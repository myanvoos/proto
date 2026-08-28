

use std::{
	os::fd::BorrowedFd,
	time::{Duration, Instant},
};

use nix::poll::{PollFd, PollFlags, PollTimeout, poll};

use crate::openfiles::OpenFile;



















pub fn poll_for_input(file: &OpenFile, timeout: Duration) -> std::io::Result<bool> {
	let fd = file
		.try_borrow_as_fd()
		.map_err(|e| std::io::Error::other(e.to_string()))?;


	if is_regular_file(fd) {
		return Ok(true);
	}






	if is_null_device(fd) {
		return Ok(true);
	}


	let deadline = if timeout.is_zero() {

		Some(Instant::now())
	} else {
		Some(Instant::now() + timeout)
	};

	poll_fd_for_input(fd, deadline)
}









fn poll_fd_for_input(fd: BorrowedFd<'_>, deadline: Option<Instant>) -> std::io::Result<bool> {
	let mut poll_fds = [PollFd::new(fd, PollFlags::POLLIN)];
	let mut first_iteration = true;

	loop {

		let timeout_ms = match deadline {
			Some(d) => {
				let remaining = d.saturating_duration_since(Instant::now());


				if remaining.is_zero() && !first_iteration {
					return Ok(false);
				}
				i32::try_from(remaining.as_millis()).unwrap_or(i32::MAX)
			},
			None => -1,
		};
		first_iteration = false;
		let poll_timeout = PollTimeout::try_from(timeout_ms).unwrap_or(PollTimeout::MAX);

		match poll(&mut poll_fds, poll_timeout) {
			Ok(0) => return Ok(false),
			Ok(_) => {
				let revents = poll_fds[0].revents().unwrap_or(PollFlags::empty());


				return Ok(
					revents.intersects(PollFlags::POLLIN | PollFlags::POLLHUP | PollFlags::POLLERR)
				);
			},
			Err(nix::errno::Errno::EINTR) => (),
			Err(e) => return Err(std::io::Error::from_raw_os_error(e as i32)),
		}
	}
}








fn is_regular_file(fd: BorrowedFd<'_>) -> bool {
	match nix::sys::stat::fstat(fd) {
		Ok(stat) => {
			use nix::sys::stat::{SFlag, mode_t};
			mode_t::try_from(stat.st_mode)
				.is_ok_and(|mode| SFlag::from_bits_truncate(mode).contains(SFlag::S_IFREG))
		},
		Err(_) => false,
	}
}










fn is_null_device(fd: BorrowedFd<'_>) -> bool {
	use nix::sys::stat::{SFlag, fstat, mode_t};
	let Ok(st) = fstat(fd) else { return false };



	let is_char_device = mode_t::try_from(st.st_mode)
		.is_ok_and(|mode| SFlag::from_bits_truncate(mode).contains(SFlag::S_IFCHR));
	is_char_device && null_device_rdev().is_some_and(|rdev| st.st_rdev == rdev)
}





fn null_device_rdev() -> Option<libc::dev_t> {
	use std::sync::OnceLock;
	static RDEV: OnceLock<Option<libc::dev_t>> = OnceLock::new();
	*RDEV.get_or_init(|| nix::sys::stat::stat("/dev/null").ok().map(|st| st.st_rdev))
}


