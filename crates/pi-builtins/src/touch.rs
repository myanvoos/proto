



#[cfg(unix)]
use std::fs::OpenOptions;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::{
	borrow::Cow,
	ffi::{OsStr, OsString},
	fs::{self, File},
	io::{Error, ErrorKind},
	path::{Path, PathBuf},
	time::SystemTime,
};

use clap::{
	Arg, ArgAction, ArgGroup, ArgMatches, Command,
	builder::{PossibleValue, ValueParser},
};
use filetime::{FileTime, set_file_times, set_symlink_file_times};
use jiff::{Timestamp, ToSpan, Zoned, civil::Time, fmt::strtime, tz::TimeZone};
#[cfg(unix)]
use libc::O_NONBLOCK;
#[cfg(unix)]
use rustix::fs::Timestamps;
#[cfg(unix)]
use rustix::fs::futimens;
#[cfg(target_os = "linux")]
use uucore::libc;
use uucore::{display::Quotable, parser::shortcut_value_parser::ShortcutValueParser};

use brush_core::{ShellExtensions, builtins::Registration};
use thiserror::Error as ThisError;

use crate::host::{Host, Utility, format_usage, matches_parser, util};

#[derive(Debug, ThisError)]
enum TouchError {
	#[error("Unable to parse date: {0}")]
	InvalidDateFormat(String),
	#[error("Source has invalid access or modification time: {0}")]
	InvalidFiletime(FileTime),
	#[error("failed to get attributes of {}: {}", .0.quote(), io_error(.1))]
	ReferenceFileInaccessible(PathBuf, std::io::Error),
	#[cfg(windows)]
	#[error("GetFinalPathNameByHandleW failed with code {0}")]
	WindowsStdoutPathError(String),
	#[error("{0}")]
	Message(String),
}

fn io_error(error: &std::io::Error) -> String {
	if error.raw_os_error().is_some() {
		match error.kind() {
			ErrorKind::NotFound => "No such file or directory".into(),
			ErrorKind::PermissionDenied => "Permission denied".into(),
			ErrorKind::AlreadyExists => "Already exists".into(),
			ErrorKind::WouldBlock => "Would block".into(),
			_ => error.to_string().split(" (os error ").next().unwrap_or_default().into(),
		}
	} else {
		error.to_string()
	}
}

fn io_context(error: std::io::Error, context: impl std::fmt::Display) -> TouchError {
	TouchError::Message(format!("{context}: {}", io_error(&error)))
}









#[derive(Debug, Clone, Eq, PartialEq)]
struct Options {

	no_create: bool,



	no_deref: bool,


	source: Source,


	date: Option<String>,


	change_times: ChangeTimes,



	strict: bool,
}

enum InputFile {

	Path(PathBuf),

	Stdout,
}


#[derive(Debug, Clone, Eq, PartialEq)]
enum ChangeTimes {

	AtimeOnly,

	MtimeOnly,

	Both,
}

#[derive(Debug, Clone, Eq, PartialEq)]
enum Source {

	Reference(PathBuf),
	Timestamp(FileTime),

	Now,
}

mod options {


	pub static SOURCES: &str = "sources";
	pub mod sources {
		pub static DATE: &str = "date";
		pub static REFERENCE: &str = "reference";
		pub static TIMESTAMP: &str = "timestamp";
	}
	pub static HELP: &str = "help";
	pub static ACCESS: &str = "access";
	pub static MODIFICATION: &str = "modification";
	pub static NO_CREATE: &str = "no-create";
	pub static NO_DEREF: &str = "no-dereference";
	pub static TIME: &str = "time";
	pub static FORCE: &str = "force";
}

static ARG_FILES: &str = "files";

mod format {
	pub(crate) const POSIX_LOCALE: &str = "%a %b %e %H:%M:%S %Y";
	pub(crate) const ISO_8601: &str = "%Y-%m-%d";

	pub(crate) const YYYYMMDDHHMM_DOT_SS: &str = "%Y%m%d%H%M.%S";

	pub(crate) const YYYYMMDDHHMMSS: &str = "%Y-%m-%d %H:%M:%S.%f";

	pub(crate) const YYYYMMDDHHMMS: &str = "%Y-%m-%d %H:%M:%S";


	pub(crate) const YYYY_MM_DD_HH_MM: &str = "%Y-%m-%d %H:%M";

	pub(crate) const YYYYMMDDHHMM: &str = "%Y%m%d%H%M";


	pub(crate) const YYYYMMDDHHMM_OFFSET: &str = "%Y-%m-%d %H:%M %z";
}

fn timestamp_to_filetime(ts: Timestamp) -> FileTime {
	FileTime::from_system_time(SystemTime::from(ts))
}

fn filetime_to_zoned(ft: &FileTime, time_zone: &TimeZone) -> Option<Zoned> {
	let ts = Timestamp::new(ft.unix_seconds(), ft.nanoseconds() as i32).ok()?;
	Some(Zoned::new(ts, time_zone.clone()))
}

fn host_time_zone(host: &Host) -> TimeZone {
	let Some(name) = host.var("TZ") else {
		return TimeZone::system();
	};
	TimeZone::get(name)
		.or_else(|_| TimeZone::posix(name))
		.unwrap_or(TimeZone::UTC)
}


fn all_digits(s: &str) -> bool {
	s.as_bytes().iter().all(u8::is_ascii_digit)
}





fn get_year(s: &str) -> u8 {
	let bytes = s.as_bytes();
	let n = bytes.len();
	let y1 = bytes[n - 2] - b'0';
	let y2 = bytes[n - 1] - b'0';
	10 * y1 + y2
}


fn is_first_filename_timestamp(
	reference: Option<&OsString>,
	date: Option<&str>,
	timestamp: Option<&str>,
	files: &[&OsString],
	posix2_version: Option<&str>,
) -> bool {
	timestamp.is_none()
		&& reference.is_none()
		&& date.is_none()
		&& files.len() >= 2

		&& posix2_version == Some("199209")
		&& files[0].to_str().is_some_and(is_timestamp)
}



fn is_timestamp(s: &str) -> bool {
	all_digits(s) && (s.len() == 8 || (s.len() == 10 && (69..=99).contains(&get_year(s))))
}




fn shr2(s: &str) -> String {
	let n = s.len();
	let (a, b) = s.split_at(n - 2);
	let mut result = String::with_capacity(n);
	result.push_str(b);
	result.push_str(a);
	result
}


pub(crate) struct Touch {
	matches: ArgMatches,
}

matches_parser!(Touch, uu_app);

impl Utility for Touch {
	const NAME: &'static str = "touch";

	fn run(self, host: &mut Host) -> i32 {
		if let Err(error) = touch_main(&self.matches, host) {
			host.error(error, 1);
		}
		host.exit_code()
	}
}

fn touch_main(matches: &ArgMatches, host: &mut Host) -> Result<(), TouchError> {
	let mut filenames: Vec<&OsString> = matches
		.get_many::<OsString>(ARG_FILES)
		.ok_or_else(|| TouchError::Message(
			"missing file operand\nTry 'touch --help' for more information.".into(),
		))?
		.collect();

	let no_deref = matches.get_flag(options::NO_DEREF);

	let reference = matches.get_one::<OsString>(options::sources::REFERENCE);
	let date = matches
		.get_one::<String>(options::sources::DATE)
		.map(ToOwned::to_owned);

	let mut timestamp = matches
		.get_one::<String>(options::sources::TIMESTAMP)
		.map(ToOwned::to_owned);

	if is_first_filename_timestamp(
		reference,
		date.as_deref(),
		timestamp.as_deref(),
		&filenames,
		host.var("_POSIX2_VERSION"),
	) {
		let first_file = filenames[0].to_str().unwrap();
		timestamp = if first_file.len() == 10 {
			Some(shr2(first_file))
		} else {
			Some(first_file.to_string())
		};
		filenames = filenames[1..].to_vec();
	}

	let time_zone = host_time_zone(host);
	let source = if let Some(reference) = reference {
		Source::Reference(PathBuf::from(reference))
	} else if let Some(ts) = timestamp {
		Source::Timestamp(parse_timestamp(&ts, &time_zone)?)
	} else {
		Source::Now
	};

	let files: Vec<InputFile> = filenames
		.into_iter()
		.map(|filename| {
			if filename == "-" {
				InputFile::Stdout
			} else {
				InputFile::Path(PathBuf::from(filename))
			}
		})
		.collect();

	let opts = Options {
		no_create: matches.get_flag(options::NO_CREATE),
		no_deref,
		source,
		date,
		change_times: determine_atime_mtime_change(matches),
		strict: false,
	};

	touch(&files, &opts, host, &time_zone)?;

	Ok(())
}

fn uu_app() -> Command {
	Command::new("touch")
		.version("0.8.0")
		.about("Update the access and modification times of each FILE to the current time.")
		.override_usage(format_usage("touch [OPTION]... [FILE]..."))
		.infer_long_args(true)
		.disable_help_flag(true)
		.arg(
			Arg::new(options::HELP)
				.long(options::HELP)
				.help("Print help information.")
				.action(ArgAction::Help),
		)
		.arg(
			Arg::new(options::ACCESS)
				.short('a')
				.help("change only the access time")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::sources::TIMESTAMP)
				.short('t')
				.help("use [[CC]YY]MMDDhhmm[.ss] instead of the current time")
				.value_name("STAMP"),
		)
		.arg(
			Arg::new(options::sources::DATE)
				.short('d')
				.long(options::sources::DATE)
				.allow_hyphen_values(true)
				.help("parse argument and use it instead of current time")
				.value_name("STRING")
				.conflicts_with(options::sources::TIMESTAMP),
		)
		.arg(
			Arg::new(options::FORCE)
				.short('f')
				.help("(ignored)")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::MODIFICATION)
				.short('m')
				.help("change only the modification time")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::NO_CREATE)
				.short('c')
				.long(options::NO_CREATE)
				.help("do not create any files")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::NO_DEREF)
				.short('h')
				.long(options::NO_DEREF)
				.help(
					"affect each symbolic link instead of any referenced file (only for systems that \
					 can change the timestamps of a symlink)",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::sources::REFERENCE)
				.short('r')
				.long(options::sources::REFERENCE)
				.help("use this file's times instead of the current time")
				.value_name("FILE")
				.value_parser(ValueParser::os_string())
				.value_hint(clap::ValueHint::AnyPath)
				.conflicts_with(options::sources::TIMESTAMP),
		)
		.arg(
			Arg::new(options::TIME)
				.long(options::TIME)
				.help(
					"change only the specified time: \"access\", \"atime\", or \"use\" are equivalent \
					 to -a; \"modify\" or \"mtime\" are equivalent to -m",
				)
				.value_name("WORD")
				.value_parser(ShortcutValueParser::new([
					PossibleValue::new("atime").alias("access").alias("use"),
					PossibleValue::new("mtime").alias("modify"),
				])),
		)
		.arg(
			Arg::new(ARG_FILES)
				.action(ArgAction::Append)
				.num_args(1..)
				.value_parser(clap::value_parser!(OsString))
				.value_hint(clap::ValueHint::AnyPath),
		)
		.group(
			ArgGroup::new(options::SOURCES)
				.args([
					options::sources::TIMESTAMP,
					options::sources::DATE,
					options::sources::REFERENCE,
				])
				.multiple(true),
		)
}


















fn touch(
	files: &[InputFile],
	opts: &Options,
	host: &mut Host,
	time_zone: &TimeZone,
) -> Result<(), TouchError> {
	let (atime, mtime) = match &opts.source {
		Source::Reference(reference) => {
			let resolved = host.resolve(reference);
			stat(&resolved, !opts.no_deref)
				.map_err(|error| TouchError::ReferenceFileInaccessible(reference.to_owned(), error))?
		},
		Source::Now => {
			let now: FileTime;
			#[cfg(target_os = "linux")]
			{
				if opts.date.is_none() {
					now = FileTime::from_unix_time(0, libc::UTIME_NOW as u32);
				} else {
					now = timestamp_to_filetime(Timestamp::now());
				}
			}
			#[cfg(not(target_os = "linux"))]
			{
				now = timestamp_to_filetime(Timestamp::now());
			}
			(now, now)
		},
		&Source::Timestamp(ts) => (ts, ts),
	};

	let (atime, mtime) = if let Some(date) = &opts.date {
		(
			parse_date(
				filetime_to_zoned(&atime, time_zone)
					.ok_or(TouchError::InvalidFiletime(atime))?,
				date,
				time_zone,
			)?,
			parse_date(
				filetime_to_zoned(&mtime, time_zone)
					.ok_or(TouchError::InvalidFiletime(mtime))?,
				date,
				time_zone,
			)?,
		)
	} else {
		(atime, mtime)
	};

	for file in files {
		let (path, is_stdout) = match file {
			InputFile::Stdout => (Cow::Owned(pathbuf_from_stdout()?), true),
			InputFile::Path(path) => (Cow::Borrowed(path), false),
		};
		touch_file(&path, is_stdout, opts, atime, mtime, host)?;
	}

	Ok(())
}










fn touch_file(
	path: &Path,
	is_stdout: bool,
	opts: &Options,
	atime: FileTime,
	mtime: FileTime,
	host: &mut Host,
) -> Result<(), TouchError> {
	let filename = if is_stdout { OsStr::new("-") } else { path.as_os_str() };
	let resolved = host.resolve(path);

	let metadata_result =
		if opts.no_deref { resolved.symlink_metadata() } else { resolved.metadata() };

	if let Err(error) = metadata_result {
		if error.kind() != ErrorKind::NotFound {
			return Err(io_context(error, format!("setting times of {}", filename.quote())));
		}

		if opts.no_create {
			return Ok(());
		}

		if opts.no_deref {
			let error =
				format!("setting times of {}: No such file or directory", filename.quote());
			if opts.strict {
				return Err(TouchError::Message(error));
			}
			host.error(error, 1);
			return Ok(());
		}

		if let Err(error) = File::create(&resolved) {


			let is_directory = path
				.to_string_lossy()
				.chars()
				.next_back()
				.is_some_and(|last| last == std::path::MAIN_SEPARATOR);
			let error = if is_directory {
				io_context(
					Error::other("No such file or directory"),
					format!("cannot touch {}", filename.quote()),
				)
			} else {
				io_context(error, format!("cannot touch {}", path.quote()))
			};
			if opts.strict {
				return Err(error);
			}
			host.error(error, 1);
			return Ok(());
		}



		if opts.source == Source::Now && opts.date.is_none() {
			return Ok(());
		}
	}

	update_times(path, &resolved, is_stdout, opts, atime, mtime)
}







fn determine_atime_mtime_change(matches: &ArgMatches) -> ChangeTimes {


	let time_access_only = if matches.contains_id(options::TIME) {
		matches
			.get_one::<String>(options::TIME)
			.map(|time| time.contains("access") || time.contains("atime") || time.contains("use"))
	} else {
		None
	};

	let atime_only = matches.get_flag(options::ACCESS) || time_access_only.unwrap_or_default();
	let mtime_only = matches.get_flag(options::MODIFICATION) || !time_access_only.unwrap_or(true);

	if atime_only && !mtime_only {
		ChangeTimes::AtimeOnly
	} else if mtime_only && !atime_only {
		ChangeTimes::MtimeOnly
	} else {
		ChangeTimes::Both
	}
}






fn update_times(
	path: &Path,
	resolved: &Path,
	is_stdout: bool,
	opts: &Options,
	atime: FileTime,
	mtime: FileTime,
) -> Result<(), TouchError> {

	let (atime, mtime) = match opts.change_times {
		ChangeTimes::AtimeOnly => (
			atime,
			stat(resolved, !opts.no_deref)
				.map_err(|error| {
					io_context(error, format!("failed to get attributes of {}", path.quote()))
				})?
				.1,
		),
		ChangeTimes::MtimeOnly => (
			stat(resolved, !opts.no_deref)
				.map_err(|error| {
					io_context(error, format!("failed to get attributes of {}", path.quote()))
				})?
				.0,
			mtime,
		),
		ChangeTimes::Both => (atime, mtime),
	};

	if opts.no_deref && !is_stdout {
		return set_symlink_file_times(resolved, atime, mtime)
			.map_err(|error| io_context(error, format!("setting times of {}", path.quote())));
	}

	#[cfg(unix)]
	{

		if !is_stdout && try_futimens_via_write_fd(resolved, atime, mtime).is_ok() {
			return Ok(());
		}
	}

	set_file_times(resolved, atime, mtime)
		.map_err(|error| io_context(error, format!("setting times of {}", path.quote())))
}

#[cfg(unix)]





fn try_futimens_via_write_fd(path: &Path, atime: FileTime, mtime: FileTime) -> std::io::Result<()> {
	let file = OpenOptions::new()
		.write(true)

		.custom_flags(O_NONBLOCK)
		.open(path)?;

	let timestamps = Timestamps {
		last_access:       rustix::fs::Timespec {
			tv_sec:  atime.unix_seconds(),
			tv_nsec: atime.nanoseconds() as _,
		},
		last_modification: rustix::fs::Timespec {
			tv_sec:  mtime.unix_seconds(),
			tv_nsec: mtime.nanoseconds() as _,
		},
	};

	futimens(&file, &timestamps).map_err(|e| Error::from_raw_os_error(e.raw_os_error()))
}





fn stat(path: &Path, follow: bool) -> std::io::Result<(FileTime, FileTime)> {
	let metadata = if follow {
		match fs::metadata(path) {

			Ok(meta) => meta,

			Err(e) if e.kind() == ErrorKind::NotFound => return Err(e),

			Err(_) => fs::symlink_metadata(path)?,
		}
	} else {
		fs::symlink_metadata(path)?
	};

	Ok((
		FileTime::from_last_access_time(&metadata),
		FileTime::from_last_modification_time(&metadata),
	))
}

fn parse_date(ref_zoned: Zoned, s: &str, time_zone: &TimeZone) -> Result<FileTime, TouchError> {














	if let Ok(parsed) = strtime::parse(format::POSIX_LOCALE, s)
		.and_then(|tm| tm.to_datetime())
		.and_then(|dt| TimeZone::UTC.to_zoned(dt))
	{
		return Ok(timestamp_to_filetime(parsed.timestamp()));
	}




	for fmt in [
		format::YYYYMMDDHHMMS,
		format::YYYYMMDDHHMMSS,
		format::YYYY_MM_DD_HH_MM,
		format::YYYYMMDDHHMM_OFFSET,
	] {
		if let Ok(parsed) = strtime::parse(fmt, s)
			.and_then(|tm| tm.to_datetime())
			.and_then(|dt| TimeZone::UTC.to_zoned(dt))
		{
			return Ok(timestamp_to_filetime(parsed.timestamp()));
		}
	}



	if let Ok(filetime) = strtime::parse(format::ISO_8601, s)
		.and_then(|tm| tm.to_date())
		.and_then(|date| {
			time_zone
				.to_ambiguous_zoned(date.to_datetime(Time::midnight()))
				.unambiguous()
		})
		.map(|zdt| timestamp_to_filetime(zdt.timestamp()))
	{
		return Ok(filetime);
	}



	if s.bytes().next() == Some(b'@')
		&& let Ok(ts) = &s[1..].parse::<i64>()
	{
		return Ok(FileTime::from_unix_time(*ts, 0));
	}

	if let Ok(zoned) = parse_datetime::parse_datetime_at_date(ref_zoned, s) {
		return Ok(timestamp_to_filetime(zoned.timestamp()));
	}

	Err(TouchError::InvalidDateFormat(s.to_owned()))
}







fn prepend_century(s: &str) -> Result<String, TouchError> {
	let first_two_digits = s[..2].parse::<u32>().map_err(|_| {
		TouchError::Message(format!("invalid date ts format {}", s.quote()))
	})?;
	Ok(format!("{}{s}", if first_two_digits > 68 { 19 } else { 20 }))
}









fn parse_timestamp(s: &str, time_zone: &TimeZone) -> Result<FileTime, TouchError> {
	use format::{YYYYMMDDHHMM, YYYYMMDDHHMM_DOT_SS};

	let current_year = || Timestamp::now().to_zoned(time_zone.clone()).year();

	let (format, ts) = match s.chars().count() {
		15 => (YYYYMMDDHHMM_DOT_SS, s.to_owned()),
		12 => (YYYYMMDDHHMM, s.to_owned()),

		13 => (YYYYMMDDHHMM_DOT_SS, prepend_century(s)?),
		10 => (YYYYMMDDHHMM, prepend_century(s)?),
		11 => (YYYYMMDDHHMM_DOT_SS, format!("{}{s}", current_year())),
		8 => (YYYYMMDDHHMM, format!("{}{s}", current_year())),
		_ => {
			return Err(TouchError::Message(format!("invalid date format {}", s.quote())));
		},
	};

	let mut dt = strtime::parse(format, &ts)
		.and_then(|parsed| parsed.to_datetime())
		.map_err(|_| TouchError::Message(format!("invalid date ts format {}", ts.quote())))?;





	if dt.second() == 59 && ts.ends_with(".60") {
		dt += 1.second();
	}




	let local = time_zone
		.to_ambiguous_zoned(dt)
		.unambiguous()
		.map_err(|_| TouchError::Message(format!("invalid date ts format {}", ts.quote())))?;

	Ok(timestamp_to_filetime(local.timestamp()))
}






#[cfg_attr(not(windows), expect(clippy::unnecessary_wraps))]
fn pathbuf_from_stdout() -> Result<PathBuf, TouchError> {
	#[cfg(all(unix, not(target_os = "android")))]
	{
		Ok(PathBuf::from("/dev/stdout"))
	}
	#[cfg(target_os = "android")]
	{
		Ok(PathBuf::from("/proc/self/fd/1"))
	}
	#[cfg(windows)]
	{
		use std::os::windows::prelude::AsRawHandle;

		use windows_sys::Win32::{
			Foundation::{
				ERROR_INVALID_PARAMETER, ERROR_NOT_ENOUGH_MEMORY, ERROR_PATH_NOT_FOUND, GetLastError,
				HANDLE, MAX_PATH,
			},
			Storage::FileSystem::{FILE_NAME_OPENED, GetFinalPathNameByHandleW},
		};

		let handle = std::io::stdout().lock().as_raw_handle() as HANDLE;
		let mut file_path_buffer: [u16; MAX_PATH as usize] = [0; MAX_PATH as usize];









		let ret = unsafe {
			GetFinalPathNameByHandleW(
				handle,
				file_path_buffer.as_mut_ptr(),
				file_path_buffer.len() as u32,
				FILE_NAME_OPENED,
			)
		};



		let buffer_size = match ret {
			ERROR_PATH_NOT_FOUND | ERROR_NOT_ENOUGH_MEMORY | ERROR_INVALID_PARAMETER => {
				return Err(TouchError::WindowsStdoutPathError(ret.to_string()));
			},
			0 => {
				return Err(TouchError::WindowsStdoutPathError(format!(
					"{}",

					unsafe { GetLastError() }
				)));
			},
			e => e as usize,
		};


		Ok(String::from_utf16(&file_path_buffer[0..buffer_size])
			.map_err(|e| TouchError::WindowsStdoutPathError(e.to_string()))?
			.into())
	}
	#[cfg(target_os = "wasi")]
	{
		Ok(PathBuf::from("/dev/stdout"))
	}
}


pub(crate) fn touch_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Touch, SE>()
}


