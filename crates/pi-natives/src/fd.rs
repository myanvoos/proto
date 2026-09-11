use std::{cmp::Ordering, collections::BinaryHeap, path::Path};

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::{iofs, task};

#[napi(object)]
pub struct FuzzyFindOptions<'env> {
	pub query: String,

	pub path: String,

	pub hidden: Option<bool>,

	pub gitignore: Option<bool>,

	pub cache: Option<bool>,

	pub max_results: Option<u32>,

	pub signal: Option<Unknown<'env>>,

	pub timeout_ms: Option<u32>,
}

#[napi(object)]
pub struct FuzzyFindMatch {
	pub path: String,

	pub is_directory: bool,

	pub score: u32,
}

#[napi(object)]
pub struct FuzzyFindResult {
	pub matches: Vec<FuzzyFindMatch>,

	pub total_matches: u32,
}

fn normalize_fuzzy_text(value: &str) -> String {
	value
		.chars()
		.filter(|ch| !ch.is_whitespace() && !matches!(ch, '/' | '\\' | '.' | '_' | '-'))
		.flat_map(|ch| ch.to_lowercase())
		.collect()
}

fn fuzzy_subsequence_score(query_chars: &[char], target: &str) -> u32 {
	if query_chars.is_empty() {
		return 1;
	}
	let mut query_index = 0usize;
	let mut gaps = 0u32;
	let mut last_match_index: Option<usize> = None;
	for (target_index, target_ch) in target.chars().enumerate() {
		if query_index >= query_chars.len() {
			break;
		}
		if query_chars[query_index] == target_ch {
			if let Some(last_index) = last_match_index
				&& target_index > last_index + 1
			{
				gaps = gaps.saturating_add(1);
			}
			last_match_index = Some(target_index);
			query_index += 1;
		}
	}
	if query_index != query_chars.len() {
		return 0;
	}
	let gap_penalty = gaps.saturating_mul(5);
	40u32.saturating_sub(gap_penalty).max(1)
}

fn score_fuzzy_path(
	path: &str,
	is_directory: bool,
	query_lower: &str,
	normalized_query: &str,
	query_chars: &[char],
) -> u32 {
	if query_lower.is_empty() {
		return if is_directory { 11 } else { 1 };
	}

	let query_has_slash = query_lower.contains('/');

	let file_name = Path::new(path)
		.file_name()
		.and_then(|name| name.to_str())
		.unwrap_or(path);
	let lower_file_name = file_name.to_lowercase();

	let mut score = if lower_file_name == query_lower {
		120
	} else if lower_file_name.starts_with(query_lower) {
		100
	} else if lower_file_name.contains(query_lower) {
		80
	} else if !query_has_slash {
		let normalized_file_name = normalize_fuzzy_text(file_name);
		let file_name_fuzzy = fuzzy_subsequence_score(query_chars, &normalized_file_name);
		if file_name_fuzzy > 0 {
			50 + file_name_fuzzy
		} else {
			0
		}
	} else {
		let lower_path = path.to_lowercase();
		if lower_path.contains(query_lower) {
			60
		} else {
			let normalized_file_name = normalize_fuzzy_text(file_name);
			let file_name_fuzzy = fuzzy_subsequence_score(query_chars, &normalized_file_name);
			if file_name_fuzzy > 0 {
				50 + file_name_fuzzy
			} else {
				let normalized_path = normalize_fuzzy_text(path);
				let path_fuzzy = if normalized_path == normalized_query {
					40
				} else {
					fuzzy_subsequence_score(query_chars, &normalized_path)
				};
				if path_fuzzy > 0 { 30 + path_fuzzy } else { 0 }
			}
		}
	};

	if is_directory && score > 0 {
		score += 10;
	}

	score
}

fn path_depth(path: &str) -> usize {
	path.trim_end_matches('/').matches('/').count()
}

struct RankedMatch {
	depth: usize,
	entry: FuzzyFindMatch,
}

impl RankedMatch {
	fn new(entry: FuzzyFindMatch) -> Self {
		let depth = path_depth(&entry.path);
		Self { depth, entry }
	}
}

impl Ord for RankedMatch {
	fn cmp(&self, other: &Self) -> Ordering {
		other
			.entry
			.score
			.cmp(&self.entry.score)
			.then_with(|| self.depth.cmp(&other.depth))
			.then_with(|| self.entry.path.cmp(&other.entry.path))
	}
}

impl PartialOrd for RankedMatch {
	fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
		Some(self.cmp(other))
	}
}

impl PartialEq for RankedMatch {
	fn eq(&self, other: &Self) -> bool {
		self.cmp(other) == Ordering::Equal
	}
}

impl Eq for RankedMatch {}

struct TopMatches {
	capacity: usize,
	total:    u64,
	heap:     BinaryHeap<RankedMatch>,
}

impl TopMatches {
	fn new(capacity: usize) -> Self {
		Self { capacity, total: 0, heap: BinaryHeap::with_capacity(capacity.min(256)) }
	}

	fn push(&mut self, entry: FuzzyFindMatch) {
		self.total = self.total.saturating_add(1);
		if self.capacity == 0 {
			return;
		}
		let candidate = RankedMatch::new(entry);
		if self.heap.len() < self.capacity {
			self.heap.push(candidate);
			return;
		}

		if self.heap.peek().is_some_and(|worst| candidate < *worst) {
			self.heap.pop();
			self.heap.push(candidate);
		}
	}

	const fn total_matches(&self) -> u32 {
		crate::utils::clamp_u32(self.total)
	}

	fn into_sorted_matches(self) -> Vec<FuzzyFindMatch> {
		self
			.heap
			.into_sorted_vec()
			.into_iter()
			.map(|ranked| ranked.entry)
			.collect()
	}
}

struct FuzzyFindConfig {
	query:       String,
	path:        String,
	hidden:      Option<bool>,
	gitignore:   Option<bool>,
	max_results: Option<u32>,
	cache:       Option<bool>,
}

fn score_entry(
	scored: &mut TopMatches,
	path: &str,
	is_directory: bool,
	query_lower: &str,
	normalized_query: &str,
	query_chars: &[char],
) {
	let score = score_fuzzy_path(path, is_directory, query_lower, normalized_query, query_chars);
	if score == 0 {
		return;
	}

	let mut path = path.to_owned();
	if is_directory {
		path.push('/');
	}
	scored.push(FuzzyFindMatch { path, is_directory, score });
}

fn fuzzy_find_sync(config: FuzzyFindConfig, ct: task::CancelToken) -> Result<FuzzyFindResult> {
	let root = pi_walker::resolve_search_path(&config.path).map_err(iofs::map_walker_error)?;
	let include_hidden = config.hidden.unwrap_or(false);
	let respect_gitignore = config.gitignore.unwrap_or(true);
	let max_results = config.max_results.unwrap_or(100) as usize;
	if max_results == 0 {
		return Ok(FuzzyFindResult { matches: Vec::new(), total_matches: 0 });
	}

	let query_lower = config.query.trim().to_lowercase();
	let normalized_query = normalize_fuzzy_text(&query_lower);
	let query_chars: Vec<char> = normalized_query.chars().collect();
	if !query_lower.is_empty() && normalized_query.is_empty() {
		return Ok(FuzzyFindResult { matches: Vec::new(), total_matches: 0 });
	}

	let mut scored = TopMatches::new(max_results);
	pi_walker::WalkRequest::new(root)
		.hidden(include_hidden)
		.gitignore(respect_gitignore)
		.skip_git(true)
		.skip_node_modules(true)
		.follow_links(pi_walker::FollowLinks::Always)
		.detail(pi_walker::WalkDetail::Minimal)
		.order(pi_walker::WalkOrder::Path)
		.emit_root(false)
		.depth(1, usize::MAX)
		.directory_errors(pi_walker::DirectoryErrorMode::SkipSkippable)
		.cache(config.cache.unwrap_or(false))
		.empty_recheck(pi_walker::EmptyRecheck::Configured)
		.for_each_entry_with_heartbeat(
			|| ct.heartbeat(),
			|entry| {
				ct.heartbeat()?;
				if entry.file_type != pi_walker::FileType::Symlink {
					let is_directory = entry.file_type == pi_walker::FileType::Dir;
					score_entry(
						&mut scored,
						entry.relative_path,
						is_directory,
						&query_lower,
						&normalized_query,
						&query_chars,
					);
				}
				Ok(pi_walker::WalkDecision::Include)
			},
			|_error| Ok(pi_walker::WalkDecision::Include),
		)
		.map_err(iofs::map_walker_error)?;

	let total_matches = scored.total_matches();
	let matches = scored.into_sorted_matches();
	Ok(FuzzyFindResult { matches, total_matches })
}

#[napi(js_name = "fuzzyFind")]
pub fn fuzzy_find(options: FuzzyFindOptions<'_>) -> task::Promise<FuzzyFindResult> {
	let FuzzyFindOptions { query, path, hidden, gitignore, cache, max_results, timeout_ms, signal } =
		options;
	let ct = task::CancelToken::new(timeout_ms, signal);
	let config = FuzzyFindConfig { query, path, hidden, gitignore, max_results, cache };
	task::blocking("fuzzy_find", ct, move |ct| fuzzy_find_sync(config, ct))
}
