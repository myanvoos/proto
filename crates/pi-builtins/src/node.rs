use std::ffi::OsString;

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{ArgMatches, Command as ClapCommand};

use crate::{
	host::{Host, Utility, matches_parser, util},
	kernel_cell::{KernelLang, kernel_lang_app, run_kernel_lang},
};

const SPEC: KernelLang = KernelLang {
	lang:             "js",
	code_flag:        "-e",
	passthrough:      &[],
	fleet_extensions: &[".js", ".mjs", ".cjs", ".ts"],
};

pub(crate) struct Node {
	matches: ArgMatches,
}

matches_parser!(Node, app);

impl Utility for Node {
	const NAME: &'static str = "node";

	fn run(self, host: &mut Host) -> i32 {
		let argv: Vec<OsString> = self
			.matches
			.get_many::<OsString>("args")
			.unwrap_or_default()
			.cloned()
			.collect();
		run_kernel_lang(&SPEC, &argv, host)
	}
}

fn app() -> ClapCommand {
	kernel_lang_app(Node::NAME)
}

pub(crate) fn node_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Node, SE>()
}
