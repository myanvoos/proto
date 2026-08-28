



use std::{
	ffi::{OsStr, OsString},
	io::{self, Write},
	path::{Path, PathBuf},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{
	Arg, ArgAction, ArgMatches, Command,
	builder::{TypedValueParser, ValueParserFactory},
};
use uucore::{
	display::Quotable,
	fs::{MissingHandling, ResolveMode, canonicalize, make_path_relative_to},
	line_ending::LineEnding,
};

use crate::host::{Host, Utility, format_usage, matches_parser, os_bytes, util};

const OPT_QUIET: &str = "quiet";
const OPT_STRIP: &str = "strip";
const OPT_ZERO: &str = "zero";
const OPT_PHYSICAL: &str = "physical";
const OPT_LOGICAL: &str = "logical";
const OPT_CANONICALIZE_MISSING: &str = "canonicalize-missing";
const OPT_CANONICALIZE: &str = "canonicalize";
const OPT_CANONICALIZE_EXISTING: &str = "canonicalize-existing";
const OPT_RELATIVE_TO: &str = "relative-to";
const OPT_RELATIVE_BASE: &str = "relative-base";
const ARG_FILES: &str = "files";


#[derive(Clone, Debug)]
struct NonEmptyOsStringParser;

impl TypedValueParser for NonEmptyOsStringParser {
	type Value = OsString;

	fn parse_ref(
		&self,
		_cmd: &Command,
		_arg: Option<&Arg>,
		value: &OsStr,
	) -> Result<Self::Value, clap::Error> {
		if value.is_empty() {
			let mut err = clap::Error::new(clap::error::ErrorKind::ValueValidation);
			err.insert(
				clap::error::ContextKind::Custom,
				clap::error::ContextValue::String("invalid operand: empty string".to_string()),
			);
			return Err(err);
		}
		Ok(value.to_os_string())
	}
}

impl ValueParserFactory for NonEmptyOsStringParser {
	type Parser = Self;

	fn value_parser() -> Self::Parser {
		Self
	}
}


pub(crate) struct Realpath {
	matches: ArgMatches,
}

matches_parser!(Realpath, app);

impl Utility for Realpath {
	const NAME: &'static str = "realpath";

	fn run(self, host: &mut Host) -> i32 {
		realpath_main(&self.matches, host)
	}
}

fn realpath_main(matches: &ArgMatches, host: &mut Host) -> i32 {
	let paths: Vec<PathBuf> = matches
		.get_many::<OsString>(ARG_FILES)
		.expect("required by clap")
		.map(PathBuf::from)
		.collect();

	let strip = matches.get_flag(OPT_STRIP);
	let line_ending = LineEnding::from_zero_flag(matches.get_flag(OPT_ZERO));
	let quiet = matches.get_flag(OPT_QUIET);
	let logical = matches.get_flag(OPT_LOGICAL);
	let can_mode = if matches.get_flag(OPT_CANONICALIZE_MISSING) {
		MissingHandling::Missing
	} else if matches.get_flag(OPT_CANONICALIZE_EXISTING) {


		MissingHandling::Existing
	} else {


		MissingHandling::Normal
	};
	let resolve_mode = if strip {
		ResolveMode::None
	} else if logical {
		ResolveMode::Logical
	} else {
		ResolveMode::Physical
	};

	let (relative_to, relative_base) =
		match prepare_relative_options(matches, host, can_mode, resolve_mode) {
			Ok(options) => options,
			Err((path, err)) => {
				host.error(format!("{}: {}", path.maybe_quote(), io_error_message(&err)), 1);
				return host.exit_code();
			},
		};

	for path in &paths {
		if let Err(err) = resolve_path(
			path,
			line_ending,
			resolve_mode,
			can_mode,
			relative_to.as_deref(),
			relative_base.as_deref(),
			host,
		) {
			if !quiet {
				host.error(format!("{}: {}", path.maybe_quote(), io_error_message(&err)), 1);
			} else {
				host.fail(1);
			}
		}
	}

	host.exit_code()
}

fn app() -> Command {
	Command::new("realpath")
		.version("0.8.0")
		.about("Print the resolved path")
		.override_usage(format_usage("realpath [OPTION]... FILE..."))
		.infer_long_args(true)
		.arg(
			Arg::new(OPT_QUIET)
				.short('q')
				.long(OPT_QUIET)
				.help("Do not print warnings for invalid paths")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_STRIP)
				.short('s')
				.long(OPT_STRIP)
				.visible_alias("no-symlinks")
				.help("Only strip '.' and '..' components, but don't resolve symbolic links")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_ZERO)
				.short('z')
				.long(OPT_ZERO)
				.help("Separate output filenames with \\0 rather than newline")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_LOGICAL)
				.short('L')
				.long(OPT_LOGICAL)
				.help("resolve '..' components before symlinks")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_PHYSICAL)
				.short('P')
				.long(OPT_PHYSICAL)
				.overrides_with_all([OPT_STRIP, OPT_LOGICAL])
				.help("resolve symlinks as encountered (default)")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_CANONICALIZE)
				.short('E')
				.long(OPT_CANONICALIZE)
				.overrides_with_all([OPT_CANONICALIZE_EXISTING, OPT_CANONICALIZE_MISSING])
				.help("all but the last component must exist (default)")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_CANONICALIZE_EXISTING)
				.short('e')
				.long(OPT_CANONICALIZE_EXISTING)
				.overrides_with_all([OPT_CANONICALIZE, OPT_CANONICALIZE_MISSING])
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
				.overrides_with_all([OPT_CANONICALIZE, OPT_CANONICALIZE_EXISTING])
				.help(
					"canonicalize by following every symlink in every component of the given name \
					 recursively, without requirements on components existence",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_RELATIVE_TO)
				.long(OPT_RELATIVE_TO)
				.value_name("DIR")
				.value_parser(NonEmptyOsStringParser)
				.help("print the resolved path relative to DIR"),
		)
		.arg(
			Arg::new(OPT_RELATIVE_BASE)
				.long(OPT_RELATIVE_BASE)
				.value_name("DIR")
				.value_parser(NonEmptyOsStringParser)
				.help("print absolute paths unless paths below DIR"),
		)
		.arg(
			Arg::new(ARG_FILES)
				.action(ArgAction::Append)
				.required(true)
				.value_parser(NonEmptyOsStringParser)
				.value_hint(clap::ValueHint::AnyPath),
		)
}

type PathIoError = (PathBuf, io::Error);




fn prepare_relative_options(
	matches: &ArgMatches,
	host: &Host,
	can_mode: MissingHandling,
	resolve_mode: ResolveMode,
) -> Result<(Option<PathBuf>, Option<PathBuf>), PathIoError> {
	let relative_to = matches
		.get_one::<OsString>(OPT_RELATIVE_TO)
		.map(PathBuf::from);
	let relative_base = matches
		.get_one::<OsString>(OPT_RELATIVE_BASE)
		.map(PathBuf::from);
	let relative_to = canonicalize_relative_option(relative_to, host, can_mode, resolve_mode)?;
	let relative_base = canonicalize_relative_option(relative_base, host, can_mode, resolve_mode)?;
	if let (Some(base), Some(to)) = (relative_base.as_deref(), relative_to.as_deref())
		&& !to.starts_with(base)
	{
		return Ok((None, None));
	}
	Ok((relative_to, relative_base))
}


fn canonicalize_relative_option(
	relative: Option<PathBuf>,
	host: &Host,
	can_mode: MissingHandling,
	resolve_mode: ResolveMode,
) -> Result<Option<PathBuf>, PathIoError> {
	match relative {
		None => Ok(None),
		Some(path) => canonicalize_relative(&host.resolve(&path), can_mode, resolve_mode)
			.map(Some)
			.map_err(|err| (path, err)),
	}
}


fn canonicalize_relative(
	path: &Path,
	can_mode: MissingHandling,
	resolve: ResolveMode,
) -> io::Result<PathBuf> {
	let absolute = canonicalize(path, can_mode, resolve)?;
	if can_mode == MissingHandling::Existing && !absolute.is_dir() {
		absolute.read_dir()?;
	}
	Ok(absolute)
}





fn resolve_path(
	path: &Path,
	line_ending: LineEnding,
	resolve: ResolveMode,
	can_mode: MissingHandling,
	relative_to: Option<&Path>,
	relative_base: Option<&Path>,
	host: &mut Host,
) -> io::Result<()> {
	let absolute = canonicalize(host.resolve(path), can_mode, resolve)?;
	let output_path = process_relative(absolute, relative_base, relative_to);
	let bytes = os_bytes(output_path.as_os_str())
		.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path is not valid Unicode"))?;
	host.stdout.write_all(bytes)?;
	host.stdout.write_all(&[line_ending.into()])?;
	host.stdout.flush()
}






fn process_relative(
	path: PathBuf,
	relative_base: Option<&Path>,
	relative_to: Option<&Path>,
) -> PathBuf {
	if let Some(base) = relative_base {
		if path.starts_with(base) {
			make_path_relative_to(path, relative_to.unwrap_or(base))
		} else {
			path
		}
	} else if let Some(to) = relative_to {
		make_path_relative_to(path, to)
	} else {
		path
	}
}

fn io_error_message(error: &io::Error) -> String {
	let mut message = error.to_string();
	if let Some(index) = message.find(" (os error ") {
		message.truncate(index);
	}
	message
}


pub(crate) fn realpath_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Realpath, SE>()
}


