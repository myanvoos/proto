use std::{collections::HashMap, sync::Arc, time::Duration};

use napi::{
	Env, Result, Status,
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, UnknownReturnValue},
};
use napi_derive::napi;
use pi_shell::{
	FsObservation as CoreFsObservation, FsObservationKind as CoreFsObservationKind,
	MinimizerResult as CoreMinimizerResult, Shell as CoreShell,
	ShellExecuteOptions as CoreShellExecuteOptions, ShellOptions as CoreShellOptions,
	ShellRunOptions as CoreShellRunOptions, ShellRunResult as CoreShellRunResult, XdDispatchFuture,
	XdDispatchRequest, XdDispatchResponse, XdDispatcher, execute_shell as core_execute_shell,
	minimizer,
};

use crate::task;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireXdDispatchResponse {
	stdout:    String,
	stderr:    String,
	exit_code: i32,
	record:    Option<String>,
}

struct NapiXdDispatcher {
	callback: Arc<ThreadsafeFunction<String, Promise<String>, String, Status, false, true>>,
}

impl XdDispatcher for NapiXdDispatcher {
	fn dispatch(&self, request: XdDispatchRequest) -> XdDispatchFuture {
		let callback = Arc::clone(&self.callback);
		Box::pin(async move {
			let payload = serde_json::to_string(&request)
				.map_err(|error| anyhow::anyhow!("failed to encode xd request: {error}"))?;
			let promise = callback
				.call_async(payload)
				.await
				.map_err(|error| anyhow::anyhow!("xd dispatcher callback failed: {error}"))?;
			let response_json = promise
				.await
				.map_err(|error| anyhow::anyhow!("xd dispatcher promise rejected: {error}"))?;
			let response: WireXdDispatchResponse = serde_json::from_str(&response_json)
				.map_err(|error| anyhow::anyhow!("invalid xd dispatcher response: {error}"))?;
			Ok(XdDispatchResponse {
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
		}
	}
}

#[napi(object)]
pub struct ShellRunOptions<'env> {
	pub command: String,

	pub cwd: Option<String>,

	pub env: Option<HashMap<String, String>>,

	pub timeout_ms: Option<u32>,

	pub xd_call_id: Option<String>,

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
pub struct FsObservation {
	pub path: String,

	pub kind: FsObservationKind,

	pub mtime_ns: Option<String>,

	pub size: Option<f64>,
}

impl From<CoreFsObservation> for FsObservation {
	fn from(value: CoreFsObservation) -> Self {
		Self {
			path:     value.path,
			kind:     value.kind.into(),
			mtime_ns: value.mtime_ns.map(|mtime_ns| mtime_ns.to_string()),
			size:     value.size.map(|size| size as f64),
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

	pub xd_dispatches: Vec<String>,
}

impl From<CoreShellRunResult> for ShellRunResult {
	fn from(value: CoreShellRunResult) -> Self {
		Self {
			exit_code:       value.exit_code,
			cancelled:       value.cancelled,
			timed_out:       value.timed_out,
			minimized:       value.minimized.map(Into::into),
			working_dir:     value.working_dir,
			fs_observations: value.fs_observations.into_iter().map(Into::into).collect(),
			xd_dispatches:   value.xd_dispatches,
		}
	}
}

#[napi]
pub struct Shell {
	inner: Arc<CoreShell>,
}

#[napi]
impl Shell {
	#[napi(constructor)]
	pub fn new(options: Option<ShellOptions>) -> Self {
		Self { inner: Arc::new(CoreShell::new(options.map(Into::into))) }
	}

	#[napi]
	pub fn run<'env>(
		&self,
		env: &'env Env,
		options: ShellRunOptions<'env>,
		#[napi(ts_arg_type = "((error: Error | null, chunk: string) => void) | undefined | null")]
		on_chunk: Option<ThreadsafeFunction<String, UnknownReturnValue>>,
		#[napi(ts_arg_type = "((request: string) => Promise<string>) | undefined | null")]
		xd_dispatcher: Option<
			ThreadsafeFunction<String, Promise<String>, String, Status, false, true>,
		>,
	) -> Result<PromiseRaw<'env, ShellRunResult>> {
		let cancel_token = task::CancelToken::new(options.timeout_ms, options.signal);
		let inner = Arc::clone(&self.inner);
		let dispatcher = xd_dispatcher.map(|callback| {
			Arc::new(NapiXdDispatcher { callback: Arc::new(callback) }) as Arc<dyn XdDispatcher>
		});
		inner.set_xd_dispatcher(dispatcher, options.xd_call_id.clone());
		let run_options = CoreShellRunOptions {
			command:    options.command,
			cwd:        options.cwd,
			env:        options.env,
			timeout_ms: options.timeout_ms,
		};
		task::future(env, "shell.run", async move {
			let (chunk_tx, drain_handle) = bridge_chunks(on_chunk);
			let result = inner
				.run(run_options, chunk_tx, cancel_token.into_core())
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

	#[napi]
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

#[napi]
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

const BRIDGE_QUEUE_CHUNKS: usize = 64;

fn bridge_chunks(
	on_chunk: Option<ThreadsafeFunction<String, UnknownReturnValue>>,
) -> (Option<flume::Sender<String>>, Option<napi::tokio::task::JoinHandle<()>>) {
	let Some(on_chunk) = on_chunk else {
		return (None, None);
	};
	let (tx, rx) = flume::bounded::<String>(BRIDGE_QUEUE_CHUNKS);
	let handle = napi::tokio::spawn(pump_chunks(rx, async move |payload: String| {
		on_chunk.call_async(Ok(payload)).await.is_ok()
	}));
	(Some(tx), Some(handle))
}

async fn pump_chunks(rx: flume::Receiver<String>, mut forward: impl AsyncFnMut(String) -> bool) {
	const MAX_BATCH_BYTES: usize = 64 * 1024;

	const INITIAL_BATCH_CAP: usize = 8 * 1024;
	let mut batch = String::with_capacity(INITIAL_BATCH_CAP);
	while let Ok(first) = rx.recv_async().await {
		batch.push_str(&first);

		while batch.len() < MAX_BATCH_BYTES {
			match rx.try_recv() {
				Ok(more) => batch.push_str(&more),
				Err(_) => break,
			}
		}
		let payload = std::mem::replace(&mut batch, String::with_capacity(INITIAL_BATCH_CAP));
		if !forward(payload).await {
			return;
		}
	}
}
const INTERRUPTED_DRAIN_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

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

	fn run_result(cancelled: bool, timed_out: bool) -> ShellRunResult {
		ShellRunResult {
			exit_code: Some(0),
			cancelled,
			timed_out,
			minimized: None,
			working_dir: None,
			fs_observations: Vec::new(),
			xd_dispatches: Vec::new(),
		}
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn interrupted_drain_disconnects_an_orphaned_output_sender() {
		let (tx, rx) = flume::bounded::<String>(BRIDGE_QUEUE_CHUNKS);
		let orphan = tx.clone();
		let handle = napi::tokio::spawn(pump_chunks(rx, async |_payload: String| true));
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
		let handle = napi::tokio::spawn(pump_chunks(rx, async move |_payload: String| {
			time::sleep(Duration::from_millis(25)).await;
			observed.store(true, Ordering::Release);
			true
		}));
		tx.send("accepted".to_string())
			.expect("pump should be connected");
		drop(tx);
		let result = Ok(run_result(false, false));
		await_drain(Some(handle), &result).await;
		assert!(forwarded.load(Ordering::Acquire), "success must not drop accepted output");
	}
}
