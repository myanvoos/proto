use std::{
	borrow::Cow,
	collections::HashMap,
	hash::{BuildHasherDefault, Hasher},
};

use crate::utok::{
	pretoken::{self, Splitter},
	utf::Unit,
};

#[derive(Default)]
struct FxHasher(u64);

impl Hasher for FxHasher {
	#[inline]
	fn write(&mut self, bytes: &[u8]) {
		const SEED: u64 = 0x51_7c_c1_b7_27_22_0a_95;
		let mut h = self.0;
		let mut b = bytes;
		while let Some(chunk) = b.first_chunk::<8>() {
			h = (h.rotate_left(5) ^ u64::from_le_bytes(*chunk)).wrapping_mul(SEED);
			b = &b[8..];
		}
		if let Some(chunk) = b.first_chunk::<4>() {
			h = (h.rotate_left(5) ^ u64::from(u32::from_le_bytes(*chunk))).wrapping_mul(SEED);
			b = &b[4..];
		}
		for &byte in b {
			h = (h.rotate_left(5) ^ u64::from(byte)).wrapping_mul(SEED);
		}
		self.0 = h;
	}

	#[inline]
	fn finish(&self) -> u64 {
		self.0
	}
}

type Fx = BuildHasherDefault<FxHasher>;
type FxMap = HashMap<Box<[u8]>, u32, Fx>;

#[inline]
fn pack(key: &[u8]) -> Option<u128> {
	let n = key.len();
	if n > 15 {
		return None;
	}
	let v: u128 = if let (Some(lo), Some(hi)) = (key.first_chunk::<8>(), key.last_chunk::<8>()) {
		u128::from(u64::from_le_bytes(*lo)) | u128::from(u64::from_le_bytes(*hi)) << ((n - 8) * 8)
	} else if let (Some(lo), Some(hi)) = (key.first_chunk::<4>(), key.last_chunk::<4>()) {
		u128::from(u32::from_le_bytes(*lo)) | u128::from(u32::from_le_bytes(*hi)) << ((n - 4) * 8)
	} else if let (Some(lo), Some(hi)) = (key.first_chunk::<2>(), key.last_chunk::<2>()) {
		u128::from(u16::from_le_bytes(*lo)) | u128::from(u16::from_le_bytes(*hi)) << ((n - 2) * 8)
	} else if let [b] = key {
		u128::from(*b)
	} else {
		0
	};
	Some(v | (n as u128) << 120)
}

pub struct RankTable {
	pairs: Box<[u32; 65536]>,

	short: HashMap<u128, u32, Fx>,

	long: FxMap,

	pub max_token_len: usize,
}

impl RankTable {
	pub fn parse(zst: &[u8]) -> Self {
		let raw = zstd::decode_all(zst).expect("utoken: zstd decode failed");
		let mut p = &raw[..];
		assert_eq!(&p[..6], b"UTOK1\n", "utoken: bad magic");
		p = &p[6..];
		let n = u32::from_le_bytes(p[..4].try_into().unwrap()) as usize;
		p = &p[4..];
		let mut pairs: Box<[u32; 65536]> =
			vec![u32::MAX; 65536].into_boxed_slice().try_into().unwrap();
		let mut short = HashMap::with_capacity_and_hasher(n, Fx::default());
		let mut long = FxMap::default();
		let mut max_token_len = 0usize;
		for rank in 0..n as u32 {
			let mut len = 0usize;
			let mut shift = 0;
			loop {
				let b = p[0];
				p = &p[1..];
				len |= ((b & 0x7f) as usize) << shift;
				if b < 0x80 {
					break;
				}
				shift += 7;
			}
			if len > 0 {
				let key = &p[..len];
				if let [a, b] = key {
					pairs[usize::from(*a) << 8 | usize::from(*b)] = rank;
				} else if let Some(k) = pack(key) {
					short.insert(k, rank);
				} else {
					long.insert(key.into(), rank);
				}
				max_token_len = max_token_len.max(len);
				p = &p[len..];
			}
		}
		assert!(p.is_empty(), "utoken: trailing bytes in UTOK1 blob");
		Self { pairs, short, long, max_token_len }
	}

	#[inline]
	pub fn rank(&self, piece: &[u8]) -> Option<u32> {
		if let [a, b] = piece {
			let r = self.pairs[usize::from(*a) << 8 | usize::from(*b)];
			return (r != u32::MAX).then_some(r);
		}
		match pack(piece) {
			Some(k) => self.short.get(&k).copied(),
			None => self.long.get(piece).copied(),
		}
	}

	pub fn encode_piece(&self, piece: &[u8], out: &mut Vec<u32>) {
		if piece.is_empty() {
			return;
		}
		if let Some(rank) = self.rank(piece) {
			out.push(rank);
			return;
		}
		self.merge(piece, |start, end| {
			out.push(
				self
					.rank(&piece[start..end])
					.expect("utoken: unreachable merge state"),
			);
		});
	}

	pub fn count_piece(&self, piece: &[u8]) -> u32 {
		if piece.is_empty() {
			return 0;
		}
		if self.rank(piece).is_some() {
			return 1;
		}
		let mut n = 0u32;
		self.merge(piece, |_, _| n += 1);
		n
	}

	fn merge(&self, piece: &[u8], mut emit: impl FnMut(usize, usize)) {
		let mut parts: Vec<(usize, u32)> = Vec::with_capacity(piece.len() + 1);
		let mut min_rank: (u32, usize) = (u32::MAX, usize::MAX);
		for i in 0..piece.len() - 1 {
			let rank = self.rank(&piece[i..i + 2]).unwrap_or(u32::MAX);
			if rank < min_rank.0 {
				min_rank = (rank, i);
			}
			parts.push((i, rank));
		}
		parts.push((piece.len() - 1, u32::MAX));
		parts.push((piece.len(), u32::MAX));

		let get_rank = |parts: &[(usize, u32)], k: usize| -> u32 {
			if k + 3 < parts.len() {
				self
					.rank(&piece[parts[k].0..parts[k + 3].0])
					.unwrap_or(u32::MAX)
			} else {
				u32::MAX
			}
		};

		while min_rank.0 != u32::MAX {
			let i = min_rank.1;
			if i > 0 {
				parts[i - 1].1 = get_rank(&parts, i - 1);
			}
			parts[i].1 = get_rank(&parts, i);
			parts.remove(i + 1);

			min_rank = (u32::MAX, usize::MAX);
			for (k, &(_, rank)) in parts[..parts.len() - 1].iter().enumerate() {
				if rank < min_rank.0 {
					min_rank = (rank, k);
				}
			}
		}
		for w in parts.windows(2) {
			emit(w[0].0, w[1].0);
		}
	}
}

pub struct BpeEncoding {
	pub table:    RankTable,
	pub splitter: Splitter,

	pub nfc: bool,

	#[allow(dead_code, reason = "retained to document the GLM-5 tokenizer behavior")]
	pub ignore_merges: bool,
}

impl BpeEncoding {
	pub fn count<U: Unit>(&self, units: &[U]) -> u32 {
		let mut n = 0u32;
		self.run(units, &mut |t, p| n += t.count_piece(p));
		n
	}

	pub fn encode<U: Unit>(&self, units: &[U]) -> Vec<u32> {
		let mut out = Vec::new();
		self.run(units, &mut |t, p| t.encode_piece(p, &mut out));
		out
	}

	fn run<U: Unit>(&self, units: &[U], f: &mut impl FnMut(&RankTable, &[u8])) {
		if let Some(bytes) = U::as_utf8(units) {
			if self.nfc
				&& let Ok(text) = std::str::from_utf8(bytes)
				&& let Cow::Owned(norm) = pretoken::nfc(text)
			{
				return self.scan(norm.as_bytes(), f);
			}
			return self.scan(bytes, f);
		}

		if self.nfc && !nfc_quick(units) {
			let s = decode_lossy(units);
			let s = match pretoken::nfc(&s) {
				Cow::Owned(o) if self.nfc => o,
				_ => s,
			};
			return self.scan(s.as_bytes(), f);
		}
		self.scan(units, f);
	}

	fn scan<U: Unit>(&self, units: &[U], f: &mut impl FnMut(&RankTable, &[u8])) {
		let mut buf = Vec::new();
		self
			.splitter
			.for_each_piece(units, |piece| f(&self.table, piece_bytes(piece, &mut buf)));
	}
}

fn piece_bytes<'a, U: Unit>(piece: &'a [U], buf: &'a mut Vec<u8>) -> &'a [u8] {
	if let Some(bytes) = U::as_utf8(piece) {
		return bytes;
	}
	buf.clear();
	buf.reserve(piece.len());
	let mut i = 0;
	while i < piece.len() {
		if let Some(b) = piece[i].ascii() {
			buf.push(b);
			i += 1;
		} else {
			let (c, n) = U::decode(piece, i);
			i += n;
			let mut tmp = [0u8; 4];
			buf.extend_from_slice(c.encode_utf8(&mut tmp).as_bytes());
		}
	}
	buf
}

fn decode_lossy<U: Unit>(units: &[U]) -> String {
	let mut s = String::with_capacity(units.len());
	let mut i = 0;
	while i < units.len() {
		let (c, n) = U::decode(units, i);
		i += n;
		s.push(c);
	}
	s
}

fn nfc_quick<U: Unit>(units: &[U]) -> bool {
	struct Cps<'a, U: Unit>(&'a [U], usize);
	impl<U: Unit> Iterator for Cps<'_, U> {
		type Item = u32;

		fn next(&mut self) -> Option<u32> {
			(self.1 < self.0.len()).then(|| {
				let (c, n) = U::decode(self.0, self.1);
				self.1 += n;
				c as u32
			})
		}
	}
	xutf::is_nfc_codepoints(Cps(units, 0))
}
