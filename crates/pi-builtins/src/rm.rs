#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
	ffi::{OsStr, OsString},
	fmt,
	fs::{self, Metadata},
	io::{self, Read, Write},
	ops::BitOr,
	path::{MAIN_SEPARATOR, Path},
};

use brush_core::{ShellExtensions, builtins::Registration, openfiles::OpenFile};
use clap::{
	Arg, ArgAction, ArgMatches, Command,
	builder::{PossibleValue, ValueParser},
	parser::ValueSource,
};
use indicatif::{ProgressBar, ProgressDrawTarget, ProgressStyle, TermLike};
use parking_lot::Mutex;
use thiserror::Error;
use uucore::{display::Quotable, parser::shortcut_value_parser::ShortcutValueParser};

use crate::host::{Host, Utility, format_usage, matches_parser, os_bytes, util};

macro_rules! show_error {
	($host:expr, $($args:tt)+) => {{
		$host.error(format_args!($($args)+), 1);
	}};
}

macro_rules! prompt_yes {
	($host:expr, $($args:tt)+) => {{
		use std::io::Write as _;
		let _ = write!($host.stderr, "rm: ");
		let _ = write!($host.stderr, $($args)+);
		let _ = write!($host.stderr, " ");
		let _ = $host.stderr.flush();
		$crate::rm::read_yes($host)
	}};
}

fn read_yes(host: &mut Host) -> bool {
	let mut byte = [0u8; 1];
	let mut first = None;
	loop {
		match host.stdin.read(&mut byte) {
			Ok(0) => break,
			Err(_) => return false,
			Ok(_) if byte[0] == b'\n' => break,
			Ok(_) => first.get_or_insert(byte[0]),
		};
	}
	matches!(first, Some(b'y' | b'Y'))
}

#[cfg(unix)]
mod platform {
	use std::{collections::HashSet, os::unix::fs::PermissionsExt};
	// This file is part of the uutils coreutils package.
	//
	// For the full copyright and license information, please view the LICENSE
	// file that was distributed with this source code.

	// Unix-specific implementations for the rm utility
	//
	// Descriptor-relative traversal (`openat`/`unlinkat`) only applies to paths
	// the injected filesystem confirms are native host paths; every other path
	// goes through the provider operations in the parent module.
	use std::{
		ffi::{OsStr, OsString},
		fs,
		os::unix::ffi::OsStrExt,
		path::{Path, PathBuf},
	};

	use indicatif::ProgressBar;
	use uucore::{
		display::Quotable,
		safe_traversal::{DirFd, SymlinkBehavior},
	};

	use super::{
		Host, InteractiveMode, Options, handle_error_with_force, is_dir_empty,
		is_missing_under_force, prompt_descend, remove_dir_with_special_cases, remove_file,
		show_permission_denied_error, show_removal_error, verbose_removed_directory,
		verbose_removed_file,
	};

	#[inline]
	fn mode_readable(mode: libc::mode_t) -> bool {
		(mode & libc::S_IRUSR) != 0
	}

	#[inline]
	fn mode_writable(mode: libc::mode_t) -> bool {
		(mode & libc::S_IWUSR) != 0
	}

	/// File prompt that reuses existing stat data to avoid extra statx calls
	fn prompt_file_with_stat(
		host: &mut Host,
		path: &Path,
		stat: &libc::stat,
		options: &Options,
	) -> bool {
		if options.interactive == InteractiveMode::Never {
			return true;
		}

		let is_symlink = ((stat.st_mode as libc::mode_t) & libc::S_IFMT) == libc::S_IFLNK;
		let writable = mode_writable(stat.st_mode as libc::mode_t);
		let len = stat.st_size as u64;
		let stdin_ok = options.__presume_input_tty.unwrap_or(false);

		// Match original behaviour:
		// - Interactive::Always: always prompt; use non-protected wording when
		//   writable, otherwise fall through to protected wording.
		if options.interactive == InteractiveMode::Always {
			if is_symlink {
				return prompt_yes!(host, "remove symbolic link {}?", path.quote());
			}
			if writable {
				return if len == 0 {
					prompt_yes!(host, "remove regular empty file {}?", path.quote())
				} else {
					prompt_yes!(host, "remove file {}?", path.quote())
				};
			}
			// Not writable: use protected wording below
		}

		// Interactive::Once or ::PromptProtected (and non-writable Always) paths
		match (stdin_ok, writable, len == 0) {
			(false, ..) if options.interactive == InteractiveMode::PromptProtected => true,
			(_, true, _) => true,
			(_, false, true) => {
				prompt_yes!(host, "remove write-protected regular empty file {}?", path.quote())
			},
			_ => prompt_yes!(host, "remove write-protected regular file {}?", path.quote()),
		}
	}

	/// Directory prompt that reuses existing stat data to avoid extra statx
	/// calls
	fn prompt_dir_with_mode(
		host: &mut Host,
		path: &Path,
		mode: libc::mode_t,
		options: &Options,
	) -> bool {
		if options.interactive == InteractiveMode::Never {
			return true;
		}

		let readable = mode_readable(mode as libc::mode_t);
		let writable = mode_writable(mode as libc::mode_t);
		let stdin_ok = options.__presume_input_tty.unwrap_or(false);

		match (stdin_ok, readable, writable, options.interactive) {
			(false, _, _, InteractiveMode::PromptProtected) => true,
			(false, false, false, InteractiveMode::Never) => true,
			(_, false, false, _) => {
				prompt_yes!(host, "attempt removal of inaccessible directory {}?", path.quote())
			},
			(_, false, true, InteractiveMode::Always) => {
				prompt_yes!(host, "attempt removal of inaccessible directory {}?", path.quote())
			},
			(_, true, false, _) => {
				prompt_yes!(host, "remove write-protected directory {}?", path.quote())
			},
			(_, _, _, InteractiveMode::Always) => {
				prompt_yes!(host, "remove directory {}?", path.quote())
			},
			(..) => true,
		}
	}

	/// The host directory containing `path` and the entry name within it, when
	/// the injected filesystem confirms the resolved operand is a native host
	/// path.
	///
	/// The operand itself is checked, never a lexical parent: a URL such as
	/// `mem://victim` has the std parent `mem:`, which would name the unrelated
	/// host directory `<cwd>/mem:`.
	fn native_entry(host: &Host, path: &Path) -> Option<(PathBuf, OsString)> {
		let resolved = host.resolve(path);
		if !true {
			return None;
		}
		let parent = resolved.parent()?.to_path_buf();
		let name = resolved.file_name()?.to_os_string();
		Some((parent, name))
	}

	/// Remove a single file using safe traversal.
	///
	/// Returns `None` when `path` is not a native host path, so the caller
	/// removes the file through the injected filesystem instead.
	pub fn safe_remove_file(
		host: &mut Host,
		path: &Path,
		options: &Options,
		progress_bar: Option<&ProgressBar>,
	) -> Option<bool> {
		let (parent, file_name) = native_entry(host, path)?;
		let dir_fd = DirFd::open(&parent, SymlinkBehavior::Follow).ok()?;

		match dir_fd.unlink_at(&file_name, false) {
			Ok(_) => {
				host.note_write(path);
				// Update progress bar for file removal
				if let Some(pb) = progress_bar {
					pb.inc(1);
				}
				verbose_removed_file(host, path, options);
				Some(false)
			},
			Err(e) if is_missing_under_force(&e, options) => Some(false),
			Err(e) => {
				if e.kind() == std::io::ErrorKind::PermissionDenied {
					show_error!(host, "cannot remove {}: Permission denied", path.quote());
				} else {
					let _ = show_removal_error(host, e, path);
				}
				Some(true)
			},
		}
	}

	/// Remove an empty directory using safe traversal.
	///
	/// Returns `None` when `path` is not a native host path, so the caller
	/// removes the directory through the injected filesystem instead.
	pub fn safe_remove_empty_dir(
		host: &mut Host,
		path: &Path,
		options: &Options,
		progress_bar: Option<&ProgressBar>,
	) -> Option<bool> {
		let (parent, dir_name) = native_entry(host, path)?;
		let dir_fd = DirFd::open(&parent, SymlinkBehavior::Follow).ok()?;

		match dir_fd.unlink_at(&dir_name, true) {
			Ok(_) => {
				host.note_write(path);
				// Update progress bar for directory removal
				if let Some(pb) = progress_bar {
					pb.inc(1);
				}
				verbose_removed_directory(host, path, options);
				Some(false)
			},
			Err(e) if is_missing_under_force(&e, options) => Some(false),
			Err(e) => {
				show_error!(host, "cannot remove {}: {e}", path.quote());
				Some(true)
			},
		}
	}

	/// Helper to handle permission denied errors
	fn handle_permission_denied(
		host: &mut Host,
		dir_fd: &DirFd,
		entry_name: &OsStr,
		entry_path: &Path,
		options: &Options,
	) -> bool {
		// When we can't open a subdirectory due to permission denied,
		// try to remove it directly (it might be empty).
		// This matches GNU rm behavior with -f flag.
		if let Err(remove_err) = dir_fd.unlink_at(entry_name, true) {
			if is_missing_under_force(&remove_err, options) {
				return false;
			}
			// The directory is not empty (or another error) and we can't read it
			// to remove its contents. Report the original permission denied error.
			// This matches GNU rm behavior — the real problem is we lack
			// permission to traverse the directory.
			show_permission_denied_error(host, entry_path);
			return true;
		}
		// Successfully removed empty directory
		verbose_removed_directory(host, entry_path, options);
		false
	}

	/// Helper to handle unlink operation with error reporting
	fn handle_unlink(
		host: &mut Host,
		dir_fd: &DirFd,
		entry_name: &OsStr,
		entry_path: &Path,
		is_dir: bool,
		options: &Options,
	) -> bool {
		if let Err(e) = dir_fd.unlink_at(entry_name, is_dir) {
			if is_missing_under_force(&e, options) {
				return false;
			}
			show_error!(host, "cannot remove {}: {e}", entry_path.quote());
			true
		} else {
			if is_dir {
				verbose_removed_directory(host, entry_path, options);
			} else {
				verbose_removed_file(host, entry_path, options);
			}
			false
		}
	}

	/// Removes a native host directory tree with descriptor-relative traversal.
	///
	/// Callers MUST have confirmed that `path` resolves to a native host path.
	pub fn safe_remove_dir_recursive(
		host: &mut Host,
		path: &Path,
		options: &Options,
		progress_bar: Option<&ProgressBar>,
	) -> bool {
		if host.is_cancelled() {
			return true;
		}

		let path_fs = host.resolve(path);
		// Base case 1: this is a file or a symbolic link.
		// Use lstat to avoid race condition between check and use
		let initial_mode = match fs::symlink_metadata(&path_fs) {
			Ok(metadata) if !metadata.is_dir() => {
				return remove_file(host, path, options, progress_bar);
			},
			Ok(metadata) => metadata.permissions().mode(),
			Err(e) if is_missing_under_force(&e, options) => return false,
			Err(e) => {
				return show_removal_error(host, e, path);
			},
		};

		// Try to open the directory using DirFd for secure traversal
		let dir_fd = match DirFd::open(&path_fs, SymlinkBehavior::Follow) {
			Ok(fd) => fd,
			Err(e) if is_missing_under_force(&e, options) => return false,
			Err(e) => {
				// If we can't open the directory for safe traversal,
				// handle the error appropriately and try to remove if possible
				if e.kind() == std::io::ErrorKind::PermissionDenied {
					// Try to remove the directory directly if it's empty
					match fs::remove_dir(&path_fs) {
						Ok(()) => {
							verbose_removed_directory(host, path, options);
							return false;
						},
						Err(gone) if is_missing_under_force(&gone, options) => return false,
						// If we can't read the directory AND can't remove it,
						// show permission denied error for GNU compatibility
						Err(_) => return show_permission_denied_error(host, path),
					}
				}
				return show_removal_error(host, e, path);
			},
		};

		let error = safe_remove_dir_recursive_impl(host, path, dir_fd, options);

		// After processing all children, remove the directory itself
		if error {
			error
		} else {
			// Ask user permission if needed
			if options.interactive == InteractiveMode::Always
				&& !prompt_dir_with_mode(host, path, initial_mode as libc::mode_t, options)
			{
				return false;
			}

			// Before trying to remove the directory, check if it's actually empty
			// This handles the case where some children weren't removed due to user "no"
			// responses
			if !is_dir_empty(host, path) {
				// Directory is not empty, so we can't/shouldn't remove it
				// In interactive mode, this might be expected if user said "no" to some
				// children In non-interactive mode, this indicates an error (some children
				// couldn't be removed)
				if options.interactive == InteractiveMode::Always {
					return false;
				}
				// Try to remove the directory anyway and let the system tell us why it failed
				// Use false for error_occurred since this is the main error we want to report
				return remove_dir_with_special_cases(host, path, options, false);
			}

			// Directory is empty and user approved removal
			if let Some(result) = safe_remove_empty_dir(host, path, options, progress_bar) {
				result
			} else {
				remove_dir_with_special_cases(host, path, options, error)
			}
		}
	}

	/// A directory suspended while one of its entries is being emptied. Together
	/// with the directory being walked, only the deepest [`OPEN_DIR_FDS`] keep
	/// their descriptor; the others get it back through ".." on the way up, so
	/// depth costs memory, not file descriptors.
	#[cfg(not(target_os = "redox"))]
	struct Frame {
		dir_fd:     Option<DirFd>,
		dev:        u64,
		ino:        u64,
		entries:    std::vec::IntoIter<OsString>,
		error:      bool,
		/// The entry being emptied, removed once that is done.
		entry_name: OsString,
		entry_mode: libc::mode_t,
		/// Length of this directory's own path, to cut the entry back off with.
		path_len:   usize,
	}

	#[cfg(not(target_os = "redox"))]
	const OPEN_DIR_FDS: usize = 16;

	/// The path of the directory being walked, kept as raw bytes so that
	/// stepping into an entry and back out again is a truncation rather than a
	/// fresh allocation.
	#[cfg(not(target_os = "redox"))]
	fn path_of(buf: &[u8]) -> &Path {
		Path::new(OsStr::from_bytes(buf))
	}

	#[cfg(not(target_os = "redox"))]
	fn path_push(buf: &mut Vec<u8>, name: &OsStr) {
		if !buf.is_empty() && buf.last() != Some(&b'/') {
			buf.push(b'/');
		}
		buf.extend_from_slice(name.as_bytes());
	}

	/// Whether `name` is an empty directory in `dir_fd`, asked through the
	/// descriptor rather than the path: past `PATH_MAX` a path-based check
	/// fails, and a failure counts as non-empty. An unreadable directory still
	/// counts as non-empty.
	#[cfg(not(target_os = "redox"))]
	fn is_subdir_empty(dir_fd: &DirFd, name: &OsStr) -> bool {
		dir_fd
			.open_subdir(name, SymlinkBehavior::NoFollow)
			.and_then(|fd| fd.read_dir())
			.is_ok_and(|entries| entries.is_empty())
	}

	/// GNU's warning for a directory that is its own ancestor.
	#[cfg(not(target_os = "redox"))]
	fn show_cycle_error(host: &mut Host, path: &Path) {
		show_error!(
			host,
			"WARNING: Circular directory structure.\nThis almost certainly means that you have a \
			 corrupted file system.\nNOTIFY YOUR SYSTEM MANAGER.\nThe following directory is part of \
			 the cycle:\n  {}\n",
			path.maybe_quote()
		);
	}

	/// Reopen the parent of `child_fd` through "..", checking it is still the
	/// directory we descended from and not one swapped in mid-walk.
	#[cfg(not(target_os = "redox"))]
	fn reopen_parent(child_fd: &DirFd, dev: u64, ino: u64) -> std::io::Result<DirFd> {
		let parent_fd = child_fd.open_subdir(OsStr::new(".."), SymlinkBehavior::NoFollow)?;
		let info = parent_fd.metadata()?.file_info();
		if info.device() == dev && info.inode() == ino {
			Ok(parent_fd)
		} else {
			Err(std::io::Error::from(std::io::ErrorKind::NotFound))
		}
	}

	/// Empties the directory open as `cur_fd`, whose path is `path`, leaving the
	/// directory itself for the caller. Returns whether any error occurred.
	///
	/// Walks with an explicit stack: recursing once per level overflows the
	/// thread's stack on a tree tens of thousands of levels deep, and that kills
	/// the whole process rather than failing the command.
	#[cfg(not(target_os = "redox"))]
	pub fn safe_remove_dir_recursive_impl(
		host: &mut Host,
		path: &Path,
		mut cur_fd: DirFd,
		options: &Options,
	) -> bool {
		let (mut dev, mut ino) = match cur_fd.metadata() {
			Ok(metadata) => {
				let info = metadata.file_info();
				(info.device(), info.inode())
			},
			Err(e) => return show_removal_error(host, e, path),
		};
		// Read directory entries using safe traversal
		let mut entries = match cur_fd.read_dir() {
			Ok(entries) => entries.into_iter(),
			Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
				if !options.force {
					show_permission_denied_error(host, path);
				}
				return !options.force;
			},
			Err(e) => {
				return handle_error_with_force(host, e, path, options);
			},
		};

		let mut error = false;
		let mut path_buf = path.as_os_str().as_bytes().to_vec();
		let mut stack: Vec<Frame> = Vec::new();
		// Identities of the directories on the walk's path: a directory that is
		// its own ancestor (a bind mount inside itself) would otherwise be walked
		// until memory runs out, since descriptors let the walk pass PATH_MAX.
		let mut ancestors = HashSet::from([(dev, ino)]);

		loop {
			if host.is_cancelled() {
				return true;
			}

			let Some(entry_name) = entries.next() else {
				// This directory is done: resume its parent, which removes it.
				let Some(parent) = stack.pop() else {
					return error;
				};
				cur_fd = if let Some(fd) = parent.dir_fd {
					fd
				} else {
					match reopen_parent(&cur_fd, parent.dev, parent.ino) {
						Ok(fd) => fd,
						Err(e) => {
							// Name the parent, not the entry we came up from.
							path_buf.truncate(parent.path_len);
							return show_removal_error(host, e, path_of(&path_buf));
						},
					}
				};
				let child_error = error;
				ancestors.remove(&(dev, ino));
				(dev, ino, entries) = (parent.dev, parent.ino, parent.entries);
				error = parent.error | child_error;

				// Ask user permission if needed for this subdirectory, then remove
				// the now-empty subdirectory using safe unlinkat.
				if !child_error
					&& (options.interactive != InteractiveMode::Always
						|| prompt_dir_with_mode(host, path_of(&path_buf), parent.entry_mode, options))
				{
					error |= handle_unlink(
						host,
						&cur_fd,
						&parent.entry_name,
						path_of(&path_buf),
						true,
						options,
					);
				}
				path_buf.truncate(parent.path_len);
				continue;
			};

			let parent_len = path_buf.len();
			path_push(&mut path_buf, &entry_name);
			let descended = 'entry: {
				// Get metadata for the entry using fstatat
				let entry_stat = match cur_fd.stat_at(&entry_name, SymlinkBehavior::NoFollow) {
					Ok(stat) => stat,
					Err(e) => {
						error |= handle_error_with_force(host, e, path_of(&path_buf), options);
						break 'entry false;
					},
				};

				let is_dir = ((entry_stat.st_mode as libc::mode_t) & libc::S_IFMT) == libc::S_IFDIR;
				if !is_dir {
					// Remove file - check if user wants to remove it first
					if prompt_file_with_stat(host, path_of(&path_buf), &entry_stat, options) {
						error |=
							handle_unlink(host, &cur_fd, &entry_name, path_of(&path_buf), false, options);
					}
					break 'entry false;
				}

				// st_dev's type varies by platform (i32 on macOS, u64 on Linux).
				#[allow(clippy::unnecessary_cast)]
				let entry_id = (entry_stat.st_dev as u64, entry_stat.st_ino as u64);
				if ancestors.contains(&entry_id) {
					show_cycle_error(host, path_of(&path_buf));
					error = true;
					break 'entry false;
				}

				// Ask user if they want to descend into this directory
				if options.interactive == InteractiveMode::Always
					&& !is_subdir_empty(&cur_fd, &entry_name)
					&& !prompt_descend(host, path_of(&path_buf))
				{
					break 'entry false;
				}

				// Open the just-stat'd subdirectory without following a symlink: one
				// swapped in since the stat makes the open fail instead of taking the
				// walk off the tree.
				let child_fd = match cur_fd.open_subdir(&entry_name, SymlinkBehavior::NoFollow) {
					Ok(fd) => fd,
					Err(e) => {
						if e.kind() == std::io::ErrorKind::PermissionDenied {
							error |= handle_permission_denied(
								host,
								&cur_fd,
								&entry_name,
								path_of(&path_buf),
								options,
							);
						} else {
							error |= handle_error_with_force(host, e, path_of(&path_buf), options);
						}
						break 'entry false;
					},
				};

				let (child_entries, child_error) = match child_fd.read_dir() {
					Ok(child_entries) => (child_entries.into_iter(), false),
					Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
						if !options.force {
							show_permission_denied_error(host, path_of(&path_buf));
						}
						(Vec::new().into_iter(), !options.force)
					},
					Err(e) => (
						Vec::new().into_iter(),
						handle_error_with_force(host, e, path_of(&path_buf), options),
					),
				};

				// Suspend this directory and empty the subdirectory first.
				stack.push(Frame {
					dir_fd: Some(std::mem::replace(&mut cur_fd, child_fd)),
					dev,
					ino,
					entries: std::mem::replace(&mut entries, child_entries),
					error: std::mem::replace(&mut error, child_error),
					entry_name,
					entry_mode: entry_stat.st_mode as libc::mode_t,
					path_len: parent_len,
				});
				if let Some(closable) = stack.len().checked_sub(OPEN_DIR_FDS) {
					stack[closable].dir_fd = None;
				}
				ancestors.insert(entry_id);
				(dev, ino) = entry_id;
				true
			};
			if !descended {
				path_buf.truncate(parent_len);
			}
		}
	}

	#[cfg(target_os = "redox")]
	pub fn safe_remove_dir_recursive_impl(
		host: &mut Host,
		_path: &Path,
		_dir_fd: DirFd,
		_options: &Options,
	) -> bool {
		// safe_traversal stat_at is not supported on Redox
		// This shouldn't be called on Redox, but provide a stub for compilation
		true // Return error
	}
}
#[cfg(all(unix, not(target_os = "redox")))]
use platform::{safe_remove_dir_recursive, safe_remove_empty_dir, safe_remove_file};

#[derive(Debug, Error)]
enum RmError {
	#[error("missing operand\nTry 'rm --help' for more information.")]
	MissingOperand,
	#[error("cannot remove {}: No such file or directory", _0.quote())]
	CannotRemoveNoSuchFile(OsString),
	#[error("cannot remove {}: Permission denied", _0.quote())]
	CannotRemovePermissionDenied(OsString),
	#[error("cannot remove {}: Is a directory", _0.quote())]
	CannotRemoveIsDirectory(OsString),
	#[error("it is dangerous to operate recursively on '/'")]
	DangerousRecursiveOperation,
	#[error("use --no-preserve-root to override this failsafe")]
	UseNoPreserveRoot,
	#[error("refusing to remove '.' or '..' directory: skipping {}", _0.quote())]
	RefusingToRemoveDirectory(OsString),
	#[error("you may not abbreviate the --no-preserve-root option")]
	MayNotAbbreviateNoPreserveRoot,
}

fn verbose_removed_file(host: &mut Host, path: &Path, options: &Options) {
	if options.verbose {
		let _ = writeln!(host.stdout, "removed {}", uucore::fs::normalize_path(path).quote());
	}
}

fn verbose_removed_directory(host: &mut Host, path: &Path, options: &Options) {
	if options.verbose {
		let _ =
			writeln!(host.stdout, "removed directory {}", uucore::fs::normalize_path(path).quote());
	}
}

fn show_removal_error(host: &mut Host, error: io::Error, path: &Path) -> bool {
	if error.kind() == io::ErrorKind::PermissionDenied {
		show_error!(host, "cannot remove {}: Permission denied", path.quote());
	} else {
		show_error!(host, "cannot remove {}: {error}", path.quote());
	}
	true
}

fn show_permission_denied_error(host: &mut Host, path: &Path) -> bool {
	show_error!(host, "cannot remove {}: Permission denied", path.quote());
	true
}

fn is_missing_under_force(e: &io::Error, options: &Options) -> bool {
	options.force
		&& !matches!(options.interactive, InteractiveMode::Always | InteractiveMode::Once)
		&& matches!(e.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory)
}

/// Helper to handle errors with force mode consideration
fn handle_error_with_force(host: &mut Host, e: io::Error, path: &Path, options: &Options) -> bool {
	// Permission denied errors should be shown even in force mode
	// This matches GNU rm behavior
	if e.kind() == io::ErrorKind::PermissionDenied {
		show_permission_denied_error(host, path);
		return true;
	}

	if !options.force {
		show_error!(host, "cannot remove {}: {e}", path.quote());
	}
	!options.force
}

/// Removes the empty directory `fs_path`.
///
/// On Windows a directory carrying the read-only attribute refuses removal,
/// although on Unix only the parent's permissions decide; the attribute is
/// cleared for one more attempt and put back if that fails too.
fn remove_empty_dir(_host: &mut Host, fs_path: &Path) -> io::Result<()> {
	let result = fs::remove_dir(fs_path);
	#[cfg(windows)]
	if result
		.as_ref()
		.is_err_and(|e| e.kind() == io::ErrorKind::PermissionDenied)
	{
		// A step that finds the directory gone reports that, which `-f`
		// ignores, rather than the stale `PermissionDenied`.
		let gone = |e: io::Error| (e.kind() == io::ErrorKind::NotFound).then_some(e);
		let metadata = match fs::symlink_metadata(fs_path) {
			Ok(metadata) => metadata,
			Err(e) => return Err(gone(e).unwrap_or_else(|| result.unwrap_err())),
		};
		// Not a symlink or junction: set_permissions would follow it.
		if metadata.is_dir() && metadata.permissions().readonly() {
			let mut writable = metadata.permissions();
			writable.set_readonly(false);
			if let Err(e) = fs::set_permissions(fs_path, writable) {
				return Err(gone(e).unwrap_or_else(|| result.unwrap_err()));
			}
			let retry = fs::remove_dir(fs_path);
			if retry.is_err() {
				// Best effort: the retry's error is the one to report.
				let _ = fs::set_permissions(fs_path, metadata.permissions());
			}
			return retry;
		}
	}
	result
}

/// Helper function to remove directory handling special cases
fn remove_dir_with_special_cases(
	host: &mut Host,
	path: &Path,
	options: &Options,
	error_occurred: bool,
) -> bool {
	let path_fs = host.resolve(path);
	match remove_empty_dir(host, &path_fs) {
		Err(e) if is_missing_under_force(&e, options) => false,
		Err(_)
			if !error_occurred
				&& !fs::metadata(host.resolve(path))
					.is_ok_and(|metadata| is_readable_metadata(&metadata)) =>
		{
			// For compatibility with GNU test case
			// `tests/rm/unread2.sh`, show "Permission denied" in this
			// case instead of "Directory not empty".
			show_permission_denied_error(host, path);
			true
		},
		Err(_) if !error_occurred && fs::read_dir(&path_fs).is_err() => {
			// For compatibility with GNU test case on Linux
			// Check if directory is readable by attempting to read it
			show_permission_denied_error(host, path);
			true
		},
		Err(e) if !error_occurred => show_removal_error(host, e, path),
		Err(_) => {
			// If we already had errors while
			// trying to remove the children, then there is no need to
			// show another error message as we return from each level
			// of the recursion.
			error_occurred
		},
		Ok(()) => {
			verbose_removed_directory(host, path, options);
			false
		},
	}
}

/// Helper function to remove a directory and handle results
fn remove_dir_with_feedback(host: &mut Host, path: &Path, options: &Options) -> bool {
	let path_fs = host.resolve(path);
	match remove_empty_dir(host, &path_fs) {
		Ok(_) => {
			verbose_removed_directory(host, path, options);
			false
		},
		Err(e) if is_missing_under_force(&e, options) => false,
		Err(e) => show_removal_error(host, e, path),
	}
}

#[derive(Eq, PartialEq, Clone, Copy)]

pub enum InteractiveMode {
	Never,

	Once,

	Always,

	PromptProtected,
}

impl From<&str> for InteractiveMode {
	fn from(s: &str) -> Self {
		match s {
			"never" => Self::Never,
			"once" => Self::Once,
			"always" => Self::Always,
			_ => unreachable!("should be prevented by clap"),
		}
	}
}

pub struct Options {
	pub force: bool,

	pub interactive: InteractiveMode,
	#[allow(
		dead_code,
		reason = "--one-file-system is parsed but intentionally unimplemented upstream"
	)]
	pub one_fs:      bool,

	pub preserve_root: bool,

	pub recursive: bool,

	pub dir: bool,

	pub verbose: bool,

	pub progress:            bool,
	#[doc(hidden)]
	pub __presume_input_tty: Option<bool>,
}

impl Default for Options {
	fn default() -> Self {
		Self {
			force:               false,
			interactive:         InteractiveMode::PromptProtected,
			one_fs:              false,
			preserve_root:       true,
			recursive:           false,
			dir:                 false,
			verbose:             false,
			progress:            false,
			__presume_input_tty: None,
		}
	}
}

static OPT_DIR: &str = "dir";
static OPT_INTERACTIVE: &str = "interactive";
static OPT_FORCE: &str = "force";
static OPT_NO_PRESERVE_ROOT: &str = "no-preserve-root";
static OPT_ONE_FILE_SYSTEM: &str = "one-file-system";
static OPT_PRESERVE_ROOT: &str = "preserve-root";
static OPT_PROMPT_ALWAYS: &str = "prompt-always";
static OPT_PROMPT_ONCE: &str = "prompt-once";
static OPT_RECURSIVE: &str = "recursive";
static OPT_VERBOSE: &str = "verbose";
static OPT_PROGRESS: &str = "progress";
static PRESUME_INPUT_TTY: &str = "-presume-input-tty";

static ARG_FILES: &str = "files";

pub(crate) struct Rm {
	matches: ArgMatches,
}

matches_parser!(Rm, uu_app);

impl Utility for Rm {
	const NAME: &'static str = "rm";

	fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		const FULL: &str = "--no-preserve-root";
		for arg in argv.iter().skip(1) {
			let Some(arg) = arg.to_str() else {
				continue;
			};
			if arg == "--" {
				break;
			}
			if arg.starts_with("--") && arg.len() < FULL.len() && FULL.starts_with(arg) {
				return Err(RmError::MayNotAbbreviateNoPreserveRoot.to_string());
			}
		}
		Ok(argv)
	}

	fn run(self, host: &mut Host) -> i32 {
		run_matches(host, &self.matches)
	}
}

fn run_matches(host: &mut Host, matches: &ArgMatches) -> i32 {
	let files: Vec<_> = matches
		.get_many::<OsString>(ARG_FILES)
		.map(|v| v.map(OsString::as_os_str).collect())
		.unwrap_or_default();

	let force_flag = matches.get_flag(OPT_FORCE);
	if files.is_empty() && !force_flag {
		host.error(RmError::MissingOperand, 1);
		return 1;
	}

	let force_prompt_never = force_flag && {
		let force_index = matches.index_of(OPT_FORCE).unwrap_or(0);
		![OPT_PROMPT_ALWAYS, OPT_PROMPT_ONCE, OPT_INTERACTIVE]
			.iter()
			.any(|flag| {
				matches.value_source(flag) == Some(ValueSource::CommandLine)
					&& matches.index_of(flag).unwrap_or(0) > force_index
			})
	};

	let options = Options {
		force:               force_flag,
		interactive:         {
			if force_prompt_never {
				InteractiveMode::Never
			} else if matches.get_flag(OPT_PROMPT_ALWAYS) {
				InteractiveMode::Always
			} else if matches.get_flag(OPT_PROMPT_ONCE) {
				InteractiveMode::Once
			} else if matches.contains_id(OPT_INTERACTIVE) {
				InteractiveMode::from(matches.get_one::<String>(OPT_INTERACTIVE).unwrap().as_str())
			} else {
				InteractiveMode::PromptProtected
			}
		},
		one_fs:              matches.get_flag(OPT_ONE_FILE_SYSTEM),
		preserve_root:       !matches.get_flag(OPT_NO_PRESERVE_ROOT),
		recursive:           matches.get_flag(OPT_RECURSIVE),
		dir:                 matches.get_flag(OPT_DIR),
		verbose:             matches.get_flag(OPT_VERBOSE),
		progress:            matches.get_flag(OPT_PROGRESS),
		__presume_input_tty: Some(
			matches.get_flag(PRESUME_INPUT_TTY) || host.stdin.file().is_terminal(),
		),
	};

	if options.interactive == InteractiveMode::Once && (options.recursive || files.len() > 3) {
		let msg = format!(
			"remove {} {}{}",
			files.len(),
			if files.len() > 1 {
				"arguments"
			} else {
				"argument"
			},
			if options.recursive {
				" recursively?"
			} else {
				"?"
			}
		);
		if !prompt_yes!(host, "{msg}") {
			return 0;
		}
	}

	if remove(host, &files, &options) {
		host.fail(1);
	}
	host.exit_code()
}

pub fn uu_app() -> Command {
	Command::new("rm")
		.version("0.8.0")
		.about("Remove (unlink) the FILE(s)")
		.override_usage(format_usage("rm [OPTION]... FILE..."))
		.after_help(
			"By default, rm does not remove directories. Use the --recursive (-r or -R)\noption to \
			 remove each listed directory, too, along with all of its contents\n\nTo remove a file \
			 whose name starts with a '-', for example '-foo',\nuse one of these commands:\nrm -- \
			 -foo\n\nrm ./-foo\n\nNote that if you use rm to remove a file, it might be possible to \
			 recover\nsome of its contents, given sufficient expertise and/or time. For \
			 greater\nassurance that the contents are truly unrecoverable, consider using shred.",
		)
		.infer_long_args(true)
		.args_override_self(true)
		.arg(
			Arg::new(OPT_FORCE)
				.short('f')
				.long(OPT_FORCE)
				.help("ignore nonexistent files and arguments, never prompt")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_PROMPT_ALWAYS)
				.short('i')
				.help("prompt before every removal")
				.overrides_with_all([OPT_PROMPT_ONCE, OPT_INTERACTIVE])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_PROMPT_ONCE)
				.short('I')
				.help(
					"prompt once before removing more than three files, or when removing \
					 recursively.\nLess intrusive than -i, while still giving some protection against \
					 most mistakes",
				)
				.overrides_with_all([OPT_PROMPT_ALWAYS, OPT_INTERACTIVE])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_INTERACTIVE)
				.long(OPT_INTERACTIVE)
				.help(
					"prompt according to WHEN: never, once (-I), or always (-i). Without \
					 WHEN,\nprompts always",
				)
				.value_name("WHEN")
				.value_parser(ShortcutValueParser::new([
					PossibleValue::new("always").alias("yes"),
					PossibleValue::new("once"),
					PossibleValue::new("never").alias("no").alias("none"),
				]))
				.num_args(0..=1)
				.require_equals(true)
				.default_missing_value("always")
				.overrides_with_all([OPT_PROMPT_ALWAYS, OPT_PROMPT_ONCE]),
		)
		.arg(
			Arg::new(OPT_ONE_FILE_SYSTEM)
				.long(OPT_ONE_FILE_SYSTEM)
				.help(
					"when removing a hierarchy recursively, skip any directory that is on a \
					 file\nsystem different from that of the corresponding command line argument \
					 (NOT\nIMPLEMENTED)",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_NO_PRESERVE_ROOT)
				.long(OPT_NO_PRESERVE_ROOT)
				.help("do not treat '/' specially")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_PRESERVE_ROOT)
				.long(OPT_PRESERVE_ROOT)
				.help("do not remove '/' (default)")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_RECURSIVE)
				.short('r')
				.visible_short_alias('R')
				.long(OPT_RECURSIVE)
				.help("remove directories and their contents recursively")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_DIR)
				.short('d')
				.long(OPT_DIR)
				.help("remove empty directories")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_VERBOSE)
				.short('v')
				.long(OPT_VERBOSE)
				.help("explain what is being done")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_PROGRESS)
				.short('g')
				.long(OPT_PROGRESS)
				.help("display a progress bar. Note: this feature is not supported by GNU coreutils.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(PRESUME_INPUT_TTY)
				.long("presume-input-tty")
				.alias(PRESUME_INPUT_TTY)
				.hide(true)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(ARG_FILES)
				.action(ArgAction::Append)
				.value_parser(ValueParser::os_string())
				.num_args(1..)
				.value_hint(clap::ValueHint::AnyPath),
		)
}

pub(crate) fn rm_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Rm, SE>()
}

struct HostTerm(Mutex<OpenFile>);

impl fmt::Debug for HostTerm {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str("HostTerm")
	}
}

impl TermLike for HostTerm {
	fn width(&self) -> u16 {
		80
	}

	fn move_cursor_up(&self, n: usize) -> io::Result<()> {
		write!(self.0.lock(), "\x1b[{n}A")
	}

	fn move_cursor_down(&self, n: usize) -> io::Result<()> {
		write!(self.0.lock(), "\x1b[{n}B")
	}

	fn move_cursor_right(&self, n: usize) -> io::Result<()> {
		write!(self.0.lock(), "\x1b[{n}C")
	}

	fn move_cursor_left(&self, n: usize) -> io::Result<()> {
		write!(self.0.lock(), "\x1b[{n}D")
	}

	fn write_line(&self, s: &str) -> io::Result<()> {
		writeln!(self.0.lock(), "{s}")
	}

	fn write_str(&self, s: &str) -> io::Result<()> {
		write!(self.0.lock(), "{s}")
	}

	fn clear_line(&self) -> io::Result<()> {
		write!(self.0.lock(), "\r\x1b[2K")
	}

	fn flush(&self) -> io::Result<()> {
		self.0.lock().flush()
	}
}

fn create_progress_bar(host: &mut Host, files: &[&OsStr], recursive: bool) -> Option<ProgressBar> {
	if !host.stderr.is_terminal() {
		return None;
	}
	let total_files = count_files(host, files, recursive);
	if total_files == 0 {
		return None;
	}

	let progress = ProgressBar::with_draw_target(
		Some(total_files),
		ProgressDrawTarget::term_like(Box::new(HostTerm(Mutex::new(host.stderr_clone())))),
	)
	.with_style(
		ProgressStyle::with_template("{msg}: [{elapsed_precise}] {wide_bar} {pos:>7}/{len:7} files")
			.unwrap(),
	)
	.with_message("Removing");
	Some(progress)
}

fn count_files(host: &mut Host, paths: &[&OsStr], recursive: bool) -> u64 {
	let mut total = 0;
	for p in paths {
		if host.is_cancelled() {
			break;
		}

		if p.is_empty() {
			continue;
		}
		let path = Path::new(p);
		if let Ok(md) = fs::symlink_metadata(host.resolve(path)) {
			if md.is_dir() && !is_symlink_dir(&md) {
				if recursive {
					total += count_files_in_directory(host, path);
				}
			} else {
				total += 1;
			}
		}
	}
	total
}

fn count_files_in_directory(host: &mut Host, p: &Path) -> u64 {
	if host.is_cancelled() {
		return 0;
	}
	let mut entries_count = 0;
	let Ok(entries) = fs::read_dir(host.resolve(p)) else {
		return 1;
	};
	for entry in entries.flatten() {
		if host.is_cancelled() {
			break;
		}
		entries_count += match entry.file_type() {
			Ok(ft) if ft.is_dir() => count_files_in_directory(host, &entry.path()),
			Ok(_) => 1,
			Err(_) => 0,
		};
	}
	1 + entries_count
}

pub fn remove(host: &mut Host, files: &[&OsStr], options: &Options) -> bool {
	let mut had_err = false;

	let mut progress_bar: Option<ProgressBar> = None;
	let mut any_files_processed = false;

	for filename in files {
		if host.is_cancelled() {
			break;
		}

		let file = Path::new(filename);

		if filename.is_empty() {
			if !options.force {
				show_error!(host, "{}", RmError::CannotRemoveNoSuchFile(filename.to_os_string()));
				had_err = true;
			}
			continue;
		}

		if uucore::fs::path_ends_with_terminator(file)
			&& options.recursive
			&& options.preserve_root
			&& is_root_path(host, file)
		{
			show_preserve_root_error(host, file);
			had_err = true;
			continue;
		}

		had_err = match host.resolve(file).symlink_metadata() {
			Ok(metadata) => {
				if options.progress && progress_bar.is_none() {
					progress_bar = create_progress_bar(host, files, options.recursive);
				}

				any_files_processed = true;
				if metadata.is_dir() {
					handle_dir(host, file, options, progress_bar.as_ref())
				} else if is_symlink_dir(&metadata) {
					remove_dir(host, file, options, progress_bar.as_ref())
				} else {
					remove_file(host, file, options, progress_bar.as_ref())
				}
			},

			Err(_e) => {
				if options.force {
					false
				} else {
					show_error!(host, "{}", RmError::CannotRemoveNoSuchFile(filename.to_os_string()));
					true
				}
			},
		}
		.bitor(had_err);
	}

	if let Some(pb) = progress_bar
		&& any_files_processed
	{
		pb.finish();
	}

	had_err
}

fn is_dir_empty(host: &mut Host, path: &Path) -> bool {
	fs::read_dir(host.resolve(path)).is_ok_and(|mut iter| iter.next().is_none())
}

#[cfg(unix)]
fn is_readable_metadata(metadata: &Metadata) -> bool {
	let mode = metadata.permissions().mode();
	(mode & 0o400) > 0
}

#[cfg(any(not(unix), target_os = "redox"))]
fn is_readable(_host: &mut Host, _path: &Path) -> bool {
	true
}

#[cfg(unix)]
fn is_writable_metadata(metadata: &Metadata) -> bool {
	let mode = metadata.permissions().mode();
	(mode & 0o200) > 0
}

#[cfg(not(unix))]
fn is_writable_metadata(_metadata: &Metadata) -> bool {
	true
}

fn remove_dir_recursive(
	host: &mut Host,
	path: &Path,
	options: &Options,
	progress_bar: Option<&ProgressBar>,
) -> bool {
	if host.is_cancelled() {
		return true;
	}

	let fs_path = host.resolve(path);
	if !fs_path.is_dir() || fs_path.is_symlink() {
		return remove_file(host, path, options, progress_bar);
	}

	remove_dir_tree(host, path, options, progress_bar)
}

/// Removes the directory `path`, known not to be a symlink to one, and
/// everything in it.
fn remove_dir_tree(
	host: &mut Host,
	path: &Path,
	options: &Options,
	progress_bar: Option<&ProgressBar>,
) -> bool {
	if options.interactive == InteractiveMode::Always
		&& !is_dir_empty(host, path)
		&& !prompt_descend(host, path)
	{
		return false;
	}

	#[cfg(all(unix, not(target_os = "redox")))]
	{
		safe_remove_dir_recursive(host, path, options, progress_bar)
	}

	#[cfg(any(not(unix), target_os = "redox"))]
	{
		if let Some(s) = path.to_str() {
			if s.len() > 1000 {
				match fs::remove_dir_all(host.resolve(path)) {
					Ok(_) => return false,
					Err(e) => {
						show_error!(host, "cannot remove {}: {e}", path.quote());
						return true;
					},
				}
			}
		}

		let mut error = false;
		match fs::read_dir(host.resolve(path)) {
			Err(e) if e.kind() == io::ErrorKind::PermissionDenied => {},
			Err(_) => error = true,
			Ok(iter) => {
				for entry in iter {
					if host.is_cancelled() {
						error = true;
						break;
					}
					match entry {
						Err(_) => error = true,
						Ok(entry) => {
							let child_error =
								remove_dir_recursive(host, &entry.path(), options, progress_bar);
							error = error || child_error;
						},
					}
				}
			},
		}

		if options.interactive == InteractiveMode::Always && !prompt_dir(host, path, options) {
			return false;
		}

		match fs::remove_dir(host.resolve(path)) {
			Err(_)
				if !error
					&& !fs::metadata(host.resolve(path))
						.is_ok_and(|metadata| is_readable_metadata(&metadata)) =>
			{
				show_permission_denied_error(host, path);
				error = true;
			},
			Err(e) if !error => {
				show_error!(host, "cannot remove {}: {e}", path.quote());
				error = true;
			},
			Err(_) => {},
			Ok(_) => verbose_removed_directory(host, path, options),
		}

		error
	}
}

fn is_root_path(host: &mut Host, path: &Path) -> bool {
	if path.has_root() && path.parent().is_none() {
		return true;
	}

	if let Ok(canonical) = host.resolve(path).canonicalize() {
		canonical.has_root() && canonical.parent().is_none()
	} else {
		false
	}
}

fn show_preserve_root_error(host: &mut Host, path: &Path) {
	let path_looks_like_root = path.has_root() && path.parent().is_none();

	if path_looks_like_root {
		show_error!(host, "{}", RmError::DangerousRecursiveOperation);
	} else {
		show_error!(
			host,
			"it is dangerous to operate recursively on '{}' (same as '/')",
			path.display()
		);
	}
	show_error!(host, "{}", RmError::UseNoPreserveRoot);
}

fn handle_dir(
	host: &mut Host,
	path: &Path,
	options: &Options,
	progress_bar: Option<&ProgressBar>,
) -> bool {
	let mut had_err = false;

	let path = clean_trailing_slashes(path);
	if path_is_current_or_parent_directory(path) {
		show_error!(host, "{}", RmError::RefusingToRemoveDirectory(path.as_os_str().to_os_string()));
		return true;
	}

	let is_root = is_root_path(host, path);
	if options.recursive && (!is_root || !options.preserve_root) {
		had_err = remove_dir_recursive(host, path, options, progress_bar);
	} else if options.dir && (!is_root || !options.preserve_root) {
		had_err = remove_dir(host, path, options, progress_bar).bitor(had_err);
	} else if options.recursive {
		show_preserve_root_error(host, path);
		had_err = true;
	} else {
		show_error!(host, "{}", RmError::CannotRemoveIsDirectory(path.as_os_str().to_os_string()));
		had_err = true;
	}

	had_err
}

fn remove_dir(
	host: &mut Host,
	path: &Path,
	options: &Options,
	progress_bar: Option<&ProgressBar>,
) -> bool {
	if !prompt_dir(host, path, options) {
		return false;
	}

	if !options.dir && !options.recursive {
		show_error!(host, "{}", RmError::CannotRemoveIsDirectory(path.as_os_str().to_os_string()));
		return true;
	}

	#[cfg(all(unix, not(target_os = "redox")))]
	{
		if let Some(result) = safe_remove_empty_dir(host, path, options, progress_bar) {
			return result;
		}
	}

	if let Some(pb) = progress_bar {
		pb.inc(1);
	}

	remove_dir_with_feedback(host, path, options)
}

fn remove_file(
	host: &mut Host,
	path: &Path,
	options: &Options,
	progress_bar: Option<&ProgressBar>,
) -> bool {
	if prompt_file(host, path, options) {
		if let Some(pb) = progress_bar {
			pb.inc(1);
		}

		#[cfg(all(unix, not(target_os = "redox")))]
		{
			if let Some(result) = safe_remove_file(host, path, options, progress_bar) {
				return result;
			}
		}

		match fs::remove_file(host.resolve(path)) {
			Ok(_) => {
				host.note_write(path);
				verbose_removed_file(host, path, options);
			},
			Err(e) if is_missing_under_force(&e, options) => {},
			Err(e) => {
				if e.kind() == io::ErrorKind::PermissionDenied {
					show_error!(
						host,
						"{}",
						RmError::CannotRemovePermissionDenied(path.as_os_str().to_os_string())
					);
				} else {
					return show_removal_error(host, e, path);
				}
				return true;
			},
		}
	}

	false
}

fn prompt_dir(host: &mut Host, path: &Path, options: &Options) -> bool {
	if options.interactive == InteractiveMode::Never {
		return true;
	}

	if let Ok(metadata) = fs::metadata(host.resolve(path)) {
		handle_writable_directory(host, path, options, &metadata)
	} else {
		true
	}
}

fn prompt_file(host: &mut Host, path: &Path, options: &Options) -> bool {
	let stdin_ok = options.__presume_input_tty.unwrap_or(false);
	if options.interactive == InteractiveMode::Never
		|| (options.interactive == InteractiveMode::PromptProtected && !stdin_ok)
	{
		return true;
	}

	let Ok(metadata) = fs::symlink_metadata(host.resolve(path)) else {
		return true;
	};

	if metadata.is_symlink() {
		return options.interactive != InteractiveMode::Always
			|| prompt_yes!(host, "remove symbolic link {}?", path.quote());
	}

	if options.interactive == InteractiveMode::Always && is_writable_metadata(&metadata) {
		return if metadata.len() == 0 {
			prompt_yes!(host, "remove regular empty file {}?", path.quote())
		} else {
			prompt_yes!(host, "remove file {}?", path.quote())
		};
	}

	prompt_file_permission_readonly(host, path, options, &metadata)
}

fn prompt_file_permission_readonly(
	host: &mut Host,
	path: &Path,
	options: &Options,
	metadata: &Metadata,
) -> bool {
	let stdin_ok = options.__presume_input_tty.unwrap_or(false);
	match (stdin_ok, options.interactive) {
		(false, InteractiveMode::PromptProtected) => true,
		_ if is_writable_metadata(metadata) => true,
		_ if metadata.len() == 0 => {
			prompt_yes!(host, "remove write-protected regular empty file {}?", path.quote())
		},
		_ => prompt_yes!(host, "remove write-protected regular file {}?", path.quote()),
	}
}

fn path_is_current_or_parent_directory(path: &Path) -> bool {
	let path_str = os_bytes(path.as_os_str());
	let dir_separator = MAIN_SEPARATOR as u8;
	if let Some(path_bytes) = path_str {
		return path_bytes == *b"."
			|| path_bytes == ([b'.', dir_separator])
			|| path_bytes == *b".."
			|| path_bytes == ([b'.', b'.', dir_separator])
			|| path_bytes.ends_with(&[dir_separator, b'.'])
			|| path_bytes.ends_with(&[dir_separator, b'.', b'.'])
			|| path_bytes.ends_with(&[dir_separator, b'.', dir_separator])
			|| path_bytes.ends_with(&[dir_separator, b'.', b'.', dir_separator]);
	}
	false
}

#[cfg(unix)]
fn handle_writable_directory(
	host: &mut Host,
	path: &Path,
	options: &Options,
	metadata: &Metadata,
) -> bool {
	let stdin_ok = options.__presume_input_tty.unwrap_or(false);
	match (
		stdin_ok,
		is_readable_metadata(metadata),
		is_writable_metadata(metadata),
		options.interactive,
	) {
		(false, _, _, InteractiveMode::PromptProtected) => true,
		(false, false, false, InteractiveMode::Never) => true,

		(_, false, false, _) => {
			prompt_yes!(host, "attempt removal of inaccessible directory {}?", path.quote())
		},
		(_, false, true, InteractiveMode::Always) => {
			prompt_yes!(host, "attempt removal of inaccessible directory {}?", path.quote())
		},
		(_, true, false, _) => {
			prompt_yes!(host, "remove write-protected directory {}?", path.quote())
		},
		(_, _, _, InteractiveMode::Always) => prompt_yes!(host, "remove directory {}?", path.quote()),
		(..) => true,
	}
}

fn clean_trailing_slashes(path: &Path) -> &Path {
	let path_str = os_bytes(path.as_os_str());
	let dir_separator = MAIN_SEPARATOR as u8;

	if let Some(path_bytes) = path_str {
		let mut idx = if path_bytes.len() > 1 {
			path_bytes.len() - 1
		} else {
			return path;
		};

		if path_bytes[idx] == dir_separator {
			for i in (1..path_bytes.len()).rev() {
				if path_bytes[i - 1] != dir_separator {
					idx = i;
					break;
				}
			}
			#[cfg(unix)]
			return Path::new(OsStr::from_bytes(&path_bytes[0..=idx]));

			#[cfg(not(unix))]
			return Path::new(std::str::from_utf8(&path_bytes[0..=idx]).unwrap());
		}
	}
	path
}

fn prompt_descend(host: &mut Host, path: &Path) -> bool {
	prompt_yes!(host, "descend into directory {}?", path.quote())
}

fn is_symlink_dir(_metadata: &Metadata) -> bool {
	false
}

#[cfg(all(test, unix))]
mod deep_walk_tests {
	use std::ffi::OsStr;

	use uucore::safe_traversal::{DirFd, SymlinkBehavior};

	use super::Rm;

	#[test]
	fn removes_paths_beyond_path_max_on_a_small_thread_stack() {
		let cwd = tempfile::tempdir().unwrap();
		let root = cwd.path().join("deep");
		std::fs::create_dir(&root).unwrap();
		let mut dir = DirFd::open(&root, SymlinkBehavior::NoFollow).unwrap();
		for _ in 0..5000 {
			dir.open_file_at(OsStr::new("f")).unwrap();
			dir.mkdir_at(OsStr::new("d"), 0o755).unwrap();
			dir = dir
				.open_subdir(OsStr::new("d"), SymlinkBehavior::NoFollow)
				.unwrap();
		}
		drop(dir);
		let path = cwd.path().to_path_buf();
		let (code, err) = std::thread::Builder::new()
			.stack_size(512 * 1024)
			.spawn(move || {
				let (code, capture) = crate::host::run_util::<Rm>(&["-rf", "deep"], "", path);
				(code, capture.err())
			})
			.unwrap()
			.join()
			.unwrap();
		assert_eq!((code, err), (0, "".into()));
		assert!(!root.exists(), "rm left the deep chain behind");
	}
}
