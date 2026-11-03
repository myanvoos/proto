use std::{collections::HashMap, io::IsTerminal, process::Stdio, sync::Arc};

use crate::{ShellFd, error, ioutils, sys};

pub trait Stream: std::io::Read + std::io::Write + Send + Sync {
	fn clone_box(&self) -> Box<dyn Stream>;

	#[cfg(unix)]
	fn try_clone_to_owned(&self) -> Result<std::os::fd::OwnedFd, error::Error>;

	#[cfg(unix)]
	fn try_borrow_as_fd(&self) -> Result<std::os::fd::BorrowedFd<'_>, error::Error>;
}

pub enum OpenFile {
	Stdin(std::io::Stdin),

	Stdout(std::io::Stdout),

	Stderr(std::io::Stderr),

	File(Arc<std::fs::File>),

	PipeReader(Arc<std::io::PipeReader>),

	PipeWriter(Arc<std::io::PipeWriter>),

	Stream(Box<dyn Stream>),
}

#[cfg(feature = "serde")]
impl serde::Serialize for OpenFile {
	fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
	where
		S: serde::Serializer,
	{
		match self {
			Self::Stdin(_) => serializer.serialize_str("stdin"),
			Self::Stdout(_) => serializer.serialize_str("stdout"),
			Self::Stderr(_) => serializer.serialize_str("stderr"),
			Self::File(_) => serializer.serialize_str("file"),
			Self::PipeReader(_) => serializer.serialize_str("pipe_reader"),
			Self::PipeWriter(_) => serializer.serialize_str("pipe_writer"),
			Self::Stream(_) => serializer.serialize_str("stream"),
		}
	}
}

#[cfg(feature = "serde")]
impl<'de> serde::Deserialize<'de> for OpenFile {
	fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
	where
		D: serde::Deserializer<'de>,
	{
		match String::deserialize(deserializer)?.as_str() {
			"stdin" => return Ok(std::io::stdin().into()),
			"stdout" => return Ok(std::io::stdout().into()),
			"stderr" => return Ok(std::io::stderr().into()),
			"file" => (),
			"pipe_reader" => (),
			"pipe_writer" => (),
			"stream" => (),
			_ => return Err(serde::de::Error::custom("invalid open file")),
		}

		null().map_err(serde::de::Error::custom)
	}
}

pub fn null() -> Result<OpenFile, error::Error> {
	let file = sys::fs::open_null_file()?;
	Ok(file.into())
}

impl Clone for OpenFile {
	fn clone(&self) -> Self {
		self.try_clone().unwrap_or_else(|_err| {
			ioutils::FailingReaderWriter::new("failed to duplicate open file").into()
		})
	}
}

impl std::fmt::Display for OpenFile {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Stdin(_) => write!(f, "stdin"),
			Self::Stdout(_) => write!(f, "stdout"),
			Self::Stderr(_) => write!(f, "stderr"),
			Self::File(_) => write!(f, "file"),
			Self::PipeReader(_) => write!(f, "pipe reader"),
			Self::PipeWriter(_) => write!(f, "pipe writer"),
			Self::Stream(_) => write!(f, "stream"),
		}
	}
}

impl OpenFile {
	/// File identity without closing a descriptor, which could release host
	/// locks.
	#[cfg(unix)]
	pub fn regular_file_identity(&self) -> Option<(u64, u64)> {
		let stat = nix::sys::stat::fstat(self.try_borrow_as_fd().ok()?).ok()?;
		(stat.st_mode & nix::libc::S_IFMT == nix::libc::S_IFREG)
			.then_some((stat.st_dev as u64, stat.st_ino as u64))
	}

	#[cfg(not(unix))]
	pub fn regular_file_identity(&self) -> Option<(u64, u64)> {
		None
	}

	pub fn try_clone(&self) -> Result<Self, std::io::Error> {
		let result = match self {
			Self::Stdin(_) => std::io::stdin().into(),
			Self::Stdout(_) => std::io::stdout().into(),
			Self::Stderr(_) => std::io::stderr().into(),
			Self::File(f) => Self::File(Arc::clone(f)),
			Self::PipeReader(r) => Self::PipeReader(Arc::clone(r)),
			Self::PipeWriter(w) => Self::PipeWriter(Arc::clone(w)),
			Self::Stream(s) => Self::Stream(s.clone_box()),
		};

		Ok(result)
	}

	#[cfg(unix)]
	pub(crate) fn try_clone_to_owned(self) -> Result<std::os::fd::OwnedFd, error::Error> {
		use std::os::fd::AsFd as _;

		match self {
			Self::Stdin(f) => Ok(f.as_fd().try_clone_to_owned()?),
			Self::Stdout(f) => Ok(f.as_fd().try_clone_to_owned()?),
			Self::Stderr(f) => Ok(f.as_fd().try_clone_to_owned()?),
			Self::File(f) => Ok(take_or_duplicate(f, std::fs::File::try_clone)?.into()),
			Self::PipeReader(r) => Ok(take_or_duplicate(r, std::io::PipeReader::try_clone)?.into()),
			Self::PipeWriter(w) => Ok(take_or_duplicate(w, std::io::PipeWriter::try_clone)?.into()),
			Self::Stream(s) => s.try_clone_to_owned(),
		}
	}

	#[cfg(unix)]
	pub fn try_borrow_as_fd(&self) -> Result<std::os::fd::BorrowedFd<'_>, error::Error> {
		use std::os::fd::AsFd as _;

		match self {
			Self::Stdin(f) => Ok(f.as_fd()),
			Self::Stdout(f) => Ok(f.as_fd()),
			Self::Stderr(f) => Ok(f.as_fd()),
			Self::File(f) => Ok(f.as_fd()),
			Self::PipeReader(r) => Ok(r.as_fd()),
			Self::PipeWriter(w) => Ok(w.as_fd()),
			Self::Stream(s) => s.try_borrow_as_fd(),
		}
	}

	pub(crate) fn into_stdio(self) -> Result<Stdio, error::Error> {
		#[cfg(unix)]
		{
			let owned_fd = self.try_clone_to_owned()?;
			Ok(Stdio::from(std::fs::File::from(owned_fd)))
		}

		#[cfg(not(unix))]
		{
			let stdio = match self {
				Self::Stdin(_) => Stdio::inherit(),
				Self::Stdout(_) => Stdio::inherit(),
				Self::Stderr(_) => Stdio::inherit(),
				Self::File(f) => take_or_duplicate(f, std::fs::File::try_clone)?.into(),
				Self::PipeReader(r) => take_or_duplicate(r, std::io::PipeReader::try_clone)?.into(),
				Self::PipeWriter(w) => take_or_duplicate(w, std::io::PipeWriter::try_clone)?.into(),
				Self::Stream(_) => return Err(error::ErrorKind::CannotConvertToNativeFd.into()),
			};
			Ok(stdio)
		}
	}

	pub(crate) fn is_dir(&self) -> bool {
		match self {
			Self::Stdin(_) | Self::Stdout(_) | Self::Stderr(_) => false,
			Self::File(file) => file.metadata().is_ok_and(|m| m.is_dir()),
			Self::PipeReader(_) | Self::PipeWriter(_) | Self::Stream(_) => false,
		}
	}

	pub fn is_terminal(&self) -> bool {
		match self {
			Self::Stdin(f) => f.is_terminal(),
			Self::Stdout(f) => f.is_terminal(),
			Self::Stderr(f) => f.is_terminal(),
			Self::File(f) => f.is_terminal(),
			Self::PipeReader(_) | Self::PipeWriter(_) | Self::Stream(_) => false,
		}
	}
}

impl From<std::io::Stdin> for OpenFile {
	fn from(stdin: std::io::Stdin) -> Self {
		Self::Stdin(stdin)
	}
}

impl From<std::io::Stdout> for OpenFile {
	fn from(stdout: std::io::Stdout) -> Self {
		Self::Stdout(stdout)
	}
}

impl From<std::io::Stderr> for OpenFile {
	fn from(stderr: std::io::Stderr) -> Self {
		Self::Stderr(stderr)
	}
}

impl From<std::fs::File> for OpenFile {
	fn from(file: std::fs::File) -> Self {
		Self::File(Arc::new(file))
	}
}

impl From<std::io::PipeReader> for OpenFile {
	fn from(reader: std::io::PipeReader) -> Self {
		Self::PipeReader(Arc::new(reader))
	}
}

impl From<std::io::PipeWriter> for OpenFile {
	fn from(writer: std::io::PipeWriter) -> Self {
		Self::PipeWriter(Arc::new(writer))
	}
}

impl std::io::Read for OpenFile {
	fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
		match self {
			Self::Stdin(f) => f.read(buf),
			Self::Stdout(_) => {
				Err(std::io::Error::other(error::ErrorKind::OpenFileNotReadable("stdout")))
			},
			Self::Stderr(_) => {
				Err(std::io::Error::other(error::ErrorKind::OpenFileNotReadable("stderr")))
			},
			Self::File(f) => (&**f).read(buf),
			Self::PipeReader(reader) => (&**reader).read(buf),
			Self::PipeWriter(_) => {
				Err(std::io::Error::other(error::ErrorKind::OpenFileNotReadable("pipe writer")))
			},
			Self::Stream(s) => s.read(buf),
		}
	}
}

impl std::io::Write for OpenFile {
	fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
		match self {
			Self::Stdin(_) => {
				Err(std::io::Error::other(error::ErrorKind::OpenFileNotWritable("stdin")))
			},
			Self::Stdout(f) => f.write(buf),
			Self::Stderr(f) => f.write(buf),
			Self::File(f) => (&**f).write(buf),
			Self::PipeReader(_) => {
				Err(std::io::Error::other(error::ErrorKind::OpenFileNotWritable("pipe reader")))
			},
			Self::PipeWriter(writer) => (&**writer).write(buf),
			Self::Stream(s) => s.write(buf),
		}
	}

	fn flush(&mut self) -> std::io::Result<()> {
		match self {
			Self::Stdin(_) => Ok(()),
			Self::Stdout(f) => f.flush(),
			Self::Stderr(f) => f.flush(),
			Self::File(f) => (&**f).flush(),
			Self::PipeReader(_) => Ok(()),
			Self::PipeWriter(writer) => (&**writer).flush(),
			Self::Stream(s) => s.flush(),
		}
	}
}

pub enum OpenFileEntry<'a> {
	Open(&'a OpenFile),

	NotPresent,

	NotSpecified,
}

#[derive(Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct OpenFiles {
	files: HashMap<ShellFd, Option<OpenFile>>,
}

impl OpenFiles {
	const FIRST_NON_STDIO_FD: ShellFd = 3;
	const MAX_FD: ShellFd = 1024;
	pub const STDERR_FD: ShellFd = 2;
	pub const STDIN_FD: ShellFd = 0;
	pub const STDOUT_FD: ShellFd = 1;

	pub(crate) fn new() -> Self {
		Self {
			files: HashMap::from([
				(Self::STDIN_FD, Some(std::io::stdin().into())),
				(Self::STDOUT_FD, Some(std::io::stdout().into())),
				(Self::STDERR_FD, Some(std::io::stderr().into())),
			]),
		}
	}

	pub fn update_from(&mut self, files: impl Iterator<Item = (ShellFd, OpenFile)>) {
		for (fd, file) in files {
			let _ = self.files.insert(fd, Some(file));
		}
	}

	pub fn try_stdin(&self) -> Option<&OpenFile> {
		self.files.get(&Self::STDIN_FD).and_then(|f| f.as_ref())
	}

	pub fn try_stdout(&self) -> Option<&OpenFile> {
		self.files.get(&Self::STDOUT_FD).and_then(|f| f.as_ref())
	}

	pub fn try_stderr(&self) -> Option<&OpenFile> {
		self.files.get(&Self::STDERR_FD).and_then(|f| f.as_ref())
	}

	pub fn remove_fd(&mut self, fd: ShellFd) -> Option<OpenFile> {
		self.files.insert(fd, None).and_then(|f| f)
	}

	pub fn try_fd(&self, fd: ShellFd) -> Option<&OpenFile> {
		self.files.get(&fd).and_then(|f| f.as_ref())
	}

	pub fn fd_entry(&self, fd: ShellFd) -> OpenFileEntry<'_> {
		self
			.files
			.get(&fd)
			.map_or(OpenFileEntry::NotSpecified, |opt_file| match opt_file {
				Some(f) => OpenFileEntry::Open(f),
				None => OpenFileEntry::NotPresent,
			})
	}

	pub fn contains_fd(&self, fd: ShellFd) -> bool {
		self.files.contains_key(&fd)
	}

	pub fn set_fd(&mut self, fd: ShellFd, file: OpenFile) -> Option<OpenFile> {
		self.files.insert(fd, Some(file)).and_then(|f| f)
	}

	pub fn iter_fds(&self) -> impl Iterator<Item = (ShellFd, &OpenFile)> {
		self
			.files
			.iter()
			.filter_map(|(fd, file)| file.as_ref().map(|f| (*fd, f)))
	}

	pub fn add(&mut self, file: OpenFile) -> Result<ShellFd, error::Error> {
		let mut fd = Self::FIRST_NON_STDIO_FD;
		while self.files.contains_key(&fd) {
			if fd >= Self::MAX_FD {
				return Err(error::ErrorKind::TooManyOpenFiles.into());
			}

			fd += 1;
		}

		self.files.insert(fd, Some(file));
		Ok(fd)
	}
}

fn take_or_duplicate<T>(
	shared: Arc<T>,
	duplicate: impl FnOnce(&T) -> std::io::Result<T>,
) -> std::io::Result<T> {
	Arc::try_unwrap(shared).or_else(|shared| duplicate(&shared))
}

impl<I> From<I> for OpenFiles
where
	I: Iterator<Item = (ShellFd, OpenFile)>,
{
	fn from(iter: I) -> Self {
		let files = iter.map(|(fd, file)| (fd, Some(file))).collect();
		Self { files }
	}
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DescriptorPath {
	/// `/dev/stdin`, `/dev/stdout`, `/dev/stderr`, or `N` under `/dev/fd`,
	/// `/proc/self/fd`, `/proc/thread-self/fd`, or `/proc/<this pid>/fd`.
	Fd(ShellFd),
	/// `/dev/tty`.
	Terminal,
}

impl DescriptorPath {
	/// Classifies an absolute path; `None` for every other path, including
	/// relative paths and the descriptor directories themselves.
	pub fn parse(path: &std::path::Path) -> Option<Self> {
		use std::path::Component;

		let mut components = path.components();
		if components.next() != Some(Component::RootDir) {
			return None;
		}
		let mut names = [""; 4];
		let mut len = 0;
		for component in components {
			let Component::Normal(name) = component else {
				return None;
			};
			*names.get_mut(len)? = name.to_str()?;
			len += 1;
		}

		match names[..len] {
			["dev", "stdin"] => Some(Self::Fd(OpenFiles::STDIN_FD)),
			["dev", "stdout"] => Some(Self::Fd(OpenFiles::STDOUT_FD)),
			["dev", "stderr"] => Some(Self::Fd(OpenFiles::STDERR_FD)),
			["dev", "tty"] => Some(Self::Terminal),
			["dev", "fd", fd] | ["proc", "self" | "thread-self", "fd", fd] => {
				decimal(fd).map(Self::Fd)
			},
			["proc", pid, "fd", fd] if decimal::<u32>(pid) == Some(std::process::id()) => {
				decimal(fd).map(Self::Fd)
			},
			_ => None,
		}
	}

	/// The error opening this path fails with in a process that lacks the
	/// descriptor (`ENOENT`) or has no controlling terminal (`ENXIO`).
	pub fn unavailable_error(self) -> std::io::Error {
		#[cfg(unix)]
		{
			let errno = match self {
				Self::Fd(_) => nix::errno::Errno::ENOENT,
				Self::Terminal => nix::errno::Errno::ENXIO,
			};
			std::io::Error::from_raw_os_error(errno as i32)
		}
		#[cfg(not(unix))]
		{
			std::io::Error::from(std::io::ErrorKind::NotFound)
		}
	}
}

/// Parses an unsigned decimal path component, as the kernel spells
/// descriptor numbers and pids; signs and other text are not numbers here.
fn decimal<T: std::str::FromStr>(name: &str) -> Option<T> {
	if name.is_empty() || !name.bytes().all(|byte| byte.is_ascii_digit()) {
		return None;
	}
	name.parse().ok()
}
