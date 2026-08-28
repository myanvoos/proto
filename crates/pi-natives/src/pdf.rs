use napi::{Result, bindgen_prelude::Uint8Array};
use napi_derive::napi;
use pdf_inspector::{MarkdownOptions, PdfOptions, process_pdf_mem_with_options};

use crate::task;

#[napi(object)]
pub struct PdfMarkdownResult {
	pub markdown: String,

	pub title: Option<String>,

	pub page_count: u32,

	pub pages_needing_ocr: Vec<u32>,

	pub has_encoding_issues: bool,
}

#[napi(js_name = "pdfToMarkdown")]
pub fn pdf_to_markdown(input: Uint8Array) -> task::Promise<PdfMarkdownResult> {
	let input = input.to_vec();
	task::blocking("pdf.to_markdown", (), move |_| convert_pdf(&input))
}

fn convert_pdf(input: &[u8]) -> Result<PdfMarkdownResult> {
	let options = PdfOptions::new()
		.markdown(MarkdownOptions { include_page_numbers: true, ..Default::default() });
	let converted = process_pdf_mem_with_options(input, options)
		.map_err(|error| napi::Error::from_reason(format!("PDF conversion failed: {error}")))?;
	let markdown = match converted.markdown {
		Some(markdown) => markdown,
		None if !converted.pages_needing_ocr.is_empty() => String::new(),
		None => {
			return Err(napi::Error::from_reason(
				"PDF conversion failed: converter returned no Markdown",
			));
		},
	};

	Ok(PdfMarkdownResult {
		markdown,
		title: converted.title,
		page_count: converted.page_count,
		pages_needing_ocr: converted.pages_needing_ocr,
		has_encoding_issues: converted.has_encoding_issues,
	})
}
