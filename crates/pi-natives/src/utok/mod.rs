mod bpe;
mod claude;
mod pretoken;
mod scan;
mod tables;
mod utf;
pub use self::{
	bpe::RankTable,
	utf::{Cursor, Unit, Utf},
};

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
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
	pub fn count<T: Utf + ?Sized>(self, text: &T) -> u32 {
		match self {
			Self::ClaudeV3 => claude::content_token_count(text.units(), claude::Family::V3),
			Self::ClaudeV47 => claude::content_token_count(text.units(), claude::Family::V47),
			Self::ClaudeV5 => claude::content_token_count(text.units(), claude::Family::V5),
			Self::ClaudeV5Sonnet => {
				claude::content_token_count(text.units(), claude::Family::V5Sonnet)
			},
			_ => tables::bpe_for(self).count(text.units()),
		}
	}

	pub fn encode<T: Utf + ?Sized>(self, text: &T) -> Option<Vec<u32>> {
		match self {
			Self::ClaudeV3 | Self::ClaudeV47 | Self::ClaudeV5 | Self::ClaudeV5Sonnet => None,
			_ => Some(tables::bpe_for(self).encode(text.units())),
		}
	}
}
