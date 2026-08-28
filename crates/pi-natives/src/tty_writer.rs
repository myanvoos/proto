//! Off-thread terminal output pump.
//!
//! `write(2)` to a TTY/PTY from the JS thread blocks the whole event loop
//! until the terminal drains: a slow, busy, or occluded terminal emulator
//! freezes the TUI for the duration of the frame (multi-MB full repaints can
//! stall for minutes). Bun's `process.stdout.write` performs exactly that
//! blocking write, and `fcntl(F_SETFL, O_NONBLOCK)` cannot be issued through
//! `bun:ffi` (variadic ABI), so the blocking write moves to a dedicated OS
//! thread instead:
//!
//! - JS enqueues frames via [`TtyWriter::write`] — never blocks. The JS string
//!   is read as UTF-16 through the scratch arena and transcoded with `xutf`
//!   straight into the shared back buffer — no per-call heap allocation once
//!   the buffers are warm.
//! - The pump thread swaps the back buffer out and performs the blocking write,
//!   preserving FIFO order.
//! - JS polls [`TtyWriter::pending`] for backpressure-aware frame skipping.
//!
//! A write error on the pump thread (dead PTY) marks the writer
//! [`TtyWriter::dead`] and drops all queued output; the JS side maps that to
//! its terminal-disconnected teardown.

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
	/// Bytes accepted from JS but not yet claimed by the pump thread. The
	/// pump swaps this out wholesale, so enqueue cost is an in-place append
	/// and chunks coalesce into one `write(2)` per drain cycle.
	back:    Mutex<Vec<u8>>,
	/// Bytes accepted but not yet written to the fd.
	pending: AtomicUsize,
	/// Signals the pump thread on enqueue/stop, and waiters on drain.
	cv:      Condvar,
	stop:    AtomicBool,
	dead:    AtomicBool,
}

#[cfg(unix)]
fn write_all(fd: i32, buf: &[u8]) -> std::io::Result<()> {
	let mut off = 0usize;
	while off < buf.len() {
		// SAFETY: `buf[off..]` is a valid initialized slice; `fd` is owned by
		// the writer (dup'd at construction) and stays open until drop.
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
			// Dead fd: drain-drop so enqueuers observing `pending` never wedge.
			Ok(())
		} else {
			write_all(fd, &front)
		};
		if result.is_err() {
			inner.dead.store(true, Ordering::Release);
			// Queued output can never be delivered; account it as gone.
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
		// Wake `flushSync` waiters parked on the same condvar.
		inner.cv.notify_all();
	}
}

/// Dedicated writer thread for one terminal fd.
///
/// Constructed by the TUI's `ProcessTerminal` around stdout. The fd is
/// `dup(2)`'d at construction and closed on drop, so later manipulation of the
/// original descriptor does not affect the pump.
#[napi]
pub struct TtyWriter {
	inner:  Arc<Inner>,
	thread: Option<JoinHandle<()>>,
	#[cfg(unix)]
	fd:     i32,
}

#[napi]
impl TtyWriter {
	/// Start a pump thread for `fd` (typically 1). Fails on non-Unix hosts and
	/// when the descriptor cannot be duplicated.
	#[napi(constructor)]
	pub fn new(fd: i32) -> Result<Self> {
		#[cfg(unix)]
		{
			// SAFETY: dup on a caller-provided fd; a negative result is handled.
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

	/// Enqueue terminal output; never blocks. Returns the total bytes now
	/// pending (including this chunk).
	///
	/// Reads the JS string as UTF-16 through the thread's scratch arena and
	/// transcodes it with `xutf` straight into the shared back buffer, so a
	/// warm writer costs no per-call heap allocation.
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

	/// Append into the back buffer under its lock, account the added bytes,
	/// and wake the pump. `fill` returns the byte count it appended.
	fn append(&self, fill: impl FnOnce(&mut Vec<u8>) -> usize) -> u32 {
		let added = {
			let mut back = self.inner.back.lock();
			fill(&mut back)
		};
		self.inner.pending.fetch_add(added, Ordering::AcqRel);
		self.inner.cv.notify_all();
		self.pending()
	}

	/// Bytes accepted but not yet written to the terminal.
	#[napi]
	pub fn pending(&self) -> u32 {
		self
			.inner
			.pending
			.load(Ordering::Acquire)
			.min(u32::MAX as usize) as u32
	}

	/// True once a write failed (dead PTY); queued output has been dropped.
	#[napi(getter)]
	pub fn dead(&self) -> bool {
		self.inner.dead.load(Ordering::Acquire)
	}

	/// Block the calling thread until the queue drains, the writer dies, or
	/// `timeout_ms` elapses. Returns true when fully drained. Exit paths only.
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

	/// Flush (bounded by `flush_timeout_ms`), stop the pump thread, and join it.
	///
	/// A pump stuck in a blocked `write(2)` (stalled-but-alive PTY consumer)
	/// cannot be joined without freezing the caller: when the bounded flush
	/// times out the thread is detached instead and its dup'd fd is leaked —
	/// closing it under a blocked write would race kernel fd reuse.
	#[napi]
	pub fn stop(&mut self, flush_timeout_ms: u32) {
		let Some(thread) = self.thread.take() else {
			return;
		};
		let drained = self.flush_sync(flush_timeout_ms);
		self.inner.stop.store(true, Ordering::Release);
		self.inner.cv.notify_all();
		if !drained && !self.inner.dead.load(Ordering::Acquire) {
			// Likely mid-blocking-write; detach and leak the fd.
			return;
		}
		let _ = thread.join();
		#[cfg(unix)]
		{
			// SAFETY: `fd` was dup'd in the constructor and the pump thread has
			// exited; nothing else references it.
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
