//! Child-interpreter stdio capture.
//!
//! The host reads framed bytes on the child's
//! original stdout; IPC stays on its own descriptor. Only native threads drain
//! captured pipes, so a synchronous interpreter write can apply real
//! backpressure without waiting for that interpreter's event loop.

use napi::{Error, Result};
use napi_derive::napi;

/// Scoped fd 0 input and nestable fd 1/2 capture for a dedicated kernel child,
/// not an in-process host console. stdout must be a pipe/socket to the host. A
/// second live instance is rejected.
#[napi]
pub struct KernelStdio {
	#[cfg(any(target_os = "linux", target_os = "macos"))]
	inner: Option<posix::Capture>,
}

#[napi]
impl KernelStdio {
	#[napi(catch_unwind, constructor)]
	pub fn new() -> Result<Self> {
		#[cfg(any(target_os = "linux", target_os = "macos"))]
		{
			Ok(Self { inner: Some(posix::Capture::new().map_err(native_error)?) })
		}
		#[cfg(not(any(target_os = "linux", target_os = "macos")))]
		Err(unsupported())
	}

	/// Install a fresh run's pipes, or nest without replacing pipes when this
	/// run is already active. Descendants inherit the installed write ends,
	/// never the reserved frame transport.
	#[napi(catch_unwind)]
	pub fn start(&mut self, run_id: String) -> Result<()> {
		#[cfg(any(target_os = "linux", target_os = "macos"))]
		{
			self
				.inner
				.as_mut()
				.ok_or_else(closed)?
				.start(run_id)
				.map_err(native_error)
		}
		#[cfg(not(any(target_os = "linux", target_os = "macos")))]
		{
			let _ = run_id;
			Err(unsupported())
		}
	}

	/// Connect a cell's input directly to fd 0. The host feeds it independently
	/// of the interpreter event loop, so synchronous reads and inherited stdin
	/// cannot deadlock IPC. Returns an owned duplicate for the interpreter's
	/// lazily-created stdin stream.
	#[napi(catch_unwind)]
	pub fn start_input(&mut self, run_id: String, socket_path: Option<String>) -> Result<u32> {
		#[cfg(any(target_os = "linux", target_os = "macos"))]
		{
			self
				.inner
				.as_mut()
				.ok_or_else(closed)?
				.start_input(&run_id, socket_path.as_deref())
				.map_err(native_error)
		}
		#[cfg(not(any(target_os = "linux", target_os = "macos")))]
		{
			let _ = (run_id, socket_path);
			Err(unsupported())
		}
	}

	/// Restore the original stdin after the cell has closed its stream
	/// duplicate.
	#[napi(catch_unwind)]
	pub fn finish_input(&mut self) -> Result<()> {
		#[cfg(any(target_os = "linux", target_os = "macos"))]
		{
			self
				.inner
				.as_mut()
				.ok_or_else(closed)?
				.finish_input()
				.map_err(native_error)
		}
		#[cfg(not(any(target_os = "linux", target_os = "macos")))]
		Err(unsupported())
	}

	/// Drain every byte accepted before the reader's barrier snapshot. The host
	/// must consume this sequence before publishing a result/display on its
	/// separate control channel.
	#[napi(catch_unwind)]
	pub fn flush(&mut self) -> Result<f64> {
		#[cfg(any(target_os = "linux", target_os = "macos"))]
		{
			self
				.inner
				.as_mut()
				.ok_or_else(closed)?
				.flush()
				.map(|n| n as f64)
				.map_err(native_error)
		}
		#[cfg(not(any(target_os = "linux", target_os = "macos")))]
		Err(unsupported())
	}

	/// Flush and restore the enclosing scope's descriptors (a discard sink
	/// outside all scopes). Child processes retaining this scope's pipes
	/// continue to emit frames with its original run id.
	#[napi(catch_unwind)]
	pub fn finish(&mut self) -> Result<f64> {
		#[cfg(any(target_os = "linux", target_os = "macos"))]
		{
			self
				.inner
				.as_mut()
				.ok_or_else(closed)?
				.finish()
				.map(|n| n as f64)
				.map_err(native_error)
		}
		#[cfg(not(any(target_os = "linux", target_os = "macos")))]
		Err(unsupported())
	}

	/// Synchronously route a retained callback's stream write, preserving its
	/// original run owner. This does not enqueue a libuv write that could
	/// outlive the temporary descriptor scope.
	#[napi(catch_unwind)]
	pub fn write(
		&mut self,
		run_id: String,
		stream: String,
		data: napi::bindgen_prelude::Buffer,
	) -> Result<f64> {
		#[cfg(any(target_os = "linux", target_os = "macos"))]
		{
			self
				.inner
				.as_mut()
				.ok_or_else(closed)?
				.write(run_id, &stream, &data)
				.map(|n| n as f64)
				.map_err(native_error)
		}
		#[cfg(not(any(target_os = "linux", target_os = "macos")))]
		{
			let _ = (run_id, stream, data);
			Err(unsupported())
		}
	}

	/// Restore owned descriptors and cancel/join the reader without waiting for
	/// descendant EOF. Pending bytes are discarded on shutdown; use
	/// finish/flush for a delivery fence first.
	#[napi(catch_unwind)]
	pub fn close(&mut self) {
		#[cfg(any(target_os = "linux", target_os = "macos"))]
		drop(self.inner.take());
	}
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn native_error(error: std::io::Error) -> Error {
	Error::from_reason(format!("kernel stdio: {error}"))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn closed() -> Error {
	Error::from_reason("kernel stdio capture is closed")
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn unsupported() -> Error {
	Error::from_reason("kernel native stdio capture is supported only on Linux and macOS")
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod posix {
	use std::{
		io,
		os::{
			fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd, RawFd},
			unix::net::UnixStream,
		},
		sync::{
			Arc,
			atomic::{AtomicBool, Ordering},
			mpsc::{self, Receiver, SyncSender},
		},
		thread::{self, JoinHandle},
	};

	use base64::{Engine, engine::general_purpose::STANDARD};
	use serde::Serialize;

	// Explicit resource ceilings fail new captures rather than evicting/truncating
	// live writers.
	const MAX_STREAMS: usize = 256;
	const MAX_SCOPES: usize = 128;
	const MAX_RUN_ID_BYTES: usize = 1024;
	const CHUNK_BYTES: usize = 16 * 1024;
	const MAX_SEQUENCE: u64 = (1_u64 << 53) - 1;
	static CLAIMED: AtomicBool = AtomicBool::new(false);

	struct Ownership;

	impl Ownership {
		fn claim() -> io::Result<Self> {
			CLAIMED
				.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
				.map_err(|_| {
					io::Error::other("another kernel stdio capture already owns this process")
				})?;
			Ok(Self)
		}
	}

	impl Drop for Ownership {
		fn drop(&mut self) {
			CLAIMED.store(false, Ordering::Release);
		}
	}

	struct Scope {
		run_id: Arc<str>,
		stdout: OwnedFd,
		stderr: OwnedFd,
	}

	struct ReadStream {
		run_id: Arc<str>,
		stream: &'static str,
		fd:     OwnedFd,
	}

	enum Command {
		Add { run_id: Arc<str>, stdout: OwnedFd, stderr: OwnedFd },
		Barrier,
	}

	struct Request {
		command: Command,
		reply:   SyncSender<io::Result<u64>>,
	}

	#[derive(Serialize)]
	struct Frame<'a> {
		#[serde(rename = "type")]
		kind:     &'static str,
		#[serde(rename = "runId")]
		run_id:   &'a str,
		stream:   &'static str,
		data:     String,
		sequence: u64,
	}

	pub(super) struct Capture {
		original_stdin:        OwnedFd,
		input:                 Option<OwnedFd>,
		original_stdout:       OwnedFd,
		original_stderr:       OwnedFd,
		original_stdout_flags: i32,
		idle:                  OwnedFd,
		scopes:                Vec<Scope>,
		requests:              SyncSender<Request>,
		wake:                  OwnedFd,
		cancel:                Option<OwnedFd>,
		reader:                Option<JoinHandle<io::Result<()>>>,
		// Released only after the descriptors and reader are restored/stopped.
		_ownership:            Ownership,
	}

	impl Capture {
		pub(super) fn new() -> io::Result<Self> {
			let ownership = Ownership::claim()?;
			let original_stdin = duplicate(libc::STDIN_FILENO)?;
			let original_stdout = duplicate(libc::STDOUT_FILENO)?;
			let original_stderr = duplicate(libc::STDERR_FILENO)?;
			let kind = stat(original_stdout.as_raw_fd())?.st_mode & libc::S_IFMT;
			if kind != libc::S_IFIFO && kind != libc::S_IFSOCK {
				return Err(io::Error::other(
					"dedicated kernel child stdout must be a host-readable pipe or socket",
				));
			}
			let original_stdout_flags = descriptor_flags(original_stdout.as_raw_fd())?;
			let transport = duplicate(original_stdout.as_raw_fd())?;
			let idle = std::fs::OpenOptions::new()
				.write(true)
				.open("/dev/null")?
				.into();
			let (wake_read, wake) = pipe()?;
			let (cancel_read, cancel) = pipe()?;
			let (requests, receiver) = mpsc::sync_channel(1);
			// dup shares file-status flags. The child owns this output description; restore
			// its flags at close. Captured fd 1/2 are separate, blocking pipe write
			// descriptions.
			set_flags(transport.as_raw_fd(), original_stdout_flags | libc::O_NONBLOCK)?;
			let reader = match thread::Builder::new()
				.name("kernel-stdio".into())
				.spawn(move || pump(transport, wake_read, cancel_read, receiver))
			{
				Ok(reader) => reader,
				Err(error) => {
					let _ = set_flags(original_stdout.as_raw_fd(), original_stdout_flags);
					return Err(error);
				},
			};
			let capture = Self {
				original_stdin,
				input: None,
				original_stdout,
				original_stderr,
				original_stdout_flags,
				idle,
				scopes: Vec::new(),
				requests,
				wake,
				cancel: Some(cancel),
				reader: Some(reader),
				_ownership: ownership,
			};
			// Never expose the framed transport as ordinary stdout between cells.
			replace(capture.idle.as_raw_fd(), libc::STDOUT_FILENO)?;
			replace(capture.idle.as_raw_fd(), libc::STDERR_FILENO)?;
			Ok(capture)
		}

		pub(super) fn start(&mut self, run_id: String) -> io::Result<()> {
			if run_id.is_empty() || run_id.len() > MAX_RUN_ID_BYTES {
				return Err(io::Error::other("run id must contain 1..1024 UTF-8 bytes"));
			}
			if self.scopes.len() == MAX_SCOPES {
				return Err(io::Error::other("kernel stdio nesting limit exceeded"));
			}
			self.check_owned()?;
			if let Some(active) = self.scopes.last().filter(|scope| *scope.run_id == run_id) {
				self.scopes.push(Scope {
					run_id: Arc::clone(&active.run_id),
					stdout: duplicate(active.stdout.as_raw_fd())?,
					stderr: duplicate(active.stderr.as_raw_fd())?,
				});
				return Ok(());
			}
			// C stdio buffers belong to the previous scope, before fd reassignment.
			self.flush()?;
			let run_id: Arc<str> = run_id.into();
			let (stdout_read, stdout) = pipe()?;
			let (stderr_read, stderr) = pipe()?;
			self.request(Command::Add {
				run_id: Arc::clone(&run_id),
				stdout: stdout_read,
				stderr: stderr_read,
			})?;
			let (previous_stdout, _) = self.current();
			replace(stdout.as_raw_fd(), libc::STDOUT_FILENO)?;
			if let Err(error) = replace(stderr.as_raw_fd(), libc::STDERR_FILENO) {
				let _ = replace(previous_stdout, libc::STDOUT_FILENO);
				return Err(error);
			}
			self.scopes.push(Scope { run_id, stdout, stderr });
			Ok(())
		}

		pub(super) fn start_input(
			&mut self,
			run_id: &str,
			socket_path: Option<&str>,
		) -> io::Result<u32> {
			if self.input.is_some() {
				return Err(io::Error::other("kernel stdin already has an active cell"));
			}
			if run_id.is_empty() || run_id.len() > MAX_RUN_ID_BYTES || run_id.contains('\n') {
				return Err(io::Error::other("invalid stdin run id"));
			}
			let input: OwnedFd = match socket_path {
				Some(path) => {
					let socket = UnixStream::connect(path)?;
					write_bytes(socket.as_raw_fd(), run_id.as_bytes())?;
					write_bytes(socket.as_raw_fd(), b"\n")?;
					socket.into()
				},
				None => std::fs::File::open("/dev/null")?.into(),
			};
			let stream = duplicate(input.as_raw_fd())?;
			replace(input.as_raw_fd(), libc::STDIN_FILENO)?;
			self.input = Some(input);
			Ok(stream.into_raw_fd() as u32)
		}

		pub(super) fn finish_input(&mut self) -> io::Result<()> {
			if self.input.is_some() {
				replace(self.original_stdin.as_raw_fd(), libc::STDIN_FILENO)?;
				self.input = None;
			}
			Ok(())
		}

		pub(super) fn flush(&self) -> io::Result<u64> {
			// Flush C stdio as well as already-written raw descriptors. Interpreter-level
			// buffering is the caller's responsibility before requesting this native fence.
			if unsafe { libc::fflush(std::ptr::null_mut()) } != 0 {
				return Err(io::Error::last_os_error());
			}
			self.request(Command::Barrier)
		}

		pub(super) fn finish(&mut self) -> io::Result<u64> {
			if self.scopes.is_empty() {
				return Err(io::Error::other("kernel stdio has no active capture"));
			}
			self.check_owned()?;
			let sequence = self.flush()?;
			let previous = self.scopes.get(self.scopes.len().wrapping_sub(2));
			let stdout =
				previous.map_or_else(|| self.idle.as_raw_fd(), |scope| scope.stdout.as_raw_fd());
			let stderr =
				previous.map_or_else(|| self.idle.as_raw_fd(), |scope| scope.stderr.as_raw_fd());
			replace(stdout, libc::STDOUT_FILENO)?;
			if let Err(error) = replace(stderr, libc::STDERR_FILENO) {
				let _ = replace(self.scopes.last().unwrap().stdout.as_raw_fd(), libc::STDOUT_FILENO);
				return Err(error);
			}
			self.scopes.pop();
			Ok(sequence)
		}

		pub(super) fn write(&mut self, run_id: String, stream: &str, data: &[u8]) -> io::Result<u64> {
			let fd = match stream {
				"stdout" => libc::STDOUT_FILENO,
				"stderr" => libc::STDERR_FILENO,
				_ => return Err(io::Error::other("stream must be stdout or stderr")),
			};
			self.start(run_id)?;
			let write_result = write_bytes(fd, data);
			let finish_result = self.finish();
			write_result?;
			finish_result
		}

		fn current(&self) -> (RawFd, RawFd) {
			self.scopes.last().map_or_else(
				|| (self.idle.as_raw_fd(), self.idle.as_raw_fd()),
				|scope| (scope.stdout.as_raw_fd(), scope.stderr.as_raw_fd()),
			)
		}

		fn check_owned(&self) -> io::Result<()> {
			let (stdout, stderr) = self.current();
			if !same_descriptor(libc::STDOUT_FILENO, stdout)
				|| !same_descriptor(libc::STDERR_FILENO, stderr)
			{
				return Err(io::Error::other(
					"kernel stdout/stderr descriptors were replaced outside their capture owner",
				));
			}
			Ok(())
		}

		fn request(&self, command: Command) -> io::Result<u64> {
			let (reply, receive) = mpsc::sync_channel(1);
			self
				.requests
				.send(Request { command, reply })
				.map_err(|_| io::Error::other("kernel stdio reader stopped"))?;
			write_bytes(self.wake.as_raw_fd(), &[1])?;
			receive
				.recv()
				.map_err(|_| io::Error::other("kernel stdio reader stopped before its barrier"))?
		}
	}

	impl Drop for Capture {
		fn drop(&mut self) {
			let _ = self.finish_input();
			let (stdout, stderr) = self.current();
			if same_descriptor(libc::STDOUT_FILENO, stdout) {
				let _ = replace(self.original_stdout.as_raw_fd(), libc::STDOUT_FILENO);
			}
			if same_descriptor(libc::STDERR_FILENO, stderr) {
				let _ = replace(self.original_stderr.as_raw_fd(), libc::STDERR_FILENO);
			}
			self.scopes.clear();
			// Closing this write end wakes poll even when the host transport is
			// backpressured.
			drop(self.cancel.take());
			if let Some(reader) = self.reader.take() {
				let _ = reader.join();
			}
			let _ = set_flags(self.original_stdout.as_raw_fd(), self.original_stdout_flags);
		}
	}

	fn pump(
		transport: OwnedFd,
		wake: OwnedFd,
		cancel: OwnedFd,
		requests: Receiver<Request>,
	) -> io::Result<()> {
		let mut streams: Vec<ReadStream> = Vec::new();
		let mut sequence = 0;
		let mut buffer = [0_u8; CHUNK_BYTES];
		loop {
			let mut fds = Vec::with_capacity(streams.len() + 2);
			fds.push(poll_entry(cancel.as_raw_fd(), libc::POLLIN));
			fds.push(poll_entry(wake.as_raw_fd(), libc::POLLIN));
			fds.extend(
				streams
					.iter()
					.map(|stream| poll_entry(stream.fd.as_raw_fd(), libc::POLLIN)),
			);
			poll(&mut fds)?;
			if fds[0].revents != 0 {
				return Ok(());
			}
			if fds[1].revents != 0 {
				let _ = read_bytes(wake.as_raw_fd(), &mut buffer)?;
				if let Ok(request) = requests.try_recv() {
					let result = match request.command {
						Command::Add { run_id, stdout, stderr } => {
							// Retire only EOF pipes. Live inherited writers are never evicted.
							streams.retain(|stream| !at_eof(stream.fd.as_raw_fd()));
							if streams.len() + 2 > MAX_STREAMS {
								Err(io::Error::other(
									"too many live kernel stdio captures; close inherited child writers",
								))
							} else {
								streams.push(ReadStream {
									run_id: Arc::clone(&run_id),
									stream: "stdout",
									fd:     stdout,
								});
								streams.push(ReadStream { run_id, stream: "stderr", fd: stderr });
								Ok(sequence)
							}
						},
						Command::Barrier => barrier(
							&streams,
							transport.as_raw_fd(),
							cancel.as_raw_fd(),
							&mut sequence,
							&mut buffer,
						),
					};
					let _ = request.reply.send(result);
				}
				continue;
			}
			for index in (0..streams.len()).rev() {
				if fds[index + 2].revents == 0 {
					continue;
				}
				let stream = &streams[index];
				match read_bytes(stream.fd.as_raw_fd(), &mut buffer) {
					Ok(0) => {
						streams.swap_remove(index);
					},
					Ok(count) => emit(
						transport.as_raw_fd(),
						cancel.as_raw_fd(),
						stream,
						&buffer[..count],
						&mut sequence,
					)?,
					Err(error) if error.kind() == io::ErrorKind::WouldBlock => {},
					Err(error) => return Err(error),
				}
			}
		}
	}

	fn barrier(
		streams: &[ReadStream],
		transport: RawFd,
		cancel: RawFd,
		sequence: &mut u64,
		buffer: &mut [u8],
	) -> io::Result<u64> {
		// The pump is the only reader. Snapshot the unread counts before draining any
		// stream; this side-channel fence cannot collide with arbitrary user bytes
		// and cannot starve when descendants keep writing. FIONREAD on pipes is
		// available on Linux and Darwin.
		let counts = streams
			.iter()
			.map(|stream| pending_bytes(stream.fd.as_raw_fd()))
			.collect::<io::Result<Vec<_>>>()?;
		for (stream, mut remaining) in streams.iter().zip(counts) {
			while remaining > 0 {
				let limit = remaining.min(buffer.len());
				let count = read_bytes(stream.fd.as_raw_fd(), &mut buffer[..limit])?;
				if count == 0 {
					return Err(io::Error::new(
						io::ErrorKind::UnexpectedEof,
						"capture pipe closed before its barrier",
					));
				}
				emit(transport, cancel, stream, &buffer[..count], sequence)?;
				remaining -= count;
			}
		}
		Ok(*sequence)
	}

	fn emit(
		transport: RawFd,
		cancel: RawFd,
		stream: &ReadStream,
		bytes: &[u8],
		sequence: &mut u64,
	) -> io::Result<()> {
		if *sequence == MAX_SEQUENCE {
			return Err(io::Error::other("kernel stdio sequence exhausted"));
		}
		let frame = Frame {
			kind:     "native-stdio",
			run_id:   &stream.run_id,
			stream:   stream.stream,
			data:     STANDARD.encode(bytes),
			sequence: *sequence + 1,
		};
		let mut data = serde_json::to_vec(&frame)?;
		data.push(b'\n');
		let mut remaining = data.as_slice();
		while !remaining.is_empty() {
			let mut fds = [poll_entry(cancel, libc::POLLIN), poll_entry(transport, libc::POLLOUT)];
			poll(&mut fds)?;
			if fds[0].revents != 0 {
				return Err(io::Error::new(io::ErrorKind::Interrupted, "kernel stdio closed"));
			}
			if fds[1].revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
				return Err(io::Error::new(
					io::ErrorKind::BrokenPipe,
					"kernel stdio host transport closed",
				));
			}
			match write_once(transport, remaining) {
				Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
				Ok(count) => remaining = &remaining[count..],
				Err(error) if error.kind() == io::ErrorKind::WouldBlock => {},
				Err(error) => return Err(error),
			}
		}
		*sequence += 1;
		Ok(())
	}

	fn duplicate(fd: RawFd) -> io::Result<OwnedFd> {
		let duplicated = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) };
		if duplicated < 0 {
			return Err(io::Error::last_os_error());
		}
		Ok(unsafe { OwnedFd::from_raw_fd(duplicated) })
	}

	fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
		let mut fds = [0; 2];
		if unsafe { libc::pipe(fds.as_mut_ptr()) } < 0 {
			return Err(io::Error::last_os_error());
		}
		let read = unsafe { OwnedFd::from_raw_fd(fds[0]) };
		let write = unsafe { OwnedFd::from_raw_fd(fds[1]) };
		for fd in [&read, &write] {
			if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
				return Err(io::Error::last_os_error());
			}
		}
		set_flags(read.as_raw_fd(), descriptor_flags(read.as_raw_fd())? | libc::O_NONBLOCK)?;
		Ok((read, write))
	}

	fn descriptor_flags(fd: RawFd) -> io::Result<i32> {
		let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
		if flags < 0 {
			return Err(io::Error::last_os_error());
		}
		Ok(flags)
	}

	fn set_flags(fd: RawFd, flags: i32) -> io::Result<()> {
		if unsafe { libc::fcntl(fd, libc::F_SETFL, flags) } < 0 {
			return Err(io::Error::last_os_error());
		}
		Ok(())
	}

	fn replace(from: RawFd, to: RawFd) -> io::Result<()> {
		loop {
			if unsafe { libc::dup2(from, to) } >= 0 {
				return Ok(());
			}
			let error = io::Error::last_os_error();
			if error.kind() != io::ErrorKind::Interrupted {
				return Err(error);
			}
		}
	}

	fn stat(fd: RawFd) -> io::Result<libc::stat> {
		let mut result = std::mem::MaybeUninit::uninit();
		if unsafe { libc::fstat(fd, result.as_mut_ptr()) } < 0 {
			return Err(io::Error::last_os_error());
		}
		Ok(unsafe { result.assume_init() })
	}

	fn same_descriptor(left: RawFd, right: RawFd) -> bool {
		match (stat(left), stat(right)) {
			(Ok(left), Ok(right)) => left.st_dev == right.st_dev && left.st_ino == right.st_ino,
			_ => false,
		}
	}

	fn pending_bytes(fd: RawFd) -> io::Result<usize> {
		let mut count: libc::c_int = 0;
		if unsafe { libc::ioctl(fd, libc::FIONREAD, &mut count) } < 0 {
			return Err(io::Error::last_os_error());
		}
		Ok(count as usize)
	}

	fn at_eof(fd: RawFd) -> bool {
		let mut entry = poll_entry(fd, libc::POLLIN);
		(unsafe { libc::poll(&raw mut entry, 1, 0) }) > 0
			&& entry.revents & libc::POLLHUP != 0
			&& pending_bytes(fd).is_ok_and(|count| count == 0)
	}

	const fn poll_entry(fd: RawFd, events: i16) -> libc::pollfd {
		libc::pollfd { fd, events, revents: 0 }
	}

	fn poll(fds: &mut [libc::pollfd]) -> io::Result<()> {
		loop {
			if unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, -1) } >= 0 {
				return Ok(());
			}
			let error = io::Error::last_os_error();
			if error.kind() != io::ErrorKind::Interrupted {
				return Err(error);
			}
		}
	}

	fn read_bytes(fd: RawFd, buffer: &mut [u8]) -> io::Result<usize> {
		loop {
			let count = unsafe { libc::read(fd, buffer.as_mut_ptr().cast(), buffer.len()) };
			if count >= 0 {
				return Ok(count as usize);
			}
			let error = io::Error::last_os_error();
			if error.kind() != io::ErrorKind::Interrupted {
				return Err(error);
			}
		}
	}

	fn write_once(fd: RawFd, bytes: &[u8]) -> io::Result<usize> {
		loop {
			let count = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
			if count >= 0 {
				return Ok(count as usize);
			}
			let error = io::Error::last_os_error();
			if error.kind() != io::ErrorKind::Interrupted {
				return Err(error);
			}
		}
	}

	fn write_bytes(fd: RawFd, mut bytes: &[u8]) -> io::Result<()> {
		while !bytes.is_empty() {
			let count = write_once(fd, bytes)?;
			if count == 0 {
				return Err(io::ErrorKind::WriteZero.into());
			}
			bytes = &bytes[count..];
		}
		Ok(())
	}
}
