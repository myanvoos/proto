//! Cross-platform process tree management.

use std::{
	collections::{HashMap, HashSet},
	time::Duration,
};

use anyhow::Result;
use parking_lot::Mutex;
/// Current state of a process reference.
///
/// Defined in `pi-builtins` alongside the process-table snapshots its process
/// builtins read, and re-exported here so this module — and `pi-natives`
/// through it — keeps one status type for both concerns.
pub use pi_builtins::ProcessStatus;

use crate::cancel::CancelToken;

#[cfg(target_os = "linux")]
mod platform {
	use std::{
		collections::HashSet,
		ffi::OsStr,
		fs,
		os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
		ptr,
		sync::Arc,
	};

	use super::ProcessStatus;

	/// Stable Linux process reference backed by a pidfd.
	#[derive(Clone)]
	pub struct Process {
		pid:        i32,
		pidfd:      Arc<OwnedFd>,
		start_time: u64,
	}

	impl Process {
		pub fn from_pid(pid: i32) -> Option<Self> {
			if pid <= 0 {
				return None;
			}
			let pidfd = open_pidfd(pid)?;
			let start_time = read_start_time(pid)?;
			Some(Self { pid, pidfd, start_time })
		}

		pub const fn pid(&self) -> i32 {
			self.pid
		}

		pub fn children(&self) -> Vec<Self> {
			if !self.live_identity() {
				return Vec::new();
			}

			// `/proc/{pid}/task/{tid}/children` is per-task: a child fork()ed from a
			// worker thread appears under that thread's `tid`, not the tgid. Walk
			// every task subdir and union the lists, then re-validate parentage.
			let task_dir = format!("/proc/{}/task", self.pid);
			let Ok(entries) = fs::read_dir(&task_dir) else {
				return Vec::new();
			};

			let mut seen: HashSet<i32> = HashSet::new();
			let mut out = Vec::new();
			let mut children_file_available = false;
			for entry in entries.flatten() {
				let name = entry.file_name();
				let Some(tid_str) = name.to_str() else {
					continue;
				};
				if tid_str.parse::<i32>().is_err() {
					continue;
				}
				let children_path = format!("/proc/{}/task/{}/children", self.pid, tid_str);
				let Ok(content) = fs::read_to_string(&children_path) else {
					continue;
				};
				// The file is readable -> this kernel has CONFIG_PROC_CHILDREN.
				children_file_available = true;
				for part in content.split_whitespace() {
					let Ok(child_pid) = part.parse::<i32>() else {
						continue;
					};
					self.push_validated_child(child_pid, &mut seen, &mut out);
				}
			}

			// Some Kata / microVM guest kernels are built without CONFIG_PROC_CHILDREN,
			// so no `.../children` file exists and the walk above finds nothing — which
			// would silently turn descendant signaling (cancellation cleanup) into a
			// no-op inside such containers. Fall back to scanning `/proc` and grouping
			// by parent pid, the same primitive the macOS path uses. Only taken when no
			// `children` file was readable, so kernels that support it keep the cheap
			// per-task fast path.
			if !children_file_available && let Ok(proc_entries) = fs::read_dir("/proc") {
				for entry in proc_entries.flatten() {
					let name = entry.file_name();
					let Some(pid_str) = name.to_str() else {
						continue;
					};
					let Ok(child_pid) = pid_str.parse::<i32>() else {
						continue;
					};
					self.push_validated_child(child_pid, &mut seen, &mut out);
				}
			}
			out
		}

		/// Validate a candidate child pid — dedup, still running, and currently
		/// parented to `self` — then push it onto `out`. Shared by the
		/// `/proc/<pid>/task/<tid>/children` fast path and the `/proc`-scan
		/// fallback for kernels without `CONFIG_PROC_CHILDREN`.
		fn push_validated_child(&self, child_pid: i32, seen: &mut HashSet<i32>, out: &mut Vec<Self>) {
			if child_pid == self.pid || !seen.insert(child_pid) {
				return;
			}
			let Some(child) = Self::from_pid(child_pid) else {
				return;
			};
			if child.status() == ProcessStatus::Running
				&& current_parent_pid(child.pid) == Some(self.pid)
			{
				out.push(child);
			}
		}

		pub fn parent_pid(&self) -> Option<i32> {
			if self.status() == ProcessStatus::Running {
				current_parent_pid(self.pid)
			} else {
				None
			}
		}

		pub fn args(&self) -> Vec<String> {
			if !self.live_identity() {
				return Vec::new();
			}

			let cmdline_path = format!("/proc/{}/cmdline", self.pid);
			let Ok(content) = fs::read(cmdline_path) else {
				return Vec::new();
			};
			// Re-validate after the read: PID reuse between identity check and read
			// would otherwise leak an impostor's command line to callers.
			if !self.live_identity() {
				return Vec::new();
			}
			split_nul_arguments(&content)
		}

		pub fn kill(&self, signal: i32) -> bool {
			// SAFETY: `self.pidfd` is an owned file descriptor returned by a successful
			// `pidfd_open` call and remains open for the duration of this syscall. A null
			// `siginfo_t` pointer is explicitly accepted by `pidfd_send_signal` and makes
			// the kernel synthesize the same signal metadata as `kill(2)`. Flags are zero,
			// which is the documented default behavior.
			let ret = unsafe {
				libc::syscall(
					libc::SYS_pidfd_send_signal,
					self.pidfd.as_raw_fd(),
					signal,
					ptr::null::<libc::siginfo_t>(),
					0,
				)
			};
			ret == 0
		}

		pub fn group_id(&self) -> Option<i32> {
			if self.status() != ProcessStatus::Running {
				return None;
			}

			// SAFETY: `self.pid` names the process currently referenced by `self.pidfd`
			// unless it exits concurrently. If it exits, `getpgid` reports failure rather
			// than dereferencing caller-owned memory.
			let pgid = unsafe { libc::getpgid(self.pid) };
			if pgid > 0 { Some(pgid) } else { None }
		}

		pub fn status(&self) -> ProcessStatus {
			loop {
				let mut pollfd =
					libc::pollfd { fd: self.pidfd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
				// SAFETY: `pollfd` points to one initialized `pollfd` element, and the pidfd
				// remains open for the duration of the call. Timeout zero makes this a
				// non-blocking readiness probe.
				let ready = unsafe { libc::poll(&raw mut pollfd, 1, 0) };
				if ready < 0 {
					// Retry on EINTR; for any other transient poll error treat the pidfd as
					// still running. The pidfd is still owned and the kernel has not reported
					// the process gone — a spurious `Exited` here makes every downstream
					// signal/kill fall through silently.
					if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
						continue;
					}
					return ProcessStatus::Running;
				}
				if ready == 0 {
					return ProcessStatus::Running;
				}
				if (pollfd.revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR | libc::POLLNVAL))
					!= 0
				{
					return ProcessStatus::Exited;
				}
				return ProcessStatus::Running;
			}
		}

		/// Walk the descendant tree in post-order (leaves first), de-duplicating
		/// by PID so concurrent reparenting cannot trap us in a cycle.
		pub fn descendants(&self) -> Vec<Self> {
			let mut out = Vec::new();
			let mut visited = HashSet::new();
			visited.insert(self.pid);
			self.descendants_into(&mut out, &mut visited);
			out
		}

		fn descendants_into(&self, out: &mut Vec<Self>, visited: &mut HashSet<i32>) {
			for child in self.children() {
				if visited.insert(child.pid) {
					child.descendants_into(out, visited);
					out.push(child);
				}
			}
		}

		fn live_identity(&self) -> bool {
			self.status() == ProcessStatus::Running
				&& read_start_time(self.pid) == Some(self.start_time)
		}
	}

	fn split_nul_arguments(content: &[u8]) -> Vec<String> {
		content
			.split(|byte| *byte == 0)
			.filter(|part| !part.is_empty())
			.map(|part| String::from_utf8_lossy(part).into_owned())
			.collect()
	}

	fn current_parent_pid(pid: i32) -> Option<i32> {
		let status_path = format!("/proc/{pid}/status");
		let content = fs::read_to_string(status_path).ok()?;
		content.lines().find_map(|line| {
			line
				.strip_prefix("PPid:")
				.and_then(|ppid| ppid.trim().parse::<i32>().ok())
		})
	}

	fn read_start_time(pid: i32) -> Option<u64> {
		// `/proc/[pid]/stat` field 22 is the process start time in clock ticks since
		// boot. The comm field (between parens) may itself contain spaces and parens,
		// so locate the *last* `)` and split the trailing whitespace-separated fields.
		let stat_path = format!("/proc/{pid}/stat");
		let content = fs::read_to_string(stat_path).ok()?;
		let last_paren = content.rfind(')')?;
		let rest = &content[last_paren + 1..];
		rest.split_whitespace().nth(19)?.parse().ok()
	}

	fn open_pidfd(pid: i32) -> Option<Arc<OwnedFd>> {
		// SAFETY: `pidfd_open` takes the PID by value and does not read caller-owned
		// memory. Flags are zero, which is valid. On success the returned descriptor is
		// newly owned by this process and is immediately wrapped in `OwnedFd` below.
		let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
		if fd < 0 {
			return None;
		}

		// SAFETY: `fd` is non-negative and was just returned by `pidfd_open`, so it is
		// an open descriptor owned by this process. `OwnedFd` takes sole ownership and
		// will close it exactly once.
		Some(Arc::new(unsafe { OwnedFd::from_raw_fd(fd as RawFd) }))
	}

	/// Send `signal` to the process group `pgid`.
	/// Returns true when the signal is delivered successfully.
	pub fn kill_process_group(pgid: i32, signal: i32) -> bool {
		// SAFETY: `kill` takes integer identifiers by value and does not access
		// caller-owned memory. A negative PID is the POSIX process-group form.
		unsafe { libc::kill(-pgid, signal) == 0 }
	}

	/// Find processes whose `/proc/{pid}/exe` symlink resolves to exactly
	/// `target`.
	pub fn find_by_path(target: &str) -> Vec<Process> {
		let mut matches = Vec::new();
		let Ok(entries) = fs::read_dir("/proc") else {
			return matches;
		};
		let target_os = OsStr::new(target);
		for entry in entries.flatten() {
			let name = entry.file_name();
			let Some(name_str) = name.to_str() else {
				continue;
			};
			let Ok(pid) = name_str.parse::<i32>() else {
				continue;
			};
			let exe_path = format!("/proc/{pid}/exe");
			let Ok(resolved) = fs::read_link(&exe_path) else {
				continue;
			};
			if resolved.as_os_str() == target_os
				&& let Some(process) = Process::from_pid(pid)
			{
				matches.push(process);
			}
		}
		matches
	}
}

#[cfg(target_os = "macos")]
mod platform {
	use std::{
		collections::{HashMap, HashSet},
		ptr,
	};

	use super::ProcessStatus;

	#[link(name = "proc", kind = "dylib")]
	unsafe extern "C" {
		fn proc_listallpids(buffer: *mut i32, buffersize: i32) -> i32;
		fn proc_pidpath(pid: i32, buffer: *mut std::ffi::c_void, buffersize: u32) -> i32;
	}

	/// macOS does not expose pidfds; identity is pinned via the kernel-reported
	/// process start time so a recycled PID does not silently impersonate the
	/// original target.
	#[derive(Clone)]
	pub struct Process {
		pid:          i32,
		start_tvsec:  u64,
		start_tvusec: u64,
	}

	impl Process {
		pub fn from_pid(pid: i32) -> Option<Self> {
			if pid <= 0 {
				return None;
			}
			let info = read_bsdinfo(pid)?;
			if i32::try_from(info.pbi_pid).ok()? != pid {
				return None;
			}
			Some(Self { pid, start_tvsec: info.pbi_start_tvsec, start_tvusec: info.pbi_start_tvusec })
		}

		pub const fn pid(&self) -> i32 {
			self.pid
		}

		pub fn children(&self) -> Vec<Self> {
			if self.live_bsdinfo().is_none() {
				return Vec::new();
			}
			// `proc_listchildpids` (the obvious choice) is broken on recent macOS
			// kernels when queried for the *calling* process — it returns one byte of
			// padding regardless of how many children the process actually has, so a
			// process can never list its own descendants. Confirmed on darwin 25.4
			// from C, Rust, and Bun callers via `proc_listchildpids(getpid(), …)`,
			// while `ps -P` and `pgrep -P` still see the same children. Walk the
			// whole pid table via `proc_listallpids` and filter on `pbi_ppid`
			// instead; this is the same approach we already use for `find_by_path`.
			let tree = build_process_tree();
			Self::children_from_tree(self.pid, &tree)
		}

		pub fn parent_pid(&self) -> Option<i32> {
			let info = self.live_bsdinfo()?;
			i32::try_from(info.pbi_ppid).ok().filter(|ppid| *ppid > 0)
		}

		pub fn args(&self) -> Vec<String> {
			if self.live_bsdinfo().is_none() {
				return Vec::new();
			}
			process_args(self.pid)
		}

		pub fn kill(&self, signal: i32) -> bool {
			// Re-validate identity right before signaling. There is no atomic
			// "kill iff start_time matches" primitive on macOS, so a vanishingly small
			// window remains between this check and the syscall — but matching against
			// the recorded `(pid, start_tvsec, start_tvusec)` triple eliminates the
			// PID-reuse race in every practical case.
			if self.live_bsdinfo().is_none() {
				return false;
			}
			// SAFETY: `kill` takes integer identifiers by value and does not access
			// caller-owned memory.
			unsafe { libc::kill(self.pid, signal) == 0 }
		}

		pub fn group_id(&self) -> Option<i32> {
			let info = self.live_bsdinfo()?;
			i32::try_from(info.pbi_pgid).ok().filter(|pgid| *pgid > 0)
		}

		/// Walk the descendant tree in post-order (leaves first), de-duplicating
		/// by PID so concurrent reparenting cannot trap us in a cycle.
		pub fn descendants(&self) -> Vec<Self> {
			// One process-table snapshot per walk — building it inside the recursion
			// would re-scan every pid for every visited node, producing an `O(N · D)`
			// kernel call pattern.
			let tree = build_process_tree();
			let mut out = Vec::new();
			let mut visited = HashSet::new();
			visited.insert(self.pid);
			Self::collect_descendants_from_tree(self.pid, &tree, &mut visited, &mut out);
			out
		}

		fn children_from_tree(parent: i32, tree: &HashMap<i32, Vec<i32>>) -> Vec<Self> {
			let Some(child_pids) = tree.get(&parent) else {
				return Vec::new();
			};
			child_pids
				.iter()
				.copied()
				.filter_map(Self::from_pid)
				.collect()
		}

		fn collect_descendants_from_tree(
			parent: i32,
			tree: &HashMap<i32, Vec<i32>>,
			visited: &mut HashSet<i32>,
			out: &mut Vec<Self>,
		) {
			let Some(child_pids) = tree.get(&parent) else {
				return;
			};
			for &child_pid in child_pids {
				if !visited.insert(child_pid) {
					continue;
				}
				let Some(child) = Self::from_pid(child_pid) else {
					continue;
				};
				// Post-order: grandchildren first, so leaf processes get signalled
				// before their parents during tree termination.
				Self::collect_descendants_from_tree(child_pid, tree, visited, out);
				out.push(child);
			}
		}

		pub fn status(&self) -> ProcessStatus {
			if self.live_bsdinfo().is_some() {
				ProcessStatus::Running
			} else {
				ProcessStatus::Exited
			}
		}

		/// Returns the current `proc_bsdinfo` only if it still describes the same
		/// process this reference was opened on — i.e. the start time has not
		/// changed.
		fn live_bsdinfo(&self) -> Option<libc::proc_bsdinfo> {
			let info = read_bsdinfo(self.pid)?;
			if info.pbi_start_tvsec == self.start_tvsec && info.pbi_start_tvusec == self.start_tvusec {
				Some(info)
			} else {
				None
			}
		}
	}

	/// Send `signal` to the process group `pgid`.
	/// Returns true when the signal is delivered successfully.
	pub fn kill_process_group(pgid: i32, signal: i32) -> bool {
		// SAFETY: `kill` takes integer identifiers by value and does not access
		// caller-owned memory. A negative PID is the POSIX process-group form.
		unsafe { libc::kill(-pgid, signal) == 0 }
	}

	const KERN_PROCARGS2: libc::c_int = 49;

	const PROC_PIDPATHINFO_MAXSIZE: usize = 4096;

	/// Snapshot every pid currently visible to `proc_listallpids`. macOS
	/// silently truncates the second call to the supplied buffer size even
	/// when the sizing query reports more bytes available, so the buffer is
	/// padded well beyond the reported count.
	fn snapshot_all_pids() -> Vec<i32> {
		// SAFETY: Passing a null buffer with size 0 is the documented libproc query
		// form for obtaining the byte count needed for all PIDs; libproc does not
		// dereference the null pointer in this mode.
		let bytes = unsafe { proc_listallpids(ptr::null_mut(), 0) };
		if bytes <= 0 {
			return Vec::new();
		}
		let count = (bytes as usize) / size_of::<i32>();
		let cap = count.saturating_mul(4).max(2048);
		let mut buffer = vec![0i32; cap];
		// SAFETY: `buffer` is valid for `buffer.len() * size_of::<i32>()` bytes and
		// is properly aligned for `i32`; libproc writes at most the supplied size.
		let actual =
			unsafe { proc_listallpids(buffer.as_mut_ptr(), (buffer.len() * size_of::<i32>()) as i32) };
		if actual <= 0 {
			return Vec::new();
		}
		let pid_count = ((actual as usize) / size_of::<i32>()).min(buffer.len());
		buffer.truncate(pid_count);
		buffer
	}

	/// Build a `ppid -> [pids]` map from a one-shot scan of `proc_listallpids`.
	///
	/// Used as the foundation of `Process::children` and `Process::descendants`
	/// on macOS where `proc_listchildpids` returns no children for self-queries.
	pub(super) fn build_process_tree() -> HashMap<i32, Vec<i32>> {
		let pids = snapshot_all_pids();
		let mut tree: HashMap<i32, Vec<i32>> = HashMap::with_capacity(pids.len() / 2);
		for pid in pids {
			if pid <= 0 {
				continue;
			}
			let Some(info) = read_bsdinfo(pid) else {
				continue;
			};
			let Ok(ppid) = i32::try_from(info.pbi_ppid) else {
				continue;
			};
			if ppid <= 0 {
				continue;
			}
			tree.entry(ppid).or_default().push(pid);
		}
		tree
	}

	/// Find processes whose libproc-reported executable path equals `target`.
	pub fn find_by_path(target: &str) -> Vec<Process> {
		let pids = snapshot_all_pids();
		let mut path_buf = vec![0u8; PROC_PIDPATHINFO_MAXSIZE];
		let mut matches = Vec::new();
		for pid in pids {
			if pid <= 0 {
				continue;
			}
			// SAFETY: `path_buf` is valid for `path_buf.len()` bytes; libproc writes a
			// NUL-terminated path no longer than the supplied capacity and returns the
			// number of bytes written.
			let len = unsafe {
				proc_pidpath(
					pid,
					path_buf.as_mut_ptr().cast::<std::ffi::c_void>(),
					path_buf.len() as u32,
				)
			};
			if len <= 0 {
				continue;
			}
			let path_bytes = &path_buf[..len as usize];
			let path_bytes = match path_bytes.iter().position(|byte| *byte == 0) {
				Some(end) => &path_bytes[..end],
				None => path_bytes,
			};
			let Ok(path) = std::str::from_utf8(path_bytes) else {
				continue;
			};
			if path == target
				&& let Some(process) = Process::from_pid(pid)
			{
				matches.push(process);
			}
		}
		matches
	}

	fn read_bsdinfo(pid: i32) -> Option<libc::proc_bsdinfo> {
		// SAFETY: `proc_bsdinfo` is a plain C data struct. Zero initialization is
		// valid because every field is an integer or fixed-size integer array, and
		// libproc fully overwrites the fields it reports on a successful call.
		let mut info = unsafe { std::mem::zeroed::<libc::proc_bsdinfo>() };
		// SAFETY: `info` is a writable `proc_bsdinfo` buffer whose exact byte size is
		// supplied to libproc. The PID, flavor, and arg are scalar values passed by
		// value; libproc writes at most the supplied buffer size.
		let actual = unsafe {
			libc::proc_pidinfo(
				pid,
				libc::PROC_PIDTBSDINFO,
				0,
				(&raw mut info).cast::<std::ffi::c_void>(),
				size_of::<libc::proc_bsdinfo>() as i32,
			)
		};
		if actual < size_of::<libc::proc_bsdinfo>() as i32 {
			return None;
		}
		Some(info)
	}

	fn process_args(pid: i32) -> Vec<String> {
		let mut mib = [libc::CTL_KERN, KERN_PROCARGS2, pid];
		let mut size = 0usize;
		// SAFETY: `mib` points to three initialized integers and the old-value buffer
		// is null with a zero-length query, which is the documented `sysctl` sizing
		// pattern. `size` is a valid out-parameter for the required byte count.
		let sizing_ok = unsafe {
			libc::sysctl(
				mib.as_mut_ptr(),
				mib.len() as u32,
				ptr::null_mut(),
				&raw mut size,
				ptr::null_mut(),
				0,
			)
		} == 0;
		if !sizing_ok || size <= size_of::<libc::c_int>() {
			return Vec::new();
		}

		let mut buffer = vec![0u8; size];
		// SAFETY: `mib` still points to three initialized integers. `buffer` is
		// writable for `size` bytes, and `size` is provided as the in/out byte count.
		let read_ok = unsafe {
			libc::sysctl(
				mib.as_mut_ptr(),
				mib.len() as u32,
				buffer.as_mut_ptr().cast::<std::ffi::c_void>(),
				&raw mut size,
				ptr::null_mut(),
				0,
			)
		} == 0;
		if !read_ok {
			return Vec::new();
		}
		buffer.truncate(size);
		parse_macos_procargs(&buffer)
	}

	fn parse_macos_procargs(buffer: &[u8]) -> Vec<String> {
		// KERN_PROCARGS2 layout: `argc: i32 | exec_path: NUL-padded | argv[0..argc] |
		// env[..]`. argc covers only argv, so we must skip the exec_path NUL padding
		// and stop after exactly argc entries — otherwise environment variables leak
		// into the arg list (each NUL-terminated env=value is indistinguishable from
		// an arg).
		let argc_size = size_of::<libc::c_int>();
		if buffer.len() <= argc_size {
			return Vec::new();
		}

		let argc_bytes: [u8; 4] = match buffer[..argc_size].try_into() {
			Ok(bytes) => bytes,
			Err(_) => return Vec::new(),
		};
		let argc = libc::c_int::from_ne_bytes(argc_bytes);
		if argc <= 0 {
			return Vec::new();
		}

		let mut offset = argc_size;
		while offset < buffer.len() && buffer[offset] != 0 {
			offset += 1;
		}
		while offset < buffer.len() && buffer[offset] == 0 {
			offset += 1;
		}

		let mut args = Vec::with_capacity(argc as usize);
		while offset < buffer.len() && args.len() < argc as usize {
			let end = buffer[offset..]
				.iter()
				.position(|byte| *byte == 0)
				.map_or(buffer.len(), |position| offset + position);
			if end == offset {
				break;
			}
			args.push(String::from_utf8_lossy(&buffer[offset..end]).into_owned());
			offset = end + 1;
		}
		args
	}
}
/// Stable process reference.
#[derive(Clone)]
pub struct Process {
	inner: platform::Process,
}

impl Process {
	/// Open a stable process reference from a PID.
	pub fn from_pid(pid: i32) -> Option<Self> {
		platform::Process::from_pid(pid).map(Self::from_inner)
	}

	/// Open stable process references whose executable path matches exactly.
	pub fn from_path(path: String) -> Vec<Self> {
		platform::find_by_path(&path)
			.into_iter()
			.map(Self::from_inner)
			.collect()
	}

	/// Operating-system process identifier for this process reference.
	#[must_use]
	pub const fn pid(&self) -> i32 {
		self.inner.pid()
	}

	/// Parent process id for this process, when available.
	#[must_use]
	pub fn ppid(&self) -> Option<i32> {
		self.inner.parent_pid()
	}

	/// Launch arguments for this process.
	#[must_use]
	pub fn args(&self) -> Vec<String> {
		self.inner.args()
	}

	/// Send `signal` to this process and its descendants, children first.
	///
	/// On Linux and macOS the signal is forwarded as-is. Defaults to the POSIX
	/// hard-kill signal.
	#[must_use]
	pub fn kill_tree(&self, signal: Option<i32>) -> u32 {
		self.signal_tree(signal.unwrap_or(KILL_SIGNAL))
	}

	/// Process group id for this process, when supported by the platform.
	#[must_use]
	pub fn group_id(&self) -> Option<i32> {
		self.inner.group_id()
	}

	/// Direct children of this process as stable process references.
	pub fn children(&self) -> Vec<Self> {
		self
			.inner
			.children()
			.into_iter()
			.map(Self::from_inner)
			.collect()
	}

	/// Current status of this process reference.
	#[must_use]
	pub fn status(&self) -> ProcessStatus {
		self.inner.status()
	}

	/// Gracefully terminate this process and its descendants.
	///
	/// Sends `TERM_SIGNAL` to the optional process group, every live descendant,
	/// and the root, then optionally waits up to `graceful_ms` for the tree to
	/// exit before escalating to `KILL_SIGNAL`. Pass `graceful_ms < 0` to skip
	/// the wait entirely (the polite signal is still emitted). Returns `true`
	/// when the tree has exited by the end of the hard wave's wait window.
	pub async fn terminate_tree(
		&self,
		group: bool,
		graceful_ms: i32,
		timeout_ms: u32,
		ct: CancelToken,
	) -> Result<bool> {
		self
			.terminate_tree_impl(group, graceful_ms, timeout_ms, ct)
			.await
	}

	/// Wait until this process exits, optionally bounded by `timeout`.
	pub async fn wait_for_exit(&self, timeout: Option<Duration>, ct: CancelToken) -> Result<bool> {
		wait_for_exit(self, &[], timeout, ct).await
	}
}

impl Process {
	const fn from_inner(inner: platform::Process) -> Self {
		Self { inner }
	}

	/// Walk the live descendant tree from scratch. Cheap and idempotent — call
	/// it again before each signal wave so grandchildren spawned during a grace
	/// period are not missed.
	fn live_descendants(&self) -> Vec<Self> {
		self
			.inner
			.descendants()
			.into_iter()
			.map(Self::from_inner)
			.collect()
	}

	fn signal_tree(&self, signal: i32) -> u32 {
		self.signal_tree_excluding(signal, &host_protected_pids())
	}

	/// Signal this process and its live descendants (children first), skipping
	/// any pid in `protected`.
	///
	/// `protected` shields the harness itself: a run-cancellation sweep must
	/// never hard-kill the host. On Windows the
	/// descendant tree is derived from raw `th32ParentProcessID` values that
	/// outlive their recorded parent, so a freshly spawned child whose recycled
	/// pid matches the harness's stale parent pid makes the harness enumerate
	/// as a false descendant; `TerminateProcess`-ing it drops the whole session
	/// with no cleanup and no `session_exit` record (#7452, related #4605).
	fn signal_tree_excluding(&self, signal: i32, protected: &HashSet<i32>) -> u32 {
		let descendants = self.signalable_descendants(protected);
		let mut signaled = 0u32;
		// If self leads its own process group, also signal the group — this catches
		// grandchildren reparented to init when their immediate parent died inside
		// the descendant walk.
		if let Some(pgid) = self.group_id()
			&& pgid == self.inner.pid()
		{
			let _ = kill_process_group(pgid, signal);
		}
		for child in &descendants {
			if child.inner.kill(signal) {
				signaled += 1;
			}
		}
		if !protected.contains(&self.pid()) && self.inner.kill(signal) {
			signaled += 1;
		}
		signaled
	}

	/// Live descendants with every protected subtree pruned, not just the exact
	/// protected pids.
	///
	/// The flattened descendant list can contain a protected node (the harness,
	/// on a Windows PID-reuse false-descendant) *together with* that node's real
	/// children, which were collected by recursing through it. Skipping only the
	/// exact protected pid would still terminate those unrelated worker/tool
	/// subprocesses, so drop every node whose recorded parent chain — within the
	/// enumerated set — passes through a protected pid (#7452 review).
	fn signalable_descendants(&self, protected: &HashSet<i32>) -> Vec<Self> {
		let descendants = self.live_descendants();
		let parents: HashMap<i32, i32> = descendants
			.iter()
			.filter_map(|descendant| descendant.ppid().map(|parent| (descendant.pid(), parent)))
			.collect();
		descendants
			.into_iter()
			.filter(|descendant| !pid_in_protected_subtree(descendant.pid(), protected, &parents))
			.collect()
	}

	async fn terminate_tree_impl(
		&self,
		group: bool,
		graceful_ms: i32,
		timeout_ms: u32,
		ct: CancelToken,
	) -> Result<bool> {
		if self.status() != ProcessStatus::Running {
			return Ok(true);
		}

		let process_group = if group { self.group_id() } else { None };
		let protected = host_protected_pids();

		// Polite wave: SIGTERM the group, every live descendant, then the root.
		if let Some(pgid) = process_group {
			let _ = kill_process_group(pgid, TERM_SIGNAL);
		}
		let mut descendants = self.signalable_descendants(&protected);
		for child in &descendants {
			let _ = child.inner.kill(TERM_SIGNAL);
		}
		if !protected.contains(&self.pid()) {
			let _ = self.inner.kill(TERM_SIGNAL);
		}

		// Optional grace wait. A negative `graceful_ms` skips the wait entirely
		// (we still emit the polite signal so cleanup handlers can run before KILL).
		if graceful_ms >= 0 {
			let exited = wait_for_exit(
				self,
				&descendants,
				Some(Duration::from_millis(graceful_ms as u64)),
				ct.clone(),
			)
			.await?;
			if exited {
				return Ok(true);
			}
		}

		// Hard wave. Re-walk the tree so any grandchild spawned during the grace
		// period — or any process re-parented to the root — is signalled too.
		if let Some(pgid) = process_group {
			let _ = kill_process_group(pgid, KILL_SIGNAL);
		}
		descendants = self.signalable_descendants(&protected);
		for child in &descendants {
			let _ = child.inner.kill(KILL_SIGNAL);
		}
		if !protected.contains(&self.pid()) {
			let _ = self.inner.kill(KILL_SIGNAL);
		}

		wait_for_exit(self, &descendants, Some(Duration::from_millis(u64::from(timeout_ms))), ct)
			.await
	}
}

/// The harness pid — the one process a run-cancellation sweep must never
/// signal.
///
/// On Unix the descendant walk is identity-pinned (pidfd / start-time), so the
/// host can never appear as a false descendant and this set is a harmless
/// no-op safety net. On Windows the descendant tree is derived from raw
/// `th32ParentProcessID` values that survive their recorded parent's death: a
/// freshly spawned child whose recycled pid matches the harness's stale parent
/// pid makes the harness enumerate as a false descendant, so cancelling a
/// timed-out bash run would `TerminateProcess` the host with no cleanup and no
/// `session_exit` record (#7452, related #4605).
///
/// Do not walk the host's numeric parent chain here. On Windows the host's
/// recorded parent pid can itself have been recycled onto the cancellation
/// target; treating that raw pid as protected would spare the hung command and
/// prune all of its descendants from cleanup.
fn host_protected_pids() -> HashSet<i32> {
	i32::try_from(std::process::id()).into_iter().collect()
}

/// True when `pid` is itself protected or descends — within the enumerated
/// `parents` map (pid -> recorded parent pid) — from a protected pid. Used to
/// prune a whole protected subtree from a cancellation sweep so a false
/// descendant of the harness cannot drag the harness's real children into the
/// kill set (#7452).
fn pid_in_protected_subtree(
	pid: i32,
	protected: &HashSet<i32>,
	parents: &HashMap<i32, i32>,
) -> bool {
	let mut current = pid;
	// Bound the walk against a corrupted or cyclic parent chain.
	for _ in 0..256 {
		if protected.contains(&current) {
			return true;
		}
		match parents.get(&current) {
			Some(&parent) if parent != current => current = parent,
			_ => return false,
		}
	}
	false
}

async fn wait_for_exit(
	root: &Process,
	descendants: &[Process],
	timeout: Option<Duration>,
	ct: CancelToken,
) -> Result<bool> {
	ct.heartbeat()?;
	if root.status() != ProcessStatus::Running
		&& descendants
			.iter()
			.all(|process| process.status() != ProcessStatus::Running)
	{
		return Ok(true);
	}

	let poll_interval = Duration::from_millis(50);
	let mut elapsed = Duration::ZERO;
	while timeout.is_none_or(|limit| elapsed < limit) {
		let sleep_for =
			timeout.map_or(poll_interval, |limit| limit.saturating_sub(elapsed).min(poll_interval));
		if sleep_for.is_zero() {
			break;
		}
		ct.heartbeat()?;
		tokio::time::sleep(sleep_for).await;
		elapsed += sleep_for;

		if root.status() != ProcessStatus::Running
			&& descendants
				.iter()
				.all(|process| process.status() != ProcessStatus::Running)
		{
			return Ok(true);
		}
	}

	Ok(false)
}

/// Send `signal` to the process group `pgid`.
/// Returns false when process groups are unsupported on the platform.
#[allow(clippy::missing_const_for_fn, reason = "Dispatches to platform-specific implementation")]
#[must_use]
pub fn kill_process_group(pgid: i32, signal: i32) -> bool {
	// Defense in depth: refuse to deliver a signal to the harness's own
	// process group. Doing so terminates the harness along with the targets.
	// `SpawnRegistry` only ever records pgids brush created for this run (never
	// the harness pgid); this catches any future caller that bypasses it.
	if pgid <= 0 || is_self_process_group(pgid) {
		return false;
	}
	platform::kill_process_group(pgid, signal)
}

#[cfg(unix)]
fn is_self_process_group(pgid: i32) -> bool {
	// SAFETY: `getpgid(0)` queries the calling process's pgid and does not access
	// caller-owned memory. A return value <= 0 is treated as "unknown", which
	// fails open so the actual signal call decides.
	let self_pgid = unsafe { libc::getpgid(0) };
	self_pgid > 0 && self_pgid == pgid
}

#[cfg(not(unix))]
const fn is_self_process_group(_pgid: i32) -> bool {
	false
}

/// POSIX `SIGTERM` / Windows polite termination sentinel.
pub const TERM_SIGNAL: i32 = 15;

/// POSIX `SIGKILL` / Windows hard-termination sentinel.
pub const KILL_SIGNAL: i32 = 9;

/// A collection of process groups and process trees scheduled for
/// termination together.
///
/// Built incrementally from job records or PTY metadata, then signalled
/// in escalating waves (typically `TERM_SIGNAL` followed by
/// `KILL_SIGNAL` after a grace period). Process-group calls are no-ops
/// on platforms that do not expose process groups.
#[derive(Default)]
pub struct TerminationTargets {
	pgids:     Vec<i32>,
	processes: Vec<Process>,
	seen_pids: HashSet<i32>,
}

impl TerminationTargets {
	/// Create an empty target set.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Record a process group id. Duplicates are ignored.
	pub fn add_pgid(&mut self, pgid: i32) {
		if pgid > 0 && !self.pgids.contains(&pgid) {
			self.pgids.push(pgid);
		}
	}

	/// Record a pid. Duplicates are ignored. If the pid is alive, opens
	/// a stable [`Process`] reference so the descendant tree can be
	/// killed even if the original pid is reused later.
	///
	/// Prefer [`add_process`](Self::add_process) when the caller already holds a
	/// [`Process`] captured at spawn time: opening by pid here loses the
	/// original identity if the pid was recycled between the child exiting
	/// and this call.
	pub fn add_pid(&mut self, pid: i32) {
		if self.seen_pids.insert(pid)
			&& let Some(process) = Process::from_pid(pid)
		{
			self.processes.push(process);
		}
	}

	/// Record a pre-pinned [`Process`] handle. Duplicates (by pid) are ignored.
	///
	/// This is the correct entry point when the caller captured the handle at
	/// spawn time — the handle already pins OS-level identity, so no `from_pid`
	/// re-open (and its PID-reuse race) is needed at cancellation time.
	pub fn add_process(&mut self, process: Process) {
		if self.seen_pids.insert(process.pid()) {
			self.processes.push(process);
		}
	}

	/// True when no targets have been recorded.
	#[must_use]
	pub const fn is_empty(&self) -> bool {
		self.pgids.is_empty() && self.processes.is_empty()
	}

	/// Send `signal` to every recorded target. Failures are swallowed:
	/// targets routinely exit between collection and signalling, and
	/// the caller's policy is "best effort".
	pub fn signal(&self, signal: i32) {
		for &pgid in &self.pgids {
			let _ = kill_process_group(pgid, signal);
		}
		for process in &self.processes {
			let _ = process.signal_tree(signal);
		}
	}
}

/// A single external child reported by the shell's spawn-observer hook.
///
/// `process` is captured *at spawn time* so its OS-level identity is pinned
/// before the pid can be recycled. On Windows an open process handle keeps
/// the pid reserved for the lifetime of the reference; on Linux the pidfd
/// pins identity; on macOS the recorded `(pid, start_time)` triple detects
/// impersonation. Storing only the raw pid and re-opening at cancellation
/// time — as previous versions did — leaked kills onto unrelated processes
/// that happened to acquire the recycled pid between the child exiting and
/// the run being cancelled (issue #4605).
#[derive(Clone)]
struct SpawnedProcess {
	process: Option<Process>,
	pgid:    Option<i32>,
}

/// Per-run record of the OS processes a single shell command launched,
/// captured at spawn time via brush's `SpawnObserver` hook.
///
/// Replaces the old process-global "new descendants since a baseline" diff,
/// which could not distinguish the children of concurrent runs sharing one
/// host process: a run that cancelled would signal *any* descendant spawned
/// after its baseline, including another run's children. Ownership is now
/// explicit — only processes this run actually spawned are ever signalled.
#[derive(Default)]
struct RegistryState {
	spawned:       Vec<SpawnedProcess>,
	/// The next `spawned.len()` at which `record` runs a sweep. Bounds sweep
	/// frequency when the live set stabilizes above the initial threshold:
	/// without this watermark, every subsequent `record` would find
	/// `len >= PRUNE_THRESHOLD` true and sweep on every spawn (O(n²) in a
	/// large-fan-out run like `for i in {1..1000}; do sleep 60 & done`). With
	/// it, the next sweep only fires once the vec has grown by another
	/// `PRUNE_THRESHOLD` entries since the previous sweep — restoring true
	/// amortized O(1) per spawn regardless of how many entries survive each
	/// sweep.
	next_sweep_at: usize,
}

#[derive(Default)]
pub struct SpawnRegistry {
	state: Mutex<RegistryState>,
}

impl SpawnRegistry {
	/// Amortized-cost threshold for opportunistic pruning of exited entries.
	///
	/// A shell run that spawns many short-lived external commands (e.g. a bash
	/// loop invoking a binary per iteration) would otherwise retain one owned
	/// pidfd per spawn for the lifetime of the run, exhausting per-process FD
	/// limits.
	///
	/// Each sweep costs `O(N)` (one non-blocking status probe per entry). The
	/// next sweep is scheduled `PRUNE_THRESHOLD` further records away — via the
	/// `next_sweep_at` watermark — so a run that keeps many concurrent
	/// long-lived children (`for i in {1..1000}; do sleep 60 & done`) does not
	/// sweep on every spawn just because the vec is already above threshold.
	/// Amortized cost per spawn stays `O(1)` regardless of the live-set size.
	const PRUNE_THRESHOLD: usize = 64;

	/// Create an empty registry.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Record a freshly spawned child. Called from the spawn-observer hook.
	///
	/// The `Process` handle MUST be opened by the caller *immediately* after
	/// the child's pid becomes visible, so identity is pinned before any race
	/// with pid recycling can start. When the pin fails (child already exited
	/// before we could `Process::from_pid`) the entry becomes a no-op at
	/// termination time — there is nothing left to signal.
	///
	/// Exited entries are swept opportunistically once the recorded vec
	/// crosses the next-sweep watermark, so long-running loops of short
	/// external commands cannot exhaust the process' FD/handle limit by
	/// retaining one owned handle per historical spawn.
	pub fn record(&self, pgid: Option<i32>, process: Option<Process>) {
		let mut state = self.state.lock();
		state.spawned.push(SpawnedProcess { process, pgid });
		if state.spawned.len() >= state.next_sweep_at.max(Self::PRUNE_THRESHOLD) {
			prune_exited(&mut state.spawned);
			// Schedule the next sweep `PRUNE_THRESHOLD` further records away.
			// Comparing against the post-sweep live-set size (not the pre-sweep
			// length) bounds the sweep frequency when many entries survive:
			// each sweep costs O(N) but now runs at most once per
			// `PRUNE_THRESHOLD` records, so amortized per-record cost is O(1)
			// even if the live set stays large.
			state.next_sweep_at = state.spawned.len() + Self::PRUNE_THRESHOLD;
		}
	}

	/// Build the kill set from the processes recorded so far. Re-read on every
	/// signal wave so a child spawned during a grace window — between the
	/// cancel firing and the next wave — is still reaped.
	///
	/// A recorded process contributes only while alive; a recorded pgid
	/// contributes only while the group still has members, so once the run's
	/// whole tree exits the targets are empty and the wave loop can stop early.
	///
	/// Pruning also runs here so a cancellation cycle sees a compact target
	/// set even when the record-time threshold hasn't fired yet.
	#[must_use]
	pub fn build_targets(&self) -> TerminationTargets {
		let mut targets = TerminationTargets::new();
		let spawned = {
			let mut state = self.state.lock();
			prune_exited(&mut state.spawned);
			// Reset the watermark to the current live-set size + threshold;
			// leaving a stale pre-sweep value would misgate the next
			// record-time sweep.
			state.next_sweep_at = state.spawned.len() + Self::PRUNE_THRESHOLD;
			state.spawned.clone()
		};
		for entry in spawned {
			if let Some(process) = entry.process {
				targets.add_process(process);
			}
			// If the observer failed to pin a handle at spawn time (the child
			// exited before `Process::from_pid` could open it), the child is
			// already gone — signalling anything for that pid would either
			// no-op or, worse, race a recycled pid onto an unrelated process.
			// Drop the entry entirely rather than reintroduce the pid-reuse
			// window this whole change exists to close (#4605).
			if let Some(pgid) = entry.pgid
				&& pgid > 0
				&& process_group_alive(pgid)
			{
				targets.add_pgid(pgid);
			}
		}
		targets
	}
}

/// Drop registry entries whose pinned process and process group are both
/// gone. With nothing still-live the entry contributes nothing to the next
/// termination wave and only pins an owned OS resource for no reason.
///
/// On Unix a child reparented onto init keeps its pgid, so a live pgid still
/// catches grandchildren whose immediate parent exited.
fn prune_exited(spawned: &mut Vec<SpawnedProcess>) {
	spawned.retain(|entry| {
		if let Some(process) = &entry.process
			&& process.status() == ProcessStatus::Running
		{
			return true;
		}
		entry
			.pgid
			.is_some_and(|pgid| pgid > 0 && process_group_alive(pgid))
	});
}

/// True when process group `pgid` still has at least one member. `kill(2)`
/// with signal 0 performs permission/existence checks without delivering a
/// signal; `EPERM` means the group exists but is not ours to signal, which
/// still counts as alive.
#[must_use]
fn process_group_alive(pgid: i32) -> bool {
	if pgid <= 0 {
		return false;
	}
	platform_process_group_alive(pgid)
}

#[cfg(unix)]
fn platform_process_group_alive(pgid: i32) -> bool {
	// SAFETY: `kill` takes integer identifiers by value and does not access
	// caller-owned memory. A negative pid targets the process group; signal 0
	// only runs the existence/permission checks.
	let ret = unsafe { libc::kill(-pgid, 0) };
	ret == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
const fn platform_process_group_alive(_pgid: i32) -> bool {
	false
}

#[cfg(test)]
mod tests {
	use super::*;

	/// The harness pid must be the only protected pid. Including its recorded
	/// parent would be unsafe on Windows: that stale numeric pid can have been
	/// recycled onto the timed-out command, causing cancellation to spare the
	/// hung target and its whole subtree.
	#[test]
	fn host_protected_pids_includes_self() {
		let self_pid = i32::try_from(std::process::id()).expect("self pid fits in i32");
		assert_eq!(
			host_protected_pids(),
			HashSet::from([self_pid]),
			"only the harness pid may be protected from cancellation sweeps",
		);
	}

	/// Regression test for #7452: a cancellation sweep must never signal the
	/// protected host pid, even when it is enumerated as the sweep root. On
	/// Windows a recycled pid can make the harness surface as
	/// a false descendant of a just-spawned child; `TerminateProcess`-ing it
	/// killed the whole session with no `session_exit` record. The observable
	/// defense — provable cross-platform — is that `signal_tree_excluding`
	/// leaves a protected pid untouched.
	#[cfg(unix)]
	#[test]
	fn signal_tree_spares_protected_pids() {
		use std::{process::Command, thread, time::Duration};

		let mut child = Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn sleep");
		let child_pid = i32::try_from(child.id()).expect("child pid fits in i32");
		let root = Process::from_pid(child_pid).expect("pin child");

		// Treat the child's pid as protected (standing in for the harness/an
		// ancestor). The sweep must refuse to signal it.
		let protected: HashSet<i32> = HashSet::from([child_pid]);
		let signaled = root.signal_tree_excluding(KILL_SIGNAL, &protected);
		assert_eq!(signaled, 0, "a protected root must never be signalled");

		// The protected process is still alive after the sweep.
		thread::sleep(Duration::from_millis(50));
		assert_eq!(
			root.status(),
			ProcessStatus::Running,
			"a protected pid must survive a cancellation sweep",
		);

		// With no protection the same sweep reaps it — proves the skip is what
		// spared it, not a dead target.
		let reaped = root.signal_tree_excluding(KILL_SIGNAL, &HashSet::new());
		assert!(reaped >= 1, "an unprotected root must be signalled");
		let _ = child.wait();
	}

	/// Regression test for the #7453 review: pruning a protected node must drop
	/// its whole subtree, not just the exact protected pid. A Windows PID-reuse
	/// false-descendant collects the harness together with the harness's real
	/// children (LSP servers, worker/tool subprocesses); skipping only the host
	/// pid would still terminate those. `pid_in_protected_subtree` walks the
	/// enumerated parent map so any node under a protected pid is excluded.
	#[test]
	fn protected_subtree_is_pruned_not_just_the_pid() {
		// root(1) -> host(2, protected) -> worker(3); root(1) -> real_child(4).
		let parents: HashMap<i32, i32> = HashMap::from([(2, 1), (3, 2), (4, 1)]);
		let protected: HashSet<i32> = HashSet::from([2]);

		assert!(
			pid_in_protected_subtree(2, &protected, &parents),
			"the protected node itself must be excluded",
		);
		assert!(
			pid_in_protected_subtree(3, &protected, &parents),
			"a child collected through the protected node must be excluded too",
		);
		assert!(
			!pid_in_protected_subtree(4, &protected, &parents),
			"a real child of the sweep root must still be signalled",
		);
		assert!(
			!pid_in_protected_subtree(1, &protected, &parents),
			"the sweep root must not be pruned",
		);
	}

	/// `kill_process_group` is the last line of defense: even if a future
	/// caller manages to feed the harness's own pgid into the signal path,
	/// this wrapper must refuse to deliver the signal.
	#[cfg(unix)]
	#[test]
	fn kill_process_group_refuses_self_pgroup() {
		// SAFETY: `getpgid(0)` queries the calling process and does not touch
		// caller-owned memory.
		let self_pgid = unsafe { libc::getpgid(0) };
		assert!(self_pgid > 0, "getpgid(0) failed");
		assert!(
			!kill_process_group(self_pgid, TERM_SIGNAL),
			"kill_process_group must refuse the harness pgid; otherwise the test process would have \
			 been SIGTERMed",
		);
		assert!(
			!kill_process_group(0, TERM_SIGNAL),
			"kill_process_group must reject non-positive pgids",
		);
	}

	/// Regression test for the macOS `proc_listchildpids` brokenness: on
	/// darwin 25.4+ the kernel returns no entries when a process queries its
	/// own children via that API, so `Process::descendants` produced an empty
	/// list and termination cleanup silently became a no-op. The replacement
	/// path scans `proc_listallpids` and groups by `pbi_ppid`, which actually
	/// works. Linux has always worked via `/proc`.
	#[cfg(unix)]
	#[test]
	fn descendants_includes_freshly_spawned_child() {
		use std::{process::Command, thread, time::Duration};

		let mut child = Command::new("sleep")
			.arg("10")
			.spawn()
			.expect("spawn sleep");
		let child_pid = i32::try_from(child.id()).expect("child pid fits in i32");

		let self_pid = i32::try_from(std::process::id()).expect("self pid fits in i32");
		let harness = Process::from_pid(self_pid).expect("harness Process ref");

		// Allow a few polling iterations so the kernel's process-table query
		// settles on a loaded host. proc_listallpids reflects newly forked pids
		// within milliseconds in practice; 1s is a comfortable upper bound.
		let mut found = false;
		for _ in 0..40 {
			if harness
				.live_descendants()
				.iter()
				.any(|descendant| descendant.pid() == child_pid)
			{
				found = true;
				break;
			}
			thread::sleep(Duration::from_millis(25));
		}

		let _ = child.kill();
		let _ = child.wait();

		assert!(
			found,
			"freshly spawned child pid {child_pid} must appear in `live_descendants` so the \
			 cancellation cleanup can reach it; this regressed on macOS when the walk relied on the \
			 broken `proc_listchildpids`",
		);
	}

	/// Regression test for issue #4605: `SpawnRegistry` MUST pin a stable
	/// [`Process`] reference at spawn time rather than defer re-opening the
	/// pid until termination.
	///
	/// Before the fix, `SpawnRegistry` stored only the raw pid; `build_targets`
	/// called `Process::from_pid` at cancellation time. Pids recycle
	/// aggressively on busy systems, so an exited child's pid could be
	/// reassigned to an unrelated process; `Process::from_pid` at cancel time
	/// would happily open that unrelated process, and `signal_tree` would then
	/// signal its entire foreign subtree.
	///
	/// A cross-platform Rust test cannot literally trigger pid recycling, but it
	/// can prove the observable defense: a recorded process reference survives
	/// the original pid's death (so no "look it up again" step exists to be
	/// raced), and the registry never consults `Process::from_pid` when a handle
	/// was pinned at record time.
	#[cfg(unix)]
	#[test]
	fn spawn_registry_pins_identity_at_record_time() {
		use std::{process::Command, thread, time::Duration};

		// Phase 1: while the child is alive, the pinned handle carries identity
		// forward into `build_targets` without any `Process::from_pid` re-open
		// step existing to be raced against pid reuse.
		let mut long = Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn sleep");
		let long_pid = i32::try_from(long.id()).expect("child pid fits in i32");

		let registry = SpawnRegistry::new();
		let pinned = Process::from_pid(long_pid).expect("pin child at record time");
		registry.record(None, Some(pinned));

		let live_targets = registry.build_targets();
		assert!(
			!live_targets.is_empty(),
			"a still-live pinned child must appear in the target set — otherwise the cancellation \
			 cleanup would silently miss it"
		);
		let live_pids: Vec<i32> = live_targets.processes.iter().map(Process::pid).collect();
		assert_eq!(
			live_pids,
			vec![long_pid],
			"target set must come from the pinned handle recorded at spawn time, not a re-lookup by \
			 pid (which would race pid reuse — issue #4605)"
		);

		let _ = long.kill();
		let _ = long.wait();

		// Phase 2: once the child exits, the registry MUST drop the entry
		// rather than reintroduce a `Process::from_pid` re-open at kill time.
		// Poll until pruning sees the pidfd as Exited (kernel-visible within
		// milliseconds in practice).
		let mut empty_after_exit = false;
		for _ in 0..40 {
			if registry.build_targets().is_empty() {
				empty_after_exit = true;
				break;
			}
			thread::sleep(Duration::from_millis(25));
		}
		assert!(
			empty_after_exit,
			"once the pinned child exits the registry must drop it — re-opening by pid at \
			 termination time is exactly the pid-reuse race #4605 closes"
		);
	}

	/// `TerminationTargets::add_process` must accept a pre-pinned handle
	/// without going through `Process::from_pid`. This is the API contract
	/// `SpawnRegistry` relies on to avoid the PID-reuse race.
	#[cfg(unix)]
	#[test]
	fn add_process_bypasses_from_pid_lookup() {
		let self_pid = i32::try_from(std::process::id()).expect("self pid fits in i32");
		let pinned = Process::from_pid(self_pid).expect("pin self");

		let mut targets = TerminationTargets::new();
		targets.add_process(pinned.clone());
		assert!(!targets.is_empty(), "add_process must record the pinned handle");

		// Adding the same pid again through either entry point must dedupe:
		// otherwise every wave in `terminate_run` would re-signal the same
		// tree N times.
		targets.add_process(pinned);
		targets.add_pid(self_pid);
		assert_eq!(targets.processes.len(), 1, "duplicate pids must be deduped");
	}

	/// Regression test for the review on PR #4606: a long-running shell
	/// command that spawns many short-lived external processes must not
	/// retain one owned handle per historical spawn — that would exhaust
	/// per-process FD/handle limits (pidfd on Linux, `HANDLE` on Windows).
	/// The registry MUST prune dead entries once the recorded vec crosses
	/// the sweep threshold.
	#[cfg(unix)]
	#[test]
	fn spawn_registry_prunes_exited_entries() {
		use std::{thread, time::Duration};

		let registry = SpawnRegistry::new();

		// Fabricate many recorded-then-exited children by pinning ourselves,
		// pushing the entry, then immediately treating it as "dead" from the
		// registry's perspective. To simulate the exit without actually
		// killing the harness, use `Process::from_pid(1)` for a pid that
		// (on Linux) is init and never exits — but wrap the recording in a
		// pattern that guarantees `status()` returns Exited for the pruner:
		// spawn a tiny child, pin it, wait for exit, then record.
		for _ in 0..(SpawnRegistry::PRUNE_THRESHOLD * 2) {
			let mut child = std::process::Command::new("true")
				.spawn()
				.expect("spawn true");
			let pid = i32::try_from(child.id()).expect("child pid fits in i32");
			let pinned = Process::from_pid(pid);
			let _ = child.wait();
			// Give the kernel a moment to mark the pidfd readable so `status()`
			// reports Exited when the pruner probes.
			for _ in 0..20 {
				if pinned
					.as_ref()
					.is_some_and(|process| process.status() == ProcessStatus::Exited)
				{
					break;
				}
				thread::sleep(Duration::from_millis(5));
			}
			registry.record(None, pinned);
		}

		let retained = registry.state.lock().spawned.len();
		assert!(
			retained < SpawnRegistry::PRUNE_THRESHOLD,
			"pruning must bound retained entries below the sweep threshold once the pinned processes \
			 have exited; got {retained} retained (threshold {})",
			SpawnRegistry::PRUNE_THRESHOLD
		);

		// build_targets sees no live handles → empty target set, matching the
		// contract that fully-exited registries stop the wave loop early.
		let targets = registry.build_targets();
		assert!(targets.is_empty(), "registry of only-dead entries must produce an empty target set");
	}

	/// Regression test for the third review on PR #4606: once the recorded
	/// vec crosses `PRUNE_THRESHOLD`, subsequent `record` calls must NOT
	/// sweep on every spawn. Without the `next_sweep_at` watermark, a large
	/// fan-out run whose live children exceed the threshold turned every
	/// spawn into an O(N) status probe of the whole retained set.
	///
	/// The check reasons about the observable side effect: after N records
	/// past threshold with entries that CANNOT be pruned (all still live),
	/// the retained size grows monotonically by exactly N — no sweep runs
	/// have modified the vec in between. The direct signal of "did a sweep
	/// happen" is a stable pinned handle count across records.
	#[cfg(unix)]
	#[test]
	fn spawn_registry_watermark_bounds_sweep_frequency() {
		let self_pid = i32::try_from(std::process::id()).expect("self pid fits in i32");
		let registry = SpawnRegistry::new();

		// Fill past threshold with entries that are permanently alive
		// (pinning ourselves) so the pruner has nothing to remove.
		let fill = SpawnRegistry::PRUNE_THRESHOLD + 10;
		for _ in 0..fill {
			registry.record(None, Process::from_pid(self_pid));
		}
		let after_fill = registry.state.lock().spawned.len();
		assert_eq!(after_fill, fill, "live-only entries must not be pruned during warm-up");
		let watermark_after_fill = registry.state.lock().next_sweep_at;

		// Every additional record with a live entry must land in the vec
		// verbatim and — critically — NOT re-enter `prune_exited` until the
		// vec crosses the freshly scheduled watermark. If the guard were
		// still `len >= PRUNE_THRESHOLD` (pre-fix), a sweep would fire on
		// every one of these records.
		let extra = 20;
		for _ in 0..extra {
			registry.record(None, Process::from_pid(self_pid));
		}
		let after_extra = registry.state.lock().spawned.len();
		assert_eq!(
			after_extra,
			after_fill + extra,
			"records with live entries must accumulate without triggering per-spawn sweeps"
		);
		assert_eq!(
			registry.state.lock().next_sweep_at,
			watermark_after_fill,
			"watermark must not advance while the vec stays below it — otherwise a sweep ran"
		);
	}
}
