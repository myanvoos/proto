use super::{cls, contraction_end, decode_at, ws_end};
use crate::utok::utf::Unit;

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
		return pos + n;
	}
	if let Some(e) = punct(units, pos) {
		return e;
	}
	if let Some(e) = ws_end(units, pos) {
		return e;
	}

	pos + n
}

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

fn word<U: Unit>(units: &[U], pos: usize) -> Option<usize> {
	let (c, n) = decode_at(units, pos)?;
	if c != '\r' && c != '\n' && !cls::is_letter(c) && !cls::is_number(c) {
		let e = lm_run_end(units, pos + n);
		if e > pos + n {
			return Some(e);
		}

		return cls::is_mark(c).then_some(pos + n);
	}

	let e = lm_run_end(units, pos);
	(e > pos).then_some(e)
}

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
