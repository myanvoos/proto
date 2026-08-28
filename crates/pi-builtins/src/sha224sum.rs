



use brush_core::{ShellExtensions, builtins::Registration};
use clap::ArgMatches;
use uucore::checksum::AlgoKind;

use crate::{
	cksum,
	host::{Host, Utility, matches_parser, util},
};


pub(crate) struct Sha224sum {
	matches: ArgMatches,
}

matches_parser!(Sha224sum, app);

impl Utility for Sha224sum {
	const NAME: &'static str = "sha224sum";
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {
		cksum::run(host, AlgoKind::Sha224, self.matches, None)
	}
}

fn app() -> clap::Command {
	cksum::command(Sha224sum::NAME, false)
}


pub(crate) fn sha224sum_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Sha224sum, SE>()
}
