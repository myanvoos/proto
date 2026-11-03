use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::task;

#[napi(object)]
pub struct BlockRangeOptions {
	pub code: String,

	pub lang: Option<String>,

	pub path: Option<String>,

	pub line: u32,
}

#[napi(object)]
pub struct BlockRange {
	pub start_line: u32,

	pub end_line: u32,
}

impl From<pi_ast::block::BlockRange> for BlockRange {
	fn from(value: pi_ast::block::BlockRange) -> Self {
		Self { start_line: value.start_line, end_line: value.end_line }
	}
}

#[napi(catch_unwind)]
pub fn block_range_at(options: BlockRangeOptions) -> Result<Option<BlockRange>> {
	pi_ast::block::block_range_at(pi_ast::block::BlockRangeOptions {
		code: options.code,
		lang: options.lang,
		path: options.path,
		line: options.line,
	})
	.map(|range| range.map(Into::into))
	.map_err(|error| Error::from_reason(error.to_string()))
}

#[napi(object)]
pub struct NodeSpan {
	pub start_line: u32,

	pub end_line: u32,

	pub kind: String,
}

impl From<pi_ast::block::NodeSpan> for NodeSpan {
	fn from(value: pi_ast::block::NodeSpan) -> Self {
		Self { start_line: value.start_line, end_line: value.end_line, kind: value.kind }
	}
}

#[napi(catch_unwind)]
pub fn node_chain_at(options: BlockRangeOptions) -> Result<Option<Vec<NodeSpan>>> {
	pi_ast::block::node_chain_at(pi_ast::block::BlockRangeOptions {
		code: options.code,
		lang: options.lang,
		path: options.path,
		line: options.line,
	})
	.map(|chain| chain.map(|spans| spans.into_iter().map(Into::into).collect()))
	.map_err(|error| Error::from_reason(error.to_string()))
}

#[napi(object)]
pub struct BlockParseOptions {
	/// Source code to parse.
	pub code: String,
	/// Language alias (e.g. "rust", "typescript") used before path inference.
	pub lang: Option<String>,
	/// File path used to infer language by extension when `lang` is omitted.
	pub path: Option<String>,
}

/// Parse `options.code` into the shared tree cache on the native blocking
/// pool.
///
/// [`enclosing_block_boundaries`], [`block_range_at`] and [`node_chain_at`]
/// are synchronous and parse on the JS thread when their source is not
/// cached; awaiting this first makes that parse a cache hit. Resolves without
/// parsing when the language is unrecognized.
#[napi]
pub fn warm_block_parse(options: BlockParseOptions) -> task::Promise<()> {
	task::blocking("block.warm_parse", (), move |_| {
		pi_ast::block::warm_parse(&options.code, options.lang.as_deref(), options.path.as_deref())
			.map_err(|error| Error::from_reason(error.to_string()))
	})
}

#[napi(object)]
pub struct LineRange {
	/// 1-indexed inclusive first visible line.
	pub start_line: u32,

	pub end_line: u32,
}

#[napi(object)]
pub struct EnclosingBoundaryOptions {
	pub code: String,

	pub lang: Option<String>,

	pub path: Option<String>,

	pub ranges: Vec<LineRange>,
}

#[napi(catch_unwind)]
pub fn enclosing_block_boundaries(options: EnclosingBoundaryOptions) -> Result<Option<Vec<u32>>> {
	pi_ast::block::enclosing_block_boundaries(pi_ast::block::EnclosingBoundaryOptions {
		code:   options.code,
		lang:   options.lang,
		path:   options.path,
		ranges: options
			.ranges
			.into_iter()
			.map(|range| pi_ast::block::LineRange {
				start_line: range.start_line,
				end_line:   range.end_line,
			})
			.collect(),
	})
	.map_err(|error| Error::from_reason(error.to_string()))
}
