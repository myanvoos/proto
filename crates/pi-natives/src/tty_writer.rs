#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
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
const MAX_TTY_WRITE_CHUNK_BYTES: usize = 16 * 1024;

#[cfg(unix)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WriteOutcome {
	Complete,
	Cancelled,
}

#[cfg(unix)]
fn write_all_with(
	mut write: impl FnMut(&[u8]) -> std::io::Result<usize>,
	mut wait_writable: impl FnMut() -> std::io::Result<bool>,
	buf: &[u8],
	mut on_progress: impl FnMut(usize),
) -> std::io::Result<WriteOutcome> {
	let mut offset = 0usize;
	let mut should_wait = true;
	while offset < buf.len() {
		if should_wait && !wait_writable()? {
			return Ok(WriteOutcome::Cancelled);
		}

		let end = (offset + MAX_TTY_WRITE_CHUNK_BYTES).min(buf.len());
		match write(&buf[offset..end]) {
			Ok(0) => return Err(std::io::ErrorKind::WriteZero.into()),
			Ok(written) => {
				offset += written;
				on_progress(written);
				should_wait = true;
			},
			Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
				should_wait = false;
			},
			Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
				should_wait = true;
			},
			Err(error) => return Err(error),
		}
	}
	Ok(WriteOutcome::Complete)
}

#[cfg(unix)]
fn wait_writable(fd: RawFd, cancel_fd: RawFd) -> std::io::Result<bool> {
	loop {
		let mut poll_fds = [libc::pollfd { fd, events: libc::POLLOUT, revents: 0 }, libc::pollfd {
			fd:      cancel_fd,
			events:  libc::POLLIN,
			revents: 0,
		}];
		let result = unsafe { libc::poll(poll_fds.as_mut_ptr(), 2, -1) };
		if result < 0 {
			let error = std::io::Error::last_os_error();
			if error.kind() == std::io::ErrorKind::Interrupted {
				continue;
			}
			return Err(error);
		}

		let cancel_events = poll_fds[1].revents;
		if cancel_events & (libc::POLLIN | libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
			return Ok(false);
		}

		let output_events = poll_fds[0].revents;
		if output_events & libc::POLLNVAL != 0 {
			return Err(std::io::Error::from_raw_os_error(libc::EBADF));
		}
		if output_events & (libc::POLLERR | libc::POLLHUP) != 0 {
			return Err(std::io::ErrorKind::BrokenPipe.into());
		}
		if output_events & libc::POLLOUT != 0 {
			return Ok(true);
		}
	}
}

#[cfg(unix)]
fn write_all(
	fd: RawFd,
	cancel_fd: RawFd,
	buf: &[u8],
	on_progress: impl FnMut(usize),
) -> std::io::Result<WriteOutcome> {
	write_all_with(
		|chunk| {
			let rc = unsafe { libc::write(fd, chunk.as_ptr().cast(), chunk.len()) };
			if rc < 0 {
				return Err(std::io::Error::last_os_error());
			}
			Ok(rc as usize)
		},
		|| wait_writable(fd, cancel_fd),
		buf,
		on_progress,
	)
}

#[cfg(unix)]
fn set_close_on_exec(fd: RawFd) -> std::io::Result<()> {
	let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
	if flags < 0 {
		return Err(std::io::Error::last_os_error());
	}
	if unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
		return Err(std::io::Error::last_os_error());
	}
	Ok(())
}

#[cfg(unix)]
fn cancellation_pipe() -> std::io::Result<(OwnedFd, OwnedFd)> {
	let mut fds = [0; 2];
	if unsafe { libc::pipe(fds.as_mut_ptr()) } < 0 {
		return Err(std::io::Error::last_os_error());
	}
	let read = unsafe { OwnedFd::from_raw_fd(fds[0]) };
	let write = unsafe { OwnedFd::from_raw_fd(fds[1]) };
	set_close_on_exec(read.as_raw_fd())?;
	set_close_on_exec(write.as_raw_fd())?;
	Ok((read, write))
}

#[cfg(unix)]
fn discard_pending(inner: &Inner) {
	let mut back = inner.back.lock();
	back.clear();
	inner.pending.store(0, Ordering::Release);
	drop(back);
	inner.cv.notify_all();
}

#[cfg(unix)]
fn pump_loop(fd: OwnedFd, cancel_fd: OwnedFd, inner: &Inner) {
	let mut front: Vec<u8> = Vec::new();
	loop {
		{
			let mut back = inner.back.lock();
			while back.is_empty() && !inner.stop.load(Ordering::Acquire) {
				inner.cv.wait(&mut back);
			}
			if inner.stop.load(Ordering::Acquire) {
				back.clear();
				inner.pending.store(0, Ordering::Release);
				drop(back);
				inner.cv.notify_all();
				return;
			}
			std::mem::swap(&mut *back, &mut front);
		}

		let mut written = 0usize;
		let result = write_all(fd.as_raw_fd(), cancel_fd.as_raw_fd(), &front, |count| {
			written += count;
			inner.pending.fetch_sub(count, Ordering::AcqRel);
		});
		match result {
			Ok(WriteOutcome::Complete) => {},
			Ok(WriteOutcome::Cancelled) => {
				discard_pending(inner);
				return;
			},
			Err(_) => {
				inner.dead.store(true, Ordering::Release);
				discard_pending(inner);
				return;
			},
		}
		debug_assert_eq!(written, front.len());
		front.clear();
		inner.cv.notify_all();
	}
}

#[napi]
pub struct TtyWriter {
	inner:        Arc<Inner>,
	thread:       Option<JoinHandle<()>>,
	#[cfg(unix)]
	cancel_write: Option<OwnedFd>,
}

#[napi]
impl TtyWriter {
	#[napi(catch_unwind, constructor)]
	pub fn new(fd: i32) -> Result<Self> {
		#[cfg(unix)]
		{
			let duplicated = unsafe { libc::dup(fd) };
			if duplicated < 0 {
				return Err(Error::from_reason(format!(
					"dup({fd}) failed: {}",
					std::io::Error::last_os_error()
				)));
			}
			let owned = unsafe { OwnedFd::from_raw_fd(duplicated) };
			set_close_on_exec(owned.as_raw_fd()).map_err(|err| {
				Error::from_reason(format!("failed to configure duplicated tty fd: {err}"))
			})?;
			let (cancel_read, cancel_write) = cancellation_pipe().map_err(|err| {
				Error::from_reason(format!("failed to create tty writer cancellation pipe: {err}"))
			})?;
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
				.spawn(move || pump_loop(owned, cancel_read, &thread_inner))
				.map_err(|err| Error::from_reason(format!("tty writer thread spawn failed: {err}")))?;
			Ok(Self { inner, thread: Some(thread), cancel_write: Some(cancel_write) })
		}
		#[cfg(not(unix))]
		{
			let _ = fd;
			Err(Error::from_reason("TtyWriter is unix-only"))
		}
	}

	#[napi(catch_unwind)]
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
		{
			let mut back = self.inner.back.lock();
			if self.inner.dead.load(Ordering::Acquire) || self.inner.stop.load(Ordering::Acquire) {
				return self.pending();
			}
			let added = fill(&mut back);
			self.inner.pending.fetch_add(added, Ordering::AcqRel);
		}
		self.inner.cv.notify_all();
		self.pending()
	}

	#[napi(catch_unwind)]
	pub fn pending(&self) -> u32 {
		self
			.inner
			.pending
			.load(Ordering::Acquire)
			.min(u32::MAX as usize) as u32
	}

	#[napi(catch_unwind, getter)]
	pub fn dead(&self) -> bool {
		self.inner.dead.load(Ordering::Acquire)
	}

	#[napi(catch_unwind)]
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

	#[napi(catch_unwind)]
	pub fn stop(&mut self, flush_timeout_ms: u32) {
		if self.thread.is_none() {
			#[cfg(unix)]
			self.cancel_write.take();
			return;
		}

		let _ = self.flush_sync(flush_timeout_ms);
		self.inner.stop.store(true, Ordering::Release);
		self.inner.cv.notify_all();
		#[cfg(unix)]
		self.cancel_write.take();
		if let Some(thread) = self.thread.take() {
			let _ = thread.join();
		}
	}
}

impl Drop for TtyWriter {
	fn drop(&mut self) {
		self.stop(0);
	}
}

#[cfg(all(test, unix))]
mod tests {
	use std::io::{Error, ErrorKind};

	use super::*;

	fn test_inner() -> Arc<Inner> {
		Arc::new(Inner {
			back:    Mutex::new(Vec::new()),
			pending: AtomicUsize::new(0),
			cv:      Condvar::new(),
			stop:    AtomicBool::new(false),
			dead:    AtomicBool::new(false),
		})
	}

	#[test]
	fn appended_bytes_are_counted_before_the_buffer_is_exposed_to_the_pump() {
		let inner = test_inner();
		let writer =
			TtyWriter { inner: Arc::clone(&inner), thread: None, cancel_write: None };
		let (start_observing, observe) = std::sync::mpsc::sync_channel(0);
		let observer_inner = Arc::clone(&inner);
		let observer = std::thread::spawn(move || {
			observe.recv().expect("append should start observer");
			let _back = observer_inner.back.lock();
			observer_inner.pending.load(Ordering::Acquire)
		});

		writer.append(|back| {
			back.push(b'x');
			start_observing
				.send(())
				.expect("observer should be waiting for the buffer lock");
			std::thread::sleep(Duration::from_millis(10));
			1
		});

		assert_eq!(observer.join().expect("observer should finish"), 1);
	}

	fn nonblocking_pipe() -> (std::os::fd::OwnedFd, std::os::fd::OwnedFd) {
		use std::os::fd::FromRawFd;

		let mut fds = [0; 2];
		assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
		for fd in fds {
			let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
			assert!(flags >= 0);
			assert_eq!(unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) }, 0);
		}
		unsafe {
			(std::os::fd::OwnedFd::from_raw_fd(fds[0]), std::os::fd::OwnedFd::from_raw_fd(fds[1]))
		}
	}

	#[test]
	fn backpressure_wait_blocks_until_cancellation() {
		use std::{os::fd::AsRawFd, sync::mpsc::RecvTimeoutError};

		let (_read_fd, write_fd) = nonblocking_pipe();
		let fill = [0u8; 4096];
		loop {
			let written =
				unsafe { libc::write(write_fd.as_raw_fd(), fill.as_ptr().cast(), fill.len()) };
			if written >= 0 {
				continue;
			}
			assert_eq!(Error::last_os_error().kind(), ErrorKind::WouldBlock);
			break;
		}

		let (cancel_read, cancel_write) =
			cancellation_pipe().expect("cancellation pipe should be created");
		let (result_tx, result_rx) = std::sync::mpsc::sync_channel(1);
		let waiter = std::thread::spawn(move || {
			let result = wait_writable(write_fd.as_raw_fd(), cancel_read.as_raw_fd());
			result_tx
				.send(result)
				.expect("wait result receiver should remain open");
		});

		assert!(matches!(
			result_rx.recv_timeout(Duration::from_millis(25)),
			Err(RecvTimeoutError::Timeout)
		));
		drop(cancel_write);
		assert!(
			!result_rx
				.recv_timeout(Duration::from_millis(250))
				.expect("cancellation should wake poll")
				.expect("poll should succeed")
		);
		waiter.join().expect("poll waiter should finish");
	}

	#[test]
	fn timed_out_stop_cancels_the_pump_and_closes_its_fd() {
		use std::os::fd::AsRawFd;

		let (read_fd, write_fd) = nonblocking_pipe();
		let fill = [0u8; 4096];
		loop {
			let written =
				unsafe { libc::write(write_fd.as_raw_fd(), fill.as_ptr().cast(), fill.len()) };
			if written >= 0 {
				continue;
			}
			let error = Error::last_os_error();
			assert_eq!(error.kind(), ErrorKind::WouldBlock);
			break;
		}

		let mut writer = TtyWriter::new(write_fd.as_raw_fd()).expect("pipe writer should duplicate");
		drop(write_fd);
		writer.append(|back| {
			back.push(b'x');
			1
		});
		writer.stop(1);

		let deadline = Instant::now() + Duration::from_millis(250);
		let mut buf = [0u8; 8192];
		let reached_eof = loop {
			let read = unsafe { libc::read(read_fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
			if read == 0 {
				break true;
			}
			if read < 0 {
				let error = Error::last_os_error();
				assert_eq!(error.kind(), ErrorKind::WouldBlock);
				if Instant::now() >= deadline {
					break false;
				}
				std::thread::sleep(Duration::from_millis(1));
			}
		};

		assert!(reached_eof, "the pump's duplicated write fd must close after cancellation");
	}

	#[test]
	fn bounded_writer_retries_interrupts_and_partial_writes_without_losing_bytes() {
		let payload = vec![b'x'; MAX_TTY_WRITE_CHUNK_BYTES * 2 + 37];
		let mut output = Vec::new();
		let mut transient_errors = 0usize;
		let mut calls = 0usize;
		let mut waits = 0usize;
		write_all_with(
			|chunk| {
				calls += 1;
				if transient_errors < 2 {
					let kind = if transient_errors == 0 {
						ErrorKind::Interrupted
					} else {
						ErrorKind::WouldBlock
					};
					transient_errors += 1;
					return Err(Error::from(kind));
				}
				let accepted = chunk.len().min(997);
				output.extend_from_slice(&chunk[..accepted]);
				Ok(accepted)
			},
			|| {
				waits += 1;
				Ok(true)
			},
			&payload,
			|_| {},
		)
		.expect("bounded writer should retry transient errors");

		assert!(waits > 1, "writer should wait again after backpressure and progress");
		assert!(calls > payload.len() / 997, "fixture must force partial writes");
		assert_eq!(output, payload, "partial writes must not duplicate or truncate the frame");
	}
}
