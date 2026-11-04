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
		let paths =
			crate::sys::fs::split_paths(path_var.as_ref()).map(|entry| self.working_dir().join(entry));

		pathsearch::search_for_executable(paths, filename)
	}

	pub fn find_executables_in_path_with_prefix(
		&self,
		filename_prefix: &str,
		case_insensitive: bool,
	) -> impl Iterator<Item = PathBuf> {
		let path_var = self.env.get_str("PATH", self).unwrap_or_default();
		let paths =
			crate::sys::fs::split_paths(path_var.as_ref()).map(|entry| self.working_dir().join(entry));

		pathsearch::search_for_executable_with_prefix(paths, filename_prefix, case_insensitive)
	}

	pub fn find_first_executable_in_path<S: AsRef<str>>(
		&self,
		candidate_name: S,
	) -> Option<PathBuf> {
		let path_var = self.env_str("PATH").unwrap_or_default();
		let paths =
			crate::sys::fs::split_paths(path_var.as_ref()).map(|entry| self.working_dir().join(entry));
		pathsearch::search_for_executable(paths, candidate_name.as_ref()).next()
	}

	pub fn find_first_executable_in_path_using_cache<S: AsRef<str>>(
		&mut self,
		candidate_name: S,
	) -> Option<PathBuf>
	where
		String: From<S>,
	{
		let path = self.env_str("PATH").unwrap_or_default().into_owned();
		let cwd = self.working_dir().to_owned();
		self.program_location_cache.set_search_context(&path, &cwd);
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

	pub(crate) async fn open_file(
		&self,
		options: &std::fs::OpenOptions,
		path: impl AsRef<Path>,
		params: &ExecutionParameters,
	) -> Result<openfiles::OpenFile, std::io::Error> {
		if let Some(result) = crate::sys::fs::try_open_special_file(path.as_ref()) {
			return result.map(openfiles::OpenFile::from);
		}

		let path_to_open = self.absolute_path(path.as_ref());

		if let Some(openfiles::DescriptorPath::Fd(fd)) =
			openfiles::DescriptorPath::parse(&path_to_open)
		{
			return params
				.try_fd(self, fd)
				.ok_or_else(|| openfiles::DescriptorPath::Fd(fd).unavailable_error())?
				.try_clone();
		}

		#[cfg(unix)]
		let options = &{
			use std::os::unix::fs::OpenOptionsExt;
			let mut options = options.clone();
			if let Some(mask) = self.umask() {
				options.mode(0o666 & !mask);
			}
			options
		};
		#[cfg(unix)]
		{
			use std::os::unix::fs::FileTypeExt;
			if openfiles::DescriptorPath::parse(&path_to_open).is_none()
				&& std::fs::metadata(&path_to_open).is_ok_and(|meta| meta.file_type().is_fifo())
			{
				return open_fifo(path_to_open, options.clone(), params.cancel_token())
					.await
					.map(Into::into);
			}
		}
		Ok(crate::heldfiles::open(path_to_open, options)?.into())
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

/// A dropped/cancelled open must release its blocking worker before a later
/// command opens the same FIFO. Opening its other end releases open(2).
#[cfg(unix)]
async fn open_fifo(
	path: PathBuf,
	options: std::fs::OpenOptions,
	cancel: Option<tokio_util::sync::CancellationToken>,
) -> std::io::Result<std::fs::File> {
	struct Release {
		path:  PathBuf,
		done:  std::sync::mpsc::Receiver<()>,
		armed: bool,
	}
	impl Drop for Release {
		fn drop(&mut self) {
			if !self.armed {
				return;
			}
			use std::os::unix::fs::OpenOptionsExt;
			// O_RDWR|O_NONBLOCK never waits for a peer; it releases either
			// direction of a pending FIFO open without consuming data.
			let peer = std::fs::OpenOptions::new()
				.read(true)
				.write(true)
				.custom_flags(nix::libc::O_NONBLOCK)
				.open(&self.path);
			if peer.is_ok() {
				let _ = self
					.done
					.recv_timeout(std::time::Duration::from_millis(500));
			}
		}
	}
	let (done_tx, done_rx) = std::sync::mpsc::channel();
	let mut release = Release { path: path.clone(), done: done_rx, armed: true };
	let task = tokio::task::spawn_blocking(move || {
		let result = crate::heldfiles::open(path, &options);
		let _ = done_tx.send(());
		result
	});
	let cancelled = async {
		match cancel {
			Some(token) => token.cancelled().await,
			None => std::future::pending().await,
		}
	};
	let result = tokio::select! {
		result = task => result.map_err(std::io::Error::other)?,
		() = cancelled => return Err(std::io::ErrorKind::Interrupted.into()),
	};
	release.armed = false;
	result
}
