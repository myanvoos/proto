use std::{
	collections::HashMap,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	time::Duration,
};

use napi::{
	Env, Result, Status,
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, UnknownReturnValue},
};
use napi_derive::napi;
use pi_shell::{
	FsObservation as CoreFsObservation, FsObservationKind as CoreFsObservationKind,
	MinimizerResult as CoreMinimizerResult, ProtolensDispatchFuture, ProtolensDispatchRequest,
	ProtolensDispatchResponse, ProtolensDispatcher, Shell as CoreShell,
	ShellExecuteOptions as CoreShellExecuteOptions, ShellOptions as CoreShellOptions,
	ShellRunOptions as CoreShellRunOptions, ShellRunResult as CoreShellRunResult,
	execute_shell as core_execute_shell, minimizer,
};

use crate::task;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireProtolensDispatchResponse {
	stdout:    String,
	stderr:    String,
	exit_code: i32,
	record:    Option<String>,
}

struct NapiProtolensDispatcher {
	callback: Arc<ThreadsafeFunction<String, Promise<String>, String, Status, false, true>>,
}

impl ProtolensDispatcher for NapiProtolensDispatcher {
	fn dispatch(&self, request: ProtolensDispatchRequest) -> ProtolensDispatchFuture {
		let callback = Arc::clone(&self.callback);
		Box::pin(async move {
			let payload = serde_json::to_string(&request)
				.map_err(|error| anyhow::anyhow!("failed to encode protolens request: {error}"))?;
			let promise = callback
				.call_async(payload)
				.await
				.map_err(|error| anyhow::anyhow!("protolens dispatcher callback failed: {error}"))?;
			let response_json = promise
				.await
				.map_err(|error| anyhow::anyhow!("protolens dispatcher promise rejected: {error}"))?;
			let response: WireProtolensDispatchResponse = serde_json::from_str(&response_json)
				.map_err(|error| anyhow::anyhow!("invalid protolens dispatcher response: {error}"))?;
			Ok(ProtolensDispatchResponse {
				stdout:    response.stdout,
				stderr:    response.stderr,
				exit_code: response.exit_code,
				record:    response.record,
			})
		})
	}
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct MinimizerOptions {
	pub enabled: Option<bool>,

	pub settings_path: Option<String>,

	pub settings_hash: Option<String>,

	pub only: Option<Vec<String>>,

	pub except: Option<Vec<String>>,

	pub max_capture_bytes: Option<u32>,

	pub source_outline_level: Option<String>,

	pub legacy_filters: Option<bool>,
}

impl From<MinimizerOptions> for minimizer::MinimizerOptions {
	fn from(value: MinimizerOptions) -> Self {
		Self {
			enabled:              value.enabled,
			settings_path:        value.settings_path,
			settings_hash:        value.settings_hash,
			only:                 value.only,
			except:               value.except,
			max_capture_bytes:    value.max_capture_bytes,
			source_outline_level: value.source_outline_level,
			legacy_filters:       value.legacy_filters,
		}
	}
}

#[napi(object)]
pub struct ShellOptions {
	pub session_env: Option<HashMap<String, String>>,

	pub snapshot_path: Option<String>,

	pub minimizer: Option<MinimizerOptions>,
}

impl From<ShellOptions> for CoreShellOptions {
	fn from(value: ShellOptions) -> Self {
		Self {
			session_env:   value.session_env,
			snapshot_path: value.snapshot_path,
			minimizer:     value.minimizer.map(Into::into),
			filesystem:    pi_vfs::Fs::native(),
		}
	}
}

#[napi(object)]
pub struct ShellRunOptions<'env> {
	pub command: String,

	pub cwd: Option<String>,

	pub env: Option<HashMap<String, String>>,

	pub timeout_ms: Option<u32>,

	pub protolens_call_id: Option<String>,

	pub signal: Option<Unknown<'env>>,
}

#[napi(object)]
pub struct ShellExecuteOptions<'env> {
	pub command: String,

	pub cwd: Option<String>,

	pub env: Option<HashMap<String, String>>,

	pub session_env: Option<HashMap<String, String>>,

	pub timeout_ms: Option<u32>,

	pub snapshot_path: Option<String>,

	pub minimizer: Option<MinimizerOptions>,

	pub signal: Option<Unknown<'env>>,
}

#[napi(object)]
pub struct MinimizerResult {
	pub filter: String,

	pub text: String,

	pub original_text: String,

	pub input_bytes: u32,

	pub output_bytes: u32,
}

impl From<CoreMinimizerResult> for MinimizerResult {
	fn from(value: CoreMinimizerResult) -> Self {
		Self {
			filter:        value.filter,
			text:          value.text,
			original_text: value.original_text,
			input_bytes:   value.input_bytes,
			output_bytes:  value.output_bytes,
		}
	}
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum FsObservationKind {
	#[napi(value = "read")]
	Read,

	#[napi(value = "write")]
	Write,
}

impl From<CoreFsObservationKind> for FsObservationKind {
	fn from(value: CoreFsObservationKind) -> Self {
		match value {
			CoreFsObservationKind::Read => Self::Read,
			CoreFsObservationKind::Write => Self::Write,
		}
	}
}

#[napi(object)]
pub struct FileMutation {
	pub existed: bool,
	pub exists:  bool,
	pub before:  Option<String>,
	pub after:   Option<String>,
}

#[napi(object)]
pub struct FsObservation {
	pub path: String,

	pub kind: FsObservationKind,

	pub mtime_ns: Option<String>,

	pub size: Option<f64>,

	pub mutation: Option<FileMutation>,
}

impl From<CoreFsObservation> for FsObservation {
	fn from(value: CoreFsObservation) -> Self {
		Self {
			path:     value.path,
			kind:     value.kind.into(),
			mtime_ns: value.mtime_ns.map(|mtime_ns| mtime_ns.to_string()),
			size:     value.size.map(|size| size as f64),
			mutation: value.mutation.map(|mutation| FileMutation {
				existed: mutation.existed,
				exists:  mutation.exists,
				before:  mutation.before,
				after:   mutation.after,
			}),
		}
	}
}

#[napi(object)]
pub struct ShellRunResult {
	pub exit_code: Option<i32>,

	pub cancelled: bool,

	pub timed_out: bool,

	pub minimized: Option<MinimizerResult>,

	pub working_dir: Option<String>,

	pub fs_observations: Vec<FsObservation>,

	pub protolens_dispatches: Vec<String>,
	pub stage_records:        Vec<String>,
}

impl From<CoreShellRunResult> for ShellRunResult {
	fn from(value: CoreShellRunResult) -> Self {
		Self {
			exit_code:            value.exit_code,
			cancelled:            value.cancelled,
			timed_out:            value.timed_out,
			minimized:            value.minimized.map(Into::into),
			working_dir:          value.working_dir,
			fs_observations:      value.fs_observations.into_iter().map(Into::into).collect(),
			protolens_dispatches: value.protolens_dispatches,
			stage_records:        value.stage_records,
		}
	}
}

#[napi]
pub struct Shell {
	inner: Arc<CoreShell>,
}

#[napi]
impl Shell {
	#[napi(catch_unwind, constructor)]
	pub fn new(options: Option<ShellOptions>) -> Self {
		Self { inner: Arc::new(CoreShell::new(options.map(Into::into))) }
	}

	#[napi(catch_unwind)]
	pub fn run<'env>(
		&self,
		env: &'env Env,
		options: ShellRunOptions<'env>,
		#[napi(ts_arg_type = "((error: Error | null, chunk: string) => void) | undefined | null")]
		on_chunk: Option<ThreadsafeFunction<String, UnknownReturnValue>>,
		#[napi(ts_arg_type = "((request: string) => Promise<string>) | undefined | null")]
		protolens_dispatcher: Option<
			ThreadsafeFunction<String, Promise<String>, String, Status, false, true>,
		>,
	) -> Result<PromiseRaw<'env, ShellRunResult>> {
		let cancel_token = task::CancelToken::new(options.timeout_ms, options.signal);
		let inner = Arc::clone(&self.inner);
		let dispatcher = protolens_dispatcher.map(|callback| {
			Arc::new(NapiProtolensDispatcher { callback: Arc::new(callback) })
				as Arc<dyn ProtolensDispatcher>
		});
		let protolens_call_id = options.protolens_call_id.clone();
		let run_options = CoreShellRunOptions {
			command:    options.command,
			cwd:        options.cwd,
			env:        options.env,
			timeout_ms: options.timeout_ms,
			filesystem: None,
			pipe_taps:  None,
			trace:      None,
		};
		task::future(env, "shell.run", async move {
			let (chunk_tx, drain_handle) = bridge_chunks(on_chunk);
			let result = inner
				.run(run_options, chunk_tx, dispatcher, protolens_call_id, cancel_token.into_core())
				.await
				.map(Into::into)
				.map_err(|err| Error::from_reason(err.to_string()));
			await_drain(drain_handle, &result).await;
			result
		})
	}

	#[napi]
	pub async fn abort(&self) -> Result<()> {
		self.inner.abort().await;
		Ok(())
	}

	#[napi]
	pub async fn close(&self) -> Result<()> {
		self.inner.close().await;
		Ok(())
	}

	#[napi(catch_unwind)]
	pub fn force_close(&self) -> Result<()> {
		if self.inner.force_close() {
			Ok(())
		} else {
			Err(napi::Error::from_reason("Shell force-close could not acquire a process target"))
		}
	}

	#[napi]
	pub async fn live_background_job_count(&self) -> u32 {
		self.inner.live_background_job_count().await
	}
}

#[napi(catch_unwind)]
pub fn execute_shell<'env>(
	env: &'env Env,
	options: ShellExecuteOptions<'env>,
	#[napi(ts_arg_type = "((error: Error | null, chunk: string) => void) | undefined | null")]
	on_chunk: Option<ThreadsafeFunction<String, UnknownReturnValue>>,
) -> Result<PromiseRaw<'env, ShellRunResult>> {
	let cancel_token = task::CancelToken::new(options.timeout_ms, options.signal);
	let exec_options = CoreShellExecuteOptions {
		command:       options.command,
		cwd:           options.cwd,
		env:           options.env,
		session_env:   options.session_env,
		timeout_ms:    options.timeout_ms,
		snapshot_path: options.snapshot_path,
		minimizer:     options.minimizer.map(Into::into),
		filesystem:    pi_vfs::Fs::native(),
	};
	task::future(env, "shell.execute", async move {
		let (chunk_tx, drain_handle) = bridge_chunks(on_chunk);
		let result = core_execute_shell(exec_options, chunk_tx, cancel_token.into_core())
			.await
			.map(Into::into)
			.map_err(|err| Error::from_reason(err.to_string()));
		await_drain(drain_handle, &result).await;
		result
	})
}

pub(crate) const BRIDGE_QUEUE_CHUNKS: usize = 64;
pub(crate) const FORWARD_STALL_TIMEOUT: Duration = Duration::from_secs(30);

fn bridge_chunks(
	on_chunk: Option<ThreadsafeFunction<String, UnknownReturnValue>>,
) -> (Option<flume::Sender<String>>, Option<napi::tokio::task::JoinHandle<()>>) {
	let Some(on_chunk) = on_chunk else {
		return (None, None);
	};
	let (tx, rx) = flume::bounded::<String>(BRIDGE_QUEUE_CHUNKS);
	let handle = napi::tokio::spawn(pump_chunks(
		rx,
		FORWARD_STALL_TIMEOUT,
		None,
		async move |payload: String| on_chunk.call_async(Ok(payload)).await.is_ok(),
	));
	(Some(tx), Some(handle))
}

pub(crate) trait BridgeItem {
	/// The output text, or `None` for an explicit end-of-output marker. The
	/// marker ends the pump even while a sender clone is still alive (the PTY
	/// keeps one to inspect queue depth).
	fn into_text(self) -> Option<String>;
}

impl BridgeItem for String {
	fn into_text(self) -> Option<String> {
		Some(self)
	}
}

/// Drain `rx`, greedily coalescing queued chunks into ≤64 KiB batches, and
/// feed each batch to `forward`, awaiting its completion before pulling more.
/// Returns when `rx` disconnects (all senders dropped), on an end-of-output
/// item, when `forward` reports the consumer is gone, or when a single
/// `forward` stalls past `stall_timeout` (a wedged JS consumer). In every case
/// dropping `rx` disconnects the channel so parked/future senders fail fast and
/// the readers keep draining the child instead of wedging it (#12657).
///
/// `busy` is held from the moment a chunk is taken until its batch has been
/// forwarded, so an empty queue with `busy` clear really means no output is
/// in transit (the PTY's stuck-open-slave check).
pub(crate) async fn pump_chunks<T: BridgeItem>(
	rx: flume::Receiver<T>,
	stall_timeout: Duration,
	busy: Option<&AtomicBool>,
	mut forward: impl AsyncFnMut(String) -> bool,
) {
	// Hard cap on one coalesced batch so the JS main thread never sees a
	// multi-MB napi callback (a giant single string would stall sanitize +
	// tail-buffer maintenance for the whole copy).
	const MAX_BATCH_BYTES: usize = 64 * 1024;
	// Initial capacity sized for typical bursty pipe output. Re-allocated
	// each batch because `String` ownership is moved into the napi call.
	const INITIAL_BATCH_CAP: usize = 8 * 1024;
	let set_busy = |value: bool| {
		if let Some(busy) = busy {
			busy.store(value, Ordering::Release);
		}
	};
	let mut batch = String::with_capacity(INITIAL_BATCH_CAP);
	let mut ended = false;
	while !ended
		&& let Ok(first) = rx.recv_async().await
		&& let Some(first) = first.into_text()
	{
		set_busy(true);
		batch.push_str(&first);
		// Greedily drain everything already queued. Child processes that
		// write byte-at-a-time (printf-style progress, llama-cli token
		// streams) otherwise produce one napi callback per `write(2)`,
		// saturating the JS main thread (~200% CPU observed) and leaving
		// the queue draining long after the child exits.
		while batch.len() < MAX_BATCH_BYTES {
			match rx.try_recv().map(BridgeItem::into_text) {
				Ok(Some(more)) => batch.push_str(&more),
				Ok(None) => {
					ended = true;
					break;
				},
				Err(_) => break,
			}
		}
		let payload = std::mem::replace(&mut batch, String::with_capacity(INITIAL_BATCH_CAP));
		// A single napi `call_async` that never returns (a wedged JS consumer)
		// must not park the pump forever: that keeps the bridge queue full, the
		// reader parked on its send, and the child blocked in `write(2)` so it
		// never exits and the run never settles (#12657). Bound each forward;
		// on a stall, return so `rx` drops and the bridge disconnects,
		// unblocking the reader and child. The deadline resets per forward, so a
		// slow-but-progressing consumer still drains losslessly.
		let forwarded = napi::tokio::time::timeout(stall_timeout, forward(payload)).await;
		set_busy(false);
		if !matches!(forwarded, Ok(true)) {
			return;
		}
	}
}

/// Upper bound on how long to wait for the chunk-forwarding pump after an
/// interrupted run resolves. Native cancellation may detach a pipe reader whose
/// sender never closes when a grandchild inherited stdout; waiting for channel
/// disconnect would then wedge the run promise past its requested timeout
/// (#10308). Successful and failed runs remain unbounded so every chunk already
/// accepted by the bridge reaches JavaScript before the result resolves.
const INTERRUPTED_DRAIN_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

/// Finish forwarding accepted output after a native shell run resolves.
///
/// Normal completion and errors drain without a deadline to preserve every
/// accepted chunk. Cancellation and timeout are bounded because an orphaned
/// pipe reader can otherwise keep a sender alive forever; aborting the pump
/// drops its `flume::Receiver`, disconnecting that reader.
async fn await_drain(
	handle: Option<napi::tokio::task::JoinHandle<()>>,
	result: &Result<ShellRunResult>,
) {
	let Some(mut handle) = handle else {
		return;
	};
	if !matches!(result, Ok(result) if result.cancelled || result.timed_out) {
		let _ = handle.await;
		return;
	}
	if napi::tokio::time::timeout(INTERRUPTED_DRAIN_SHUTDOWN_TIMEOUT, &mut handle)
		.await
		.is_err()
	{
		handle.abort();
		let _ = handle.await;
	}
}

#[cfg(test)]
mod tests {
	use std::{
		sync::{
			Arc,
			atomic::{AtomicBool, Ordering},
		},
		time::{Duration, Instant},
	};

	use tokio::time;

	use super::*;

	#[tokio::test(flavor = "multi_thread")]
	async fn wedged_forward_disconnects_output_readers() {
		let (tx, rx) = flume::bounded::<String>(1);
		tx.send("first".into()).unwrap();
		let pump = tokio::spawn(pump_chunks(rx, Duration::from_millis(25), None, async |_| {
			std::future::pending::<bool>().await
		}));
		time::timeout(Duration::from_secs(2), pump)
			.await
			.unwrap()
			.unwrap();
		assert!(tx.send_async("late".into()).await.is_err());
	}

	fn run_result(cancelled: bool, timed_out: bool) -> ShellRunResult {
		ShellRunResult {
			exit_code: Some(0),
			cancelled,
			timed_out,
			minimized: None,
			working_dir: None,
			fs_observations: Vec::new(),
			protolens_dispatches: Vec::new(),
			stage_records: Vec::new(),
		}
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn interrupted_drain_disconnects_an_orphaned_output_sender() {
		let (tx, rx) = flume::bounded::<String>(BRIDGE_QUEUE_CHUNKS);
		let orphan = tx.clone();
		let handle = napi::tokio::spawn(pump_chunks(
			rx,
			FORWARD_STALL_TIMEOUT,
			None,
			async |_payload: String| true,
		));
		drop(tx);
		let started = Instant::now();
		let result = Ok(run_result(false, true));
		time::timeout(
			INTERRUPTED_DRAIN_SHUTDOWN_TIMEOUT + Duration::from_secs(1),
			await_drain(Some(handle), &result),
		)
		.await
		.expect("a timed-out run must not hang on inherited output handles");
		assert!(started.elapsed() >= INTERRUPTED_DRAIN_SHUTDOWN_TIMEOUT);
		assert!(orphan.send("late".to_string()).is_err(), "aborting drain must disconnect readers");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn successful_drain_preserves_accepted_output() {
		let (tx, rx) = flume::bounded::<String>(BRIDGE_QUEUE_CHUNKS);
		let forwarded = Arc::new(AtomicBool::new(false));
		let observed = Arc::clone(&forwarded);
		let handle = napi::tokio::spawn(pump_chunks(
			rx,
			FORWARD_STALL_TIMEOUT,
			None,
			async move |_payload: String| {
				time::sleep(Duration::from_millis(25)).await;
				observed.store(true, Ordering::Release);
				true
			},
		));
		tx.send("accepted".to_string())
			.expect("pump should be connected");
		drop(tx);
		let result = Ok(run_result(false, false));
		await_drain(Some(handle), &result).await;
		assert!(forwarded.load(Ordering::Acquire), "success must not drop accepted output");
	}
}
