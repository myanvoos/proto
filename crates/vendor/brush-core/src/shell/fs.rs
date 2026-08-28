

use std::path::{Path, PathBuf};

use normalize_path::NormalizePath as _;

use crate::{
	ExecutionParameters, ShellFd,
	env::{EnvironmentLookup, EnvironmentScope},
	error, openfiles, pathsearch,
	sys::users,
	variables,
};

impl<SE: crate::extensions::ShellExtensions> crate::Shell<SE> {





	pub fn set_working_dir(&mut self, target_dir: impl AsRef<Path>) -> Result<(), error::Error> {
		let abs_path = self.absolute_path(target_dir.as_ref());

		match std::fs::metadata(&abs_path) {
			Ok(m) => {
				if !m.is_dir() {
					return Err(error::ErrorKind::NotADirectory(abs_path).into());
				}
			},
			Err(e) => {
				return Err(e.into());
			},
		}


		let cleaned_path = abs_path.normalize();

		let pwd = cleaned_path.to_string_lossy().to_string();

		self.env.update_or_add(
			"PWD",
			variables::ShellValueLiteral::Scalar(pwd),
			|_| Ok(()),
			EnvironmentLookup::Anywhere,
			EnvironmentScope::Global,
		)?;
		let oldpwd = std::mem::replace(self.working_dir_mut(), cleaned_path);

		self.env.update_or_add(
			"OLDPWD",
			variables::ShellValueLiteral::Scalar(oldpwd.to_string_lossy().to_string()),
			|_| Ok(()),
			EnvironmentLookup::Anywhere,
			EnvironmentScope::Global,
		)?;

		Ok(())
	}







	pub fn tilde_shorten(&self, s: String) -> String {
		if let Some(home_dir) = self.home_dir()
			&& let Some(stripped) = s.strip_prefix(home_dir.to_string_lossy().as_ref())
		{
			return format!("~{stripped}");
		}
		s
	}


	pub(crate) fn home_dir(&self) -> Option<PathBuf> {
		if let Some(home) = self.env.get_str("HOME", self) {
			Some(PathBuf::from(home.to_string()))
		} else {

			users::get_current_user_home_dir()
		}
	}







	pub fn find_executables_in_path<'a>(
		&'a self,
		filename: &'a str,
	) -> impl Iterator<Item = PathBuf> + 'a {
		let path_var = self.env.get_str("PATH", self).unwrap_or_default();
		let paths = crate::sys::fs::split_paths(path_var.as_ref());

		pathsearch::search_for_executable(paths, filename)
	}







	pub fn find_executables_in_path_with_prefix(
		&self,
		filename_prefix: &str,
		case_insensitive: bool,
	) -> impl Iterator<Item = PathBuf> {
		let path_var = self.env.get_str("PATH", self).unwrap_or_default();
		let paths = crate::sys::fs::split_paths(path_var.as_ref());

		pathsearch::search_for_executable_with_prefix(paths, filename_prefix, case_insensitive)
	}








	pub fn find_first_executable_in_path<S: AsRef<str>>(
		&self,
		candidate_name: S,
	) -> Option<PathBuf> {
		let path_var = self.env_str("PATH").unwrap_or_default();
		let paths = crate::sys::fs::split_paths(path_var.as_ref());
		pathsearch::search_for_executable(paths, candidate_name.as_ref()).next()
	}









	pub fn find_first_executable_in_path_using_cache<S: AsRef<str>>(
		&mut self,
		candidate_name: S,
	) -> Option<PathBuf>
	where
		String: From<S>,
	{
		if let Some(cached_path) = self.program_location_cache.get(&candidate_name) {
			Some(cached_path)
		} else if let Some(found_path) = self.find_first_executable_in_path(&candidate_name) {
			self
				.program_location_cache
				.set(candidate_name, found_path.clone());
			Some(found_path)
		} else {
			None
		}
	}






	pub fn absolute_path(&self, path: impl AsRef<Path>) -> PathBuf {
		let normalized_path = crate::sys::fs::normalize_shell_path(path.as_ref());
		let path = normalized_path.as_ref();
		if path.as_os_str().is_empty() || path.is_absolute() {
			path.to_owned()
		} else {
			self.working_dir().join(path)
		}
	}










	pub(crate) fn open_file(
		&self,
		options: &std::fs::OpenOptions,
		path: impl AsRef<Path>,
		params: &ExecutionParameters,
	) -> Result<openfiles::OpenFile, std::io::Error> {




		if let Some(result) = crate::sys::fs::try_open_special_file(path.as_ref()) {
			return result.map(openfiles::OpenFile::from);
		}

		let path_to_open = self.absolute_path(path.as_ref());




		if let Some(parent) = path_to_open.parent()
			&& parent == Path::new("/dev/fd")
			&& let Some(filename) = path_to_open.file_name()
			&& let Ok(fd_num) = filename.to_string_lossy().to_string().parse::<ShellFd>()
			&& let Some(open_file) = params.try_fd(self, fd_num)
		{
			return open_file.try_clone();
		}

		Ok(options.open(path_to_open)?.into())
	}







	pub fn replace_open_files(
		&mut self,
		open_fds: impl Iterator<Item = (ShellFd, openfiles::OpenFile)>,
	) {
		self.open_files = openfiles::OpenFiles::from(open_fds);
	}

	pub(crate) const fn persistent_open_files(&self) -> &openfiles::OpenFiles {
		&self.open_files
	}
}
