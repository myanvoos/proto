



use brush_core::{ShellExtensions, builtins::Registration};

use crate::host::{Host, Utility, format_usage, matches_parser, util};

mod format_modifiers {





























	use std::{fmt, sync::LazyLock};

	use jiff::{
		Zoned,
		fmt::strtime::{BrokenDownTime, Config, PosixCustom},
	};
	use regex::Regex;


	#[derive(Debug)]
	pub enum FormatError {

		JiffError(jiff::Error),

		FieldWidthTooLarge { width: usize, specifier: String },
	}

	impl fmt::Display for FormatError {
		fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
			match self {
				Self::JiffError(e) => write!(f, "{e}"),


				Self::FieldWidthTooLarge { width, specifier } => {
					write!(f, "format modifier width '{width}' is too large for specifier '%{specifier}'")
				},
			}
		}
	}

	impl From<jiff::Error> for FormatError {
		fn from(e: jiff::Error) -> Self {
			Self::JiffError(e)
		}
	}







	static FORMAT_SPEC_REGEX: LazyLock<Regex> =
		LazyLock::new(|| Regex::new(r"%([_0^#+-]*)(\d*)(:*[a-zA-Z])").unwrap());







	pub fn format_with_modifiers_if_present(
		date: &Zoned,
		format_string: &str,
		config: &Config<PosixCustom>,
	) -> Option<Result<String, FormatError>> {
		let re = &*FORMAT_SPEC_REGEX;


		let has_modifiers = re.captures_iter(format_string).any(|cap| {
			let flags = cap.get(1).map_or("", |m| m.as_str());
			let width_str = cap.get(2).map_or("", |m| m.as_str());
			!flags.is_empty() || !width_str.is_empty()
		});

		if !has_modifiers {
			return None;
		}


		Some(format_with_modifiers(date, format_string, config))
	}













	fn format_with_modifiers(
		date: &Zoned,
		format_string: &str,
		config: &Config<PosixCustom>,
	) -> Result<String, FormatError> {

		let placeholder = "\x00PERCENT\x00";
		let temp_format = format_string.replace("%%", placeholder);

		let re = &*FORMAT_SPEC_REGEX;
		let mut result = String::new();
		let mut last_end = 0;

		let broken_down = BrokenDownTime::from(date);

		for cap in re.captures_iter(&temp_format) {
			let whole_match = cap.get(0).unwrap();
			let flags = cap.get(1).map_or("", |m| m.as_str());
			let width_str = cap.get(2).map_or("", |m| m.as_str());
			let spec = cap.get(3).unwrap().as_str();


			result.push_str(&temp_format[last_end..whole_match.start()]);


			let base_format = format!("%{spec}");
			let formatted = broken_down.to_string_with_config(config, &base_format)?;


			if !flags.is_empty() || !width_str.is_empty() {

				let width: usize = width_str.parse().unwrap_or(0);
				let explicit_width = !width_str.is_empty();
				let modified = apply_modifiers(&formatted, flags, width, spec, explicit_width)?;
				result.push_str(&modified);
			} else {

				result.push_str(&formatted);
			}

			last_end = whole_match.end();
		}


		result.push_str(&temp_format[last_end..]);


		let result = result.replace(placeholder, "%");

		Ok(result)
	}



	fn is_text_specifier(specifier: &str) -> bool {
		matches!(specifier.chars().last(), Some('A' | 'a' | 'B' | 'b' | 'h' | 'Z' | 'p' | 'P'))
	}




	fn is_space_padded_specifier(specifier: &str) -> bool {
		matches!(
			specifier.chars().last(),
			Some('A' | 'a' | 'B' | 'b' | 'h' | 'Z' | 'p' | 'P' | 'e' | 'k' | 'l')
		)
	}



	fn get_default_width(specifier: &str) -> usize {
		match specifier.chars().last() {

			Some('d') | Some('e') => 2,

			Some('m') => 2,

			Some('H') | Some('k') => 2,

			Some('I') | Some('l') => 2,

			Some('M') => 2,

			Some('S') => 2,

			Some('y') => 2,

			Some('j') => 3,

			Some('U') | Some('W') | Some('V') => 2,

			Some('w') | Some('u') => 1,

			Some('C') => 2,

			Some('Y') | Some('G') => 4,

			Some('g') => 2,

			Some('s') => 0,

			Some('N') => 9,

			Some('q') => 1,

			Some('z') => 0,

			_ => 0,
		}
	}



	fn strip_default_padding(value: &str) -> String {
		if value.starts_with('0') && value.len() >= 2 {
			let stripped = value.trim_start_matches('0');
			if stripped.is_empty() {
				return "0".to_string();
			}
			if let Some(first_char) = stripped.chars().next()
				&& first_char.is_ascii_digit()
			{
				return stripped.to_string();
			}
		}
		if value.starts_with(' ') {
			let stripped = value.trim_start();
			if !stripped.is_empty() {
				return stripped.to_string();
			}
		}
		value.to_string()
	}











	fn apply_modifiers(
		value: &str,
		flags: &str,
		width: usize,
		specifier: &str,
		explicit_width: bool,
	) -> Result<String, FormatError> {
		let mut result = value.to_string();





		let default_pad = if is_space_padded_specifier(specifier) {
			' '
		} else {
			'0'
		};


		let mut pad_char = default_pad;
		let mut no_pad = false;
		let mut uppercase = false;
		let mut swap_case = false;
		let mut force_sign = false;
		let mut underscore_flag = false;

		for flag in flags.chars() {
			match flag {
				'-' => {
					no_pad = true;
				},
				'_' => {
					no_pad = false;
					pad_char = ' ';
					underscore_flag = true;
				},
				'0' => {
					no_pad = false;
					pad_char = '0';
				},
				'^' => {
					uppercase = true;
					swap_case = false;
				},
				'#' if !uppercase => {

					swap_case = true;
				},
				'+' => {
					force_sign = true;
					no_pad = false;
					pad_char = '0';
				},
				_ => {},
			}
		}


		if uppercase {
			result = result.to_uppercase();
		} else if swap_case {
			if result
				.chars()
				.all(|c| !c.is_alphabetic() || c.is_uppercase())
			{
				result = result.to_lowercase();
			} else if !result
				.chars()
				.all(|c| !c.is_alphabetic() || c.is_lowercase())
			{
				result = result.to_uppercase();
			}
		}


		if no_pad {
			return Ok(strip_default_padding(&result));
		}




		let effective_width = if !explicit_width && (underscore_flag || pad_char != default_pad) {
			get_default_width(specifier)
		} else {
			width
		};



		if effective_width > 0 && effective_width < result.len() {
			result = strip_default_padding(&result);
		}


		if !is_text_specifier(specifier) && result.len() >= 2 {
			if pad_char == ' ' && result.starts_with('0') {

				result = strip_default_padding(&result);
			} else if pad_char == '0' && result.starts_with(' ') {

				result = strip_default_padding(&result);
			}
		}






		if force_sign
			&& !result.starts_with('+')
			&& !result.starts_with('-')
			&& result.chars().next().is_some_and(|c| c.is_ascii_digit())
		{
			let default_w = get_default_width(specifier);

			if explicit_width || (default_w > 0 && result.len() > default_w) {
				result.insert(0, '+');
			}
		}


		if effective_width > result.len() {
			let padding = effective_width - result.len();
			let has_sign = result.starts_with('+') || result.starts_with('-');

			if pad_char == '0' && has_sign {

				let sign = result.chars().next().unwrap();
				let rest = &result[1..];
				let mut padded = try_alloc_padded(result.len(), padding, effective_width, specifier)?;
				padded.push(sign);
				padded.extend(std::iter::repeat_n('0', padding));
				padded.push_str(rest);
				result = padded;
			} else {

				let mut padded = try_alloc_padded(result.len(), padding, effective_width, specifier)?;
				padded.extend(std::iter::repeat_n(pad_char, padding));
				padded.push_str(&result);
				result = padded;
			}
		}

		Ok(result)
	}



	fn try_alloc_padded(
		current_len: usize,
		padding: usize,
		width: usize,
		specifier: &str,
	) -> Result<String, FormatError> {
		let target_len = current_len
			.checked_add(padding)
			.ok_or_else(|| FormatError::FieldWidthTooLarge { width, specifier: specifier.to_string() })?;
		let mut s = String::new();
		s.try_reserve(target_len)
			.map_err(|_| FormatError::FieldWidthTooLarge { width, specifier: specifier.to_string() })?;
		Ok(s)
	}


}

use std::{
	borrow::Cow,
	collections::HashMap,
	ffi::OsString,
	fs::File,
	io::{BufRead, BufReader, Read, Write},
	path::{Path, PathBuf},
	sync::LazyLock,
};
#[cfg(any(
	target_os = "linux",
	target_vendor = "apple",
	target_os = "freebsd",
	target_os = "netbsd",
	target_os = "openbsd",
	target_os = "dragonfly",
))]
use std::ffi::{CStr, CString};


use clap::{Arg, ArgAction, ArgMatches, Command};
use jiff::{
	Span, Timestamp, Zoned,
	fmt::strtime::{self, BrokenDownTime, Config, PosixCustom},
	tz::{Offset, TimeZone, TimeZoneDatabase},
};
use uucore::{display::Quotable, parser::shortcut_value_parser::ShortcutValueParser};


const DATE: &str = "date";
const HOURS: &str = "hours";
const MINUTES: &str = "minutes";
const SECONDS: &str = "seconds";
const NS: &str = "ns";

const OPT_DATE: &str = "date";
const OPT_FORMAT: &str = "format";
const OPT_FILE: &str = "file";
const OPT_DEBUG: &str = "debug";
const OPT_ISO_8601: &str = "iso-8601";
const OPT_RESOLUTION: &str = "resolution";
const OPT_RFC_EMAIL: &str = "rfc-email";
const OPT_RFC_822: &str = "rfc-822";
const OPT_RFC_2822: &str = "rfc-2822";
const OPT_RFC_3339: &str = "rfc-3339";
const OPT_SET: &str = "set";
const OPT_REFERENCE: &str = "reference";
const OPT_UNIVERSAL: &str = "universal";
const OPT_UNIVERSAL_2: &str = "utc";

const OPT_BSD_ADJUST: &str = "bsd-adjust";
const OPT_BSD_PARSE_ONLY: &str = "bsd-parse-only";


struct Settings {
	utc:         bool,
	format:      Format,
	date_source: DateSource,
	debug:       bool,
	default_format: String,
}


#[derive(Clone, Copy)]
struct DebugOptions {

	debug:         bool,

	warn_midnight: bool,
}

impl DebugOptions {
	fn new(debug: bool, warn_midnight: bool) -> Self {
		Self { debug, warn_midnight }
	}
}


enum Format {
	Iso8601(Iso8601Format),
	Rfc5322,
	Rfc3339(Rfc3339Format),
	Resolution,
	Custom(String),
	Default,
}


enum DateSource {
	Now,
	File(PathBuf),
	FileMtime(PathBuf),
	Stdin,
	Human(String),

	Strptime { format: String, value: String },
	Resolution,
}

enum Iso8601Format {
	Date,
	Hours,
	Minutes,
	Seconds,
	Ns,
}

impl From<&str> for Iso8601Format {
	fn from(s: &str) -> Self {
		match s {
			HOURS => Self::Hours,
			MINUTES => Self::Minutes,
			SECONDS => Self::Seconds,
			NS => Self::Ns,
			DATE => Self::Date,

			_ => unreachable!(),
		}
	}
}

enum Rfc3339Format {
	Date,
	Seconds,
	Ns,
}

impl From<&str> for Rfc3339Format {
	fn from(s: &str) -> Self {
		match s {
			DATE => Self::Date,
			SECONDS => Self::Seconds,
			NS => Self::Ns,

			_ => panic!("Invalid format: {s}"),
		}
	}
}





#[derive(PartialEq, Debug)]
enum DayDelta {

	Same,

	Previous,

	Next,
}



















fn escape_invalid_bytes(bytes: &[u8]) -> String {
	let escaped = bytes
		.iter()
		.flat_map(|&b| {

			if (0x20..0x7f).contains(&b) && b != b'\\' {
				vec![b]
			} else {

				format!("\\{b:03o}").into_bytes()
			}
		})
		.collect::<Vec<u8>>();
	String::from_utf8_lossy(&escaped).into_owned()
}












fn strip_parenthesized_comments(input: &str) -> Cow<'_, str> {
	if !input.contains('(') {
		return Cow::Borrowed(input);
	}

	let mut result = String::with_capacity(input.len());
	let mut depth = 0;

	for c in input.chars() {
		match c {
			'(' => {
				depth += 1;
			},
			')' if depth > 0 => {
				depth -= 1;
			},
			_ if depth == 0 => {
				result.push(c);
			},
			_ => {},
		}
	}

	Cow::Owned(result)
}














fn parse_military_timezone_with_offset(s: &str) -> Option<(i32, DayDelta)> {
	if s.is_empty() || s.len() > 3 {
		return None;
	}

	let mut chars = s.chars();
	let letter = chars.next()?.to_ascii_lowercase();



	if !letter.is_ascii_lowercase() || letter == 'j' {
		return None;
	}


	let additional_hours: i32 = if let Some(rest) = chars.as_str().chars().next() {
		if !rest.is_ascii_digit() {
			return None;
		}
		chars.as_str().parse().ok()?
	} else {
		0
	};


	let tz_offset = match letter {
		'a'..='i' => (letter as i32 - 'a' as i32) + 1,
		'k'..='m' => (letter as i32 - 'k' as i32) + 10,
		'n'..='y' => -((letter as i32 - 'n' as i32) + 1),
		'z' => 0,
		_ => return None,
	};

	let day_delta = match additional_hours - tz_offset {
		h if h < 0 => DayDelta::Previous,
		h if h >= 24 => DayDelta::Next,
		_ => DayDelta::Same,
	};



	let hours_from_midnight = (0 - tz_offset + additional_hours).rem_euclid(24);

	Some((hours_from_midnight, day_delta))
}







fn rewrite_date_argv(argv: Vec<OsString>) -> Vec<OsString> {

	const VALUE_LONGS: &[&str] = &["date", "file", "reference", "set", "rfc-3339"];

	const FLAG_LONGS: &[&str] =
		&["debug", "resolution", "rfc-email", "rfc-2822", "rfc-822", "universal", "utc", "uct"];

	const VALUE_SHORTS: &[char] = &['d', 'f', 'r', 's', 'v'];

	let mut out = Vec::with_capacity(argv.len());
	let mut argv = argv.into_iter();
	if let Some(name) = argv.next() {
		out.push(name);
	}
	let mut skip_value = false;
	let mut opts_ended = false;
	for arg in argv {
		if skip_value || opts_ended {
			skip_value = false;
			out.push(arg);
			continue;
		}
		let Some(token) = arg.to_str() else {
			out.push(arg);
			continue;
		};
		if token == "--" {
			opts_ended = true;
			out.push(arg);
		} else if let Some(long) = token.strip_prefix("--") {


			let (name, value) = match long.split_once('=') {
				Some((name, value)) => (name, Some(value)),
				None => (long, None),
			};
			let ambiguous = VALUE_LONGS
				.iter()
				.chain(FLAG_LONGS)
				.any(|other| other.starts_with(name));
			if !name.is_empty() && "iso-8601".starts_with(name) && !ambiguous {
				out.push(format!("--iso-8601={}", value.unwrap_or(DATE)).into());
			} else {
				if value.is_none()
					&& VALUE_LONGS.iter().filter(|l| l.starts_with(name)).count() == 1
					&& !FLAG_LONGS.iter().any(|l| l.starts_with(name))
					&& !"iso-8601".starts_with(name)
				{
					skip_value = true;
				}
				out.push(arg);
			}
		} else if let Some(cluster) = token.strip_prefix('-').filter(|rest| !rest.is_empty()) {

			let mut rewrote = false;
			for (index, ch) in cluster.char_indices() {
				if ch == 'I' {
					let flags = &cluster[..index];
					let rest = &cluster[index + ch.len_utf8()..];
					if !flags.is_empty() {
						out.push(format!("-{flags}").into());
					}
					let spec = if rest.is_empty() { DATE } else { rest };
					out.push(format!("--iso-8601={spec}").into());
					rewrote = true;
					break;
				}
				if VALUE_SHORTS.contains(&ch) {


					if cluster[index + ch.len_utf8()..].is_empty() {
						skip_value = true;
					}
					break;
				}
			}
			if !rewrote {
				out.push(arg);
			}
		} else {
			out.push(arg);
		}
	}
	out
}


#[derive(Clone, Copy)]
enum BsdAdjustUnit {
	Year,
	Month,
	Week,
	Day,
	Hour,
	Minute,
	Second,
}



#[derive(Clone, Copy)]
enum BsdAdjustment {
	Offset(i64, BsdAdjustUnit),
	Set(i64, BsdAdjustUnit),
}






fn parse_bsd_adjustment(spec: &str) -> Option<BsdAdjustment> {
	let (sign, rest) = match *spec.as_bytes().first()? {
		b'+' => (Some(1), &spec[1..]),
		b'-' => (Some(-1), &spec[1..]),
		_ => (None, spec),
	};
	let mut chars = rest.chars();
	let unit = match chars.next_back()? {
		'y' | 'Y' => BsdAdjustUnit::Year,
		'm' => BsdAdjustUnit::Month,
		'w' | 'W' => BsdAdjustUnit::Week,
		'd' | 'D' => BsdAdjustUnit::Day,
		'H' | 'h' => BsdAdjustUnit::Hour,
		'M' => BsdAdjustUnit::Minute,
		'S' | 's' => BsdAdjustUnit::Second,
		_ => return None,
	};
	let digits = chars.as_str();
	if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
		return None;
	}
	let value: i64 = digits.parse().ok()?;
	Some(match sign {
		Some(sign) => BsdAdjustment::Offset(sign * value, unit),
		None => BsdAdjustment::Set(value, unit),
	})
}


fn apply_bsd_adjustments(mut date: Zoned, adjustments: &[BsdAdjustment]) -> Result<Zoned, String> {
	for adjustment in adjustments {
		date = match *adjustment {
			BsdAdjustment::Offset(value, unit) => {
				let span = Span::new();
				let span = match unit {
					BsdAdjustUnit::Year => span.try_years(value),
					BsdAdjustUnit::Month => span.try_months(value),
					BsdAdjustUnit::Week => span.try_weeks(value),
					BsdAdjustUnit::Day => span.try_days(value),
					BsdAdjustUnit::Hour => span.try_hours(value),
					BsdAdjustUnit::Minute => span.try_minutes(value),
					BsdAdjustUnit::Second => span.try_seconds(value),
				}
				.map_err(|error| format!("invalid adjustment ({error})"))?;
				date
					.checked_add(span)
					.map_err(|error| format!("cannot adjust date ({error})"))?
			},
			BsdAdjustment::Set(value, unit) => {
				let narrow = |unit: char| {
					i8::try_from(value).map_err(|_| format!("invalid adjustment: '{value}{unit}'"))
				};
				let with = date.with();
				let with = match unit {
					BsdAdjustUnit::Year => {

						let year = match value {
							0..=68 => value + 2000,
							69..=99 => value + 1900,
							_ => value,
						};
						let year = i16::try_from(year)
							.map_err(|_| format!("invalid adjustment: '{value}y'"))?;
						with.year(year)
					},
					BsdAdjustUnit::Month => with.month(narrow('m')?),
					BsdAdjustUnit::Week => {
						return Err(format!(
							"unsupported adjustment: '{value}w' (setting the week is not \
							 implemented; use an offset like '+{value}w')"
						));
					},
					BsdAdjustUnit::Day => with.day(narrow('d')?),
					BsdAdjustUnit::Hour => with.hour(narrow('H')?),
					BsdAdjustUnit::Minute => with.minute(narrow('M')?),
					BsdAdjustUnit::Second => with.second(narrow('S')?),
				};
				with
					.build()
					.map_err(|error| format!("cannot adjust date ({error})"))?
			},
		};
	}
	Ok(date)
}






fn parse_bsd_strptime(format: &str, value: &str, now: &Zoned) -> Result<Zoned, String> {
	let convert_error =
		|error: jiff::Error| format!("failed conversion of '{value}' using format '{format}' ({error})");
	let broken = BrokenDownTime::parse(format, value).map_err(convert_error)?;

	if let Ok(timestamp) = broken.to_timestamp() {
		return Ok(timestamp.to_zoned(now.time_zone().clone()));
	}
	let base = now.datetime();
	let date = broken
		.to_date()
		.or_else(|_| {
			jiff::civil::Date::new(
				broken.year().unwrap_or(base.year()),
				broken.month().unwrap_or(base.month()),
				broken.day().unwrap_or(base.day()),
			)
		})
		.map_err(convert_error)?;
	let time = jiff::civil::Time::new(
		broken.hour().unwrap_or(base.hour()),
		broken.minute().unwrap_or(base.minute()),
		broken.second().unwrap_or(base.second()),
		broken.subsec_nanosecond().unwrap_or(base.subsec_nanosecond()),
	)
	.map_err(convert_error)?;
	date
		.to_datetime(time)
		.to_zoned(now.time_zone().clone())
		.map_err(convert_error)
}



pub(crate) struct Date {
	matches: ArgMatches,
}

matches_parser!(Date, uu_app);

#[derive(Debug)]
struct DateError {
	code:    i32,
	message: String,
}

impl DateError {
	fn new(code: i32, message: impl Into<String>) -> Self {
		Self { code, message: message.into() }
	}
}

impl From<std::io::Error> for DateError {
	fn from(error: std::io::Error) -> Self {
		Self::new(1, error.to_string())
	}
}

impl Utility for Date {
	const NAME: &'static str = "date";

	fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		Ok(rewrite_date_argv(argv))
	}

	fn run(self, host: &mut Host) -> i32 {
		match date_main(host, &self.matches) {
			Ok(()) => host.exit_code(),
			Err(error) => {
				host.error(error.message, error.code);
				host.exit_code()
			},
		}
	}
}
fn shell_time_zone(host: &Host) -> TimeZone {
	let Some(value) = host.var("TZ") else {
		return TimeZone::system();
	};
	let value = value.strip_prefix(':').unwrap_or(value);
	if value.is_empty() {
		return TimeZone::UTC;
	}
	TimeZone::get(value)
		.or_else(|_| TimeZone::posix(value))
		.unwrap_or(TimeZone::UTC)
}
fn shell_locale(host: &Host) -> String {
	let locale = host
		.var("LC_ALL")
		.filter(|value| !value.is_empty())
		.or_else(|| host.var("LC_TIME").filter(|value| !value.is_empty()))
		.or_else(|| host.var("LANG").filter(|value| !value.is_empty()))
		.unwrap_or("C");
	locale_default_format(locale).unwrap_or_else(|| "%a %b %e %X %Z %Y".to_string())
}

#[cfg(any(
	target_os = "linux",
	target_vendor = "apple",
	target_os = "freebsd",
	target_os = "netbsd",
	target_os = "openbsd",
	target_os = "dragonfly",
))]
fn locale_default_format(locale: &str) -> Option<String> {
	let locale = CString::new(locale).ok()?;



	unsafe {
		let locale_object =
			libc::newlocale(libc::LC_TIME_MASK, locale.as_ptr(), std::ptr::null_mut());
		if locale_object.is_null() {
			return None;
		}
		let previous = libc::uselocale(locale_object);
		let format_ptr = libc::nl_langinfo(libc::D_T_FMT);
		let format = (!format_ptr.is_null())
			.then(|| CStr::from_ptr(format_ptr).to_string_lossy().into_owned())
			.filter(|format| !format.is_empty());
		libc::uselocale(previous);
		libc::freelocale(locale_object);

		format.map(|mut format| {
			if !format.contains("%Z") && !format.contains("%z") {
				if let Some(position) = format.find("%Y").or_else(|| format.find("%y")) {
					format.insert_str(position, "%Z ");
				} else {
					format.push_str(" %Z");
				}
			}
			format
		})
	}
}

#[cfg(not(any(
	target_os = "linux",
	target_vendor = "apple",
	target_os = "freebsd",
	target_os = "netbsd",
	target_os = "openbsd",
	target_os = "dragonfly",
)))]
fn locale_default_format(_locale: &str) -> Option<String> {
	None
}



#[allow(clippy::cognitive_complexity)]
fn date_main(host: &mut Host, matches: &ArgMatches) -> Result<(), DateError> {
	let bsd_parse_only = matches.get_flag(OPT_BSD_PARSE_ONLY);
	let adjustments: Vec<BsdAdjustment> = matches
		.get_many::<String>(OPT_BSD_ADJUST)
		.into_iter()
		.flatten()
		.map(|spec| {
			parse_bsd_adjustment(spec)
				.ok_or_else(|| DateError::new(1, format!("invalid adjustment: '{spec}'")))
		})
		.collect::<Result<_, _>>()?;



	let mut operands: Vec<&String> = matches
		.get_many::<String>(OPT_FORMAT)
		.map(Iterator::collect)
		.unwrap_or_default();



	let strptime_format = if bsd_parse_only {
		matches.get_one::<String>(OPT_FILE)
	} else {
		None
	};
	let strptime_value = if strptime_format.is_some() {
		if operands.first().is_some_and(|operand| !operand.starts_with('+')) {
			Some(operands.remove(0))
		} else {
			return Err(DateError::new(1, "'-j -f FORMAT' requires a date operand to parse"));
		}
	} else {
		None
	};

	let date_source = if let (Some(format), Some(value)) = (strptime_format, strptime_value) {
		DateSource::Strptime { format: format.clone(), value: value.clone() }
	} else if let Some(date_os) = matches.get_one::<OsString>(OPT_DATE) {

		let date = date_os.to_str().ok_or_else(|| {
			let bytes = date_os.as_encoded_bytes();
			let escaped_str = escape_invalid_bytes(bytes);
			DateError::new(1, format!("invalid date '{escaped_str}'"))
		})?;
		DateSource::Human(date.into())
	} else if let Some(file) = matches.get_one::<String>(OPT_FILE) {
		match file.as_ref() {
			"-" => DateSource::Stdin,
			_ => DateSource::File(file.into()),
		}
	} else if let Some(reference) = matches.get_one::<String>(OPT_REFERENCE) {




		let digits = reference.strip_prefix('-').unwrap_or(reference);
		let numeric = !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit());
		if numeric && !host.resolve(Path::new(reference)).exists() {
			DateSource::Human(format!("@{reference}"))
		} else {
			DateSource::FileMtime(reference.into())
		}
	} else if matches.get_flag(OPT_RESOLUTION) {
		DateSource::Resolution
	} else {
		DateSource::Now
	};


	if operands.len() > 1 {
		return Err(DateError::new(1, format!("extra operand '{}'", operands[1])));
	}

	let format = if let Some(form) = operands.first() {
		if !form.starts_with('+') {


			if !matches!(date_source, DateSource::Human(_) | DateSource::Strptime { .. }) {
				return Err(DateError::new(1, format!("invalid date '{form}'")));
			}


			return Err(DateError::new(
				1,
				format!(
					"the argument {form} lacks a leading '+';\nwhen using an option to specify \
					 date(s), any non-option\nargument must be a format string beginning with '+'"
				),
			));
		}
		Format::Custom(form[1..].to_string())
	} else if let Some(fmt) = matches
		.get_many::<String>(OPT_ISO_8601)
		.map(|mut iter| iter.next().unwrap_or(&DATE.to_string()).as_str().into())
	{
		Format::Iso8601(fmt)
	} else if matches.get_flag(OPT_RFC_EMAIL) {
		Format::Rfc5322
	} else if let Some(fmt) = matches
		.get_one::<String>(OPT_RFC_3339)
		.map(|s| s.as_str().into())
	{
		Format::Rfc3339(fmt)
	} else if matches.get_flag(OPT_RESOLUTION) {
		Format::Resolution
	} else {
		Format::Default
	};

	let utc = matches.get_flag(OPT_UNIVERSAL);
	let debug_mode = matches.get_flag(OPT_DEBUG);


	let local_time_zone = shell_time_zone(host);
	let now = Timestamp::now().to_zoned(if utc {
		TimeZone::UTC
	} else {
		local_time_zone.clone()
	});
	if let Some(input) = matches.get_one::<String>(OPT_SET) {
		let mut error = host.stderr_clone();
		let date = parse_date(
			input,
			&now,
			DebugOptions::new(debug_mode, true),
			&mut error,
		)
		.map_err(|(input, _)| DateError::new(1, format!("invalid date '{input}'")))?;
		return set_system_datetime(date);
	}

	let default_format = shell_locale(host);

	let settings = Settings { utc, format, date_source, debug: debug_mode, default_format };


	let cancel = host.cancel_flag();
	let mut had_error = false;
	let mut debug_stderr = host.stderr_clone();
	let mut stdout = host.stdout_writer();
	let reader_stderr = host.stderr_clone();
	let dates: Box<dyn Iterator<Item = _>> = match &settings.date_source {
		DateSource::Human(input) => {

			let input = strip_parenthesized_comments(input);
			let input = input.trim();



			let is_empty_or_whitespace = input.is_empty();




			let is_military_j = input.eq_ignore_ascii_case("j");






			let military_tz_with_offset = parse_military_timezone_with_offset(input);







			let is_pure_digits =
				!input.is_empty() && input.len() <= 4 && input.chars().all(|c| c.is_ascii_digit());

			let date = if is_empty_or_whitespace || is_military_j {

				let date_part =
					strtime::format("%F", &now).unwrap_or_else(|_| String::from("1970-01-01"));
				let offset = if settings.utc {
					String::from("+00:00")
				} else {
					strtime::format("%:z", &now).unwrap_or_default()
				};
				let composed = if offset.is_empty() {
					format!("{date_part} 00:00")
				} else {
					format!("{date_part} 00:00 {offset}")
				};
				if settings.debug {
					let _ = writeln!(
						host.stderr,
						"date: warning: using midnight as starting time: 00:00:00"
					);
				}
				parse_date(
					composed,
					&now,
					DebugOptions::new(settings.debug, false),
					&mut debug_stderr,
				)
			} else if let Some((total_hours, day_delta)) = military_tz_with_offset {








				let format_date_with_epoch_fallback = |date: Result<Zoned, _>| -> String {
					date
						.and_then(|d| strtime::format("%F", &d))
						.unwrap_or_else(|_| String::from("1970-01-01"))
				};
				let date_part = match day_delta {
					DayDelta::Same => format_date_with_epoch_fallback(Ok(now.clone())),
					DayDelta::Next => format_date_with_epoch_fallback(now.tomorrow()),
					DayDelta::Previous => format_date_with_epoch_fallback(now.yesterday()),
				};
				let composed = format!("{date_part} {total_hours:02}:00:00 +00:00");
				parse_date(
					composed,
					&now,
					DebugOptions::new(settings.debug, false),
					&mut debug_stderr,
				)
			} else if is_pure_digits {

				let (hh_opt, mm_opt) = if input.len() <= 2 {
					(input.parse::<u32>().ok(), Some(0u32))
				} else {
					let (h, m) = input.split_at(input.len() - 2);
					(h.parse::<u32>().ok(), m.parse::<u32>().ok())
				};

				if let (Some(hh), Some(mm)) = (hh_opt, mm_opt) {


					let date_part =
						strtime::format("%F", &now).unwrap_or_else(|_| String::from("1970-01-01"));

					let offset = if settings.utc {
						String::from("+00:00")
					} else {
						strtime::format("%:z", &now).unwrap_or_default()
					};
					let composed = if offset.is_empty() {
						format!("{date_part} {hh:02}:{mm:02}")
					} else {
						format!("{date_part} {hh:02}:{mm:02} {offset}")
					};
					parse_date(
						composed,
						&now,
						DebugOptions::new(settings.debug, false),
						&mut debug_stderr,
					)
				} else {

					parse_date(
						input,
						&now,
						DebugOptions::new(settings.debug, true),
						&mut debug_stderr,
					)
				}
			} else {
				parse_date(
					input,
					&now,
					DebugOptions::new(settings.debug, true),
					&mut debug_stderr,
				)
			};

			let iter = std::iter::once(date);
			Box::new(iter)
		},
		DateSource::Stdin => parse_dates_from_reader(
			&mut host.stdin,
			&now,
			DebugOptions::new(settings.debug, true),
			reader_stderr.clone(),
		),
		DateSource::File(path) => {

			let resolved = host.resolve(path);
			if resolved.is_dir() {
				return Err(DateError::new(
					2,
					format!("expected file, got directory {}", path.quote()),
				));
			}
			let file = File::open(&resolved).map_err(|error| {
				DateError::new(1, format!("{}: {error}", path.as_os_str().maybe_quote()))
			})?;
			parse_dates_from_reader(
				file,
				&now,
				DebugOptions::new(settings.debug, true),
				reader_stderr,
			)
		},
		DateSource::FileMtime(path) => {

			let metadata = std::fs::metadata(host.resolve(path)).map_err(|error| {
				DateError::new(1, format!("{}: {error}", path.as_os_str().maybe_quote()))
			})?;
			let mtime = metadata.modified()?;
			let ts = Timestamp::try_from(mtime)
				.map_err(|_| DateError::new(1, "cannot set date".to_string()))?;
			let date = ts.to_zoned(local_time_zone.clone());
			let iter = std::iter::once(Ok(date));
			Box::new(iter)
		},
		DateSource::Resolution => {
			let resolution = get_clock_resolution();
			let date = resolution.to_zoned(local_time_zone.clone());
			let iter = std::iter::once(Ok(date));
			Box::new(iter)
		},
		DateSource::Strptime { format, value } => {
			let date = parse_bsd_strptime(format, value, &now)
				.map_err(|message| DateError::new(1, message))?;
			Box::new(std::iter::once(Ok(date)))
		},
		DateSource::Now => {
			let iter = std::iter::once(Ok(now.clone()));
			Box::new(iter)
		},
	};

	let format_string = make_format_string(&settings);


	let config = Config::new().custom(PosixCustom::new()).lenient(true);
	for date in dates {

		if cancel.load(std::sync::atomic::Ordering::Relaxed) {
			break;
		}
		match date {
			Ok(date) => {

				let date = if adjustments.is_empty() {
					date
				} else {
					match apply_bsd_adjustments(date, &adjustments) {
						Ok(date) => date,
						Err(message) => {
							let _ = stdout.flush();
							return Err(DateError::new(1, message));
						},
					}
				};
				let date = if settings.utc {
					date.with_time_zone(TimeZone::UTC)
				} else {
					date
				};
				match format_date(&date, format_string, &config) {
					Ok(s) => writeln!(stdout, "{s}")
						.map_err(|e| DateError::new(1, format!("write error: {e}")))?,
					Err(e) => {
						let _ = stdout.flush();
						return Err(DateError::new(
							1,
							format!("invalid format '{format_string}' ({e})"),
						));
					},
				}
			},
			Err((input, _err)) => {
				let _ = stdout.flush();


				let _ = writeln!(host.stderr, "date: invalid date '{input}'");
				had_error = true;
			},
		}
	}

	stdout
		.flush()
		.map_err(|e| DateError::new(1, format!("write error: {e}")))?;
	drop(stdout);

	if had_error {
		host.fail(1);
	}
	Ok(())
}
fn uu_app() -> Command {
	Command::new("date")
		.version("0.8.0")
		.about("Print or set the system date and time")

		.override_usage(format_usage(
			"date [OPTION]... [+FORMAT]...\ndate [OPTION]... [MMDDhhmm[[CC]YY][.ss]]",
		))
		.after_help(FORMAT_HELP)
		.infer_long_args(true)
		.arg(
			Arg::new(OPT_DATE)
				.short('d')
				.long(OPT_DATE)
				.value_name("STRING")
				.allow_hyphen_values(true)
				.overrides_with(OPT_DATE)
				.value_parser(clap::value_parser!(OsString))
				.help("display time described by STRING, not 'now'"),
		)
		.arg(
			Arg::new(OPT_FILE)
				.short('f')
				.long(OPT_FILE)
				.value_name("DATEFILE")
				.value_hint(clap::ValueHint::FilePath)
				.conflicts_with(OPT_DATE)
				.help(
					"like --date; once for each line of DATEFILE\n(BSD: with -j, the strptime(3) \
					 input format for the date operand)",
				),
		)
		.arg(
			Arg::new(OPT_ISO_8601)
				.short('I')
				.long(OPT_ISO_8601)
				.value_name("FMT")
				.value_parser(ShortcutValueParser::new([DATE, HOURS, MINUTES, SECONDS, NS]))




				.num_args(0..=1)
				.require_equals(true)
				.default_missing_value(OPT_DATE)
				.help(
					"output date/time in ISO 8601 format.\nFMT='date' for date only (the \
					 default),\n'hours', 'minutes', 'seconds', or 'ns'\nfor date and time to the \
					 indicated precision.\nExample: 2006-08-14T02:34:56-06:00",
				),
		)
		.arg(
			Arg::new(OPT_RESOLUTION)
				.long(OPT_RESOLUTION)
				.conflicts_with_all([OPT_DATE, OPT_FILE])
				.overrides_with(OPT_RESOLUTION)
				.help("output the available resolution of timestamps\nExample: 0.000000001")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_RFC_EMAIL)
				.short('R')
				.long(OPT_RFC_EMAIL)
				.alias(OPT_RFC_2822)
				.alias(OPT_RFC_822)
				.overrides_with(OPT_RFC_EMAIL)
				.help(
					"output date and time in RFC 5322 format.\nExample: Mon, 14 Aug 2006 02:34:56 -0600",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_RFC_3339)
				.long(OPT_RFC_3339)
				.value_name("FMT")
				.value_parser(ShortcutValueParser::new([DATE, SECONDS, NS]))
				.help(
					"output date/time in RFC 3339 format.\nFMT='date', 'seconds', or 'ns'\nfor date \
					 and time to the indicated precision.\nExample: 2006-08-14 02:34:56-06:00",
				),
		)
		.arg(
			Arg::new(OPT_DEBUG)
				.long(OPT_DEBUG)
				.help("annotate the parsed date, and warn about questionable usage to stderr")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_REFERENCE)
				.short('r')
				.long(OPT_REFERENCE)
				.value_name("FILE")
				.value_hint(clap::ValueHint::AnyPath)
				.allow_hyphen_values(true)
				.conflicts_with_all([OPT_DATE, OPT_FILE, OPT_RESOLUTION])
				.help(
					"display the last modification time of FILE\n(BSD: when FILE is numeric and \
					 no such file exists,\ndisplay the date at that many seconds since the epoch)",
				),
		)
		.arg(
			Arg::new(OPT_SET)
				.short('s')
				.long(OPT_SET)
				.value_name("STRING")
				.allow_hyphen_values(true)
				.help("set time described by STRING"),
		)
		.arg(
			Arg::new(OPT_UNIVERSAL)
				.short('u')
				.long(OPT_UNIVERSAL)
				.visible_alias(OPT_UNIVERSAL_2)
				.alias("uct")
				.overrides_with(OPT_UNIVERSAL)
				.help("print or set Coordinated Universal Time (UTC)")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_BSD_PARSE_ONLY)
				.short('j')
				.help(
					"BSD compatibility: do not try to set the system clock;\nwith -f, parse the \
					 date operand using the strptime(3)\nformat given to -f",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_BSD_ADJUST)
				.short('v')
				.value_name("[+|-]VAL[ymwdHMS]")
				.allow_hyphen_values(true)
				.action(ArgAction::Append)
				.help(
					"BSD compatibility: adjust ('+'/'-') or set (no sign) the\ndisplayed date; \
					 may be given multiple times, applied in order",
				),
		)
		.arg(Arg::new(OPT_FORMAT).num_args(0..))
}


const FORMAT_HELP: &str = "\
FORMAT controls the output.  Interpreted sequences are:
  %%     a literal %
  %a     locale's abbreviated weekday name (e.g., Sun)
  %A     locale's full weekday name (e.g., Sunday)
  %b     locale's abbreviated month name (e.g., Jan)
  %B     locale's full month name (e.g., January)
  %c     locale's date and time (e.g., Thu Mar  3 23:05:25 2005)
  %C     century; like %Y, except omit last two digits (e.g., 20)
  %d     day of month (e.g., 01)
  %D     date; same as %m/%d/%y
  %e     day of month, space padded; same as %_d
  %F     full date; same as %Y-%m-%d
  %g     last two digits of year of ISO week number (see %G)
  %G     year of ISO week number (see %V); normally useful only with %V
  %h     same as %b
  %H     hour (00..23)
  %I     hour (01..12)
  %j     day of year (001..366)
  %k     hour, space padded ( 0..23); same as %_H
  %l     hour, space padded ( 1..12); same as %_I
  %m     month (01..12)
  %M     minute (00..59)
  %n     a newline
  %N     nanoseconds (000000000..999999999)
  %p     locale's equivalent of either AM or PM; blank if not known
  %P     like %p, but lower case
  %q     quarter of year (1..4)
  %r     locale's 12-hour clock time (e.g., 11:11:04 PM)
  %R     24-hour hour and minute; same as %H:%M
  %s     seconds since 1970-01-01 00:00:00 UTC
  %S     second (00..60)
  %t     a tab
  %T     time; same as %H:%M:%S
  %u     day of week (1..7); 1 is Monday
  %U     week number of year, with Sunday as first day of week (00..53)
  %V     ISO week number, with Monday as first day of week (01..53)
  %w     day of week (0..6); 0 is Sunday
  %W     week number of year, with Monday as first day of week (00..53)
  %x     locale's date representation (e.g., 03/03/2005)
  %X     locale's time representation (e.g., 23:30:30)
  %y     last two digits of year (00..99)
  %Y     year
  %z     +hhmm numeric time zone (e.g., -0400)
  %:z    +hh:mm numeric time zone (e.g., -04:00)
  %::z   +hh:mm:ss numeric time zone (e.g., -04:00:00)
  %:::z  numeric time zone with : to necessary precision (e.g., -04, +05:30)
  %Z     alphabetic time zone abbreviation (e.g., EDT)

By default, date pads numeric fields with zeroes.
The following optional flags may follow '%':
  - (hyphen) do not pad the field
  _ (underscore) pad with spaces
  0 (zero) pad with zeros
  ^ use upper case if possible
  # use opposite case if possible
After any flags comes an optional field width, as a decimal number;
then an optional modifier, which is either
  E to use the locale's alternate representations if available, or
  O to use the locale's alternate numeric symbols if available.

Examples:
  Convert seconds since the epoch (1970-01-01 UTC) to a date
    date --date='@2147483647'
  Show the time on the west coast of the US (use tzselect(1) to find TZ)
    TZ='America/Los_Angeles' date";



fn format_date(
	date: &Zoned,
	format_string: &str,
	config: &Config<PosixCustom>,
) -> Result<String, String> {

	if let Some(result) =
		format_modifiers::format_with_modifiers_if_present(date, format_string, config)
	{
		return result.map_err(|e| e.to_string());
	}

	let broken_down = BrokenDownTime::from(date);
	broken_down
		.to_string_with_config(config, format_string)
		.map_err(|e| e.to_string())
}


fn make_format_string(settings: &Settings) -> &str {
	match &settings.format {
		Format::Iso8601(fmt) => match fmt {
			Iso8601Format::Date => "%F",
			Iso8601Format::Hours => "%FT%H%:z",
			Iso8601Format::Minutes => "%FT%H:%M%:z",
			Iso8601Format::Seconds => "%FT%T%:z",
			Iso8601Format::Ns => "%FT%T,%N%:z",
		},
		Format::Rfc5322 => "%a, %d %h %Y %T %z",
		Format::Rfc3339(fmt) => match fmt {
			Rfc3339Format::Date => "%F",
			Rfc3339Format::Seconds => "%F %T%:z",
			Rfc3339Format::Ns => "%F %T.%N%:z",
		},
		Format::Resolution => "%s.%N",
		Format::Custom(fmt) => fmt,
		Format::Default => &settings.default_format,
	}
}







static FIXED_OFFSET_ABBREVIATIONS: &[(&str, i32)] = &[
	("UTC", 0),
	("GMT", 0),
	("MEST", 7200),

	("PST", -28800),
	("PDT", -25200),
	("MST", -25200),
	("MDT", -21600),
	("CST", -21600),
	("CDT", -18000),
	("EST", -18000),
	("EDT", -14400),

	("IST", 19800),

	("AWST", 28800),
	("ACST", 34200),
	("ACDT", 37800),
	("AEST", 36000),
	("AEDT", 39600),

	("MEZ", 3600),
	("MESZ", 7200),

	("KST", 32400),
];


static TZ_ABBREV_CACHE: LazyLock<HashMap<String, String>> = LazyLock::new(build_tz_abbrev_map);




fn build_tz_abbrev_map() -> HashMap<String, String> {
	let mut map = HashMap::new();
	let tzdb = TimeZoneDatabase::bundled();

	for tz_name in tzdb.available() {
		let tz_str = tz_name.as_str();


		if let Some(last_part) = tz_str.split('/').next_back() {
			let potential_abbrev = last_part.to_uppercase();

			if potential_abbrev.len() >= 2
				&& potential_abbrev.len() <= 5
				&& potential_abbrev.chars().all(|c| c.is_ascii_uppercase())
			{
				map.entry(potential_abbrev)
					.or_insert_with(|| tz_str.to_string());
			}
		}
	}

	map
}



fn tz_abbrev_to_iana(abbrev: &str) -> Option<&str> {
	TZ_ABBREV_CACHE.get(abbrev).map(String::as_str)
}







fn try_parse_with_abbreviation<S: AsRef<str>>(date_str: S, now: &Zoned) -> Option<Zoned> {
	let s = date_str.as_ref();



	if let Some(last_word) = s.split_whitespace().last() {

		if last_word.len() >= 2
			&& last_word.len() <= 5
			&& last_word.chars().all(|c| c.is_ascii_uppercase())
		{
			let tz = if let Some(&(_, offset_secs)) = FIXED_OFFSET_ABBREVIATIONS
				.iter()
				.find(|(abbr, _)| *abbr == last_word)
			{
				Offset::from_seconds(offset_secs).ok().map(TimeZone::fixed)
			} else {
				tz_abbrev_to_iana(last_word).and_then(|name| TimeZone::get(name).ok())
			};

			if let Some(tz) = tz {
				let date_part = s.trim_end_matches(last_word).trim();

				if let Ok(parsed) = parse_datetime::parse_datetime_at_date(now.clone(), date_part) {
					let dt = parsed.datetime();
					if let Ok(zoned) = dt.to_zoned(tz) {
						return Some(zoned);
					}
				}
			}
		}
	}


	None
}





fn parse_dates_from_reader<'a, R: Read + 'a, W: Write + 'a>(
	reader: R,
	now: &'a Zoned,
	dbg_opts: DebugOptions,
	mut error: W,
) -> Box<dyn Iterator<Item = Result<Zoned, (String, parse_datetime::ParseDateTimeError)>> + 'a> {
	let lines = BufReader::new(reader).lines();
	Box::new(
		lines
			.map_while(Result::ok)
			.map(move |s| parse_date(s, now, dbg_opts, &mut error)),
	)
}



fn parse_date<S: AsRef<str> + Clone>(
	s: S,
	now: &Zoned,
	dbg_opts: DebugOptions,
	error: &mut dyn Write,
) -> Result<Zoned, (String, parse_datetime::ParseDateTimeError)> {
	let input_str = s.as_ref();

	if dbg_opts.debug {
		let _ = writeln!(error, "date: input string: {input_str}");
	}


	if let Some(zoned) = try_parse_with_abbreviation(input_str, now) {
		if dbg_opts.debug {
			let err = &mut *error;
			let _ = writeln!(
				err,
				"date: parsed date part: (Y-M-D) {}",
				strtime::format("%Y-%m-%d", &zoned).unwrap_or_default()
			);
			let _ = writeln!(
				err,
				"date: parsed time part: {}",
				strtime::format("%H:%M:%S", &zoned).unwrap_or_default()
			);
			let tz_display = zoned.time_zone().iana_name().unwrap_or("system default");
			let _ = writeln!(err, "date: input timezone: {tz_display}");
		}
		return Ok(zoned);
	}

	match parse_datetime::parse_datetime_at_date(now.clone(), input_str) {


		Ok(date) => {
			let result = date.timestamp().to_zoned(now.time_zone().clone());
			if dbg_opts.debug {

				let err = &mut *error;
				let _ = writeln!(
					err,
					"date: parsed date part: (Y-M-D) {}",
					strtime::format("%Y-%m-%d", &result).unwrap_or_default()
				);
				let _ = writeln!(
					err,
					"date: parsed time part: {}",
					strtime::format("%H:%M:%S", &result).unwrap_or_default()
				);


				let _ = writeln!(err, "date: input timezone: system default");




				if dbg_opts.warn_midnight && !input_str.contains(':') && !input_str.contains('@') {

					let time_str = strtime::format("%H:%M:%S", &result).unwrap_or_default();
					if time_str == "00:00:00" {
						let _ = writeln!(err, "date: warning: using midnight as starting time: 00:00:00");
					}
				}
			}
			Ok(result)
		},
		Err(e) => Err((input_str.into(), e)),
	}
}



#[cfg(not(any(unix, windows)))]
fn get_clock_resolution() -> Timestamp {
	unimplemented!("getting clock resolution not implemented (unsupported target)");
}

#[cfg(all(unix, not(target_os = "redox")))]







fn get_clock_resolution() -> Timestamp {
	use rustix::time::{ClockId, clock_getres};

	let timespec = clock_getres(ClockId::Realtime);

	#[allow(clippy::unnecessary_cast, reason = "needed for 32 bit target")]
	Timestamp::constant(timespec.tv_sec as _, timespec.tv_nsec as _)
}
#[cfg(unix)]
fn set_system_datetime(date: Zoned) -> Result<(), DateError> {
	use rustix::time::{ClockId, Timespec, clock_settime};

	let timestamp = date.timestamp();
	let timespec = Timespec {
		tv_sec:  timestamp.as_second() as _,
		tv_nsec: timestamp.subsec_nanosecond() as _,
	};
	clock_settime(ClockId::Realtime, timespec)
		.map_err(std::io::Error::from)
		.map_err(|error| DateError::new(1, format!("cannot set date: {error}")))
}

#[cfg(not(unix))]
fn set_system_datetime(_date: Zoned) -> Result<(), DateError> {
	Err(DateError::new(
		1,
		"--set is not supported by the in-process builtin",
	))
}


#[cfg(all(unix, target_os = "redox"))]
fn get_clock_resolution() -> Timestamp {



	Timestamp::constant(0, 1)
}

#[cfg(windows)]
fn get_clock_resolution() -> Timestamp {




	Timestamp::constant(0, 100)
}



pub(crate) fn date_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Date, SE>()
}
