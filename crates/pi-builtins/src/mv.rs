


#[cfg(unix)]
use std::os::fd::AsRawFd;
#[cfg(unix)]
use std::os::unix;
#[cfg(unix)]
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::{
	ffi::OsString,
	fmt,
	fs,
	io::{self, Write},
	path::{Path, PathBuf},
};

use brush_core::{ShellExtensions, builtins::Registration, openfiles::OpenFile};
use clap::{Arg, ArgAction, ArgMatches, Command, builder::ValueParser, error::ErrorKind};
use fs_extra::dir::get_size as dir_get_size;
use indicatif::{MultiProgress, ProgressBar, ProgressDrawTarget, ProgressStyle, TermLike};
use parking_lot::Mutex;
#[cfg(all(unix, not(any(target_os = "macos", target_os = "redox"))))]
use rustc_hash::FxHashMap;
use rustc_hash::FxHashSet;
use thiserror::Error;
#[cfg(unix)]
use uucore::fs::{display_permissions_unix, make_fifo};
#[cfg(all(unix, not(any(target_os = "macos", target_os = "redox"))))]
use uucore::fsxattr;
use uucore::{
	backup_control::{self, BackupMode, source_is_target_backup},
	display::Quotable,
	fs::{
		MissingHandling, ResolveMode, are_hardlinks_or_one_way_symlink_to_same_file,
		are_hardlinks_to_same_file, canonicalize, path_ends_with_terminator,
	},
	update_control::{self, UpdateMode},
};

use crate::host::{Host, Utility, format_usage, matches_parser, util};
#[cfg(unix)]
use self::hardlink::{
	HardlinkGroupScanner, HardlinkOptions, HardlinkTracker, create_hardlink_context,
	with_optional_hardlink_context,
};

#[derive(Debug, Error)]
enum MvError {
	#[error("cannot stat {0}: No such file or directory")]
	NoSuchFile(String),
	#[error("cannot stat {0}: Not a directory")]
	CannotStatNotADirectory(String),
	#[error("{0} and {1} are the same file")]
	SameFile(String, String),
	#[error("cannot move {0} to a subdirectory of itself, {1}")]
	SelfTargetSubdirectory(String, String),
	#[error("cannot overwrite directory {0} with non-directory")]
	DirectoryToNonDirectory(String),
	#[error("cannot overwrite non-directory {1} with directory {0}")]
	NonDirectoryToDirectory(String, String),
	#[error("target {0}: Not a directory")]
	NotADirectory(String),
	#[error("target directory {0}: Not a directory")]
	TargetNotADirectory(String),
	#[error("failed to access {0}: Not a directory")]
	FailedToAccessNotADirectory(String),
}

#[derive(Debug, Error)]
enum MvFailure {
	#[error(transparent)]
	Move(#[from] MvError),
	#[error(transparent)]
	Io(#[from] io::Error),
	#[error("{0}")]
	Message(String),
}

type MvResult<T> = Result<T, MvFailure>;


pub(crate) struct Mv {
	matches: ArgMatches,
}

matches_parser!(Mv, app);


struct ProgressTerminal {
	writer: Mutex<OpenFile>,
}

impl fmt::Debug for ProgressTerminal {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("ProgressTerminal").finish_non_exhaustive()
	}
}

impl ProgressTerminal {
	fn write_control(&self, value: impl fmt::Display) -> io::Result<()> {
		write!(self.writer.lock(), "{value}")
	}

	fn move_cursor(&self, n: usize, direction: char) -> io::Result<()> {
		if n == 0 {
			Ok(())
		} else {
			self.write_control(format_args!("\x1b[{n}{direction}"))
		}
	}
}

impl TermLike for ProgressTerminal {
	fn width(&self) -> u16 {
		#[cfg(unix)]
		{
			let writer = self.writer.lock();
			if let Ok(fd) = writer.try_borrow_as_fd() {
				let mut size = libc::winsize { ws_row: 0, ws_col: 0, ws_xpixel: 0, ws_ypixel: 0 };


				if unsafe { libc::ioctl(fd.as_raw_fd(), libc::TIOCGWINSZ, &mut size) } == 0
					&& size.ws_col > 0
				{
					return size.ws_col;
				}
			}
		}
		80
	}

	fn move_cursor_up(&self, n: usize) -> io::Result<()> {
		self.move_cursor(n, 'A')
	}

	fn move_cursor_down(&self, n: usize) -> io::Result<()> {
		self.move_cursor(n, 'B')
	}

	fn move_cursor_right(&self, n: usize) -> io::Result<()> {
		self.move_cursor(n, 'C')
	}

	fn move_cursor_left(&self, n: usize) -> io::Result<()> {
		self.move_cursor(n, 'D')
	}

	fn write_line(&self, s: &str) -> io::Result<()> {
		writeln!(self.writer.lock(), "{s}")
	}

	fn write_str(&self, s: &str) -> io::Result<()> {
		self.writer.lock().write_all(s.as_bytes())
	}

	fn clear_line(&self) -> io::Result<()> {
		self.write_control("\r\x1b[2K")
	}

	fn flush(&self) -> io::Result<()> {
		self.writer.lock().flush()
	}
}

fn progress_manager(host: &Host, enabled: bool) -> Option<MultiProgress> {
	(enabled && host.stderr.is_terminal()).then(|| {
		let terminal = ProgressTerminal { writer: Mutex::new(host.stderr_clone()) };
		MultiProgress::with_draw_target(ProgressDrawTarget::term_like(Box::new(terminal)))
	})
}


#[derive(Debug, Clone, Eq, PartialEq)]
pub struct Options {


	pub overwrite: OverwriteMode,


	pub backup: BackupMode,


	pub suffix: String,


	pub update: UpdateMode,


	pub target_dir: Option<OsString>,


	pub no_target_dir: bool,


	pub verbose: bool,


	pub strip_slashes: bool,


	pub progress_bar: bool,


	pub debug: bool,


	pub context: Option<String>,
}

impl Default for Options {
	fn default() -> Self {
		Self {
			overwrite:     OverwriteMode::default(),
			backup:        BackupMode::default(),
			suffix:        backup_control::DEFAULT_BACKUP_SUFFIX.to_owned(),
			update:        UpdateMode::default(),
			target_dir:    None,
			no_target_dir: false,
			verbose:       false,
			strip_slashes: false,
			progress_bar:  false,
			debug:         false,
			context:       None,
		}
	}
}


#[derive(Clone, Debug, Eq, PartialEq, Default)]
pub enum OverwriteMode {

	#[default]
	Default,

	NoClobber,

	Interactive,

	Force,
}

static OPT_FORCE: &str = "force";
static OPT_INTERACTIVE: &str = "interactive";
static OPT_NO_CLOBBER: &str = "no-clobber";
static OPT_STRIP_TRAILING_SLASHES: &str = "strip-trailing-slashes";
static OPT_TARGET_DIRECTORY: &str = "target-directory";
static OPT_NO_TARGET_DIRECTORY: &str = "no-target-directory";
static OPT_VERBOSE: &str = "verbose";
static OPT_PROGRESS: &str = "progress";
static ARG_FILES: &str = "files";
static OPT_DEBUG: &str = "debug";
static OPT_CONTEXT: &str = "context";
static OPT_SELINUX: &str = "selinux";
impl Utility for Mv {
	const NAME: &'static str = "mv";

	fn run(self, host: &mut Host) -> i32 {
		let files_len = self.matches.get_many::<OsString>(ARG_FILES).map_or(0, |v| v.len());
		if files_len == 1 && !self.matches.contains_id(OPT_TARGET_DIRECTORY) {
			let err = app().error(
				ErrorKind::TooFewValues,
				format!(
					"The argument '<{ARG_FILES}>...' requires at least 2 values, but only 1 was provided"
				),
			);
			let _ = write!(host.stderr, "{err}");
			return 1;
		}

		match run_matches(&self.matches, host) {
			Ok(()) => host.exit_code(),
			Err(err) => {
				let _ = writeln!(host.stderr, "{}: {err}", Self::NAME);
				1
			},
		}
	}
}

fn show(host: &mut Host, err: impl fmt::Display) {
	host.error(err, 1);
}

fn match_backup_method(method: &str, origin: &str) -> MvResult<BackupMode> {
	let matches = backup_control::BACKUP_CONTROL_VALUES
		.iter()
		.filter(|value| value.starts_with(method))
		.collect::<Vec<_>>();
	if matches.len() == 1 {
		match *matches[0] {
			"simple" | "never" => Ok(BackupMode::Simple),
			"numbered" | "t" => Ok(BackupMode::Numbered),
			"existing" | "nil" => Ok(BackupMode::Existing),
			"none" | "off" => Ok(BackupMode::None),
			_ => unreachable!("matched value comes from BACKUP_CONTROL_VALUES"),
		}
	} else {
		let kind = if matches.is_empty() { "invalid" } else { "ambiguous" };
		Err(MvFailure::Message(format!(
			"{kind} argument {} for '{origin}'\nValid arguments are:\n  - 'none', 'off'\n  - \
			 'simple', 'never'\n  - 'existing', 'nil'\n  - 'numbered', 't'",
			method.quote()
		)))
	}
}

fn determine_backup_mode(matches: &ArgMatches, host: &Host) -> MvResult<BackupMode> {
	let cli_method = matches
		.get_one::<String>(backup_control::arguments::OPT_BACKUP)
		.map(String::as_str);
	if matches.contains_id(backup_control::arguments::OPT_BACKUP) {
		if let Some(method) = cli_method {
			match_backup_method(method, "backup type")
		} else if let Some(method) = host.var("VERSION_CONTROL") {
			match_backup_method(method, "$VERSION_CONTROL")
		} else {
			Ok(BackupMode::Existing)
		}
	} else if matches.get_flag(backup_control::arguments::OPT_BACKUP_NO_ARG)
		|| matches.contains_id(backup_control::arguments::OPT_SUFFIX)
	{
		host.var("VERSION_CONTROL").map_or(Ok(BackupMode::Existing), |method| {
			match_backup_method(method, "$VERSION_CONTROL")
		})
	} else {
		Ok(BackupMode::None)
	}
}

fn determine_backup_suffix(matches: &ArgMatches, host: &Host) -> String {
	let suffix = matches
		.get_one::<String>(backup_control::arguments::OPT_SUFFIX)
		.map(String::as_str)
		.or_else(|| host.var("SIMPLE_BACKUP_SUFFIX"))
		.unwrap_or(backup_control::DEFAULT_BACKUP_SUFFIX);
	if suffix.contains('/') {
		backup_control::DEFAULT_BACKUP_SUFFIX.to_string()
	} else {
		suffix.to_string()
	}
}

fn run_matches(matches: &ArgMatches, host: &mut Host) -> MvResult<()> {
	let files: Vec<OsString> = matches
		.get_many::<OsString>(ARG_FILES)
		.unwrap_or_default()
		.cloned()
		.collect();

	let overwrite_mode = determine_overwrite_mode(matches);
	let backup_mode = determine_backup_mode(matches, host)?;
	let update_mode = update_control::determine_update_mode(matches);

	if backup_mode != BackupMode::None
		&& (overwrite_mode == OverwriteMode::NoClobber
			|| update_mode == UpdateMode::None
			|| update_mode == UpdateMode::NoneFail)
	{
		return Err(MvFailure::Message(
			"cannot combine --backup with -n/--no-clobber or --update=none-fail".to_string(),
		));
	}

	let backup_suffix = determine_backup_suffix(matches, host);
	let target_dir = matches.get_one::<OsString>(OPT_TARGET_DIRECTORY).cloned();
	if let Some(maybe_dir) = &target_dir
		&& !host.resolve(Path::new(maybe_dir)).is_dir()
	{
		return Err(MvError::TargetNotADirectory(maybe_dir.quote().to_string()).into());
	}

	let context = if matches.get_flag(OPT_SELINUX) {
		Some(String::new())
	} else {
		matches.get_one::<String>(OPT_CONTEXT).cloned()
	};

	let opts = Options {
		overwrite: overwrite_mode,
		backup: backup_mode,
		suffix: backup_suffix,
		update: update_mode,
		target_dir,
		no_target_dir: matches.get_flag(OPT_NO_TARGET_DIRECTORY),
		verbose: matches.get_flag(OPT_VERBOSE) || matches.get_flag(OPT_DEBUG),
		strip_slashes: matches.get_flag(OPT_STRIP_TRAILING_SLASHES),
		progress_bar: matches.get_flag(OPT_PROGRESS),
		debug: matches.get_flag(OPT_DEBUG),
		context,
	};

	mv(host, &files, &opts)
}

fn app() -> Command {
	Command::new("mv")
		.version("0.8.0")
		.about("Move SOURCE to DEST, or multiple SOURCE(s) to DIRECTORY.")
		.override_usage(format_usage(
			"mv [OPTION]... [-T] SOURCE DEST\nmv [OPTION]... SOURCE... DIRECTORY\nmv [OPTION]... -t \
			 DIRECTORY SOURCE...",
		))
		.after_help(format!(
			"{}\n\n{}",
			"When specifying more than one of -i, -f, -n, only the final one will take effect.\n\nDo \
			 not move a non-directory that has an existing destination with the same or newer \
			 modification timestamp;\ninstead, silently skip the file without failing. If the move \
			 is across file system boundaries, the comparison is\nto the source timestamp truncated \
			 to the resolutions of the destination file system and of the system calls used\nto \
			 update timestamps; this avoids duplicate work if several mv -u commands are executed \
			 with the same source\nand destination. This option is ignored if the -n or --no-clobber \
			 option is also specified. which gives more control\nover which existing files in the \
			 destination are replaced, and its value can be one of the following:\n\n- all This is \
			 the default operation when an --update option is not specified, and results in all \
			 existing files in the destination being replaced.\n- none This is similar to the \
			 --no-clobber option, in that no files in the destination are replaced, but also \
			 skipping a file does not induce a failure.\n- older This is the default operation when \
			 --update is specified, and results in files being replaced if they're older than the \
			 corresponding source file.",
			backup_control::BACKUP_CONTROL_LONG_HELP
		))
		.infer_long_args(true)
		.arg(
			Arg::new(OPT_FORCE)
				.short('f')
				.long(OPT_FORCE)
				.help("do not prompt before overwriting")
				.overrides_with_all([OPT_INTERACTIVE, OPT_NO_CLOBBER])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_INTERACTIVE)
				.short('i')
				.long(OPT_INTERACTIVE)
				.help("prompt before override")
				.overrides_with_all([OPT_FORCE, OPT_NO_CLOBBER])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_NO_CLOBBER)
				.short('n')
				.long(OPT_NO_CLOBBER)
				.help("do not overwrite an existing file")
				.overrides_with_all([OPT_FORCE, OPT_INTERACTIVE])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_STRIP_TRAILING_SLASHES)
				.long(OPT_STRIP_TRAILING_SLASHES)
				.help("remove any trailing slashes from each SOURCE argument")
				.action(ArgAction::SetTrue),
		)
		.arg(backup_control::arguments::backup())
		.arg(backup_control::arguments::backup_no_args())
		.arg(backup_control::arguments::suffix())
		.arg(update_control::arguments::update())
		.arg(update_control::arguments::update_no_args())
		.arg(
			Arg::new(OPT_TARGET_DIRECTORY)
				.short('t')
				.long(OPT_TARGET_DIRECTORY)
				.help("move all SOURCE arguments into DIRECTORY")
				.value_name("DIRECTORY")
				.value_hint(clap::ValueHint::DirPath)
				.conflicts_with(OPT_NO_TARGET_DIRECTORY)
				.value_parser(ValueParser::os_string()),
		)
		.arg(
			Arg::new(OPT_NO_TARGET_DIRECTORY)
				.short('T')
				.long(OPT_NO_TARGET_DIRECTORY)
				.help("treat DEST as a normal file")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_VERBOSE)
				.short('v')
				.long(OPT_VERBOSE)
				.help("explain what is being done")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_PROGRESS)
				.short('g')
				.long(OPT_PROGRESS)
				.help("Display a progress bar.\nNote: this feature is not supported by GNU coreutils.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_SELINUX)
				.short('Z')
				.help("set SELinux security context of destination file to default type")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_CONTEXT)
				.long(OPT_CONTEXT)
				.value_name("CTX")
				.value_parser(clap::value_parser!(String))
				.help("like -Z, or if CTX is specified then set the SELinux security context to CTX")
				.num_args(0..=1)
				.require_equals(true)
				.default_missing_value(""),
		)
		.arg(
			Arg::new(ARG_FILES)
				.action(ArgAction::Append)
				.num_args(1..)
				.required(true)
				.value_parser(ValueParser::os_string())
				.value_hint(clap::ValueHint::AnyPath),
		)
		.arg(
			Arg::new(OPT_DEBUG)
				.long(OPT_DEBUG)
				.help("explain how a file is copied. Implies -v")
				.action(ArgAction::SetTrue),
		)
}

fn determine_overwrite_mode(matches: &ArgMatches) -> OverwriteMode {


	if matches.get_flag(OPT_NO_CLOBBER) {
		OverwriteMode::NoClobber
	} else if matches.get_flag(OPT_INTERACTIVE) {
		OverwriteMode::Interactive
	} else if matches.get_flag(OPT_FORCE) {
		OverwriteMode::Force
	} else {
		OverwriteMode::Default
	}
}

fn parse_paths(files: &[OsString], opts: &Options) -> Vec<PathBuf> {
	let paths = files.iter().map(Path::new);

	if opts.strip_slashes {
		paths
			.map(|p| p.components().as_path().to_owned())
			.collect::<Vec<PathBuf>>()
	} else {
		paths.map(ToOwned::to_owned).collect::<Vec<PathBuf>>()
	}
}

fn handle_two_paths(host: &mut Host, source: &Path, target: &Path, opts: &Options) -> MvResult<()> {
	if opts.backup == BackupMode::Simple && source_is_target_backup(source, target, &opts.suffix) {
		return Err(
			io::Error::new(
				io::ErrorKind::NotFound,
				format!(
					"backing up {} might destroy source;  {} not moved",
					target.quote(),
					source.quote()
				),
			)
			.into(),
		);
	}

	let source_fs = host.resolve(source);
	let target_fs = host.resolve(target);

	if source_fs.symlink_metadata().is_err() {
		return Err(if path_ends_with_terminator(source) {
			MvError::CannotStatNotADirectory(source.quote().to_string()).into()
		} else {
			MvError::NoSuchFile(source.quote().to_string()).into()
		});
	}

	let source_is_dir = source_fs.is_dir() && !source_fs.is_symlink();
	let target_is_dir = if target_fs.is_symlink() {
		fs::canonicalize(&target_fs).is_ok_and(|p| p.is_dir())
	} else {
		target_fs.is_dir()
	};

	if path_ends_with_terminator(target)
		&& (!target_is_dir && !source_is_dir)
		&& !opts.no_target_dir
		&& opts.update != UpdateMode::IfOlder
	{
		return Err(MvError::FailedToAccessNotADirectory(target.quote().to_string()).into());
	}

	assert_not_same_file(host, source, target, target_is_dir, opts)?;

	if target_is_dir {
		if opts.no_target_dir {
			if source_fs.is_dir() {
				#[cfg(unix)]
				let (mut hardlink_tracker, hardlink_scanner) = create_hardlink_context();
				#[cfg(unix)]
				let hardlink_params = (Some(&mut hardlink_tracker), Some(&hardlink_scanner));
				#[cfg(not(unix))]
				let hardlink_params = (None, None);

				rename(host, source, target, opts, None, hardlink_params.0, hardlink_params.1)
					.map_err(|e| MvFailure::Message(format!("cannot move {} to {}: {e}", source.quote(), target.quote())))
			} else {
				Err(MvError::DirectoryToNonDirectory(target.quote().to_string()).into())
			}
		} else {
			move_files_into_dir(host, &[source.to_path_buf()], target, opts)
		}
	} else if target_fs.exists() && source_is_dir {
		match opts.overwrite {
			OverwriteMode::NoClobber => return Ok(()),
			OverwriteMode::Interactive => prompt_overwrite(host, target, None)?,
			OverwriteMode::Force => {},
			OverwriteMode::Default => {
				let (writable, mode) = is_writable(host, target);
				if !writable && stdin_is_terminal(host) {
					prompt_overwrite(host, target, mode)?;
				}
			},
		}
		Err(
			MvError::NonDirectoryToDirectory(source.quote().to_string(), target.quote().to_string())
				.into(),
		)
	} else {
		#[cfg(unix)]
		let (mut hardlink_tracker, hardlink_scanner) = create_hardlink_context();
		#[cfg(unix)]
		let hardlink_params = (Some(&mut hardlink_tracker), Some(&hardlink_scanner));
		#[cfg(not(unix))]
		let hardlink_params = (None, None);

		rename(host, source, target, opts, None, hardlink_params.0, hardlink_params.1)
			.map_err(|e| MvFailure::Message(format!("{e}")))
	}
}

fn assert_not_same_file(
	host: &mut Host,
	source: &Path,
	target: &Path,
	target_is_dir: bool,
	opts: &Options,
) -> MvResult<()> {
	let source_abs = host.resolve(source);
	let target_abs = host.resolve(target);


	let canonicalized_source =
		match canonicalize(&source_abs, MissingHandling::Normal, ResolveMode::Logical) {
			Ok(source) if source.exists() => source,
			_ => source_abs.clone(),

		};


	let target_is_dir = target_is_dir && !opts.no_target_dir;
	let canonicalized_target = if target_is_dir {


		canonicalize(&target_abs, MissingHandling::Normal, ResolveMode::Logical)?
			.join(source.file_name().unwrap_or_default())
	} else {


		match target_abs.parent() {
			Some(parent) if parent.to_str() != Some("") => {
				canonicalize(parent, MissingHandling::Normal, ResolveMode::Logical)?
					.join(target.file_name().unwrap_or_default())
			},

			_ => target_abs.clone(),

		}
	};

	let same_file = (canonicalized_source.eq(&canonicalized_target)
		|| are_hardlinks_to_same_file(&source_abs, &target_abs)
		|| are_hardlinks_or_one_way_symlink_to_same_file(&source_abs, &target_abs))
		&& opts.backup == BackupMode::None;


	let target_display = match source.file_name() {
		Some(file_name) if target_is_dir => {

			let mut path = target
				.display()
				.to_string()
				.trim_end_matches('/')
				.to_owned();

			path.push('/');
			path.push_str(&file_name.to_string_lossy());

			path.quote().to_string()
		},
		_ => target.quote().to_string(),
	};

	if same_file
		&& (canonicalized_source.eq(&canonicalized_target)
			|| source.eq(Path::new("."))
			|| source.ends_with("/.")
			|| source_abs.is_file())
	{
		return Err(MvError::SameFile(source.quote().to_string(), target_display).into());
	} else if (same_file || canonicalized_target.starts_with(&canonicalized_source))

        && !source_abs.is_symlink()
	{
		return Err(
			MvError::SelfTargetSubdirectory(source.quote().to_string(), target_display).into(),
		);
	}
	Ok(())
}

fn handle_multiple_paths(host: &mut Host, paths: &[PathBuf], opts: &Options) -> MvResult<()> {
	if opts.no_target_dir {
		return Err(MvFailure::Message(format!("mv: extra operand {}", paths.last().unwrap().quote()),
		));
	}
	let target_dir = paths.last().unwrap();
	let sources = &paths[..paths.len() - 1];

	move_files_into_dir(host, sources, target_dir, opts)
}


fn mv(host: &mut Host, files: &[OsString], opts: &Options) -> MvResult<()> {
	let paths = parse_paths(files, opts);

	if let Some(name) = &opts.target_dir {
		return move_files_into_dir(host, &paths, &PathBuf::from(name), opts);
	}

	match paths.len() {
		2 => handle_two_paths(host, &paths[0], &paths[1], opts),
		_ => handle_multiple_paths(host, &paths, opts),
	}
}

#[allow(clippy::cognitive_complexity)]
fn move_files_into_dir(host: &mut Host, files: &[PathBuf], target_dir: &Path, options: &Options) -> MvResult<()> {

	let mut moved_destinations: FxHashSet<PathBuf> =
		FxHashSet::with_capacity_and_hasher(files.len(), rustc_hash::FxBuildHasher);

	#[cfg(unix)]
	let (mut hardlink_tracker, hardlink_scanner) = {
		let (tracker, mut scanner) = create_hardlink_context();


		let hardlink_options = HardlinkOptions { verbose: options.verbose || options.debug };


		scanner.scan_files(host, files, &hardlink_options);

		(tracker, scanner)
	};

	if !host.resolve(target_dir).is_dir() {
		return Err(MvError::NotADirectory(target_dir.quote().to_string()).into());
	}

	let display_manager = progress_manager(host, options.progress_bar);

	let count_progress = if let Some(display_manager) = &display_manager {
		if files.len() > 1 {
			Some(
				display_manager.add(
					ProgressBar::new(files.len().try_into().unwrap()).with_style(
						ProgressStyle::with_template(&format!(
							"{} {{msg}} {{wide_bar}} {{pos}}/{{len}}",
							"moving"
						))
						.unwrap(),
					),
				),
			)
		} else {
			None
		}
	} else {
		None
	};

	for sourcepath in files {
		if host.resolve(sourcepath)
			.symlink_metadata()
			.is_err()
		{
			show(host, &MvError::NoSuchFile(sourcepath.quote().to_string()));
			continue;
		}

		if let Some(pb) = &count_progress {
			let msg = format!("{} (scanning hardlinks)", sourcepath.to_string_lossy());
			pb.set_message(msg);
		}

		let targetpath = if let Some(name) = sourcepath.file_name() {
			target_dir.join(name)
		} else {
			show(host, &MvError::NoSuchFile(sourcepath.quote().to_string()));
			continue;
		};

		if moved_destinations.contains(&targetpath) && options.backup != BackupMode::Numbered {

			show(host, format!(
					"will not overwrite just-created {} with {}",
					targetpath.quote(),
					sourcepath.quote()
				),
			);
			continue;
		}


		if let Err(e) = assert_not_same_file(host, sourcepath, target_dir, true, options) {
			show(host, e);
			continue;
		}

		#[cfg(unix)]
		let hardlink_params = (Some(&mut hardlink_tracker), Some(&hardlink_scanner));
		#[cfg(not(unix))]
		let hardlink_params = (None, None);

		match rename(host,
			sourcepath,
			&targetpath,
			options,
			display_manager.as_ref(),
			hardlink_params.0,
			hardlink_params.1,
		) {
			Err(e) if e.to_string().is_empty() => host.fail(1),
			Err(e) => {
				let e = format!("cannot move {} to {}: {e}", sourcepath.quote(), targetpath.quote());
				if let Some(pb) = &display_manager {
					pb.suspend(|| show(host, e));
				} else {
					show(host, e);
				}
			},
			Ok(()) => (),
		}
		if let Some(pb) = &count_progress {
			pb.inc(1);
		}
		moved_destinations.insert(targetpath.clone());
	}
	Ok(())
}

fn rename(
	host: &mut Host,
	from: &Path,
	to: &Path,
	opts: &Options,
	display_manager: Option<&MultiProgress>,
	#[cfg(unix)] hardlink_tracker: Option<&mut HardlinkTracker>,
	#[cfg(unix)] hardlink_scanner: Option<&HardlinkGroupScanner>,
	#[cfg(not(unix))] _hardlink_tracker: Option<()>,
	#[cfg(not(unix))] _hardlink_scanner: Option<()>,
) -> io::Result<()> {
	let mut backup_path = None;


	let from_fs = host.resolve(from);
	let to_fs = host.resolve(to);

	if to_fs.exists() {
		if opts.update == UpdateMode::None {
			if opts.debug {
				let _ = writeln!(host.stdout, "skipped {}", to.quote());
			}
			return Ok(());
		}

		if (opts.update == UpdateMode::IfOlder)
			&& fs::metadata(&from_fs)?.modified()? <= fs::metadata(&to_fs)?.modified()?
		{
			return Ok(());
		}

		if opts.update == UpdateMode::NoneFail {
			return Err(io::Error::other(format!("not replacing {}", to.quote())));
		}

		match opts.overwrite {
			OverwriteMode::NoClobber => {
				if opts.debug {
					let _ = writeln!(host.stdout, "skipped {}", to.quote());
				}
				return Ok(());
			},
			OverwriteMode::Interactive => prompt_overwrite(host, to, None)?,
			OverwriteMode::Force => {},
			OverwriteMode::Default => {

				let (writable, mode) = is_writable(host, to);
				if !writable && stdin_is_terminal(host) {
					prompt_overwrite(host, to, mode)?;
				}
			},
		}


		backup_path = backup_control::get_backup_path(opts.backup, &to_fs, &opts.suffix);
		if let Some(backup_path) = &backup_path {


			rename_with_fallback(host, to, backup_path, display_manager, false, None, None)?;
		}
	}


	if to_fs.exists() && to_fs.is_dir() && !to_fs.is_symlink() {

		if from_fs.is_dir() {
			if is_empty_dir(host, to) {
				fs::remove_dir(&to_fs)?;
			} else {
				return Err(io::Error::other("Directory not empty"));
			}
		}
	}

	#[cfg(unix)]
	{
		rename_with_fallback(host,
			from,
			to,
			display_manager,
			opts.verbose,
			hardlink_tracker,
			hardlink_scanner,
		)?;
	}
	#[cfg(not(unix))]
	{
		rename_with_fallback(host, from, to, display_manager, opts.verbose, None, None)?;
	}


	if opts.verbose {
		let message = if let Some(path) = &backup_path {

			let backup_display = match (to.parent(), path.file_name()) {
				(Some(parent), Some(name)) if !parent.as_os_str().is_empty() => parent.join(name),
				(_, Some(name)) => PathBuf::from(name),
				_ => path.clone(),
			};
			format!("renamed {} -> {} (backup: {})", from.quote(), to.quote(), backup_display.quote())
		} else {
			format!("renamed {} -> {}", from.quote(), to.quote())
		};

		match display_manager {
			Some(pb) => pb.suspend(|| {
				let _ = writeln!(host.stdout, "{message}");
			}),
			None => {
				let _ = writeln!(host.stdout, "{message}");
			},
		}
	}
	Ok(())
}

#[cfg(unix)]
fn is_fifo(filetype: fs::FileType) -> bool {
	filetype.is_fifo()
}

#[cfg(not(unix))]
fn is_fifo(_filetype: fs::FileType) -> bool {
	false
}


fn rename_with_fallback(
	host: &mut Host,
	from: &Path,
	to: &Path,
	display_manager: Option<&MultiProgress>,
	verbose: bool,
	#[cfg(unix)] hardlink_tracker: Option<&mut HardlinkTracker>,
	#[cfg(unix)] hardlink_scanner: Option<&HardlinkGroupScanner>,
	#[cfg(not(unix))] _hardlink_tracker: Option<()>,
	#[cfg(not(unix))] _hardlink_scanner: Option<()>,
) -> io::Result<()> {
	let from_fs = host.resolve(from);
	let to_fs = host.resolve(to);

	fs::rename(&from_fs, &to_fs).or_else(|err| {
		#[cfg(unix)]
		const EXDEV: i32 = libc::EXDEV as _;
		#[cfg(target_os = "wasi")]
		const EXDEV: i32 = 18;


		let should_fallback = matches!(err.raw_os_error(), Some(EXDEV))
			|| (from_fs.is_file() && can_delete_file(host, &from_fs));
		if !should_fallback {
			return Err(err);
		}

		let metadata = from_fs.symlink_metadata()?;
		let file_type = metadata.file_type();
		if file_type.is_symlink() {
			rename_symlink_fallback(host, from, to)
		} else if file_type.is_dir() {
			#[cfg(unix)]
			{
				with_optional_hardlink_context(
					hardlink_tracker,
					hardlink_scanner,
					|tracker, scanner| {
						rename_dir_fallback(host,
							from,
							to,
							display_manager,
							verbose,
							Some(tracker),
							Some(scanner),
						)
					},
				)
			}
			#[cfg(not(unix))]
			{
				rename_dir_fallback(host, from, to, display_manager, verbose)
			}
		} else if is_fifo(file_type) {
			rename_fifo_fallback(host, from, to)
		} else {
			#[cfg(unix)]
			{
				with_optional_hardlink_context(
					hardlink_tracker,
					hardlink_scanner,
					|tracker, scanner| rename_file_fallback(host, from, to, Some(tracker), Some(scanner)),
				)
			}
			#[cfg(not(unix))]
			{
				rename_file_fallback(host, from, to)
			}
		}
	})
}


#[cfg(unix)]
fn rename_fifo_fallback(host: &mut Host, from: &Path, to: &Path) -> io::Result<()> {
	let to_fs = host.resolve(to);
	if to_fs.try_exists()? {
		fs::remove_file(&to_fs)?;
	}
	make_fifo(&to_fs).and_then(|_| fs::remove_file(host.resolve(from)))
}

#[cfg(not(unix))]
#[expect(clippy::unnecessary_wraps, reason = "fn sig must match on all platforms")]
fn rename_fifo_fallback(_host: &mut Host, _from: &Path, _to: &Path) -> io::Result<()> {
	Ok(())
}


#[cfg(unix)]
fn rename_symlink_fallback(host: &mut Host, from: &Path, to: &Path) -> io::Result<()> {


	let path_symlink_points_to = fs::read_link(host.resolve(from))?;
	unix::fs::symlink(path_symlink_points_to, host.resolve(to))?;
	#[cfg(not(any(target_os = "macos", target_os = "redox")))]
	{
		let _ = copy_xattrs_if_supported(host, from, to);
	}
	fs::remove_file(host.resolve(from))
}


#[cfg(target_os = "wasi")]
fn rename_symlink_fallback(host: &mut Host, _from: &Path, _to: &Path) -> io::Result<()> {
	Err(io::Error::other("your operating system does not support symlinks"))
}

fn rename_dir_fallback(
	host: &mut Host,
	from: &Path,
	to: &Path,
	display_manager: Option<&MultiProgress>,
	verbose: bool,
	#[cfg(unix)] hardlink_tracker: Option<&mut HardlinkTracker>,
	#[cfg(unix)] hardlink_scanner: Option<&HardlinkGroupScanner>,
) -> io::Result<()> {


	let to_fs = host.resolve(to);
	if to_fs.exists() {
		fs::remove_dir_all(&to_fs)?;
	}


	let total_size = dir_get_size(host.resolve(from)).ok();

	let progress_bar = match (display_manager, total_size) {
		(Some(display_manager), Some(total_size)) => {
			let template = "{msg}: [{elapsed_precise}] {wide_bar} {bytes:>7}/{total_bytes:7}";
			let style = ProgressStyle::with_template(template).unwrap();
			let bar = ProgressBar::new(total_size).with_style(style);
			Some(display_manager.add(bar))
		},
		(..) => None,
	};

	#[cfg(all(unix, not(any(target_os = "macos", target_os = "redox"))))]
	let xattrs = fsxattr::retrieve_xattrs(host.resolve(from))
		.unwrap_or_else(|_| FxHashMap::default());


	let result = copy_dir_contents(host,
		from,
		to,
		#[cfg(unix)]
		hardlink_tracker,
		#[cfg(unix)]
		hardlink_scanner,
		verbose,
		progress_bar.as_ref(),
		display_manager,
	);

	#[cfg(all(unix, not(any(target_os = "macos", target_os = "redox"))))]
	fsxattr::apply_xattrs(host.resolve(to), xattrs)?;

	result?;


	fs::remove_dir_all(host.resolve(from))?;

	Ok(())
}


fn copy_dir_contents(
	host: &mut Host,
	from: &Path,
	to: &Path,
	#[cfg(unix)] hardlink_tracker: Option<&mut HardlinkTracker>,
	#[cfg(unix)] hardlink_scanner: Option<&HardlinkGroupScanner>,
	verbose: bool,
	progress_bar: Option<&ProgressBar>,
	display_manager: Option<&MultiProgress>,
) -> io::Result<()> {

	fs::create_dir_all(host.resolve(to))?;


	#[cfg(unix)]
	{
		if let (Some(tracker), Some(scanner)) = (hardlink_tracker, hardlink_scanner) {
			copy_dir_contents_recursive(host,
				from,
				to,
				tracker,
				scanner,
				verbose,
				progress_bar,
				display_manager,
			)?;
		}
	}
	#[cfg(not(unix))]
	{
		copy_dir_contents_recursive(host, from, to, verbose, progress_bar, display_manager)?;
	}

	Ok(())
}

fn copy_dir_contents_recursive(
	host: &mut Host,
	from_dir: &Path,
	to_dir: &Path,
	#[cfg(unix)] hardlink_tracker: &mut HardlinkTracker,
	#[cfg(unix)] hardlink_scanner: &HardlinkGroupScanner,
	verbose: bool,
	progress_bar: Option<&ProgressBar>,
	display_manager: Option<&MultiProgress>,
) -> io::Result<()> {
	let print_verbose = |host: &mut Host, from: &Path, to: &Path| {
		if verbose {
			let message = format!("renamed {} -> {}", from.quote(), to.quote());
			match display_manager {
				Some(pb) => pb.suspend(|| {
					let _ = writeln!(host.stdout, "{message}");
				}),
				None => {
					let _ = writeln!(host.stdout, "{message}");
				},
			}
		}
	};


	let entries = fs::read_dir(host.resolve(from_dir))?;

	for entry in entries {
		let entry = entry?;
		let file_name = entry.file_name();
		let from_path = from_dir.join(&file_name);
		let to_path = to_dir.join(&file_name);

		if let Some(pb) = progress_bar {
			pb.set_message(from_path.to_string_lossy().to_string());
		}

		if host.resolve(&from_path).is_symlink() {


			#[cfg(unix)]
			{
				copy_file_with_hardlinks_helper(host,
					&from_path,
					&to_path,
					hardlink_tracker,
					hardlink_scanner,
				)?;
			}
			#[cfg(not(unix))]
			{
				rename_symlink_fallback(host, &from_path, &to_path)?;
			}

			print_verbose(host, &from_path, &to_path);
		} else if host.resolve(&from_path).is_dir() {

			fs::create_dir_all(host.resolve(&to_path))?;

			print_verbose(host, &from_path, &to_path);

			copy_dir_contents_recursive(host,
				&from_path,
				&to_path,
				#[cfg(unix)]
				hardlink_tracker,
				#[cfg(unix)]
				hardlink_scanner,
				verbose,
				progress_bar,
				display_manager,
			)?;
		} else {

			#[cfg(unix)]
			{
				copy_file_with_hardlinks_helper(host,
					&from_path,
					&to_path,
					hardlink_tracker,
					hardlink_scanner,
				)?;
			}
			#[cfg(not(unix))]
			{

				fs::copy(host.resolve(&from_path), host.resolve(&to_path))?;
			}

			print_verbose(host, &from_path, &to_path);
		}

		if let Some(pb) = progress_bar
			&& let Ok(metadata) = host.resolve(&from_path).metadata()
		{
			pb.inc(metadata.len());
		}
	}

	Ok(())
}

#[cfg(unix)]
fn copy_file_with_hardlinks_helper(
	host: &mut Host,
	from: &Path,
	to: &Path,
	hardlink_tracker: &mut HardlinkTracker,
	hardlink_scanner: &HardlinkGroupScanner,
) -> io::Result<()> {

	use hardlink::HardlinkOptions;
	let hardlink_options = HardlinkOptions::default();

	if let Some(existing_target) =
		hardlink_tracker.check_hardlink(host, from, to, hardlink_scanner, &hardlink_options)
	{
		fs::hard_link(host.resolve(&existing_target), host.resolve(to))?;
		return Ok(());
	}

	if host.resolve(from).is_symlink() {

		rename_symlink_fallback(host, from, to)?;
	} else if is_fifo(host.resolve(from).symlink_metadata()?.file_type()) {
		make_fifo(&host.resolve(to))?;
	} else {

		fs::copy(host.resolve(from), host.resolve(to))?;

		#[cfg(all(unix, not(any(target_os = "macos", target_os = "redox"))))]
		{
			let _ = copy_xattrs_if_supported(host, from, to);
		}
	}

	Ok(())
}

fn rename_file_fallback(
	host: &mut Host,
	from: &Path,
	to: &Path,
	#[cfg(unix)] hardlink_tracker: Option<&mut HardlinkTracker>,
	#[cfg(unix)] hardlink_scanner: Option<&HardlinkGroupScanner>,
) -> io::Result<()> {
	let to_fs = host.resolve(to);

	if to_fs.is_symlink() {
		fs::remove_file(&to_fs).map_err(|err| {
			let inter_device_msg = format!(
				"inter-device move failed: {} to {}; unable to remove target: {err}",
				from.quote(),
				to.quote()
			);
			io::Error::new(err.kind(), inter_device_msg)
		})?;
	} else if to_fs.exists() {

		fs::remove_file(&to_fs)?;
	}


	#[cfg(unix)]
	{
		if let (Some(tracker), Some(scanner)) = (hardlink_tracker, hardlink_scanner) {
			use hardlink::HardlinkOptions;
			let hardlink_options = HardlinkOptions::default();
			if let Some(existing_target) = tracker.check_hardlink(host, from, to, scanner, &hardlink_options)
			{

				fs::hard_link(host.resolve(&existing_target), &to_fs)?;
				fs::remove_file(host.resolve(from))?;
				return Ok(());
			}
		}
	}


	fs::copy(host.resolve(from), &to_fs)
		.map_err(|err| io::Error::new(err.kind(), "Permission denied"))?;


	#[cfg(all(unix, not(any(target_os = "macos", target_os = "redox"))))]
	{
		let _ = copy_xattrs_if_supported(host, from, to);
	}

	fs::remove_file(host.resolve(from))
		.map_err(|err| io::Error::new(err.kind(), "Permission denied"))?;
	Ok(())
}


#[cfg(all(unix, not(any(target_os = "macos", target_os = "redox"))))]
fn copy_xattrs_if_supported(host: &Host, from: &Path, to: &Path) -> io::Result<()> {
	match fsxattr::copy_xattrs(host.resolve(from), host.resolve(to)) {
		Ok(()) => Ok(()),
		Err(e) if e.raw_os_error() == Some(libc::EOPNOTSUPP) => Ok(()),
		Err(e) => Err(e),
	}
}

fn is_empty_dir(host: &Host, path: &Path) -> bool {
	fs::read_dir(host.resolve(path)).is_ok_and(|mut contents| contents.next().is_none())
}


#[cfg(unix)]
fn is_writable(host: &Host, path: &Path) -> (bool, Option<u32>) {
	if let Ok(metadata) = host.resolve(path).metadata() {
		let mode = metadata.permissions().mode();

		((mode & 0o200) != 0, Some(mode))
	} else {
		(false, None)
	}
}


#[cfg(not(unix))]
fn is_writable(host: &Host, path: &Path) -> (bool, Option<u32>) {
	if let Ok(metadata) = host.resolve(path).metadata() {
		(!metadata.permissions().readonly(), None)
	} else {
		(false, None)
	}
}

#[cfg(unix)]
fn get_interactive_prompt(host: &Host, to: &Path, cached_mode: Option<u32>) -> String {

	let mode = cached_mode.or_else(|| {
		host.resolve(to)
			.metadata()
			.ok()
			.map(|m| m.permissions().mode())
	});
	if let Some(mode) = mode {
		let file_mode = mode & 0o777;

		if (mode & 0o200) == 0 {
			let perms = display_permissions_unix(mode, false);
			let mode_info = format!("{file_mode:04o} ({perms})");
			return format!("replace {}, overriding mode {mode_info}?", to.quote());
		}
	}
	format!("overwrite {}?", to.quote())
}

#[cfg(not(unix))]
fn get_interactive_prompt(_host: &Host, to: &Path, _cached_mode: Option<u32>) -> String {
	format!("overwrite {}?", to.quote())
}


fn read_yes(host: &mut Host) -> bool {
	use std::io::Read as _;
	let stdin = &mut host.stdin;
	let mut buf = [0u8; 1];
	let mut first = None;
	loop {
		match stdin.read(&mut buf) {
			Ok(0) => break,
			Ok(_) => {
				if buf[0] == b'\n' {
					break;
				}
				if first.is_none() {
					first = Some(buf[0]);
				}
			},
			Err(_) => return false,
		}
	}
	matches!(first, Some(b'y' | b'Y'))
}


fn stdin_is_terminal(host: &Host) -> bool {
	host.stdin.file().is_terminal()
}


fn prompt_overwrite(host: &mut Host, to: &Path, cached_mode: Option<u32>) -> io::Result<()> {
	let prompt = get_interactive_prompt(host, to, cached_mode);
	{
		let err = &mut host.stderr;
		let _ = write!(err, "mv: {prompt} ");
		let _ = err.flush();
	}
	if !read_yes(host) {
		return Err(io::Error::other(""));
	}
	Ok(())
}


fn can_delete_file(_host: &Host, _: &Path) -> bool {


	false
}


pub(crate) fn mv_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Mv, SE>()
}

#[cfg(unix)]
mod hardlink {
	use super::Host;
	use std::{
		io::{self, Write},
		path::{Path, PathBuf},
	};

	use rustc_hash::FxHashMap;
	use uucore::display::Quotable;


	#[derive(Debug, Default)]
	pub struct HardlinkTracker {

		inode_map: FxHashMap<(u64, u64), PathBuf>,
	}


	#[derive(Debug, Default)]
	pub struct HardlinkGroupScanner {

		hardlink_groups: FxHashMap<(u64, u64), Vec<PathBuf>>,

		source_files:    Vec<PathBuf>,

		scanned:         bool,
	}


	#[derive(Debug, Clone, Default)]
	pub struct HardlinkOptions {

		pub verbose: bool,
	}


	#[derive(Debug)]
	pub enum HardlinkError {

		Io(io::Error),

		Scan(String),

		Preservation { source: PathBuf, target: PathBuf },

		Metadata { path: PathBuf, error: io::Error },
	}

	impl std::fmt::Display for HardlinkError {
		fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
			match self {
				Self::Io(e) => write!(f, "I/O error during hardlink operation: {e}"),
				Self::Scan(msg) => {
					write!(f, "Failed to scan files for hardlinks: {msg}")
				},
				Self::Preservation { source, target } => {
					write!(f, "Failed to preserve hardlink: {} -> {}", source.quote(), target.quote())
				},
				Self::Metadata { path, error } => {
					write!(f, "Metadata access error for {}: {error}", path.quote())
				},
			}
		}
	}

	impl std::error::Error for HardlinkError {
		fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
			match self {
				Self::Io(e) => Some(e),
				Self::Metadata { error, .. } => Some(error),
				_ => None,
			}
		}
	}

	impl From<io::Error> for HardlinkError {
		fn from(error: io::Error) -> Self {
			Self::Io(error)
		}
	}

	impl From<HardlinkError> for io::Error {
		fn from(error: HardlinkError) -> Self {
			match error {
				HardlinkError::Io(e) => e,
				HardlinkError::Scan(msg) => Self::other(msg),
				HardlinkError::Preservation { source, target } => Self::other(format!(
					"Failed to preserve hardlink: {} -> {}",
					source.quote(),
					target.quote()
				)),

				HardlinkError::Metadata { path, error } => {
					Self::other(format!("Metadata access error for {}: {error}", path.quote(),))
				},
			}
		}
	}

	impl HardlinkTracker {

		pub fn new() -> Self {
			Self::default()
		}


		pub fn check_hardlink(
			&mut self,
			host: &mut Host,
			source: &Path,
			dest: &Path,
			scanner: &HardlinkGroupScanner,
			options: &HardlinkOptions,
		) -> Option<PathBuf> {
			use std::os::unix::fs::MetadataExt;

			let metadata = match host.resolve(source).metadata() {
				Ok(meta) => meta,
				Err(e) => {


					if options.verbose {
						let _ = writeln!(
							host.stderr,
							"warning: cannot get metadata for {}: {e}",
							source.quote()
						);
					}
					return None;
				},
			};

			let key = (metadata.dev(), metadata.ino());


			if let Some(existing_path) = self.inode_map.get(&key) {

				let has_hardlinks = scanner
					.hardlink_groups
					.get(&key)
					.is_some_and(|group| group.len() > 1);

				if has_hardlinks {
					if options.verbose {
						let _ = writeln!(
							host.stderr,
							"preserving hardlink {} -> {} (hardlinked)",
							source.quote(),
							existing_path.quote()
						);
					}
					return Some(existing_path.clone());
				}
			}


			self.inode_map.insert(key, dest.to_path_buf());

			None
		}
	}

	impl HardlinkGroupScanner {

		pub fn new() -> Self {
			Self::default()
		}


		pub fn scan_files(&mut self, host: &mut Host, files: &[PathBuf], options: &HardlinkOptions) {
			if self.scanned {
				return;
			}


			self.source_files = files.to_vec();

			for file in files {
				if let Err(e) = self.scan_single_path(host, file)
					&& options.verbose
				{

					let _ =
						writeln!(host.stderr, "warning: failed to scan {}: {e}", file.quote());
				}


			}

			self.scanned = true;

			if options.verbose {
				let stats = self.stats();
				if stats.total_groups > 0 {
					let _ = writeln!(
						host.stderr,
						"found {} hardlink groups with {} total files",
						stats.total_groups,
						stats.total_files
					);
				}
			}
		}


		fn scan_single_path(&mut self, host: &mut Host, path: &Path) -> io::Result<()> {
			use std::os::unix::fs::MetadataExt;

			if host.resolve(path).is_dir() {

				self.scan_directory_recursive(host, path)?;
			} else {
				let metadata = host.resolve(path).metadata()?;
				if metadata.nlink() > 1 {
					let key = (metadata.dev(), metadata.ino());
					self
						.hardlink_groups
						.entry(key)
						.or_default()
						.push(path.to_path_buf());
				}
			}
			Ok(())
		}


		fn scan_directory_recursive(&mut self, host: &mut Host, dir: &Path) -> io::Result<()> {
			use std::os::unix::fs::MetadataExt;

			let entries = std::fs::read_dir(host.resolve(dir))?;
			for entry in entries {
				let entry = entry?;
				let path = entry.path();

				if path.is_dir() {
					self.scan_directory_recursive(host, &path)?;
				} else {
					let metadata = path.metadata()?;
					if metadata.nlink() > 1 {
						let key = (metadata.dev(), metadata.ino());
						self.hardlink_groups.entry(key).or_default().push(path);
					}
				}
			}
			Ok(())
		}


		#[cfg(unix)]
		pub fn stats(&self) -> ScannerStats {
			let total_groups = self.hardlink_groups.len();
			let total_files = self.hardlink_groups.values().map(Vec::len).sum();

			ScannerStats { total_groups, total_files }
		}
	}


	#[derive(Debug, Clone)]
	pub struct ScannerStats {

		pub total_groups: usize,

		pub total_files:  usize,
	}


	pub fn create_hardlink_context() -> (HardlinkTracker, HardlinkGroupScanner) {
		(HardlinkTracker::new(), HardlinkGroupScanner::new())
	}


	pub fn with_optional_hardlink_context<F, R>(
		tracker: Option<&mut HardlinkTracker>,
		scanner: Option<&HardlinkGroupScanner>,
		operation: F,
	) -> R
	where
		F: FnOnce(&mut HardlinkTracker, &HardlinkGroupScanner) -> R,
	{
		if let (Some(tracker), Some(scanner)) = (tracker, scanner) {
			operation(tracker, scanner)
		} else {
			let (mut dummy_tracker, dummy_scanner) = create_hardlink_context();
			operation(&mut dummy_tracker, &dummy_scanner)
		}
	}

}

