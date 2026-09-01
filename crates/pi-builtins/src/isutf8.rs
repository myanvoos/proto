


















use std::{
	ffi::{OsStr, OsString},
	io::{self, Read, Write},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command, builder::ValueParser};

use crate::host::{Host, Utility, format_usage, matches_parser, util};

const OPT_QUIET: &str = "quiet";
const OPT_LIST: &str = "list";
const OPT_INVERT: &str = "invert";
const ARG_FILES: &str = "files";
const CHUNK_SIZE: usize = 64 * 1024;
const STDIN_NAME: &str = "(standard input)";

enum Verdict {
	Valid,
	Invalid { line: u64, character: u64, byte: u64 },
	Cancelled,
}


pub(crate) struct Isutf8 {
	matches: ArgMatches,
}

matches_parser!(Isutf8, command);

impl Utility for Isutf8 {
	const NAME: &'static str = "isutf8";
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {
		let quiet = self.matches.get_flag(OPT_QUIET);
		let list = self.matches.get_flag(OPT_LIST);
		let invert = self.matches.get_flag(OPT_INVERT);
		let files: Vec<OsString> = self
			.matches
			.get_many::<OsString>(ARG_FILES)
			.map_or_else(Vec::new, |values| values.cloned().collect());
		let cancel = host.cancel_flag();

		let mut any_failed = false;
		let mut io_error = false;
		if files.is_empty() {
			match validate(&mut host.stdin, &cancel) {
				Err(err) => {
				host.error(format!("{STDIN_NAME}: {err}"), 2);
				io_error = true;
				},
				Ok(Verdict::Cancelled) => return 130,
				Ok(verdict) => {
					any_failed = report_verdict(
						host,
						STDIN_NAME,
						verdict,
						quiet,
						list,
						invert,
					);
				},
			}
		} else {
			for name in &files {
				let display = display_name(name);
				let result = if name == "-" {
					validate(&mut host.stdin, &cancel)
				} else {
					host.open_read(name).and_then(|mut file| validate(&mut file, &cancel))
				};
				let verdict = match result {
					Err(err) => {
						host.error(format!("{display}: {err}"), 2);
						io_error = true;
						continue;
					},
					Ok(Verdict::Cancelled) => return 130,
					Ok(verdict) => verdict,
				};
				any_failed |= report_verdict(host, &display, verdict, quiet, list, invert);
			}
		}

		if io_error { 2 } else { i32::from(any_failed) }
	}
}

fn report_verdict(
	host: &mut Host,
	display: &str,
	verdict: Verdict,
	quiet: bool,
	list: bool,
	invert: bool,
) -> bool {
	let valid = match verdict {
		Verdict::Valid => true,
		Verdict::Invalid { line, character, byte } => {
			if !quiet && !list {
				let _ = writeln!(
					host.stdout,
					"{display}: line {line}, char {character}, byte {byte}: invalid UTF-8 code"
				);
			}
			false
		},
		Verdict::Cancelled => unreachable!("cancellation is handled by the caller"),
	};

	let failed = valid == invert;
	if failed && list && !quiet {
		let _ = writeln!(host.stdout, "{display}");
	}
	failed
}

fn command() -> Command {
	Command::new(Isutf8::NAME)
		.version("isutf8 (pi-shell) 17.2.11")
		.about("Check whether files are valid UTF-8.")
		.override_usage(format_usage("isutf8 [-q|--quiet] [-l|--list] [-i|--invert] [FILE]..."))
		.disable_help_flag(true)
		.disable_version_flag(true)
		.infer_long_args(true)
		.arg(
			Arg::new(OPT_QUIET)
				.short('q')
				.long(OPT_QUIET)
				.help("suppress all output; report via exit status only")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_LIST)
				.short('l')
				.long(OPT_LIST)
				.help("print only the names of files failing the check")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_INVERT)
				.short('i')
				.long(OPT_INVERT)
				.help("invert the check: valid files fail")
				.action(ArgAction::SetTrue),
		)
		.arg(Arg::new("help").long("help").action(ArgAction::Help))
		.arg(
			Arg::new(ARG_FILES)
				.value_name("FILE")
				.num_args(0..)
				.value_parser(ValueParser::os_string()),
		)
}



fn validate(input: &mut impl Read, cancel: &Arc<AtomicBool>) -> io::Result<Verdict> {
	let mut buf = vec![0u8; CHUNK_SIZE + 3];
	let mut carry = 0usize;
	let mut offset = 0u64;
	let mut line = 1u64;
	let mut chars_in_line = 0u64;

	loop {
		if cancel.load(Ordering::Relaxed) {
			return Ok(Verdict::Cancelled);
		}
		let read = input.read(&mut buf[carry..carry + CHUNK_SIZE])?;
		let eof = read == 0;
		let data_len = carry + read;
		if data_len == 0 {
			return Ok(Verdict::Valid);
		}

		let mut pos = 0usize;
		while pos < data_len {
			match std::str::from_utf8(&buf[pos..data_len]) {
				Ok(_) => {
					advance(&buf[pos..data_len], &mut line, &mut chars_in_line);
					pos = data_len;
				},
				Err(err) => {
					advance(&buf[pos..pos + err.valid_up_to()], &mut line, &mut chars_in_line);
					pos += err.valid_up_to();
					if err.error_len().is_some() || eof {

						return Ok(Verdict::Invalid {
							line,
							character: chars_in_line + 1,
							byte: offset + pos as u64,
						});
					}
					break;
				},
			}
		}
		if eof {
			return Ok(Verdict::Valid);
		}

		buf.copy_within(pos..data_len, 0);
		carry = data_len - pos;
		offset += pos as u64;
	}
}



fn advance(text: &[u8], line: &mut u64, chars_in_line: &mut u64) {
	match memchr::memrchr(b'\n', text) {
		Some(last) => {
			*line += memchr::memchr_iter(b'\n', text).count() as u64;
			*chars_in_line = count_chars(&text[last + 1..]);
		},
		None => *chars_in_line += count_chars(text),
	}
}

fn count_chars(bytes: &[u8]) -> u64 {
	bytes.iter().filter(|&&byte| (byte & 0xc0) != 0x80).count() as u64
}

fn display_name(name: &OsStr) -> String {
	if name == "-" {
		STDIN_NAME.to_owned()
	} else {
		name.to_string_lossy().into_owned()
	}
}


pub(crate) fn isutf8_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Isutf8, SE>()
}


