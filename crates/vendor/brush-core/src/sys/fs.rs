

use std::{
	borrow::Cow,
	path::{Path, PathBuf},
};


#[allow(clippy::missing_const_for_fn)]
pub fn normalize_shell_path(path: &Path) -> Cow<'_, Path> {
	Cow::Borrowed(path)
}


#[allow(clippy::missing_const_for_fn)]
pub fn pattern_drive_alias_root(
	starts_with_forward_slash: bool,
	first: &str,
	second: Option<&str>,
	third: Option<&str>,
) -> Option<(PathBuf, usize)> {
	let _ = (starts_with_forward_slash, first, second, third);
	None
}


pub use super::platform::fs::*;


pub trait PathExt {

	fn readable(&self) -> bool;

	fn writable(&self) -> bool;


	fn executable(&self) -> bool;


	fn exists_and_is_block_device(&self) -> bool;

	fn exists_and_is_char_device(&self) -> bool;

	fn exists_and_is_fifo(&self) -> bool;

	fn exists_and_is_socket(&self) -> bool;

	fn exists_and_is_setgid(&self) -> bool;

	fn exists_and_is_setuid(&self) -> bool;

	fn exists_and_is_sticky_bit(&self) -> bool;


	fn get_device_and_inode(&self) -> Result<(u64, u64), crate::error::Error>;
}


