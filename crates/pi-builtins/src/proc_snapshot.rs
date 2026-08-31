


#![allow(dead_code, reason = "consumed by the feature-gated process builtins")]


#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessStatus {

	Running,

	Exited,
}


pub(crate) fn sanitize_process_command(command: String) -> String {
	command
		.chars()
		.map(|character| {
			if character.is_control() {
				' '
			} else {
				character
			}
		})
		.collect()
}

#[cfg(target_os = "linux")]
mod proc_snapshot {
	use std::{
		fs,
		os::fd::{AsRawFd, FromRawFd, OwnedFd},
		time::Duration,
	};

	use super::ProcessStatus;

	#[derive(Clone)]
	pub struct ProcInfo {
		pid:  i32,
		stat: Stat,
		args: Vec<String>,
		uid:  Option<(u32, u32)>,
		gid:  Option<(u32, u32)>,
	}

	#[derive(Clone)]
	struct Stat {
		comm:       String,
		state:      char,
		ppid:       i32,
		pgrp:       i32,
		session:    i32,
		tty:        i64,
		tpgid:      i32,
		flags:      u64,
		minflt:     u64,
		majflt:     u64,
		utime:      u64,
		stime:      u64,
		priority:   i32,
		nice:       i32,
		threads:    u32,
		start_time: u64,
		virtual_:   u64,
		rss_pages:  i64,
	}

	#[allow(
		clippy::unnecessary_wraps,
		reason = "Option returns match the cross-platform ProcInfo contract"
	)]
	impl ProcInfo {
		pub fn all() -> Vec<Self> {
			let Ok(entries) = fs::read_dir("/proc") else {
				return Vec::new();
			};
			let mut result = Vec::new();
			for entry in entries.flatten() {
				let Some(pid) = entry
					.file_name()
					.to_str()
					.and_then(|name| name.parse::<i32>().ok())
				else {
					continue;
				};
				if let Some(process) = Self::from_pid(pid) {
					result.push(process);
				}
			}
			result
		}

		fn from_pid(pid: i32) -> Option<Self> {
			if pid <= 0 {
				return None;
			}
			let stat = read_stat(pid)?;
			let args = fs::read(format!("/proc/{pid}/cmdline"))
				.ok()
				.map(|bytes| {
					bytes
						.split(|byte| *byte == 0)
						.filter(|part| !part.is_empty())
						.map(|part| String::from_utf8_lossy(part).into_owned())
						.collect()
				})
				.unwrap_or_default();
			let uid = status_ids(pid, "Uid:").map(|ids| (ids.0, ids.1));
			let gid = status_ids(pid, "Gid:");
			(read_stat(pid)?.start_time == stat.start_time).then_some(Self {
				pid,
				stat,
				args,
				uid,
				gid,
			})
		}

		pub const fn pid(&self) -> i32 {
			self.pid
		}

		pub const fn ppid(&self) -> Option<i32> {
			Some(self.stat.ppid)
		}

		pub fn args(&self) -> Vec<String> {
			self.args.clone()
		}

		pub const fn group_id(&self) -> Option<i32> {
			Some(self.stat.pgrp)
		}

		pub const fn session_id(&self) -> Option<i32> {
			Some(self.stat.session)
		}

		pub fn real_user_id(&self) -> Option<u32> {
			self.uid.map(|ids| ids.0)
		}

		pub fn effective_user_id(&self) -> Option<u32> {
			self.uid.map(|ids| ids.1)
		}

		pub fn real_group_id(&self) -> Option<u32> {
			self.gid.map(|ids| ids.0)
		}

		pub fn effective_group_id(&self) -> Option<u32> {
			self.gid.map(|ids| ids.1)
		}

		pub fn terminal_id(&self) -> Option<u64> {
			(self.stat.tty != 0).then_some(self.stat.tty as u32 as u64)
		}

		pub fn terminal_group_id(&self) -> Option<i32> {
			(self.stat.tpgid > 0).then_some(self.stat.tpgid)
		}

		pub const fn priority(&self) -> Option<i32> {
			Some(self.stat.priority)
		}

		pub const fn flags(&self) -> Option<u64> {
			Some(self.stat.flags)
		}

		pub const fn minor_faults(&self) -> Option<u64> {
			Some(self.stat.minflt)
		}

		pub const fn major_faults(&self) -> Option<u64> {
			Some(self.stat.majflt)
		}

		pub fn wchan(&self) -> Option<String> {
			let value = fs::read_to_string(format!("/proc/{}/wchan", self.pid)).ok()?;
			let value = value.trim();
			(!value.is_empty() && value != "0" && value != "-").then(|| value.to_string())
		}

		pub const fn state(&self) -> char {
			self.stat.state
		}

		pub const fn start_time(&self) -> u64 {
			self.stat.start_time
		}

		pub fn age(&self) -> Option<Duration> {
			let uptime = fs::read_to_string("/proc/uptime")
				.ok()?
				.split_whitespace()
				.next()?
				.parse::<f64>()
				.ok()?;
			let ticks = clock_ticks()? as f64;
			Some(Duration::from_secs_f64((uptime - self.stat.start_time as f64 / ticks).max(0.0)))
		}

		pub fn match_name(&self) -> String {
			self.stat.comm.clone()
		}

		pub fn command_name(&self) -> String {
			self.stat.comm.clone()
		}

		pub fn status(&self) -> ProcessStatus {
			match read_stat(self.pid) {
				Some(stat) if stat.start_time == self.stat.start_time && stat.state != 'Z' => {
					ProcessStatus::Running
				},
				_ => ProcessStatus::Exited,
			}
		}

		pub fn signal(&self, signal: i32, queue: Option<i32>) -> bool {
			if signal == 0 {
				return read_stat(self.pid).is_some_and(|stat| stat.start_time == self.stat.start_time);
			}
			let Some(pidfd) = open_pidfd(self.pid) else {
				return false;
			};
			if read_stat(self.pid).is_none_or(|stat| stat.start_time != self.stat.start_time) {
				return false;
			}
			if let Some(value) = queue {
				let mut value_arg = libc::sigval { sival_ptr: std::ptr::null_mut() };


				unsafe {
					(&raw mut value_arg).cast::<i32>().write(value);
					return libc::sigqueue(self.pid, signal, value_arg) == 0;
				}
			}

			unsafe {
				libc::syscall(
					libc::SYS_pidfd_send_signal,
					pidfd.as_raw_fd(),
					signal,
					std::ptr::null::<libc::siginfo_t>(),
					0,
				) == 0
			}
		}

		pub fn cpu_time(&self) -> Option<Duration> {
			let ticks = clock_ticks()?;
			Some(Duration::from_secs_f64((self.stat.utime + self.stat.stime) as f64 / ticks as f64))
		}

		pub fn resident_bytes(&self) -> Option<u64> {
			let pages = u64::try_from(self.stat.rss_pages).ok()?;
			Some(pages.saturating_mul(page_size()?))
		}

		pub const fn virtual_bytes(&self) -> Option<u64> {
			Some(self.stat.virtual_)
		}

		pub const fn thread_count(&self) -> Option<u32> {
			Some(self.stat.threads)
		}

		pub const fn nice(&self) -> Option<i32> {
			Some(self.stat.nice)
		}
	}

	fn open_pidfd(pid: i32) -> Option<OwnedFd> {

		let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) } as i32;
		(fd >= 0).then(|| {

			unsafe { OwnedFd::from_raw_fd(fd) }
		})
	}

	fn read_stat(pid: i32) -> Option<Stat> {
		let content = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
		let open = content.find('(')?;
		let close = content.rfind(')')?;
		let comm = content[open + 1..close].to_string();
		let fields: Vec<&str> = content[close + 1..].split_whitespace().collect();
		Some(Stat {
			comm,
			state: fields.first()?.chars().next()?,
			ppid: fields.get(1)?.parse().ok()?,
			pgrp: fields.get(2)?.parse().ok()?,
			session: fields.get(3)?.parse().ok()?,
			tty: fields.get(4)?.parse().ok()?,
			tpgid: fields.get(5)?.parse().ok()?,
			flags: fields.get(6)?.parse().ok()?,
			minflt: fields.get(7)?.parse().ok()?,
			majflt: fields.get(9)?.parse().ok()?,
			utime: fields.get(11)?.parse().ok()?,
			stime: fields.get(12)?.parse().ok()?,
			priority: fields.get(15)?.parse().ok()?,
			nice: fields.get(16)?.parse().ok()?,
			threads: fields.get(17)?.parse().ok()?,
			start_time: fields.get(19)?.parse().ok()?,
			virtual_: fields.get(20)?.parse().ok()?,
			rss_pages: fields.get(21)?.parse().ok()?,
		})
	}

	fn status_ids(pid: i32, prefix: &str) -> Option<(u32, u32)> {
		let content = fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
		let mut ids = content
			.lines()
			.find(|line| line.starts_with(prefix))?
			.split_whitespace()
			.skip(1)
			.filter_map(|value| value.parse().ok());
		Some((ids.next()?, ids.next()?))
	}

	fn clock_ticks() -> Option<u64> {

		u64::try_from(unsafe { libc::sysconf(libc::_SC_CLK_TCK) })
			.ok()
			.filter(|v| *v > 0)
	}
	fn page_size() -> Option<u64> {

		u64::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) })
			.ok()
			.filter(|v| *v > 0)
	}
}
#[cfg(target_os = "macos")]
mod proc_snapshot {
	use std::{
		ffi::CStr,
		mem::size_of,
		path::Path,
		ptr,
		time::{Duration, SystemTime, UNIX_EPOCH},
	};

	use super::ProcessStatus;

	const KERN_PROCARGS2: libc::c_int = 49;

	#[link(name = "proc", kind = "dylib")]
	unsafe extern "C" {
		fn proc_listallpids(buffer: *mut i32, buffersize: i32) -> i32;
	}

	#[derive(Clone)]
	pub struct ProcInfo {
		pid:  i32,
		info: libc::proc_bsdinfo,
		task: Option<libc::proc_taskinfo>,
		args: Vec<String>,
	}

	#[allow(
		clippy::unnecessary_wraps,
		reason = "Option returns match the cross-platform ProcInfo contract"
	)]
	impl ProcInfo {
		pub fn all() -> Vec<Self> {

			let reported = unsafe { proc_listallpids(ptr::null_mut(), 0) };
			if reported <= 0 {
				return Vec::new();
			}
			let count = (reported as usize).saturating_mul(2).max(2048);
			let mut pids = vec![0i32; count];

			let actual =
				unsafe { proc_listallpids(pids.as_mut_ptr(), (pids.len() * size_of::<i32>()) as i32) };
			if actual <= 0 {
				return Vec::new();
			}
			pids.truncate((actual as usize).min(pids.len()));
			pids.into_iter().filter_map(Self::from_pid).collect()
		}

		fn from_pid(pid: i32) -> Option<Self> {
			let info = read_bsdinfo(pid)?;
			Some(Self { pid, info, task: read_taskinfo(pid), args: process_args(pid) })
		}

		fn live_info(&self) -> Option<libc::proc_bsdinfo> {
			let info = read_bsdinfo(self.pid())?;
			(info.pbi_start_tvsec == self.info.pbi_start_tvsec
				&& info.pbi_start_tvusec == self.info.pbi_start_tvusec)
				.then_some(info)
		}

		pub const fn pid(&self) -> i32 {
			self.pid
		}

		pub fn ppid(&self) -> Option<i32> {
			i32::try_from(self.info.pbi_ppid).ok()
		}

		pub fn args(&self) -> Vec<String> {
			self.args.clone()
		}

		pub fn group_id(&self) -> Option<i32> {
			i32::try_from(self.info.pbi_pgid).ok()
		}

		pub fn session_id(&self) -> Option<i32> {

			let sid = unsafe { libc::getsid(self.pid()) };
			(sid >= 0).then_some(sid)
		}

		pub const fn real_user_id(&self) -> Option<u32> {
			Some(self.info.pbi_ruid)
		}

		pub const fn effective_user_id(&self) -> Option<u32> {
			Some(self.info.pbi_uid)
		}

		pub const fn real_group_id(&self) -> Option<u32> {
			Some(self.info.pbi_rgid)
		}

		pub fn terminal_id(&self) -> Option<u64> {
			(!matches!(self.info.e_tdev, 0 | u32::MAX)).then_some(self.info.e_tdev as u64)
		}

		pub fn terminal_group_id(&self) -> Option<i32> {
			i32::try_from(self.info.e_tpgid)
				.ok()
				.filter(|tpgid| *tpgid > 0)
		}

		pub const fn effective_group_id(&self) -> Option<u32> {
			Some(self.info.pbi_gid)
		}

		pub fn priority(&self) -> Option<i32> {
			Some(self.task.as_ref()?.pti_priority)
		}

		pub const fn flags(&self) -> Option<u64> {
			Some(self.info.pbi_flags as u64)
		}

		pub fn minor_faults(&self) -> Option<u64> {
			u64::try_from(self.task.as_ref()?.pti_faults).ok()
		}

		pub fn major_faults(&self) -> Option<u64> {
			u64::try_from(self.task.as_ref()?.pti_pageins).ok()
		}

		#[allow(clippy::unused_self, reason = "matches the cross-platform ProcInfo contract")]
		pub const fn wchan(&self) -> Option<String> {
			None
		}

		pub const fn state(&self) -> char {
			match self.info.pbi_status {
				1 => 'I',
				2 => 'R',
				3 => 'S',
				4 => 'T',
				5 => 'Z',
				_ => '?',
			}
		}

		pub const fn start_time(&self) -> u64 {
			self
				.info
				.pbi_start_tvsec
				.saturating_mul(1_000_000)
				.saturating_add(self.info.pbi_start_tvusec)
		}

		pub fn age(&self) -> Option<Duration> {
			let start = UNIX_EPOCH
				+ Duration::from_secs(self.info.pbi_start_tvsec)
				+ Duration::from_micros(self.info.pbi_start_tvusec);
			SystemTime::now().duration_since(start).ok()
		}

		pub fn match_name(&self) -> String {
			self
				.args
				.first()
				.and_then(|arg| Path::new(arg).file_name())
				.map(|name| name.to_string_lossy().into_owned())
				.filter(|name| !name.is_empty())
				.unwrap_or_else(|| self.command_name())
		}

		pub fn command_name(&self) -> String {

			unsafe { CStr::from_ptr(self.info.pbi_comm.as_ptr()) }
				.to_string_lossy()
				.into_owned()
		}

		pub fn status(&self) -> ProcessStatus {
			match self.live_info() {
				Some(info) if info.pbi_status != 5 => ProcessStatus::Running,
				_ => ProcessStatus::Exited,
			}
		}

		pub fn signal(&self, signal: i32, _queue: Option<i32>) -> bool {
			if self.live_info().is_none() {
				return false;
			}

			unsafe { libc::kill(self.pid(), signal) == 0 }
		}

		pub fn cpu_time(&self) -> Option<Duration> {
			let task = self.task.as_ref()?;
			Some(Duration::from_nanos(task.pti_total_user.saturating_add(task.pti_total_system)))
		}

		pub fn resident_bytes(&self) -> Option<u64> {
			Some(self.task.as_ref()?.pti_resident_size)
		}

		pub fn virtual_bytes(&self) -> Option<u64> {
			Some(self.task.as_ref()?.pti_virtual_size)
		}

		pub fn thread_count(&self) -> Option<u32> {
			u32::try_from(self.task.as_ref()?.pti_threadnum).ok()
		}

		pub const fn nice(&self) -> Option<i32> {
			Some(self.info.pbi_nice)
		}
	}

	fn read_bsdinfo(pid: i32) -> Option<libc::proc_bsdinfo> {
		if pid <= 0 {
			return None;
		}

		let mut info = unsafe { std::mem::zeroed::<libc::proc_bsdinfo>() };

		let actual = unsafe {
			libc::proc_pidinfo(
				pid,
				libc::PROC_PIDTBSDINFO,
				0,
				(&raw mut info).cast(),
				size_of::<libc::proc_bsdinfo>() as i32,
			)
		};
		(actual >= size_of::<libc::proc_bsdinfo>() as i32).then_some(info)
	}

	fn read_taskinfo(pid: i32) -> Option<libc::proc_taskinfo> {

		let mut info = unsafe { std::mem::zeroed::<libc::proc_taskinfo>() };

		let actual = unsafe {
			libc::proc_pidinfo(
				pid,
				libc::PROC_PIDTASKINFO,
				0,
				(&raw mut info).cast(),
				size_of::<libc::proc_taskinfo>() as i32,
			)
		};
		(actual >= size_of::<libc::proc_taskinfo>() as i32).then_some(info)
	}

	fn process_args(pid: i32) -> Vec<String> {
		let mut mib = [libc::CTL_KERN, KERN_PROCARGS2, pid];
		let mut size = 0usize;

		if unsafe {
			libc::sysctl(mib.as_mut_ptr(), 3, ptr::null_mut(), &raw mut size, ptr::null_mut(), 0)
		} != 0 || size <= size_of::<libc::c_int>()
		{
			return Vec::new();
		}
		let mut buffer = vec![0u8; size];

		if unsafe {
			libc::sysctl(
				mib.as_mut_ptr(),
				3,
				buffer.as_mut_ptr().cast(),
				&raw mut size,
				ptr::null_mut(),
				0,
			)
		} != 0
		{
			return Vec::new();
		}
		buffer.truncate(size);
		let argc_size = size_of::<libc::c_int>();
		let Some(argc_bytes) = buffer.get(..argc_size) else {
			return Vec::new();
		};
		let Ok(argc_bytes) = <[u8; 4]>::try_from(argc_bytes) else {
			return Vec::new();
		};
		let argc = i32::from_ne_bytes(argc_bytes);
		let mut offset = argc_size;
		while offset < buffer.len() && buffer[offset] != 0 {
			offset += 1;
		}
		while offset < buffer.len() && buffer[offset] == 0 {
			offset += 1;
		}
		let mut args = Vec::new();
		while offset < buffer.len() && args.len() < argc.max(0) as usize {
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

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub use proc_snapshot::ProcInfo;


#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) struct HostProcesses {

	pub pids:  smallvec::SmallVec<[i32; 16]>,

	pub pgids: smallvec::SmallVec<[i32; 16]>,
}


#[cfg(any(target_os = "linux", target_os = "macos"))]
#[derive(Clone, Copy)]
struct ChainNode {
	ppid:  Option<i32>,
	pgid:  Option<i32>,


	start: u64,
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
impl HostProcesses {


	pub fn resolve() -> Self {
		Self::resolve_in(&ProcInfo::all())
	}


	pub fn resolve_in(all: &[ProcInfo]) -> Self {
		let Ok(self_pid) = i32::try_from(std::process::id()) else {
			return Self { pids: smallvec::SmallVec::new(), pgids: smallvec::SmallVec::new() };
		};
		Self::walk(self_pid, |pid| {
			all
				.iter()
				.find(|process| process.pid() == pid)
				.map(|process| ChainNode {
					ppid:  process.ppid(),
					pgid:  process.group_id(),
					start: process.start_time(),
				})
		})
	}


	fn walk(self_pid: i32, lookup: impl Fn(i32) -> Option<ChainNode>) -> Self {
		let mut pids = smallvec::SmallVec::new();
		let mut pgids = smallvec::SmallVec::new();


		pids.push(self_pid);
		let mut node = lookup(self_pid);
		while let Some(current) = node {
			if let Some(pgid) = current.pgid
				&& !pgids.contains(&pgid)
			{
				pgids.push(pgid);
			}
			let Some(parent) = current.ppid else {
				break;
			};


			if parent == 0 || pids.contains(&parent) {
				break;
			}
			let Some(found) = lookup(parent) else {
				break;
			};
			if found.start > current.start {
				break;
			}
			pids.push(parent);
			node = Some(found);
		}
		Self { pids, pgids }
	}
}

