use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi(object)]
pub struct OutlineOptions {
	pub code: String,

	pub lang: Option<String>,

	pub path: Option<String>,
}

#[napi(object)]
pub struct OutlineEntry {
	pub kind:     String,
	pub modifier: Option<String>,
	pub name:     Option<String>,
	pub detail:   Option<String>,
	pub doc:      Option<String>,
	pub notes:    Vec<String>,
	pub asks:     Vec<String>,
	pub line:     u32,
	pub children: Vec<Self>,
}

#[napi(object)]
pub struct OutlineResult {
	pub language: Option<String>,

	pub parsed: bool,

	pub entries: Vec<OutlineEntry>,
}

impl From<pi_ast::outline::OutlineEntry> for OutlineEntry {
	fn from(value: pi_ast::outline::OutlineEntry) -> Self {
		Self {
			kind:     value.kind,
			modifier: value.modifier,
			name:     value.name,
			detail:   value.detail,
			doc:      value.doc,
			notes:    value.notes,
			asks:     value.asks,
			line:     value.line,
			children: value.children.into_iter().map(Into::into).collect(),
		}
	}
}

impl From<pi_ast::outline::OutlineResult> for OutlineResult {
	fn from(value: pi_ast::outline::OutlineResult) -> Self {
		Self {
			language: value.language,
			parsed:   value.parsed,
			entries:  value.entries.into_iter().map(Into::into).collect(),
		}
	}
}

#[napi]
pub fn code_outline(options: OutlineOptions) -> Result<OutlineResult> {
	pi_ast::outline::code_outline(pi_ast::outline::OutlineOptions {
		code: options.code,
		lang: options.lang,
		path: options.path,
	})
	.map(Into::into)
	.map_err(|error| Error::from_reason(error.to_string()))
}
