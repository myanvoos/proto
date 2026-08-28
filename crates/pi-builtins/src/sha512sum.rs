



use brush_core::{ShellExtensions, builtins::Registration};
use clap::ArgMatches;
use uucore::checksum::AlgoKind;

use crate::{
	cksum,
	host::{Host, Utility, matches_parser, util},
};


pub(crate) struct Sha512sum {
	matches: ArgMatches,
}

matches_parser!(Sha512sum, app);

impl Utility for Sha512sum {
	const NAME: &'static str = "sha512sum";
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {
		cksum::run(host, AlgoKind::Sha512, self.matches, None)
	}
}

fn app() -> clap::Command {
	cksum::command(Sha512sum::NAME, false)
}


pub(crate) fn sha512sum_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Sha512sum, SE>()
}
