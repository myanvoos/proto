



use std::io::Write;

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{ArgMatches, Command};

use crate::host::{Host, Utility, matches_parser, os_bytes, util};

mod platform {
	#[cfg(unix)]
	pub use self::unix::get_username;
	#[cfg(windows)]
	pub use self::windows::get_username;

	#[cfg(unix)]
	mod unix {
		use std::{ffi::OsString, io};

		use uucore::{entries::uid2usr, process::geteuid};

		pub fn get_username() -> io::Result<OsString> {

			uid2usr(geteuid()).map(Into::into)
		}
	}

	#[cfg(windows)]
	mod windows {
		use std::{ffi::OsString, io, os::windows::ffi::OsStringExt};

		use windows_sys::Win32::System::WindowsProgramming::GetUserNameW;

		pub fn get_username() -> io::Result<OsString> {



			const BUF_LEN: u32 = 257;
			let mut buffer = [0_u16; BUF_LEN as usize];
			let mut len = BUF_LEN;

			if unsafe { GetUserNameW(buffer.as_mut_ptr(), &raw mut len) } == 0 {
				return Err(io::Error::last_os_error());
			}
			Ok(OsString::from_wide(&buffer[..len as usize - 1]))
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


