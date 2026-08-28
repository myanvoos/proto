use super::{cls, contraction_end, decode_at, digits_end, punct_end, ws_end};
use crate::utok::utf::Unit;

#[inline]
fn in_a(c: char) -> bool {
	cls::in_upper_set(c) && !cls::is_han(c)
}

#[inline]
fn in_b(c: char) -> bool {
	cls::in_lower_set(c) && !cls::is_han(c)
}

fn core_lower<U: Unit>(units: &[U], pos: usize) -> Option<usize> {
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

pub fn next_piece<U: Unit>(units: &[U], pos: usize) -> usize {
	let (c0, l0) = U::decode(units, pos);

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

	if let Some(e) = digits_end(units, pos) {
		return e;
	}

	if let Some(e) = punct_end(units, pos, false) {
		return e;
	}

	if let Some(e) = ws_end(units, pos) {
		return e;
	}

	pos + l0
}
