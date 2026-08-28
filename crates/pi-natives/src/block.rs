use napi::bindgen_prelude::*;
use napi_derive::napi;

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

#[napi]
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

#[napi]
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
pub struct LineRange {
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

#[napi]
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
