use crate::utok::{scan, utf::Unit};

pub enum Splitter {
	O200k,

	Cl100k,

	DeepSeek,

	Kimi,

	Qwen,
}

impl Splitter {
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

pub fn nfc(text: &str) -> std::borrow::Cow<'_, str> {
	use xutf::ToUnicodeNormalized;
	if text.is_ascii() || xutf::is_nfc(text) {
		return std::borrow::Cow::Borrowed(text);
	}
	std::borrow::Cow::Owned(text.to_nfc())
}
