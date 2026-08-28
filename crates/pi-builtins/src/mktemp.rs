




#[cfg(unix)]
use std::fs;
#[cfg(unix)]
use std::os::unix::prelude::PermissionsExt;
use std::{
	env,
	ffi::{OsStr, OsString},
	io::{self, ErrorKind, Write},
	iter,
	path::{MAIN_SEPARATOR, Path, PathBuf},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{
	Arg, ArgAction, ArgMatches, Command,
	builder::{TypedValueParser, ValueParserFactory},
};
use rand::{
	RngExt as _, SeedableRng as _,
	rngs::{self, SmallRng},
};
use tempfile::Builder;
use thiserror::Error;
use uucore::display::Quotable;

use crate::host::{Host, Utility, format_usage, matches_parser, os_bytes, util};

static DEFAULT_TEMPLATE: &str = "tmp.XXXXXXXXXX";

static OPT_DIRECTORY: &str = "directory";
static OPT_DRY_RUN: &str = "dry-run";
static OPT_QUIET: &str = "quiet";
static OPT_SUFFIX: &str = "suffix";
static OPT_TMPDIR: &str = "tmpdir";
static OPT_P: &str = "p";
static OPT_T: &str = "t";

static ARG_TEMPLATE: &str = "template";

#[cfg(not(windows))]
const TMPDIR_ENV_VAR: &str = "TMPDIR";
#[cfg(windows)]
const TMPDIR_ENV_VAR: &str = "TMP";

const FALLBACK_TMPDIR: &str = "/tmp";

#[derive(Error, Debug)]
enum MkTempError {
	#[error("could not persist file {}", .0.quote())]
	Persist(PathBuf),

	#[error("with --suffix, template {} must end in X", .0.quote())]
	MustEndInX(String),

	#[error("too few X's in template {}", .0.quote())]
	TooFewXs(String),

	#[error("invalid template, {}, contains directory separator", .0.quote())]
	PrefixContainsDirSeparator(String),

	#[error("invalid suffix {}, contains directory separator", .0.quote())]
	SuffixContainsDirSeparator(String),

	#[error("invalid template, {}; with --tmpdir, it may not be absolute", .0.quote())]
	InvalidTemplate(OsString),

	#[error("too many templates")]
	TooManyTemplates,

	#[error("failed to create {} via template {}: No such file or directory", .0, .1.quote())]
	NotFound(String, PathBuf),

	#[error(transparent)]
	Io(#[from] io::Error),
}





#[derive(Clone)]
struct Options {

	directory: bool,

	dry_run: bool,

	quiet: bool,

	tmpdir: Option<PathBuf>,

	suffix: Option<OsString>,

	treat_as_template: bool,

	template: OsString,
}

impl Options {
	fn from(matches: &ArgMatches, host: &Host) -> Self {
		let tmpdir = matches
			.get_one::<Option<PathBuf>>(OPT_TMPDIR)
			.or_else(|| matches.get_one::<Option<PathBuf>>(OPT_P))
			.map(|dir| match dir {

				Some(dir) => dir.clone(),

				None => get_tmpdir_env_or_default(host),
			});
		let (tmpdir, template) = match matches.get_one::<OsString>(ARG_TEMPLATE) {

			None => (
				Some(tmpdir.unwrap_or_else(|| get_tmpdir_env_or_default(host))),
				OsString::from(DEFAULT_TEMPLATE),
			),
			Some(template) => {
				let tmpdir = if let Some(tmpdir) = host.var(TMPDIR_ENV_VAR)
					&& matches.get_flag(OPT_T)
				{
					Some(PathBuf::from(tmpdir))
				} else if tmpdir.is_some() {
					tmpdir
				} else if matches.get_flag(OPT_T) || matches.contains_id(OPT_TMPDIR) {
					Some(get_tmpdir_env_or_default(host))
				} else {
					None
				};
				(tmpdir, template.clone())
			},
		};
		Self {
			directory: matches.get_flag(OPT_DIRECTORY),
			dry_run: matches.get_flag(OPT_DRY_RUN),
			quiet: matches.get_flag(OPT_QUIET),
			tmpdir,
			suffix: matches.get_one::<OsString>(OPT_SUFFIX).cloned(),
			treat_as_template: matches.get_flag(OPT_T),
			template,
		}
	}
}


struct Params {

	directory: PathBuf,

	prefix: String,

	num_rand_chars: usize,

	suffix: String,
}


fn find_last_contiguous_block_of_xs(s: &str) -> Option<(usize, usize)> {
	let bytes = s.as_bytes();
	let end = bytes.iter().rposition(|&b| b == b'X')?;
	let mut start = end;
	while start > 0 && bytes[start - 1] == b'X' {
		start -= 1;
	}
	(end + 1 - start >= 3).then_some((start, end + 1))
}

impl Params {
	fn from(options: Options) -> Result<Self, MkTempError> {


		let mut template_str = if options.treat_as_template {
			options.template.to_string_lossy().into_owned()
		} else {
			options
				.template
				.to_str()
				.ok_or_else(|| {
					MkTempError::InvalidTemplate("template contains invalid UTF-8".into())
				})?
				.to_string()
		};

		if options.suffix.is_some() && !template_str.ends_with('X') {
			return Err(MkTempError::MustEndInX(template_str));
		}

		let (i, j) = match find_last_contiguous_block_of_xs(&template_str) {
			Some(indices) => indices,

			None if options.treat_as_template => {
				template_str.push('.');
				template_str.push_str("XXXXXXXXXX");
				let j = template_str.len();
				(j - 10, j)
			},
			None => return Err(MkTempError::TooFewXs(template_str)),
		};



		let tmpdir = options.tmpdir;
		let prefix_from_option = tmpdir.clone().unwrap_or_default();
		let prefix_from_template = &template_str[..i];
		let prefix_path = Path::new(&prefix_from_option).join(prefix_from_template);
		if options.treat_as_template && prefix_from_template.contains(MAIN_SEPARATOR) {
			return Err(MkTempError::PrefixContainsDirSeparator(template_str));
		}
		if tmpdir.is_some() && Path::new(prefix_from_template).is_absolute() {
			return Err(MkTempError::InvalidTemplate(template_str.into()));
		}
		let (directory, prefix) = {
			let prefix_str = prefix_path.to_string_lossy();
			if prefix_str.ends_with(MAIN_SEPARATOR) {
				(prefix_path, String::new())
			} else {
				let directory = prefix_path.parent().map_or_else(PathBuf::new, Path::to_path_buf);
				let prefix = prefix_path
					.file_name()
					.map_or_else(String::new, |f| f.to_string_lossy().into_owned());
				(directory, prefix)
			}
		};


		let suffix_from_option = options
			.suffix
			.map(|s| s.to_string_lossy().into_owned())
			.unwrap_or_default();
		let suffix_from_template = &template_str[j..];
		let suffix = format!("{suffix_from_template}{suffix_from_option}");
		if suffix.contains(MAIN_SEPARATOR) {
			return Err(MkTempError::SuffixContainsDirSeparator(suffix));
		}

		Ok(Self { directory, prefix, num_rand_chars: j - i, suffix })
	}
}


#[derive(Clone, Debug)]
struct OptionalPathBufParser;

impl TypedValueParser for OptionalPathBufParser {
	type Value = Option<PathBuf>;

	fn parse_ref(
		&self,
		_cmd: &Command,
		_arg: Option<&Arg>,
		value: &OsStr,
	) -> Result<Self::Value, clap::Error> {
		if value.is_empty() {
			Ok(None)
		} else {
			Ok(Some(PathBuf::from(value)))
		}
	}
}

impl ValueParserFactory for OptionalPathBufParser {
	type Parser = Self;

	fn value_parser() -> Self::Parser {
		Self
	}
}


pub(crate) struct Mktemp {
	matches: ArgMatches,
}

matches_parser!(Mktemp, app);

impl Utility for Mktemp {
	const NAME: &'static str = "mktemp";

	fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {


		if let Err(err) = app().try_get_matches_from(&argv)
			&& err.kind() == clap::error::ErrorKind::TooManyValues
			&& err.context().any(|(kind, value)| {
				kind == clap::error::ContextKind::InvalidArg
					&& value == &clap::error::ContextValue::String("[template]".into())
			})
		{
			return Err(MkTempError::TooManyTemplates.to_string());
		}
		Ok(argv)
	}

	fn run(self, host: &mut Host) -> i32 {
		let options = Options::from(&self.matches, host);



		if host.var("POSIXLY_CORRECT").is_some()
			&& self.matches.contains_id(ARG_TEMPLATE)
			&& !template_is_last(&self.matches)
		{
			host.error(MkTempError::TooManyTemplates, 1);
			return 1;
		}

		let dry_run = options.dry_run;
		let quiet = options.quiet;
		let make_dir = options.directory;
		let Params { directory, prefix, num_rand_chars, suffix } = match Params::from(options) {
			Ok(params) => params,
			Err(err) => {
				host.error(err, 1);
				return 1;
			},
		};

		let result = if dry_run {
			Ok(dry_exec(&directory, &prefix, num_rand_chars, &suffix))
		} else {
			exec(host, &directory, &prefix, num_rand_chars, &suffix, make_dir)
		};
		let path = match result {
			Ok(path) => path,
			Err(_) if quiet => return 1,
			Err(err) => {
				host.error(err, 1);
				return 1;
			},
		};

		let Some(bytes) = os_bytes(path.as_os_str()) else {
			host.error("failed to print directory name: path contains invalid text", 1);
			return 1;
		};
		if host.stdout.write_all(bytes).is_err()
			|| host.stdout.write_all(b"\n").is_err()
			|| host.stdout.flush().is_err()
		{
			return 1;
		}
		0
	}
}


fn template_is_last(matches: &ArgMatches) -> bool {
	let Some(template_index) = matches.index_of(ARG_TEMPLATE) else {
		return true;
	};
	[
		OPT_DIRECTORY,
		OPT_DRY_RUN,
		OPT_QUIET,
		OPT_SUFFIX,
		OPT_TMPDIR,
		OPT_P,
		OPT_T,
	]
	.into_iter()
	.filter_map(|id| matches.index_of(id))
	.all(|index| index < template_index)
}


fn app() -> Command {
	Command::new(Mktemp::NAME)
		.version("0.8.0")
		.about("Create a temporary file or directory.")
		.override_usage(format_usage("mktemp [OPTION]... [TEMPLATE]"))
		.infer_long_args(true)
		.arg(
			Arg::new(OPT_DIRECTORY)
				.short('d')
				.long(OPT_DIRECTORY)
				.help("Make a directory instead of a file")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_DRY_RUN)
				.short('u')
				.long(OPT_DRY_RUN)
				.help("do not create anything; merely print a name (unsafe)")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_QUIET)
				.short('q')
				.long(OPT_QUIET)
				.help("Fail silently if an error occurs.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_SUFFIX)
				.long(OPT_SUFFIX)
				.help(
					"append SUFFIX to TEMPLATE; SUFFIX must not contain a path separator. This option \
					 is implied if TEMPLATE does not end with X.",
				)
				.value_name("SUFFIX")
				.value_parser(clap::value_parser!(OsString)),
		)
		.arg(
			Arg::new(OPT_P)
				.short('p')
				.help("short form of --tmpdir")
				.value_name("DIR")
				.num_args(1)
				.value_parser(OptionalPathBufParser)
				.value_hint(clap::ValueHint::DirPath),
		)
		.arg(
			Arg::new(OPT_TMPDIR)
				.long(OPT_TMPDIR)
				.help(
					"interpret TEMPLATE relative to DIR; if DIR is not specified, use $TMPDIR ($TMP on \
					 windows) if set, else /tmp. With this option, TEMPLATE must not be an absolute \
					 name; unlike with -t, TEMPLATE may contain slashes, but mktemp creates only the \
					 final component",
				)
				.value_name("DIR")
				.num_args(0..=1)
				.require_equals(true)
				.overrides_with(OPT_P)
				.value_parser(OptionalPathBufParser)
				.value_hint(clap::ValueHint::DirPath),
		)
		.arg(
			Arg::new(OPT_T)
				.short('t')
				.help(
					"Generate a template (using the supplied prefix and TMPDIR (TMP on windows) if \
					 set) to create a filename template [deprecated]",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(ARG_TEMPLATE)
				.num_args(..=1)
				.value_parser(clap::value_parser!(OsString)),
		)
}

fn dry_exec(tmpdir: &Path, prefix: &str, rand: usize, suffix: &str) -> PathBuf {
	let len = prefix.len() + suffix.len() + rand;
	let mut buf = Vec::with_capacity(len);
	buf.extend(prefix.as_bytes());
	buf.extend(iter::repeat_n(b'X', rand));
	buf.extend(suffix.as_bytes());

	let bytes = &mut buf[prefix.len()..prefix.len() + rand];
	SmallRng::try_from_rng(&mut rngs::SysRng)
		.unwrap_or_else(|_| SmallRng::seed_from_u64(bytes.as_ptr() as usize as u64))
		.fill(bytes);
	for byte in bytes {
		*byte = match *byte % 62 {
			v @ 0..=9 => v + b'0',
			v @ 10..=35 => v - 10 + b'a',
			v @ 36..=61 => v - 36 + b'A',
			_ => unreachable!(),
		};
	}

	let buf = String::from_utf8(buf).unwrap();
	tmpdir.join(buf)
}


fn make_temp_dir(
	dir: &Path,
	display_dir: &Path,
	prefix: &str,
	rand: usize,
	suffix: &str,
) -> Result<PathBuf, MkTempError> {
	let mut builder = Builder::new();
	builder.prefix(prefix).rand_bytes(rand).suffix(suffix);
	#[cfg(not(windows))]
	builder.permissions(fs::Permissions::from_mode(0o700));

	match builder.tempdir_in(dir) {
		Ok(directory) => Ok(directory.keep()),
		Err(err) if err.kind() == ErrorKind::NotFound => {
			let filename = format!("{prefix}{}{suffix}", "X".repeat(rand));
			Err(MkTempError::NotFound(
				"directory".to_string(),
				display_dir.join(filename),
			))
		},
		Err(err) => Err(err.into()),
	}
}


fn make_temp_file(
	dir: &Path,
	display_dir: &Path,
	prefix: &str,
	rand: usize,
	suffix: &str,
) -> Result<PathBuf, MkTempError> {
	let mut builder = Builder::new();
	builder.prefix(prefix).rand_bytes(rand).suffix(suffix);
	match builder.tempfile_in(dir) {
		Ok(file) => file.keep().map(|(_, path)| path).map_err(|err| {
			let path = err.file.path();
			let display_path = path
				.file_name()
				.map_or_else(|| display_dir.to_path_buf(), |name| display_dir.join(name));
			MkTempError::Persist(display_path)
		}),
		Err(err) if err.kind() == ErrorKind::NotFound => {
			let filename = format!("{prefix}{}{suffix}", "X".repeat(rand));
			Err(MkTempError::NotFound("file".to_string(), display_dir.join(filename)))
		},
		Err(err) => Err(err.into()),
	}
}

fn exec(
	host: &Host,
	dir: &Path,
	prefix: &str,
	rand: usize,
	suffix: &str,
	make_dir: bool,
) -> Result<PathBuf, MkTempError> {


	let resolved_dir = host.resolve(dir);
	let created = if make_dir {
		make_temp_dir(&resolved_dir, dir, prefix, rand, suffix)?
	} else {
		make_temp_file(&resolved_dir, dir, prefix, rand, suffix)?
	};
	let filename = created.file_name().expect("tempfile path has a file name");
	Ok(dir.join(filename))
}



fn get_tmpdir_env_or_default(host: &Host) -> PathBuf {
	match host.var(TMPDIR_ENV_VAR) {
		Some(value) if value.is_empty() => PathBuf::from(FALLBACK_TMPDIR),
		Some(value) => PathBuf::from(value),
		None => env::temp_dir(),
	}
}


pub(crate) fn mktemp_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Mktemp, SE>()
}


