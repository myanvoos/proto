






use std::{
	ffi::{OsStr, OsString},
	fs::{self, File, OpenOptions},
	io::{self, Read, Write},
	path::{Path, PathBuf},
	sync::atomic::{AtomicU64, Ordering},
	time::{SystemTime, UNIX_EPOCH},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};

use crate::host::{Host, Utility, format_usage, matches_parser, util};

const OPT_APPEND: &str = "append";
const ARG_FILE: &str = "file";
const CHUNK_SIZE: usize = 64 * 1024;


pub(crate) struct Sponge {
	matches: ArgMatches,
}

matches_parser!(Sponge, command);

impl Utility for Sponge {
	const NAME: &'static str = "sponge";

	fn run(self, host: &mut Host) -> i32 {


		let buffer = match soak_stdin(host) {
			Ok(buffer) => buffer,
			Err(SoakError::Cancelled) => return 130,
			Err(SoakError::Io(err)) => {
				host.error(format_args!("stdin: {err}"), 1);
				return 1;
			},
		};

		let Some(file) = self.matches.get_one::<OsString>(ARG_FILE) else {
			if let Err(err) = host.stdout.write_all(&buffer).and_then(|()| host.stdout.flush()) {
				host.error(format_args!("stdout: {err}"), 1);
				return 1;
			}
			return 0;
		};

		let target = host.resolve(file);
		let result = if self.matches.get_flag(OPT_APPEND) {
			append_to(&target, &buffer)
		} else {
			replace_atomically(&target, &buffer)
		};
		match result {
			Ok(()) => 0,
			Err(err) => {
			host.error(format_args!("{}: {err}", file.to_string_lossy()), 1);
				1
			},
		}
	}
}

fn command() -> Command {
	Command::new("sponge")
		.version("sponge (pi-shell) 17.2.11")
		.about("Soak up all standard input, then write it to a file.")
		.override_usage(format_usage("sponge [-a] [FILE]"))
		.disable_help_flag(true)
		.disable_version_flag(true)
		.arg(
			Arg::new(OPT_APPEND)
				.short('a')
				.long(OPT_APPEND)
				.help("append the soaked input to the file instead of replacing it")
				.action(ArgAction::SetTrue),
		)
		.arg(Arg::new("help").long("help").action(ArgAction::Help))
		.arg(
			Arg::new("version")
				.long("version")
				.action(ArgAction::Version),
		)
		.arg(
			Arg::new(ARG_FILE)
				.value_name("FILE")
				.value_parser(clap::value_parser!(OsString)),
		)
}

enum SoakError {
	Cancelled,
	Io(io::Error),
}



fn soak_stdin(host: &mut Host) -> Result<Vec<u8>, SoakError> {
	let mut buffer = Vec::new();
	let mut chunk = vec![0u8; CHUNK_SIZE].into_boxed_slice();
	loop {
		if host.is_cancelled() {
			return Err(SoakError::Cancelled);
		}
		match host.stdin.read(&mut chunk) {
			Ok(0) if host.is_cancelled() => return Err(SoakError::Cancelled),
			Ok(0) => return Ok(buffer),
			Ok(n) => buffer.extend_from_slice(&chunk[..n]),
			Err(err) if err.kind() == io::ErrorKind::Interrupted => {},
			Err(err) => return Err(SoakError::Io(err)),
		}
	}
}

fn append_to(target: &Path, buffer: &[u8]) -> io::Result<()> {
	let mut file = OpenOptions::new().append(true).create(true).open(target)?;
	file.write_all(buffer)?;
	file.flush()
}




fn replace_atomically(target: &Path, buffer: &[u8]) -> io::Result<()> {
	let (temp_path, mut temp) = create_sibling_temp(target)?;
	let result = write_and_swap(target, &temp_path, &mut temp, buffer);
	if result.is_err() {
		let _ = fs::remove_file(&temp_path);
	}
	result
}

fn write_and_swap(
	target: &Path,
	temp_path: &Path,
	temp: &mut File,
	buffer: &[u8],
) -> io::Result<()> {
	temp.write_all(buffer)?;
	temp.flush()?;
	if let Ok(metadata) = fs::metadata(target) {
		fs::set_permissions(temp_path, metadata.permissions())?;
	}
	fs::rename(temp_path, target)
}



fn create_sibling_temp(target: &Path) -> io::Result<(PathBuf, File)> {
	static COUNTER: AtomicU64 = AtomicU64::new(0);
	let dir = target
		.parent()
		.filter(|p| !p.as_os_str().is_empty())
		.unwrap_or_else(|| Path::new("."));
	let base = target
		.file_name()
		.unwrap_or_else(|| OsStr::new("sponge"))
		.to_string_lossy();
	for _ in 0..32 {
		let nanos = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.map_or(0, |duration| duration.subsec_nanos() as u64);
		let tag = nanos
			.wrapping_mul(0x9e37_79b9_7f4a_7c15)
			.wrapping_add(COUNTER.fetch_add(1, Ordering::Relaxed))
			.wrapping_add(std::process::id() as u64);
		let path = dir.join(format!(".{base}.sponge.{tag:016x}"));
		match OpenOptions::new().write(true).create_new(true).open(&path) {
			Ok(file) => return Ok((path, file)),
			Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {},
			Err(err) => return Err(err),
		}
	}
	Err(io::Error::new(
		io::ErrorKind::AlreadyExists,
		"could not create temporary file",
	))
}


pub(crate) fn sponge_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Sponge, SE>()
}


