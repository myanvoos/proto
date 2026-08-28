//! `printenv` builtin: display values from the shell's exported environment.
//!
//! Ported from uutils coreutils 0.8.0.

use std::io::Write;

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};
use uucore::line_ending::LineEnding;

use crate::host::{Host, Utility, format_usage, matches_parser, util};

const OPT_NULL: &str = "null";
const ARG_VARIABLES: &str = "variables";

/// Parsed `printenv` invocation.
pub(crate) struct Printenv {
	matches: ArgMatches,
}

matches_parser!(Printenv, app);

impl Utility for Printenv {
	const NAME: &'static str = "printenv";

	fn run(self, host: &mut Host) -> i32 {
		let variables = self
			.matches
			.get_many::<String>(ARG_VARIABLES)
			.into_iter()
			.flatten()
			.collect::<Vec<_>>();
		let separator = LineEnding::from_zero_flag(self.matches.get_flag(OPT_NULL));

		if variables.len() == 0 {
			// Hash map iteration order is intentionally hidden from callers. Sort by
			// name so repeated invocations produce the same environment dump.
			let mut environment = host
				.env()
				.map(|(name, value)| (name.to_owned(), value.to_owned()))
				.collect::<Vec<_>>();
			environment.sort_unstable_by(|left, right| left.0.cmp(&right.0));
			for (name, value) in environment {
				if let Err(error) = write!(host.stdout, "{name}={value}{separator}") {
					host.error(error, 1);
					return 1;
				}
			}
			if let Err(error) = host.stdout.flush() {
				host.error(error, 1);
				return 1;
			}
			return 0;
		}

		let mut error_found = false;
		for env_var in variables {
			// We silently ignore a=b as a variable, but still report failure in
			// the exit status.
			if env_var.contains('=') {
				error_found = true;
				continue;
			}
			if let Some(value) = host.var(env_var).map(str::to_owned) {
				if let Err(error) = write!(host.stdout, "{value}{separator}") {
					host.error(error, 1);
					return 1;
				}
				if let Err(error) = host.stdout.flush() {
					host.error(error, 1);
					return 1;
				}
			} else {
				error_found = true;
			}
		}

		i32::from(error_found)
	}
}

/// The `printenv` argument model.
fn app() -> Command {
	Command::new(Printenv::NAME)
		.version("0.8.0")
		.about(
			"Display the values of the specified environment VARIABLE(s), or (with no VARIABLE) \
			 display name and value pairs for them all.",
		)
		.override_usage(format_usage("printenv [OPTION]... [VARIABLE]..."))
		.infer_long_args(true)
		.arg(
			Arg::new(OPT_NULL)
				.short('0')
				.long(OPT_NULL)
				.help("end each output line with 0 byte rather than newline")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(ARG_VARIABLES)
				.action(ArgAction::Append)
				.num_args(1..),
		)
}

/// Creates the `printenv` builtin registration.
pub(crate) fn printenv_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Printenv, SE>()
}


