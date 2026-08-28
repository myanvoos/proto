use super::{cls, contraction_end, decode_at, digits_end, punct_end, ws_end};
use crate::utok::utf::Unit;

pub fn next_piece<U: Unit>(units: &[U], pos: usize) -> usize {
	if let Some(e) = word(units, pos) {
		return contraction_end(units, e);
	}
	if let Some(e) = digits_end(units, pos) {
		return e;
	}
	if let Some(e) = punct_end(units, pos, true) {
		return e;
	}
	if let Some(e) = ws_end(units, pos) {
		return e;
	}

	pos + decode_at(units, pos).map_or(1, |(_, n)| n)
}

fn word<U: Unit>(units: &[U], pos: usize) -> Option<usize> {
	let (c, n) = decode_at(units, pos)?;
	let prefix =
		(c != '\r' && c != '\n' && !cls::is_letter(c) && !cls::is_number(c)).then_some(pos + n);
	if let Some(p) = prefix
		&& let Some(e) = body1(units, p)
	{
		return Some(e);
	}
	if let Some(e) = body1(units, pos) {
		return Some(e);
	}
	if let Some(p) = prefix
		&& let Some(e) = body2(units, p)
	{
		return Some(e);
	}
	body2(units, pos)
}

fn body1<U: Unit>(units: &[U], pos: usize) -> Option<usize> {
	let mut i = pos;
	let mut last_shared_end = None;
	while let Some((c, n)) = decode_at(units, i) {
		if !cls::in_upper_set(c) {
			break;
		}
		if cls::in_lower_set(c) {
			last_shared_end = Some(i + n);
		}
		i += n;
	}
	if let Some((c, n)) = decode_at(units, i)
		&& cls::in_lower_set(c)
	{
		let mut j = i + n;
		while let Some((c, n)) = decode_at(units, j) {
			if !cls::in_lower_set(c) {
				break;
			}
			j += n;
		}
		return Some(j);
	}
	last_shared_end
}

fn body2<U: Unit>(units: &[U], pos: usize) -> Option<usize> {
	let mut i = pos;
	while let Some((c, n)) = decode_at(units, i) {
		if !cls::in_upper_set(c) {
			break;
		}
		i += n;
	}
	if i == pos {
		return None;
	}
	while let Some((c, n)) = decode_at(units, i) {
		if !cls::in_lower_set(c) {
			break;
		}
		i += n;
	}
	Some(i)
}
