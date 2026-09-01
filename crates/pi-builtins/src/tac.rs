



use std::{
	ffi::{OsStr, OsString},
	fs::File,
	io::{BufWriter, Read, Write},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};
use memchr::memmem;
use memmap2::Mmap;
use thiserror::Error;
use uucore::display::Quotable;

use crate::host::{Host, Utility, format_usage, matches_parser, util};

mod options {
	pub static BEFORE: &str = "before";
	pub static REGEX: &str = "regex";
	pub static SEPARATOR: &str = "separator";
	pub static FILE: &str = "file";
}

#[derive(Debug, Error)]
enum TacError {

	#[error("invalid regular expression: {0}")]
	InvalidRegex(regex::Error),

	#[error("failed to open {} for reading: {}", .0.quote(), strip_errno(.1))]
	Open(OsString, std::io::Error),

	#[error("{}: read error: {}", .0.maybe_quote(), strip_errno(.1))]
	Read(OsString, std::io::Error),

	#[error("failed to write to stdout: {}", strip_errno(.0))]
	Write(std::io::Error),
}

fn strip_errno(error: &std::io::Error) -> String {
	let mut message = error.to_string();
	if let Some(position) = message.find(" (os error ") {
		message.truncate(position);
	}
	message
}


pub(crate) struct Tac {
	matches: ArgMatches,
}

matches_parser!(Tac, app);

impl Utility for Tac {
	const NAME: &'static str = "tac";

	fn run(self, host: &mut Host) -> i32 {
		run_matches(&self.matches, host)
	}
}

#[allow(dead_code, reason = "called by the separately feature-gated tail builtin")]


pub(crate) fn run_argv(argv: Vec<std::ffi::OsString>, host: &mut Host) -> i32 {
	match <Tac as clap::Parser>::try_parse_from(argv) {
		Ok(parsed) => parsed.run(host),
		Err(error) => {
			let rendered = error.to_string();
			if error.use_stderr() {
				let _ = write!(host.stderr, "{rendered}");
				i32::from(Tac::USAGE_ERROR)
			} else {
				let _ = write!(host.stdout, "{rendered}");
				0
			}
		},
	}
}

fn run_matches(matches: &ArgMatches, host: &mut Host) -> i32 {
	match tac_main(matches, host) {
		Ok(()) => host.exit_code(),
		Err(error) => {
			show(host, &error);
			1
		},
	}
}

fn tac_main(matches: &ArgMatches, host: &mut Host) -> Result<(), TacError> {
	let before = matches.get_flag(options::BEFORE);
	let regex = matches.get_flag(options::REGEX);
	let raw_separator = matches
		.get_one::<OsString>(options::SEPARATOR)
		.map_or(OsStr::new("\n"), |separator| separator.as_os_str());

	let separator = if raw_separator.is_empty() { OsStr::new("\0") } else { raw_separator };
	let files: Vec<OsString> = matches
		.get_many::<OsString>(options::FILE)
		.map_or_else(|| vec![OsString::from("-")], |files| files.cloned().collect());

	tac(&files, before, regex, separator, host)
}


fn app() -> Command {
	Command::new(Tac::NAME)
		.version("0.8.0")
		.override_usage(format_usage("tac [OPTION]... [FILE]..."))
		.about("Write each file to standard output, last line first.")
		.infer_long_args(true)
		.arg(
			Arg::new(options::BEFORE)
				.short('b')
				.long(options::BEFORE)
				.help("attach the separator before instead of after")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::REGEX)
				.short('r')
				.long(options::REGEX)
				.help("interpret the sequence as a regular expression")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::SEPARATOR)
				.short('s')
				.long(options::SEPARATOR)
				.help("use STRING as the separator instead of newline")
				.value_parser(clap::value_parser!(OsString))
				.value_name("STRING"),
		)
		.arg(
			Arg::new(options::FILE)
				.hide(true)
				.action(ArgAction::Append)
				.value_parser(clap::value_parser!(OsString))
				.value_hint(clap::ValueHint::FilePath),
		)
}





fn show(host: &mut Host, error: &TacError) {
	let _ = writeln!(host.stderr, "{}: {error}", Tac::NAME);
	host.fail(1);
}


fn buffer_tac_regex(
	data: &[u8],
	pattern: &regex::bytes::Regex,
	before: bool,
	host: &mut Host,
) -> std::io::Result<()> {
	let mut out = BufWriter::new(&mut host.stdout);



	let mut this_line_end = data.len();


	let mut following_line_start = data.len();

	for i in (0..data.len()).rev() {
		if let Some(match_) = pattern.find_at(&data[..this_line_end], i)
			&& match_.start() == i
		{
			this_line_end = i;
			let separator_len = match_.end() - match_.start();
			if before {
				out.write_all(&data[i..following_line_start])?;
				following_line_start = i;
			} else {
				out.write_all(&data[i + separator_len..following_line_start])?;
				following_line_start = i + separator_len;
			}
		}
	}

	out.write_all(&data[..following_line_start])?;
	out.flush()
}


fn buffer_tac(data: &[u8], before: bool, separator: &OsStr, host: &mut Host) -> std::io::Result<()> {
	let mut out = BufWriter::new(&mut host.stdout);
	let separator_len = separator.len();
	let mut following_line_start = data.len();

	for i in memmem::rfind_iter(data, separator.as_encoded_bytes()) {
		if before {
			out.write_all(&data[i..following_line_start])?;
			following_line_start = i;
		} else {
			out.write_all(&data[i + separator_len..following_line_start])?;
			following_line_start = i + separator_len;
		}
	}

	out.write_all(&data[..following_line_start])?;
	out.flush()
}






fn translate_regex_flavor(bytes: &[u8]) -> String {
	let mut result = Vec::new();
	let mut i = 0;
	let mut inside_brackets = false;
	let mut prev_was_backslash = false;
	let mut last_byte: Option<u8> = None;

	while let Some(byte) = bytes.get(i) {
		let is_escaped = prev_was_backslash;
		prev_was_backslash = false;

		match byte {
			_ if inside_brackets && !byte.is_ascii() => {
				i += 1;
				continue;
			},
			b'\\' if !inside_brackets && !is_escaped => {
				if let Some(next) = bytes.get(i + 1)
					&& matches!(next, b'(' | b')' | b'|' | b'{' | b'}')
				{
					result.push(*next);
					last_byte = Some(*next);
					i += 2;
					continue;
				}

				result.push(b'\\');
				last_byte = Some(b'\\');
				prev_was_backslash = true;
			},
			b'[' => {
				inside_brackets = true;
				result.push(*byte);
				last_byte = Some(*byte);
			},
			b']' => {
				inside_brackets = false;
				result.push(*byte);
				last_byte = Some(*byte);
			},
			b'(' | b')' | b'|' | b'{' | b'}' if !inside_brackets && !is_escaped => {
				result.push(b'\\');
				result.push(*byte);
				last_byte = Some(*byte);
			},
			b'^' if !inside_brackets && !is_escaped => {
				let is_anchor_position = result.is_empty() || matches!(last_byte, Some(b'(' | b'|'));
				if !is_anchor_position {
					result.push(b'\\');
				}
				result.push(*byte);
				last_byte = Some(*byte);
			},
			b'$' if !inside_brackets && !is_escaped => {
				let next_is_anchor_position = match bytes.get(i + 1) {
					None => true,
					Some(b')' | b'|') => true,
					Some(b'\\') => matches!(bytes.get(i + 2), Some(b')' | b'|')),
					_ => false,
				};
				if !next_is_anchor_position {
					result.push(b'\\');
				}
				result.push(*byte);
				last_byte = Some(*byte);
			},
			_ if !byte.is_ascii() => {
				let _ = write!(result, r"(?-u:\x{byte:02x})");
				last_byte = None;
			},
			_ => {
				result.push(*byte);
				last_byte = Some(*byte);
			},
		}

		i += 1;
	}

	String::from_utf8(result).expect("produces ASCII bytes")
}

fn tac(
	filenames: &[OsString],
	before: bool,
	regex: bool,
	separator: &OsStr,
	host: &mut Host,
) -> Result<(), TacError> {
	let maybe_pattern = if regex {
		Some(
			regex::bytes::RegexBuilder::new(&translate_regex_flavor(separator.as_encoded_bytes()))
				.multi_line(true)
				.build()
				.map_err(TacError::InvalidRegex)?,
		)
	} else {
		None
	};

	for filename in filenames {
		let mmap;
		let buffer;
		let data: &[u8] = if filename == "-" {
			let mut contents = Vec::new();
			match host.stdin.read_to_end(&mut contents) {
				Ok(_) => {
					buffer = contents;
					&buffer
				},
				Err(error) => {
					show(host, &TacError::Read(OsString::from("stdin"), error));
					continue;
				},
			}
		} else {
			let mut file = match host.open_read(filename) {
				Ok(file) => file,
				Err(error) => {
					show(host, &TacError::Open(filename.clone(), error));
					continue;
				},
			};

			if let Some(mapping) = try_mmap_file(&file) {
				mmap = mapping;
				&mmap
			} else {
				let mut contents = Vec::new();
				match file.read_to_end(&mut contents) {
					Ok(_) => {
						buffer = contents;
						&buffer
					},
					Err(error) => {
						show(host, &TacError::Read(filename.clone(), error));
						continue;
					},
				}
			}
		};

		let result = match &maybe_pattern {
			Some(pattern) => buffer_tac_regex(data, pattern, before, host),
			None => buffer_tac(data, before, separator, host),
		};
		if let Err(error) = result {
			return Err(TacError::Write(error));
		}
	}
	Ok(())
}

fn try_mmap_file(file: &File) -> Option<Mmap> {


	unsafe { Mmap::map(file).ok() }
}


pub(crate) fn tac_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Tac, SE>()
}




