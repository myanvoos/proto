//! In-process file access that cannot release the host process's SQLite locks.
//!
//! POSIX record locks belong to the process, and closing *any* descriptor for a file drops every
//! lock the process holds on it. Builtins and redirections run inside the host, so opening and
//! closing a SQLite database (or its `-shm` index) that the host itself has open silently releases
//! SQLite's locks; another process may then checkpoint and delete the WAL underneath the host,
//! splitting the store into diverging copies that corrupt each other.

use std::{
	collections::HashMap,
	fs::{File, Metadata, OpenOptions},
	io::{self, Read},
	path::Path,
};

#[cfg(unix)]
const SQLITE_HEADER: &[u8; 16] = b"SQLite format 3\0";
#[cfg(unix)]
const WAL_INDEX_VERSION: u32 = 3_007_000;

/// Regular files the process had open when the snapshot was taken, keyed by device and inode.
#[derive(Debug)]
pub struct HeldFiles {
	by_inode: HashMap<(u64, u64), i32>,
}

impl HeldFiles {
	#[cfg(unix)]
	pub fn snapshot() -> Self {
		let mut by_inode = HashMap::new();
		let Ok(entries) = std::fs::read_dir("/dev/fd") else {
			return Self { by_inode };
		};
		for entry in entries.flatten() {
			let Some(fd) = entry.file_name().to_str().and_then(|name| name.parse::<i32>().ok()) else {
				continue;
			};
			let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
			// SAFETY: fstat only writes the provided buffer; a descriptor closed meanwhile yields EBADF.
			if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0 {
				continue;
			}
			// SAFETY: fstat succeeded and initialized the buffer.
			let stat = unsafe { stat.assume_init() };
			if stat.st_mode & libc::S_IFMT == libc::S_IFREG {
				by_inode.entry((stat.st_dev as u64, stat.st_ino as u64)).or_insert(fd);
			}
		}
		Self { by_inode }
	}

	#[cfg(not(unix))]
	pub fn snapshot() -> Self {
		Self { by_inode: HashMap::new() }
	}

	/// Fails when opening `path` would release SQLite locks this process holds on it.
	pub fn check(&self, path: &Path) -> io::Result<()> {
		match std::fs::metadata(path) {
			Ok(metadata) => self.check_metadata(path, &metadata),
			Err(_) => Ok(()),
		}
	}

	/// [`Self::check`] for callers that already hold the target's (symlink-followed) metadata.
	#[cfg(unix)]
	pub fn check_metadata(&self, path: &Path, metadata: &Metadata) -> io::Result<()> {
		use std::os::unix::fs::MetadataExt;
		if !metadata.is_file() {
			return Ok(());
		}
		match self.by_inode.get(&(metadata.dev(), metadata.ino())) {
			Some(&fd) if is_sqlite_store(fd, path) => Err(held_error()),
			_ => Ok(()),
		}
	}

	#[cfg(not(unix))]
	pub fn check_metadata(&self, _path: &Path, _metadata: &Metadata) -> io::Result<()> {
		Ok(())
	}

	pub fn open(&self, path: &Path, options: &OpenOptions) -> io::Result<File> {
		self.check(path)?;
		options.open(path)
	}

	pub fn open_read(&self, path: &Path) -> io::Result<File> {
		self.open(path, OpenOptions::new().read(true))
	}
}

/// Opens `path` unless that would release SQLite locks this process holds on it.
pub fn open(path: impl AsRef<Path>, options: &OpenOptions) -> io::Result<File> {
	HeldFiles::snapshot().open(path.as_ref(), options)
}

/// [`open`] for reading, like [`File::open`].
pub fn open_read(path: impl AsRef<Path>) -> io::Result<File> {
	HeldFiles::snapshot().open_read(path.as_ref())
}

/// [`std::fs::read`] unless that would release SQLite locks this process holds on `path`.
pub fn read(path: impl AsRef<Path>) -> io::Result<Vec<u8>> {
	let mut bytes = Vec::new();
	open_read(path)?.read_to_end(&mut bytes)?;
	Ok(bytes)
}

/// [`std::fs::read_to_string`] unless that would release SQLite locks this process holds on `path`.
pub fn read_to_string(path: impl AsRef<Path>) -> io::Result<String> {
	let mut text = String::new();
	open_read(path)?.read_to_string(&mut text)?;
	Ok(text)
}

/// Whether `path` is a SQLite database or `-shm` index this process currently holds open.
pub fn is_held_sqlite_store(path: impl AsRef<Path>) -> bool {
	HeldFiles::snapshot().check(path.as_ref()).is_err()
}

#[cfg(unix)]
fn held_error() -> io::Error {
	io::Error::new(
		io::ErrorKind::ResourceBusy,
		"SQLite database held open by this process; reading it in-process would release its locks \
		 and can corrupt it (use sqlite3 or an external program)",
	)
}

#[cfg(unix)]
fn is_sqlite_store(fd: i32, path: &Path) -> bool {
	if path.file_name().is_some_and(|name| name.as_encoded_bytes().ends_with(b"-shm")) {
		return true;
	}
	let mut header = [0u8; 16];
	// SAFETY: pread only writes the provided buffer and never closes the borrowed descriptor.
	let read = unsafe { libc::pread(fd, header.as_mut_ptr().cast(), header.len(), 0) };
	let Ok(read) = usize::try_from(read) else {
		return false;
	};
	let header = &header[..read];
	header == SQLITE_HEADER
		|| header
			.first_chunk::<4>()
			.is_some_and(|version| u32::from_ne_bytes(*version) == WAL_INDEX_VERSION)
}
