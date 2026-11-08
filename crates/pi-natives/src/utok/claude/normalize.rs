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

fn hard_sub_end(s: &str, start: usize, end: usize) -> usize {
	let mut chars = s[start..end].char_indices();
	let kind = chars.next().map(|(_, first)| hard_kind(first));
	chars
		.find(|&(_, ch)| !is_variation_selector(ch) && Some(hard_kind(ch)) != kind)
		.map_or(end, |(off, _)| start + off)
}

/// The text split into maximal same-class runs, with terminal marks as
/// unmarked separators and HARD runs split where the pretoken kind changes.
/// Lazy: [`stream_norm`] looks at most two runs back and one ahead, so the
/// runs are never collected.
struct Runs<'a> {
	s:     &'a str,
	chars: std::str::CharIndices<'a>,
	/// The open run's start and class; `None` once the text is exhausted.
	open:  Option<(usize, Class)>,
	/// A closed HARD run's remainder still to split into sub-runs.
	hard:  Option<(usize, usize)>,
}

impl<'a> Runs<'a> {
	fn new(s: &'a str) -> Self {
		let mut chars = s.char_indices();
		let open = chars.next().map(|(_, first)| {
			let cls = classify(first);
			// Nothing in front of it, so no letter can be its base.
			let cls = if cls == Class::Wordy && is_stray_mark(first) {
				Class::StrayMark
			} else {
				cls
			};
			(0, cls)
		});
		Self { s, chars, open, hard: None }
	}

	/// Emit the closed run `start..end`, splitting a HARD run into sub-runs.
	fn close(&mut self, cls: Class, start: usize, end: usize) -> Run {
		if cls != Class::Hard {
			return Run { cls, start, end };
		}
		let sub_end = hard_sub_end(self.s, start, end);
		self.hard = (sub_end < end).then_some((sub_end, end));
		Run { cls, start, end: sub_end }
	}
}

impl Iterator for Runs<'_> {
	type Item = Run;

	fn next(&mut self) -> Option<Run> {
		if let Some((start, end)) = self.hard {
			return Some(self.close(Class::Hard, start, end));
		}
		let (start, cls) = self.open?;
		while let Some((i, ch)) = self.chars.next() {
			let c = classify(ch);
			// Consecutive unattached marks are one regex-style run; an accent
			// riding a separator run opens a stray word like any other.
			if cls == Class::StrayMark && c == Class::Wordy && is_stray_mark(ch) {
				continue;
			}
			if c == cls {
				continue;
			}
			let next = if c == Class::Wordy && cls != Class::Wordy && is_stray_mark(ch) {
				Class::StrayMark
			} else {
				c
			};
			self.open = Some((i, next));
			return Some(self.close(cls, start, i));
		}
		self.open = None;
		Some(self.close(cls, start, self.s.len()))
	}
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
			))
			&& !is_lower_x(c)
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

fn opens_word(s: &str, r: &Run, next: Option<&Run>) -> bool {
	r.end - r.start == 1
		&& s.as_bytes()[r.start] == b'\''
		&& next.is_some_and(|n| matches!(n.cls, Class::Wordy | Class::StrayMark))
}

fn takes_right_border(s: &str, run: &Run) -> bool {
	let body = &s[run.start..run.end];
	run.cls == Class::Punct
		|| hard_eow(body)
		|| (matches!(run.cls, Class::Digit | Class::Hard) && is_digit_run(body) && digit_eow(body))
}

fn contraction_seam(s: &str, r: &Run, prev: Option<&Run>, prev2: Option<&Run>) -> bool {
	let Some(prev) = prev else {
		return false;
	};
	if !is_contraction_suffix(&s.as_bytes()[r.start..r.end]) {
		return false;
	}
	if prev.cls != Class::Punct || prev.end - prev.start != 1 || s.as_bytes()[prev.start] != b'\'' {
		return false;
	}
	prev2.is_none_or(|p2| !takes_right_border(s, p2))
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

struct Stream<F: FnMut(&[u8])> {
	out:     Vec<u8>,
	/// Stream bytes already handed to `sink`.
	flushed: usize,
	/// Stream offset just past the last seam-dropped space's ⟨bow⟩.
	guard:   usize,
	sink:    F,
}

impl<F: FnMut(&[u8])> Stream<F> {
	/// Large enough that normalization and tiling alternate rarely: at 4 KiB
	/// their tables evicted each other often enough to cost ~2% of a count.
	const CHUNK: usize = 128 * 1024;
	const KEEP: usize = 8;

	/// Write ⟨bow⟩, applying the seam law: in `⟨eow⟩ ' ' [case markers] ⟨bow⟩`
	/// the space is not written as a character. The character before the
	/// ⟨eow⟩ has to start at or after `guard`, which is what keeps the
	/// rewrite non-overlapping and left-to-right, exactly as `re.sub` scans.
	fn push_bow(&mut self) {
		let out = &mut self.out;
		let mut case_at = out.len();
		while case_at >= 1 && matches!(out[case_at - 1], SHIFT | CAPS) {
			case_at -= 1;
		}
		// `case_at` is where this run's case markers begin: a seam needs ⟨eow⟩
		// and a space in front of them, plus a character before the ⟨eow⟩
		// that no earlier seam has consumed. A flush always leaves `KEEP`
		// bytes, so `case_at >= 3` holds here whenever it does stream-wide.
		let seam = case_at >= 3
			&& out[case_at - 1] == b' '
			&& out[case_at - 2] == EOW
			&& self.flushed + prev_char_start(out, case_at - 2) >= self.guard;
		if seam {
			// Drop the space, sliding this run's case markers down over it.
			out.copy_within(case_at.., case_at - 1);
			out.truncate(out.len() - 1);
		}
		out.push(BOW);
		if seam {
			self.guard = self.flushed + out.len();
		}
	}

	/// Append run text; a long run streams straight through to `sink`.
	fn text(&mut self, body: &[u8]) {
		if body.len() <= Self::CHUNK {
			self.out.extend_from_slice(body);
			return;
		}
		(self.sink)(&self.out);
		let k = body.len() - Self::KEEP;
		(self.sink)(&body[..k]);
		self.flushed += self.out.len() + k;
		self.out.clear();
		self.out.extend_from_slice(&body[k..]);
	}

	/// Append a word body in its case form. A lowered body is written
	/// `CHUNK` source bytes at a time with a flush between, so a long word
	/// never sits whole in `out` any more than a long literal run does.
	fn case_body(&mut self, span: &str, form: &CaseForm) {
		// `case_form` never opens a `ShiftKeepDotted` span with İ, so keeping
		// every İ is keeping all but the first character's: no piece needs to
		// know whether it holds the span's head.
		let keep_dotted = match form {
			CaseForm::Literal => return self.text(span.as_bytes()),
			CaseForm::Shift | CaseForm::Caps => false,
			CaseForm::ShiftKeepDotted => true,
		};
		let mut rest = span;
		while !rest.is_empty() {
			let (piece, tail) = rest.split_at(rest.floor_char_boundary(Self::CHUNK));
			if piece.is_ascii() {
				self
					.out
					.extend(piece.bytes().map(|b| b.to_ascii_lowercase()));
			} else {
				// Per-char lowering never applies Final_Sigma, so Σ lowers to
				// σ everywhere — exactly the oracle's ⟨caps⟩ body spelling.
				for c in piece.chars() {
					if keep_dotted && c == 'İ' {
						push_char(c, &mut self.out);
					} else {
						push_lower(c, &mut self.out);
					}
				}
			}
			self.settle();
			rest = tail;
		}
	}

	/// Flush all but the rewritable tail once the buffer is large.
	fn settle(&mut self) {
		if self.out.len() > Self::CHUNK {
			let k = self.out.len() - Self::KEEP;
			(self.sink)(&self.out[..k]);
			self.out.drain(..k);
			self.flushed += k;
		}
	}
}

/// The marked stream over already-normalized text, in the internal marked
/// form, delivered to `sink` in order as consecutive chunks. A WORDY run is
/// bracketed by ⟨bow⟩/⟨eow⟩ and case-normalized; the ⟨eow⟩⟨bow⟩ seam encodes
/// a single space between two such runs; punct, digit, separator and
/// stray-mark runs receive their measured boundary markers.
pub fn stream_norm(norm: &str, p: &FrameParams, raw_head_space: bool, sink: impl FnMut(&[u8])) {
	let mut s = norm;
	// The frame's tail for a ladder family; a "free" family was stripped on
	// the raw text instead (see `content_token_count`).
	if p.ladder {
		s = s.trim_end_matches('\n');
	}
	// A single leading space is dropped where the frame ends in ⟨bow⟩: that
	// ⟨bow⟩ is the space (' a' = 1). Two or more are a whitespace-run token
	// and stay.
	if p.frame_bow
		&& raw_head_space
		&& s.as_bytes().first() == Some(&b' ')
		&& s.as_bytes().get(1) != Some(&b' ')
	{
		s = &s[1..];
	}

	let mut stream = Stream { out: Vec::with_capacity(256), flushed: 0, guard: 0, sink };
	let mut runs = Runs::new(s);
	let Some(first) = runs.next() else {
		// Content that normalizes away entirely still pays for the frame's
		// ⟨bow⟩; with nothing to attach to it, it tiles as itself.
		if p.frame_bow {
			(stream.sink)(&[BOW]);
		}
		return;
	};
	let bytes = s.as_bytes();

	// Whether the neighbor run on side `side` (-1 left, +1 right) supplies a
	// border space; `None` is the message edge.
	let borders_space = |neighbor: Option<&Run>, side: isize| -> bool {
		let Some(r) = neighbor else {
			// Message start counts: the frame ends in ⟨bow⟩, which is a
			// space. Message end does not: the trailing frame is not a space.
			return side < 0 && p.frame_bow;
		};
		if r.cls != Class::Space {
			return false;
		}
		if side < 0 {
			bytes[r.end - 1] == b' '
		} else {
			// Run-kills-marker: a right-hand marker is written for the seam
			// space only, never before a run of two or more spaces.
			bytes[r.start] == b' ' && (r.end - r.start < 2 || bytes[r.start + 1] != b' ')
		}
	};

	// The window of runs every rule reads: two back, the current one, one ahead.
	let (mut prev2, mut prev): (Option<Run>, Option<Run>) = (None, None);
	let mut cur = first;
	let mut next = runs.next();

	let head_quote = opens_word(s, &cur, next.as_ref());
	let first_body = &s[cur.start..cur.end];
	let has_own_bow = !head_quote
		&& (matches!(cur.cls, Class::Wordy | Class::Punct | Class::StrayMark)
			|| hard_bow(first_body)
			|| (matches!(cur.cls, Class::Digit | Class::Hard) && digit_bow(first_body))
			|| (cur.cls == Class::Space && bytes[cur.start] == b' '));
	if !has_own_bow && p.frame_bow {
		// The frame ends in ⟨bow⟩, always; a run that supplies none leaves it
		// to be written here, where it tiles as itself. A word-opening `'`
		// receives the frame's space as the character it is.
		stream.out.push(if head_quote { b' ' } else { BOW });
	}

	loop {
		let r = &cur;
		let body = &s[r.start..r.end];
		match r.cls {
			Class::Wordy => {
				// Flanked on both sides, except where a contraction apostrophe
				// is already its opening boundary or an unattached mark run
				// already opened this word.
				let fused = prev.is_some_and(|left| left.cls == Class::StrayMark);
				let form = case_form(body, p.allcaps_min, fused);
				match form {
					CaseForm::Shift | CaseForm::ShiftKeepDotted => stream.out.push(SHIFT),
					CaseForm::Caps => stream.out.push(CAPS),
					CaseForm::Literal => {},
				}
				if !(fused || contraction_seam(s, r, prev.as_ref(), prev2.as_ref())) {
					stream.push_bow();
				}
				stream.case_body(body, &form);
				stream.out.push(EOW);
			},
			Class::StrayMark => {
				// A stray-mark pretoken is a word: ⟨bow⟩ on the left always,
				// ⟨eow⟩ on the right against everything except a letter, which
				// is the rest of the same word.
				stream.push_bow();
				stream.text(body.as_bytes());
				if !next.is_some_and(|n| n.cls == Class::Wordy) {
					stream.out.push(EOW);
				}
			},
			_ if r.cls == Class::Punct || hard_bow(body) || hard_eow(body) => {
				// A punct span is marked only on the side that borders
				// whitespace: `a! b` gets `!⟨eow⟩`, `a!b` a bare `!`.
				let takes_bow = borders_space(prev.as_ref(), -1)
					&& !opens_word(s, r, next.as_ref())
					&& (r.cls == Class::Punct || hard_bow(body));
				if takes_bow {
					stream.push_bow();
				}
				stream.text(body.as_bytes());
				if borders_space(next.as_ref(), 1) && (r.cls == Class::Punct || hard_eow(body)) {
					stream.out.push(EOW);
				}
			},
			Class::Digit | Class::Hard if is_digit_run(body) => {
				// Same border markers as punctuation, decided per border
				// character; deliberately no lookback across the space.
				if digit_bow(body) && borders_space(prev.as_ref(), -1) {
					stream.push_bow();
				}
				stream.text(body.as_bytes());
				if digit_eow(body) && borders_space(next.as_ref(), 1) {
					stream.out.push(EOW);
				}
			},
			_ => stream.text(body.as_bytes()), // HARD letter scripts and whitespace
		}
		stream.settle();
		let Some(n) = next else {
			break;
		};
		prev2 = prev;
		prev = Some(cur);
		cur = n;
		next = runs.next();
	}
	(stream.sink)(&stream.out);
}
