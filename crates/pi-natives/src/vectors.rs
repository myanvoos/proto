use napi::{
	Error, JsString, Result, Status,
	bindgen_prelude::{Array, Float32Array, Float64Array, Uint32Array},
};
use napi_derive::napi;

use crate::js;

fn invalid<T>(message: &str) -> Result<T> {
	Err(Error::new(Status::InvalidArg, message))
}

#[inline]
const fn finite_or_zero(value: f64) -> f64 {
	if value.is_finite() { value } else { 0.0 }
}

#[inline]
#[allow(
	clippy::suboptimal_flops,
	reason = "mul_add rounds differently; bit-exact with the TS loops is the contract"
)]
fn cosine_one(a: &[f64], b: &[f64]) -> f64 {
	if a.is_empty() && b.is_empty() {
		return 0.0;
	}
	let shared = a.len().min(b.len());
	let mut dot = 0.0f64;
	let mut norm_a = 0.0f64;
	let mut norm_b = 0.0f64;
	for i in 0..shared {
		let av = finite_or_zero(a[i]);
		let bv = finite_or_zero(b[i]);
		dot += av * bv;
		norm_a += av * av;
		norm_b += bv * bv;
	}
	for &raw in &a[shared..] {
		let av = finite_or_zero(raw);
		norm_a += av * av;
	}
	for &raw in &b[shared..] {
		let bv = finite_or_zero(raw);
		norm_b += bv * bv;
	}
	if norm_a == 0.0 || norm_b == 0.0 {
		return 0.0;
	}
	dot / (norm_a.sqrt() * norm_b.sqrt())
}

#[napi]
pub fn cosine_similarity_pairs(
	vectors: Float64Array,
	count: u32,
	dim: u32,
	threshold: f64,
) -> Result<Uint32Array> {
	let count = count as usize;
	let dim = dim as usize;
	let data: &[f64] = &vectors;
	if data.len() != count * dim {
		return invalid("vectors length must equal count * dim");
	}
	let widened: &[f64] = data;
	let mut pairs: Vec<u32> = Vec::new();
	for i in 0..count {
		let left = &widened[i * dim..(i + 1) * dim];
		for j in (i + 1)..count {
			let right = &widened[j * dim..(j + 1) * dim];
			if cosine_one(left, right) >= threshold {
				pairs.push(i as u32);
				pairs.push(j as u32);
			}
		}
	}
	Ok(Uint32Array::new(pairs))
}

#[napi(object)]
pub struct VectorTopK {
	pub indices: Uint32Array,

	pub scores: Float64Array,
}

#[napi]
#[allow(
	clippy::suboptimal_flops,
	reason = "mul_add rounds differently; bit-exact with the TS loops is the contract"
)]
pub fn vector_index_top_k(
	matrix: Float32Array,
	dimensions: u32,
	query: Float64Array,
	limit: u32,
) -> Result<VectorTopK> {
	let dims = dimensions as usize;
	let data: &[f32] = &matrix;
	if dims == 0 || !data.len().is_multiple_of(dims) {
		return invalid("matrix length must be a positive multiple of dimensions");
	}
	let count = data.len() / dims;
	let q: &[f64] = &query;
	let mut norm_sq = 0.0f64;
	for &value in q {
		norm_sq += value * value;
	}
	let norm = norm_sq.sqrt();

	let query_dims = q.len().min(dims);
	let normalized: Vec<f64> = q[..query_dims].iter().map(|&v| v / norm).collect();

	let mut order: Vec<(f64, u32)> = Vec::with_capacity(count);
	for row in 0..count {
		let base = row * dims;
		let mut score = 0.0f64;
		for (col, &qv) in normalized.iter().enumerate() {
			score += f64::from(data[base + col]) * qv;
		}
		order.push((score, row as u32));
	}

	order.sort_by(|a, b| {
		let diff = b.0 - a.0;
		if diff > 0.0 {
			core::cmp::Ordering::Greater
		} else if diff < 0.0 {
			core::cmp::Ordering::Less
		} else {
			a.1.cmp(&b.1)
		}
	});
	let take = (limit as usize).min(order.len());
	order.truncate(take);
	let indices: Vec<u32> = order.iter().map(|&(_, row)| row).collect();
	let scores: Vec<f64> = order.iter().map(|&(score, _)| score).collect();
	Ok(VectorTopK { indices: Uint32Array::new(indices), scores: Float64Array::new(scores) })
}

#[inline]
const fn is_js_whitespace(c: char) -> bool {
	matches!(
		c,
		'\u{0009}'
			| '\u{000a}'
			| '\u{000b}'
			| '\u{000c}'
			| '\u{000d}'
			| '\u{0020}'
			| '\u{00a0}'
			| '\u{1680}'
			| '\u{2000}'
			..='\u{200a}'
				| '\u{2028}'
				| '\u{2029}'
				| '\u{202f}'
				| '\u{205f}'
				| '\u{3000}'
				| '\u{feff}'
	)
}

fn word_set(text: &str) -> Vec<Box<str>> {
	let lower = text.to_lowercase();
	let mut words: Vec<Box<str>> = lower
		.split(is_js_whitespace)
		.filter(|w| !w.is_empty())
		.map(Box::from)
		.collect();
	words.sort_unstable();
	words.dedup();
	words
}

fn jaccard_sorted(a: &[Box<str>], b: &[Box<str>]) -> f64 {
	if a.is_empty() || b.is_empty() {
		return 0.0;
	}
	let mut intersection = 0usize;
	let (mut i, mut j) = (0usize, 0usize);
	while i < a.len() && j < b.len() {
		match a[i].cmp(&b[j]) {
			core::cmp::Ordering::Less => i += 1,
			core::cmp::Ordering::Greater => j += 1,
			core::cmp::Ordering::Equal => {
				intersection += 1;
				i += 1;
				j += 1;
			},
		}
	}
	intersection as f64 / (a.len() + b.len() - intersection) as f64
}

#[napi]
#[allow(
	clippy::suboptimal_flops,
	reason = "mul_add rounds differently; bit-exact with the TS loops is the contract"
)]
pub fn mmr_rerank_indices(
	#[napi(ts_arg_type = "Array<string>")] contents: Array,
	scores: Float64Array,
	lambda_param: f64,
	top_k: u32,
) -> Result<Uint32Array> {
	if scores.len() != contents.len() as usize {
		return invalid("scores length must equal contents length");
	}
	let limit = top_k as usize;
	let count = contents.len() as usize;
	if limit == 0 || count == 0 {
		return Ok(Uint32Array::new(Vec::new()));
	}
	let mut sets = Vec::with_capacity(count);
	for index in 0..contents.len() {
		let content = contents
			.get::<JsString>(index)?
			.ok_or_else(|| Error::new(Status::InvalidArg, "contents changed during reranking"))?;
		sets.push(word_set(&js::utf8(content)?));
	}
	let mut selected: Vec<u32> = Vec::with_capacity(limit.min(count));
	selected.push(0);
	let mut remaining: Vec<u32> = (1..count as u32).collect();

	while !remaining.is_empty() && selected.len() < limit {
		let mut best_idx = 0usize;
		let mut best_score = f64::NEG_INFINITY;
		for (idx, &candidate) in remaining.iter().enumerate() {
			let mut max_similarity = 0.0f64;
			for &picked in &selected {
				let similarity = jaccard_sorted(&sets[candidate as usize], &sets[picked as usize]);
				if similarity > max_similarity {
					max_similarity = similarity;
				}
			}
			let relevance = scores[candidate as usize];
			let mmr_score = lambda_param * relevance - (1.0 - lambda_param) * max_similarity;
			if mmr_score > best_score {
				best_score = mmr_score;
				best_idx = idx;
			}
		}
		selected.push(remaining.remove(best_idx));
	}
	if selected.len() < limit {
		selected.extend(remaining);
		selected.truncate(limit);
	}
	Ok(Uint32Array::new(selected))
}
