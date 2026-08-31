


use std::{
	ffi::OsString,
	fmt,
	io::{self, Write},
	path::Path,
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command, builder::ValueParser, parser::ValuesRef};
use uucore::{display::Quotable, fs};
use uucore::mode;
#[cfg(all(unix, target_os = "linux"))]
use uucore::fsxattr;

use crate::host::{Host, Utility, format_usage, matches_parser, util};

const DEFAULT_PERM: u32 = 0o777;

mod options {
	pub const MODE: &str = "mode";
	pub const PARENTS: &str = "parents";
	pub const VERBOSE: &str = "verbose";
	pub const DIRS: &str = "dirs";
	pub const SECURITY_CONTEXT: &str = "z";
	pub const CONTEXT: &str = "context";
}

struct Config {
	recursive: bool,
	mode:      u32,
	verbose:   bool,
}


fn get_mode(matches: &ArgMatches) -> Result<u32, String> {
	if let Some(mode_arg) = matches.get_one::<String>(options::MODE) {
		mode::parse_chmod(DEFAULT_PERM, mode_arg, true, mode::get_umask())
	} else {

		Ok(!mode::get_umask() & DEFAULT_PERM)
	}
}

#[derive(Debug)]
enum MkdirError {
	Message(String),
	Io { context: Option<String>, source: io::Error },
}

impl MkdirError {
	fn io(source: io::Error) -> Self {
		Self::Io { context: None, source }
	}

	#[cfg(all(unix, target_os = "linux"))]
	fn io_with_context(source: io::Error, context: String) -> Self {
		Self::Io { context: Some(context), source }
	}
}

impl fmt::Display for MkdirError {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Message(message) => formatter.write_str(message),
			Self::Io { context, source } => {
				if let Some(context) = context {
					write!(formatter, "{context}: ")?;
				}
				formatter.write_str(&normalized_io_message(source))
			},
		}
	}
}

fn normalized_io_message(error: &io::Error) -> String {
	if error.raw_os_error().is_none() {
		return error.to_string();
	}

	use io::ErrorKind::{
		AddrInUse, AddrNotAvailable, AlreadyExists, BrokenPipe, ConnectionAborted,
		ConnectionRefused, ConnectionReset, Interrupted, InvalidData, InvalidInput, NotConnected,
		NotFound, PermissionDenied, TimedOut, UnexpectedEof, WouldBlock, WriteZero,
	};
	match error.kind() {
		NotFound => "No such file or directory".into(),
		PermissionDenied => "Permission denied".into(),
		ConnectionRefused => "Connection refused".into(),
		ConnectionReset => "Connection reset".into(),
		ConnectionAborted => "Connection aborted".into(),
		NotConnected => "Not connected".into(),
		AddrInUse => "Address in use".into(),
		AddrNotAvailable => "Address not available".into(),
		BrokenPipe => "Broken pipe".into(),
		AlreadyExists => "Already exists".into(),
		WouldBlock => "Would block".into(),
		InvalidInput => "Invalid input".into(),
		InvalidData => "Invalid data".into(),
		TimedOut => "Timed out".into(),
		WriteZero => "Write zero".into(),
		Interrupted => "Interrupted".into(),
		UnexpectedEof => "Unexpected end of file".into(),
		_ => error
			.to_string()
			.split_once(" (os error ")
			.map_or_else(|| error.to_string(), |(message, _)| message.to_string()),
	}
}


pub(crate) struct Mkdir {
	matches: ArgMatches,
}

matches_parser!(Mkdir, app);

impl Utility for Mkdir {
	const NAME: &'static str = "mkdir";

	fn run(self, host: &mut Host) -> i32 {
		let dirs = self
			.matches
			.get_many::<OsString>(options::DIRS)
			.unwrap_or_default();
		let config = match get_mode(&self.matches) {
			Ok(mode) => Config {
				recursive: self.matches.get_flag(options::PARENTS),
				mode,
				verbose: self.matches.get_flag(options::VERBOSE),
			},
			Err(message) => {
				host.error(message, 1);
				return 1;
			},
		};

		exec(dirs, &config, host);
		host.exit_code()
	}
}

fn app() -> Command {
	Command::new(Mkdir::NAME)
		.version("0.8.0")
		.about("Create the given DIRECTORY(ies) if they do not exist")
		.override_usage(format_usage("mkdir [OPTION]... DIRECTORY..."))
		.infer_long_args(true)
		.after_help("Each MODE is of the form [ugoa]*([-+=]([rwxXst]*|[ugo]))+|[-+=]?[0-7]+.")
		.arg(
			Arg::new(options::MODE)
				.short('m')
				.long(options::MODE)
				.help("set file mode")
				.allow_hyphen_values(true)
				.num_args(1),
		)
		.arg(
			Arg::new(options::PARENTS)
				.short('p')
				.long(options::PARENTS)
				.help("make parent directories as needed")
				.overrides_with(options::PARENTS)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::VERBOSE)
				.short('v')
				.long(options::VERBOSE)
				.help("print a message for each printed directory")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::SECURITY_CONTEXT)
				.short('Z')
				.help("set SELinux security context of each created directory to the default type")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::CONTEXT)
				.long(options::CONTEXT)
				.value_name("CTX")
				.help(
					"like -Z, or if CTX is specified then set the SELinux or SMACK security context to \
					 CTX",
				),
		)
		.arg(
			Arg::new(options::DIRS)
				.action(ArgAction::Append)
				.num_args(1..)
				.required(true)
				.value_parser(ValueParser::os_string())
				.value_hint(clap::ValueHint::DirPath),
		)
}

fn exec(dirs: ValuesRef<'_, OsString>, config: &Config, host: &mut Host) {
	for dir in dirs {
		if let Err(error) = mkdir(Path::new(dir), config, host) {
			host.error(error, 1);
		}
	}
}


fn mkdir(path: &Path, config: &Config, host: &mut Host) -> Result<(), MkdirError> {
	if path.as_os_str().is_empty() {
		return Err(MkdirError::Message(
			"cannot create directory '': No such file or directory".into(),
		));
	}

	let path = fs::dir_strip_dot_for_creation(path);
	create_dir(&path, false, config, host)
}

#[cfg(all(unix, target_os = "linux"))]
fn chmod(fs_path: &Path, display_path: &Path, mode: u32) -> Result<(), MkdirError> {
	use std::{
		fs::{Permissions, set_permissions},
		os::unix::fs::PermissionsExt,
	};

	set_permissions(fs_path, Permissions::from_mode(mode)).map_err(|source| {
		MkdirError::io_with_context(
			source,
			format!("cannot set permissions {}", display_path.quote()),
		)
	})
}


fn create_dir(
	path: &Path,
	is_parent: bool,
	config: &Config,
	host: &mut Host,
) -> Result<(), MkdirError> {
	let path_exists = host.resolve(path).exists();
	if path_exists && !config.recursive {
		return Err(MkdirError::Message(format!("{}: File exists", path.maybe_quote())));
	}
	if path == Path::new("") {
		return Ok(());
	}

	if config.recursive {
		let mut dirs_to_create = Vec::with_capacity(16);
		let mut current = path;
		while let Some(parent) = current.parent() {
			if parent == Path::new("") {
				break;
			}
			dirs_to_create.push(parent);
			current = parent;
		}

		for dir in dirs_to_create.iter().rev() {
			if !host.resolve(dir).exists() {
				create_single_dir(dir, true, config, host)?;
			}
		}
	}

	create_single_dir(path, is_parent, config, host)
}


#[cfg(unix)]
struct UmaskGuard(rustix::fs::Mode);

#[cfg(unix)]
impl UmaskGuard {
	fn set(new_mask: rustix::fs::Mode) -> Self {
		let old_mask = rustix::process::umask(new_mask);
		Self(old_mask)
	}
}

#[cfg(unix)]
impl Drop for UmaskGuard {
	fn drop(&mut self) {
		rustix::process::umask(self.0);
	}
}

#[cfg(unix)]
fn create_dir_with_mode(path: &Path, mode: u32) -> io::Result<()> {
	use std::os::unix::fs::DirBuilderExt;


	let _guard = UmaskGuard::set(rustix::fs::Mode::empty());
	std::fs::DirBuilder::new().mode(mode).create(path)
}

#[cfg(not(unix))]
fn create_dir_with_mode(path: &Path, _mode: u32) -> io::Result<()> {
	std::fs::create_dir(path)
}

fn create_single_dir(
	path: &Path,
	is_parent: bool,
	config: &Config,
	host: &mut Host,
) -> Result<(), MkdirError> {
	let fs_path = host.resolve(path);
	#[cfg(all(unix, target_os = "linux"))]
	let path_exists = fs_path.exists();

	#[cfg(unix)]
	let create_mode = if is_parent {

		(!mode::get_umask() & 0o777) | 0o300
	} else {
		config.mode
	};
	#[cfg(not(unix))]
	let create_mode = config.mode;

	match create_dir_with_mode(&fs_path, create_mode) {
		Ok(()) => {
			if config.verbose {
				writeln!(host.stdout, "mkdir: created directory {}", path.quote())
					.map_err(MkdirError::io)?;
			}

			#[cfg(all(unix, target_os = "linux"))]
			if !path_exists {
				let acl_perm_bits = fsxattr::get_acl_perm_bits_from_xattr(&fs_path);
				if acl_perm_bits != 0 {
					chmod(&fs_path, path, create_mode | acl_perm_bits)?;
				}
			}

			Ok(())
		},
		Err(_) if fs_path.is_dir() => {
			let ends_with_parent_dir =
				matches!(path.components().next_back(), Some(std::path::Component::ParentDir));
			if config.verbose && is_parent && config.recursive && !ends_with_parent_dir {
				writeln!(host.stdout, "mkdir: created directory {}", path.quote())
					.map_err(MkdirError::io)?;
			}
			Ok(())
		},
		Err(source) => Err(MkdirError::io(source)),
	}
}


pub(crate) fn mkdir_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Mkdir, SE>()
}


