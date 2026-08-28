







use std::ffi::OsStr;

use crate::{ShellFd, error, openfiles};


pub trait CommandExt {





	fn arg0<S>(&mut self, arg: S) -> &mut Self
	where
		S: AsRef<OsStr>;






	fn process_group(&mut self, pgroup: i32) -> &mut Self;
}

impl CommandExt for std::process::Command {
	fn arg0<S>(&mut self, _arg: S) -> &mut Self
	where
		S: AsRef<OsStr>,
	{

		self
	}

	fn process_group(&mut self, _pgroup: i32) -> &mut Self {


		self
	}
}


pub trait ExitStatusExt {

	fn signal(&self) -> Option<i32>;
}

impl ExitStatusExt for std::process::ExitStatus {
	fn signal(&self) -> Option<i32> {
		None
	}
}


pub trait CommandFdInjectionExt {





	fn inject_fds(
		&mut self,
		open_files: impl Iterator<Item = (ShellFd, openfiles::OpenFile)>,
	) -> Result<(), error::Error>;
}

impl CommandFdInjectionExt for std::process::Command {
	fn inject_fds(
		&mut self,
		mut open_files: impl Iterator<Item = (ShellFd, openfiles::OpenFile)>,
	) -> Result<(), error::Error> {
		if open_files.next().is_some() {
			return Err(
				error::ErrorKind::NotSupportedOnThisPlatform(
					"fd redirections beyond stdin/stdout/stderr on Windows",
				)
				.into(),
			);
		}

		Ok(())
	}
}


pub trait CommandFgControlExt {

	fn take_foreground(&mut self);

	fn lead_session(&mut self);
}

impl CommandFgControlExt for std::process::Command {
	fn take_foreground(&mut self) {


	}

	fn lead_session(&mut self) {


	}
}


pub trait CommandSessionExt {



	fn detach_session(&mut self);



	fn detach_session_reparent(&mut self);
}

impl CommandSessionExt for std::process::Command {
	fn detach_session(&mut self) {

	}

	fn detach_session_reparent(&mut self) {

	}
}
