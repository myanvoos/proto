



use std::{io::Write, thread};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};
use uucore::display::Quotable;

use crate::host::{Host, Utility, format_usage, matches_parser, util};

static OPT_ALL: &str = "all";
static OPT_IGNORE: &str = "ignore";


pub(crate) struct Nproc {
	matches: ArgMatches,
}

matches_parser!(Nproc, app);

impl Utility for Nproc {
	const NAME: &'static str = "nproc";

	fn run(self, host: &mut Host) -> i32 {
		let ignore = match self.matches.get_one::<String>(OPT_IGNORE) {
			Some(numstr) => match numstr.trim().parse::<usize>() {
				Ok(num) => num,
				Err(error) => {
					host.error(format!("{} is not a valid number: {error}", numstr.quote()), 1);
					return 1;
				},
			},
			None => 0,
		};

		let limit = match host.var("PROTO_THREAD_LIMIT") {


			Some(threads) => match threads.parse() {
				Ok(0) | Err(_) => usize::MAX,
				Ok(n) => n,
			},
			None => usize::MAX,
		};

		let mut cores = if self.matches.get_flag(OPT_ALL) {
			num_cpus_all()
		} else {
			match host.var("PROTO_NUM_THREADS") {
				Some(threads) => {


					match threads.split_terminator(',').next() {
						None => available_parallelism(),
						Some(value) => match value.trim().parse() {
							Ok(0) | Err(_) => available_parallelism(),
							Ok(n) => n,
						},
					}
				},
				None => available_parallelism(),
			}
		};

		cores = std::cmp::min(limit, cores);
		if cores <= ignore {
			cores = 1;
		} else {
			cores -= ignore;
		}

		if let Err(error) = writeln!(host.stdout, "{cores}") {
			host.error(error, 1);
			return 1;
		}
		0
	}
}

fn app() -> Command {
	Command::new("nproc")
		.version("0.8.0")
		.about(
			"Print the number of cores available to the current process.\nIf the PROTO_NUM_THREADS or \
			 PROTO_THREAD_LIMIT environment variables are set, then\nthey will determine the minimum \
			 and maximum returned value respectively.",
		)
		.override_usage(format_usage("nproc [OPTIONS]..."))
		.infer_long_args(true)
		.arg(
			Arg::new(OPT_ALL)
				.long(OPT_ALL)
				.help("print the number of cores available to the system")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_IGNORE)
				.long(OPT_IGNORE)
				.value_name("N")
				.help("ignore up to N cores"),
		)
}

#[cfg(unix)]
fn num_cpus_all() -> usize {


	unsafe { libc::sysconf(libc::_SC_NPROCESSORS_CONF) }
		.try_into()
		.ok()
		.filter(|&n: &isize| n > 1)
		.map_or_else(available_parallelism, |n| n as usize)
}

#[cfg(not(unix))]
fn num_cpus_all() -> usize {
	available_parallelism()
}


fn available_parallelism() -> usize {
	thread::available_parallelism().map_or(1, std::num::NonZeroUsize::get)
}


pub(crate) fn nproc_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Nproc, SE>()
}


