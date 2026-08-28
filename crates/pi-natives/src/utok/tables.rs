use std::sync::LazyLock;

use crate::utok::{
	Encoding,
	bpe::{BpeEncoding, RankTable},
	pretoken::Splitter,
};

static O200K_BASE: LazyLock<BpeEncoding> = LazyLock::new(|| BpeEncoding {
	table:         RankTable::parse(include_bytes!("../../data/o200k_base.bin.zst")),
	splitter:      Splitter::O200k,
	nfc:           false,
	ignore_merges: false,
});

static CL100K_BASE: LazyLock<BpeEncoding> = LazyLock::new(|| BpeEncoding {
	table:         RankTable::parse(include_bytes!("../../data/cl100k_base.bin.zst")),
	splitter:      Splitter::Cl100k,
	nfc:           false,
	ignore_merges: false,
});

static QWEN3: LazyLock<BpeEncoding> = LazyLock::new(|| BpeEncoding {
	table:         RankTable::parse(include_bytes!("../../data/qwen3.bin.zst")),
	splitter:      Splitter::Qwen,
	nfc:           true,
	ignore_merges: false,
});

static DEEPSEEK3: LazyLock<BpeEncoding> = LazyLock::new(|| BpeEncoding {
	table:         RankTable::parse(include_bytes!("../../data/deepseek3.bin.zst")),
	splitter:      Splitter::DeepSeek,
	nfc:           false,
	ignore_merges: false,
});

static KIMI_K2: LazyLock<BpeEncoding> = LazyLock::new(|| BpeEncoding {
	table:         RankTable::parse(include_bytes!("../../data/kimi_k2.bin.zst")),
	splitter:      Splitter::Kimi,
	nfc:           false,
	ignore_merges: false,
});

static GLM5: LazyLock<BpeEncoding> = LazyLock::new(|| BpeEncoding {
	table:         RankTable::parse(include_bytes!("../../data/glm5.bin.zst")),
	splitter:      Splitter::Cl100k,
	nfc:           false,
	ignore_merges: true,
});

pub(crate) fn bpe_for(enc: Encoding) -> &'static BpeEncoding {
	match enc {
		Encoding::O200kBase => &O200K_BASE,
		Encoding::Cl100kBase => &CL100K_BASE,
		Encoding::Qwen3 => &QWEN3,
		Encoding::DeepSeekV3 => &DEEPSEEK3,
		Encoding::KimiK2 => &KIMI_K2,
		Encoding::Glm5 => &GLM5,
		_ => unreachable!("claude families never reach bpe_for"),
	}
}
