use std::ffi::OsString;

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{ArgMatches, Command as ClapCommand};

use crate::{
	host::{Host, Utility, matches_parser, util},
	kernel_cell::{KernelLang, kernel_lang_app, run_kernel_lang},
};

const SPEC: KernelLang = KernelLang {
	lang:             "py",
	code_flag:        "-c",
	passthrough:      &["-u"],
	fleet_extensions: &[".py"],
	interpreters:     &["python3", "python"],
};

pub(crate) struct Python {
	matches: ArgMatches,
}

matches_parser!(Python, app);

impl Utility for Python {
	const NAME: &'static str = "python";

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
	kernel_lang_app(Python::NAME)
}

pub(crate) fn python_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Python, SE>()
}
