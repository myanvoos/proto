







use std::{
	ffi::OsString,
	io::{self, ErrorKind, Read, Write},
	process::{Command, Stdio},
	sync::atomic::{AtomicBool, Ordering},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command as ClapCommand, builder::ValueParser};

use crate::host::{Host, Utility, matches_parser, util};

const USAGE: &str = "usage: ifne [-n] command [args...]";
const CHUNK: usize = 64 * 1024;


pub(crate) struct Ifne {
	matches: ArgMatches,
}

matches_parser!(Ifne, app);

impl Utility for Ifne {
	const NAME: &'static str = "ifne";

	fn run(self, host: &mut Host) -> i32 {
		let invert = self.matches.get_flag("invert");
		let command: Vec<OsString> = self
			.matches
			.get_many::<OsString>("command")
			.unwrap_or_default()
			.cloned()
			.collect();
		if command.is_empty() {
			let _ = writeln!(host.stderr, "{USAGE}");
			return 1;
		}



		let mut first = [0u8; 1];
		let got = loop {
			if host.is_cancelled() {
				return 130;
			}
			match host.stdin.read(&mut first) {
				Ok(n) => break n,
				Err(err) if err.kind() == ErrorKind::Interrupted => {
					if host.is_cancelled() {
						return 130;
					}
				},
				Err(err) => {
					host.error(format!("stdin: {err}"), 1);
					return 1;
				},
			}
		};
		if got == 0 && host.is_cancelled() {
			return 130;
		}
		let empty = got == 0;

		if empty != invert {
			if empty {

				return 0;
			}

			let cancel = host.cancel_flag();
			return match copy_cancellable(
				&mut host.stdin,
				&mut host.stdout,
				Some(first[0]),
				&cancel,
			) {
				Ok(()) => 0,
				Err(CopyError::Cancelled) => 130,
				Err(CopyError::Io(err)) => {
					host.error(err, 1);
					1
				},
			};
		}

		spawn_and_pump(host, &command, if empty { None } else { Some(first[0]) })
	}
}


fn app() -> ClapCommand {
	ClapCommand::new(Ifne::NAME)
		.disable_version_flag(true)
		.override_usage("ifne [-n] command [args...]")
		.arg(
			Arg::new("invert")
				.short('n')
				.action(ArgAction::SetTrue)
				.help("run the command when standard input is empty"),
		)
		.arg(
			Arg::new("command")
				.value_name("command [args...]")
				.value_parser(ValueParser::os_string())
				.allow_hyphen_values(true)
				.trailing_var_arg(true)
				.num_args(0..),
		)
}


fn spawn_and_pump(host: &mut Host, command: &[OsString], first: Option<u8>) -> i32 {
	let mut child = match Command::new(&command[0])
		.args(&command[1..])
		.current_dir(host.cwd())
		.env_clear()
		.envs(host.env())
		.stdin(Stdio::piped())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.spawn()
	{
		Ok(child) => child,
		Err(err) => {
			host.error(format!("{}: {err}", command[0].to_string_lossy()), 127);
			return 127;
		},
	};

	let mut child_stdin = child.stdin.take().expect("piped stdin");
	let mut child_stdout = child.stdout.take().expect("piped stdout");
	let mut child_stderr = child.stderr.take().expect("piped stderr");
	let cancel = host.cancel_flag();




	let (out_buf, err_buf, pump) = std::thread::scope(|scope| {
		let out = scope.spawn(move || {
			let mut buf = Vec::new();
			let _ = child_stdout.read_to_end(&mut buf);
			buf
		});
		let err = scope.spawn(move || {
			let mut buf = Vec::new();
			let _ = child_stderr.read_to_end(&mut buf);
			buf
		});


		let pump = match copy_cancellable(&mut host.stdin, &mut child_stdin, first, &cancel) {
			Err(CopyError::Io(err)) if err.kind() != ErrorKind::BrokenPipe => {
				Err(CopyError::Io(err))
			},
			Err(CopyError::Cancelled) => Err(CopyError::Cancelled),
			_ => Ok(()),
		};
		drop(child_stdin);
		if matches!(pump, Err(CopyError::Cancelled)) {
			let _ = child.kill();
		}
		(out.join().unwrap_or_default(), err.join().unwrap_or_default(), pump)
	});

	let status = child.wait();
	let _ = host.stdout.write_all(&out_buf);
	let _ = host.stderr.write_all(&err_buf);

	match pump {
		Err(CopyError::Cancelled) => return 130,
		Err(CopyError::Io(err)) => {
			host.error(err, 1);
			return 1;
		},
		Ok(()) => {},
	}

	match status {
		Ok(status) => exit_code(status),
		Err(err) => {
			host.error(err, 1);
			1
		},
	}
}

enum CopyError {
	Cancelled,
	Io(io::Error),
}


fn copy_cancellable(
	src: &mut impl Read,
	dst: &mut impl Write,
	first: Option<u8>,
	cancel: &AtomicBool,
) -> Result<(), CopyError> {
	if let Some(byte) = first {
		dst.write_all(&[byte]).map_err(CopyError::Io)?;
	}
	let mut buf = vec![0u8; CHUNK].into_boxed_slice();
	loop {
		if cancel.load(Ordering::Relaxed) {
			return Err(CopyError::Cancelled);
		}
		match src.read(&mut buf) {
			Ok(0) => return Ok(()),
			Ok(n) => dst.write_all(&buf[..n]).map_err(CopyError::Io)?,
			Err(err) if err.kind() == ErrorKind::Interrupted => {},
			Err(err) => return Err(CopyError::Io(err)),
		}
	}
}



fn exit_code(status: std::process::ExitStatus) -> i32 {
	if let Some(code) = status.code() {
		return code;
	}
	#[cfg(unix)]
	{
		use std::os::unix::process::ExitStatusExt;
		if let Some(signal) = status.signal() {
			return 128 + signal;
		}
	}
	1
}


pub(crate) fn ifne_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Ifne, SE>()
}


