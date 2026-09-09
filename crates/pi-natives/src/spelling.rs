use napi::{Error, Result, Status};
use napi_derive::napi;

#[napi(object)]
pub struct SpellingRange {
	pub start: u32,

	pub length: u32,
}

#[cfg_attr(
	not(target_os = "macos"),
	allow(dead_code, reason = "macOS result filter is unit-tested cross-platform")
)]
fn collect_spelling_ranges(
	results: impl IntoIterator<Item = (bool, usize, usize)>,
) -> Result<Vec<SpellingRange>> {
	const NS_NOT_FOUND: usize = isize::MAX as usize;
	let mut ranges = Vec::new();
	for (is_spelling, start, length) in results {
		if !is_spelling || length == 0 || start >= NS_NOT_FOUND {
			continue;
		}
		ranges.push(SpellingRange {
			start:  u32::try_from(start)
				.map_err(|_| Error::new(Status::InvalidArg, "spelling range start is too large"))?,
			length: u32::try_from(length)
				.map_err(|_| Error::new(Status::InvalidArg, "spelling range length is too large"))?,
		});
	}
	Ok(ranges)
}

#[cfg(target_os = "macos")]
mod platform {
	use std::sync::LazyLock;

	use napi::{Error, Result, Status};
	use objc2::rc::Retained;
	use objc2_app_kit::NSSpellChecker;
	use objc2_foundation::{NSArray, NSRange, NSString, NSTextCheckingType};

	use super::{SpellingRange, collect_spelling_ranges};

	type Job = Box<dyn FnOnce() + Send + 'static>;

	static SPELLING_THREAD: LazyLock<flume::Sender<Job>> = LazyLock::new(|| {
		let (sender, receiver) = flume::unbounded::<Job>();
		std::thread::Builder::new()
			.name("pi-native-spelling".into())
			.spawn(move || {
				while let Ok(job) = receiver.recv() {
					job();
				}
			})
			.expect("failed to spawn the native spelling thread");
		sender
	});
	static APP_KIT_LOADED: LazyLock<bool> = LazyLock::new(|| unsafe { NSApplicationLoad() });

	#[link(name = "AppKit", kind = "framework")]
	unsafe extern "C" {
		fn NSApplicationLoad() -> bool;
	}

	fn checker() -> Result<Retained<NSSpellChecker>> {
		if !*APP_KIT_LOADED {
			return Err(Error::new(Status::GenericFailure, "failed to initialize AppKit"));
		}
		let checker = NSSpellChecker::sharedSpellChecker();
		checker.setAutomaticallyIdentifiesLanguages(true);
		Ok(checker)
	}

	pub async fn run<T>(work: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T>
	where
		T: Send + 'static,
	{
		let (reply, result) = flume::bounded(1);
		SPELLING_THREAD
			.send(Box::new(move || {
				let _ = reply.send(work());
			}))
			.map_err(|_| Error::new(Status::GenericFailure, "native spelling thread stopped"))?;
		result
			.recv_async()
			.await
			.map_err(|_| Error::new(Status::GenericFailure, "native spelling thread stopped"))?
	}

	fn ns_range(start: u32, length: u32) -> Result<NSRange> {
		Ok(NSRange {
			location: usize::try_from(start)
				.map_err(|_| Error::new(Status::InvalidArg, "spelling range start is too large"))?,
			length:   usize::try_from(length)
				.map_err(|_| Error::new(Status::InvalidArg, "spelling range length is too large"))?,
		})
	}

	pub fn check(text: &str) -> Result<Vec<SpellingRange>> {
		let checker = checker()?;
		let text = NSString::from_str(text);
		let full = NSRange { location: 0, length: text.length() };

		let results = unsafe {
			checker.checkString_range_types_options_inSpellDocumentWithTag_orthography_wordCount(
				&text,
				full,
				NSTextCheckingType::Spelling.bits(),
				None,
				0,
				None,
				std::ptr::null_mut(),
			)
		};
		collect_spelling_ranges(results.iter().map(|result| {
			let range = result.range();
			(result.resultType() == NSTextCheckingType::Spelling, range.location, range.length)
		}))
	}

	fn strings(values: Option<Retained<NSArray<NSString>>>) -> Vec<String> {
		values
			.map(|values| values.iter().map(|value| value.to_string()).collect())
			.unwrap_or_default()
	}

	fn word_language(
		checker: &NSSpellChecker,
		text: &NSString,
		range: NSRange,
	) -> Retained<NSString> {
		checker
			.languageForWordRange_inString_orthography(range, text, None)
			.unwrap_or_else(|| checker.language())
	}

	pub fn completions(text: &str, start: u32, length: u32) -> Result<Vec<String>> {
		let checker = checker()?;
		let text = NSString::from_str(text);
		let range = ns_range(start, length)?;
		let language = word_language(&checker, &text, range);
		let values = checker.completionsForPartialWordRange_inString_language_inSpellDocumentWithTag(
			range,
			&text,
			Some(&*language),
			0,
		);
		Ok(strings(values))
	}

	pub fn guesses(text: &str, start: u32, length: u32) -> Result<Vec<String>> {
		let checker = checker()?;
		let text = NSString::from_str(text);
		let range = ns_range(start, length)?;
		let language = word_language(&checker, &text, range);
		let values = checker.guessesForWordRange_inString_language_inSpellDocumentWithTag(
			range,
			&text,
			Some(&*language),
			0,
		);
		Ok(strings(values))
	}

	pub fn correction(text: &str, start: u32, length: u32) -> Result<Option<String>> {
		let checker = checker()?;
		let text = NSString::from_str(text);
		let range = ns_range(start, length)?;
		let language = word_language(&checker, &text, range);
		let value = checker.correctionForWordRange_inString_language_inSpellDocumentWithTag(
			range, &text, &language, 0,
		);
		Ok(value.map(|value| value.to_string()))
	}
}

#[napi(js_name = "macOSSpellCheckerAvailable")]
#[allow(clippy::missing_const_for_fn, reason = "napi macro is incompatible with const fn")]
pub fn macos_spell_checker_available() -> bool {
	cfg!(target_os = "macos")
}

#[napi(js_name = "macOSCheckSpelling")]
#[cfg_attr(
	not(target_os = "macos"),
	allow(clippy::unused_async, reason = "napi contract returns a Promise on every platform")
)]
pub async fn macos_check_spelling(text: String) -> napi::Result<Vec<SpellingRange>> {
	#[cfg(target_os = "macos")]
	{
		platform::run(move || platform::check(&text)).await
	}
	#[cfg(not(target_os = "macos"))]
	{
		let _ = text;
		Ok(Vec::new())
	}
}

#[napi(js_name = "macOSCompleteWord")]
#[cfg_attr(
	not(target_os = "macos"),
	allow(clippy::unused_async, reason = "napi contract returns a Promise on every platform")
)]
pub async fn macos_complete_word(
	text: String,
	start: u32,
	length: u32,
) -> napi::Result<Vec<String>> {
	#[cfg(target_os = "macos")]
	{
		platform::run(move || platform::completions(&text, start, length)).await
	}
	#[cfg(not(target_os = "macos"))]
	{
		let _ = (text, start, length);
		Ok(Vec::new())
	}
}

#[napi(js_name = "macOSAutocorrectWord")]
#[cfg_attr(
	not(target_os = "macos"),
	allow(clippy::unused_async, reason = "napi contract returns a Promise on every platform")
)]
pub async fn macos_autocorrect_word(
	text: String,
	start: u32,
	length: u32,
) -> napi::Result<Option<String>> {
	#[cfg(target_os = "macos")]
	{
		platform::run(move || platform::correction(&text, start, length)).await
	}
	#[cfg(not(target_os = "macos"))]
	{
		let _ = (text, start, length);
		Ok(None)
	}
}

#[napi(js_name = "macOSSpellingGuesses")]
#[cfg_attr(
	not(target_os = "macos"),
	allow(clippy::unused_async, reason = "napi contract returns a Promise on every platform")
)]
pub async fn macos_spelling_guesses(
	text: String,
	start: u32,
	length: u32,
) -> napi::Result<Vec<String>> {
	#[cfg(target_os = "macos")]
	{
		platform::run(move || platform::guesses(&text, start, length)).await
	}
	#[cfg(not(target_os = "macos"))]
	{
		let _ = (text, start, length);
		Ok(Vec::new())
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn check_filters_non_spelling_full_range_that_duplicates_editor_text() {
		let ranges =
			collect_spelling_ranges([(false, 0, 12), (true, 4, 3), (true, isize::MAX as usize, 1)])
				.expect("valid spelling ranges should convert");

		assert_eq!(ranges.len(), 1, "orthography and sentinel ranges must not render as typos");
		assert_eq!(ranges[0].start, 4);
		assert_eq!(ranges[0].length, 3);
	}
}
