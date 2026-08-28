//! `yes` builtin: repeatedly write a line assembled from its operands.
//!
//! Ported from uutils coreutils 0.8.0.

use std::{
	ffi::OsString,
	io::{self, Write},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command, builder::ValueParser};

use crate::host::{Host, Utility, format_usage, matches_parser, util};

// It's possible that using a smaller or larger buffer might provide better
// performance on some systems, but honestly this is good enough.
const BUF_SIZE: usize = 16 * 1024;

/// Parsed `yes` invocation.
pub(crate) struct Yes {
	matches: ArgMatches,
}

matches_parser!(Yes, app);

impl Utility for Yes {
	const NAME: &'static str = "yes";

	fn rewrite_argv(mut argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		// GNU yes (gnulib `parse_gnu_standard_options_only`) recognizes
		// `--help`/`--version` only as the sole argument; everything else —
		// `yes -n`, `yes --no`, even `yes --help me` — is echoed verbatim.
		// Insert `--` so clap treats every remaining argument as an operand.
		if argv.is_empty()
			|| (argv.len() == 2 && matches!(argv[1].to_str(), Some("--help" | "--version")))
		{
			return Ok(argv);
		}
		// GNU consumes one leading `--` as the operand separator; ours replaces it.
		if argv.get(1).is_some_and(|arg| arg.to_str() == Some("--")) {
			argv.remove(1);
		}
		argv.insert(1, OsString::from("--"));
		Ok(argv)
	}

	fn run(self, host: &mut Host) -> i32 {
		let mut buffer = Vec::with_capacity(BUF_SIZE);
		let Some(strings) = self.matches.get_many::<OsString>("STRING") else {
			host.error("missing default operand", 1);
			return 1;
		};
		let _ = args_into_buffer(&mut buffer, strings);
		prepare_buffer(&mut buffer);

		match exec(&buffer, host) {
			// A process `yes` normally dies from SIGPIPE when its consumer closes.
			// The builtin must instead recognize EPIPE and end without a diagnostic.
			ExecStop::Io(error) if error.kind() == io::ErrorKind::BrokenPipe => 0,
			ExecStop::Io(error) => {
				host.error(format!("standard output: {}", strip_errno(&error)), 1);
				1
			},
			// The adapter reports status 130 when shell cancellation triggered this.
			ExecStop::Cancelled => 1,
		}
	}
}

/// The `yes` argument model.
fn app() -> Command {
	Command::new(Yes::NAME)
		.version("0.8.0")
		.about("Repeatedly display a line with STRING (or 'y')")
		.override_usage(format_usage("yes [STRING]..."))
		.arg(
			Arg::new("STRING")
				.default_value("y")
				.value_parser(ValueParser::os_string())
				.action(ArgAction::Append)
				.allow_hyphen_values(true)
				.trailing_var_arg(true),
		)
		.infer_long_args(true)
}

/// Copies words from `strings` into `buffer`, separated by spaces.
fn args_into_buffer<'a>(
	buffer: &mut Vec<u8>,
	strings: impl Iterator<Item = &'a OsString>,
) -> Result<(), &'static str> {
	// On Unix (and WASI), OsStrs are just &[u8] underneath.
	#[cfg(any(unix, target_os = "wasi"))]
	{
		#[cfg(unix)]
		use std::os::unix::ffi::OsStrExt;
		#[cfg(target_os = "wasi")]
		use std::os::wasi::ffi::OsStrExt;

		for part in itertools::intersperse(strings.map(|argument| argument.as_bytes()), b" ") {
			buffer.extend_from_slice(part);
		}
	}

	// On Windows, we must hop through a String.
	#[cfg(not(any(unix, target_os = "wasi")))]
	{
		for part in itertools::intersperse(strings.map(|argument| argument.to_str()), Some(" ")) {
			let Some(part) = part else {
				return Err("arguments contain invalid UTF-8");
			};
			buffer.extend_from_slice(part.as_bytes());
		}
	}

	buffer.push(b'\n');
	Ok(())
}

/// Expands the single output line to the largest whole-line batch under [`BUF_SIZE`].
fn prepare_buffer(buffer: &mut Vec<u8>) {
	let line_len = buffer.len();
	debug_assert!(line_len > 0, "buffer is not empty since we have newline");
	let target_size = line_len * (BUF_SIZE / line_len);

	while buffer.len() < target_size {
		let to_copy = std::cmp::min(target_size - buffer.len(), buffer.len());
		debug_assert_eq!(to_copy % line_len, 0);
		buffer.extend_from_within(..to_copy);
	}
}

/// Why the otherwise-infinite output loop stopped.
enum ExecStop {
	Io(io::Error),
	Cancelled,
}

/// Writes one prepared batch at a time until output fails or the host is cancelled.
fn exec(bytes: &[u8], host: &mut Host) -> ExecStop {
	loop {
		// Poll immediately before every batch write. This is the flush boundary of
		// the batching fast path and keeps abort/timeout latency bounded by a batch.
		if host.is_cancelled() {
			return ExecStop::Cancelled;
		}
		if let Err(error) = host.stdout.write_all(bytes) {
			return ExecStop::Io(error);
		}
	}
}

/// Formats an I/O error without its platform-specific numeric errno suffix.
fn strip_errno(error: &io::Error) -> String {
	let mut message = error.to_string();
	if let Some(position) = message.find(" (os error ") {
		message.truncate(position);
	}
	message
}

/// Creates the `yes` builtin registration.
pub(crate) fn yes_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Yes, SE>()
}


