//! Lazily-decoded embedded tables and per-family wiring.
//!
//! Each family agent: add your `LazyLock`, your pattern constant(s), and
//! your arm in [`bpe_for`]. Data blobs live in `data/<name>.bin.zst`
//! (UTOK1 + zstd; see `data/families.json`). Patterns come from
//! `data/families.json` — do not invent them.

use std::sync::LazyLock;

use crate::utok::{
	Encoding,
	bpe::{BpeEncoding, RankTable},
	pretoken::Splitter,
};

// ── OpenAI ──────────────────────────────────────────────────────────────
// Codepoint scanners in src/scan/{o200k,cl100k}.rs, hand-ported from the
// tiktoken-rs 0.7.0 patterns (src/tiktoken_ext/openai_public.rs, identical
// to openai/tiktoken tiktoken_ext/openai_public.py) and differential-tested
// against tiktoken-rs in tests/openai.rs.

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

// ── Qwen3 ───────────────────────────────────────────────────────────────
// Pattern: qwen3.8.tokenizer.json pre_tokenizer Split regex, verified equal
// to data/families.json qwen3.pre. Note `\p{N}` matches a SINGLE digit
// (unlike cl100k's {1,3}) and letters admit trailing marks `[\p{L}\p{M}]+`.
// Normalizer is NFC (`nfc: true`). The pack (tools/pack-qwen.ts) empties the
// 201 merge-unreachable vocab slots so the engine's whole-piece
// short-circuit cannot emit ids the HF reference (ignore_merges=false)
// never produces.

static QWEN3: LazyLock<BpeEncoding> = LazyLock::new(|| BpeEncoding {
	table:         RankTable::parse(include_bytes!("../../data/qwen3.bin.zst")),
	splitter:      Splitter::Qwen,
	nfc:           true,
	ignore_merges: false,
});

// ── DeepSeek ────────────────────────────────────────────────────────────
// Three-stage HF Split(Isolated) chain from data/families.json deepseek3
// (cache/deepseek-v4.tokenizer.json pre_tokenizer; base BPE identical
// V3..V4): digits ≤3, then CJK runs (Han + hiragana + katakana blocks),
// then the main pattern with a punctuation-prefix-letters alternate.

static DEEPSEEK3: LazyLock<BpeEncoding> = LazyLock::new(|| BpeEncoding {
	table:         RankTable::parse(include_bytes!("../../data/deepseek3.bin.zst")),
	splitter:      Splitter::DeepSeek,
	nfc:           false,
	ignore_merges: false,
});

// ── Kimi ────────────────────────────────────────────────────────────────
// Runtime split: hand-written scanner (`scan::kimi`), a port of the
// tokenization_kimi.py pat_str (8-alternate join, class intersection
// `&&[^\p{Han}]`, `\s+(?!\S)` lookahead).

static KIMI_K2: LazyLock<BpeEncoding> = LazyLock::new(|| BpeEncoding {
	table:         RankTable::parse(include_bytes!("../../data/kimi_k2.bin.zst")),
	splitter:      Splitter::Kimi,
	nfc:           false,
	ignore_merges: false,
});

// ── GLM ─────────────────────────────────────────────────────────────────
// Pattern: glm-5.tokenizer.json pre_tokenizer Split regex, verified equal
// to data/families.json glm5.pre — and character-identical to tiktoken's
// cl100k_base pattern, so the runtime splitter aliases the cl100k scanner
// (`scan::cl100k`) instead of duplicating it.
// `ignore_merges: true` — whole-piece vocab hits bypass merging; the
// engine's encode_piece short-circuit implements exactly this (proven by
// directed fixtures: greedy-merge-unreachable tokens like ' 参考' encode
// as one id).

static GLM5: LazyLock<BpeEncoding> = LazyLock::new(|| BpeEncoding {
	table:         RankTable::parse(include_bytes!("../../data/glm5.bin.zst")),
	splitter:      Splitter::Cl100k,
	nfc:           false,
	ignore_merges: true,
});

/// Resolve the BPE encoding for a non-Claude family.
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
