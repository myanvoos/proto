use std::collections::BTreeSet;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tree_sitter::{Point, TreeCursor};

use crate::{
	parse_cache::parse_cached,
	summary::{node_content_end_line, node_start_line, resolve_language},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockRangeOptions {
	pub code: String,

	pub lang: Option<String>,

	pub path: Option<String>,

	pub line: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct BlockRange {
	pub start_line: u32,

	pub end_line: u32,
}

fn first_content_column(code: &str, row: usize) -> Option<usize> {
	let line = code.split('\n').nth(row)?;
	for (col, byte) in line.bytes().enumerate() {
		if byte != b' ' && byte != b'\t' {
			return Some(col);
		}
	}
	None
}

pub fn block_range_at(options: BlockRangeOptions) -> Result<Option<BlockRange>> {
	let BlockRangeOptions { code, lang, path, line } = options;
	if line == 0 || code.is_empty() {
		return Ok(None);
	}
	let Some(language) = resolve_language(lang.as_deref(), path.as_deref()) else {
		return Ok(None);
	};
	let row = (line - 1) as usize;
	let Some(col) = first_content_column(&code, row) else {
		return Ok(None);
	};

	let Some(tree) = parse_cached(&code, language)? else {
		return Ok(None);
	};
	let root = tree.root_node();

	let point = Point::new(row, col);
	let point_end = Point::new(row, col + 1);
	let Some(leaf) = root.named_descendant_for_point_range(point, point_end) else {
		return Ok(None);
	};

	if leaf.start_position().row != row {
		return Ok(None);
	}

	let mut node = leaf;
	while let Some(parent) = node.parent() {
		if parent.id() == root.id() {
			break;
		}
		if parent.start_position().row != row {
			break;
		}
		node = parent;
	}

	if node.has_error() {
		return Ok(None);
	}
	Ok(Some(BlockRange {
		start_line: node_start_line(node),
		end_line:   node_content_end_line(node),
	}))
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct LineRange {
	pub start_line: u32,

	pub end_line: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnclosingBoundaryOptions {
	pub code: String,

	pub lang: Option<String>,

	pub path: Option<String>,

	pub ranges: Vec<LineRange>,
}

fn normalize_ranges(mut ranges: Vec<LineRange>) -> Vec<LineRange> {
	ranges.retain(|range| range.start_line > 0 && range.end_line >= range.start_line);
	ranges.sort_by(|a, b| {
		a.start_line
			.cmp(&b.start_line)
			.then(a.end_line.cmp(&b.end_line))
	});
	let mut merged: Vec<LineRange> = Vec::with_capacity(ranges.len());
	for range in ranges {
		if let Some(last) = merged.last_mut()
			&& range.start_line <= last.end_line.saturating_add(1)
		{
			last.end_line = last.end_line.max(range.end_line);
			continue;
		}
		merged.push(range);
	}
	merged
}

fn is_visible(merged: &[LineRange], line: u32) -> bool {
	merged
		.binary_search_by(|range| {
			if line < range.start_line {
				std::cmp::Ordering::Greater
			} else if line > range.end_line {
				std::cmp::Ordering::Less
			} else {
				std::cmp::Ordering::Equal
			}
		})
		.is_ok()
}

fn intersects_visible(merged: &[LineRange], start: u32, end: u32) -> bool {
	let idx = merged.partition_point(|range| range.end_line < start);
	merged.get(idx).is_some_and(|range| range.start_line <= end)
}

fn collect_boundaries(cursor: &mut TreeCursor<'_>, merged: &[LineRange], out: &mut BTreeSet<u32>) {
	let node = cursor.node();

	let raw_start = node.start_position().row.saturating_add(1) as u32;
	let raw_end = node.end_position().row.saturating_add(1) as u32;
	if !intersects_visible(merged, raw_start, raw_end) {
		return;
	}

	if node.is_named() && node.parent().is_some() {
		let start = node_start_line(node);
		let end = node_content_end_line(node);
		if end > start {
			let start_visible = is_visible(merged, start);
			let end_visible = is_visible(merged, end);

			if start_visible && !end_visible {
				out.insert(end);
			} else if end_visible && !start_visible {
				out.insert(start);
			}
		}
	}
	if cursor.goto_first_child() {
		loop {
			collect_boundaries(cursor, merged, out);
			if !cursor.goto_next_sibling() {
				break;
			}
		}
		cursor.goto_parent();
	}
}

pub fn enclosing_block_boundaries(options: EnclosingBoundaryOptions) -> Result<Option<Vec<u32>>> {
	let EnclosingBoundaryOptions { code, lang, path, ranges } = options;
	let merged = normalize_ranges(ranges);
	if code.is_empty() || merged.is_empty() {
		return Ok(Some(Vec::new()));
	}
	let Some(language) = resolve_language(lang.as_deref(), path.as_deref()) else {
		return Ok(None);
	};
	let Some(tree) = parse_cached(&code, language)? else {
		return Ok(None);
	};
	let root = tree.root_node();

	if root.has_error() {
		return Ok(None);
	}

	let mut boundaries = BTreeSet::new();
	let mut cursor = root.walk();
	collect_boundaries(&mut cursor, &merged, &mut boundaries);
	Ok(Some(boundaries.into_iter().collect()))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NodeSpan {
	pub start_line: u32,

	pub end_line: u32,

	pub kind: String,
}

pub fn node_chain_at(options: BlockRangeOptions) -> Result<Option<Vec<NodeSpan>>> {
	let BlockRangeOptions { code, lang, path, line } = options;
	if line == 0 || code.is_empty() {
		return Ok(None);
	}
	let Some(language) = resolve_language(lang.as_deref(), path.as_deref()) else {
		return Ok(None);
	};
	let row = (line - 1) as usize;
	let Some(col) = first_content_column(&code, row) else {
		return Ok(None);
	};
	let Some(tree) = parse_cached(&code, language)? else {
		return Ok(None);
	};
	let root = tree.root_node();

	let point = Point::new(row, col);
	let point_end = Point::new(row, col + 1);
	let Some(leaf) = root.named_descendant_for_point_range(point, point_end) else {
		return Ok(None);
	};
	let mut chain = Vec::new();
	let mut node = Some(leaf);
	while let Some(current) = node {
		if current.id() == root.id() {
			break;
		}
		if current.is_named() && !current.is_error() && !current.is_missing() {
			chain.push(NodeSpan {
				start_line: node_start_line(current),
				end_line:   node_content_end_line(current),
				kind:       current.kind().to_string(),
			});
		}
		node = current.parent();
	}
	Ok(Some(chain))
}
