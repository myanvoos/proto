


#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
	ffi::{OsStr, OsString},
	fs::{self, Metadata},
	fmt,
	io::{self, Read, Write},
	ops::BitOr,
	path::{MAIN_SEPARATOR, Path},
};

use clap::{
	Arg, ArgAction, ArgMatches, Command,
	builder::{PossibleValue, ValueParser},
	parser::ValueSource,
};
use indicatif::{ProgressBar, ProgressDrawTarget, ProgressStyle, TermLike};
use parking_lot::Mutex;
use brush_core::{ShellExtensions, builtins::Registration, openfiles::OpenFile};
use thiserror::Error;
use uucore::{display::Quotable, parser::shortcut_value_parser::ShortcutValueParser};

use crate::host::{Host, Utility, format_usage, matches_parser, os_bytes, util};

macro_rules! show_error {
	($host:expr, $($args:tt)+) => {{
		$host.error(format_args!($($args)+), 1);
	}};
}

macro_rules! prompt_yes {
	($host:expr, $($args:tt)+) => {{
		use std::io::Write as _;
		let _ = write!($host.stderr, "rm: ");
		let _ = write!($host.stderr, $($args)+);
		let _ = write!($host.stderr, " ");
		let _ = $host.stderr.flush();
		$crate::rm::read_yes($host)
	}};
}

fn read_yes(host: &mut Host) -> bool {
	let mut byte = [0u8; 1];
	let mut first = None;
	loop {
		match host.stdin.read(&mut byte) {
			Ok(0) => break,
			Err(_) => return false,
			Ok(_) if byte[0] == b'\n' => break,
			Ok(_) => first.get_or_insert(byte[0]),
		};
	}
	matches!(first, Some(b'y' | b'Y'))
}

#[cfg(unix)]
mod platform {


use std::{ffi::OsStr, fs, os::unix::fs::PermissionsExt, path::Path};

use indicatif::ProgressBar;
use uucore::{display::Quotable, safe_traversal::{DirFd, SymlinkBehavior}};

use super::{
	Host,
	InteractiveMode, Options, is_dir_empty, is_readable_metadata, prompt_descend, remove_file,
	show_permission_denied_error, show_removal_error, verbose_removed_directory,
	verbose_removed_file,
};

#[inline]
fn mode_readable(mode: libc::mode_t) -> bool {
	(mode & libc::S_IRUSR) != 0
}

#[inline]
fn mode_writable(mode: libc::mode_t) -> bool {
	(mode & libc::S_IWUSR) != 0
}


fn prompt_file_with_stat(host: &mut Host, path: &Path, stat: &libc::stat, options: &Options) -> bool {
	if options.interactive == InteractiveMode::Never {
		return true;
	}

	let is_symlink = ((stat.st_mode as libc::mode_t) & libc::S_IFMT) == libc::S_IFLNK;
	let writable = mode_writable(stat.st_mode as libc::mode_t);
	let len = stat.st_size as u64;
	let stdin_ok = options.__presume_input_tty.unwrap_or(false);


	if options.interactive == InteractiveMode::Always {
		if is_symlink {
			return prompt_yes!(host, "remove symbolic link {}?", path.quote());
		}
		if writable {
			return if len == 0 {
				prompt_yes!(host, "remove regular empty file {}?", path.quote())
			} else {
				prompt_yes!(host, "remove file {}?", path.quote())
			};
		}

	}


	match (stdin_ok, writable, len == 0) {
		(false, ..) if options.interactive == InteractiveMode::PromptProtected => true,
		(_, true, _) => true,
		(_, false, true) => {
			prompt_yes!(host, "remove write-protected regular empty file {}?", path.quote())
		},
		_ => prompt_yes!(host, "remove write-protected regular file {}?", path.quote()),
	}
}


fn prompt_dir_with_mode(host: &mut Host, path: &Path, mode: libc::mode_t, options: &Options) -> bool {
	if options.interactive == InteractiveMode::Never {
		return true;
	}

	let readable = mode_readable(mode as libc::mode_t);
	let writable = mode_writable(mode as libc::mode_t);
	let stdin_ok = options.__presume_input_tty.unwrap_or(false);

	match (stdin_ok, readable, writable, options.interactive) {
		(false, _, _, InteractiveMode::PromptProtected) => true,
		(false, false, false, InteractiveMode::Never) => true,
		(_, false, false, _) => {
			prompt_yes!(host, "attempt removal of inaccessible directory {}?", path.quote())
		},
		(_, false, true, InteractiveMode::Always) => {
			prompt_yes!(host, "attempt removal of inaccessible directory {}?", path.quote())
		},
		(_, true, false, _) => prompt_yes!(host, "remove write-protected directory {}?", path.quote()),
		(_, _, _, InteractiveMode::Always) => prompt_yes!(host, "remove directory {}?", path.quote()),
		(..) => true,
	}
}


pub fn is_readable(host: &mut Host, path: &Path) -> bool {
	fs::metadata(host.resolve(path)).is_ok_and(|metadata| is_readable_metadata(&metadata))
}


pub fn safe_remove_file(host: &mut Host,
	path: &Path,
	options: &Options,
	progress_bar: Option<&ProgressBar>,
) -> Option<bool> {

	let parent = path.parent().unwrap_or(Path::new("."));
	let file_name = path.file_name()?;

	let dir_fd = DirFd::open(&host.resolve(parent), SymlinkBehavior::Follow).ok()?;

	match dir_fd.unlink_at(file_name, false) {
		Ok(_) => {
			host.note_write(path);

			if let Some(pb) = progress_bar {
				pb.inc(1);
			}
			verbose_removed_file(host, path, options);
			Some(false)
		},
		Err(e) => {
			if e.kind() == std::io::ErrorKind::PermissionDenied {
				show_error!(host, "cannot remove {}: Permission denied", path.quote());
			} else {
				let _ = show_removal_error(host, e, path);
			}
			Some(true)
		},
	}
}


pub fn safe_remove_empty_dir(host: &mut Host,
	path: &Path,
	options: &Options,
	progress_bar: Option<&ProgressBar>,
) -> Option<bool> {
	let parent = path.parent().unwrap_or(Path::new("."));
	let dir_name = path.file_name()?;

	let dir_fd = DirFd::open(&host.resolve(parent), SymlinkBehavior::Follow).ok()?;

	match dir_fd.unlink_at(dir_name, true) {
		Ok(_) => {

			if let Some(pb) = progress_bar {
				pb.inc(1);
			}
			verbose_removed_directory(host, path, options);
			Some(false)
		},
		Err(e) => {
			show_error!(host, "cannot remove {}: {e}", path.quote());
			Some(true)
		},
	}
}


fn handle_error_with_force(host: &mut Host, e: std::io::Error, path: &Path, options: &Options) -> bool {


	if e.kind() == std::io::ErrorKind::PermissionDenied {
		show_permission_denied_error(host, path);
		return true;
	}

	if !options.force {
		show_error!(host, "cannot remove {}: {e}", path.quote());
	}
	!options.force
}


fn handle_permission_denied(host: &mut Host,
	dir_fd: &DirFd,
	entry_name: &OsStr,
	entry_path: &Path,
	options: &Options,
) -> bool {


	if let Err(_remove_err) = dir_fd.unlink_at(entry_name, true) {


		show_permission_denied_error(host, entry_path);
		return true;
	}

	verbose_removed_directory(host, entry_path, options);
	false
}


fn handle_unlink(host: &mut Host,
	dir_fd: &DirFd,
	entry_name: &OsStr,
	entry_path: &Path,
	is_dir: bool,
	options: &Options,
) -> bool {
	if let Err(e) = dir_fd.unlink_at(entry_name, is_dir) {
		show_error!(host, "cannot remove {}: {e}", entry_path.quote());
		true
	} else {
		if is_dir {
			verbose_removed_directory(host, entry_path, options);
		} else {
			host.note_write(entry_path);
			verbose_removed_file(host, entry_path, options);
		}
		false
	}
}


pub fn remove_dir_with_special_cases(host: &mut Host, path: &Path, options: &Options, error_occurred: bool) -> bool {
	match fs::remove_dir(host.resolve(path)) {
		Err(_) if !error_occurred && !is_readable(host, path) => {


			show_permission_denied_error(host, path);
			true
		},
		Err(_) if !error_occurred && host.resolve(path).read_dir().is_err() => {


			show_permission_denied_error(host, path);
			true
		},
		Err(e) if !error_occurred => show_removal_error(host, e, path),
		Err(_) => {


			error_occurred
		},
		Ok(_) => {
			verbose_removed_directory(host, path, options);
			false
		},
	}
}

pub fn safe_remove_dir_recursive(host: &mut Host,
	path: &Path,
	options: &Options,
	progress_bar: Option<&ProgressBar>,
) -> bool {
	if host.is_cancelled() {
		return true;
	}


	let initial_mode = match fs::symlink_metadata(host.resolve(path)) {
		Ok(metadata) if !metadata.is_dir() => {
			return remove_file(host, path, options, progress_bar);
		},
		Ok(metadata) => metadata.permissions().mode(),
		Err(e) => {
			return show_removal_error(host, e, path);
		},
	};


	let dir_fd = match DirFd::open(&host.resolve(path), SymlinkBehavior::Follow) {
		Ok(fd) => fd,
		Err(e) => {


			if e.kind() == std::io::ErrorKind::PermissionDenied {

				if fs::remove_dir(host.resolve(path)).is_ok() {
					verbose_removed_directory(host, path, options);
					return false;
				}


				return show_permission_denied_error(host, path);
			}
			return show_removal_error(host, e, path);
		},
	};

	let error = safe_remove_dir_recursive_impl(host, path, &dir_fd, options);


	if error {
		error
	} else {

		if options.interactive == InteractiveMode::Always
			&& !prompt_dir_with_mode(host, path, initial_mode as libc::mode_t, options)
		{
			return false;
		}


		if !is_dir_empty(host, path) {


			if options.interactive == InteractiveMode::Always {
				return false;
			}


			return remove_dir_with_special_cases(host, path, options, false);
		}


		if let Some(result) = safe_remove_empty_dir(host, path, options, progress_bar) {
			result
		} else {
			remove_dir_with_special_cases(host, path, options, error)
		}
	}
}

#[cfg(not(target_os = "redox"))]
pub fn safe_remove_dir_recursive_impl(host: &mut Host, path: &Path, dir_fd: &DirFd, options: &Options) -> bool {

	let entries = match dir_fd.read_dir() {
		Ok(entries) => entries,
		Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
			if !options.force {
				show_permission_denied_error(host, path);
			}
			return !options.force;
		},
		Err(e) => {
			return handle_error_with_force(host, e, path, options);
		},
	};

	let mut error = false;


	for entry_name in entries {
		if host.is_cancelled() {
			return true;
		}

		let entry_path = path.join(&entry_name);


		let entry_stat = match dir_fd.stat_at(&entry_name, SymlinkBehavior::NoFollow) {
			Ok(stat) => stat,
			Err(e) => {
				error |= handle_error_with_force(host, e, &entry_path, options);
				continue;
			},
		};


		let is_dir = ((entry_stat.st_mode as libc::mode_t) & libc::S_IFMT) == libc::S_IFDIR;

		if is_dir {

			if options.interactive == InteractiveMode::Always
				&& !is_dir_empty(host, &entry_path)
				&& !prompt_descend(host, &entry_path)
			{
				continue;
			}


			let child_dir_fd = match dir_fd.open_subdir(&entry_name, SymlinkBehavior::Follow) {
				Ok(fd) => fd,
				Err(e) => {


					if e.kind() == std::io::ErrorKind::PermissionDenied {
						error |=
							handle_permission_denied(host, dir_fd, entry_name.as_ref(), &entry_path, options);
					} else {
						error |= handle_error_with_force(host, e, &entry_path, options);
					}
					continue;
				},
			};

			let child_error = safe_remove_dir_recursive_impl(host, &entry_path, &child_dir_fd, options);
			error |= child_error;


			if !child_error
				&& options.interactive == InteractiveMode::Always
				&& !prompt_dir_with_mode(host, &entry_path, entry_stat.st_mode as libc::mode_t, options)
			{
				continue;
			}


			if !child_error {
				error |= handle_unlink(host, dir_fd, entry_name.as_ref(), &entry_path, true, options);
			}
		} else {

			if prompt_file_with_stat(host, &entry_path, &entry_stat, options) {
				error |= handle_unlink(host, dir_fd, entry_name.as_ref(), &entry_path, false, options);
			}
		}
	}

	error
}

#[cfg(target_os = "redox")]
pub fn safe_remove_dir_recursive_impl(host: &mut Host, _path: &Path, _dir_fd: &DirFd, _options: &Options) -> bool {


	true
}

}
#[cfg(all(unix, not(target_os = "redox")))]
use platform::{safe_remove_dir_recursive, safe_remove_empty_dir, safe_remove_file};

#[derive(Debug, Error)]
enum RmError {
	#[error("missing operand\nTry 'rm --help' for more information.")]
	MissingOperand,
	#[error("cannot remove {}: No such file or directory", _0.quote())]
	CannotRemoveNoSuchFile(OsString),
	#[error("cannot remove {}: Permission denied", _0.quote())]
	CannotRemovePermissionDenied(OsString),
	#[error("cannot remove {}: Is a directory", _0.quote())]
	CannotRemoveIsDirectory(OsString),
	#[error("it is dangerous to operate recursively on '/'")]
	DangerousRecursiveOperation,
	#[error("use --no-preserve-root to override this failsafe")]
	UseNoPreserveRoot,
	#[error("refusing to remove '.' or '..' directory: skipping {}", _0.quote())]
	RefusingToRemoveDirectory(OsString),
	#[error("you may not abbreviate the --no-preserve-root option")]
	MayNotAbbreviateNoPreserveRoot,
}


fn verbose_removed_file(host: &mut Host, path: &Path, options: &Options) {
	if options.verbose {
		let _ =
			writeln!(host.stdout, "removed {}", uucore::fs::normalize_path(path).quote());
	}
}


fn verbose_removed_directory(host: &mut Host, path: &Path, options: &Options) {
	if options.verbose {
		let _ = writeln!(
			host.stdout,
			"removed directory {}",
			uucore::fs::normalize_path(path).quote()
		);
	}
}


fn show_removal_error(host: &mut Host, error: io::Error, path: &Path) -> bool {
	if error.kind() == io::ErrorKind::PermissionDenied {
		show_error!(host, "cannot remove {}: Permission denied", path.quote());
	} else {
		show_error!(host, "cannot remove {}: {error}", path.quote());
	}
	true
}


fn show_permission_denied_error(host: &mut Host, path: &Path) -> bool {
	show_error!(host, "cannot remove {}: Permission denied", path.quote());
	true
}


fn remove_dir_with_feedback(host: &mut Host, path: &Path, options: &Options) -> bool {
	match fs::remove_dir(host.resolve(path)) {
		Ok(_) => {
			verbose_removed_directory(host, path, options);
			false
		},
		Err(e) => show_removal_error(host, e, path),
	}
}

#[derive(Eq, PartialEq, Clone, Copy)]

pub enum InteractiveMode {

	Never,


	Once,

	Always,

	PromptProtected,
}


impl From<&str> for InteractiveMode {
	fn from(s: &str) -> Self {
		match s {
			"never" => Self::Never,
			"once" => Self::Once,
			"always" => Self::Always,
			_ => unreachable!("should be prevented by clap"),
		}
	}
}


pub struct Options {

	pub force:               bool,


	pub interactive:         InteractiveMode,
	#[allow(dead_code, reason = "--one-file-system is parsed but intentionally unimplemented upstream")]

	pub one_fs:              bool,

	pub preserve_root:       bool,

	pub recursive:           bool,

	pub dir:                 bool,

	pub verbose:             bool,

	pub progress:            bool,
	#[doc(hidden)]


	pub __presume_input_tty: Option<bool>,
}

impl Default for Options {
	fn default() -> Self {
		Self {
			force:               false,
			interactive:         InteractiveMode::PromptProtected,
			one_fs:              false,
			preserve_root:       true,
			recursive:           false,
			dir:                 false,
			verbose:             false,
			progress:            false,
			__presume_input_tty: None,
		}
	}
}

static OPT_DIR: &str = "dir";
static OPT_INTERACTIVE: &str = "interactive";
static OPT_FORCE: &str = "force";
static OPT_NO_PRESERVE_ROOT: &str = "no-preserve-root";
static OPT_ONE_FILE_SYSTEM: &str = "one-file-system";
static OPT_PRESERVE_ROOT: &str = "preserve-root";
static OPT_PROMPT_ALWAYS: &str = "prompt-always";
static OPT_PROMPT_ONCE: &str = "prompt-once";
static OPT_RECURSIVE: &str = "recursive";
static OPT_VERBOSE: &str = "verbose";
static OPT_PROGRESS: &str = "progress";
static PRESUME_INPUT_TTY: &str = "-presume-input-tty";

static ARG_FILES: &str = "files";


pub(crate) struct Rm {
	matches: ArgMatches,
}

matches_parser!(Rm, uu_app);

impl Utility for Rm {
	const NAME: &'static str = "rm";
	fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		const FULL: &str = "--no-preserve-root";
		for arg in argv.iter().skip(1) {
			let Some(arg) = arg.to_str() else {
				continue;
			};
			if arg == "--" {
				break;
			}
			if arg.starts_with("--") && arg.len() < FULL.len() && FULL.starts_with(arg) {
				return Err(RmError::MayNotAbbreviateNoPreserveRoot.to_string());
			}
		}
		Ok(argv)
	}


	fn run(self, host: &mut Host) -> i32 {
		run_matches(host, &self.matches)
	}
}

fn run_matches(host: &mut Host, matches: &ArgMatches) -> i32 {
	let files: Vec<_> = matches
		.get_many::<OsString>(ARG_FILES)
		.map(|v| v.map(OsString::as_os_str).collect())
		.unwrap_or_default();

	let force_flag = matches.get_flag(OPT_FORCE);
	if files.is_empty() && !force_flag {
		host.error(RmError::MissingOperand, 1);
		return 1;
	}


	let force_prompt_never = force_flag && {
		let force_index = matches.index_of(OPT_FORCE).unwrap_or(0);
		![OPT_PROMPT_ALWAYS, OPT_PROMPT_ONCE, OPT_INTERACTIVE]
			.iter()
			.any(|flag| {
				matches.value_source(flag) == Some(ValueSource::CommandLine)
					&& matches.index_of(flag).unwrap_or(0) > force_index
			})
	};


	let options = Options {
		force: force_flag,
		interactive: {
			if force_prompt_never {
				InteractiveMode::Never
			} else if matches.get_flag(OPT_PROMPT_ALWAYS) {
				InteractiveMode::Always
			} else if matches.get_flag(OPT_PROMPT_ONCE) {
				InteractiveMode::Once
			} else if matches.contains_id(OPT_INTERACTIVE) {
				InteractiveMode::from(matches.get_one::<String>(OPT_INTERACTIVE).unwrap().as_str())
			} else {
				InteractiveMode::PromptProtected
			}
		},
		one_fs: matches.get_flag(OPT_ONE_FILE_SYSTEM),
		preserve_root: !matches.get_flag(OPT_NO_PRESERVE_ROOT),
		recursive: matches.get_flag(OPT_RECURSIVE),
		dir: matches.get_flag(OPT_DIR),
		verbose: matches.get_flag(OPT_VERBOSE),
		progress: matches.get_flag(OPT_PROGRESS),
		__presume_input_tty: Some(
			matches.get_flag(PRESUME_INPUT_TTY) || host.stdin.file().is_terminal(),
		),
	};

	if options.interactive == InteractiveMode::Once && (options.recursive || files.len() > 3) {
		let msg = format!(
			"remove {} {}{}",
			files.len(),
			if files.len() > 1 { "arguments" } else { "argument" },
			if options.recursive { " recursively?" } else { "?" }
		);
		if !prompt_yes!(host, "{msg}") {
			return 0;
		}
	}

	if remove(host, &files, &options) {
		host.fail(1);
	}
	host.exit_code()
}

pub fn uu_app() -> Command {
	Command::new("rm")
		.version("0.8.0")
		.about("Remove (unlink) the FILE(s)")
		.override_usage(format_usage("rm [OPTION]... FILE..."))
		.after_help(
			"By default, rm does not remove directories. Use the --recursive (-r or -R)\noption to \
			 remove each listed directory, too, along with all of its contents\n\nTo remove a file \
			 whose name starts with a '-', for example '-foo',\nuse one of these commands:\nrm -- \
			 -foo\n\nrm ./-foo\n\nNote that if you use rm to remove a file, it might be possible to \
			 recover\nsome of its contents, given sufficient expertise and/or time. For \
			 greater\nassurance that the contents are truly unrecoverable, consider using shred.",
		)
		.infer_long_args(true)
		.args_override_self(true)
		.arg(
			Arg::new(OPT_FORCE)
				.short('f')
				.long(OPT_FORCE)
				.help("ignore nonexistent files and arguments, never prompt")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_PROMPT_ALWAYS)
				.short('i')
				.help("prompt before every removal")
				.overrides_with_all([OPT_PROMPT_ONCE, OPT_INTERACTIVE])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_PROMPT_ONCE)
				.short('I')
				.help(
					"prompt once before removing more than three files, or when removing \
					 recursively.\nLess intrusive than -i, while still giving some protection against \
					 most mistakes",
				)
				.overrides_with_all([OPT_PROMPT_ALWAYS, OPT_INTERACTIVE])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_INTERACTIVE)
				.long(OPT_INTERACTIVE)
				.help(
					"prompt according to WHEN: never, once (-I), or always (-i). Without \
					 WHEN,\nprompts always",
				)
				.value_name("WHEN")
				.value_parser(ShortcutValueParser::new([
					PossibleValue::new("always").alias("yes"),
					PossibleValue::new("once"),
					PossibleValue::new("never").alias("no").alias("none"),
				]))
				.num_args(0..=1)
				.require_equals(true)
				.default_missing_value("always")
				.overrides_with_all([OPT_PROMPT_ALWAYS, OPT_PROMPT_ONCE]),
		)
		.arg(
			Arg::new(OPT_ONE_FILE_SYSTEM)
				.long(OPT_ONE_FILE_SYSTEM)
				.help(
					"when removing a hierarchy recursively, skip any directory that is on a \
					 file\nsystem different from that of the corresponding command line argument \
					 (NOT\nIMPLEMENTED)",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_NO_PRESERVE_ROOT)
				.long(OPT_NO_PRESERVE_ROOT)
				.help("do not treat '/' specially")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_PRESERVE_ROOT)
				.long(OPT_PRESERVE_ROOT)
				.help("do not remove '/' (default)")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_RECURSIVE)
				.short('r')
				.visible_short_alias('R')
				.long(OPT_RECURSIVE)
				.help("remove directories and their contents recursively")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_DIR)
				.short('d')
				.long(OPT_DIR)
				.help("remove empty directories")
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
				.help("display a progress bar. Note: this feature is not supported by GNU coreutils.")
				.action(ArgAction::SetTrue),
		)


		.arg(
			Arg::new(PRESUME_INPUT_TTY)
				.long("presume-input-tty")
				.alias(PRESUME_INPUT_TTY)
				.hide(true)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(ARG_FILES)
				.action(ArgAction::Append)
				.value_parser(ValueParser::os_string())
				.num_args(1..)
				.value_hint(clap::ValueHint::AnyPath),
		)
}

pub(crate) fn rm_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Rm, SE>()
}


struct HostTerm(Mutex<OpenFile>);

impl fmt::Debug for HostTerm {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str("HostTerm")
	}
}

impl TermLike for HostTerm {
	fn width(&self) -> u16 {
		80
	}

	fn move_cursor_up(&self, n: usize) -> io::Result<()> {
		write!(self.0.lock(), "\x1b[{n}A")
	}

	fn move_cursor_down(&self, n: usize) -> io::Result<()> {
		write!(self.0.lock(), "\x1b[{n}B")
	}

	fn move_cursor_right(&self, n: usize) -> io::Result<()> {
		write!(self.0.lock(), "\x1b[{n}C")
	}

	fn move_cursor_left(&self, n: usize) -> io::Result<()> {
		write!(self.0.lock(), "\x1b[{n}D")
	}

	fn write_line(&self, s: &str) -> io::Result<()> {
		writeln!(self.0.lock(), "{s}")
	}

	fn write_str(&self, s: &str) -> io::Result<()> {
		write!(self.0.lock(), "{s}")
	}

	fn clear_line(&self) -> io::Result<()> {
		write!(self.0.lock(), "\r\x1b[2K")
	}

	fn flush(&self) -> io::Result<()> {
		self.0.lock().flush()
	}
}


fn create_progress_bar(host: &mut Host, files: &[&OsStr], recursive: bool) -> Option<ProgressBar> {
	if !host.stderr.is_terminal() {
		return None;
	}
	let total_files = count_files(host, files, recursive);
	if total_files == 0 {
		return None;
	}

	let progress = ProgressBar::with_draw_target(
		Some(total_files),
		ProgressDrawTarget::term_like(Box::new(HostTerm(Mutex::new(host.stderr_clone())))),
	)
	.with_style(
		ProgressStyle::with_template(
			"{msg}: [{elapsed_precise}] {wide_bar} {pos:>7}/{len:7} files",
		)
		.unwrap(),
	)
	.with_message("Removing");
	Some(progress)
}


fn count_files(host: &mut Host, paths: &[&OsStr], recursive: bool) -> u64 {
	let mut total = 0;
	for p in paths {
		if host.is_cancelled() {
			break;
		}


		if p.is_empty() {
			continue;
		}
		let path = Path::new(p);
		if let Ok(md) = fs::symlink_metadata(host.resolve(path)) {
			if md.is_dir() && !is_symlink_dir(&md) {
				if recursive {
					total += count_files_in_directory(host, path);
				}
			} else {
				total += 1;
			}
		}


	}
	total
}


fn count_files_in_directory(host: &mut Host, p: &Path) -> u64 {
	if host.is_cancelled() {
		return 0;
	}
	let mut entries_count = 0;
	let Ok(entries) = fs::read_dir(host.resolve(p)) else {
		return 1;
	};
	for entry in entries.flatten() {
		if host.is_cancelled() {
			break;
		}
		entries_count += match entry.file_type() {
			Ok(ft) if ft.is_dir() => count_files_in_directory(host, &entry.path()),
			Ok(_) => 1,
			Err(_) => 0,
		};
	}
	1 + entries_count
}


pub fn remove(host: &mut Host, files: &[&OsStr], options: &Options) -> bool {
	let mut had_err = false;


	let mut progress_bar: Option<ProgressBar> = None;
	let mut any_files_processed = false;

	for filename in files {
		if host.is_cancelled() {
			break;
		}

		let file = Path::new(filename);


		if filename.is_empty() {
			if !options.force {
				show_error!(host, "{}", RmError::CannotRemoveNoSuchFile(filename.to_os_string()));
				had_err = true;
			}
			continue;
		}


		if uucore::fs::path_ends_with_terminator(file)
			&& options.recursive
			&& options.preserve_root
			&& is_root_path(host, file)
		{
			show_preserve_root_error(host, file);
			had_err = true;
			continue;
		}

		had_err = match host.resolve(file).symlink_metadata() {
			Ok(metadata) => {

				if options.progress && progress_bar.is_none() {
					progress_bar = create_progress_bar(host, files, options.recursive);
				}

				any_files_processed = true;
				if metadata.is_dir() {
					handle_dir(host, file, options, progress_bar.as_ref())
				} else if is_symlink_dir(&metadata) {
					remove_dir(host, file, options, progress_bar.as_ref())
				} else {
					remove_file(host, file, options, progress_bar.as_ref())
				}
			},

			Err(_e) => {


				if options.force {
					false
				} else {
					show_error!(host, "{}", RmError::CannotRemoveNoSuchFile(filename.to_os_string()));
					true
				}
			},
		}
		.bitor(had_err);
	}


	if let Some(pb) = progress_bar
		&& any_files_processed
	{
		pb.finish();
	}

	had_err
}


fn is_dir_empty(host: &mut Host, path: &Path) -> bool {
	fs::read_dir(host.resolve(path)).is_ok_and(|mut iter| iter.next().is_none())
}

#[cfg(unix)]
fn is_readable_metadata(metadata: &Metadata) -> bool {
	let mode = metadata.permissions().mode();
	(mode & 0o400) > 0
}


#[cfg(any(not(unix), target_os = "redox"))]
fn is_readable(_host: &mut Host, _path: &Path) -> bool {
	true
}

#[cfg(unix)]
fn is_writable_metadata(metadata: &Metadata) -> bool {
	let mode = metadata.permissions().mode();
	(mode & 0o200) > 0
}

#[cfg(not(unix))]
fn is_writable_metadata(_metadata: &Metadata) -> bool {
	true
}


fn remove_dir_recursive(host: &mut Host,
	path: &Path,
	options: &Options,
	progress_bar: Option<&ProgressBar>,
) -> bool {
	if host.is_cancelled() {
		return true;
	}


	let fs_path = host.resolve(path);
	if !fs_path.is_dir() || fs_path.is_symlink() {
		return remove_file(host, path, options, progress_bar);
	}


	if options.interactive == InteractiveMode::Always && !is_dir_empty(host, path) && !prompt_descend(host, path)
	{
		return false;
	}


	#[cfg(all(unix, not(target_os = "redox")))]
	{
		safe_remove_dir_recursive(host, path, options, progress_bar)
	}


	#[cfg(any(not(unix), target_os = "redox"))]
	{
		if let Some(s) = path.to_str() {
			if s.len() > 1000 {
				match fs::remove_dir_all(host.resolve(path)) {
					Ok(_) => return false,
					Err(e) => {
						show_error!(host, "cannot remove {}: {e}", path.quote());
						return true;
					},
				}
			}
		}


		let mut error = false;
		match fs::read_dir(host.resolve(path)) {
			Err(e) if e.kind() == io::ErrorKind::PermissionDenied => {

			},
			Err(_) => error = true,
			Ok(iter) => {
				for entry in iter {
					if host.is_cancelled() {
						error = true;
						break;
					}
					match entry {
						Err(_) => error = true,
						Ok(entry) => {
							let child_error = remove_dir_recursive(host, &entry.path(), options, progress_bar);
							error = error || child_error;
						},
					}
				}
			},
		}


		if options.interactive == InteractiveMode::Always && !prompt_dir(host, path, options) {
			return false;
		}


		match fs::remove_dir(host.resolve(path)) {
			Err(_) if !error && !is_readable(host, path) => {


				show_permission_denied_error(host, path);
				error = true;
			},
			Err(e) if !error => {
				show_error!(host, "cannot remove {}: {e}", path.quote());
				error = true;
			},
			Err(_) => {


			},
			Ok(_) => verbose_removed_directory(host, path, options),
		}

		error
	}
}


fn is_root_path(host: &mut Host, path: &Path) -> bool {

	if path.has_root() && path.parent().is_none() {
		return true;
	}


	if let Ok(canonical) = host.resolve(path).canonicalize() {
		canonical.has_root() && canonical.parent().is_none()
	} else {
		false
	}
}


fn show_preserve_root_error(host: &mut Host, path: &Path) {
	let path_looks_like_root = path.has_root() && path.parent().is_none();

	if path_looks_like_root {

		show_error!(host, "{}", RmError::DangerousRecursiveOperation);
	} else {

		show_error!(host, "it is dangerous to operate recursively on '{}' (same as '/')", path.display());
	}
	show_error!(host, "{}", RmError::UseNoPreserveRoot);
}

fn handle_dir(host: &mut Host, path: &Path, options: &Options, progress_bar: Option<&ProgressBar>) -> bool {
	let mut had_err = false;

	let path = clean_trailing_slashes(path);
	if path_is_current_or_parent_directory(path) {
		show_error!(host, "{}", RmError::RefusingToRemoveDirectory(path.as_os_str().to_os_string()));
		return true;
	}

	let is_root = is_root_path(host, path);
	if options.recursive && (!is_root || !options.preserve_root) {
		had_err = remove_dir_recursive(host, path, options, progress_bar);
	} else if options.dir && (!is_root || !options.preserve_root) {
		had_err = remove_dir(host, path, options, progress_bar).bitor(had_err);
	} else if options.recursive {
		show_preserve_root_error(host, path);
		had_err = true;
	} else {
		show_error!(host, "{}", RmError::CannotRemoveIsDirectory(path.as_os_str().to_os_string()));
		had_err = true;
	}

	had_err
}


fn remove_dir(host: &mut Host, path: &Path, options: &Options, progress_bar: Option<&ProgressBar>) -> bool {

	if !prompt_dir(host, path, options) {
		return false;
	}


	if !options.dir && !options.recursive {
		show_error!(host, "{}", RmError::CannotRemoveIsDirectory(path.as_os_str().to_os_string()));
		return true;
	}


	#[cfg(all(unix, not(target_os = "redox")))]
	{
		if let Some(result) = safe_remove_empty_dir(host, path, options, progress_bar) {
			return result;
		}
	}


	if let Some(pb) = progress_bar {
		pb.inc(1);
	}


	remove_dir_with_feedback(host, path, options)
}

fn remove_file(host: &mut Host, path: &Path, options: &Options, progress_bar: Option<&ProgressBar>) -> bool {
	if prompt_file(host, path, options) {

		if let Some(pb) = progress_bar {
			pb.inc(1);
		}


		#[cfg(all(unix, not(target_os = "redox")))]
		{
			if let Some(result) = safe_remove_file(host, path, options, progress_bar) {
				return result;
			}
		}


		match fs::remove_file(host.resolve(path)) {
			Ok(_) => {
				host.note_write(path);
				verbose_removed_file(host, path, options);
			},
			Err(e) => {
				if e.kind() == io::ErrorKind::PermissionDenied {

					show_error!(host,
						"{}",
						RmError::CannotRemovePermissionDenied(path.as_os_str().to_os_string())
					);
				} else {
					return show_removal_error(host, e, path);
				}
				return true;
			},
		}
	}

	false
}

fn prompt_dir(host: &mut Host, path: &Path, options: &Options) -> bool {

	if options.interactive == InteractiveMode::Never {
		return true;
	}


	if let Ok(metadata) = fs::metadata(host.resolve(path)) {
		handle_writable_directory(host, path, options, &metadata)
	} else {
		true
	}
}

fn prompt_file(host: &mut Host, path: &Path, options: &Options) -> bool {

	if options.interactive == InteractiveMode::Never {
		return true;
	}

	let Ok(metadata) = fs::symlink_metadata(host.resolve(path)) else {
		return true;
	};

	if metadata.is_symlink() {
		return options.interactive != InteractiveMode::Always
			|| prompt_yes!(host, "remove symbolic link {}?", path.quote());
	}

	if options.interactive == InteractiveMode::Always && is_writable_metadata(&metadata) {
		return if metadata.len() == 0 {
			prompt_yes!(host, "remove regular empty file {}?", path.quote())
		} else {
			prompt_yes!(host, "remove file {}?", path.quote())
		};
	}

	prompt_file_permission_readonly(host, path, options, &metadata)
}

fn prompt_file_permission_readonly(host: &mut Host, path: &Path, options: &Options, metadata: &Metadata) -> bool {
	let stdin_ok = options.__presume_input_tty.unwrap_or(false);
	match (stdin_ok, options.interactive) {
		(false, InteractiveMode::PromptProtected) => true,
		_ if is_writable_metadata(metadata) => true,
		_ if metadata.len() == 0 => {
			prompt_yes!(host, "remove write-protected regular empty file {}?", path.quote())
		},
		_ => prompt_yes!(host, "remove write-protected regular file {}?", path.quote()),
	}
}


fn path_is_current_or_parent_directory(path: &Path) -> bool {
	let path_str = os_bytes(path.as_os_str());
	let dir_separator = MAIN_SEPARATOR as u8;
	if let Some(path_bytes) = path_str {
		return path_bytes == *b"."
			|| path_bytes == ([b'.', dir_separator])
			|| path_bytes == *b".."
			|| path_bytes == ([b'.', b'.', dir_separator])
			|| path_bytes.ends_with(&[dir_separator, b'.'])
			|| path_bytes.ends_with(&[dir_separator, b'.', b'.'])
			|| path_bytes.ends_with(&[dir_separator, b'.', dir_separator])
			|| path_bytes.ends_with(&[dir_separator, b'.', b'.', dir_separator]);
	}
	false
}


#[cfg(unix)]
fn handle_writable_directory(host: &mut Host, path: &Path, options: &Options, metadata: &Metadata) -> bool {
	let stdin_ok = options.__presume_input_tty.unwrap_or(false);
	match (
		stdin_ok,
		is_readable_metadata(metadata),
		is_writable_metadata(metadata),
		options.interactive,
	) {
		(false, _, _, InteractiveMode::PromptProtected) => true,
		(false, false, false, InteractiveMode::Never) => true,

		(_, false, false, _) => {
			prompt_yes!(host, "attempt removal of inaccessible directory {}?", path.quote())
		},
		(_, false, true, InteractiveMode::Always) => {
			prompt_yes!(host, "attempt removal of inaccessible directory {}?", path.quote())
		},
		(_, true, false, _) => prompt_yes!(host, "remove write-protected directory {}?", path.quote()),
		(_, _, _, InteractiveMode::Always) => prompt_yes!(host, "remove directory {}?", path.quote()),
		(..) => true,
	}
}


fn clean_trailing_slashes(path: &Path) -> &Path {
	let path_str = os_bytes(path.as_os_str());
	let dir_separator = MAIN_SEPARATOR as u8;

	if let Some(path_bytes) = path_str {
		let mut idx = if path_bytes.len() > 1 {
			path_bytes.len() - 1
		} else {
			return path;
		};

		if path_bytes[idx] == dir_separator {
			for i in (1..path_bytes.len()).rev() {


				if path_bytes[i - 1] != dir_separator {
					idx = i;
					break;
				}
			}
			#[cfg(unix)]
			return Path::new(OsStr::from_bytes(&path_bytes[0..=idx]));

			#[cfg(not(unix))]


			return Path::new(std::str::from_utf8(&path_bytes[0..=idx]).unwrap());
		}
	}
	path
}

fn prompt_descend(host: &mut Host, path: &Path) -> bool {
	prompt_yes!(host, "descend into directory {}?", path.quote())
}

fn is_symlink_dir(_metadata: &Metadata) -> bool {
	false
}


