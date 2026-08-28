use std::{
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicUsize, Ordering},
	},
	thread::JoinHandle,
	time::{Duration, Instant},
};

use napi::{Error, JsString, Result};
use napi_derive::napi;
use parking_lot::{Condvar, Mutex};

use crate::js;

struct Inner {
	back: Mutex<Vec<u8>>,

	pending: AtomicUsize,

	cv:   Condvar,
	stop: AtomicBool,
	dead: AtomicBool,
}

#[cfg(unix)]
fn write_all(fd: i32, buf: &[u8]) -> std::io::Result<()> {
	let mut off = 0usize;
	while off < buf.len() {
		let rc = unsafe { libc::write(fd, buf[off..].as_ptr().cast(), buf.len() - off) };
		if rc < 0 {
			let err = std::io::Error::last_os_error();
			if err.kind() == std::io::ErrorKind::Interrupted {
				continue;
			}
			return Err(err);
		}
		off += rc as usize;
	}
	Ok(())
}

#[cfg(unix)]
fn pump_loop(fd: i32, inner: &Inner) {
	let mut front: Vec<u8> = Vec::new();
	loop {
		{
			let mut back = inner.back.lock();
			while back.is_empty() {
				if inner.stop.load(Ordering::Acquire) {
					return;
				}
				inner.cv.wait(&mut back);
			}
			std::mem::swap(&mut *back, &mut front);
		}
		let result = if inner.dead.load(Ordering::Acquire) {
			Ok(())
		} else {
			write_all(fd, &front)
		};
		if result.is_err() {
			inner.dead.store(true, Ordering::Release);

			let mut back = inner.back.lock();
			let dropped = back.len();
			back.clear();
			inner
				.pending
				.fetch_sub(dropped + front.len(), Ordering::AcqRel);
		} else {
			inner.pending.fetch_sub(front.len(), Ordering::AcqRel);
		}
		front.clear();

		inner.cv.notify_all();
	}
}

#[napi]
pub struct TtyWriter {
	inner:  Arc<Inner>,
	thread: Option<JoinHandle<()>>,
	#[cfg(unix)]
	fd:     i32,
}

#[napi]
impl TtyWriter {
	#[napi(constructor)]
	pub fn new(fd: i32) -> Result<Self> {
		#[cfg(unix)]
		{
			let owned = unsafe { libc::dup(fd) };
			if owned < 0 {
				return Err(Error::from_reason(format!(
					"dup({fd}) failed: {}",
					std::io::Error::last_os_error()
				)));
			}
			let inner = Arc::new(Inner {
				back:    Mutex::new(Vec::new()),
				pending: AtomicUsize::new(0),
				cv:      Condvar::new(),
				stop:    AtomicBool::new(false),
				dead:    AtomicBool::new(false),
			});
			let thread_inner = Arc::clone(&inner);
			let thread = std::thread::Builder::new()
				.name("tty-writer".into())
				.spawn(move || pump_loop(owned, &thread_inner))
				.map_err(|err| Error::from_reason(format!("tty writer thread spawn failed: {err}")))?;
			Ok(Self { inner, thread: Some(thread), fd: owned })
		}
		#[cfg(not(unix))]
		{
			let _ = fd;
			Err(Error::from_reason("TtyWriter is unix-only"))
		}
	}

	#[napi]
	pub fn write(&self, data: JsString) -> Result<u32> {
		if self.inner.dead.load(Ordering::Acquire) {
			return Ok(self.pending());
		}
		let units = js::utf16(data)?;
		if units.is_empty() {
			return Ok(self.pending());
		}
		Ok(self.append(|back| {
			let start = back.len();
			back.resize(start + xutf::transcoded_len::<xutf::Utf16, xutf::Utf8>(&units), 0);
			let (_, written) = xutf::transcode_into::<xutf::Utf16, xutf::Utf8>(
				&units,
				&mut back[start..],
				xutf::AsciiCase::Preserve,
			);
			back.truncate(start + written);
			written
		}))
	}

	fn append(&self, fill: impl FnOnce(&mut Vec<u8>) -> usize) -> u32 {
		let added = {
			let mut back = self.inner.back.lock();
			fill(&mut back)
		};
		self.inner.pending.fetch_add(added, Ordering::AcqRel);
		self.inner.cv.notify_all();
		self.pending()
	}

	#[napi]
	pub fn pending(&self) -> u32 {
		self
			.inner
			.pending
			.load(Ordering::Acquire)
			.min(u32::MAX as usize) as u32
	}

	#[napi(getter)]
	pub fn dead(&self) -> bool {
		self.inner.dead.load(Ordering::Acquire)
	}

	#[napi]
	pub fn flush_sync(&self, timeout_ms: u32) -> bool {
		let deadline = Instant::now() + Duration::from_millis(u64::from(timeout_ms));
		let mut back = self.inner.back.lock();
		while self.inner.pending.load(Ordering::Acquire) > 0
			&& !self.inner.dead.load(Ordering::Acquire)
		{
			let now = Instant::now();
			if now >= deadline {
				return false;
			}
			self.inner.cv.wait_for(&mut back, deadline - now);
		}
		drop(back);
		self.inner.pending.load(Ordering::Acquire) == 0
	}

	#[napi]
	pub fn stop(&mut self, flush_timeout_ms: u32) {
		let Some(thread) = self.thread.take() else {
			return;
		};
		let drained = self.flush_sync(flush_timeout_ms);
		self.inner.stop.store(true, Ordering::Release);
		self.inner.cv.notify_all();
		if !drained && !self.inner.dead.load(Ordering::Acquire) {
			return;
		}
		let _ = thread.join();
		#[cfg(unix)]
		{
			unsafe { libc::close(self.fd) };
			self.fd = -1;
		}
	}
}

impl Drop for TtyWriter {
	fn drop(&mut self) {
		self.stop(0);
	}
}
