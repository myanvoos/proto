//! `tac` builtin: write each file to standard output, last line first.
//!
//! Ported from uutils coreutils 0.8.0.

use std::{
	ffi::{OsStr, OsString},
	io::{BufWriter, Read, Seek, SeekFrom, Write},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};
use memchr::memmem;
use thiserror::Error;
use uucore::display::Quotable;

use crate::host::{Host, Utility, format_usage, matches_parser, strip_errno, util};

mod options {
	pub static BEFORE: &str = "before";
	pub static REGEX: &str = "regex";
	pub static SEPARATOR: &str = "separator";
	pub static FILE: &str = "file";
}

#[derive(Debug, Error)]
enum TacError {
	/// A regular expression given by the user is invalid.
	#[error("invalid regular expression: {0}")]
	InvalidRegex(regex::Error),
	/// An error opening a file for reading.
	#[error("failed to open {} for reading: {}", .0.quote(), strip_errno(.1))]
	Open(OsString, std::io::Error),
	/// An error reading the contents of a file or stdin.
	#[error("{}: read error: {}", .0.maybe_quote(), strip_errno(.1))]
	Read(OsString, std::io::Error),
	/// An error writing the reversed contents of a file or stdin.
	#[error("failed to write to stdout: {}", strip_errno(.0))]
	Write(std::io::Error),
}

/// Parsed `tac` invocation.
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
/// Runs `tac` with `argv` (argv[0] is the command name) against `host`.
/// Entry point for BSD `tail -r` delegation.
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

	let separator = if raw_separator.is_empty() {
		OsStr::new("\0")
	} else {
		raw_separator
	};
	let files: Vec<OsString> = matches
		.get_many::<OsString>(options::FILE)
		.map_or_else(|| vec![OsString::from("-")], |files| files.cloned().collect());

	tac(&files, before, regex, separator, host)
}

/// The `tac` argument model.
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

/// Reports a recoverable per-file error and records a non-zero status.
///
/// This deliberately uses `Tac::NAME`: delegated `tail -r` invocations retain
/// `tac:` diagnostics even though the shared host's invocation name is `tail`.
fn show(host: &mut Host, error: &TacError) {
	let _ = writeln!(host.stderr, "{}: {error}", Tac::NAME);
	host.fail(1);
}

/// Prints lines of a buffer in reverse, with the line separator given as a
/// regex.
fn buffer_tac_regex(
	data: &[u8],
	pattern: &regex::bytes::Regex,
	before: bool,
	host: &mut Host,
) -> std::io::Result<()> {
	let mut out = BufWriter::new(&mut host.stdout);

	// As we scan from right to left, this limits each search to bytes before the
	// separator found on the previous iteration.
	let mut this_line_end = data.len();
	// If `before` is true, each line starts immediately before its separator;
	// otherwise it starts immediately after it.
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

/// Input read per step when a file is read backwards.
const BLOCK: usize = 128 * 1024;
/// Output gathered per write: lines come out short and scattered.
const OUTPUT_BUFFER: usize = 64 * 1024;

/// Writes the input's lines to stdout in reverse, split on a literal separator.
///
/// `window` holds the input from offset `start` to its end. While no separator
/// is left in it and `start` is not 0, `read_before(offset, buffer)` fills
/// `buffer` with the input bytes that end at `offset`, so a file read backwards
/// keeps only one block and its unfinished line in memory. Separators match as
/// `memmem::rfind_iter` over the whole input would: each search ends where the
/// previously found separator starts.
fn reverse_lines(
	mut window: Vec<u8>,
	mut start: usize,
	before: bool,
	separator: &[u8],
	host: &mut Host,
	mut read_before: impl FnMut(usize, &mut [u8]) -> Result<(), TacError>,
) -> Result<(), TacError> {
	let finder = memmem::FinderRev::new(separator);
	let mut out = BufWriter::with_capacity(OUTPUT_BUFFER, &mut host.stdout);
	// `window[..end]` is not written yet; separators are searched in
	// `window[..limit]`.
	let mut end = window.len();
	let mut limit = end;
	loop {
		if let Some(i) = finder.rfind(&window[..limit]) {
			let line_start = if before { i } else { i + separator.len() };
			out.write_all(&window[line_start..end])
				.map_err(TacError::Write)?;
			end = line_start;
			limit = i;
		} else if start == 0 {
			break;
		} else {
			// Prepend the input before the window, at least as much as the
			// unfinished line holds, so a long line costs linear time.
			let read = BLOCK.max(end).min(start);
			if window.len() < read + end {
				window.resize(read + end, 0);
			}
			window.copy_within(..end, read);
			read_before(start, &mut window[..read])?;
			start -= read;
			end += read;
			limit += read;
		}
	}
	out.write_all(&window[..end]).map_err(TacError::Write)?;
	out.flush().map_err(TacError::Write)
}

/// Makes the GNU basic regular-expression flavor compatible with `regex`.
///
/// This toggles escaping of `()`, `|`, and `{}`, escapes misplaced anchors,
/// leaves only ASCII bytes inside bracket expressions, and byte-escapes
/// non-ASCII outside bracket expressions.
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
		if host.is_cancelled() {
			break;
		}
		// Never map the input: a concurrent truncation would SIGBUS the whole
		// host process through the mapping (and on Windows the mapping makes the
		// writer's SetEndOfFile fail).
		let mut data = Vec::new();
		if filename == "-" {
			if let Err(error) = host.stdin.read_to_end(&mut data) {
				show(host, &TacError::Read(OsString::from("stdin"), error));
				continue;
			}
		} else {
			let path = host.resolve(filename);
			let mut file = match host.open_read(path) {
				Ok(file) => file,
				Err(error) => {
					show(host, &TacError::Open(filename.clone(), error));
					continue;
				},
			};
			// A regular host file larger than a block is read backwards instead
			// of whole. Smaller files include pseudo-files (procfs, sysfs) whose
			// reported size is not their content's.
			if maybe_pattern.is_none()
				&& let Some(len) = file
					.metadata()
					.ok()
					.filter(std::fs::Metadata::is_file)
					.and_then(|metadata| usize::try_from(metadata.len()).ok())
					.filter(|len| *len > BLOCK)
			{
				let result = reverse_lines(
					Vec::new(),
					len,
					before,
					separator.as_encoded_bytes(),
					host,
					|offset, buffer| {
						file
							.seek(SeekFrom::Start((offset - buffer.len()) as u64))
							.and_then(|_| file.read_exact(buffer))
							.map_err(|error| TacError::Read(filename.clone(), error))
					},
				);
				match result {
					Err(error @ TacError::Read(..)) => show(host, &error),
					result => result?,
				}
				continue;
			}
			if let Err(error) = file.read_to_end(&mut data) {
				show(host, &TacError::Read(filename.clone(), error));
				continue;
			}
		}

		match &maybe_pattern {
			Some(pattern) => {
				buffer_tac_regex(&data, pattern, before, host).map_err(TacError::Write)?
			},
			// The whole input is in the window, so nothing is read before it.
			None => reverse_lines(data, 0, before, separator.as_encoded_bytes(), host, |_, _| Ok(()))?,
		}
	}
	Ok(())
}

/// Creates the `tac` builtin registration.
pub(crate) fn tac_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Tac, SE>()
}
