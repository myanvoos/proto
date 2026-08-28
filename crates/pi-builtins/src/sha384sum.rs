



use brush_core::{ShellExtensions, builtins::Registration};
use clap::ArgMatches;
use uucore::checksum::AlgoKind;

use crate::{
	cksum,
	host::{Host, Utility, matches_parser, util},
};


pub(crate) struct Sha384sum {
	matches: ArgMatches,
}

matches_parser!(Sha384sum, app);

impl Utility for Sha384sum {
	const NAME: &'static str = "sha384sum";
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {
		cksum::run(host, AlgoKind::Sha384, self.matches, None)
	}
}

fn app() -> clap::Command {
	cksum::command(Sha384sum::NAME, false)
}


pub(crate) fn sha384sum_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Sha384sum, SE>()
}
