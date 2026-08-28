//! Kimi K2/K3 pre-tokenizer: hand-written codepoint scanner over `&[U]`.
//!
//! Faithful port of the 8-alternate `pat_str` from `tokenization_kimi.py`
//! (see `KIMI_K2_PATTERN` in `tables.rs`), replicating fancy-regex's
//! leftmost-first alternation and greedy-with-backtracking quantifiers:
//!
//! 1. `[\p{Han}]+`
//! 2. `P? A* B+ C?` — P = `[^\r\n\p{L}\p{N}]`, A = upper set minus Han, B =
//!    lower set minus Han, C = `(?i:'s|'t|'re|'ve|'m|'ll|'d)`
//! 3. `P? A+ B* C?`
//! 4. `\p{N}{1,3}`
//! 5. ` ?[^\s\p{L}\p{N}]+[\r\n]*`
//! 6. `\s*[\r\n]+`
//! 7. `\s+(?!\S)`
//! 8. `\s+`
//!
//! Alternates 4–8 are the shared helpers ([`digits_end`], [`punct_end`]
//! without o200k's `/` tail, [`ws_end`]); only the Han run and the
//! Han-excluded letter cores are Kimi-specific. Alternates are tried in
//! order at each position; every scalar matches one of them, so no gaps
//! arise. Differential-tested against the fancy-regex splitter (the
//! reference tiktoken engine) in `tests` below.

use super::{cls, contraction_end, decode_at, digits_end, punct_end, ws_end};
use crate::utok::utf::Unit;

/// Class A: `[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]`.
#[inline]
fn in_a(c: char) -> bool {
	cls::in_upper_set(c) && !cls::is_han(c)
}

/// Class B: `[\p{Ll}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]`.
#[inline]
fn in_b(c: char) -> bool {
	cls::in_lower_set(c) && !cls::is_han(c)
}

/// `A* B+ C?` from `pos`; end unit offset on success.
fn core_lower<U: Unit>(units: &[U], pos: usize) -> Option<usize> {
	// Greedy A*, remembering the end of the last A-scalar that is also in
	// B: backtracking scans A* backward, and the first ∈B scalar found is
	// the last ∈B scalar forward. B's greedy run from there ends where the
	// A run did (nothing between it and the run end is in B).
	let mut i = pos;
	let mut last_b_end = None;
	while let Some((c, n)) = decode_at(units, i) {
		if !in_a(c) {
			break;
		}
		i += n;
		if in_b(c) {
			last_b_end = Some(i);
		}
	}
	// B+ directly after the full A run.
	let mut e = i;
	while let Some((c, n)) = decode_at(units, e) {
		if !in_b(c) {
			break;
		}
		e += n;
	}
	if e > i {
		return Some(contraction_end(units, e));
	}
	last_b_end.map(|e| contraction_end(units, e))
}

/// `A+ B* C?` from `pos`; end unit offset on success. `B*` never forces
/// backtracking, so this is two greedy runs.
fn core_upper<U: Unit>(units: &[U], pos: usize) -> Option<usize> {
	let mut i = pos;
	while let Some((c, n)) = decode_at(units, i) {
		if !in_a(c) {
			break;
		}
		i += n;
	}
	if i == pos {
		return None;
	}
	let mut e = i;
	while let Some((c, n)) = decode_at(units, e) {
		if !in_b(c) {
			break;
		}
		e += n;
	}
	Some(contraction_end(units, e))
}

/// END unit offset of the piece starting at `pos` (`pos < end <= len`).
/// The alternates cover every Unicode scalar, so a piece always exists.
pub fn next_piece<U: Unit>(units: &[U], pos: usize) -> usize {
	let (c0, l0) = U::decode(units, pos);

	// 1: [\p{Han}]+
	if cls::is_han(c0) {
		let mut i = pos + l0;
		while let Some((c, n)) = decode_at(units, i) {
			if !cls::is_han(c) {
				break;
			}
			i += n;
		}
		return i;
	}

	// 2/3: the letter cores, each trying the greedy-optional prefix
	// `[^\r\n\p{L}\p{N}]?` (space, punctuation, symbols, marks, …) before
	// the bare form — regex backtracking order.
	let p = c0 != '\r' && c0 != '\n' && !cls::is_letter(c0) && !cls::is_number(c0);
	if p && let Some(e) = core_lower(units, pos + l0) {
		return e;
	}
	if let Some(e) = core_lower(units, pos) {
		return e;
	}
	if p && let Some(e) = core_upper(units, pos + l0) {
		return e;
	}
	if let Some(e) = core_upper(units, pos) {
		return e;
	}

	// 4: \p{N}{1,3}
	if let Some(e) = digits_end(units, pos) {
		return e;
	}
	// 5: ` ?[^\s\p{L}\p{N}]+[\r\n]*` (no o200k `/` tail)
	if let Some(e) = punct_end(units, pos, false) {
		return e;
	}
	// 6/7/8: whitespace trio
	if let Some(e) = ws_end(units, pos) {
		return e;
	}

	// Unreachable for assigned scalars; consume one as a defensive gap.
	pos + l0
}
