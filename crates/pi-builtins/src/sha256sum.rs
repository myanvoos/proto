



use brush_core::{ShellExtensions, builtins::Registration};
use clap::ArgMatches;
use uucore::checksum::AlgoKind;

use crate::{
	cksum,
	host::{Host, Utility, matches_parser, util},
};


pub(crate) struct Sha256sum {
	matches: ArgMatches,
}

matches_parser!(Sha256sum, app);

impl Utility for Sha256sum {
	const NAME: &'static str = "sha256sum";
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {
		cksum::run(host, AlgoKind::Sha256, self.matches, None)
	}
}

fn app() -> clap::Command {
	cksum::command(Sha256sum::NAME, false)
}


pub(crate) fn sha256sum_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Sha256sum, SE>()
}
