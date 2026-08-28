



use brush_core::{ShellExtensions, builtins::Registration};
use clap::ArgMatches;
use uucore::checksum::AlgoKind;

use crate::{
	cksum,
	host::{Host, Utility, matches_parser, util},
};


pub(crate) struct Md5sum {
	matches: ArgMatches,
}

matches_parser!(Md5sum, app);

impl Utility for Md5sum {
	const NAME: &'static str = "md5sum";
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {
		cksum::run(host, AlgoKind::Md5, self.matches, None)
	}
}

fn app() -> clap::Command {
	cksum::command(Md5sum::NAME, false)
}


pub(crate) fn md5sum_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Md5sum, SE>()
}


