



use brush_core::{ShellExtensions, builtins::Registration};
use clap::ArgMatches;
use uucore::checksum::{AlgoKind, BlakeLength, parse_blake_length};

use crate::{
	cksum,
	host::{Host, Utility, matches_parser, util},
};


pub(crate) struct B2sum {
	matches: ArgMatches,
}

matches_parser!(B2sum, app);

impl Utility for B2sum {
	const NAME: &'static str = "b2sum";
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {
		let length = self
			.matches
			.get_one::<String>("length")
			.map(|value| parse_blake_length(AlgoKind::Blake2b, BlakeLength::String(value)))
			.transpose();
		let length = match length {
			Ok(length) => length,
			Err(error) => {
				host.error(error, 1);
				return 1;
			},
		};
		cksum::run(host, AlgoKind::Blake2b, self.matches, length)
	}
}

fn app() -> clap::Command {
	cksum::command(B2sum::NAME, true)
}


pub(crate) fn b2sum_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<B2sum, SE>()
}


