

use crate::{ShellFd, openfiles};



pub fn try_iter_open_fds() -> impl Iterator<Item = (ShellFd, openfiles::OpenFile)> {
	vec![
		(openfiles::OpenFiles::STDIN_FD, openfiles::OpenFile::Stdin(std::io::stdin())),
		(openfiles::OpenFiles::STDOUT_FD, openfiles::OpenFile::Stdout(std::io::stdout())),
		(openfiles::OpenFiles::STDERR_FD, openfiles::OpenFile::Stderr(std::io::stderr())),
	]
	.into_iter()
}




pub fn try_get_file_for_open_fd(fd: ShellFd) -> Option<openfiles::OpenFile> {
	match fd {
		openfiles::OpenFiles::STDIN_FD => Some(openfiles::OpenFile::Stdin(std::io::stdin())),
		openfiles::OpenFiles::STDOUT_FD => Some(openfiles::OpenFile::Stdout(std::io::stdout())),
		openfiles::OpenFiles::STDERR_FD => Some(openfiles::OpenFile::Stderr(std::io::stderr())),
		_ => None,
	}
}
