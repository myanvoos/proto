

use crate::error;

pub(crate) trait MetadataExt {
	fn gid(&self) -> u32 {
		0
	}

	fn uid(&self) -> u32 {
		0
	}
}

impl MetadataExt for std::fs::Metadata {}

pub(crate) fn get_default_executable_search_paths() -> Vec<std::path::PathBuf> {
	vec![]
}



pub fn get_default_standard_utils_paths() -> Vec<std::path::PathBuf> {
	vec![]
}




pub fn open_null_file() -> Result<std::fs::File, error::Error> {
	Err(error::ErrorKind::NotSupportedOnThisPlatform("opening null file").into())
}





pub fn try_open_special_file(
	_path: &std::path::Path,
) -> Option<Result<std::fs::File, std::io::Error>> {
	None
}




pub fn get_system_profile_path() -> Option<&'static std::path::Path> {
	None
}




pub fn get_system_rc_path() -> Option<&'static std::path::Path> {
	None
}




pub const fn default_case_insensitive_path_expansion() -> bool {
	false
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




pub fn rfind_path_separator(s: &str) -> Option<usize> {
	s.rfind('/')
}





pub fn split_path_for_pattern(s: &str) -> impl Iterator<Item = &str> {
	s.split('/')
}






pub fn pattern_path_root(first_component: &str) -> Option<std::path::PathBuf> {
	if first_component.is_empty() {
		Some(std::path::PathBuf::from("/"))
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






pub fn resolve_executable(path: std::path::PathBuf) -> Option<std::path::PathBuf> {
	use crate::sys::fs::PathExt;
	if path.as_path().executable() {
		Some(path)
	} else {
		None
	}
}
