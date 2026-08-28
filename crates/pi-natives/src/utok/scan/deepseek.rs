use xutf::GeneralCategoryGroup as GCG;

use super::{cls, decode_at, digits_end, ws_end};
use crate::utok::utf::Unit;

pub fn for_each_piece<U: Unit>(units: &[U], f: &mut impl FnMut(&[U])) {
	isolated(units, digits_end, &mut |p1: &[U]| {
		isolated(p1, cjk_end, &mut |p2: &[U]| {
			isolated(p2, main_end, f);
		});
	});
}

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

#[inline]
const fn is_cjk(c: char) -> bool {
	matches!(c as u32, 0x3040..=0x30FF | 0x4E00..=0x9FA5)
}

#[inline]
fn is_lm(c: char) -> bool {
	cls::is_letter(c) || cls::is_mark(c)
}

#[inline]
fn is_ps(c: char) -> bool {
	matches!(cls::group(c), GCG::Punctuation | GCG::Symbol)
}

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

fn main_end<U: Unit>(units: &[U], pos: usize) -> Option<usize> {
	let (c, n) = decode_at(units, pos)?;

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

	if is_lm(c) {
		return Some(lm_run_end(units, pos + n));
	}
	if c != '\r'
		&& c != '\n'
		&& !is_ps(c)
		&& let Some((c2, n2)) = decode_at(units, pos + n)
		&& is_lm(c2)
	{
		return Some(lm_run_end(units, pos + n + n2));
	}

	if let Some(e) = ps_end(units, pos) {
		return Some(e);
	}

	ws_end(units, pos)
}

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
