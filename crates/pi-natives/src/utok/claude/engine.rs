use std::collections::{HashSet, VecDeque};

use super::{constants::is_marker_byte, normalize::FrameParams};

#[inline]
const fn is_continuation(b: u8) -> bool {
	b & 0xc0 == 0x80
}

pub struct PieceMatcher {
	states:       Vec<State>,
	edge_bytes:   Vec<u8>,
	edge_targets: Vec<u32>,
	/// Dense transitions out of the root, which is the hottest state by far.
	/// Zero (the root itself) where no piece starts with that byte.
	root_goto:    [u32; 256],
	/// Byte length of the longest piece: how far back the tiling DP reads.
	max_len:      usize,
}

/// One automaton state: goto edges, the fail link, and the piece chain the DP
/// reads. Sixteen bytes, so a transition and the match it reports share a cache
/// line.
struct State {
	edge_start: u32,
	/// Longest proper suffix of this state's path that is also a state.
	fail:       u32,

	dict:       u32,
	edge_count: u16,

	out_len: u16,
}

struct Builder {
	terminal: Vec<bool>,
	depth:    Vec<u32>,
	edges:    Vec<(u32, u8, u32)>,

	path: Vec<u32>,
}

impl Builder {
	fn new(piece_count: usize) -> Self {
		Self {
			terminal: vec![false],
			depth:    vec![0],
			edges:    Vec::with_capacity(piece_count * 2),
			path:     vec![0],
		}
	}

	fn push_piece(&mut self, shared: usize, suffix: &[u8]) {
		self.path.truncate(shared + 1);
		let mut at = *self.path.last().expect("root state");
		for &b in suffix {
			let child = self.terminal.len() as u32;
			self.terminal.push(false);
			self.depth.push(self.depth[at as usize] + 1);
			self.edges.push((at, b, child));
			self.path.push(child);
			at = child;
		}
		self.terminal[at as usize] = true;
	}

	fn freeze(self) -> PieceMatcher {
		let count = self.terminal.len();

		let mut offsets = vec![0u32; count + 1];
		for &(parent, ..) in &self.edges {
			offsets[parent as usize + 1] += 1;
		}
		for i in 0..count {
			offsets[i + 1] += offsets[i];
		}
		let mut edge_bytes = vec![0u8; self.edges.len()];
		let mut edge_targets = vec![0u32; self.edges.len()];
		let mut cursor = offsets.clone();
		for &(parent, b, child) in &self.edges {
			let at = cursor[parent as usize] as usize;
			cursor[parent as usize] += 1;
			edge_bytes[at] = b;
			edge_targets[at] = child;
		}

		let states = (0..count)
			.map(|i| State {
				edge_start: offsets[i],
				edge_count: u16::try_from(offsets[i + 1] - offsets[i]).expect("byte fanout"),
				out_len:    0,
				fail:       0,
				dict:       0,
			})
			.collect();
		let mut matcher =
			PieceMatcher { states, edge_bytes, edge_targets, root_goto: [0; 256], max_len: 0 };
		matcher.link(&self.terminal, &self.depth);
		matcher
	}
}

impl PieceMatcher {
	fn link(&mut self, terminal: &[bool], depth: &[u32]) {
		let mut queue: VecDeque<u32> = VecDeque::new();
		let root = &self.states[0];
		let (start, count) = (root.edge_start as usize, usize::from(root.edge_count));
		for i in start..start + count {
			let child = self.edge_targets[i];
			self.root_goto[usize::from(self.edge_bytes[i])] = child;
			queue.push_back(child);
		}
		while let Some(u) = queue.pop_front() {
			let fail = self.states[u as usize].fail;
			self.states[u as usize].out_len = if terminal[u as usize] {
				self.max_len = self.max_len.max(depth[u as usize] as usize);
				u16::try_from(depth[u as usize]).expect("piece length fits u16")
			} else {
				0
			};

			self.states[u as usize].dict = if self.states[fail as usize].out_len > 0 {
				fail
			} else {
				self.states[fail as usize].dict
			};
			let st = &self.states[u as usize];
			let (start, count) = (st.edge_start as usize, usize::from(st.edge_count));
			for i in start..start + count {
				let child = self.edge_targets[i];

				self.states[child as usize].fail = self.advance(fail, self.edge_bytes[i]);
				queue.push_back(child);
			}
		}
	}

	#[inline]
	fn goto(&self, state: u32, b: u8) -> Option<u32> {
		let st = &self.states[state as usize];
		let start = st.edge_start as usize;
		let bytes = &self.edge_bytes[start..start + usize::from(st.edge_count)];

		let hit = if bytes.len() <= 8 {
			bytes
				.iter()
				.position(|&e| e >= b)
				.filter(|&i| bytes[i] == b)
		} else {
			bytes.binary_search(&b).ok()
		}?;
		Some(self.edge_targets[start + hit])
	}

	#[inline]
	fn advance(&self, state: u32, b: u8) -> u32 {
		let mut at = state;
		loop {
			if at == 0 {
				return self.root_goto[usize::from(b)];
			}
			if let Some(next) = self.goto(at, b) {
				return next;
			}
			at = self.states[at as usize].fail;
		}
	}

	#[inline]
	const fn matches(&self, state: u32) -> Matches<'_> {
		Matches { vocab: self, at: state }
	}
}

struct Matches<'a> {
	vocab: &'a PieceMatcher,
	at:    u32,
}

impl Iterator for Matches<'_> {
	type Item = usize;

	#[inline]
	fn next(&mut self) -> Option<usize> {
		loop {
			let st = &self.vocab.states[self.at as usize];
			let len = st.out_len;
			self.at = st.dict;
			if len > 0 {
				return Some(usize::from(len));
			}

			if self.at == 0 {
				return None;
			}
		}
	}
}

/// Incremental min-cost tiling over the cost-1 vocabulary plus a guaranteed
/// one-character floor, fed the marked stream in chunks
/// ([`push`](Self::push)) so the stream is never materialized whole. A
/// character no piece covers is priced by [`VocabCore::uncovered_cost`] (may
/// be > 1: a 4-byte letter with no piece costs its byte tiling).
///
/// Long pieces make `best` non-monotone — covering a longer prefix can cost
/// fewer tokens than covering a shorter one — so every piece ending at a
/// position is scored, not just the longest. The one-character floor is needed
/// only when no piece spells that character alone: any piece ending here covers
/// at least the final character (a piece cannot start mid-character), and the
/// character's own piece costs 1, never more than its floor.
pub struct Tiler<'a> {
	core:    &'a VocabCore,
	/// `best[end & mask]`: min cost of the stream prefix ending at byte `end`.
	/// It is read only at `end - len` for a piece ending at `end` and at the
	/// start of the final character (≤ 4 bytes back), so a ring over that
	/// reach replaces a stream-length array. Offsets inside a character are
	/// never written or read, so their stale slots are harmless.
	best:    Vec<u32>,
	mask:    usize,
	state:   u32,
	/// Stream bytes consumed so far.
	end:     usize,
	/// The character being consumed: its bytes so far and its full length,
	/// known from the lead byte (the stream is valid UTF-8).
	ch:      [u8; 4],
	ch_len:  usize,
	ch_need: usize,
}

impl Tiler<'_> {
	/// Consume the next stream bytes.
	pub fn push(&mut self, bytes: &[u8]) {
		// The DP runs on locals, written back once per chunk: kept in `self`
		// across the calls in the loop, they were reloaded and stored per byte.
		let core = self.core;
		let vocab = &core.vocab;
		let mask = self.mask;
		let best = &mut self.best[..=mask];
		let (mut state, mut end) = (self.state, self.end);
		let (mut ch, mut ch_len, mut ch_need) = (self.ch, self.ch_len, self.ch_need);
		for &b in bytes {
			state = vocab.advance(state, b);
			end += 1;
			if !is_continuation(b) {
				ch_len = 0;
				ch_need = match b {
					0x00..=0x7f => 1,
					0xc0..=0xdf => 2,
					0xe0..=0xef => 3,
					_ => 4,
				};
			}
			ch[ch_len & 3] = b;
			ch_len += 1;
			// Tiles start and end on character boundaries only; interior byte
			// positions of a character are never a DP state.
			if ch_len < ch_need {
				continue;
			}
			let mut cost = u32::MAX;
			let mut spelled = false;
			for len in vocab.matches(state) {
				cost = cost.min(best[(end - len) & mask] + 1);
				spelled |= len == ch_len;
			}
			if !spelled {
				cost = cost.min(best[(end - ch_len) & mask] + core.uncovered_cost(&ch[..ch_len]));
			}
			best[end & mask] = cost;
		}
		(self.state, self.end) = (state, end);
		(self.ch, self.ch_len, self.ch_need) = (ch, ch_len, ch_need);
	}

	/// Token count of everything pushed (0 for an empty stream).
	pub fn finish(&self) -> u32 {
		self.best[self.end & self.mask]
	}
}

/// What a codepoint costs when no piece covers it: a min-cost tiling of its
/// UTF-8 bytes over the partial byte-prefix tokens, every single byte
/// costing 1.
struct ByteFloor {
	/// Sorted sentinel-packed byte strings (≤ 4 bytes): membership is all that
	/// is needed, since every token costs 1.
	tokens:  Vec<u64>,
	max_len: usize,
}

#[inline]
fn pack_bytes(bs: &[u8]) -> u64 {
	bs.iter().fold(1u64, |acc, &b| (acc << 8) | u64::from(b))
}

impl ByteFloor {
	fn cost_bytes(&self, bs: &[u8]) -> u32 {
		let n = bs.len();
		let mut best = [u32::MAX; 5];
		best[0] = 0;
		for i in 1..=n {
			for j in i.saturating_sub(self.max_len)..i {
				if best[j] != u32::MAX
					&& (i - j == 1 || self.tokens.binary_search(&pack_bytes(&bs[j..i])).is_ok())
					&& best[j] + 1 < best[i]
				{
					best[i] = best[j] + 1;
				}
			}
		}
		best[n]
	}

	fn cost_char(&self, c: char) -> u32 {
		let mut buf = [0u8; 4];
		self.cost_bytes(c.encode_utf8(&mut buf).as_bytes())
	}
}

#[inline]
fn decode_char(bytes: &[u8]) -> char {
	#[inline]
	const fn cont(b: u8) -> u32 {
		(b & 0x3f) as u32
	}
	let lead = u32::from(bytes[0]);
	let cp = if lead < 0x80 {
		lead
	} else if lead < 0xe0 {
		(lead & 0x1f) << 6 | cont(bytes[1])
	} else if lead < 0xf0 {
		(lead & 0x0f) << 12 | cont(bytes[1]) << 6 | cont(bytes[2])
	} else {
		(lead & 0x07) << 18 | cont(bytes[1]) << 12 | cont(bytes[2]) << 6 | cont(bytes[3])
	};
	char::from_u32(cp).expect("valid UTF-8")
}

struct Cursor<'a> {
	data: &'a [u8],
	pos:  usize,
}

impl<'a> Cursor<'a> {
	fn take(&mut self, n: usize) -> &'a [u8] {
		let slice = &self.data[self.pos..self.pos + n];
		self.pos += n;
		slice
	}

	fn u8(&mut self) -> u8 {
		self.take(1)[0]
	}

	fn u16(&mut self) -> u16 {
		u16::from_le_bytes(self.take(2).try_into().expect("two bytes"))
	}

	fn u32(&mut self) -> u32 {
		u32::from_le_bytes(self.take(4).try_into().expect("four bytes"))
	}

	fn varint(&mut self) -> usize {
		let mut value = 0usize;
		let mut shift = 0u32;
		loop {
			let byte = self.u8();
			value |= usize::from(byte & 0x7f) << shift;
			if byte & 0x80 == 0 {
				return value;
			}
			shift += 7;
			assert!(shift < 32, "ctok varint overflow");
		}
	}
}

pub struct VocabCore {
	pub message_overhead: u32,

	pub fold_quotes: bool,

	pub allcaps_min: Option<usize>,
	vocab:           PieceMatcher,

	unit_pieces: Vec<u32>,

	newline_ladder: Vec<u32>,
	floor:          ByteFloor,
}

impl VocabCore {
	pub fn parse(blob: &[u8]) -> Self {
		let mut cur = Cursor { data: blob, pos: 0 };
		assert_eq!(cur.take(4), b"CTOK", "bad ctok vocabulary magic");
		assert_eq!(cur.u8(), 2, "unsupported ctok vocabulary version");
		let fold_quotes = cur.u8() & 1 != 0;
		let message_overhead = u32::from(cur.u8());
		let allcaps_min = match cur.u8() {
			0 => None,
			n => Some(usize::from(n)),
		};
		let byte_token_count = usize::from(cur.u16());
		let piece_count = cur.u32();

		let mut tokens = HashSet::with_capacity(byte_token_count + 512);
		let mut max_len = 1usize;
		for _ in 0..byte_token_count {
			let len = usize::from(cur.u8());
			assert!((1..=4).contains(&len), "byte token out of range: {len}");
			max_len = max_len.max(len);
			tokens.insert(pack_bytes(cur.take(len)));
		}

		let mut builder = Builder::new(piece_count as usize);
		let mut unit_pieces = Vec::new();
		let mut newline_ladder = Vec::new();
		let mut scratch: Vec<u8> = Vec::with_capacity(64);
		for _ in 0..piece_count {
			let shared = cur.varint();
			let suffix_len = cur.varint();
			assert!(shared <= scratch.len(), "ctok pieces should be front-coded in order");
			scratch.truncate(shared);
			let suffix = cur.take(suffix_len);
			scratch.extend_from_slice(suffix);
			builder.push_piece(shared, suffix);
			assert!(std::str::from_utf8(&scratch).is_ok(), "ctok piece should be UTF-8");
			if scratch.iter().all(|&b| b == b'\n') {
				newline_ladder.push(scratch.len() as u32);
			}

			if scratch.len() == 1 && is_marker_byte(scratch[0]) {
				continue;
			}
			let c = decode_char(&scratch);
			if scratch.len() == c.len_utf8() {
				unit_pieces.push(c as u32);
				max_len = max_len.max(scratch.len());
				tokens.insert(pack_bytes(&scratch));
			}
		}
		assert_eq!(cur.pos, blob.len(), "trailing ctok vocabulary bytes");
		newline_ladder.sort_unstable();
		unit_pieces.sort_unstable();
		let mut tokens: Vec<u64> = tokens.into_iter().collect();
		tokens.sort_unstable();

		Self {
			message_overhead,
			fold_quotes,
			allcaps_min,
			vocab: builder.freeze(),
			unit_pieces,
			newline_ladder,
			floor: ByteFloor { tokens, max_len },
		}
	}

	fn uncovered_cost(&self, bytes: &[u8]) -> u32 {
		if bytes.len() == 1 && is_marker_byte(bytes[0]) {
			return 1;
		}
		let c = decode_char(bytes);
		if self.unit_pieces.binary_search(&(c as u32)).is_ok() {
			1
		} else {
			self.floor.cost_char(c)
		}
	}

	/// A tiler for one marked stream: minimum token count over the vocabulary,
	/// with markers costing one and uncovered characters falling to the byte
	/// floor.
	pub fn tiler(&self) -> Tiler<'_> {
		let mask = (self.vocab.max_len.max(4) + 1).next_power_of_two() - 1;
		Tiler {
			core: self,
			best: vec![0; mask + 1],
			mask,
			state: 0,
			end: 0,
			ch: [0; 4],
			ch_len: 0,
			ch_need: 0,
		}
	}

	/// What a content-final run of `n_tail` frame-absorbed newlines costs
	/// beyond the frame's own trailing token (ladder families only). The
	/// v3/v4.7 frames append ⏎⏎ after the content and one token can span
	/// into them, so the run the tokenizer sees is `n_tail + 2`; the
	/// sonnet/fable-5 frame appends nothing (`appended = 0`). In both cases
	/// the frame already pays for one token of the run.
	pub fn ladder_tail_cost(&self, n_tail: usize, appended: usize) -> u32 {
		if n_tail == 0 {
			return 0;
		}
		let m = n_tail + appended;
		// Min-token cover of a homogeneous run: only the pure-newline
		// pieces can match (each costing one), and a newline left over
		// costs one. The lengths are not contiguous (v4.7 jumps 16 → 24),
		// so this is a coin DP, not a division by the longest piece.
		// Ring over the longest ladder piece: no read reaches further back.
		let mask =
			(self.newline_ladder.last().map_or(1, |&l| l as usize) + 1).next_power_of_two() - 1;
		let mut best = vec![0u32; mask + 1];
		for end in 1..=m {
			let mut cost = best[(end - 1) & mask] + 1;
			for &len in &self.newline_ladder {
				let len = len as usize;
				if len > end {
					break;
				}
				cost = cost.min(best[(end - len) & mask] + 1);
			}
			best[end & mask] = cost;
		}
		best[m & mask] - 1
	}

	/// The frame scalars this vocabulary file measures (v3/v4.7 defaults:
	/// the frame ends in ⟨bow⟩ and pays the trailing-newline ladder).
	pub const fn frame_params(&self) -> FrameParams {
		FrameParams {
			message_overhead: self.message_overhead,
			fold_quotes:      self.fold_quotes,
			allcaps_min:      self.allcaps_min,
			frame_bow:        true,
			ladder:           true,
		}
	}
}
