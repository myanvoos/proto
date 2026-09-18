use std::path::{Path, PathBuf};

use async_trait::async_trait;

use crate::{BackendKind, IsoError, IsoResult, IsolationBackend, ProbeResult, command_failed};

pub struct RcopyBackend;

#[async_trait]
impl IsolationBackend for RcopyBackend {
	fn kind(&self) -> BackendKind {
		BackendKind::Rcopy
	}

	fn probe(&self) -> ProbeResult {
		ProbeResult::available()
	}

	fn start(&self, lower: &Path, merged: &Path) -> IsoResult<()> {
		let lower = canonical_existing_dir(lower)?;
		let merged = absolutize(merged);
		prepare_destination(&merged)?;
		if is_git_worktree(&lower) {
			git_worktree_add(&lower, &merged)?;

			seed_dirty_state(&lower, &merged)
		} else {
			recursive_copy(&lower, &merged)
		}
	}

	fn stop(&self, merged: &Path) -> IsoResult<()> {
		if is_git_worktree(merged) {
			let _ = git_worktree_remove(merged);
		}
		match std::fs::remove_dir_all(merged) {
			Ok(()) => Ok(()),
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
			Err(err) => Err(IsoError::other(format!("unable to remove {}: {err}", merged.display()))),
		}
	}
}

fn canonical_existing_dir(path: &Path) -> IsoResult<PathBuf> {
	let resolved = if path.is_absolute() {
		path.to_path_buf()
	} else {
		std::env::current_dir().map_or_else(|_| path.to_path_buf(), |cwd| cwd.join(path))
	};
	let meta = std::fs::metadata(&resolved).map_err(|err| {
		IsoError::other(format!("invalid rcopy source {}: {err}", resolved.display()))
	})?;
	if !meta.is_dir() {
		return Err(IsoError::other(format!(
			"rcopy source {} is not a directory",
			resolved.display()
		)));
	}
	Ok(std::fs::canonicalize(&resolved).unwrap_or(resolved))
}

fn absolutize(path: &Path) -> PathBuf {
	if path.is_absolute() {
		path.to_path_buf()
	} else {
		std::env::current_dir().map_or_else(|_| path.to_path_buf(), |cwd| cwd.join(path))
	}
}

fn prepare_destination(merged: &Path) -> IsoResult<()> {
	if let Some(parent) = merged.parent() {
		std::fs::create_dir_all(parent)
			.map_err(|err| IsoError::other(format!("create parent of {}: {err}", merged.display())))?;
	}
	match std::fs::remove_dir_all(merged) {
		Ok(()) => {},
		Err(err) if err.kind() == std::io::ErrorKind::NotFound => {},
		Err(err) => {
			return Err(IsoError::other(format!(
				"unable to clear {} before rcopy: {err}",
				merged.display()
			)));
		},
	}
	Ok(())
}

fn is_git_worktree(path: &Path) -> bool {
	std::fs::symlink_metadata(path.join(".git")).is_ok()
}

fn git_worktree_add(lower: &Path, merged: &Path) -> IsoResult<()> {
	let output = std::process::Command::new("git")
		.arg("-C")
		.arg(lower)
		.args(["worktree", "add", "--detach"])
		.arg(merged)
		.arg("HEAD")
		.stdin(std::process::Stdio::null())
		.stdout(std::process::Stdio::piped())
		.stderr(std::process::Stdio::piped())
		.output()
		.map_err(|err| {
			if err.kind() == std::io::ErrorKind::NotFound {
				IsoError::unavailable(
					"`git` not on PATH; rcopy cannot materialise a worktree from a git source",
				)
			} else {
				IsoError::other(format!("spawn git worktree add: {err}"))
			}
		})?;
	if output.status.success() {
		return Ok(());
	}
	Err(command_failed("git worktree add", output.status.code().unwrap_or(-1), &output.stderr))
}

fn git_worktree_remove(merged: &Path) -> IsoResult<()> {
	let output = std::process::Command::new("git")
		.arg("-C")
		.arg(merged)
		.args(["worktree", "remove", "--force"])
		.arg(merged)
		.stdin(std::process::Stdio::null())
		.stdout(std::process::Stdio::piped())
		.stderr(std::process::Stdio::piped())
		.output()
		.map_err(|err| IsoError::other(format!("spawn git worktree remove: {err}")))?;
	if output.status.success() {
		return Ok(());
	}
	Err(command_failed("git worktree remove", output.status.code().unwrap_or(-1), &output.stderr))
}

fn seed_dirty_state(lower: &Path, merged: &Path) -> IsoResult<()> {
	let staged = git_capture(lower, &["diff", "--binary", "--no-color", "--cached"])?;
	if !staged.is_empty() {
		git_apply(merged, &staged, &["--cached"])?;
		git_apply(merged, &staged, &[])?;
	}

	let unstaged = git_capture(lower, &["diff", "--binary", "--no-color"])?;
	if !unstaged.is_empty() {
		git_apply(merged, &unstaged, &[])?;
	}

	let untracked = git_capture(lower, &["ls-files", "--others", "--exclude-standard", "-z"])?;
	for path_bytes in untracked.split(|b| *b == 0) {
		if path_bytes.is_empty() {
			continue;
		}
		let rel = std::str::from_utf8(path_bytes)
			.map_err(|err| IsoError::other(format!("untracked path is not valid UTF-8: {err}")))?;
		let src = lower.join(rel);
		let dst = merged.join(rel);
		if let Some(parent) = dst.parent() {
			std::fs::create_dir_all(parent)
				.map_err(|err| IsoError::other(format!("create {}: {err}", parent.display())))?;
		}
		copy_path(&src, &dst)?;
	}

	Ok(())
}

fn git_capture(cwd: &Path, args: &[&str]) -> IsoResult<Vec<u8>> {
	let output = std::process::Command::new("git")
		.arg("-C")
		.arg(cwd)
		.args(args)
		.stdin(std::process::Stdio::null())
		.stdout(std::process::Stdio::piped())
		.stderr(std::process::Stdio::piped())
		.output()
		.map_err(|err| {
			if err.kind() == std::io::ErrorKind::NotFound {
				IsoError::unavailable(
					"`git` not on PATH; rcopy cannot seed dirty state from a git source",
				)
			} else {
				IsoError::other(format!("spawn git {}: {err}", args.first().unwrap_or(&"<args>")))
			}
		})?;
	if !output.status.success() {
		return Err(command_failed(
			format_args!("git {}", args.join(" ")),
			output.status.code().unwrap_or(-1),
			&output.stderr,
		));
	}
	Ok(output.stdout)
}

fn git_apply(cwd: &Path, patch: &[u8], extra: &[&str]) -> IsoResult<()> {
	git_apply_with_program(Path::new("git"), cwd, patch, extra)
}

fn git_apply_with_program(
	program: &Path,
	cwd: &Path,
	patch: &[u8],
	extra: &[&str],
) -> IsoResult<()> {
	use std::io::{Read as _, Write as _};
	let mut child = std::process::Command::new(program)
		.arg("-C")
		.arg(cwd)
		.args(["apply", "--binary", "--whitespace=nowarn"])
		.args(extra)
		.stdin(std::process::Stdio::piped())
		.stdout(std::process::Stdio::null())
		.stderr(std::process::Stdio::piped())
		.spawn()
		.map_err(|err| {
			if err.kind() == std::io::ErrorKind::NotFound {
				IsoError::unavailable(
					"`git` not on PATH; rcopy cannot seed dirty state from a git source",
				)
			} else {
				IsoError::other(format!("spawn git apply: {err}"))
			}
		})?;
	let mut stderr = child
		.stderr
		.take()
		.ok_or_else(|| IsoError::other("git apply: child stderr was not piped".to_string()))?;
	let stderr_reader = std::thread::Builder::new()
		.name("pi-iso-git-apply-stderr".to_string())
		.spawn(move || {
			let mut bytes = Vec::new();
			stderr.read_to_end(&mut bytes).map(|_| bytes)
		})
		.map_err(|err| IsoError::other(format!("spawn git apply stderr reader: {err}")))?;
	let write_result = {
		let mut stdin = child
			.stdin
			.take()
			.ok_or_else(|| IsoError::other("git apply: child stdin was not piped".to_string()))?;
		let result = stdin.write_all(patch);
		drop(stdin);
		result
	};
	let status = child
		.wait()
		.map_err(|err| IsoError::other(format!("wait git apply: {err}")))?;
	let stderr = stderr_reader
		.join()
		.map_err(|_| IsoError::other("wait git apply: stderr reader panicked".to_string()))?
		.map_err(|err| IsoError::other(format!("read git apply stderr: {err}")))?;
	if status.success() {
		write_result.map_err(|err| IsoError::other(format!("write patch to git apply: {err}")))?;
		return Ok(());
	}
	Err(command_failed("git apply", status.code().unwrap_or(-1), &stderr))
}

fn copy_path(src: &Path, dst: &Path) -> IsoResult<()> {
	let meta = std::fs::symlink_metadata(src)
		.map_err(|err| IsoError::other(format!("stat {}: {err}", src.display())))?;
	copy_entry(src, dst, meta.file_type())
}

fn recursive_copy(lower: &Path, merged: &Path) -> IsoResult<()> {
	std::fs::create_dir_all(merged)
		.map_err(|err| IsoError::other(format!("create {}: {err}", merged.display())))?;
	copy_dir_contents(lower, merged)
}

fn copy_dir_contents(src: &Path, dst: &Path) -> IsoResult<()> {
	let entries = std::fs::read_dir(src)
		.map_err(|err| IsoError::other(format!("read_dir {}: {err}", src.display())))?;
	for entry in entries {
		let entry =
			entry.map_err(|err| IsoError::other(format!("dir entry in {}: {err}", src.display())))?;
		let file_type = entry
			.file_type()
			.map_err(|err| IsoError::other(format!("file_type {}: {err}", entry.path().display())))?;
		let src_path = entry.path();
		let dst_path = dst.join(entry.file_name());
		copy_entry(&src_path, &dst_path, file_type)?;
	}
	Ok(())
}

fn copy_entry(src: &Path, dst: &Path, file_type: std::fs::FileType) -> IsoResult<()> {
	if file_type.is_symlink() {
		return copy_symlink(src, dst);
	}
	if file_type.is_dir() {
		std::fs::create_dir_all(dst)
			.map_err(|err| IsoError::other(format!("create {}: {err}", dst.display())))?;
		copy_dir_contents(src, dst)?;
		copy_dir_mtime(src, dst);
		return Ok(());
	}
	if file_type.is_file() {
		std::fs::copy(src, dst).map_err(|err| {
			IsoError::other(format!("copy {} -> {}: {err}", src.display(), dst.display()))
		})?;
		copy_file_mtime(src, dst);
		return Ok(());
	}
	skip_special_file(src, file_type)
}

#[cfg(unix)]
fn skip_special_file(path: &Path, file_type: std::fs::FileType) -> IsoResult<()> {
	use std::os::unix::fs::FileTypeExt as _;
	if file_type.is_fifo() {
		return Ok(());
	}
	if file_type.is_socket() {
		return Ok(());
	}
	if file_type.is_block_device() {
		return Ok(());
	}
	if file_type.is_char_device() {
		return Ok(());
	}
	Err(IsoError::other(format!("unsupported special file type: {}", path.display())))
}

#[cfg(not(unix))]
fn skip_special_file(path: &Path, _file_type: std::fs::FileType) -> IsoResult<()> {
	Err(IsoError::other(format!("unsupported special file type: {}", path.display())))
}

#[cfg(unix)]
fn copy_symlink(src: &Path, dst: &Path) -> IsoResult<()> {
	let target = std::fs::read_link(src)
		.map_err(|err| IsoError::other(format!("read_link {}: {err}", src.display())))?;
	std::os::unix::fs::symlink(target, dst)
		.map_err(|err| IsoError::other(format!("symlink {}: {err}", dst.display())))
}

#[cfg(not(unix))]
fn copy_symlink(_src: &Path, _dst: &Path) -> IsoResult<()> {
	Err(IsoError::other("symlink copy unsupported on this platform"))
}

fn copy_file_mtime(src: &Path, dst: &Path) {
	let Ok(meta) = std::fs::metadata(src) else {
		return;
	};
	let Ok(mtime) = meta.modified() else { return };
	let _ = filetime_set(dst, mtime);
}

fn copy_dir_mtime(src: &Path, dst: &Path) {
	let Ok(meta) = std::fs::metadata(src) else {
		return;
	};
	let Ok(mtime) = meta.modified() else { return };
	let _ = filetime_set(dst, mtime);
}

#[cfg(unix)]
fn filetime_set(path: &Path, mtime: std::time::SystemTime) -> std::io::Result<()> {
	use std::os::unix::ffi::OsStrExt;
	let dur = mtime
		.duration_since(std::time::UNIX_EPOCH)
		.map_err(std::io::Error::other)?;
	let times = [libc::timespec { tv_sec: dur.as_secs() as _, tv_nsec: 0 }, libc::timespec {
		tv_sec:  dur.as_secs() as _,
		tv_nsec: dur.subsec_nanos() as libc::c_long,
	}];
	let c_path = std::ffi::CString::new(path.as_os_str().as_bytes())?;

	let rc = unsafe { libc::utimensat(libc::AT_FDCWD, c_path.as_ptr(), times.as_ptr(), 0) };
	if rc == 0 {
		Ok(())
	} else {
		Err(std::io::Error::last_os_error())
	}
}

#[cfg(not(unix))]
fn filetime_set(_path: &Path, _mtime: std::time::SystemTime) -> std::io::Result<()> {
	Ok(())
}

#[cfg(all(test, unix))]
mod tests {
	use std::{
		ffi::CString,
		fs,
		os::unix::ffi::OsStrExt as _,
		path::{Path, PathBuf},
		process::{Command, Stdio},
		sync::atomic::{AtomicU64, Ordering},
		time::{Duration, Instant},
	};

	use super::{copy_path, recursive_copy};

	const FIFO_CHILD_ENV: &str = "PI_ISO_FIFO_COPY_CHILD";
	const FIFO_LOWER_ENV: &str = "PI_ISO_FIFO_COPY_LOWER";
	const FIFO_MERGED_ENV: &str = "PI_ISO_FIFO_COPY_MERGED";
	static NEXT_TEMP_DIR: AtomicU64 = AtomicU64::new(0);

	struct TempDir(PathBuf);

	impl TempDir {
		fn new() -> Self {
			let sequence = NEXT_TEMP_DIR.fetch_add(1, Ordering::Relaxed);
			let path = std::env::temp_dir()
				.join(format!("pi-iso-rcopy-fifo-{}-{sequence}", std::process::id()));
			fs::create_dir(&path).expect("create test directory");
			Self(path)
		}

		fn path(&self) -> &Path {
			&self.0
		}
	}

	impl Drop for TempDir {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	fn make_fifo(path: &Path) {
		let path = CString::new(path.as_os_str().as_bytes()).unwrap();
		let rc = unsafe { libc::mkfifo(path.as_ptr(), 0o600) };
		assert_eq!(rc, 0, "mkfifo failed: {}", std::io::Error::last_os_error());
	}

	#[test]
	fn fifo_is_skipped_without_blocking_copy() {
		let temp = TempDir::new();
		let lower = temp.path().join("lower");
		let merged = temp.path().join("merged");
		fs::create_dir(&lower).unwrap();
		fs::write(lower.join("regular.txt"), "copied").unwrap();
		make_fifo(&lower.join("named-pipe"));

		let mut child = Command::new(std::env::current_exe().unwrap())
			.args(["--ignored", "--exact", "rcopy::tests::fifo_copy_child", "--nocapture"])
			.env(FIFO_CHILD_ENV, "1")
			.env(FIFO_LOWER_ENV, &lower)
			.env(FIFO_MERGED_ENV, &merged)
			.stdin(Stdio::null())
			.stdout(Stdio::null())
			.stderr(Stdio::null())
			.spawn()
			.unwrap();

		let deadline = Instant::now() + Duration::from_secs(3);
		loop {
			if let Some(status) = child.try_wait().unwrap() {
				assert!(status.success(), "bounded FIFO copy child failed with {status}");
				break;
			}
			if Instant::now() >= deadline {
				child.kill().unwrap();
				let _ = child.wait();
				panic!("copy blocked while opening a FIFO");
			}
			std::thread::sleep(Duration::from_millis(10));
		}

		assert_eq!(fs::read_to_string(merged.join("regular.txt")).unwrap(), "copied");
		assert!(!merged.join("named-pipe").exists());
		assert!(!merged.join("standalone-pipe").exists());
	}

	#[test]
	#[ignore = "subprocess helper for bounded FIFO test"]
	fn fifo_copy_child() {
		if std::env::var_os(FIFO_CHILD_ENV).is_none() {
			return;
		}
		let lower = PathBuf::from(std::env::var_os(FIFO_LOWER_ENV).unwrap());
		let merged = PathBuf::from(std::env::var_os(FIFO_MERGED_ENV).unwrap());
		recursive_copy(&lower, &merged).unwrap();
		copy_path(&lower.join("named-pipe"), &merged.join("standalone-pipe")).unwrap();
	}
}
