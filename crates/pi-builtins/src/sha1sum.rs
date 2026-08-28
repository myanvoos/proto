



use brush_core::{ShellExtensions, builtins::Registration};
use clap::ArgMatches;
use uucore::checksum::AlgoKind;

use crate::{
	cksum,
	host::{Host, Utility, matches_parser, util},
};


pub(crate) struct Sha1sum {
	matches: ArgMatches,
}

matches_parser!(Sha1sum, app);

impl Utility for Sha1sum {
	const NAME: &'static str = "sha1sum";
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {
		cksum::run(host, AlgoKind::Sha1, self.matches, None)
	}
}

fn app() -> clap::Command {
	cksum::command(Sha1sum::NAME, false)
}


pub(crate) fn sha1sum_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Sha1sum, SE>()
}
