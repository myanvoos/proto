pub mod config;
pub mod detect;
pub mod engine;
pub mod filters;
pub mod primitives;

pub mod pipeline;

pub mod plan;

use std::borrow::Cow;

pub use config::{MinimizerConfig, MinimizerOptions};

#[derive(Debug, Clone)]
pub struct MinimizerCtx<'a> {
	pub program: &'a str,

	pub subcommand: Option<&'a str>,

	pub command: &'a str,

	pub config: &'a MinimizerConfig,
}

#[derive(Debug, Clone)]
pub struct MinimizerOutput {
	pub text: String,

	pub changed: bool,

	pub input_bytes: usize,

	pub output_bytes: usize,

	pub filter: &'static str,

	pub original_text: Option<String>,
}

impl MinimizerOutput {
	pub fn passthrough<'a>(text: impl Into<Cow<'a, str>>) -> Self {
		let text = text.into().into_owned();
		let bytes = text.len();
		Self {
			text,
			changed: false,
			input_bytes: bytes,
			output_bytes: bytes,
			filter: "passthrough",
			original_text: None,
		}
	}

	#[must_use]
	pub const fn transformed(text: String, input_bytes: usize) -> Self {
		let output_bytes = text.len();
		Self { text, changed: true, input_bytes, output_bytes, filter: "", original_text: None }
	}

	#[must_use]
	pub const fn labeled(mut self, filter: &'static str) -> Self {
		self.filter = filter;
		self
	}

	#[must_use]
	pub fn with_original(mut self, original: impl Into<String>) -> Self {
		if self.changed {
			self.original_text = Some(original.into());
		}
		self
	}

	#[must_use]
	pub fn with_text(mut self, text: String) -> Self {
		self.output_bytes = text.len();
		self.text = text;
		self
	}
}

#[allow(
	clippy::missing_const_for_fn,
	reason = "kept non-const because this constructs owned output used only at runtime"
)]
pub(crate) fn chain_output(
	text: String,
	original_text: String,
	input_bytes: usize,
	changed: bool,
) -> MinimizerOutput {
	let filter = if changed { "chain" } else { "chain-noop" };
	let output_bytes = text.len();
	MinimizerOutput {
		text,
		changed,
		input_bytes,
		output_bytes,
		filter,
		original_text: Some(original_text),
	}
}

#[must_use]
pub fn apply(
	command: &str,
	captured: &str,
	exit_code: i32,
	config: &MinimizerConfig,
) -> MinimizerOutput {
	engine::apply(command, captured, exit_code, config)
}
