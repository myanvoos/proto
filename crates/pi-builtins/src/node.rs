use std::ffi::OsString;

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{ArgMatches, Command as ClapCommand};

use crate::{
	host::{Host, Utility, matches_parser, util},
	kernel_cell::{KernelLang, kernel_lang_app, run_kernel_lang},
};

const NODE_SPEC: KernelLang = KernelLang {
	lang:             "js",
	code_flag:        "-e",
	passthrough:      &[],
	fleet_extensions: &[".js", ".mjs", ".cjs", ".ts"],
	interpreters:     &["node"],
};

const BUN_SPEC: KernelLang = KernelLang {
	lang:             "js",
	code_flag:        "-e",
	passthrough:      &[],
	fleet_extensions: &[".js", ".mjs", ".cjs", ".ts"],
	interpreters:     &["bun"],
};

fn collect_args(matches: &ArgMatches) -> Vec<OsString> {
	matches
		.get_many::<OsString>("args")
		.unwrap_or_default()
		.cloned()
		.collect()
}

pub(crate) struct Node {
	matches: ArgMatches,
}

matches_parser!(Node, node_app);

impl Utility for Node {
	const NAME: &'static str = "node";

	fn run(self, host: &mut Host) -> i32 {
		run_kernel_lang(&NODE_SPEC, &collect_args(&self.matches), host)
	}
}

fn node_app() -> ClapCommand {
	kernel_lang_app(Node::NAME)
}

pub(crate) fn node_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Node, SE>()
}

pub(crate) struct Bun {
	matches: ArgMatches,
}

matches_parser!(Bun, bun_app);

impl Utility for Bun {
	const NAME: &'static str = "bun";

	fn run(self, host: &mut Host) -> i32 {
		run_kernel_lang(&BUN_SPEC, &collect_args(&self.matches), host)
	}
}

fn bun_app() -> ClapCommand {
	kernel_lang_app(Bun::NAME)
}

pub(crate) fn bun_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Bun, SE>()
}
