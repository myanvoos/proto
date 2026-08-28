pub mod cl100k;
pub mod deepseek;
pub mod kimi;
pub mod o200k;
pub mod qwen;

use crate::utok::utf::Unit;

pub mod cls {
	use xutf::{GeneralCategory as GC, GeneralCategoryGroup as GCG, Script, Ucd};

	#[inline]
	pub fn category(c: char) -> GC {
		c.general_category()
	}

	#[inline]
	pub fn group(c: char) -> GCG {
		c.general_category_group()
	}

	#[inline]
	pub fn is_letter(c: char) -> bool {
		if c.is_ascii() {
			return c.is_ascii_alphabetic();
		}
		group(c) == GCG::Letter
	}

	#[inline]
	pub fn is_number(c: char) -> bool {
		if c.is_ascii() {
			return c.is_ascii_digit();
		}
		group(c) == GCG::Number
	}

	#[inline]
	pub fn is_mark(c: char) -> bool {
		!c.is_ascii() && group(c) == GCG::Mark
	}

	#[inline]
	pub const fn is_ws(c: char) -> bool {
		c.is_whitespace()
	}

	#[inline]
	pub fn is_han(c: char) -> bool {
		!c.is_ascii() && c.script() == Script::Han
	}

	#[inline]
	pub fn in_upper_set(c: char) -> bool {
		if c.is_ascii() {
			return c.is_ascii_uppercase();
		}
		let cat = category(c);
		matches!(
			cat,
			GC::UppercaseLetter | GC::TitlecaseLetter | GC::ModifierLetter | GC::OtherLetter
		) || cat.group() == GCG::Mark
	}

	#[inline]
	pub fn in_lower_set(c: char) -> bool {
		if c.is_ascii() {
			return c.is_ascii_lowercase();
		}
		let cat = category(c);
		matches!(cat, GC::LowercaseLetter | GC::ModifierLetter | GC::OtherLetter)
			|| cat.group() == GCG::Mark
	}
}

#[inline]
pub(crate) fn decode_at<U: Unit>(units: &[U], i: usize) -> Option<(char, usize)> {
	(i < units.len()).then(|| U::decode(units, i))
}

pub(crate) fn contraction_end<U: Unit>(units: &[U], pos: usize) -> usize {
	let Some(('\'', n0)) = decode_at(units, pos) else {
		return pos;
	};
	let Some((c1, n1)) = decode_at(units, pos + n0) else {
		return pos;
	};
	let one = pos + n0 + n1;
	match c1 {
		's' | 'S' | '\u{17f}' | 't' | 'T' | 'm' | 'M' | 'd' | 'D' => one,
		'r' | 'R' | 'v' | 'V' => match decode_at(units, one) {
			Some(('e' | 'E', n2)) => one + n2,
			_ => pos,
		},
		'l' | 'L' => match decode_at(units, one) {
			Some(('l' | 'L', n2)) => one + n2,
			_ => pos,
		},
		_ => pos,
	}
}

pub(crate) fn digits_end<U: Unit>(units: &[U], pos: usize) -> Option<usize> {
	let mut i = pos;
	for _ in 0..3 {
		match decode_at(units, i) {
			Some((c, n)) if cls::is_number(c) => i += n,
			_ => break,
		}
	}
	(i > pos).then_some(i)
}

pub(crate) fn punct_end<U: Unit>(units: &[U], pos: usize, trailing_slash: bool) -> Option<usize> {
	let mut i = pos;
	if let Some((' ', n)) = decode_at(units, pos) {
		i += n;
	}
	let start = i;
	while let Some((c, n)) = decode_at(units, i) {
		if cls::is_ws(c) || cls::is_letter(c) || cls::is_number(c) {
			break;
		}
		i += n;
	}
	if i == start {
		return None;
	}
	while let Some((c, n)) = decode_at(units, i) {
		if c == '\r' || c == '\n' || (trailing_slash && c == '/') {
			i += n;
		} else {
			break;
		}
	}
	Some(i)
}

pub(crate) fn ws_end<U: Unit>(units: &[U], pos: usize) -> Option<usize> {
	let mut i = pos;
	let mut last_nl_end = None;
	let mut last_len = 0;
	let mut cps = 0usize;
	while let Some((c, n)) = decode_at(units, i) {
		if !cls::is_ws(c) {
			break;
		}
		i += n;
		if c == '\r' || c == '\n' {
			last_nl_end = Some(i);
		}
		last_len = n;
		cps += 1;
	}
	if cps == 0 {
		return None;
	}
	if let Some(e) = last_nl_end {
		return Some(e);
	}
	if i == units.len() {
		return Some(i);
	}
	Some(if cps > 1 { i - last_len } else { i })
}
