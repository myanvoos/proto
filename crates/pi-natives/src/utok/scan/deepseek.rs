//! `DeepSeek` V3..V4 pre-tokenizer: hand-written codepoint scanner over `&[U]`.
//!
//! Faithful port of the three-stage HF `Split(Isolated)` chain (see
//! `DEEPSEEK_STAGE_*` in `tables.rs`). Every stage applies to each piece
//! produced by the previous one; matches and unmatched gaps both survive
//! as pieces:
//!
//! 1. `\p{N}{1,3}` — after this stage no piece contains a digit outside its own
//!    1–3-digit piece.
//! 2. `[一-龥぀-ゟ゠-ヿ]+` — Han U+4E00–9FA5 plus the contiguous
//!    hiragana/katakana blocks U+3040–30FF.
//! 3. The main pattern:
//!    - ``[!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~][A-Za-z]+`` (one ASCII
//!      punctuation codepoint glued to ASCII letters, e.g. `.NET`, `(foo`)
//!    - `[^\r\n\p{L}\p{P}\p{S}]?[\p{L}\p{M}]+`
//!    - ` ?[\p{P}\p{S}]+[\r\n]*`
//!    - the whitespace trio `\s*[\r\n]+|\s+(?!\S)|\s+` ([`ws_end`])
//!
//! Stage 3 has no digit alternate, so digit pieces from stage 1 pass
//! through as single gaps; stage-2 CJK pieces may re-split (゠ U+30A0 is
//! `Pd`, ・ U+30FB is `Po`, ー U+30FC is `Lm`…). Alternates are tried in
//! leftmost-first order with greedy backtracking, replicating the
//! reference regex; differential-tested against the fancy-regex chain in
//! `tests` below.

use xutf::GeneralCategoryGroup as GCG;

use super::{cls, decode_at, digits_end, ws_end};
use crate::utok::utf::Unit;

/// Split `units` into pieces of the full three-stage chain, in order,
/// covering the input exactly.
pub fn for_each_piece<U: Unit>(units: &[U], f: &mut impl FnMut(&[U])) {
	isolated(units, digits_end, &mut |p1: &[U]| {
		isolated(p1, cjk_end, &mut |p2: &[U]| {
			isolated(p2, main_end, f);
		});
	});
}

/// One `Split(Isolated)` stage: `matcher` returns the end of a match
/// starting exactly at the given offset (or `None`); matches become
/// pieces, unmatched gaps between them survive as pieces too.
fn isolated<U: Unit>(
	piece: &[U],
	matcher: impl Fn(&[U], usize) -> Option<usize>,
	f: &mut impl FnMut(&[U]),
) {
	let mut gap = 0;
	let mut pos = 0;
	while pos < piece.len() {
		match matcher(piece, pos) {
			Some(end) => {
				debug_assert!(
					pos < end && end <= piece.len(),
					"utoken: stage matcher must advance within bounds"
				);
				if pos > gap {
					f(&piece[gap..pos]);
				}
				f(&piece[pos..end]);
				pos = end;
				gap = end;
			},
			None => pos += U::decode(piece, pos).1,
		}
	}
	if gap < piece.len() {
		f(&piece[gap..]);
	}
}

/// `[一-龥぀-ゟ゠-ヿ]`.
#[inline]
const fn is_cjk(c: char) -> bool {
	matches!(c as u32, 0x3040..=0x30FF | 0x4E00..=0x9FA5)
}

/// `[\p{L}\p{M}]`.
#[inline]
fn is_lm(c: char) -> bool {
	cls::is_letter(c) || cls::is_mark(c)
}

/// `[\p{P}\p{S}]`. Via [`cls::group`], so the 17.0 symbol/punctuation
/// additions stay outside the class like the reference engine sees them.
#[inline]
fn is_ps(c: char) -> bool {
	matches!(cls::group(c), GCG::Punctuation | GCG::Symbol)
}

/// Stage 2: `[一-龥぀-ゟ゠-ヿ]+` at `pos`.
fn cjk_end<U: Unit>(units: &[U], pos: usize) -> Option<usize> {
	let mut i = pos;
	while let Some((c, n)) = decode_at(units, i) {
		if !is_cjk(c) {
			break;
		}
		i += n;
	}
	(i > pos).then_some(i)
}

/// Stage 3 alternates in leftmost-first order at `pos`; `None` on a gap
/// codepoint (e.g. digits, which stage 3 has no alternate for).
fn main_end<U: Unit>(units: &[U], pos: usize) -> Option<usize> {
	let (c, n) = decode_at(units, pos)?;

	// `[ascii punct][A-Za-z]+`
	if c.is_ascii_punctuation() {
		let mut i = pos + n;
		while let Some((c2, n2)) = decode_at(units, i) {
			if !c2.is_ascii_alphabetic() {
				break;
			}
			i += n2;
		}
		if i > pos + n {
			return Some(i);
		}
	}

	// `[^\r\n\p{L}\p{P}\p{S}]?[\p{L}\p{M}]+` — when the first codepoint is
	// in the run class the greedy optional prefix changes nothing (marks
	// are in both; the run absorbs them either way).
	if is_lm(c) {
		return Some(lm_run_end(units, pos + n));
	}
	if c != '\r' && c != '\n' && !is_ps(c) {
		// Not L (checked above), not P/S, not CR/LF: prefix-eligible.
		if let Some((c2, n2)) = decode_at(units, pos + n)
			&& is_lm(c2)
		{
			return Some(lm_run_end(units, pos + n + n2));
		}
	}

	// ` ?[\p{P}\p{S}]+[\r\n]*`
	if let Some(e) = ps_end(units, pos) {
		return Some(e);
	}

	// `\s*[\r\n]+|\s+(?!\S)|\s+`
	ws_end(units, pos)
}

/// Rest of a `[\p{L}\p{M}]+` run whose first codepoint ends at `pos`.
fn lm_run_end<U: Unit>(units: &[U], pos: usize) -> usize {
	let mut i = pos;
	while let Some((c, n)) = decode_at(units, i) {
		if !is_lm(c) {
			break;
		}
		i += n;
	}
	i
}

/// ` ?[\p{P}\p{S}]+[\r\n]*` at `pos`.
fn ps_end<U: Unit>(units: &[U], pos: usize) -> Option<usize> {
	let mut i = pos;
	if let Some((' ', n)) = decode_at(units, pos) {
		i += n;
	}
	let start = i;
	while let Some((c, n)) = decode_at(units, i) {
		if !is_ps(c) {
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
