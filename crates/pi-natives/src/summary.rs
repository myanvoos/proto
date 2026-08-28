use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi(object)]
pub struct SummaryOptions {
	pub code: String,

	pub lang: Option<String>,

	pub path: Option<String>,

	pub min_body_lines: Option<u32>,

	pub min_comment_lines: Option<u32>,

	pub unfold_until_lines: Option<u32>,

	pub unfold_limit_lines: Option<u32>,
}

#[napi(object)]
pub struct SummarySegment {
	pub kind: String,

	pub start_line: u32,

	pub end_line: u32,

	pub text: Option<String>,
}

#[napi(object)]
pub struct SummaryResult {
	pub language: Option<String>,

	pub parsed: bool,

	pub elided: bool,

	pub total_lines: u32,

	pub segments: Vec<SummarySegment>,
}

impl From<pi_ast::summary::SummarySegment> for SummarySegment {
	fn from(value: pi_ast::summary::SummarySegment) -> Self {
		Self {
			kind:       value.kind,
			start_line: value.start_line,
			end_line:   value.end_line,
			text:       value.text,
		}
	}
}

impl From<pi_ast::summary::SummaryResult> for SummaryResult {
	fn from(value: pi_ast::summary::SummaryResult) -> Self {
		Self {
			language:    value.language,
			parsed:      value.parsed,
			elided:      value.elided,
			total_lines: value.total_lines,
			segments:    value.segments.into_iter().map(Into::into).collect(),
		}
	}
}

#[napi]
pub fn summarize_code(options: SummaryOptions) -> Result<SummaryResult> {
	pi_ast::summary::summarize_code(pi_ast::summary::SummaryOptions {
		code:               options.code,
		lang:               options.lang,
		path:               options.path,
		min_body_lines:     options.min_body_lines,
		min_comment_lines:  options.min_comment_lines,
		unfold_until_lines: options.unfold_until_lines,
		unfold_limit_lines: options.unfold_limit_lines,
	})
	.map(Into::into)
	.map_err(|error| Error::from_reason(error.to_string()))
}
