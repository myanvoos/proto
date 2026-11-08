//! `node`, `nodejs` and `bun`: the JavaScript kernel-cell builtins.
//!
//! Each decides at run time whether an invocation is a persistent kernel cell
//! or a real interpreter process ([`crate::kernel_cell`]). They are extras so
//! the shell can offer them like any other command; the fall-through path
//! runs the interpreter in a subshell of the caller through
//! [`crate::host::Host::run_command`], which is why they report
//! [`crate::host::Utility::RUNS_COMMANDS`].

use std::ffi::OsString;

use clap::{Arg, ArgMatches, Command as ClapCommand, builder::ValueParser};

use crate::{
	host::{Host, Utility, matches_parser},
	kernel_cell::{KernelLang, run_kernel_lang},
	kernel_route::JS_ARGV,
};

const NODE_SPEC: KernelLang = KernelLang {
	lang:             "node",
	argv:             &JS_ARGV,
	fleet_extensions: &[".js", ".mjs", ".cjs", ".ts"],
	interpreters:     &["node", "nodejs"],
};

const BUN_SPEC: KernelLang = KernelLang {
	lang:             "bun",
	argv:             &JS_ARGV,
	fleet_extensions: &[".js", ".mjs", ".cjs", ".ts"],
	interpreters:     &["bun"],
};

/// Every argument after the command name, hyphenated ones included: the
/// interpreter's own grammar is classified by [`crate::kernel_route`], not by
/// clap.
fn kernel_lang_app(name: &'static str) -> ClapCommand {
	ClapCommand::new(name)
		.disable_help_flag(true)
		.disable_version_flag(true)
		.arg(
			Arg::new("args")
				.value_name("args")
				.value_parser(ValueParser::os_string())
				.allow_hyphen_values(true)
				.trailing_var_arg(true)
				.num_args(0..),
		)
}

fn collect_args(matches: &ArgMatches) -> Vec<OsString> {
	matches
		.get_many::<OsString>("args")
		.unwrap_or_default()
		.cloned()
		.collect()
}

/// `node` / `nodejs`.
pub(crate) struct Node {
	matches: ArgMatches,
}

matches_parser!(Node, node_app);

impl Utility for Node {
	const NAME: &'static str = "node";
	const RUNS_COMMANDS: bool = true;

	fn run(self, host: &mut Host) -> i32 {
		run_kernel_lang(&NODE_SPEC, &collect_args(&self.matches), host)
	}
}

fn node_app() -> ClapCommand {
	kernel_lang_app(Node::NAME)
}

/// `bun`.
pub(crate) struct Bun {
	matches: ArgMatches,
}

matches_parser!(Bun, bun_app);

impl Utility for Bun {
	const NAME: &'static str = "bun";
	const RUNS_COMMANDS: bool = true;

	fn run(self, host: &mut Host) -> i32 {
		run_kernel_lang(&BUN_SPEC, &collect_args(&self.matches), host)
	}
}

fn bun_app() -> ClapCommand {
	kernel_lang_app(Bun::NAME)
}

#[cfg(test)]
mod tests {
	use clap::CommandFactory;

	use super::*;

	#[test]
	fn every_argument_after_the_name_reaches_the_parser() {
		for (argv, expected) in [
			(vec!["node", "-e", "code", "a"], vec!["-e", "code", "a"]),
			(vec!["node", "prog.js", "hello"], vec!["prog.js", "hello"]),
			(vec!["node"], Vec::new()),
		] {
			let matches = Node::command().try_get_matches_from(&argv).expect("parse");
			let args: Vec<_> = collect_args(&matches);
			assert_eq!(args, expected.iter().map(OsString::from).collect::<Vec<_>>(), "{argv:?}");
		}
	}
}
