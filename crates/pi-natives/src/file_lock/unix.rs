use std::{
	fs::{File, OpenOptions},
	io,
	os::{fd::AsRawFd, unix::fs::OpenOptionsExt},
};

pub struct PlatformFileLock {
	file: Option<File>,
}

pub fn try_acquire(path: &str) -> io::Result<Option<PlatformFileLock>> {
	let file = OpenOptions::new()
		.read(true)
		.write(true)
		.create(true)
		.truncate(false)
		.mode(0o600)
		.open(path)?;

	let status = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
	if status == 0 {
		return Ok(Some(PlatformFileLock { file: Some(file) }));
	}
	let error = io::Error::last_os_error();
	if error.kind() == io::ErrorKind::WouldBlock {
		return Ok(None);
	}
	Err(error)
}

impl PlatformFileLock {
	#[allow(clippy::unnecessary_wraps, reason = "uniform cross-platform interface")]
	pub fn release(&mut self) -> io::Result<()> {
		drop(self.file.take());
		Ok(())
	}
}
