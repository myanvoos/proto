//! `uptime` builtin: tell how long the system has been running.
//!
//! Report line, user counting, and boot-time sources match the reference
//! output.

use std::{
	ffi::{OsStr, OsString},
	io::Write,
	path::Path,
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command, ValueHint, builder::ValueParser};
use jiff::{Timestamp, tz::TimeZone};

use crate::{
	host::{Host, Utility, format_usage, matches_parser, util},
	time_zone::shell_time_zone,
};

mod options {
	pub const SINCE: &str = "since";
	pub const PATH: &str = "path";
	pub const PRETTY: &str = "pretty";
}

/// The login-records file read when no FILE operand is given (gnulib's
/// `UTMP_FILE`).
#[cfg(target_vendor = "apple")]
const UTMP_FILE: &str = "/var/run/utmpx";
#[cfg(target_os = "linux")]
const UTMP_FILE: &str = "/var/run/utmp";
#[cfg(not(any(target_vendor = "apple", target_os = "linux")))]
const UTMP_FILE: &str = "/etc/utmp";

/// Parsed `uptime` invocation.
pub(crate) struct Uptime {
	matches: ArgMatches,
}

matches_parser!(Uptime, app);

impl Utility for Uptime {
	const NAME: &'static str = "uptime";

	fn run(self, host: &mut Host) -> i32 {
		// GNU: the default file has entries of dead login processes weeded
		// out; an explicit FILE is taken as is.
		let (name, check_pids) = match self.matches.get_one::<OsString>(options::PATH) {
			Some(file) => (file.as_os_str(), false),
			None => (OsStr::new(UTMP_FILE), true),
		};
		let utmp = read_utmp(host, name, check_pids);
		let now = Timestamp::now().as_second();
		let zone = shell_time_zone(host);

		let (text, status) = if self.matches.get_flag(options::SINCE) {
			match utmp.boot_time {
				Some(boot) => (format!("{}\n", since_line(boot, &zone)), 0),
				None => return boot_time_unknown(host),
			}
		} else if self.matches.get_flag(options::PRETTY) {
			match utmp.boot_time {
				None => return boot_time_unknown(host),
				Some(boot) if boot > now => {
					host.error("boot time larger than current time", 1);
					return 1;
				},
				Some(boot) => (format!("{}\n", pretty_uptime(now - boot)), 0),
			}
		} else {
			if utmp.boot_time.is_none() {
				boot_time_unknown(host);
			}
			let (line, complete) =
				uptime_line(now, &zone, utmp.boot_time, utmp.users, &load_average());
			(line, i32::from(!complete))
		};
		match host
			.stdout
			.write_all(text.as_bytes())
			.and_then(|()| host.stdout.flush())
		{
			Ok(()) => status,
			Err(error) => {
				host.error(error, 1);
				1
			},
		}
	}
}

/// GNU's diagnostic when no boot time could be determined; exit status 1.
fn boot_time_unknown(host: &mut Host) -> i32 {
	host.error("couldn't get boot time", 1);
	1
}

fn app() -> Command {
	Command::new("uptime")
		.version("0.8.0")
		.about(
			"Display the current time, the length of time the system has been up,\nthe number of \
			 users on the system, and the average number of jobs\nin the run queue over the last 1, \
			 5 and 15 minutes.",
		)
		.override_usage(format_usage("uptime [OPTION]... [FILE]"))
		.infer_long_args(true)
		.arg(
			Arg::new(options::SINCE)
				.short('s')
				.long(options::SINCE)
				.help("system up since")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::PATH)
				.help("file to search boot time from")
				.action(ArgAction::Set)
				.num_args(0..=1)
				.value_parser(ValueParser::os_string())
				.value_hint(ValueHint::AnyPath),
		)
		.arg(
			Arg::new(options::PRETTY)
				.short('p')
				.long(options::PRETTY)
				.help("show uptime in pretty format")
				.action(ArgAction::SetTrue),
		)
}

/// GNU's report line for `now`, plus whether every field was known (GNU
/// exits 1 when the uptime is not).
fn uptime_line(
	now: i64,
	zone: &TimeZone,
	boot_time: Option<i64>,
	users: usize,
	loads: &[f64],
) -> (String, bool) {
	let clock = Timestamp::from_second(now).map(|now| {
		now.to_zoned(zone.clone())
			.strftime(" %H:%M:%S  ")
			.to_string()
	});
	let mut complete = clock.is_ok();
	let mut line = clock.unwrap_or_else(|_| " ??:????  ".to_owned());
	match boot_time
		.and_then(|boot| now.checked_sub(boot))
		.filter(|uptime| *uptime >= 0)
	{
		Some(uptime) => line.push_str(&up_duration(uptime)),
		None => {
			line.push_str("up ???? days ??:??,  ");
			complete = false;
		},
	}
	line.push_str(&user_count(users));
	line.push_str(&load_suffix(loads));
	(line, complete)
}

/// GNU's `up …,  ` field for an uptime of `seconds`: `up  3:07,  ` under a
/// day, `up 2 days  3:07,  ` past it.
fn up_duration(seconds: i64) -> String {
	let days = seconds / 86400;
	let hours = seconds % 86400 / 3600;
	let minutes = seconds % 3600 / 60;
	match days {
		0 => format!("up {hours:2}:{minutes:02},  "),
		1 => format!("up 1 day {hours:2}:{minutes:02},  "),
		_ => format!("up {days} days {hours:2}:{minutes:02},  "),
	}
}

fn user_count(users: usize) -> String {
	if users == 1 {
		"1 user".to_owned()
	} else {
		format!("{users} users")
	}
}

/// What follows the user count: `,  load average: a, b, c` and the newline,
/// with as many averages as `getloadavg` produced. GNU prints only the
/// newline when the load average is unavailable.
fn load_suffix(loads: &[f64]) -> String {
	let mut suffix = String::new();
	for (index, load) in loads.iter().enumerate() {
		if index == 0 {
			suffix.push_str(&format!(",  load average: {load:.2}"));
		} else {
			suffix.push_str(&format!(", {load:.2}"));
		}
	}
	suffix.push('\n');
	suffix
}

/// `-p` output for an uptime of `seconds`, as uutils formats it.
fn pretty_uptime(seconds: i64) -> String {
	let plural = |count: i64, unit: &str| {
		if count == 1 {
			format!("1 {unit}")
		} else {
			format!("{count} {unit}s")
		}
	};
	let days = seconds / 86400;
	let hours = seconds % 86400 / 3600;
	let minutes = seconds % 3600 / 60;
	let mut parts = Vec::new();
	if days > 0 {
		parts.push(plural(days, "day"));
	}
	if hours > 0 {
		parts.push(plural(hours, "hour"));
	}
	if minutes > 0 || parts.is_empty() {
		parts.push(plural(minutes, "minute"));
	}
	format!("up {}", parts.join(", "))
}

/// `-s` output: the boot time in the shell's time zone.
fn since_line(boot: i64, zone: &TimeZone) -> String {
	match Timestamp::from_second(boot) {
		Ok(boot) => boot
			.to_zoned(zone.clone())
			.strftime("%Y-%m-%d %H:%M:%S")
			.to_string(),
		Err(_) => boot.to_string(),
	}
}

/// The system load averages over 1, 5, and 15 minutes; empty when the
/// platform has none (GNU's `getloadavg` returning -1).
fn load_average() -> Vec<f64> {
	#[cfg(any(
		target_os = "linux",
		target_vendor = "apple",
		target_os = "freebsd",
		target_os = "netbsd",
		target_os = "openbsd",
		target_os = "dragonfly",
	))]
	{
		let mut loads = [0.0_f64; 3];
		// SAFETY: `loads` has room for the three samples requested.
		let count = unsafe { libc::getloadavg(loads.as_mut_ptr(), 3) };
		loads[..usize::try_from(count).unwrap_or(0).min(3)].to_vec()
	}
	#[cfg(not(any(
		target_os = "linux",
		target_vendor = "apple",
		target_os = "freebsd",
		target_os = "netbsd",
		target_os = "openbsd",
		target_os = "dragonfly",
	)))]
	{
		Vec::new()
	}
}

/// What `uptime` learns from the login records.
#[derive(Debug, Default)]
struct UtmpSummary {
	/// The last `BOOT_TIME` record's time, or the system's boot time when the
	/// default file has none; `None` when unknown (or recorded as 0).
	boot_time: Option<i64>,
	/// `USER_PROCESS` records with a user name.
	users:     usize,
}

/// One login record, reduced to the fields `uptime` consults.
#[derive(Debug)]
struct Record {
	kind:          i16,
	pid:           i32,
	has_user:      bool,
	/// `user == "runlevel" && line == "~"`: Linux's run-level change record.
	runlevel_mark: bool,
	seconds:       i64,
}

const BOOT_TIME: i16 = 2;
const USER_PROCESS: i16 = 7;

/// gnulib's `read_utmp (name, …)` as `uptime` consumes it. `name` is the
/// operand as given: the system boot-time fallbacks apply only when it
/// spells the default file exactly.
///
/// The records are parsed here rather than through libc's `utmpxname` and
/// `getutxent` (or `uucore::utmpx`, which wraps them): that state is
/// process-global, so one shell's `uptime FILE` would redirect another's
/// default read; Apple's `getutxent` creates and signs a missing or empty
/// file; and only [`Host::fs`] reaches the shell's virtual paths.
fn read_utmp(host: &Host, name: &OsStr, check_pids: bool) -> UtmpSummary {
	let path = host.resolve(Path::new(name));
	let records = read_records(host, &path);
	let mut summary = UtmpSummary::default();
	let is_default = name == OsStr::new(UTMP_FILE);

	// gnulib's Raspbian workaround: a boot record stamped before the clock
	// was set takes the time of the later run-level record.
	let runlevel = records
		.iter()
		.rev()
		.find(|record| record.runlevel_mark)
		.map(|record| record.seconds);
	let mut first_boot = true;
	for record in &records {
		if record.kind == USER_PROCESS
			&& record.has_user
			&& !(check_pids && process_is_gone(record.pid))
		{
			summary.users += 1;
		}
		if record.kind == BOOT_TIME {
			let mut seconds = record.seconds;
			if cfg!(target_os = "linux") && is_default && first_boot && seconds <= 60 {
				seconds = runlevel.filter(|&time| time != 0).unwrap_or(seconds);
			}
			first_boot = false;
			summary.boot_time = Some(seconds);
		}
	}
	if is_default && first_boot {
		summary.boot_time = system_boot_time(host);
	}
	summary.boot_time = summary.boot_time.filter(|&boot| boot != 0);
	summary
}

/// Whether `kill(pid, 0)` reports no such process (`READ_UTMP_CHECK_PIDS`).
#[cfg(unix)]
fn process_is_gone(pid: i32) -> bool {
	// SAFETY: signal 0 only probes for the process; nothing is delivered.
	pid > 0
		&& unsafe { libc::kill(pid, 0) } < 0
		&& std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

#[cfg(not(unix))]
fn process_is_gone(_pid: i32) -> bool {
	false
}

/// macOS stores login records as 628-byte `utmpx32` entries behind a
/// signature record; libc's `getutxent` converts them to `struct utmpx`.
#[cfg(target_vendor = "apple")]
mod layout {
	pub const RECORD: usize = 628;
	pub const USER: usize = 0;
	pub const USER_LEN: usize = 256;
	pub const PID: usize = 292;
	pub const TYPE: usize = 296;
	pub const SECONDS: usize = 300;
	pub const SIGNATURE: &[u8] = b"utmpx-1.00";
	pub const SIGNATURE_TYPE: i16 = 10;
}

/// The bytes of `path` when it is a readable regular file. Anything else
/// holds no records: a directory or unreadable file reads as empty, and a
/// FIFO or device is not opened at all (GNU would block on a FIFO).
#[cfg(any(target_vendor = "apple", all(target_os = "linux", target_env = "gnu")))]
fn regular_file_bytes(_host: &Host, path: &Path) -> Vec<u8> {
	match std::fs::metadata(&path) {
		Ok(metadata) if metadata.is_file() => brush_core::heldfiles::read(&path).unwrap_or_default(),
		_ => Vec::new(),
	}
}

/// Reads the records of `path` as Apple libc's `getutxent` does: a file
/// whose first record is not the signature holds no entries.
#[cfg(target_vendor = "apple")]
fn read_records(host: &Host, path: &Path) -> Vec<Record> {
	use layout::*;

	let bytes = regular_file_bytes(host, path);
	let i16_at = |record: &[u8], at: usize| i16::from_ne_bytes([record[at], record[at + 1]]);
	let i32_at = |record: &[u8], at: usize| {
		i32::from_ne_bytes([record[at], record[at + 1], record[at + 2], record[at + 3]])
	};
	let mut chunks = bytes.chunks_exact(RECORD);
	let signed = chunks.next().is_some_and(|signature| {
		let user = &signature[USER..USER + USER_LEN];
		user.split(|&byte| byte == 0).next() == Some(SIGNATURE)
			&& i16_at(signature, TYPE) == SIGNATURE_TYPE
	});
	if !signed {
		return Vec::new();
	}
	chunks
		.map(|record| Record {
			kind:          i16_at(record, TYPE),
			pid:           i32_at(record, PID),
			has_user:      record[USER] != 0,
			// The run-level workaround is Linux-only.
			runlevel_mark: false,
			seconds:       i64::from(i32_at(record, SECONDS)),
		})
		.collect()
}

/// Reads glibc `struct utmpx` records; like `getutxent`, a trailing partial
/// record is ignored.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn read_records(host: &Host, path: &Path) -> Vec<Record> {
	let bytes = regular_file_bytes(host, path);
	let text = |field: &[libc::c_char]| -> Vec<u8> {
		field
			.iter()
			.map(|&c| c as u8)
			.take_while(|&byte| byte != 0)
			.collect()
	};
	bytes
		.chunks_exact(size_of::<libc::utmpx>())
		.map(|chunk| {
			// SAFETY: `chunk` holds exactly one `utmpx`, a plain-data struct
			// valid for any bit pattern; the read tolerates misalignment.
			let entry: libc::utmpx = unsafe { std::ptr::read_unaligned(chunk.as_ptr().cast()) };
			#[allow(clippy::useless_conversion, reason = "`tv_sec` is i32 or i64 by architecture")]
			let seconds = i64::from(entry.ut_tv.tv_sec);
			Record {
				kind: entry.ut_type,
				pid: entry.ut_pid,
				has_user: entry.ut_user[0] != 0,
				runlevel_mark: text(&entry.ut_user) == b"runlevel" && text(&entry.ut_line) == b"~",
				seconds,
			}
		})
		.collect()
}

/// Platforms whose login-record format is not modelled read no entries.
#[cfg(not(any(target_vendor = "apple", all(target_os = "linux", target_env = "gnu"))))]
fn read_records(_host: &Host, _path: &Path) -> Vec<Record> {
	Vec::new()
}

/// The kernel's boot time, which gnulib substitutes when the default file
/// has no boot record.
#[cfg(target_vendor = "apple")]
fn system_boot_time(_host: &Host) -> Option<i64> {
	let mut mib = [libc::CTL_KERN, libc::KERN_BOOTTIME];
	// SAFETY: an all-zero `timeval` is valid.
	let mut boot: libc::timeval = unsafe { std::mem::zeroed() };
	let mut len = size_of::<libc::timeval>();
	// SAFETY: `mib` names a read-only `timeval` sysctl and `boot`/`len`
	// describe a buffer of exactly that size; nothing is written to the kernel.
	let status = unsafe {
		libc::sysctl(
			mib.as_mut_ptr(),
			2,
			(&raw mut boot).cast(),
			&raw mut len,
			std::ptr::null_mut(),
			0,
		)
	};
	(status == 0).then_some(boot.tv_sec)
}

/// gnulib's Linux fallbacks: the modification time of a file only the boot
/// sequence touches, else now minus `CLOCK_BOOTTIME`.
#[cfg(target_os = "linux")]
fn system_boot_time(_host: &Host) -> Option<i64> {
	const BOOT_TOUCHED_FILES: [&str; 4] = [
		"/var/lib/systemd/random-seed",
		"/var/lib/urandom/random-seed",
		"/var/lib/random-seed",
		"/var/run/utmp",
	];
	// Older stamps are bogus (2005-07-25, predating the distros involved).
	const PLAUSIBLE: i64 = 1_122_334_455;
	for file in BOOT_TOUCHED_FILES {
		if let Some(mtime) = std::fs::metadata(file).ok().map(|metadata| {
			use std::os::unix::fs::MetadataExt;
			metadata.mtime()
		}) && mtime >= PLAUSIBLE
		{
			return Some(mtime);
		}
	}
	// SAFETY: an all-zero `timespec` is valid.
	let mut uptime: libc::timespec = unsafe { std::mem::zeroed() };
	// SAFETY: `uptime` is a valid out-pointer for the clock read.
	if unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &raw mut uptime) } != 0 {
		return None;
	}
	let uptime_ns = i128::from(uptime.tv_sec) * 1_000_000_000 + i128::from(uptime.tv_nsec);
	let boot_ns = Timestamp::now().as_nanosecond() - uptime_ns;
	i64::try_from(boot_ns.div_euclid(1_000_000_000)).ok()
}

/// Windows: now minus the milliseconds since boot.
#[cfg(windows)]
fn system_boot_time(_host: &Host) -> Option<i64> {
	use windows_sys::Win32::System::SystemInformation::GetTickCount64;
	// SAFETY: no preconditions.
	let since_boot = unsafe { GetTickCount64() } / 1000;
	Some(Timestamp::now().as_second() - i64::try_from(since_boot).ok()?)
}

#[cfg(not(any(target_vendor = "apple", target_os = "linux", windows)))]
fn system_boot_time(_host: &Host) -> Option<i64> {
	None
}

/// Creates the `uptime` builtin registration.
pub(crate) fn uptime_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Uptime, SE>()
}
