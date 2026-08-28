



use std::{
	ffi::OsString,
	io::{self, Write},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command, builder::ValueParser};

use crate::host::{Host, Utility, format_usage, matches_parser, util};



const BUF_SIZE: usize = 16 * 1024;


pub(crate) struct Yes {
	matches: ArgMatches,
}

matches_parser!(Yes, app);

impl Utility for Yes {
	const NAME: &'static str = "yes";

	fn rewrite_argv(mut argv: Vec<OsString>) -> Result<Vec<OsString>, String> {




		if argv.is_empty()
			|| (argv.len() == 2 && matches!(argv[1].to_str(), Some("--help" | "--version")))
		{
			return Ok(argv);
		}

		if argv.get(1).is_some_and(|arg| arg.to_str() == Some("--")) {
			argv.remove(1);
		}
		argv.insert(1, OsString::from("--"));
		Ok(argv)
	}

	fn run(self, host: &mut Host) -> i32 {
		let mut buffer = Vec::with_capacity(BUF_SIZE);
		let Some(strings) = self.matches.get_many::<OsString>("STRING") else {
			host.error("missing default operand", 1);
			return 1;
		};
		let _ = args_into_buffer(&mut buffer, strings);
		prepare_buffer(&mut buffer);

		match exec(&buffer, host) {


			ExecStop::Io(error) if error.kind() == io::ErrorKind::BrokenPipe => 0,
			ExecStop::Io(error) => {
				host.error(format!("standard output: {}", strip_errno(&error)), 1);
				1
			},

			ExecStop::Cancelled => 1,
		}
	}
}


fn app() -> Command {
	Command::new(Yes::NAME)
		.version("0.8.0")
		.about("Repeatedly display a line with STRING (or 'y')")
		.override_usage(format_usage("yes [STRING]..."))
		.arg(
			Arg::new("STRING")
				.default_value("y")
				.value_parser(ValueParser::os_string())
				.action(ArgAction::Append)
				.allow_hyphen_values(true)
				.trailing_var_arg(true),
		)
		.infer_long_args(true)
}


fn args_into_buffer<'a>(
	buffer: &mut Vec<u8>,
	strings: impl Iterator<Item = &'a OsString>,
) -> Result<(), &'static str> {

	#[cfg(any(unix, target_os = "wasi"))]
	{
		#[cfg(unix)]
		use std::os::unix::ffi::OsStrExt;
		#[cfg(target_os = "wasi")]
		use std::os::wasi::ffi::OsStrExt;

		for part in itertools::intersperse(strings.map(|argument| argument.as_bytes()), b" ") {
			buffer.extend_from_slice(part);
		}
	}


	#[cfg(not(any(unix, target_os = "wasi")))]
	{
		for part in itertools::intersperse(strings.map(|argument| argument.to_str()), Some(" ")) {
			let Some(part) = part else {
				return Err("arguments contain invalid UTF-8");
			};
			buffer.extend_from_slice(part.as_bytes());
		}
	}

	buffer.push(b'\n');
	Ok(())
}


fn prepare_buffer(buffer: &mut Vec<u8>) {
	let line_len = buffer.len();
	debug_assert!(line_len > 0, "buffer is not empty since we have newline");
	let target_size = line_len * (BUF_SIZE / line_len);

	while buffer.len() < target_size {
		let to_copy = std::cmp::min(target_size - buffer.len(), buffer.len());
		debug_assert_eq!(to_copy % line_len, 0);
		buffer.extend_from_within(..to_copy);
	}
}


enum ExecStop {
	Io(io::Error),
	Cancelled,
}


fn exec(bytes: &[u8], host: &mut Host) -> ExecStop {
	loop {


		if host.is_cancelled() {
			return ExecStop::Cancelled;
		}
		if let Err(error) = host.stdout.write_all(bytes) {
			return ExecStop::Io(error);
		}
	}
}


fn strip_errno(error: &io::Error) -> String {
	let mut message = error.to_string();
	if let Some(position) = message.find(" (os error ") {
		message.truncate(position);
	}
	message
}


pub(crate) fn yes_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Yes, SE>()
}


