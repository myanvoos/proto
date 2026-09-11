use std::{collections::HashMap, rc::Rc};

use napi::{JsString, bindgen_prelude::*};
use napi_derive::napi;

use crate::js;

const LF: u16 = 0x000a;

#[napi(object)]
pub struct DiffChange {
	pub value: Utf16String,

	pub count: u32,

	pub added: bool,

	pub removed: bool,
}

#[napi(object)]
pub struct DiffRun {
	pub count: u32,

	pub added: bool,

	pub removed: bool,
}

#[napi(object)]
pub struct PatchHunk {
	pub old_start: u32,

	pub old_lines: u32,

	pub new_start: u32,

	pub new_lines: u32,

	pub lines: Vec<Utf16String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Run {
	count:   usize,
	added:   bool,
	removed: bool,
}

struct Component {
	count:   usize,
	added:   bool,
	removed: bool,
	prev:    Option<Rc<Self>>,
}

struct PathState {
	old_pos: isize,
	last:    Option<Rc<Component>>,
}

fn extract_common(path: &mut PathState, new: &[u32], old: &[u32], diagonal: isize) -> isize {
	let new_len = new.len() as isize;
	let old_len = old.len() as isize;
	let mut old_pos = path.old_pos;
	let mut new_pos = old_pos - diagonal;
	let mut common = 0usize;
	while new_pos + 1 < new_len
		&& old_pos + 1 < old_len
		&& old[(old_pos + 1) as usize] == new[(new_pos + 1) as usize]
	{
		new_pos += 1;
		old_pos += 1;
		common += 1;
	}
	if common > 0 {
		path.last = Some(Rc::new(Component {
			count:   common,
			added:   false,
			removed: false,
			prev:    path.last.take(),
		}));
	}
	path.old_pos = old_pos;
	new_pos
}

fn add_to_path(path: &PathState, added: bool, removed: bool, old_pos_inc: isize) -> PathState {
	match &path.last {
		Some(last) if last.added == added && last.removed == removed => PathState {
			old_pos: path.old_pos + old_pos_inc,
			last:    Some(Rc::new(Component {
				count: last.count + 1,
				added,
				removed,
				prev: last.prev.clone(),
			})),
		},
		_ => PathState {
			old_pos: path.old_pos + old_pos_inc,
			last:    Some(Rc::new(Component { count: 1, added, removed, prev: path.last.clone() })),
		},
	}
}

fn build_runs(last: Option<Rc<Component>>) -> Vec<Run> {
	let mut runs = Vec::new();
	let mut cursor = last.as_deref();
	while let Some(component) = cursor {
		runs.push(Run {
			count:   component.count,
			added:   component.added,
			removed: component.removed,
		});
		cursor = component.prev.as_deref();
	}
	runs.reverse();
	runs
}

const MAX_MYERS_EDIT_DISTANCE: usize = 1024;

fn push_run(runs: &mut Vec<Run>, run: Run) {
	if run.count == 0 {
		return;
	}
	if let Some(last) = runs.last_mut()
		&& last.added == run.added
		&& last.removed == run.removed
	{
		last.count += run.count;
	} else {
		runs.push(run);
	}
}

fn trim_common_edges(old: &[u32], new: &[u32]) -> (usize, usize) {
	let prefix = old
		.iter()
		.zip(new)
		.take_while(|(old, new)| old == new)
		.count();
	let max_suffix = old
		.len()
		.saturating_sub(prefix)
		.min(new.len().saturating_sub(prefix));
	let suffix = old
		.iter()
		.rev()
		.zip(new.iter().rev())
		.take(max_suffix)
		.take_while(|(old, new)| old == new)
		.count();
	(prefix, suffix)
}

fn myers_diff_bounded(old: &[u32], new: &[u32], max_edit_distance: usize) -> Option<Vec<Run>> {
	let old_len = old.len() as isize;
	let new_len = new.len() as isize;
	let max_edit = old.len().saturating_add(new.len()).min(max_edit_distance) as isize;
	let offset = max_edit + 1;
	let mut best: Vec<Option<PathState>> = Vec::new();
	best.resize_with((2 * max_edit + 3) as usize, || None);

	let mut seed = PathState { old_pos: -1, last: None };
	let seed_new_pos = extract_common(&mut seed, new, old, 0);
	if seed.old_pos + 1 >= old_len && seed_new_pos + 1 >= new_len {
		return Some(build_runs(seed.last));
	}
	best[offset as usize] = Some(seed);

	let mut min_diagonal = isize::MIN;
	let mut max_diagonal = isize::MAX;
	let mut edit_length: isize = 1;
	while edit_length <= max_edit {
		let mut diagonal = min_diagonal.max(-edit_length);
		while diagonal <= max_diagonal.min(edit_length) {
			let idx = (diagonal + offset) as usize;
			let remove_path = best[idx - 1].take();
			let add_path_old_pos = best[idx + 1].as_ref().map(|path| path.old_pos);
			let can_add = add_path_old_pos.is_some_and(|old_pos| {
				let add_new_pos = old_pos - diagonal;
				add_new_pos >= 0 && add_new_pos < new_len
			});
			let can_remove = remove_path
				.as_ref()
				.is_some_and(|path| path.old_pos + 1 < old_len);
			if !can_add && !can_remove {
				best[idx] = None;
				diagonal += 2;
				continue;
			}

			let mut base_path = if !can_remove
				|| (can_add
					&& remove_path.as_ref().is_some_and(|path| {
						add_path_old_pos.is_some_and(|add_old| path.old_pos < add_old)
					})) {
				add_to_path(
					best[idx + 1]
						.as_ref()
						.expect("canAdd implies a live addPath"),
					true,
					false,
					0,
				)
			} else {
				add_to_path(
					remove_path
						.as_ref()
						.expect("canRemove implies a live removePath"),
					false,
					true,
					1,
				)
			};
			let new_pos = extract_common(&mut base_path, new, old, diagonal);
			if base_path.old_pos + 1 >= old_len && new_pos + 1 >= new_len {
				return Some(build_runs(base_path.last));
			}
			if base_path.old_pos + 1 >= old_len {
				max_diagonal = max_diagonal.min(diagonal - 1);
			}
			if new_pos + 1 >= new_len {
				min_diagonal = min_diagonal.max(diagonal + 1);
			}
			best[idx] = Some(base_path);
			diagonal += 2;
		}
		edit_length += 1;
	}
	None
}

fn myers_diff(old: &[u32], new: &[u32]) -> Vec<Run> {
	// Run the original search while it is within the compatibility budget. The
	// bounded frontier has the same tie-breaking as the unbounded implementation,
	// so all results at or below the cap remain byte-for-byte compatible.
	if let Some(runs) = myers_diff_bounded(old, new, MAX_MYERS_EDIT_DISTANCE) {
		return runs;
	}

	// Once the budget is exceeded, retain equal edges and replace only the middle.
	// This keeps large files readable while making the expensive path bounded.
	let (prefix, suffix) = trim_common_edges(old, new);
	let old_middle_end = old.len() - suffix;
	let new_middle_end = new.len() - suffix;
	let old_middle = &old[prefix..old_middle_end];
	let new_middle = &new[prefix..new_middle_end];
	let mut runs = Vec::with_capacity(4);
	push_run(&mut runs, Run { count: prefix, added: false, removed: false });
	push_run(&mut runs, Run { count: old_middle.len(), added: false, removed: true });
	push_run(&mut runs, Run { count: new_middle.len(), added: true, removed: false });
	push_run(&mut runs, Run { count: suffix, added: false, removed: false });
	runs
}

fn intern_exact<'a>(old_tokens: &[&'a [u16]], new_tokens: &[&'a [u16]]) -> (Vec<u32>, Vec<u32>) {
	fn assign<'a>(ids: &mut HashMap<&'a [u16], u32>, token: &'a [u16]) -> u32 {
		let next = ids.len() as u32;
		*ids.entry(token).or_insert(next)
	}
	let mut ids: HashMap<&'a [u16], u32> =
		HashMap::with_capacity(old_tokens.len() + new_tokens.len());
	let old_ids = old_tokens
		.iter()
		.map(|token| assign(&mut ids, token))
		.collect();
	let new_ids = new_tokens
		.iter()
		.map(|token| assign(&mut ids, token))
		.collect();
	(old_ids, new_ids)
}

fn build_changes(
	runs: &[Run],
	old_tokens: &[&[u16]],
	new_tokens: &[&[u16]],
	join: impl Fn(&[&[u16]]) -> Vec<u16>,
) -> Vec<DiffChange> {
	let mut old_pos = 0usize;
	let mut new_pos = 0usize;
	runs
		.iter()
		.map(|run| {
			let value = if run.removed {
				let value = join(&old_tokens[old_pos..old_pos + run.count]);
				old_pos += run.count;
				value
			} else {
				let value = join(&new_tokens[new_pos..new_pos + run.count]);
				new_pos += run.count;
				if !run.added {
					old_pos += run.count;
				}
				value
			};
			DiffChange {
				value:   value.into(),
				count:   run.count as u32,
				added:   run.added,
				removed: run.removed,
			}
		})
		.collect()
}

fn line_tokens(text: &[u16]) -> Vec<&[u16]> {
	text.split_inclusive(|&unit| unit == LF).collect()
}

fn diff_line_tokens(old_tokens: &[&[u16]], new_tokens: &[&[u16]]) -> Vec<Run> {
	let (old_ids, new_ids) = intern_exact(old_tokens, new_tokens);
	myers_diff(&old_ids, &new_ids)
}

fn concat_tokens(tokens: &[&[u16]]) -> Vec<u16> {
	let mut out = Vec::with_capacity(tokens.iter().map(|token| token.len()).sum());
	for token in tokens {
		out.extend_from_slice(token);
	}
	out
}

#[napi]
pub fn diff_lines(old_text: JsString, new_text: JsString) -> Result<Vec<DiffChange>> {
	let old_text = js::utf16(old_text)?;
	let new_text = js::utf16(new_text)?;
	Ok(diff_lines_impl(&old_text, &new_text))
}

fn diff_lines_impl(old_text: &[u16], new_text: &[u16]) -> Vec<DiffChange> {
	let old_tokens = line_tokens(old_text);
	let new_tokens = line_tokens(new_text);
	let runs = diff_line_tokens(&old_tokens, &new_tokens);
	build_changes(&runs, &old_tokens, &new_tokens, concat_tokens)
}

#[napi]
pub fn diff_line_runs(old_text: JsString, new_text: JsString) -> Result<Vec<DiffRun>> {
	let old_text = js::utf16(old_text)?;
	let new_text = js::utf16(new_text)?;
	Ok(diff_line_runs_impl(&old_text, &new_text))
}

fn diff_line_runs_impl(old_text: &[u16], new_text: &[u16]) -> Vec<DiffRun> {
	let old_tokens: Vec<&[u16]> = old_text.split(|&unit| unit == LF).collect();
	let new_tokens: Vec<&[u16]> = new_text.split(|&unit| unit == LF).collect();
	let (old_ids, new_ids) = intern_exact(&old_tokens, &new_tokens);
	myers_diff(&old_ids, &new_ids)
		.into_iter()
		.map(|run| DiffRun { count: run.count as u32, added: run.added, removed: run.removed })
		.collect()
}

fn prefixed_line(prefix: u8, line: &[u16]) -> Vec<u16> {
	let mut out = Vec::with_capacity(1 + line.len());
	out.push(u16::from(prefix));
	out.extend_from_slice(line);
	out
}

fn no_newline_marker() -> Vec<u16> {
	"\\ No newline at end of file".encode_utf16().collect()
}

#[napi]
pub fn structured_patch_hunks(
	old_text: JsString,
	new_text: JsString,
	context: Option<u32>,
) -> Result<Vec<PatchHunk>> {
	let old_text = js::utf16(old_text)?;
	let new_text = js::utf16(new_text)?;
	Ok(structured_patch_hunks_impl(&old_text, &new_text, context))
}

fn structured_patch_hunks_impl(
	old_text: &[u16],
	new_text: &[u16],
	context: Option<u32>,
) -> Vec<PatchHunk> {
	let context = context.map_or(4usize, |value| value as usize);
	let old_tokens = line_tokens(old_text);
	let new_tokens = line_tokens(new_text);
	let runs = diff_line_tokens(&old_tokens, &new_tokens);

	struct ChangeLines<'a> {
		added:   bool,
		removed: bool,
		lines:   &'a [&'a [u16]],
	}
	let mut list: Vec<ChangeLines> = Vec::with_capacity(runs.len() + 1);
	let mut old_pos = 0usize;
	let mut new_pos = 0usize;
	for run in &runs {
		let lines: &[&[u16]] = if run.removed {
			let slice = &old_tokens[old_pos..old_pos + run.count];
			old_pos += run.count;
			slice
		} else {
			let slice = &new_tokens[new_pos..new_pos + run.count];
			new_pos += run.count;
			if !run.added {
				old_pos += run.count;
			}
			slice
		};
		list.push(ChangeLines { added: run.added, removed: run.removed, lines });
	}
	list.push(ChangeLines { added: false, removed: false, lines: &[] });

	struct RawHunk {
		old_start: usize,
		old_lines: usize,
		new_start: usize,
		new_lines: usize,
		lines:     Vec<Vec<u16>>,
	}
	let mut hunks: Vec<RawHunk> = Vec::new();
	let mut old_range_start = 0usize;
	let mut new_range_start = 0usize;
	let mut cur_range: Vec<Vec<u16>> = Vec::new();
	let mut old_line = 1usize;
	let mut new_line = 1usize;
	for i in 0..list.len() {
		let current = &list[i];
		if current.added || current.removed {
			if old_range_start == 0 {
				old_range_start = old_line;
				new_range_start = new_line;
				if i > 0 && context > 0 {
					let prev_lines = list[i - 1].lines;
					let take = prev_lines.len().min(context);
					cur_range = prev_lines[prev_lines.len() - take..]
						.iter()
						.map(|line| prefixed_line(b' ', line))
						.collect();
					old_range_start -= cur_range.len();
					new_range_start -= cur_range.len();
				}
			}
			let marker = if current.added { b'+' } else { b'-' };
			for line in current.lines {
				cur_range.push(prefixed_line(marker, line));
			}
			if current.added {
				new_line += current.lines.len();
			} else {
				old_line += current.lines.len();
			}
		} else {
			if old_range_start != 0 {
				if current.lines.len() <= context * 2 && i + 2 < list.len() {
					for line in current.lines {
						cur_range.push(prefixed_line(b' ', line));
					}
				} else {
					let context_size = current.lines.len().min(context);
					for line in &current.lines[..context_size] {
						cur_range.push(prefixed_line(b' ', line));
					}
					hunks.push(RawHunk {
						old_start: old_range_start,
						old_lines: old_line - old_range_start + context_size,
						new_start: new_range_start,
						new_lines: new_line - new_range_start + context_size,
						lines:     std::mem::take(&mut cur_range),
					});
					old_range_start = 0;
					new_range_start = 0;
				}
			}
			old_line += current.lines.len();
			new_line += current.lines.len();
		}
	}

	for hunk in &mut hunks {
		let mut i = 0;
		while i < hunk.lines.len() {
			if hunk.lines[i].last() == Some(&LF) {
				hunk.lines[i].pop();
			} else {
				hunk.lines.insert(i + 1, no_newline_marker());
				i += 1;
			}
			i += 1;
		}
	}
	hunks
		.into_iter()
		.map(|hunk| PatchHunk {
			old_start: hunk.old_start as u32,
			old_lines: hunk.old_lines as u32,
			new_start: hunk.new_start as u32,
			new_lines: hunk.new_lines as u32,
			lines:     hunk.lines.into_iter().map(Utf16String::from).collect(),
		})
		.collect()
}

const fn is_word_char(cp: u32) -> bool {
	matches!(cp,
		0x30..=0x39
		| 0x41..=0x5A
		| 0x5F
		| 0x61..=0x7A
		| 0xAD
		| 0xC0..=0xD6
		| 0xD8..=0xF6
		| 0xF8..=0x2C6
		| 0x2C8..=0x2D7
		| 0x2DE..=0x2FF
		| 0x1E00..=0x1EFF)
}

const fn is_js_whitespace(cp: u32) -> bool {
	matches!(
		cp,
		0x09 | 0x0a | 0x0b | 0x0c | 0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000
			..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff
	)
}

const fn is_ws_unit(unit: u16) -> bool {
	is_js_whitespace(unit as u32)
}

fn trim_leading_ws(s: &[u16]) -> &[u16] {
	let start = s
		.iter()
		.position(|&unit| !is_ws_unit(unit))
		.unwrap_or(s.len());
	&s[start..]
}

fn trim_trailing_ws(s: &[u16]) -> &[u16] {
	let end = s
		.iter()
		.rposition(|&unit| !is_ws_unit(unit))
		.map_or(0, |i| i + 1);
	&s[..end]
}

fn leading_ws(s: &[u16]) -> &[u16] {
	&s[..s.len() - trim_leading_ws(s).len()]
}

fn trailing_ws(s: &[u16]) -> &[u16] {
	&s[trim_trailing_ws(s).len()..]
}

fn js_trim(s: &[u16]) -> &[u16] {
	trim_trailing_ws(trim_leading_ws(s))
}

struct CodePoints<'a> {
	text: &'a [u16],
	pos:  usize,
}

impl Iterator for CodePoints<'_> {
	type Item = (usize, u32, usize);

	fn next(&mut self) -> Option<Self::Item> {
		let &unit = self.text.get(self.pos)?;
		let start = self.pos;
		if matches!(unit, 0xd800..=0xdbff)
			&& let Some(&low) = self.text.get(start + 1)
			&& matches!(low, 0xdc00..=0xdfff)
		{
			self.pos += 2;
			let cp = 0x10000 + ((u32::from(unit & 0x3ff) << 10) | u32::from(low & 0x3ff));
			return Some((start, cp, 2));
		}
		self.pos += 1;
		Some((start, u32::from(unit), 1))
	}
}

const fn code_points(text: &[u16]) -> CodePoints<'_> {
	CodePoints { text, pos: 0 }
}

fn word_parts(text: &[u16]) -> Vec<&[u16]> {
	let mut parts = Vec::new();
	let mut iter = code_points(text).peekable();
	while let Some((start, cp, len)) = iter.next() {
		let class = if is_word_char(cp) {
			1u8
		} else if is_js_whitespace(cp) {
			2u8
		} else {
			0u8
		};
		let mut end = start + len;
		if class != 0 {
			while let Some(&(_, next_cp, next_len)) = iter.peek() {
				let same = if class == 1 {
					is_word_char(next_cp)
				} else {
					is_js_whitespace(next_cp)
				};
				if !same {
					break;
				}
				end += next_len;
				iter.next();
			}
		}
		parts.push(&text[start..end]);
	}
	parts
}

fn word_tokens(text: &[u16]) -> Vec<Vec<u16>> {
	let parts = word_parts(text);
	let mut tokens: Vec<Vec<u16>> = Vec::with_capacity(parts.len());
	let mut prev_part: Option<&[u16]> = None;
	for part in parts {
		let part_is_ws = part.first().is_some_and(|&unit| is_ws_unit(unit));
		if part_is_ws {
			if prev_part.is_none() {
				tokens.push(part.to_vec());
			} else {
				let last = tokens
					.last_mut()
					.expect("tokens non-empty after first part");
				last.extend_from_slice(part);
			}
		} else if let Some(prev) =
			prev_part.filter(|p| p.first().is_some_and(|&unit| is_ws_unit(unit)))
		{
			if tokens.last().is_some_and(|last| last.as_slice() == prev) {
				let last = tokens.last_mut().expect("checked non-empty");
				last.extend_from_slice(part);
			} else {
				let mut token = Vec::with_capacity(prev.len() + part.len());
				token.extend_from_slice(prev);
				token.extend_from_slice(part);
				tokens.push(token);
			}
		} else {
			tokens.push(part.to_vec());
		}
		prev_part = Some(part);
	}
	tokens
}

fn word_join(tokens: &[&[u16]]) -> Vec<u16> {
	let mut out = Vec::new();
	for (i, token) in tokens.iter().enumerate() {
		if i == 0 {
			out.extend_from_slice(token);
		} else {
			out.extend_from_slice(trim_leading_ws(token));
		}
	}
	out
}

fn longest_common_prefix<'a>(a: &'a [u16], b: &[u16]) -> &'a [u16] {
	let len = a.iter().zip(b).take_while(|(x, y)| x == y).count();
	&a[..len]
}

fn longest_common_suffix<'a>(a: &'a [u16], b: &[u16]) -> &'a [u16] {
	let len = a
		.iter()
		.rev()
		.zip(b.iter().rev())
		.take_while(|(x, y)| x == y)
		.count();
	&a[a.len() - len..]
}

fn remove_prefix(s: &[u16], prefix: &[u16]) -> Vec<u16> {
	s.strip_prefix(prefix)
		.expect("value must start with recorded prefix")
		.to_vec()
}

fn remove_suffix(s: &[u16], suffix: &[u16]) -> Vec<u16> {
	s.strip_suffix(suffix)
		.expect("value must end with recorded suffix")
		.to_vec()
}

fn replace_prefix(s: &[u16], old_prefix: &[u16], new_prefix: &[u16]) -> Vec<u16> {
	let rest = s
		.strip_prefix(old_prefix)
		.expect("value must start with recorded prefix");
	let mut out = Vec::with_capacity(new_prefix.len() + rest.len());
	out.extend_from_slice(new_prefix);
	out.extend_from_slice(rest);
	out
}

fn replace_suffix(s: &[u16], old_suffix: &[u16], new_suffix: &[u16]) -> Vec<u16> {
	let rest = s
		.strip_suffix(old_suffix)
		.expect("value must end with recorded suffix");
	let mut out = Vec::with_capacity(rest.len() + new_suffix.len());
	out.extend_from_slice(rest);
	out.extend_from_slice(new_suffix);
	out
}

fn maximum_overlap<'a>(a: &[u16], b: &'a [u16]) -> &'a [u16] {
	let start_a = a.len().saturating_sub(b.len());
	let end_b = b.len().min(a.len());
	if end_b == 0 {
		return &[];
	}
	let mut map = vec![0usize; end_b];
	let mut k = 0usize;
	for j in 1..end_b {
		if b[j] == b[k] {
			map[j] = map[k];
		} else {
			map[j] = k;
		}
		while k > 0 && b[j] != b[k] {
			k = map[k];
		}
		if b[j] == b[k] {
			k += 1;
		}
	}
	k = 0;
	for &unit in &a[start_a..] {
		while k > 0 && unit != b[k] {
			k = map[k];
		}
		if unit == b[k] {
			k += 1;
		}
	}
	&b[..k]
}

fn dedupe_whitespace(
	changes: &mut [DiffChange],
	start_keep: Option<usize>,
	deletion: Option<usize>,
	insertion: Option<usize>,
	end_keep: Option<usize>,
) {
	match (deletion, insertion) {
		(Some(del), Some(ins)) => {
			let old_ws_prefix = leading_ws(&changes[del].value).to_vec();
			let old_ws_suffix = trailing_ws(&changes[del].value).to_vec();
			let new_ws_prefix = leading_ws(&changes[ins].value).to_vec();
			let new_ws_suffix = trailing_ws(&changes[ins].value).to_vec();
			if let Some(start) = start_keep {
				let common_ws_prefix = longest_common_prefix(&old_ws_prefix, &new_ws_prefix).to_vec();
				changes[start].value =
					replace_suffix(&changes[start].value, &new_ws_prefix, &common_ws_prefix).into();
				changes[del].value = remove_prefix(&changes[del].value, &common_ws_prefix).into();
				changes[ins].value = remove_prefix(&changes[ins].value, &common_ws_prefix).into();
			}
			if let Some(end) = end_keep {
				let common_ws_suffix = longest_common_suffix(&old_ws_suffix, &new_ws_suffix).to_vec();
				changes[end].value =
					replace_prefix(&changes[end].value, &new_ws_suffix, &common_ws_suffix).into();
				changes[del].value = remove_suffix(&changes[del].value, &common_ws_suffix).into();
				changes[ins].value = remove_suffix(&changes[ins].value, &common_ws_suffix).into();
			}
		},
		(None, Some(ins)) => {
			if start_keep.is_some() {
				let ws_len = leading_ws(&changes[ins].value).len();
				changes[ins].value = changes[ins].value[ws_len..].to_vec().into();
			}
			if let Some(end) = end_keep {
				let ws_len = leading_ws(&changes[end].value).len();
				changes[end].value = changes[end].value[ws_len..].to_vec().into();
			}
		},
		(Some(del), None) => match (start_keep, end_keep) {
			(Some(start), Some(end)) => {
				let new_ws_full = leading_ws(&changes[end].value).to_vec();
				let del_ws_start = leading_ws(&changes[del].value).to_vec();
				let del_ws_end = trailing_ws(&changes[del].value).to_vec();
				let new_ws_start = longest_common_prefix(&new_ws_full, &del_ws_start).to_vec();
				changes[del].value = remove_prefix(&changes[del].value, &new_ws_start).into();
				let new_ws_end =
					longest_common_suffix(&new_ws_full[new_ws_start.len()..], &del_ws_end).to_vec();
				changes[del].value = remove_suffix(&changes[del].value, &new_ws_end).into();
				changes[end].value =
					replace_prefix(&changes[end].value, &new_ws_full, &new_ws_end).into();
				let start_ws = &new_ws_full[..new_ws_full.len() - new_ws_end.len()];
				changes[start].value =
					replace_suffix(&changes[start].value, &new_ws_full, start_ws).into();
			},
			(None, Some(end)) => {
				let end_keep_ws_prefix = leading_ws(&changes[end].value).to_vec();
				let deletion_ws_suffix = trailing_ws(&changes[del].value).to_vec();
				let overlap = maximum_overlap(&deletion_ws_suffix, &end_keep_ws_prefix).to_vec();
				changes[del].value = remove_suffix(&changes[del].value, &overlap).into();
			},
			(Some(start), None) => {
				let start_keep_ws_suffix = trailing_ws(&changes[start].value).to_vec();
				let deletion_ws_prefix = leading_ws(&changes[del].value).to_vec();
				let overlap = maximum_overlap(&start_keep_ws_suffix, &deletion_ws_prefix).to_vec();
				changes[del].value = remove_prefix(&changes[del].value, &overlap).into();
			},
			(None, None) => {},
		},
		(None, None) => {},
	}
}

fn word_post_process(changes: &mut [DiffChange]) {
	let mut last_keep: Option<usize> = None;
	let mut insertion: Option<usize> = None;
	let mut deletion: Option<usize> = None;
	for i in 0..changes.len() {
		if changes[i].added {
			insertion = Some(i);
		} else if changes[i].removed {
			deletion = Some(i);
		} else {
			if insertion.is_some() || deletion.is_some() {
				dedupe_whitespace(changes, last_keep, deletion, insertion, Some(i));
			}
			last_keep = Some(i);
			insertion = None;
			deletion = None;
		}
	}
	if insertion.is_some() || deletion.is_some() {
		dedupe_whitespace(changes, last_keep, deletion, insertion, None);
	}
}

#[napi]
pub fn diff_words(old_text: JsString, new_text: JsString) -> Result<Vec<DiffChange>> {
	let old_text = js::utf16(old_text)?;
	let new_text = js::utf16(new_text)?;
	Ok(diff_words_impl(&old_text, &new_text))
}

fn diff_words_impl(old_text: &[u16], new_text: &[u16]) -> Vec<DiffChange> {
	let old_tokens = word_tokens(old_text);
	let new_tokens = word_tokens(new_text);
	let old_refs: Vec<&[u16]> = old_tokens.iter().map(Vec::as_slice).collect();
	let new_refs: Vec<&[u16]> = new_tokens.iter().map(Vec::as_slice).collect();

	let old_keys: Vec<&[u16]> = old_refs.iter().map(|token| js_trim(token)).collect();
	let new_keys: Vec<&[u16]> = new_refs.iter().map(|token| js_trim(token)).collect();
	let (old_ids, new_ids) = intern_exact(&old_keys, &new_keys);
	let runs = myers_diff(&old_ids, &new_ids);
	let mut changes = build_changes(&runs, &old_refs, &new_refs, word_join);
	word_post_process(&mut changes);
	changes
}

#[cfg(test)]
mod tests {
	use super::*;

	fn run(count: usize, added: bool, removed: bool) -> Run {
		Run { count, added, removed }
	}

	#[test]
	fn empty_inputs_have_no_runs() {
		assert!(myers_diff(&[], &[]).is_empty());
	}

	#[test]
	fn under_cap_long_inputs_keep_the_existing_edit_shape() {
		let len = MAX_MYERS_EDIT_DISTANCE + 128;
		let changed_at = len / 2;
		let old: Vec<u32> = (0..len).map(|index| index as u32).collect();
		let mut new = old.clone();
		new[changed_at] = u32::MAX;

		assert_eq!(myers_diff(&old, &new), vec![
			run(changed_at, false, false),
			run(1, false, true),
			run(1, true, false),
			run(len - changed_at - 1, false, false),
		]);
	}

	#[test]
	fn over_cap_replaces_only_the_trimmed_middle() {
		let prefix = [1, 2, 3];
		let suffix = [4, 5];
		let middle_len = MAX_MYERS_EDIT_DISTANCE / 2 + 1;
		let mut old = prefix.to_vec();
		old.extend((0..middle_len).map(|index| 100 + index as u32));
		old.extend(suffix);
		let mut new = prefix.to_vec();
		new.extend((0..middle_len).map(|index| 10_000 + index as u32));
		new.extend(suffix);

		assert_eq!(myers_diff(&old, &new), vec![
			run(prefix.len(), false, false),
			run(middle_len, false, true),
			run(middle_len, true, false),
			run(suffix.len(), false, false),
		]);
	}

	#[test]
	fn over_cap_without_common_edges_is_a_full_replace() {
		let len = MAX_MYERS_EDIT_DISTANCE / 2 + 1;
		let old: Vec<u32> = (0..len).map(|index| 100 + index as u32).collect();
		let new: Vec<u32> = (0..len).map(|index| 10_000 + index as u32).collect();

		assert_eq!(myers_diff(&old, &new), vec![run(len, false, true), run(len, true, false)]);
	}

	#[test]
	fn unicode_word_diff_preserves_utf16_values() {
		let old: Vec<u16> = "prefix 😀 café".encode_utf16().collect();
		let new: Vec<u16> = "prefix 😃 café".encode_utf16().collect();
		let changes = diff_words_impl(&old, &new);
		let values: Vec<(Vec<u16>, bool, bool)> = changes
			.iter()
			.map(|change| (change.value.to_vec(), change.added, change.removed))
			.collect();

		assert_eq!(values[0], ("prefix ".encode_utf16().collect(), false, false));
		assert_eq!(values[1], ("😀".encode_utf16().collect(), false, true));
		assert_eq!(values[2], ("😃".encode_utf16().collect(), true, false));
		assert_eq!(values[3], (" café".encode_utf16().collect(), false, false));
	}
}
