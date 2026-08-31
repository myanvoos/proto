


use std::io::Write;

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{ArgMatches, Command};

use crate::host::{Host, Utility, matches_parser, os_bytes, util};

mod platform {
	pub use self::unix::get_username;

	mod unix {
		use std::{ffi::OsString, io};

		use uucore::{entries::uid2usr, process::geteuid};

		pub fn get_username() -> io::Result<OsString> {

			uid2usr(geteuid()).map(Into::into)
		}
	}

}


pub(crate) struct Whoami {
	matches: ArgMatches,
}

matches_parser!(Whoami, app);

impl Utility for Whoami {
	const NAME: &'static str = "whoami";

	fn run(self, host: &mut Host) -> i32 {
		let _ = self.matches;
		let username = match platform::get_username() {
			Ok(username) => username,
			Err(err) => {
				host.error(format!("failed to get username: {err}"), 1);
				return 1;
			},
		};
		let Some(username) = os_bytes(&username) else {
			host.error("failed to print username: username cannot be represented as bytes", 1);
			return 1;
		};
		let result = host
			.stdout
			.write_all(username)
			.and_then(|()| host.stdout.write_all(b"\n"))
			.and_then(|()| host.stdout.flush());
		if let Err(err) = result {
			host.error(format!("failed to print username: {err}"), 1);
			return 1;
		}
		0
	}
}


fn app() -> Command {
	Command::new(Whoami::NAME)
		.version("0.8.0")
		.about("Print the current username.")
		.override_usage("whoami")
		.infer_long_args(true)
}


pub(crate) fn whoami_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Whoami, SE>()
}


