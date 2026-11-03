pub use std::os::unix::process::{CommandExt, ExitStatusExt};

use command_fds::{CommandFdExt, FdMapping};

use crate::{ShellFd, error, openfiles};

pub trait CommandFdInjectionExt {
	fn inject_fds(
		&mut self,
		open_files: impl Iterator<Item = (ShellFd, openfiles::OpenFile)>,
	) -> Result<(), error::Error>;
}

impl CommandFdInjectionExt for std::process::Command {
	fn inject_fds(
		&mut self,
		open_files: impl Iterator<Item = (ShellFd, openfiles::OpenFile)>,
	) -> Result<(), error::Error> {
		let fd_mappings: Vec<FdMapping> = open_files
			.map(|(child_fd, open_file)| -> Result<FdMapping, error::Error> {
				let parent_fd = open_file.try_clone_to_owned()?;
				Ok(FdMapping { child_fd, parent_fd })
			})
			.collect::<Result<Vec<_>, _>>()?;

		// `fd_mappings` registers a `pre_exec` closure even for an empty list, and
		// any closure forces std onto its fork+exec path instead of `posix_spawn`.
		if fd_mappings.is_empty() {
			return Ok(());
		}

		self
			.fd_mappings(fd_mappings)
			.map_err(|_e| error::ErrorKind::ChildCreationFailure)?;

		Ok(())
	}
}

pub trait CommandFgControlExt {
	fn take_foreground(&mut self);

	fn lead_session(&mut self);
}

impl CommandFgControlExt for std::process::Command {
	fn take_foreground(&mut self) {
		unsafe {
			self.pre_exec(pre_exec_take_foreground);
		}
	}

	fn lead_session(&mut self) {
		unsafe {
			self.pre_exec(pre_exec_lead_session);
		}
	}
}

pub trait CommandSessionExt {
	fn detach_session(&mut self);

	fn detach_session_reparent(&mut self);
}

impl CommandSessionExt for std::process::Command {
	fn detach_session(&mut self) {
		// Unlike a `pre_exec` closure, this keeps std's `posix_spawn` path
		// (`POSIX_SPAWN_SETSID`, vfork-style) available on linux-gnu, so spawn cost
		// does not scale with the host's address space. Elsewhere std calls
		// `setsid()` in its fork+exec fallback. Callers never combine this with
		// `process_group`, so the fresh child cannot already lead a process group
		// and `setsid()` cannot fail with EPERM.
		//
		// glibc rejects `POSIX_SPAWN_SETSID` with EINVAL before 2.26, but std only
		// reaches it here on glibc 2.29+: `compose_std_command` always sets a
		// working directory, and std takes `posix_spawn` with one only when
		// `posix_spawn_file_actions_addchdir_np` (glibc 2.29) exists.
		self.setsid(true);
	}

	fn detach_session_reparent(&mut self) {
		unsafe {
			self.pre_exec(pre_exec_detach_session_reparent);
		}
	}
}

fn pre_exec_take_foreground() -> Result<(), std::io::Error> {
	use crate::sys;

	sys::terminal::move_self_to_foreground()?;
	Ok(())
}

fn pre_exec_lead_session() -> Result<(), std::io::Error> {
	if let Err(e) = nix::unistd::setsid() {
		return Err(std::io::Error::other(format!("failed to become session leader: {e}")));
	}

	#[cfg(not(target_os = "macos"))]
	let control = libc::TIOCSCTTY;
	#[cfg(target_os = "macos")]
	let control: u64 = libc::TIOCSCTTY.into();

	let result = unsafe { libc::ioctl(0, control, 0) };
	if result != 0 {
		return Err(std::io::Error::other("failed to set controlling terminal"));
	}

	Ok(())
}

fn pre_exec_detach_session_reparent() -> Result<(), std::io::Error> {
	match nix::unistd::setsid() {
		Ok(_) | Err(nix::errno::Errno::EPERM) => {},
		Err(errno) => return Err(std::io::Error::from_raw_os_error(errno as i32)),
	}

	let pid = unsafe { libc::fork() };
	if pid < 0 {
		return Err(std::io::Error::last_os_error());
	}
	if pid > 0 {
		unsafe { libc::_exit(0) };
	}
	Ok(())
}
