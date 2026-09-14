use std::collections::BTreeSet;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tree_sitter::{Node, Point, TreeCursor};

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

	// A closing delimiter or a continuation line has no node that starts on the
	// requested line. Preserve the existing unresolved result for those lines;
	// the enclosing lookup below applies once a node starting on the line exists.
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
	let selected = if is_multiline(node) {
		node
	} else {
		find_enclosing_block(node, root).unwrap_or(node)
	};
	if selected.has_error() || !selected.is_named() {
		return Ok(None);
	}
	Ok(Some(BlockRange {
		start_line: node_start_line(selected),
		end_line:   node_content_end_line(selected),
	}))
}

fn is_multiline(node: Node<'_>) -> bool {
	node_start_line(node) < node_content_end_line(node)
}

/// Prefer a declaration/statement wrapper over its body node. For example, a
/// statement inside a TypeScript method has a `statement_block` ancestor, but
/// the edit/read operation should resolve the enclosing `method_definition`.
fn find_enclosing_block<'tree>(node: Node<'tree>, root: Node<'tree>) -> Option<Node<'tree>> {
	let mut body_fallback = None;
	let mut current = node.parent();
	while let Some(ancestor) = current {
		if ancestor.id() == root.id() {
			break;
		}
		if ancestor.is_named()
			&& !ancestor.is_error()
			&& !ancestor.is_missing()
			&& is_multiline(ancestor)
		{
			if is_block_declaration_kind(ancestor.kind()) {
				return Some(ancestor);
			}
			if body_fallback.is_none() && is_block_container_kind(ancestor.kind()) {
				body_fallback = Some(ancestor);
			}
		}
		current = ancestor.parent();
	}
	body_fallback
}

fn is_block_declaration_kind(kind: &str) -> bool {
	matches!(
		kind,
		"function_declaration"
			| "function_definition"
			| "function_item"
			| "function_expression"
			| "method_definition"
			| "method_declaration"
			| "constructor_declaration"
			| "constructor_definition"
			| "class_declaration"
			| "class_definition"
			| "struct_declaration"
			| "struct_definition"
			| "struct_item"
			| "impl_item"
			| "trait_item"
			| "mod_item"
			| "interface_declaration"
			| "interface_definition"
			| "enum_declaration"
			| "enum_definition"
			| "enum_item"
			| "type_declaration"
			| "type_definition"
			| "namespace_declaration"
			| "module_declaration"
			| "protocol_declaration"
			| "extension_declaration"
			| "record_declaration"
			| "object_declaration"
			| "object_definition"
			| "if_statement"
			| "for_statement"
			| "for_in_statement"
			| "while_statement"
			| "do_statement"
			| "repeat_statement"
			| "switch_statement"
			| "switch_expression"
			| "try_statement"
			| "catch_clause"
			| "with_statement"
			| "match_statement"
			| "match_expression"
			| "expression_switch_statement"
			| "type_switch_statement"
			| "select_statement"
			| "loop_expression"
			| "for_expression"
			| "while_expression"
			| "synchronized_statement"
			| "lock_statement"
			| "using_statement"
			| "unsafe_block"
	)
}

fn is_block_container_kind(kind: &str) -> bool {
	matches!(
		kind,
		"block"
			| "statement_block"
			| "compound_statement"
			| "function_body"
			| "constructor_body"
			| "class_body"
			| "interface_body"
			| "enum_body"
			| "declaration_list"
			| "template_body"
			| "protocol_body"
			| "enum_class_body"
			| "extension_body"
			| "mixin_body"
			| "method_body"
			| "switch_body"
			| "switch_block"
			| "match_block"
			| "match_body"
			| "do_block"
			| "seq_block"
	)
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

#[cfg(test)]
mod tests {
	use super::{BlockRange, BlockRangeOptions, block_range_at};

	fn range(code: &str, lang: &str, line: u32) -> Option<BlockRange> {
		block_range_at(BlockRangeOptions {
			code: code.to_string(),
			lang: Some(lang.to_string()),
			path: None,
			line,
		})
		.expect("source should parse")
	}

	#[test]
	fn mid_function_body_line_resolves_the_enclosing_function() {
		let code = "function top() {\n  const value = 1;\n  return value;\n}\n";
		assert_eq!(range(code, "ts", 3), Some(BlockRange { start_line: 1, end_line: 4 }));
	}

	#[test]
	fn class_header_resolves_the_whole_class() {
		let code = "class Foo {\n  bar() {\n    return 1;\n  }\n}\nfunction top() {}\n";
		assert_eq!(range(code, "ts", 1), Some(BlockRange { start_line: 1, end_line: 5 }));
	}
}
