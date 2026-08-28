










use std::{
	io::{self, BufRead, BufReader, Write},
	sync::atomic::Ordering,
	time::Instant,
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};
use jiff::{Timestamp, fmt::strtime, tz::TimeZone};

use crate::host::{Host, Utility, format_usage, matches_parser, util};

const OPT_RELATIVE: &str = "relative";
const OPT_INCREMENTAL: &str = "incremental";
const OPT_SINCE_START: &str = "since-start";
const OPT_MONOTONIC: &str = "monotonic";
const ARG_FORMAT: &str = "format";

const DEFAULT_ABSOLUTE_FORMAT: &str = "%b %d %H:%M:%S";
const DEFAULT_ELAPSED_FORMAT: &str = "%H:%M:%S";


const SYSLOG_LEN: usize = 15;


pub(crate) struct Ts {
	matches: ArgMatches,
}

matches_parser!(Ts, command);

impl Utility for Ts {
	const NAME: &'static str = "ts";
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {
		match timestamp_lines(&self.matches, host) {
			Ok(code) => code,
			Err(err) if err.kind() == io::ErrorKind::BrokenPipe => 0,
			Err(err) => {
				host.error(err, 1);
				1
			},
		}
	}
}


fn command() -> Command {
	Command::new(Ts::NAME)
		.version("ts (pi-shell) 17.2.11")
		.about("Timestamp each line of standard input.")
		.override_usage(format_usage("ts [-r] [-i | -s] [-m] [FORMAT]"))
		.disable_help_flag(true)
		.disable_version_flag(true)
		.arg(
			Arg::new(OPT_RELATIVE)
				.short('r')
				.help("convert existing leading timestamps to relative times")
				.conflicts_with_all([OPT_INCREMENTAL, OPT_SINCE_START])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_INCREMENTAL)
				.short('i')
				.help("timestamp with the time elapsed since the last line")
				.conflicts_with(OPT_SINCE_START)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_SINCE_START)
				.short('s')
				.help("timestamp with the time elapsed since program start")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_MONOTONIC)
				.short('m')
				.help("use the monotonic clock for elapsed timestamps")
				.action(ArgAction::SetTrue),
		)
		.arg(Arg::new("help").long("help").action(ArgAction::Help))
		.arg(Arg::new("version").long("version").action(ArgAction::Version))
		.arg(
			Arg::new(ARG_FORMAT)
				.value_name("FORMAT")
				.help("strftime format string"),
		)
}


#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
	Absolute,
	SinceLast,
	SinceStart,
	Relative,
}

fn timestamp_lines(matches: &ArgMatches, host: &mut Host) -> io::Result<i32> {
	let mode = if matches.get_flag(OPT_RELATIVE) {
		Mode::Relative
	} else if matches.get_flag(OPT_INCREMENTAL) {
		Mode::SinceLast
	} else if matches.get_flag(OPT_SINCE_START) {
		Mode::SinceStart
	} else {
		Mode::Absolute
	};
	let monotonic = matches.get_flag(OPT_MONOTONIC);
	let default_format = if mode == Mode::Absolute {
		DEFAULT_ABSOLUTE_FORMAT
	} else {
		DEFAULT_ELAPSED_FORMAT
	};
	let format = expand_subseconds(
		matches
			.get_one::<String>(ARG_FORMAT)
			.map_or(default_format, String::as_str),
	);
	let tz = local_timezone(host.var("TZ"));

	if host.is_cancelled() {
		return Ok(130);
	}
	let cancel = host.cancel_flag();
	let mut reader = BufReader::new(&mut host.stdin);
	let out = &mut host.stdout;
	let start_wall = Timestamp::now();
	let start_mono = Instant::now();
	let mut last_wall = start_wall;
	let mut last_mono = start_mono;
	let mut buf = Vec::new();

	loop {
		if cancel.load(Ordering::Relaxed) {
			return Ok(130);
		}
		buf.clear();
		let n = reader.read_until(b'\n', &mut buf)?;
		if n == 0 {
			break;
		}
		let had_newline = buf.last() == Some(&b'\n');
		let content = if had_newline { &buf[..n - 1] } else { &buf[..] };

		match mode {
			Mode::Relative => {
				write_relative_line(out, content, Timestamp::now(), &tz)?;
			},
			Mode::Absolute => {
				let zoned = Timestamp::now().to_zoned(tz.clone());
				let stamp = strtime::format(&format, &zoned).map_err(io::Error::other)?;
				out.write_all(stamp.as_bytes())?;
				out.write_all(b" ")?;
				out.write_all(content)?;
			},
			Mode::SinceLast | Mode::SinceStart => {
				let nanos = if monotonic {
					let now = Instant::now();
					let anchor = if mode == Mode::SinceLast { last_mono } else { start_mono };
					last_mono = now;
					i128::try_from(now.duration_since(anchor).as_nanos()).unwrap_or(i128::MAX)
				} else {
					let now = Timestamp::now();
					let anchor = if mode == Mode::SinceLast { last_wall } else { start_wall };
					last_wall = now;
					now.duration_since(anchor).as_nanos().max(0)
				};
				let stamp = format_elapsed(nanos, &format).map_err(io::Error::other)?;
				out.write_all(stamp.as_bytes())?;
				out.write_all(b" ")?;
				out.write_all(content)?;
			},
		}
		if had_newline {
			out.write_all(b"\n")?;
		}

		out.flush()?;
	}
	Ok(0)
}


fn format_elapsed(nanos: i128, format: &str) -> Result<String, String> {
	let stamp = Timestamp::from_nanosecond(nanos).map_err(|err| err.to_string())?;
	strtime::format(format, &stamp.to_zoned(TimeZone::UTC)).map_err(|err| err.to_string())
}


fn local_timezone(tz: Option<&str>) -> TimeZone {
	if let Some(tz) = tz
		&& let Ok(tz) = TimeZone::get(tz)
	{
		return tz;
	}
	TimeZone::try_system().unwrap_or(TimeZone::UTC)
}


fn expand_subseconds(format: &str) -> String {
	let mut out = String::with_capacity(format.len());
	let bytes = format.as_bytes();
	let mut i = 0;
	while i < bytes.len() {
		if bytes[i] == b'%' && i + 1 < bytes.len() {
			match &bytes[i + 1..] {
				[b'%', ..] => {
					out.push_str("%%");
					i += 2;
					continue;
				},
				[b'.', b'S', ..] => {
					out.push_str("%S.%6f");
					i += 3;
					continue;
				},
				[b'.', b's', ..] => {
					out.push_str("%s.%6f");
					i += 3;
					continue;
				},
				[b'.', b'T', ..] => {
					out.push_str("%H:%M:%S.%6f");
					i += 3;
					continue;
				},
				_ => {},
			}
		}
		let len = utf8_len(bytes[i]);
		out.push_str(std::str::from_utf8(&bytes[i..i + len]).unwrap_or("\u{fffd}"));
		i += len;
	}
	out
}


const fn utf8_len(first: u8) -> usize {
	match first {
		0xc0..=0xdf => 2,
		0xe0..=0xef => 3,
		0xf0..=0xf7 => 4,
		_ => 1,
	}
}


fn parse_leading_timestamp(line: &[u8], year: i16, tz: &TimeZone) -> Option<(usize, Timestamp)> {
	let token_len = line
		.iter()
		.position(|b| b.is_ascii_whitespace())
		.unwrap_or(line.len());
	if let Ok(token) = std::str::from_utf8(&line[..token_len]) {
		if let Ok(ts) = token.parse::<Timestamp>() {
			return Some((token_len, ts));
		}
		if let Ok(dt) = token.parse::<jiff::civil::DateTime>()
			&& let Ok(zoned) = dt.to_zoned(tz.clone())
		{
			return Some((token_len, zoned.timestamp()));
		}
	}

	if line.len() < SYSLOG_LEN || (line.len() > SYSLOG_LEN && !line[SYSLOG_LEN].is_ascii_whitespace())
	{
		return None;
	}
	let mut prefix: [u8; SYSLOG_LEN] = line[..SYSLOG_LEN].try_into().ok()?;
	if prefix[4] == b' ' {
		prefix[4] = b'0';
	}
	let text = std::str::from_utf8(&prefix).ok()?;
	let tm = strtime::parse("%Y %b %d %H:%M:%S", format!("{year} {text}")).ok()?;
	let zoned = tm.to_datetime().ok()?.to_zoned(tz.clone()).ok()?;
	Some((SYSLOG_LEN, zoned.timestamp()))
}


fn write_relative_line(
	out: &mut impl Write,
	line: &[u8],
	now: Timestamp,
	tz: &TimeZone,
) -> io::Result<()> {
	let year = now.to_zoned(tz.clone()).year();
	if let Some((consumed, then)) = parse_leading_timestamp(line, year, tz) {
		out.write_all(render_relative(then, now).as_bytes())?;
		out.write_all(&line[consumed..])
	} else {
		out.write_all(line)
	}
}


fn render_relative(then: Timestamp, now: Timestamp) -> String {
	let secs = now.duration_since(then).as_secs();
	let magnitude = secs.unsigned_abs();
	let (count, unit) = if magnitude >= 86_400 {
		(magnitude / 86_400, 'd')
	} else if magnitude >= 3_600 {
		(magnitude / 3_600, 'h')
	} else if magnitude >= 60 {
		(magnitude / 60, 'm')
	} else {
		(magnitude, 's')
	};
	if secs >= 0 {
		format!("{count}{unit} ago")
	} else {
		format!("in {count}{unit}")
	}
}


pub(crate) fn ts_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Ts, SE>()
}


