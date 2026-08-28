use super::{cls, contraction_end, decode_at, digits_end, punct_end, ws_end};
use crate::utok::utf::Unit;

pub fn next_piece<U: Unit>(units: &[U], pos: usize) -> usize {
	let e = contraction_end(units, pos);
	if e > pos {
		return e;
	}
	if let Some(e) = word(units, pos) {
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

	pos + decode_at(units, pos).map_or(1, |(_, n)| n)
}

fn word<U: Unit>(units: &[U], pos: usize) -> Option<usize> {
	let (c, n) = decode_at(units, pos)?;
	let start = if c != '\r' && c != '\n' && !cls::is_letter(c) && !cls::is_number(c) {
		pos + n
	} else {
		pos
	};
	let mut i = start;
	while let Some((c, n)) = decode_at(units, i) {
		if !cls::is_letter(c) {
			break;
		}
		i += n;
	}
	(i > start).then_some(i)
}
