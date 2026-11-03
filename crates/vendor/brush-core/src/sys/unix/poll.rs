use std::{
	io,
	os::fd::BorrowedFd,
	time::{Duration, Instant},
};

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
	let mut first = true;
	loop {
		let remaining =
			deadline.map_or(POLL_SLICE, |deadline| deadline.saturating_duration_since(Instant::now()));
		if !first && deadline.is_some() && remaining.is_zero() {
			return Ok(false);
		}
		first = false;
		match readable_within(fd, remaining) {
			Ok(true) => return Ok(true),
			Ok(false) => {},
			Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {},
			Err(error) => return Err(error),
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

#[cfg(not(target_os = "macos"))]
fn poll_readable(fd: std::os::fd::BorrowedFd<'_>, timeout: Duration) -> io::Result<bool> {
	use std::os::fd::AsRawFd;
	let mut pfd = libc::pollfd { fd: fd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
	// Rounded up, so a wait shorter than a millisecond does not spin.
	let timeout_ms = i32::try_from(timeout.as_micros().div_ceil(1000)).unwrap_or(i32::MAX);
	// SAFETY: one `pollfd` valid for the call; `fd` is borrowed from a live
	// descriptor for the whole call.
	match unsafe { libc::poll(&mut pfd, 1, timeout_ms) } {
		..0 => Err(std::io::Error::last_os_error()),
		ready => Ok(ready > 0),
	}
}

#[cfg(target_os = "macos")]
fn select_readable(fd: std::os::fd::BorrowedFd<'_>, timeout: Duration) -> io::Result<bool> {
	use std::os::fd::AsRawFd;

	unsafe extern "C" {
		/// `select` for sets of any length: a set is a bitmap of 32-bit words,
		/// descriptor `n` at bit `n % 32` of word `n / 32`, and the call reads
		/// as many words as `nfds` bits need.
		#[link_name = "select$DARWIN_EXTSN"]
		fn select_unlimited(
			nfds: libc::c_int,
			readfds: *mut u32,
			writefds: *mut u32,
			errorfds: *mut u32,
			timeout: *mut libc::timeval,
		) -> libc::c_int;
	}
	/// Words of a set holding `FD_SETSIZE` (1024) descriptors.
	const INLINE_WORDS: usize = 32;
	/// The longest wait `select` accepts; above it, it fails with `EINVAL`.
	const MAX_SECS: u64 = 100_000_000;

	let raw = fd.as_raw_fd();
	// A borrowed descriptor is never negative.
	let index = raw.unsigned_abs() as usize;
	let (word, bit) = (index / 32, index % 32);
	let mut inline = [0_u32; INLINE_WORDS];
	let mut heap = Vec::new();
	let set = if word < INLINE_WORDS {
		&mut inline[..=word]
	} else {
		heap.resize(word + 1, 0);
		heap.as_mut_slice()
	};
	set[word] = 1 << bit;
	let mut timeval = libc::timeval {
		tv_sec:  libc::time_t::try_from(timeout.as_secs().min(MAX_SECS)).unwrap_or(libc::time_t::MAX),
		// Below one million, so it fits.
		tv_usec: timeout.subsec_micros().cast_signed(),
	};
	// SAFETY: `set` holds the `raw + 1` bits `nfds` names, the other sets are
	// absent, and `timeval` is valid for the call; `fd` is borrowed from a live
	// descriptor for the whole call.
	let ready = unsafe {
		select_unlimited(
			raw + 1,
			set.as_mut_ptr(),
			std::ptr::null_mut(),
			std::ptr::null_mut(),
			&mut timeval,
		)
	};
	if ready < 0 {
		Err(std::io::Error::last_os_error())
	} else {
		Ok(ready > 0)
	}
}

pub const POLL_SLICE: Duration = Duration::from_millis(100);

pub fn fd_reads_can_block(fd: BorrowedFd<'_>) -> bool {
	!is_regular_file(fd) && !is_null_device(fd)
}

pub fn readable_within(fd: BorrowedFd<'_>, timeout: Duration) -> std::io::Result<bool> {
	#[cfg(target_os = "macos")]
	{
		select_readable(fd, timeout)
	}
	#[cfg(not(target_os = "macos"))]
	{
		poll_readable(fd, timeout)
	}
}

pub fn wait_readable(fd: BorrowedFd<'_>, is_cancelled: impl Fn() -> bool) -> std::io::Result<()> {
	if !fd_reads_can_block(fd) {
		return Ok(());
	}
	loop {
		if is_cancelled() {
			return Err(std::io::ErrorKind::Interrupted.into());
		}
		match readable_within(fd, POLL_SLICE) {
			Ok(true) => return Ok(()),
			Ok(false) => {},
			Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {},
			Err(error) => return Err(error),
		}
	}
}
