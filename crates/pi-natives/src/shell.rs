use std::{collections::HashMap, sync::Arc};

use napi::{
	Env, Result,
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, UnknownReturnValue},
};
use napi_derive::napi;
use pi_shell::{
	MinimizerResult as CoreMinimizerResult, Shell as CoreShell,
	ShellExecuteOptions as CoreShellExecuteOptions, ShellOptions as CoreShellOptions,
	ShellRunOptions as CoreShellRunOptions, ShellRunResult as CoreShellRunResult,
	execute_shell as core_execute_shell, minimizer,
};

use crate::task;

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

#[napi(object)]
pub struct ShellRunResult {
	pub exit_code: Option<i32>,

	pub cancelled: bool,

	pub timed_out: bool,

	pub minimized: Option<MinimizerResult>,

	pub working_dir: Option<String>,
}

impl From<CoreShellRunResult> for ShellRunResult {
	fn from(value: CoreShellRunResult) -> Self {
		Self {
			exit_code:   value.exit_code,
			cancelled:   value.cancelled,
			timed_out:   value.timed_out,
			minimized:   value.minimized.map(Into::into),
			working_dir: value.working_dir,
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
	) -> Result<PromiseRaw<'env, ShellRunResult>> {
		let cancel_token = task::CancelToken::new(options.timeout_ms, options.signal);
		let inner = Arc::clone(&self.inner);
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
			if let Some(handle) = drain_handle {
				let _ = handle.await;
			}
			result
		})
	}

	#[napi]
	pub async fn abort(&self) -> Result<()> {
		self.inner.abort().await;
		Ok(())
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
		if let Some(handle) = drain_handle {
			let _ = handle.await;
		}
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
