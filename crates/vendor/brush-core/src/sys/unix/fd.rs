

use std::os::fd::RawFd;

use crate::{ShellFd, error, openfiles};

cfg_if::cfg_if! {
	 if #[cfg(any(target_os = "linux", target_os = "android"))] {
		  const FD_DIR_PATH: &str = "/proc/self/fd";
	 } else if #[cfg(any(
				target_os = "freebsd",
				target_os = "macos",
				target_os = "netbsd",
				target_os = "openbsd"
		  ))] {
		  const FD_DIR_PATH: &str = "/dev/fd";
	 } else {

		  pub fn iter_fds()
		  -> Result<impl Iterator<Item = (ShellFd, openfiles::OpenFile)>, error::Error> {
				Ok(std::iter::empty())
		  }
	 }
}







#[cfg(any(
	target_os = "linux",
	target_os = "android",
	target_os = "freebsd",
	target_os = "macos",
	target_os = "netbsd",
	target_os = "openbsd"
))]
pub fn try_iter_open_fds() -> impl Iterator<Item = (ShellFd, openfiles::OpenFile)> {
	std::fs::read_dir(FD_DIR_PATH)
		.into_iter()
		.flatten()
		.filter_map(Result::ok)
		.filter_map(|entry| {
			let fd: RawFd = entry.file_name().to_str()?.parse().ok()?;








			let file = unsafe { open_file_by_fd(fd) }.ok()?;

			Some((fd, file))
		})
}











pub fn try_get_file_for_open_fd(fd: RawFd) -> Option<openfiles::OpenFile> {







	unsafe { open_file_by_fd(fd).ok() }
}

unsafe fn open_file_by_fd(fd: RawFd) -> Result<openfiles::OpenFile, error::Error> {




	let borrowed_fd = unsafe { std::os::fd::BorrowedFd::borrow_raw(fd) };
	let owned_fd = borrowed_fd.try_clone_to_owned()?;
	Ok(std::fs::File::from(owned_fd).into())
}
