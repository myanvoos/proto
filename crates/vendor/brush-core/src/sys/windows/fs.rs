

use std::{
	ffi::OsStr,
	path::{Path, PathBuf},
	sync::LazyLock,
};
use std::os::windows::{
	fs::OpenOptionsExt,
	io::AsRawHandle,
};

use crate::error;

pub(crate) use crate::sys::stubs::fs::MetadataExt;
use windows_sys::Win32::{
	Foundation::HANDLE,
	Storage::FileSystem::{
		BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, GetFileInformationByHandle,
	},
};








static PATHEXT_EXTENSIONS: LazyLock<Vec<String>> = LazyLock::new(|| {
	let fallback = || {
		[".com", ".exe", ".bat", ".cmd"]
			.into_iter()
			.map(|ext| ext.to_string())
			.collect::<Vec<_>>()
	};

	let Some(value) = std::env::var_os("PATHEXT") else {
		return fallback();
	};

	let extensions = value
		.to_string_lossy()
		.split(';')
		.filter_map(|entry| {
			let entry = entry.trim();
			if entry.is_empty() {
				None
			} else if entry.starts_with('.') {
				Some(entry.to_ascii_lowercase())
			} else {
				Some(format!(".{}", entry.to_ascii_lowercase()))
			}
		})
		.collect::<Vec<_>>();

	if extensions.is_empty() {
		fallback()
	} else {
		extensions
	}
});





fn pathext_entry_stem(entry: &str) -> &str {
	entry.strip_prefix('.').unwrap_or(entry)
}





fn has_executable_extension(path: &Path) -> bool {
	path.extension().is_some_and(|ext| {
		PATHEXT_EXTENSIONS
			.iter()
			.any(|e| ext.eq_ignore_ascii_case(pathext_entry_stem(e)))
	})
}





fn is_executable_file(path: &Path) -> bool {
	has_executable_extension(path) && path.is_file()
}






pub fn resolve_executable(path: PathBuf) -> Option<PathBuf> {
	if is_executable_file(&path) {
		return Some(path);
	}

	for ext in PATHEXT_EXTENSIONS.iter() {
		let mut name = path.as_os_str().to_owned();
		name.push(ext);
		let candidate = PathBuf::from(name);
		if candidate.is_file() {
			return Some(candidate);
		}
	}
	None
}

impl crate::sys::fs::PathExt for Path {
	fn readable(&self) -> bool {
		std::fs::OpenOptions::new().read(true).open(self).is_ok()
	}

	fn writable(&self) -> bool {
		std::fs::OpenOptions::new().write(true).open(self).is_ok()
	}

	fn executable(&self) -> bool {
		if is_executable_file(self) {
			return true;
		}


		PATHEXT_EXTENSIONS.iter().any(|ext| {
			let mut name = self.as_os_str().to_owned();
			name.push(ext);
			Self::new(&name).is_file()
		})
	}

	fn exists_and_is_block_device(&self) -> bool {
		false
	}

	fn exists_and_is_char_device(&self) -> bool {
		false
	}

	fn exists_and_is_fifo(&self) -> bool {
		false
	}

	fn exists_and_is_socket(&self) -> bool {
		false
	}

	fn exists_and_is_setgid(&self) -> bool {
		false
	}

	fn exists_and_is_setuid(&self) -> bool {
		false
	}

	fn exists_and_is_sticky_bit(&self) -> bool {
		false
	}

	fn get_device_and_inode(&self) -> Result<(u64, u64), crate::error::Error> {
		let file = std::fs::OpenOptions::new()
			.access_mode(0)
			.custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
			.open(self)?;
		let mut info = BY_HANDLE_FILE_INFORMATION {



			..unsafe { std::mem::zeroed() }
		};

		let succeeded = {



			(unsafe {
				GetFileInformationByHandle(file.as_raw_handle() as HANDLE, &mut info)
			}) != 0
		};
		if !succeeded {
			return Err(std::io::Error::last_os_error().into());
		}

		let file_index = (u64::from(info.nFileIndexHigh) << 32)
			| u64::from(info.nFileIndexLow);
		Ok((u64::from(info.dwVolumeSerialNumber), file_index))
	}
}






pub fn split_paths<T: AsRef<OsStr> + ?Sized>(
	s: &T,
) -> impl Iterator<Item = PathBuf> + '_ {
	std::env::split_paths(s).map(trim_surrounding_path_quotes)
}

fn trim_surrounding_path_quotes(path: PathBuf) -> PathBuf {
	PathBuf::from(path.to_string_lossy().trim_matches('"').to_string())
}


pub fn open_null_file() -> Result<std::fs::File, error::Error> {
	let f = std::fs::File::options()
		.read(true)
		.write(true)
		.open("NUL")?;
	Ok(f)
}



pub fn try_open_special_file(path: &Path) -> Option<Result<std::fs::File, std::io::Error>> {
	if path.ends_with("dev/null") && path.is_absolute() {
		Some(open_null_file().map_err(std::io::Error::other))
	} else {
		None
	}
}


pub(crate) fn get_default_executable_search_paths() -> Vec<PathBuf> {
	default_system_paths()
}



pub fn get_default_standard_utils_paths() -> Vec<PathBuf> {
	default_system_paths()
}

fn default_system_paths() -> Vec<PathBuf> {
	let mut paths = Vec::new();
	if let Some(system32) = system32_path() {
		paths.push(system32.clone());
		if let Some(system_root) = system32.parent() {
			paths.push(system_root.to_path_buf());
		}
		paths.push(system32.join("Wbem"));
		paths.push(system32.join("WindowsPowerShell").join("v1.0"));
	}
	if paths.is_empty()
		&& let Some(env_path) = std::env::var_os("PATH")
	{
		paths.extend(std::env::split_paths(&env_path));
	}
	if let Ok(userprofile) = std::env::var("USERPROFILE") {
		paths.push(
			PathBuf::from(userprofile)
				.join("AppData")
				.join("Local")
				.join("Microsoft")
				.join("WindowsApps"),
		);
	}
	paths
}

fn system32_path() -> Option<PathBuf> {
	let system_root = std::env::var_os("SystemRoot")?;
	Some(PathBuf::from(system_root).join("System32"))
}




pub const fn get_system_profile_path() -> Option<&'static Path> {
	None
}




pub const fn get_system_rc_path() -> Option<&'static Path> {
	None
}





pub const fn default_case_insensitive_path_expansion() -> bool {
	true
}


const PATH_SEPARATORS: [char; 2] = ['/', '\\'];




pub fn contains_path_separator(s: &str) -> bool {
	s.contains(PATH_SEPARATORS)
}




pub fn ends_with_path_separator(s: &str) -> bool {
	s.ends_with(PATH_SEPARATORS)
}




pub fn strip_path_separator_suffix(s: &str) -> &str {
	s.strip_suffix(PATH_SEPARATORS).unwrap_or(s)
}




pub fn rfind_path_separator(s: &str) -> Option<usize> {
	s.rfind(PATH_SEPARATORS)
}





pub fn split_path_for_pattern(s: &str) -> impl Iterator<Item = &str> {
	s.split(PATH_SEPARATORS)
}













pub fn pattern_path_root(first_component: &str) -> Option<PathBuf> {
	if first_component.is_empty() {

		Some(PathBuf::from("/"))
	} else if first_component.len() == 2
		&& first_component.as_bytes()[0].is_ascii_alphabetic()
		&& first_component.as_bytes()[1] == b':'
	{

		let mut root = String::with_capacity(3);
		root.push_str(first_component);
		root.push('/');
		Some(PathBuf::from(root))
	} else {
		None
	}
}








pub fn push_path_for_pattern(path: &mut PathBuf, component: &str) {


	let bytes = path.as_os_str().as_encoded_bytes();
	let needs_sep = !bytes.is_empty() && !matches!(bytes.last(), Some(b'/' | b'\\'));

	let buf = path.as_mut_os_string();
	if needs_sep {
		buf.push("/");
	}
	buf.push(component);
}





pub fn normalize_path_separators(s: &str) -> std::borrow::Cow<'_, str> {
	if s.contains('\\') {
		std::borrow::Cow::Owned(s.replace('\\', "/"))
	} else {
		std::borrow::Cow::Borrowed(s)
	}
}


