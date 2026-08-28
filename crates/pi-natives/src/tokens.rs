use napi::{
	JsString,
	bindgen_prelude::{Array, Either},
};
use napi_derive::napi;
use pi_shell::rayon_global_pool_available;
use rayon::prelude::*;

use crate::{js, utok};

#[napi(string_enum)]
pub enum Encoding {
	O200kBase,

	Cl100kBase,

	ClaudeV3,

	ClaudeV47,

	ClaudeV5,

	ClaudeV5Sonnet,

	Qwen3,

	DeepSeekV3,

	KimiK2,

	Glm5,
}

impl Encoding {
	fn utok(encoding: Option<Self>) -> utok::Encoding {
		match encoding.unwrap_or(Self::O200kBase) {
			Self::O200kBase => utok::Encoding::O200kBase,
			Self::Cl100kBase => utok::Encoding::Cl100kBase,
			Self::ClaudeV3 => utok::Encoding::ClaudeV3,
			Self::ClaudeV47 => utok::Encoding::ClaudeV47,
			Self::ClaudeV5 => utok::Encoding::ClaudeV5,
			Self::ClaudeV5Sonnet => utok::Encoding::ClaudeV5Sonnet,
			Self::Qwen3 => utok::Encoding::Qwen3,
			Self::DeepSeekV3 => utok::Encoding::DeepSeekV3,
			Self::KimiK2 => utok::Encoding::KimiK2,
			Self::Glm5 => utok::Encoding::Glm5,
		}
	}
}

#[napi]
pub fn count_tokens(
	#[napi(ts_arg_type = "string | string[]")] input: Either<JsString, Array>,
	encoding: Option<Encoding>,
) -> napi::Result<u32> {
	let enc = Encoding::utok(encoding);
	match input {
		Either::A(text) => Ok(enc.count(&*js::utf16(text)?)),
		Either::B(array) => {
			let mut units = Vec::new();
			let mut spans = Vec::with_capacity(array.len() as usize);
			for index in 0..array.len() {
				let text = array
					.get::<JsString>(index)?
					.ok_or_else(|| napi::Error::from_reason("array changed during token counting"))?;
				spans.push(js::utf16_append(text, &mut units)?);
			}

			const PARALLEL_BATCH_MIN: usize = 16;
			Ok(if spans.len() >= PARALLEL_BATCH_MIN && rayon_global_pool_available() {
				spans
					.par_iter()
					.map(|span| enc.count(&units[span.clone()]))
					.sum()
			} else {
				spans
					.iter()
					.map(|span| enc.count(&units[span.clone()]))
					.sum()
			})
		},
	}
}
