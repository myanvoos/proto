use std::borrow::Cow;

use xutf::{
	GeneralCategory, GeneralCategoryGroup, IntoUnicodeNormalized, ToUnicodeNormalized, Ucd,
	canonical_combining_class, is_nfc, is_nfc_codepoints,
};

use super::constants::{
	BOW, CAPS, EOW, NON_SEPARATOR, SHIFT, fold_quote, in_separator_ranges, is_contraction_suffix,
	is_funny_space, is_punct_sym, is_stripped_control, is_stripped_private, is_symbol_letter,
	is_variation_selector,
};
use crate::utok::utf::Unit;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Class {
	Wordy,

	Hard,

	Digit,

	Punct,

	Space,

	StrayMark,
}

#[derive(Clone, Copy)]
pub struct Run {
	pub cls:   Class,
	pub start: usize,
	pub end:   usize,
}

#[derive(Clone, Copy)]
pub struct FrameParams {
	pub message_overhead: u32,

	pub fold_quotes: bool,

	pub allcaps_min: Option<usize>,

	pub frame_bow: bool,

	pub ladder: bool,
}

const NEW_CASE_PAIRS: [(char, char); 2] = [('\u{1c89}', '\u{1c8a}'), ('\u{a7cb}', '\u{0264}')];

fn new_case_lower(c: char) -> Option<char> {
	NEW_CASE_PAIRS
		.iter()
		.find(|&&(u, _)| u == c)
		.map(|&(_, l)| l)
}

fn is_new_cased(c: char) -> bool {
	NEW_CASE_PAIRS.iter().any(|&(u, l)| u == c || l == c)
}

fn is_upper_x(c: char) -> bool {
	new_case_lower(c).is_some() || c.is_uppercase()
}

fn is_lower_x(c: char) -> bool {
	NEW_CASE_PAIRS.iter().any(|&(_, l)| l == c) || c.is_lowercase()
}

fn lowers_to_self(c: char) -> bool {
	if new_case_lower(c).is_some() {
		return false;
	}
	let mut it = c.to_lowercase();
	it.next() == Some(c) && it.next().is_none()
}

#[inline]
fn push_char(c: char, out: &mut Vec<u8>) {
	let mut buf = [0u8; 4];
	out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
}

fn push_lower(c: char, out: &mut Vec<u8>) {
	match new_case_lower(c) {
		Some(l) => push_char(l, out),
		None => {
			for l in c.to_lowercase() {
				push_char(l, out);
			}
		},
	}
}

#[inline]
const fn ascii_needs_fold(b: u8) -> bool {
	matches!(b, 0x00..=0x08 | 0x0b..=0x1f | 0x7f)
}

pub fn nfc(text: &str, fold_quotes: bool) -> Cow<'_, str> {
	if text.is_ascii() {
		if !text.bytes().any(ascii_needs_fold) {
			return Cow::Borrowed(text);
		}
		let mut out = String::with_capacity(text.len());
		for b in text.bytes() {
			match b {
				0x00 => out.push(' '),
				b if ascii_needs_fold(b) => {},
				b => out.push(char::from(b)),
			}
		}
		return Cow::Owned(out);
	}
	if is_nfc(text) {
		return Cow::Owned(fold_chars(text.chars(), fold_quotes, text.len()));
	}
	let composed = text.to_nfc();
	let folded = fold_chars(composed.chars(), fold_quotes, composed.len());
	Cow::Owned(folded)
}

fn fold_chars(chars: impl Iterator<Item = char>, fold_quotes: bool, cap: usize) -> String {
	let mut out = String::with_capacity(cap);
	for c in chars {
		if is_stripped_control(c) {
			continue;
		}
		let c = if c == '\0' { ' ' } else { c };

		if c == '\u{0e32}' && out.ends_with('\u{0e4d}') {
			out.pop();
			out.push('\u{0e33}');
			continue;
		}
		if is_stripped_private(c) {
			continue;
		}
		let c = if fold_quotes { fold_quote(c) } else { c };
		out.push(if is_funny_space(c) { ' ' } else { c });
	}
	out
}

fn as_str<U: Unit>(units: &[U]) -> Option<&str> {
	std::str::from_utf8(U::as_utf8(units)?).ok()
}

struct UnitChars<'a, U: Unit> {
	units: &'a [U],
	pos:   usize,
}

impl<U: Unit> Iterator for UnitChars<'_, U> {
	type Item = char;

	#[inline]
	fn next(&mut self) -> Option<char> {
		if self.pos >= self.units.len() {
			return None;
		}
		let (c, n) = U::decode(self.units, self.pos);
		self.pos += n;
		Some(c)
	}
}

pub fn nfc_units<U: Unit>(units: &[U], fold_quotes: bool) -> Cow<'_, str> {
	if let Some(text) = as_str(units) {
		return nfc(text, fold_quotes);
	}
	if is_nfc_codepoints(UnitChars { units, pos: 0 }.map(u32::from)) {
		return Cow::Owned(fold_chars(UnitChars { units, pos: 0 }, fold_quotes, units.len()));
	}
	let composed: String = UnitChars { units, pos: 0 }.collect::<String>().into_nfc();
	let folded = fold_chars(composed.chars(), fold_quotes, composed.len());
	Cow::Owned(folded)
}

fn is_hard_cp(o: u32) -> bool {
	o >= 0x10000
		|| (0x4e00..=0x9fff).contains(&o)
		|| (0x3400..=0x4dbf).contains(&o)
		|| (0xf900..=0xfaff).contains(&o)
		|| (0xac00..=0xd7a3).contains(&o)
		|| o == 0x3005
		|| o == 0x3006
		|| (0x06dd..=0x06e0).contains(&o)
		|| (0x06e9..=0x06ec).contains(&o)
}

pub fn is_separator(c: char) -> bool {
	!c.is_ascii() && is_separator_general(c)
}

fn is_separator_general(c: char) -> bool {
	(canonical_combining_class(c as u32) == 9 && c != NON_SEPARATOR) || in_separator_ranges(c as u32)
}

static ASCII_CLASS: [Class; 128] = {
	let mut table = [Class::Hard; 128];
	let mut i = 0usize;
	while i < 128 {
		table[i] = match i as u8 {
			b'\t' | b'\n' | 0x0b | 0x0c | b'\r' | b' ' => Class::Space,
			b'0'..=b'9' => Class::Digit,
			b'A'..=b'Z' | b'a'..=b'z' => Class::Wordy,

			0x21..=0x2f | 0x3a..=0x40 | 0x5b..=0x60 | 0x7b..=0x7e => Class::Punct,

			_ => Class::Hard,
		};
		i += 1;
	}
	table
};

pub fn classify(c: char) -> Class {
	if c.is_ascii() {
		return ASCII_CLASS[c as usize];
	}
	if is_ideograph(c as u32) {
		return Class::Hard;
	}
	classify_nonascii(c)
}

const fn is_ideograph(o: u32) -> bool {
	matches!(o, 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xac00..=0xd7a3)
}

fn classify_nonascii(c: char) -> Class {
	if is_separator(c) {
		return Class::Hard;
	}
	if is_new_cased(c) {
		return Class::Wordy;
	}
	let o = c as u32;
	let group = c.general_category_group();
	if group == GeneralCategoryGroup::Separator
		|| matches!(c, '\t' | '\n' | '\r' | '\u{0b}' | '\u{0c}')
	{
		return Class::Space;
	}
	if is_symbol_letter(o) {
		return Class::Wordy;
	}
	let cat = c.general_category();
	if cat == GeneralCategory::DecimalNumber
		&& (o < 0x80 || (0x0660..=0x0669).contains(&o) || (0x06f0..=0x06f9).contains(&o))
	{
		return Class::Digit;
	}
	if o < 0x80 && matches!(group, GeneralCategoryGroup::Punctuation | GeneralCategoryGroup::Symbol)
	{
		return Class::Punct;
	}
	if is_punct_sym(c) {
		return Class::Punct;
	}
	if is_variation_selector(c) {
		return Class::Hard;
	}
	if o == 0x0cf3 {
		return Class::Wordy;
	}
	if matches!(group, GeneralCategoryGroup::Letter | GeneralCategoryGroup::Mark) && !is_hard_cp(o) {
		return Class::Wordy;
	}
	Class::Hard
}

fn is_syriac_vowel(c: char) -> bool {
	let o = c as u32;
	o == 0x0711 || (0x0730..=0x073f).contains(&o)
}

fn is_stray_mark(c: char) -> bool {
	!c.is_ascii() && is_stray_mark_general(c)
}

fn is_stray_mark_general(c: char) -> bool {
	if is_syriac_vowel(c) {
		return false;
	}
	canonical_combining_class(c as u32) != 0 && !is_separator(c)
}

fn digit_border(c: char) -> bool {
	!c.is_ascii() && digit_border_general(c)
}

fn digit_border_general(c: char) -> bool {
	let cat = c.general_category();
	(cat == GeneralCategory::OtherNumber || (cat == GeneralCategory::DecimalNumber && !c.is_ascii()))
		&& (c as u32) < 0x10000
}

fn is_digit_run(body: &str) -> bool {
	if body.is_ascii() {
		return !body.is_empty() && body.bytes().all(|b| b.is_ascii_digit());
	}
	is_digit_run_general(body)
}

fn is_digit_run_general(body: &str) -> bool {
	let mut chars = body.chars();
	let Some(first) = chars.next() else {
		return false;
	};
	let category = first.general_category();
	if !matches!(category, GeneralCategory::DecimalNumber | GeneralCategory::OtherNumber) {
		return false;
	}
	chars.all(|c| c.general_category() == category)
}

fn digit_bow(body: &str) -> bool {
	is_digit_run(body) && body.chars().next().is_some_and(digit_border)
}

fn digit_eow(body: &str) -> bool {
	is_digit_run(body) && body.chars().next_back().is_some_and(digit_border)
}

fn marks_like_punct(c: char) -> bool {
	if c.is_ascii() {
		return ASCII_CLASS[c as usize] == Class::Punct;
	}
	if is_ideograph(c as u32) {
		return false;
	}
	marks_like_punct_general(c)
}

fn marks_like_punct_general(c: char) -> bool {
	let o = c as u32;
	if o >= 0x10000 {
		return false;
	}
	if is_separator(c) {
		return true;
	}

	match c.general_category_group() {
		GeneralCategoryGroup::Punctuation => !(0x3001..=0x303f).contains(&o),
		GeneralCategoryGroup::Symbol => true,
		GeneralCategoryGroup::Other => {
			matches!(c.general_category(), GeneralCategory::Format | GeneralCategory::Unassigned)
		},
		_ => false,
	}
}

fn hard_bow(body: &str) -> bool {
	body
		.chars()
		.next()
		.is_some_and(|c| is_variation_selector(c) || marks_like_punct(c))
}

fn hard_eow(body: &str) -> bool {
	body
		.chars()
		.next_back()
		.is_some_and(|c| is_variation_selector(c) || marks_like_punct(c))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum HardKind {
	Punct,
	Number,
	Letter,
}

fn hard_kind(c: char) -> HardKind {
	if is_ideograph(c as u32) {
		return HardKind::Letter;
	}
	hard_kind_general(c)
}

fn hard_kind_general(c: char) -> HardKind {
	if marks_like_punct_general(c) {
		HardKind::Punct
	} else if digit_border_general(c) {
		HardKind::Number
	} else {
		HardKind::Letter
	}
}

fn push_run(runs: &mut Vec<Run>, s: &str, cls: Class, start: usize, end: usize) {
	if cls != Class::Hard {
		runs.push(Run { cls, start, end });
		return;
	}
	let body = &s[start..end];
	let mut chars = body.char_indices();
	let Some((_, first)) = chars.next() else {
		return;
	};
	let mut sub_start = start;
	let mut kind = hard_kind(first);
	for (off, ch) in chars {
		if is_variation_selector(ch) || hard_kind(ch) == kind {
			continue;
		}
		runs.push(Run { cls: Class::Hard, start: sub_start, end: start + off });
		sub_start = start + off;
		kind = hard_kind(ch);
	}
	runs.push(Run { cls: Class::Hard, start: sub_start, end });
}

fn split_runs(s: &str) -> Vec<Run> {
	let mut runs: Vec<Run> = Vec::with_capacity(s.len() / 3 + 8);
	let mut chars = s.char_indices();
	let Some((_, first)) = chars.next() else {
		return runs;
	};
	let mut start = 0usize;
	let mut cls = classify(first);
	if cls == Class::Wordy && is_stray_mark(first) {
		cls = Class::StrayMark;
	}
	for (i, ch) in chars {
		let c = classify(ch);

		if cls == Class::StrayMark && c == Class::Wordy && is_stray_mark(ch) {
			continue;
		}
		if c == cls {
			continue;
		}
		if c == Class::Wordy && cls != Class::Wordy && is_stray_mark(ch) {
			push_run(&mut runs, s, cls, start, i);
			start = i;
			cls = Class::StrayMark;
			continue;
		}
		push_run(&mut runs, s, cls, start, i);
		start = i;
		cls = c;
	}
	push_run(&mut runs, s, cls, start, s.len());
	runs
}

enum CaseForm {
	Literal,

	Shift,

	ShiftKeepDotted,

	Caps,
}

fn span_is_upper(span: &str) -> bool {
	let mut saw_cased = false;
	for c in span.chars() {
		if is_upper_x(c) {
			saw_cased = true;
		} else if is_lower_x(c) {
			return false;
		}
	}
	saw_cased
}

fn case_form(span: &str, allcaps_min: Option<usize>, head_mark: bool) -> CaseForm {
	if head_mark {
		return CaseForm::Literal;
	}
	if span.is_ascii() {
		let bytes = span.as_bytes();
		let mut any_upper = false;
		let mut any_lower = false;
		let mut upper_after_first = false;
		for (i, &b) in bytes.iter().enumerate() {
			if b.is_ascii_uppercase() {
				any_upper = true;
				upper_after_first |= i > 0;
			} else if b.is_ascii_lowercase() {
				any_lower = true;
			}
		}
		if allcaps_min.is_some_and(|min| span.len() >= min && any_upper && !any_lower) {
			return CaseForm::Caps;
		}
		if any_upper && !upper_after_first && bytes[0].is_ascii_uppercase() {
			return CaseForm::Shift;
		}
		return CaseForm::Literal;
	}
	if span.contains('ẞ') {
		return CaseForm::Literal;
	}
	let first = span.chars().next().expect("run bodies are non-empty");
	if span.contains('İ') {
		if is_upper_x(first)
			&& first != 'İ'
			&& !span.chars().skip(1).any(|c| c != 'İ' && is_upper_x(c))
		{
			return CaseForm::ShiftKeepDotted;
		}
		return CaseForm::Literal;
	}

	let unlowerable = span.chars().any(|c| {
		(is_new_cased(c)
			|| matches!(
				c.general_category_group(),
				GeneralCategoryGroup::Letter | GeneralCategoryGroup::Mark
			)) && !is_lower_x(c)
			&& (!is_upper_x(c) || lowers_to_self(c))
	});
	if let Some(min) = allcaps_min
		&& span.chars().count() >= min
		&& span_is_upper(span)
		&& !unlowerable
	{
		return CaseForm::Caps;
	}
	if lowers_to_self(first) {
		return CaseForm::Literal;
	}
	if is_upper_x(first) && !span.chars().skip(1).any(is_upper_x) {
		return CaseForm::Shift;
	}
	CaseForm::Literal
}

fn emit_case_body(span: &str, form: &CaseForm, out: &mut Vec<u8>) {
	match form {
		CaseForm::Literal => out.extend_from_slice(span.as_bytes()),

		CaseForm::Shift | CaseForm::Caps => {
			if span.is_ascii() {
				out.extend(span.bytes().map(|b| b.to_ascii_lowercase()));
			} else {
				for c in span.chars() {
					push_lower(c, out);
				}
			}
		},
		CaseForm::ShiftKeepDotted => {
			let mut chars = span.chars();
			push_lower(chars.next().expect("run bodies are non-empty"), out);
			for c in chars {
				if c == 'İ' {
					push_char(c, out);
				} else {
					push_lower(c, out);
				}
			}
		},
	}
}

const fn opens_word(s: &str, runs: &[Run], i: usize) -> bool {
	let r = &runs[i];
	r.end - r.start == 1
		&& s.as_bytes()[r.start] == b'\''
		&& i + 1 < runs.len()
		&& matches!(runs[i + 1].cls, Class::Wordy | Class::StrayMark)
}

fn takes_right_border(s: &str, run: &Run) -> bool {
	let body = &s[run.start..run.end];
	run.cls == Class::Punct
		|| hard_eow(body)
		|| (matches!(run.cls, Class::Digit | Class::Hard) && is_digit_run(body) && digit_eow(body))
}

fn contraction_seam(s: &str, runs: &[Run], i: usize) -> bool {
	if i == 0 {
		return false;
	}
	let r = &runs[i];
	if !is_contraction_suffix(&s.as_bytes()[r.start..r.end]) {
		return false;
	}
	let prev = &runs[i - 1];
	if prev.cls != Class::Punct || prev.end - prev.start != 1 || s.as_bytes()[prev.start] != b'\'' {
		return false;
	}
	i < 2 || !takes_right_border(s, &runs[i - 2])
}

pub fn raw_head_space_units<U: Unit>(units: &[U]) -> bool {
	!units.is_empty() && U::decode(units, 0).0 == ' '
}

pub fn trim_end_ws<U: Unit>(units: &[U]) -> &[U] {
	let Some(&last) = units.last() else {
		return units;
	};
	let mut buf = [last; 4];
	let ws: [U; 6] = [' ', '\t', '\n', '\r', '\u{0b}', '\u{0c}'].map(|c| {
		let n = U::encode(c, &mut buf);
		debug_assert_eq!(n, 1, "ASCII must encode as one unit");
		buf[0]
	});
	let mut end = units.len();
	while end > 0 && ws.contains(&units[end - 1]) {
		end -= 1;
	}
	&units[..end]
}

#[inline]
const fn prev_char_start(out: &[u8], at: usize) -> usize {
	let mut start = at - 1;
	while out[start] & 0xc0 == 0x80 {
		start -= 1;
	}
	start
}

fn push_bow(out: &mut Vec<u8>, guard: &mut usize) {
	let mut case_at = out.len();
	while case_at >= 1 && matches!(out[case_at - 1], SHIFT | CAPS) {
		case_at -= 1;
	}

	let seam = case_at >= 3
		&& out[case_at - 1] == b' '
		&& out[case_at - 2] == EOW
		&& prev_char_start(out, case_at - 2) >= *guard;
	if seam {
		out.copy_within(case_at.., case_at - 1);
		out.truncate(out.len() - 1);
	}
	out.push(BOW);
	if seam {
		*guard = out.len();
	}
}

pub fn stream_norm(norm: &str, p: &FrameParams, raw_head_space: bool) -> Vec<u8> {
	let mut s = norm;

	if p.ladder {
		s = s.trim_end_matches('\n');
	}

	if p.frame_bow
		&& raw_head_space
		&& s.as_bytes().first() == Some(&b' ')
		&& s.as_bytes().get(1) != Some(&b' ')
	{
		s = &s[1..];
	}

	let runs = split_runs(s);
	if runs.is_empty() {
		return if p.frame_bow { vec![BOW] } else { Vec::new() };
	}
	let bytes = s.as_bytes();

	let borders_space = |i: usize, side: isize| -> bool {
		let at = i as isize + side;
		if at < 0 {
			return p.frame_bow;
		}
		let at = at as usize;
		if at >= runs.len() {
			return false;
		}
		let r = &runs[at];
		if r.cls != Class::Space {
			return false;
		}
		if side < 0 {
			bytes[r.end - 1] == b' '
		} else {
			bytes[r.start] == b' ' && (r.end - r.start < 2 || bytes[r.start + 1] != b' ')
		}
	};

	let mut out: Vec<u8> = Vec::with_capacity(s.len() + s.len() / 2 + 16);

	let mut guard = 0usize;
	let head_quote = opens_word(s, &runs, 0);
	let first = &runs[0];
	let first_body = &s[first.start..first.end];
	let has_own_bow = !head_quote
		&& (matches!(first.cls, Class::Wordy | Class::Punct | Class::StrayMark)
			|| hard_bow(first_body)
			|| (matches!(first.cls, Class::Digit | Class::Hard) && digit_bow(first_body))
			|| (first.cls == Class::Space && bytes[first.start] == b' '));
	if !has_own_bow && p.frame_bow {
		if head_quote {
			out.push(b' ');
		} else {
			out.push(BOW);
		}
	}

	for i in 0..runs.len() {
		let r = &runs[i];
		let body = &s[r.start..r.end];
		match r.cls {
			Class::Wordy => {
				let fused = i > 0 && runs[i - 1].cls == Class::StrayMark;
				let form = case_form(body, p.allcaps_min, fused);
				match form {
					CaseForm::Shift | CaseForm::ShiftKeepDotted => out.push(SHIFT),
					CaseForm::Caps => out.push(CAPS),
					CaseForm::Literal => {},
				}
				if !(fused || contraction_seam(s, &runs, i)) {
					push_bow(&mut out, &mut guard);
				}
				emit_case_body(body, &form, &mut out);
				out.push(EOW);
			},
			Class::StrayMark => {
				push_bow(&mut out, &mut guard);
				out.extend_from_slice(body.as_bytes());
				let letter_follows = i + 1 < runs.len() && runs[i + 1].cls == Class::Wordy;
				if !letter_follows {
					out.push(EOW);
				}
			},
			_ if r.cls == Class::Punct || hard_bow(body) || hard_eow(body) => {
				let takes_bow = borders_space(i, -1)
					&& !opens_word(s, &runs, i)
					&& (r.cls == Class::Punct || hard_bow(body));
				if takes_bow {
					push_bow(&mut out, &mut guard);
				}
				out.extend_from_slice(body.as_bytes());
				if borders_space(i, 1) && (r.cls == Class::Punct || hard_eow(body)) {
					out.push(EOW);
				}
			},
			Class::Digit | Class::Hard if is_digit_run(body) => {
				if digit_bow(body) && borders_space(i, -1) {
					push_bow(&mut out, &mut guard);
				}
				out.extend_from_slice(body.as_bytes());
				if digit_eow(body) && borders_space(i, 1) {
					out.push(EOW);
				}
			},
			_ => out.extend_from_slice(body.as_bytes()),
		}
	}
	out
}
