//! Qwen3 (3.5/3.6/3.8) split pattern as a codepoint scanner.
//!
//! Reference (qwen3.8.tokenizer.json `pre_tokenizer`, = families.json qwen3):
//! ```text
//! (?i:'s|'t|'re|'ve|'m|'ll|'d)
//! |[^\r\n\p{L}\p{N}]?[\p{L}\p{M}]+
//! |\p{N}
//! | ?[^\s\p{L}\p{M}\p{N}]+[\r\n]*
//! |\s*[\r\n]+
//! |\s+(?!\S)
//! |\s+
//! ```
//! Deviations from cl100k: letter runs include marks (`[\p{L}\p{M}]+`)
//! and the optional prefix class admits marks (real backtracking: a lone
//! mark is both prefix- and run-eligible), `\p{N}` is a SINGLE codepoint
//! (not `{1,3}`), and punctuation runs exclude marks.
//!
//! NFC is not this layer's concern: the engine normalizes before scanning
//! (`BpeEncoding` nfc funnel).

use super::{cls, contraction_end, decode_at, ws_end};
use crate::utok::utf::Unit;

/// End of the piece starting at `pos` (`pos < units.len()`).
pub fn next_piece<U: Unit>(units: &[U], pos: usize) -> usize {
	let e = contraction_end(units, pos);
	if e > pos {
		return e;
	}
	if let Some(e) = word(units, pos) {
		return e;
	}
	let Some((c, n)) = decode_at(units, pos) else {
		return pos + 1;
	};
	if cls::is_number(c) {
		// `\p{N}`: exactly one codepoint.
		return pos + n;
	}
	if let Some(e) = punct(units, pos) {
		return e;
	}
	if let Some(e) = ws_end(units, pos) {
		return e;
	}
	// Unreachable for real input (the alternates cover every codepoint);
	// isolate one codepoint so the scan always advances.
	pos + n
}

/// `[\p{L}\p{M}]+` run end starting at `pos` (may equal `pos`).
#[inline]
fn lm_run_end<U: Unit>(units: &[U], pos: usize) -> usize {
	let mut i = pos;
	while let Some((c, n)) = decode_at(units, i) {
		if !cls::is_letter(c) && !cls::is_mark(c) {
			break;
		}
		i += n;
	}
	i
}

/// `[^\r\n\p{L}\p{N}]?[\p{L}\p{M}]+`. The prefix class admits marks, which
/// are also run codepoints, so the greedy optional prefix backtracks: when
/// nothing follows a mark prefix, the mark itself is the run.
fn word<U: Unit>(units: &[U], pos: usize) -> Option<usize> {
	let (c, n) = decode_at(units, pos)?;
	if c != '\r' && c != '\n' && !cls::is_letter(c) && !cls::is_number(c) {
		// Greedy: try with the prefix consumed.
		let e = lm_run_end(units, pos + n);
		if e > pos + n {
			return Some(e);
		}
		// Backtrack to no prefix: only a mark is still run-eligible
		// (letters are excluded from the prefix class).
		return cls::is_mark(c).then_some(pos + n);
	}
	// No prefix possible; run only if `c` itself is a letter.
	let e = lm_run_end(units, pos);
	(e > pos).then_some(e)
}

/// ` ?[^\s\p{L}\p{M}\p{N}]+[\r\n]*`. No backtracking needed: the body
/// class excludes whitespace, so a failed body after the optional space
/// cannot succeed from the space either.
fn punct<U: Unit>(units: &[U], pos: usize) -> Option<usize> {
	let (c, n) = decode_at(units, pos)?;
	let start = if c == ' ' { pos + n } else { pos };
	let mut i = start;
	while let Some((c, n)) = decode_at(units, i) {
		if cls::is_ws(c) || cls::is_letter(c) || cls::is_mark(c) || cls::is_number(c) {
			break;
		}
		i += n;
	}
	if i == start {
		return None;
	}
	while let Some((c, n)) = decode_at(units, i) {
		if c != '\r' && c != '\n' {
			break;
		}
		i += n;
	}
	Some(i)
}
