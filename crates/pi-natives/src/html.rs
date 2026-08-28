use html_to_markdown_rs::{
	ConversionOptions, PreprocessingOptions, PreprocessingPreset, WarningKind, convert,
};
use napi::{JsString, bindgen_prelude::*};
use napi_derive::napi;

use crate::{js::into_string, task};

#[napi(object)]
#[derive(Debug, Default)]
pub struct HtmlToMarkdownOptions {
	pub clean_content: Option<bool>,

	pub skip_images: Option<bool>,
}

#[napi]
pub fn html_to_markdown(
	html: JsString,
	options: Option<HtmlToMarkdownOptions>,
) -> Result<task::Promise<String>> {
	let html = into_string(html)?;
	let options = options.unwrap_or_default();
	let clean_content = options.clean_content.unwrap_or(false);
	let skip_images = options.skip_images.unwrap_or(false);

	Ok(task::blocking("html_to_markdown", (), move |_| {
		let conversion_opts = ConversionOptions {
			skip_images,
			preprocessing: PreprocessingOptions {
				enabled:           clean_content,
				preset:            PreprocessingPreset::Aggressive,
				remove_navigation: true,
				remove_forms:      true,
			},
			tier_strategy: html_to_markdown_rs::TierStrategy::Tier2,
			..Default::default()
		};

		let result = convert(html.as_str(), Some(conversion_opts))
			.map_err(|err| Error::from_reason(format!("Conversion error: {err}")))?;
		if let Some(warning) = result
			.warnings
			.iter()
			.find(|warning| warning.kind == WarningKind::DepthLimitExceeded)
		{
			return Err(Error::from_reason(format!("Conversion error: {}", warning.message)));
		}
		Ok(result.content.unwrap_or_default())
	}))
}
