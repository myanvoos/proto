//! `readlink` builtin: print a symbolic link's value or a canonical file name.
//!
//! Ported from uutils coreutils 0.8.0.

use std::{
	ffi::OsString,
	fs,
	io::Write,
	path::{Path, PathBuf},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};
use uucore::{
	display::Quotable,
	fs::{MissingHandling, ResolveMode, canonicalize},
	libc::EINVAL,
	line_ending::LineEnding,
};

use crate::host::{Host, Utility, format_usage, matches_parser, os_bytes, util};

const OPT_CANONICALIZE: &str = "canonicalize";
const OPT_CANONICALIZE_MISSING: &str = "canonicalize-missing";
const OPT_CANONICALIZE_EXISTING: &str = "canonicalize-existing";
const OPT_NO_NEWLINE: &str = "no-newline";
const OPT_QUIET: &str = "quiet";
const OPT_SILENT: &str = "silent";
const OPT_VERBOSE: &str = "verbose";
const OPT_ZERO: &str = "zero";

const ARG_FILES: &str = "files";

/// Parsed `readlink` invocation.
pub(crate) struct Readlink {
	matches: ArgMatches,
}

matches_parser!(Readlink, app);

impl Utility for Readlink {
	const NAME: &'static str = "readlink";

	fn run(self, host: &mut Host) -> i32 {
		let mut no_trailing_delimiter = self.matches.get_flag(OPT_NO_NEWLINE);
		let use_zero = self.matches.get_flag(OPT_ZERO);
		let verbose = self.matches.get_flag(OPT_VERBOSE) || host.var("POSIXLY_CORRECT").is_some();

		// GNU readlink -f/-e/-m follows symlinks first and then applies `..`
		// (physical resolution). Logical mode would collapse `..` first.
		let resolve_mode = if self.matches.get_flag(OPT_CANONICALIZE)
			|| self.matches.get_flag(OPT_CANONICALIZE_EXISTING)
			|| self.matches.get_flag(OPT_CANONICALIZE_MISSING)
		{
			ResolveMode::Physical
		} else {
			ResolveMode::None
		};

		let missing_handling = if self.matches.get_flag(OPT_CANONICALIZE_EXISTING) {
			MissingHandling::Existing
		} else if self.matches.get_flag(OPT_CANONICALIZE_MISSING) {
			MissingHandling::Missing
		} else {
			MissingHandling::Normal
		};

		let files: Vec<PathBuf> = self
			.matches
			.get_many::<OsString>(ARG_FILES)
			.map(|values| values.map(PathBuf::from).collect())
			.unwrap_or_default();

		if files.is_empty() {
			host.error("missing operand", 1);
			return 1;
		}

		if no_trailing_delimiter && files.len() > 1 {
			let _ = writeln!(
				host.stderr,
				"readlink: ignoring --no-newline with multiple arguments"
			);
			no_trailing_delimiter = false;
		}

		let line_ending = if no_trailing_delimiter {
			None
		} else {
			Some(LineEnding::from_zero_flag(use_zero))
		};

		for operand in &files {
			let resolved = host.resolve(operand);
			let path_result = if resolve_mode == ResolveMode::None {
				fs::read_link(&resolved)
			} else {
				canonicalize(&resolved, missing_handling, resolve_mode)
			};

			match path_result {
				Ok(path) => {
					if show(&mut host.stdout, &path, line_ending).is_err() {
						return 1;
					}
				},
				Err(err) => {
					if verbose {
						let message = if err.raw_os_error() == Some(EINVAL) {
							format!("{}: Invalid argument", operand.maybe_quote())
						} else {
							format!("{}: {err}", operand.maybe_quote())
						};
						let _ = writeln!(host.stderr, "readlink: {message}");
					}
					return 1;
				},
			}
		}
		0
	}
}

/// The `readlink` argument model.
fn app() -> Command {
	Command::new(Readlink::NAME)
		.version("0.8.0")
		.about("Print value of a symbolic link or canonical file name.")
		.override_usage(format_usage("readlink [OPTION]... [FILE]..."))
		.infer_long_args(true)
		.arg(
			Arg::new(OPT_CANONICALIZE)
				.short('f')
				.long(OPT_CANONICALIZE)
				.help(
					"canonicalize by following every symlink in every component of the given name \
					 recursively; all but the last component must exist",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_CANONICALIZE_EXISTING)
				.short('e')
				.long(OPT_CANONICALIZE_EXISTING)
				.help(
					"canonicalize by following every symlink in every component of the given name \
					 recursively, all components must exist",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_CANONICALIZE_MISSING)
				.short('m')
				.long(OPT_CANONICALIZE_MISSING)
				.help(
					"canonicalize by following every symlink in every component of the given name \
					 recursively, without requirements on components existence",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_NO_NEWLINE)
				.short('n')
				.long(OPT_NO_NEWLINE)
				.help("do not output the trailing delimiter")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_QUIET)
				.short('q')
				.long(OPT_QUIET)
				.help("suppress most error messages")
				.overrides_with_all([OPT_QUIET, OPT_SILENT, OPT_VERBOSE])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_SILENT)
				.short('s')
				.long(OPT_SILENT)
				.help("suppress most error messages")
				.overrides_with_all([OPT_QUIET, OPT_SILENT, OPT_VERBOSE])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_VERBOSE)
				.short('v')
				.long(OPT_VERBOSE)
				.help("report error message")
				.overrides_with_all([OPT_QUIET, OPT_SILENT, OPT_VERBOSE])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_ZERO)
				.short('z')
				.long(OPT_ZERO)
				.help("separate output with NUL rather than newline")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(ARG_FILES)
				.action(ArgAction::Append)
				.value_parser(clap::value_parser!(OsString))
				.value_hint(clap::ValueHint::AnyPath),
		)
}

/// Writes a resolved path verbatim, followed by the selected delimiter.
fn show(out: &mut impl Write, path: &Path, line_ending: Option<LineEnding>) -> std::io::Result<()> {
	let bytes = os_bytes(path.as_os_str())
		.ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid path"))?;
	out.write_all(bytes)?;
	if let Some(line_ending) = line_ending {
		write!(out, "{line_ending}")?;
	}
	out.flush()
}

/// Creates the `readlink` builtin registration.
pub(crate) fn readlink_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Readlink, SE>()
}


