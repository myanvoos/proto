

pub use std::os::unix::fs::MetadataExt;
use std::{
	os::unix::{ffi::OsStringExt, fs::FileTypeExt},
	path::{Path, PathBuf},
};

use crate::error;

#[cfg(target_os = "android")]

const ANDROID_DEFPATH: &str = "/product/bin:/apex/com.android.runtime/bin:/apex/com.android.art/\
                               bin:/apex/com.android.virt/bin:/system_ext/bin:/system/bin:/system/\
                               xbin:/odm/bin:/vendor/bin:/vendor/xbin";

impl crate::sys::fs::PathExt for Path {
	fn readable(&self) -> bool {
		nix::unistd::access(self, nix::unistd::AccessFlags::R_OK).is_ok()
	}

	fn writable(&self) -> bool {
		nix::unistd::access(self, nix::unistd::AccessFlags::W_OK).is_ok()
	}

	fn executable(&self) -> bool {
		nix::unistd::access(self, nix::unistd::AccessFlags::X_OK).is_ok()
	}

	fn exists_and_is_block_device(&self) -> bool {
		try_get_file_type(self).is_some_and(|ft| ft.is_block_device())
	}

	fn exists_and_is_char_device(&self) -> bool {
		try_get_file_type(self).is_some_and(|ft| ft.is_char_device())
	}

	fn exists_and_is_fifo(&self) -> bool {
		try_get_file_type(self).is_some_and(|ft: std::fs::FileType| ft.is_fifo())
	}

	fn exists_and_is_socket(&self) -> bool {
		try_get_file_type(self).is_some_and(|ft| ft.is_socket())
	}

	fn exists_and_is_setgid(&self) -> bool {
		const S_ISGID: u32 = 0o2000;
		let file_mode = try_get_file_mode(self);
		file_mode.is_some_and(|mode| mode & S_ISGID != 0)
	}

	fn exists_and_is_setuid(&self) -> bool {
		const S_ISUID: u32 = 0o4000;
		let file_mode = try_get_file_mode(self);
		file_mode.is_some_and(|mode| mode & S_ISUID != 0)
	}

	fn exists_and_is_sticky_bit(&self) -> bool {
		const S_ISVTX: u32 = 0o1000;
		let file_mode = try_get_file_mode(self);
		file_mode.is_some_and(|mode| mode & S_ISVTX != 0)
	}

	fn get_device_and_inode(&self) -> Result<(u64, u64), crate::error::Error> {
		let metadata = self.metadata()?;
		Ok((metadata.dev(), metadata.ino()))
	}
}

fn try_get_file_type(path: &Path) -> Option<std::fs::FileType> {
	path.metadata().map(|metadata| metadata.file_type()).ok()
}

fn try_get_file_mode(path: &Path) -> Option<u32> {
	path.metadata().map(|metadata| metadata.mode()).ok()
}




pub fn split_paths<T: AsRef<std::ffi::OsStr> + ?Sized>(s: &T) -> std::env::SplitPaths<'_> {
	std::env::split_paths(s)
}

pub(crate) fn get_default_executable_search_paths() -> Vec<PathBuf> {
	#[cfg(target_os = "android")]
	{
		std::env::split_paths(ANDROID_DEFPATH).collect()
	}
	#[cfg(not(target_os = "android"))]
	{

		vec![
			"/usr/local/sbin".into(),
			"/usr/local/bin".into(),
			"/usr/sbin".into(),
			"/usr/bin".into(),
			"/sbin".into(),
			"/bin".into(),
		]
	}
}



pub fn get_default_standard_utils_paths() -> Vec<PathBuf> {





	if let Ok(Some(cs_path)) = confstr_cs_path()
		&& !cs_path.as_os_str().is_empty()
	{
		return split_paths(&cs_path).collect();
	}

	#[cfg(target_os = "android")]
	{
		std::env::split_paths(ANDROID_DEFPATH).collect()
	}
	#[cfg(not(target_os = "android"))]
	{

		vec![
			"/bin".into(),
			"/usr/bin".into(),
			"/sbin".into(),
			"/usr/sbin".into(),
			"/etc".into(),
			"/usr/etc".into(),
		]
	}
}

#[allow(clippy::unnecessary_wraps)]
fn confstr_cs_path() -> Result<Option<PathBuf>, std::io::Error> {
	#[cfg(target_os = "android")]
	{
		Ok(Some(PathBuf::from(ANDROID_DEFPATH)))
	}
	#[cfg(not(target_os = "android"))]
	{
		let value = confstr(nix::libc::_CS_PATH)?;

		if let Some(value) = value {
			let value_str = PathBuf::from(value);
			Ok(Some(value_str))
		} else {
			Ok(None)
		}
	}
}








#[cfg(not(target_os = "android"))]
fn confstr(name: nix::libc::c_int) -> Result<Option<std::ffi::OsString>, std::io::Error> {




	let required_size = unsafe { nix::libc::confstr(name, std::ptr::null_mut(), 0) };





	if required_size == 0 {
		return Ok(None);
	}

	let mut buffer = Vec::<u8>::with_capacity(required_size);






	let final_size =
		unsafe { nix::libc::confstr(name, buffer.as_mut_ptr().cast(), buffer.capacity()) };

	if final_size == 0 {
		return Err(std::io::Error::last_os_error());
	}





	if final_size > buffer.capacity() {
		return Err(std::io::Error::other("confstr needed more space than advertised"));
	}






	unsafe { buffer.set_len(final_size) };


	if !matches!(buffer.pop(), Some(0)) {
		return Err(std::io::Error::other("confstr did not null-terminate the returned string"));
	}

	Ok(Some(std::ffi::OsString::from_vec(buffer)))
}


pub fn open_null_file() -> Result<std::fs::File, error::Error> {
	let f = std::fs::File::options()
		.read(true)
		.write(true)
		.open("/dev/null")?;

	Ok(f)
}



pub const fn try_open_special_file(_path: &Path) -> Option<Result<std::fs::File, std::io::Error>> {
	None
}


pub fn get_system_profile_path() -> Option<&'static Path> {
	Some(Path::new("/etc/profile"))
}


pub fn get_system_rc_path() -> Option<&'static Path> {
	Some(Path::new("/etc/bash.bashrc"))
}




pub fn contains_path_separator(s: &str) -> bool {
	s.contains('/')
}




pub fn ends_with_path_separator(s: &str) -> bool {
	s.ends_with('/')
}




pub fn strip_path_separator_suffix(s: &str) -> &str {
	s.strip_suffix('/').unwrap_or(s)
}




pub const fn default_case_insensitive_path_expansion() -> bool {
	false
}




pub fn rfind_path_separator(s: &str) -> Option<usize> {
	s.rfind('/')
}





pub fn split_path_for_pattern(s: &str) -> impl Iterator<Item = &str> {
	s.split('/')
}






pub fn pattern_path_root(first_component: &str) -> Option<PathBuf> {
	if first_component.is_empty() {
		Some(PathBuf::from("/"))
	} else {
		None
	}
}




pub fn push_path_for_pattern(path: &mut std::path::PathBuf, component: &str) {
	path.push(component);
}




pub const fn normalize_path_separators(s: &str) -> std::borrow::Cow<'_, str> {
	std::borrow::Cow::Borrowed(s)
}









pub fn resolve_executable(path: PathBuf) -> Option<PathBuf> {
	use crate::sys::fs::PathExt;
	if path.as_path().executable() {
		Some(path)
	} else {
		None
	}
}


