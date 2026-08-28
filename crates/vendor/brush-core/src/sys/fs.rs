//! Filesystem utilities

use std::{
	borrow::Cow,
	path::{Path, PathBuf},
};

/// Normalizes shell-facing path aliases before `std::fs` sees them.
#[allow(clippy::missing_const_for_fn, reason = "Windows implementation allocates")]
pub fn normalize_shell_path(path: &Path) -> Cow<'_, Path> {
	#[cfg(windows)]
	{
		translate_unix_drive_path(path).map_or(Cow::Borrowed(path), Cow::Owned)
	}
	#[cfg(not(windows))]
	{
		Cow::Borrowed(path)
	}
}

/// Returns a Windows drive root for a shell pattern that starts with an MSYS/WSL drive alias.
#[allow(clippy::missing_const_for_fn, reason = "Windows implementation allocates")]
pub fn pattern_drive_alias_root(
	starts_with_forward_slash: bool,
	first: &str,
	second: Option<&str>,
	third: Option<&str>,
) -> Option<(PathBuf, usize)> {
	#[cfg(windows)]
	{
		pattern_drive_alias_root_impl(starts_with_forward_slash, first, second, third)
	}
	#[cfg(not(windows))]
	{
		let _ = (starts_with_forward_slash, first, second, third);
		None
	}
}

#[cfg(windows)]
fn pattern_drive_alias_root_impl(
	starts_with_forward_slash: bool,
	first: &str,
	second: Option<&str>,
	third: Option<&str>,
) -> Option<(PathBuf, usize)> {
	if !starts_with_forward_slash || !first.is_empty() {
		return None;
	}

	if let Some(drive) = second
		&& is_ascii_drive_component(drive)
	{
		return Some((drive_root_path(drive.as_bytes()[0]), 2));
	}

	if let (Some(mount), Some(drive)) = (second, third)
		&& mount.eq_ignore_ascii_case("mnt")
		&& is_ascii_drive_component(drive)
	{
		return Some((drive_root_path(drive.as_bytes()[0]), 3));
	}

	None
}

#[cfg(windows)]
fn drive_root_path(drive: u8) -> PathBuf {
	let mut root = String::with_capacity(3);
	root.push(char::from(drive).to_ascii_uppercase());
	root.push(':');
	root.push('/');
	PathBuf::from(root)
}

#[cfg(windows)]
const fn is_ascii_drive_component(value: &str) -> bool {
	value.len() == 1 && value.as_bytes()[0].is_ascii_alphabetic()
}

#[cfg(windows)]
fn translate_unix_drive_path(path: &Path) -> Option<PathBuf> {
	let raw = path.to_str()?;
	let bytes = raw.as_bytes();
	let (drive, tail) = drive_alias_parts(bytes)?;

	// `tail` is a suffix of the valid UTF-8 `raw` beginning at an ASCII `/`
	// boundary, so it is itself valid UTF-8. Translate separators per `char` —
	// iterating bytes would split multibyte scalars (e.g. `José` → `JosÃ©`).
	let tail = std::str::from_utf8(tail).ok()?;
	let mut native = String::with_capacity(3 + tail.len());
	native.push(char::from(drive).to_ascii_uppercase());
	native.push(':');
	native.push('\\');
	for ch in tail.chars() {
		native.push(if ch == '/' || ch == '\\' { '\\' } else { ch });
	}
	Some(PathBuf::from(native))
}

#[cfg(windows)]
fn drive_alias_parts(bytes: &[u8]) -> Option<(u8, &[u8])> {
	if bytes.len() >= 2
		&& bytes[0] == b'/'
		&& bytes[1].is_ascii_alphabetic()
		&& bytes.get(2).is_none_or(|byte| *byte == b'/')
	{
		let tail = if bytes.len() > 2 { &bytes[3..] } else { &[] };
		return Some((bytes[1], tail));
	}

	if bytes.len() >= 6
		&& bytes[0] == b'/'
		&& bytes[1..4].eq_ignore_ascii_case(b"mnt")
		&& bytes[4] == b'/'
		&& bytes[5].is_ascii_alphabetic()
		&& bytes.get(6).is_none_or(|byte| *byte == b'/')
	{
		let tail = if bytes.len() > 6 { &bytes[7..] } else { &[] };
		return Some((bytes[5], tail));
	}

	None
}

pub use super::platform::fs::*;

/// Extension trait for path-related filesystem operations.
pub trait PathExt {
	/// Returns true if the path exists and is readable by the current user.
	fn readable(&self) -> bool;
	/// Returns true if the path exists and is writable by the current user.
	fn writable(&self) -> bool;
	/// Returns true if the path exists and is executable by the current user.
	///
	/// On Windows, this returns true if *either* the path itself is a file with
	/// a `PATHEXT` extension *or* appending some `PATHEXT` extension resolves
	/// to an existing file. To recover the actual on-disk path in the
	/// latter case, use [`resolve_executable`] which takes ownership
	/// and avoids copies on platforms where no resolution is needed.
	fn executable(&self) -> bool;

	/// Returns true if the path exists and is a block device.
	fn exists_and_is_block_device(&self) -> bool;
	/// Returns true if the path exists and is a character device.
	fn exists_and_is_char_device(&self) -> bool;
	/// Returns true if the path exists and is a FIFO (named pipe).
	fn exists_and_is_fifo(&self) -> bool;
	/// Returns true if the path exists and is a socket.
	fn exists_and_is_socket(&self) -> bool;
	/// Returns true if the path exists and has the setgid bit set.
	fn exists_and_is_setgid(&self) -> bool;
	/// Returns true if the path exists and has the setuid bit set.
	fn exists_and_is_setuid(&self) -> bool;
	/// Returns true if the path exists and has the sticky bit set.
	fn exists_and_is_sticky_bit(&self) -> bool;

	/// Returns the device ID and inode number for the path.
	fn get_device_and_inode(&self) -> Result<(u64, u64), crate::error::Error>;
}


