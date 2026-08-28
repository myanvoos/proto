

use crate::{ShellFd, error, openfiles};



pub fn try_iter_open_fds() -> impl Iterator<Item = (ShellFd, openfiles::OpenFile)> {
	std::iter::empty()
}



pub fn try_get_file_for_open_fd(_fd: ShellFd) -> Option<openfiles::OpenFile> {
	None
}
