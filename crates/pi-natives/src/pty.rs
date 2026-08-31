use std::{
	collections::HashMap,
	io::{Read, Write},
	str,
	sync::Arc,
	time::{Duration, Instant},
};

use napi::{
	JsString,
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;
use parking_lot::Mutex;
use portable_pty::{Child, CommandBuilder, PtySize, native_pty_system};

use crate::{js::into_string, ps, task};

#[napi(object)]
pub struct PtyStartOptions<'env> {
	pub command: String,

	pub cwd: Option<String>,

	pub env: Option<HashMap<String, String>>,

	pub timeout_ms: Option<u32>,

	pub signal: Option<Unknown<'env>>,

	pub cols: Option<u16>,

	pub rows: Option<u16>,

	pub shell: Option<String>,
}

#[napi(object)]
pub struct PtyArgvStartOptions<'env> {
	pub application: String,

	pub args: Vec<String>,

	pub cwd: Option<String>,

	pub env: Option<HashMap<String, String>>,

	pub timeout_ms: Option<u32>,

	pub signal: Option<Unknown<'env>>,

	pub cols: Option<u16>,

	pub rows: Option<u16>,
}

#[napi(object)]
pub struct PtyRunResult {
	pub exit_code: Option<i32>,

	pub cancelled: bool,

	pub timed_out: bool,
}

#[derive(Clone)]
enum PtyCommand {
	Shell { command: String, shell: Option<String> },
	Argv { application: String, args: Vec<String> },
}

#[derive(Clone)]
struct PtyRunConfig {
	command: PtyCommand,
	cwd:     Option<String>,
	env:     Option<HashMap<String, String>>,
	cols:    u16,
	rows:    u16,
}

enum ReaderEvent {
	Chunk(String),
	Done,
}

enum ControlMessage {
	Input(String),
	Resize { cols: u16, rows: u16 },
	Kill,
}

const CONTROL_MESSAGES_PER_TICK: usize = 64;
const READER_EVENTS_PER_TICK: usize = 256;
const POST_CANCEL_DRAIN_TIMEOUT: Duration = Duration::from_millis(300);
const POST_EXIT_DRAIN_TIMEOUT: Duration = Duration::from_millis(300);

const CANCEL_REAP_TIMEOUT: Duration = Duration::from_millis(500);
const CANCEL_REAP_POLL_INTERVAL: Duration = Duration::from_millis(5);
const FINAL_READER_DRAIN_TIMEOUT: Duration = Duration::from_millis(50);

struct PtySessionCore {
	control_tx: flume::Sender<ControlMessage>,
}

#[napi]
pub struct PtySession {
	core: Arc<Mutex<Option<PtySessionCore>>>,
}

impl Default for PtySession {
	fn default() -> Self {
		Self::new()
	}
}

#[napi]
impl PtySession {
	#[napi(constructor)]
	pub fn new() -> Self {
		Self { core: Arc::new(Mutex::new(None)) }
	}

	#[napi]
	pub fn start<'env>(
		&self,
		env: &'env Env,
		options: PtyStartOptions<'env>,
		#[napi(ts_arg_type = "((error: Error | null, chunk: string) => void) | undefined | null")]
		on_chunk: Option<ThreadsafeFunction<String>>,
		#[napi(ts_arg_type = "((error: Error | null, pid: number) => void) | undefined | null")]
		on_start: Option<ThreadsafeFunction<u32>>,
	) -> Result<PromiseRaw<'env, PtyRunResult>> {
		let run_config = PtyRunConfig {
			command: PtyCommand::Shell { command: options.command, shell: options.shell },
			cwd:     options.cwd,
			env:     options.env,
			cols:    options.cols.unwrap_or(120).clamp(20, 400),
			rows:    options.rows.unwrap_or(40).clamp(5, 200),
		};
		self.start_config(env, run_config, options.timeout_ms, options.signal, on_chunk, on_start)
	}

	#[napi]
	pub fn start_argv<'env>(
		&self,
		env: &'env Env,
		options: PtyArgvStartOptions<'env>,
		#[napi(ts_arg_type = "((error: Error | null, chunk: string) => void) | undefined | null")]
		on_chunk: Option<ThreadsafeFunction<String>>,
		#[napi(ts_arg_type = "((error: Error | null, pid: number) => void) | undefined | null")]
		on_start: Option<ThreadsafeFunction<u32>>,
	) -> Result<PromiseRaw<'env, PtyRunResult>> {
		let run_config = PtyRunConfig {
			command: PtyCommand::Argv { application: options.application, args: options.args },
			cwd:     options.cwd,
			env:     options.env,
			cols:    options.cols.unwrap_or(120).clamp(20, 400),
			rows:    options.rows.unwrap_or(40).clamp(5, 200),
		};
		self.start_config(env, run_config, options.timeout_ms, options.signal, on_chunk, on_start)
	}

	#[napi]
	pub fn write(&self, data: JsString) -> Result<()> {
		self.send_control(ControlMessage::Input(into_string(data)?))
	}

	#[napi]
	pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
		self.send_control(ControlMessage::Resize {
			cols: cols.clamp(20, 400),
			rows: rows.clamp(5, 200),
		})
	}

	#[napi]
	pub fn kill(&self) -> Result<()> {
		self.send_control(ControlMessage::Kill)
	}
}

impl PtySession {
	fn start_config<'env>(
		&self,
		env: &'env Env,
		run_config: PtyRunConfig,
		timeout_ms: Option<u32>,
		signal: Option<Unknown<'env>>,
		on_chunk: Option<ThreadsafeFunction<String>>,
		on_start: Option<ThreadsafeFunction<u32>>,
	) -> Result<PromiseRaw<'env, PtyRunResult>> {
		let ct = task::CancelToken::new(timeout_ms, signal);
		let core = Arc::clone(&self.core);

		let (control_tx, control_rx) = flume::unbounded::<ControlMessage>();
		{
			let mut guard = core.lock();
			if guard.is_some() {
				return Err(Error::from_reason("PTY session already running"));
			}
			*guard = Some(PtySessionCore { control_tx });
		}
		task::future(env, "pty.start", async move {
			let run_result = tokio::task::spawn_blocking(move || {
				run_pty_sync(run_config, on_chunk, on_start, control_rx, ct)
			})
			.await;

			let mut guard = core.lock();
			*guard = None;
			drop(guard);

			match run_result {
				Ok(inner) => inner,
				Err(err) => Err(Error::from_reason(format!("PTY execution task failed: {err}"))),
			}
		})
	}

	fn send_control(&self, message: ControlMessage) -> Result<()> {
		let guard = self.core.lock();
		let core = guard
			.as_ref()
			.ok_or_else(|| Error::from_reason("PTY session is not running"))?;
		core
			.control_tx
			.send(message)
			.map_err(|_| Error::from_reason("PTY session is no longer available"))
	}
}

fn terminate_pty_processes(
	child: &mut Box<dyn Child + Send + Sync>,
	child_pid: Option<i32>,
	process_group_id: Option<i32>,
) {
	let mut targets = ps::TerminationTargets::new();
	if let Some(pgid) = process_group_id {
		targets.add_pgid(pgid);
	}
	if let Some(pid) = child_pid {
		targets.add_pid(pid);
	}

	targets.signal(ps::TERM_SIGNAL);
	let _ = child.kill();
	targets.signal(ps::KILL_SIGNAL);
}
fn run_pty_sync(
	config: PtyRunConfig,
	on_chunk: Option<ThreadsafeFunction<String>>,
	on_start: Option<ThreadsafeFunction<u32>>,
	control_rx: flume::Receiver<ControlMessage>,
	ct: task::CancelToken,
) -> Result<PtyRunResult> {
	let pty_system = native_pty_system();
	ct.heartbeat()
		.map_err(|err| Error::from_reason(format!("PTY setup cancelled before openpty: {err}")))?;

	let pair = pty_system
		.openpty(PtySize {
			rows:         config.rows,
			cols:         config.cols,
			pixel_width:  0,
			pixel_height: 0,
		})
		.map_err(|err| Error::from_reason(format!("Failed to open PTY: {err}")))?;

	let mut cmd = match config.command {
		PtyCommand::Shell { command, shell } => {
			let shell = shell.as_deref().unwrap_or("sh");
			let mut cmd = CommandBuilder::new(shell);
			cmd.arg("-lc");
			cmd.arg(command);
			cmd
		},
		PtyCommand::Argv { application, args } => {
			let mut cmd = CommandBuilder::new(application);
			for arg in args {
				cmd.arg(arg);
			}
			cmd
		},
	};
	if let Some(cwd) = config.cwd.as_ref() {
		cmd.cwd(cwd);
	}
	if let Some(env) = config.env.as_ref() {
		for (key, value) in env {
			cmd.env(key, value);
		}
	}
	ct.heartbeat()
		.map_err(|err| Error::from_reason(format!("PTY setup cancelled before spawn: {err}")))?;

	let mut child = pair
		.slave
		.spawn_command(cmd)
		.map_err(|err| Error::from_reason(format!("Failed to spawn PTY command: {err}")))?;
	drop(pair.slave);
	let child_process_id = child.process_id();
	let child_pid = child_process_id.and_then(|value| i32::try_from(value).ok());
	if let Some(callback) = on_start.as_ref() {
		callback.call(Ok(child_process_id.unwrap_or(0)), ThreadsafeFunctionCallMode::NonBlocking);
	}

	let master = pair.master;
	let mut writer = master
		.take_writer()
		.map_err(|err| Error::from_reason(format!("Failed to create PTY writer: {err}")))?;
	let mut reader = master
		.try_clone_reader()
		.map_err(|err| Error::from_reason(format!("Failed to create PTY reader: {err}")))?;

	let (reader_tx, reader_rx) = flume::unbounded::<ReaderEvent>();
	let reader_thread = std::thread::spawn(move || {
		const REPLACEMENT: &str = "\u{FFFD}";
		const BUF: usize = 65536;
		let mut buf = vec![0u8; BUF + 4];
		let mut it = 0;
		loop {
			match reader.read(&mut buf[it..BUF]) {
				Ok(0) => {
					break;
				},
				Ok(n) => {
					it += n;
					while it > 0 {
						let pending = &buf[..it];
						match str::from_utf8(pending) {
							Ok(text) => {
								let _ = reader_tx.send(ReaderEvent::Chunk(text.to_string()));
								it = 0;
								break;
							},
							Err(err) => {
								let valid_up_to = err.valid_up_to();
								if valid_up_to > 0 {
									let text = unsafe { str::from_utf8_unchecked(&pending[..valid_up_to]) };
									let _ = reader_tx.send(ReaderEvent::Chunk(text.to_string()));
									buf.copy_within(valid_up_to..it, 0);
									it -= valid_up_to;
								}
								match err.error_len() {
									Some(invalid_len) => {
										let _ = reader_tx.send(ReaderEvent::Chunk(REPLACEMENT.to_string()));
										buf.copy_within(invalid_len..it, 0);
										it -= invalid_len;
									},
									None => {
										break;
									},
								}
							},
						}
					}
				},
				Err(_) => {
					break;
				},
			}
		}
		for chunk in buf[..it].utf8_chunks() {
			let valid = chunk.valid();
			if !valid.is_empty() {
				let _ = reader_tx.send(ReaderEvent::Chunk(valid.to_string()));
			}
			if !chunk.invalid().is_empty() {
				let _ = reader_tx.send(ReaderEvent::Chunk(REPLACEMENT.to_string()));
			}
		}
		let _ = reader_tx.send(ReaderEvent::Done);
	});

	#[cfg(unix)]
	let process_group_id = master.process_group_leader().filter(|pgid| *pgid > 0);
	#[cfg(not(unix))]
	let process_group_id: Option<i32> = None;
	let mut timed_out = false;
	let mut cancelled = false;
	let mut reader_done = false;
	let mut exit_code: Option<i32> = None;
	let mut terminate_requested = false;
	let mut reader_drain_deadline: Option<Instant> = None;
	while exit_code.is_none() || !reader_done {
		if !terminate_requested && let Err(err) = ct.heartbeat() {
			let message = err.to_string();
			timed_out = message.contains("Timeout");
			cancelled = !timed_out;
			terminate_pty_processes(&mut child, child_pid, process_group_id);
			terminate_requested = true;
			reader_drain_deadline = Some(Instant::now() + POST_CANCEL_DRAIN_TIMEOUT);
		}

		for _ in 0..CONTROL_MESSAGES_PER_TICK {
			match control_rx.try_recv() {
				Ok(ControlMessage::Input(data)) => {
					let _ = writer.write_all(data.as_bytes());
					let _ = writer.flush();
				},
				Ok(ControlMessage::Resize { cols, rows }) => {
					let _ = master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
				},
				Ok(ControlMessage::Kill) => {
					cancelled = true;
					if !terminate_requested {
						terminate_pty_processes(&mut child, child_pid, process_group_id);
						terminate_requested = true;
						reader_drain_deadline = Some(Instant::now() + POST_CANCEL_DRAIN_TIMEOUT);
					}
				},
				Err(flume::TryRecvError::Empty | flume::TryRecvError::Disconnected) => break,
			}
		}

		for _ in 0..READER_EVENTS_PER_TICK {
			match reader_rx.try_recv() {
				Ok(ReaderEvent::Chunk(chunk)) => emit_chunk(&chunk, on_chunk.as_ref()),
				Ok(ReaderEvent::Done) => {
					reader_done = true;
					break;
				},
				Err(flume::TryRecvError::Empty) => break,
				Err(flume::TryRecvError::Disconnected) => {
					reader_done = true;
					break;
				},
			}
		}
		if exit_code.is_none()
			&& let Some(status) = child
				.try_wait()
				.map_err(|err| Error::from_reason(format!("Failed checking PTY status: {err}")))?
		{
			exit_code = Some(i32::try_from(status.exit_code()).unwrap_or(i32::MAX));
			if !reader_done && reader_drain_deadline.is_none() {
				reader_drain_deadline = Some(Instant::now() + POST_EXIT_DRAIN_TIMEOUT);
			}
		}

		if let Some(deadline) = reader_drain_deadline
			&& Instant::now() >= deadline
		{
			break;
		}
		if exit_code.is_none() || !reader_done {
			let wait_duration = reader_drain_deadline.map_or(Duration::from_millis(16), |deadline| {
				deadline
					.saturating_duration_since(Instant::now())
					.min(Duration::from_millis(16))
			});
			match reader_rx.recv_timeout(wait_duration) {
				Ok(ReaderEvent::Chunk(chunk)) => emit_chunk(&chunk, on_chunk.as_ref()),
				Ok(ReaderEvent::Done) => reader_done = true,
				Err(flume::RecvTimeoutError::Timeout) => {},
				Err(flume::RecvTimeoutError::Disconnected) => {
					reader_done = true;
					if exit_code.is_none() {
						std::thread::sleep(wait_duration);
					}
				},
			}
		}
	}
	if exit_code.is_none() {
		if terminate_requested {
			let deadline = Instant::now() + CANCEL_REAP_TIMEOUT;
			while exit_code.is_none() {
				if let Some(status) = child
					.try_wait()
					.map_err(|err| Error::from_reason(format!("Failed checking PTY status: {err}")))?
				{
					exit_code = Some(i32::try_from(status.exit_code()).unwrap_or(i32::MAX));
					break;
				}
				if Instant::now() >= deadline {
					break;
				}
				std::thread::sleep(CANCEL_REAP_POLL_INTERVAL);
			}
			if exit_code.is_none() {
				std::thread::spawn(move || {
					let _ = child.wait();
				});
			}
		} else {
			let status = child
				.wait()
				.map_err(|err| Error::from_reason(format!("Failed waiting PTY process: {err}")))?;
			exit_code = Some(i32::try_from(status.exit_code()).unwrap_or(i32::MAX));
		}
	}

	drop(writer);

	if !reader_done {
		let drain_timeout = FINAL_READER_DRAIN_TIMEOUT;
		let finalize_deadline = Instant::now() + drain_timeout;
		while Instant::now() < finalize_deadline {
			let remaining = finalize_deadline.saturating_duration_since(Instant::now());
			let wait_duration = remaining.min(Duration::from_millis(5));
			match reader_rx.recv_timeout(wait_duration) {
				Ok(ReaderEvent::Chunk(chunk)) => emit_chunk(&chunk, on_chunk.as_ref()),
				Ok(ReaderEvent::Done) => {
					reader_done = true;
					break;
				},
				Err(flume::RecvTimeoutError::Timeout) => {},
				Err(flume::RecvTimeoutError::Disconnected) => {
					reader_done = true;
					break;
				},
			}
		}
	}

	drop(master);

	if reader_done {
		let _ = reader_thread.join();
	}
	Ok(PtyRunResult { exit_code, cancelled, timed_out })
}

fn emit_chunk(text: &str, callback: Option<&ThreadsafeFunction<String>>) {
	if let Some(callback) = callback {
		callback.call(Ok(text.to_string()), ThreadsafeFunctionCallMode::NonBlocking);
	}
}
