use std::path::Path;

use async_trait::async_trait;

#[cfg(not(target_os = "linux"))]
use crate::IsoError;
use crate::{BackendKind, IsoResult, IsolationBackend, ProbeResult};

pub struct OverlayfsBackend;

pub fn backend() -> &'static dyn IsolationBackend {
	&OverlayfsBackend
}

#[async_trait]
impl IsolationBackend for OverlayfsBackend {
	fn kind(&self) -> BackendKind {
		BackendKind::Overlayfs
	}

	fn probe(&self) -> ProbeResult {
		#[cfg(target_os = "linux")]
		{
			imp::probe()
		}
		#[cfg(not(target_os = "linux"))]
		{
			ProbeResult::unavailable("overlayfs isolation is only available on Linux")
		}
	}

	fn start(&self, lower: &Path, merged: &Path) -> IsoResult<()> {
		#[cfg(target_os = "linux")]
		{
			imp::start(lower, merged)
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = (lower, merged);
			Err(IsoError::unavailable("overlayfs isolation is only available on Linux"))
		}
	}

	fn stop(&self, merged: &Path) -> IsoResult<()> {
		#[cfg(target_os = "linux")]
		{
			imp::stop(merged)
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = merged;
			Ok(())
		}
	}
}

#[cfg(target_os = "linux")]
mod imp {
	use std::{
		collections::BTreeMap,
		ffi::CString,
		fs,
		os::unix::ffi::OsStrExt,
		path::{Path, PathBuf},
		process::{Command, Stdio},
		sync::{
			LazyLock,
			atomic::{AtomicBool, Ordering},
		},
	};

	use parking_lot::Mutex;

	use crate::{IsoError, IsoResult, ProbeResult, command_failed};

	#[derive(Clone, Copy)]
	enum MountFlavor {
		Kernel,
		Fuse,
	}

	static ACTIVE_MOUNTS: LazyLock<Mutex<BTreeMap<PathBuf, MountFlavor>>> =
		LazyLock::new(|| Mutex::new(BTreeMap::new()));

	/// Set once `fuse-overlayfs` has run; a host that has it keeps it, so later
	/// probes skip the spawn. A failure is not cached: it can be installed while
	/// a long-running session is up, so the next probe spawns again.
	static FUSE_OVERLAYFS: AtomicBool = AtomicBool::new(false);

	pub fn probe() -> ProbeResult {
		if kernel_overlay_supported() || FUSE_OVERLAYFS.load(Ordering::Relaxed) {
			return ProbeResult::available();
		}
		let fuse_runs = Command::new("fuse-overlayfs")
			.arg("--version")
			.stdin(Stdio::null())
			.stdout(Stdio::null())
			.stderr(Stdio::null())
			.status()
			.is_ok();
		if fuse_runs {
			FUSE_OVERLAYFS.store(true, Ordering::Relaxed);
			return ProbeResult::available();
		}
		ProbeResult::unavailable(
			"overlay filesystem unavailable: kernel `overlay` module missing and `fuse-overlayfs` \
			 not on PATH",
		)
	}

	pub fn start(lower: &Path, merged: &Path) -> IsoResult<()> {
		let lower = canonical_existing_dir(lower)?;
		let merged = absolutize(merged);
		let base = merged.parent().ok_or_else(|| {
			IsoError::other(format!("merged path has no parent: {}", merged.display()))
		})?;
		let upper = base.join("upper");
		let work = base.join("work");

		remove_dir_if_exists(&upper, "stale overlay upper")?;
		remove_dir_if_exists(&work, "stale overlay work")?;
		remove_dir_if_exists(&merged, "stale overlay merged")?;

		fs::create_dir_all(&upper)
			.map_err(|err| IsoError::other(format!("create upper dir {}: {err}", upper.display())))?;
		fs::create_dir_all(&work)
			.map_err(|err| IsoError::other(format!("create work dir {}: {err}", work.display())))?;
		fs::create_dir_all(&merged).map_err(|err| {
			IsoError::other(format!("create merged dir {}: {err}", merged.display()))
		})?;

		let opts = format!(
			"lowerdir={},upperdir={},workdir={}",
			lower.display(),
			upper.display(),
			work.display()
		);

		match kernel_mount(&merged, &opts) {
			Ok(()) => {
				ACTIVE_MOUNTS.lock().insert(merged, MountFlavor::Kernel);
				Ok(())
			},
			Err(err) if err.is_unavailable() => {
				fuse_mount(&lower, &upper, &work, &merged)?;
				ACTIVE_MOUNTS.lock().insert(merged, MountFlavor::Fuse);
				Ok(())
			},
			Err(err) => Err(err),
		}
	}

	pub fn stop(merged: &Path) -> IsoResult<()> {
		let merged = absolutize(merged);
		let result = {
			let flavor = ACTIVE_MOUNTS.lock().remove(&merged);
			match flavor {
				Some(MountFlavor::Fuse) => fuse_umount(&merged),
				Some(MountFlavor::Kernel) | None => kernel_umount(&merged).or_else(|err| {
					if err.is_unavailable() {
						fuse_umount(&merged)
					} else {
						Err(err)
					}
				}),
			}
		};
		result?;

		if let Some(base) = merged.parent() {
			remove_dir_if_exists(&base.join("upper"), "overlay upper")?;
			remove_dir_if_exists(&base.join("work"), "overlay work")?;
		}
		remove_dir_if_exists(&merged, "overlay merged")
	}

	fn kernel_mount(merged: &Path, opts: &str) -> IsoResult<()> {
		let target = to_cstring(merged.as_os_str().as_bytes(), "merged")?;
		let source = CString::new("overlay").expect("static source");
		let fstype = CString::new("overlay").expect("static fstype");
		let opts_c = to_cstring(opts.as_bytes(), "overlay options")?;

		let rc = unsafe {
			libc::mount(
				source.as_ptr(),
				target.as_ptr(),
				fstype.as_ptr(),
				0,
				opts_c.as_ptr().cast::<libc::c_void>(),
			)
		};
		if rc == 0 {
			return Ok(());
		}
		let err = std::io::Error::last_os_error();
		let raw = err.raw_os_error();
		if matches!(
			raw,
			Some(libc::EPERM | libc::EACCES | libc::ENODEV | libc::ENOENT | libc::EINVAL)
		) {
			return Err(IsoError::unavailable(format!(
				"kernel overlay mount denied ({err}); falling back to fuse-overlayfs"
			)));
		}
		Err(IsoError::other(format!("overlay mount {}: {err}", merged.display())))
	}

	fn kernel_umount(merged: &Path) -> IsoResult<()> {
		let target = to_cstring(merged.as_os_str().as_bytes(), "merged")?;

		let rc = unsafe { libc::umount2(target.as_ptr(), libc::MNT_DETACH) };
		if rc == 0 {
			return Ok(());
		}
		let err = std::io::Error::last_os_error();
		match err.raw_os_error() {
			Some(libc::EINVAL | libc::ENOENT) => Ok(()),
			Some(libc::EPERM | libc::EACCES) => {
				Err(IsoError::unavailable(format!("kernel umount denied: {err}")))
			},
			_ => Err(IsoError::other(format!("umount {}: {err}", merged.display()))),
		}
	}

	fn fuse_mount(lower: &Path, upper: &Path, work: &Path, merged: &Path) -> IsoResult<()> {
		let opts = format!(
			"lowerdir={},upperdir={},workdir={}",
			lower.display(),
			upper.display(),
			work.display()
		);
		let output = Command::new("fuse-overlayfs")
			.args(["-o", &opts])
			.arg(merged)
			.stdin(Stdio::null())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped())
			.output();
		let output = match output {
			Ok(out) => out,
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
				return Err(IsoError::unavailable(
					"fuse-overlayfs not found on PATH; install it to enable overlay isolation",
				));
			},
			Err(err) => return Err(IsoError::other(format!("spawn fuse-overlayfs: {err}"))),
		};
		if output.status.success() {
			return Ok(());
		}
		Err(command_failed(
			"fuse-overlayfs mount failed",
			output.status.code().unwrap_or(-1),
			&output.stderr,
		))
	}

	/// Unmount helpers in preference order: libfuse3's `fusermount3`, then the
	/// libfuse2 `fusermount` older hosts ship instead.
	const FUSERMOUNT: [&str; 2] = ["fusermount3", "fusermount"];

	fn fuse_umount(merged: &Path) -> IsoResult<()> {
		fuse_umount_with(&FUSERMOUNT, merged)
	}

	/// Unmount the FUSE mount at `merged` via the first of `programs` that
	/// succeeds.
	///
	/// A plain `-u` right after the session ends can fail with a transient
	/// `EBUSY` while the kernel still holds references to the mount; the lazy
	/// `-u -z` then detaches it anyway and the daemon exits once those drop.
	/// The final `umount2` is `EPERM` for the unprivileged users that use
	/// fuse-overlayfs, so a fusermount failure (with its stderr) is what gets
	/// reported when every attempt fails.
	fn fuse_umount_with(programs: &[&str], merged: &Path) -> IsoResult<()> {
		let mut fuse_err = None;
		'programs: for program in programs {
			for args in [&["-u"][..], &["-u", "-z"]] {
				let result = Command::new(program)
					.args(args)
					.arg(merged)
					.stdin(Stdio::null())
					.stdout(Stdio::null())
					.stderr(Stdio::piped())
					.output();
				match result {
					Ok(out) if out.status.success() => return Ok(()),
					Ok(out) => {
						fuse_err = Some(command_failed(
							format_args!("{program} {}", args.join(" ")),
							out.status.code().unwrap_or(-1),
							&out.stderr,
						));
					},
					Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue 'programs,
					Err(err) => return Err(IsoError::other(format!("spawn {program}: {err}"))),
				}
			}
		}
		// Last resort — the lazy kernel umount works for both kernel overlay and
		// any fuse mount the caller is privileged to detach.
		kernel_umount(merged).map_err(|err| fuse_err.unwrap_or(err))
	}

	fn kernel_overlay_supported() -> bool {
		let Ok(text) = fs::read_to_string("/proc/filesystems") else {
			return false;
		};
		text
			.lines()
			.any(|line| line.split_whitespace().any(|word| word == "overlay"))
	}

	fn canonical_existing_dir(path: &Path) -> IsoResult<PathBuf> {
		let resolved = absolutize(path);
		let meta = fs::metadata(&resolved).map_err(|err| {
			IsoError::other(format!("invalid overlay lower {}: {err}", resolved.display()))
		})?;
		if !meta.is_dir() {
			return Err(IsoError::other(format!(
				"overlay lower {} is not a directory",
				resolved.display()
			)));
		}
		Ok(fs::canonicalize(&resolved).unwrap_or(resolved))
	}

	fn absolutize(path: &Path) -> PathBuf {
		if path.is_absolute() {
			path.to_path_buf()
		} else {
			std::env::current_dir().map_or_else(|_| path.to_path_buf(), |cwd| cwd.join(path))
		}
	}

	fn remove_dir_if_exists(path: &Path, label: &str) -> IsoResult<()> {
		match fs::remove_dir_all(path) {
			Ok(()) => Ok(()),
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
			Err(err) => Err(IsoError::other(format!("remove {label} {}: {err}", path.display()))),
		}
	}

	fn to_cstring(bytes: &[u8], label: &str) -> IsoResult<CString> {
		CString::new(bytes)
			.map_err(|err| IsoError::other(format!("{label} path contains NUL byte: {err}")))
	}
}
