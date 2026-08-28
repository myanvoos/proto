



use brush_core::{ShellExtensions, builtins::Registration};
use clap::{ArgMatches, Command};
use uucore::encoding::Format;

use crate::{
	base32::{base_app, run_base},
	host::{Host, Utility, matches_parser, util},
};

const ABOUT: &str = "encode/decode data and print to standard output\nWith no FILE, or when FILE is -, read standard input.\n\nThe data are encoded as described for the base64 alphabet in RFC 3548.\nWhen decoding, the input may contain newlines in addition to the bytes of the formal base64 alphabet. Use --ignore-garbage to attempt to recover from any other non-alphabet bytes in the encoded stream.";


pub(crate) struct Base64 {
	matches: ArgMatches,
}

matches_parser!(Base64, app);

impl Utility for Base64 {
	const NAME: &'static str = "base64";

	fn run(self, host: &mut Host) -> i32 {
		run_base(&self.matches, Format::Base64, host)
	}
}


fn app() -> Command {
	base_app(Base64::NAME, ABOUT, "base64 [OPTION]... [FILE]")
}


pub(crate) fn base64_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Base64, SE>()
}


