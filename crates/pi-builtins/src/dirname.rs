



use std::{borrow::Cow, ffi::OsString, io::Write};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};
use uucore::{display::Quotable, line_ending::LineEnding};

use crate::host::{Host, Utility, format_usage, matches_parser, os_bytes, util};

mod options {
	pub const ZERO: &str = "zero";
	pub const DIR: &str = "dir";
}


pub(crate) struct Dirname {
	matches: ArgMatches,
}

matches_parser!(Dirname, app);

impl Utility for Dirname {
	const NAME: &'static str = "dirname";

	fn run(self, host: &mut Host) -> i32 {
		let dirnames = self
			.matches
			.get_many::<OsString>(options::DIR)
			.unwrap_or_default()
			.collect::<Vec<_>>();

		if dirnames.is_empty() {
			host.error("missing operand", 1);
			return 1;
		}

		let line_ending = LineEnding::from_zero_flag(self.matches.get_flag(options::ZERO));
		for path in dirnames {
			let Some(path_bytes) = os_bytes(path.as_os_str()) else {
				host.error(
					format!(
						"invalid UTF-8 input {} encountered when converting to bytes on a platform that doesn't expose byte arguments",
						path.quote()
					),
					1,
				);
				return 1;
			};
			let result = dirname_string_manipulation(path_bytes);

			if host.stdout.write_all(&result).is_err()
				|| write!(host.stdout, "{line_ending}").is_err()
			{
				return 1;
			}
		}
		if host.stdout.flush().is_err() {
			return 1;
		}
		0
	}
}





















fn dirname_string_manipulation(path_bytes: &[u8]) -> Cow<'_, [u8]> {
	if path_bytes.is_empty() {
		return Cow::Borrowed(b".");
	}

	let mut bytes = path_bytes;


	let all_slashes = bytes.iter().all(|&b| b == b'/');
	if all_slashes {
		return Cow::Borrowed(b"/");
	}

	while bytes.len() > 1 && bytes.ends_with(b"/") {
		bytes = &bytes[..bytes.len() - 1];
	}


	if bytes.ends_with(b".") && bytes.len() >= 2 {
		let dot_pos = bytes.len() - 1;
		if bytes[dot_pos - 1] == b'/' {

			let mut slash_start = dot_pos - 1;
			while slash_start > 0 && bytes[slash_start - 1] == b'/' {
				slash_start -= 1;
			}

			if slash_start == 0 {

				return if path_bytes.starts_with(b"/") {
					Cow::Borrowed(b"/")
				} else {
					Cow::Borrowed(b".")
				};
			}
			return Cow::Borrowed(&bytes[..slash_start]);
		}
	}


	if let Some(last_slash_pos) = bytes.iter().rposition(|&b| b == b'/') {

		let mut result = &bytes[..last_slash_pos];


		while result.len() > 1 && result.ends_with(b"/") {
			result = &result[..result.len() - 1];
		}

		if result.is_empty() {
			return Cow::Borrowed(b"/");
		}

		return Cow::Borrowed(result);
	}


	Cow::Borrowed(b".")
}


fn app() -> Command {
	Command::new(Dirname::NAME)
		.about("Strip last component from file name")
		.version("0.8.0")
		.override_usage(format_usage("dirname [OPTION] NAME..."))
		.args_override_self(true)
		.infer_long_args(true)
		.after_help(
			"Output each NAME with its last non-slash component and trailing slashes\n  removed; if \
			 NAME contains no /'s, output '.' (meaning the current directory).",
		)
		.arg(
			Arg::new(options::ZERO)
				.long(options::ZERO)
				.short('z')
				.help("separate output with NUL rather than newline")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::DIR)
				.hide(true)
				.action(ArgAction::Append)
				.value_hint(clap::ValueHint::AnyPath)
				.value_parser(clap::value_parser!(OsString)),
		)
}


pub(crate) fn dirname_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Dirname, SE>()
}


