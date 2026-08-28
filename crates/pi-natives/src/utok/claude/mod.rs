mod constants;
mod engine;
mod normalize;

use std::sync::LazyLock;

use engine::VocabCore;
use normalize::{FrameParams, nfc_units, raw_head_space_units, stream_norm, trim_end_ws};

use crate::utok::utf::Unit;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Family {
	V3,

	V47,

	V5,

	V5Sonnet,
}

static CORE_V3: LazyLock<VocabCore> = LazyLock::new(|| {
	let raw = zstd::decode_all(&include_bytes!("../../../data/ctok_v3.bin.zst")[..])
		.expect("utoken: ctok v3 zstd decode failed");
	VocabCore::parse(&raw)
});

static CORE_V47: LazyLock<VocabCore> = LazyLock::new(|| {
	let raw = zstd::decode_all(&include_bytes!("../../../data/ctok_v4_7.bin.zst")[..])
		.expect("utoken: ctok v4.7 zstd decode failed");
	VocabCore::parse(&raw)
});

impl Family {
	fn core(self) -> &'static VocabCore {
		match self {
			Self::V3 => &CORE_V3,
			Self::V47 | Self::V5 | Self::V5Sonnet => &CORE_V47,
		}
	}

	fn params(self) -> FrameParams {
		let mut p = self.core().frame_params();
		if matches!(self, Self::V5 | Self::V5Sonnet) {
			p.message_overhead = 6;
			p.frame_bow = false;
			p.ladder = self == Self::V5Sonnet;
		}
		p
	}

	const fn appended_newlines(self) -> usize {
		match self {
			Self::V5Sonnet => 0,
			_ => 2,
		}
	}
}

pub fn content_token_count<U: Unit>(units: &[U], family: Family) -> u32 {
	let core = family.core();
	let p = family.params();
	let head_space = raw_head_space_units(units);
	if p.ladder {
		let norm = nfc_units(units, p.fold_quotes);

		let n_tail = norm.bytes().rev().take_while(|&b| b == b'\n').count();
		let stream = stream_norm(&norm, &p, head_space);
		let tail = core.ladder_tail_cost(n_tail, family.appended_newlines());
		if stream.is_empty() {
			return tail;
		}
		core.tile_cost(&stream) + tail
	} else {
		let stripped = trim_end_ws(units);
		let norm = nfc_units(stripped, p.fold_quotes);
		let stream = stream_norm(&norm, &p, head_space);
		if stream.is_empty() {
			0
		} else {
			core.tile_cost(&stream)
		}
	}
}
