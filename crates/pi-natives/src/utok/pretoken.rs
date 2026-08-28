//! Pre-tokenization: per-family piece splitting.
//!
//! Families use HF `Split` semantics with `behavior: Isolated` — every
//! match becomes its own piece and unmatched gaps survive as pieces too.
//! Every family runs a hand-written codepoint scanner ([`crate::utok::scan`])
//! natively over any UTF flavor.

use crate::utok::{scan, utf::Unit};

/// A family's piece splitter.
pub enum Splitter {
	/// tiktoken `o200k_base` scanner.
	O200k,
	/// tiktoken `cl100k_base` scanner.
	Cl100k,
	/// `DeepSeek` V3..V4 three-stage chain scanner.
	DeepSeek,
	/// Kimi K2/K3 scanner.
	Kimi,
	/// Qwen3 scanner.
	Qwen,
}

impl Splitter {
	/// Feed every piece of `units` to `f`, in order, covering the input
	/// exactly.
	pub fn for_each_piece<U: Unit>(&self, units: &[U], mut f: impl FnMut(&[U])) {
		match self {
			Self::O200k => scan_loop(units, &mut f, scan::o200k::next_piece),
			Self::Cl100k => scan_loop(units, &mut f, scan::cl100k::next_piece),
			Self::DeepSeek => scan::deepseek::for_each_piece(units, &mut f),
			Self::Kimi => scan_loop(units, &mut f, scan::kimi::next_piece),
			Self::Qwen => scan_loop(units, &mut f, scan::qwen::next_piece),
		}
	}
}

/// Drive a single-stage scanner over `units`.
pub(crate) fn scan_loop<U: Unit>(
	units: &[U],
	f: &mut impl FnMut(&[U]),
	next: impl Fn(&[U], usize) -> usize,
) {
	let mut pos = 0;
	while pos < units.len() {
		let end = next(units, pos);
		debug_assert!(pos < end && end <= units.len(), "utoken: scanner must advance within bounds");
		f(&units[pos..end]);
		pos = end;
	}
}

/// NFC-normalize (Qwen3 input contract). Borrows when no work is needed:
/// ASCII short-circuit (std `is_ascii` is word-vectorized; cf. xutf's SIMD
/// ASCII kernels) then the NFC quick-check, so only text that actually
/// needs recomposition allocates.
pub fn nfc(text: &str) -> std::borrow::Cow<'_, str> {
	use xutf::ToUnicodeNormalized;
	if text.is_ascii() || xutf::is_nfc(text) {
		return std::borrow::Cow::Borrowed(text);
	}
	std::borrow::Cow::Owned(text.to_nfc())
}
