use std::{
	collections::HashMap,
	fs,
	io::{self},
	str,
	sync::Arc,
	time::Duration,
};

use anyhow::{Error, Result};
use brush_core::{
	ExecutionControlFlow, ExecutionExitCode, ExecutionParameters, ExecutionResult,
	ProcessGroupPolicy, ProfileLoadBehavior, RcLoadBehavior, Shell as BrushShell, ShellValue,
	ShellVariable, SourceInfo, SpawnObserver,
	env::EnvironmentScope,
	openfiles::{self, OpenFile, OpenFiles},
};
use bytes::Bytes;
use flume::Sender;
use pi_builtins::{BuiltinSet, default_builtins};
#[cfg(not(unix))]
use tokio::io::AsyncReadExt as _;
use tokio::{sync::Mutex as TokioMutex, time};
use tokio_util::sync::CancellationToken;

use crate::{
	cancel::{AbortReason, AbortToken, CancelToken},
	minimizer, process,
};

struct ShellSessionCore {
	shell: BrushShell,
}

impl Drop for ShellSessionCore {
	fn drop(&mut self) {
		terminate_internal_background_jobs(&mut self.shell);
	}
}

#[derive(Clone, Default)]
struct ShellAbortState(Arc<TokioMutex<Option<AbortToken>>>);

impl ShellAbortState {
	async fn set(&self, abort_token: AbortToken) {
		*self.0.lock().await = Some(abort_token);
	}

	async fn clear(&self) {
		*self.0.lock().await = None;
	}

	async fn abort(&self) {
		let abort_token = self.0.lock().await.clone();
		if let Some(abort_token) = abort_token {
			abort_token.abort(AbortReason::Signal);
		}
	}
}

fn shell_working_dir_matches(shell: &BrushShell, cwd: &str) -> bool {
	let requested = std::path::Path::new(cwd);
	if !requested.is_absolute() {
		return false;
	}
	let current = shell.working_dir();
	current == requested
}

fn set_shell_working_dir_if_changed(shell: &mut BrushShell, cwd: &str) -> Result<()> {
	if shell_working_dir_matches(shell, cwd) {
		return Ok(());
	}
	shell
		.set_working_dir(cwd)
		.map_err(|err| Error::msg(format!("Failed to set cwd: {err}")))
}

#[derive(Clone)]
struct ShellConfig {
	session_env:   Option<HashMap<String, String>>,
	snapshot_path: Option<String>,
	minimizer:     Option<minimizer::MinimizerConfig>,
}

#[derive(Debug, Clone, Default)]
pub struct ShellOptions {
	pub session_env:   Option<HashMap<String, String>>,
	pub snapshot_path: Option<String>,
	pub minimizer:     Option<minimizer::MinimizerOptions>,
}

struct ShellRunConfig {
	command:   String,
	cwd:       Option<String>,
	env:       Option<HashMap<String, String>>,
	minimizer: Option<minimizer::MinimizerConfig>,
}

#[derive(Debug, Clone, Default)]
pub struct ShellRunOptions {
	pub command:    String,
	pub cwd:        Option<String>,
	pub env:        Option<HashMap<String, String>>,
	pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MinimizerResult {
	pub filter:        String,
	pub text:          String,
	pub original_text: String,
	pub input_bytes:   u32,
	pub output_bytes:  u32,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ShellRunResult {
	pub exit_code:   Option<i32>,
	pub cancelled:   bool,
	pub timed_out:   bool,
	pub minimized:   Option<MinimizerResult>,
	pub working_dir: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ShellExecuteOptions {
	pub command:       String,
	pub cwd:           Option<String>,
	pub env:           Option<HashMap<String, String>>,
	pub session_env:   Option<HashMap<String, String>>,
	pub timeout_ms:    Option<u32>,
	pub snapshot_path: Option<String>,
	pub minimizer:     Option<minimizer::MinimizerOptions>,
}

pub type ShellExecuteResult = ShellRunResult;

pub struct Shell {
	session:     Arc<TokioMutex<Option<ShellSessionCore>>>,
	abort_state: ShellAbortState,
	config:      ShellConfig,
}

impl Shell {
	#[must_use]
	pub fn new(options: Option<ShellOptions>) -> Self {
		let config = match options {
			None => ShellConfig { session_env: None, snapshot_path: None, minimizer: None },
			Some(opt) => {
				let minimizer = opt
					.minimizer
					.as_ref()
					.map(minimizer::MinimizerConfig::from_options);
				ShellConfig {
					session_env: opt.session_env,
					snapshot_path: opt.snapshot_path,
					minimizer,
				}
			},
		};
		Self {
			session: Arc::new(TokioMutex::new(None)),
			abort_state: ShellAbortState::default(),
			config,
		}
	}

	pub async fn run(
		&self,
		options: ShellRunOptions,
		on_chunk: Option<Sender<String>>,
		mut cancel_token: CancelToken,
	) -> Result<ShellRunResult> {
		let run_config = ShellRunConfig {
			command:   options.command,
			cwd:       options.cwd,
			env:       options.env,
			minimizer: self.config.minimizer.clone(),
		};
		run_shell_session(
			self.session.clone(),
			self.abort_state.clone(),
			self.config.clone(),
			run_config,
			on_chunk,
			&mut cancel_token,
		)
		.await
	}

	pub async fn abort(&self) {
		self.abort_state.abort().await;
	}

	pub async fn live_background_job_count(&self) -> u32 {
		let mut guard = self.session.lock().await;
		let Some(core) = guard.as_mut() else {
			return 0;
		};
		let jobs = core.shell.jobs_mut();

		if jobs.poll().is_err() {
			return 0;
		}
		u32::try_from(
			jobs
				.jobs
				.iter()
				.filter(|job| job.representative_pid().is_some())
				.count(),
		)
		.unwrap_or(u32::MAX)
	}
}

pub async fn execute_shell(
	options: ShellExecuteOptions,
	on_chunk: Option<Sender<String>>,
	cancel_token: CancelToken,
) -> Result<ShellExecuteResult> {
	let minimizer = options
		.minimizer
		.as_ref()
		.map(minimizer::MinimizerConfig::from_options);
	let config = ShellConfig {
		session_env:   options.session_env,
		snapshot_path: options.snapshot_path,
		minimizer:     minimizer.clone(),
	};
	let run_config =
		ShellRunConfig { command: options.command, cwd: options.cwd, env: options.env, minimizer };
	run_shell_oneshot(config, run_config, on_chunk, cancel_token).await
}

#[derive(Default)]
pub struct StreamSinks {
	pub stdout: Option<Sender<Bytes>>,
	pub stderr: Option<Sender<Bytes>>,
}

pub async fn execute_shell_streams(
	options: ShellExecuteOptions,
	streams: StreamSinks,
	cancel_token: CancelToken,
) -> Result<ShellExecuteResult> {
	let config = ShellConfig {
		session_env:   options.session_env,
		snapshot_path: options.snapshot_path,
		minimizer:     None,
	};
	let run_config = ShellRunConfig {
		command:   options.command,
		cwd:       options.cwd,
		env:       options.env,
		minimizer: None,
	};
	run_shell_oneshot_streams(config, run_config, streams, cancel_token).await
}

async fn run_shell_session(
	session: Arc<TokioMutex<Option<ShellSessionCore>>>,
	abort_state: ShellAbortState,
	config: ShellConfig,
	run_config: ShellRunConfig,
	on_chunk: Option<Sender<String>>,
	ct: &mut CancelToken,
) -> Result<ShellRunResult> {
	let tokio_cancel = CancellationToken::new();
	let spawn_registry = Arc::new(process::SpawnRegistry::new());
	let process_cancel_bridge = tokio::spawn({
		let tokio_cancel = tokio_cancel.clone();
		let spawn_registry = spawn_registry.clone();
		async move {
			tokio_cancel.cancelled().await;
			terminate_run(&spawn_registry).await;
		}
	});

	let mut run_task = tokio::spawn({
		let session = session.clone();
		let abort_state = abort_state.clone();
		let tokio_cancel = tokio_cancel.clone();
		let at = ct.emplace_abort_token();
		let spawn_registry = spawn_registry.clone();
		async move {
			let mut session_guard = session.lock().await;

			let session = match &mut *session_guard {
				Some(session) => session,
				None => session_guard.insert(
					create_session_for_run(
						&config,
						Some(spawn_registry.clone()),
						Some(tokio_cancel.clone()),
					)
					.await?,
				),
			};
			abort_state.set(at).await;
			run_shell_command(session, &run_config, on_chunk, tokio_cancel, spawn_registry).await
		}
	});

	let res = tokio::select! {
		res = &mut run_task => res,
		reason = ct.wait() => {
			tokio_cancel.cancel();
			let graceful = time::timeout(Duration::from_secs(2), &mut run_task).await;
			if graceful.is_err() {
				run_task.abort();
				let _ = run_task.await;
			}
			abort_state.clear().await;



			if let Ok(mut guard) = session.try_lock() {
				*guard = None;
			}
			let _ = process_cancel_bridge.await;
			return Ok(ShellRunResult {
				exit_code:   None,
				cancelled:   matches!(reason, AbortReason::Signal),
				timed_out:   matches!(reason, AbortReason::Timeout),
				minimized:   None,
				working_dir: None,
			});
		}
	};
	let res =
		res.unwrap_or_else(|err| Err(Error::msg(format!("Shell execution task failed: {err}"))));
	process_cancel_bridge.abort();
	let _ = process_cancel_bridge.await;
	abort_state.clear().await;

	let keepalive = res.as_ref().is_ok_and(|(exec, ..)| session_keepalive(exec));
	if !keepalive {
		*session.lock().await = None;
	}
	let (exec, minimized, working_dir) = res?;
	Ok(ShellRunResult {
		exit_code: Some(exit_code(&exec)),
		cancelled: false,
		timed_out: false,
		working_dir,
		minimized,
	})
}

async fn run_shell_oneshot(
	config: ShellConfig,
	run_config: ShellRunConfig,
	on_chunk: Option<Sender<String>>,
	ct: CancelToken,
) -> Result<ShellExecuteResult> {
	let tokio_cancel = CancellationToken::new();
	let spawn_registry = Arc::new(process::SpawnRegistry::new());
	let process_cancel_bridge = tokio::spawn({
		let tokio_cancel = tokio_cancel.clone();
		let spawn_registry = spawn_registry.clone();
		async move {
			tokio_cancel.cancelled().await;
			terminate_run(&spawn_registry).await;
		}
	});

	let mut task = tokio::spawn({
		let tokio_cancel = tokio_cancel.clone();
		let spawn_registry = spawn_registry.clone();
		async move {
			let mut session = create_session_for_run(
				&config,
				Some(spawn_registry.clone()),
				Some(tokio_cancel.clone()),
			)
			.await?;
			run_shell_command(&mut session, &run_config, on_chunk, tokio_cancel, spawn_registry).await
		}
	});

	let run_result = tokio::select! {
		result = &mut task => result,
		reason = ct.wait() => {
			tokio_cancel.cancel();
			let graceful = time::timeout(Duration::from_secs(2), &mut task).await;
			if graceful.is_err() {
				task.abort();
				let _ = task.await;
			}
			let _ = process_cancel_bridge.await;
			return Ok(ShellExecuteResult {
				exit_code:   None,
				cancelled:   matches!(reason, AbortReason::Signal),
				timed_out:   matches!(reason, AbortReason::Timeout),
				minimized:   None,
				working_dir: None,
			});
		},
	};

	process_cancel_bridge.abort();
	let _ = process_cancel_bridge.await;
	let res = run_result
		.unwrap_or_else(|err| Err(Error::msg(format!("Shell execution task failed: {err}"))));
	let (exec, minimized, working_dir) = res?;
	Ok(ShellExecuteResult {
		exit_code: Some(exit_code(&exec)),
		cancelled: false,
		timed_out: false,
		working_dir,
		minimized,
	})
}

async fn run_shell_oneshot_streams(
	config: ShellConfig,
	run_config: ShellRunConfig,
	streams: StreamSinks,
	ct: CancelToken,
) -> Result<ShellExecuteResult> {
	let tokio_cancel = CancellationToken::new();
	let spawn_registry = Arc::new(process::SpawnRegistry::new());
	let process_cancel_bridge = tokio::spawn({
		let tokio_cancel = tokio_cancel.clone();
		let spawn_registry = spawn_registry.clone();
		async move {
			tokio_cancel.cancelled().await;
			terminate_run(&spawn_registry).await;
		}
	});

	let mut task = tokio::spawn({
		let tokio_cancel = tokio_cancel.clone();
		let spawn_registry = spawn_registry.clone();
		async move {
			let mut session = create_session_for_run(
				&config,
				Some(spawn_registry.clone()),
				Some(tokio_cancel.clone()),
			)
			.await?;
			run_shell_command_streams(&mut session, &run_config, streams, tokio_cancel, spawn_registry)
				.await
		}
	});

	let run_result = tokio::select! {
		result = &mut task => result,
		reason = ct.wait() => {
			tokio_cancel.cancel();
			let graceful = time::timeout(Duration::from_secs(2), &mut task).await;
			if graceful.is_err() {
				task.abort();
				let _ = task.await;
			}
			let _ = process_cancel_bridge.await;
			return Ok(ShellExecuteResult {
				exit_code: None,
				cancelled: matches!(reason, AbortReason::Signal),
				timed_out: matches!(reason, AbortReason::Timeout),
				minimized: None,
				working_dir: None,
			});
		},
	};

	process_cancel_bridge.abort();
	let _ = process_cancel_bridge.await;
	let res = run_result
		.unwrap_or_else(|err| Err(Error::msg(format!("Shell execution task failed: {err}"))));
	let (exec, working_dir) = res?;
	Ok(ShellExecuteResult {
		exit_code: Some(exit_code(&exec)),
		cancelled: false,
		timed_out: false,
		working_dir,
		minimized: None,
	})
}

fn null_file() -> Result<OpenFile> {
	openfiles::null().map_err(|err| Error::msg(format!("Failed to create null file: {err}")))
}

const fn exit_code(result: &ExecutionResult) -> i32 {
	match result.exit_code {
		ExecutionExitCode::Success => 0,
		ExecutionExitCode::GeneralError => 1,
		ExecutionExitCode::InvalidUsage => 2,
		ExecutionExitCode::Unimplemented => 99,
		ExecutionExitCode::CannotExecute => 126,
		ExecutionExitCode::NotFound => 127,
		ExecutionExitCode::Interrupted => 130,
		ExecutionExitCode::BrokenPipe => 141,
		ExecutionExitCode::Custom(code) => code as i32,
	}
}

const fn normalize_env_key(key: &str) -> &str {
	key
}

fn copy_env_into_shell(
	shell: &mut BrushShell,
	env: impl Iterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) -> Result<()> {
	let mut merged_path: Option<String> = None;
	for (key, value) in env {
		let (Some(key), Some(value)) = (key.to_str(), value.to_str()) else {
			continue;
		};
		let normalized_key = normalize_env_key(key);
		if should_skip_env_var(normalized_key) {
			continue;
		}
		if normalized_key == "PATH" {
			merged_path = Some(value.to_string());
			continue;
		}
		let mut var = ShellVariable::new(ShellValue::String(value.to_string()));
		var.export();
		shell
			.env_mut()
			.set_global(normalized_key, var)
			.map_err(|err| Error::msg(format!("Failed to set env: {err}")))?;
	}

	if let Some(path_value) = &merged_path {
		let mut var = ShellVariable::new(ShellValue::String(path_value.clone()));
		var.export();
		shell
			.env_mut()
			.set_global("PATH", var)
			.map_err(|err| Error::msg(format!("Failed to set env: {err}")))?;
	}

	Ok(())
}

async fn create_session_for_run(
	config: &ShellConfig,
	spawn_registry: Option<Arc<process::SpawnRegistry>>,
	cancel_token: Option<CancellationToken>,
) -> Result<ShellSessionCore> {
	let mut shell = BrushShell::builder()
		.do_not_inherit_env(true)
		.profile(ProfileLoadBehavior::Skip)
		.rc(RcLoadBehavior::Skip)
		.builtins(default_builtins(BuiltinSet::BashMode))
		.build()
		.await
		.map_err(|err| Error::msg(format!("Failed to initialize shell: {err}")))?;

	if let Some(exec_builtin) = shell.builtin_mut("exec") {
		exec_builtin.disabled = true;
	}
	if let Some(suspend_builtin) = shell.builtin_mut("suspend") {
		suspend_builtin.disabled = true;
	}

	for (name, registration) in pi_builtins::process_builtins() {
		if name == "nohup" && nohup_builtin_disabled(config) {
			continue;
		}
		shell.register_builtin(name, registration);
	}

	if !uutils_env_disabled(config, "PI_DISABLE_UUTILS_BUILTINS") {
		let destructive_disabled = uutils_env_disabled(config, "PI_DISABLE_UUTILS_DESTRUCTIVE");
		let rm_disabled =
			destructive_disabled || uutils_env_disabled(config, "PI_DISABLE_RM_BUILTIN");
		let mv_disabled =
			destructive_disabled || uutils_env_disabled(config, "PI_DISABLE_MV_BUILTIN");
		for (name, registration) in pi_builtins::utility_builtins() {
			let disabled = match name {
				"rm" => rm_disabled,
				"mv" => mv_disabled,

				"ln" => destructive_disabled,
				_ => false,
			};
			if !disabled {
				shell.register_builtin(name, registration);
			}
		}
	}

	copy_env_into_shell(&mut shell, std::env::vars_os())?;

	if let Some(env) = config.session_env.as_ref() {
		for (key, value) in env {
			let normalized_key = normalize_env_key(key);
			if should_skip_env_var(normalized_key) {
				continue;
			}
			let mut var = ShellVariable::new(ShellValue::String(value.clone()));
			var.export();
			shell
				.env_mut()
				.set_global(normalized_key, var)
				.map_err(|err| Error::msg(format!("Failed to set env: {err}")))?;
		}
	}
	apply_env_fallback(&mut shell)?;

	if let Some(snapshot_path) = config.snapshot_path.as_ref() {
		source_snapshot(&mut shell, snapshot_path, spawn_registry, cancel_token).await?;
	}

	Ok(ShellSessionCore { shell })
}

async fn source_snapshot(
	shell: &mut BrushShell,
	snapshot_path: &str,
	spawn_registry: Option<Arc<process::SpawnRegistry>>,
	cancel_token: Option<CancellationToken>,
) -> Result<()> {
	let mut params = shell.default_exec_params();
	let source_info = SourceInfo::from("pi-natives:snapshot");
	params.set_fd(OpenFiles::STDIN_FD, null_file()?);
	params.set_fd(OpenFiles::STDOUT_FD, null_file()?);
	params.set_fd(OpenFiles::STDERR_FD, null_file()?);
	if let Some(cancel_token) = cancel_token {
		params.set_cancel_token(cancel_token);
	}
	if let Some(spawn_registry) = spawn_registry {
		params.set_spawn_observer(spawn_registry);
	}

	let escaped = snapshot_path.replace('\'', "'\\''");
	let command = format!("source '{escaped}'");
	shell
		.run_string(command, &source_info, &params)
		.await
		.map_err(|err| Error::msg(format!("Failed to source snapshot: {err}")))?;
	Ok(())
}

#[derive(Clone, Copy)]
enum CommandCaptureMode {
	Streaming,
	Buffered { max_capture_bytes: usize },
}

struct CommandRunOutput {
	result:   ExecutionResult,
	buffered: Option<BufferedOutput>,
}

struct ChainCapture {
	original_text: String,
	text:          String,
	input_bytes:   usize,
	changed:       bool,
}

impl ChainCapture {
	const fn new() -> Self {
		Self {
			original_text: String::new(),
			text:          String::new(),
			input_bytes:   0,
			changed:       false,
		}
	}

	fn push(&mut self, original: &str, original_input_bytes: usize, minimized: &str, changed: bool) {
		self.original_text.push_str(original);
		self.text.push_str(minimized);
		self.input_bytes = self.input_bytes.saturating_add(original_input_bytes);
		self.changed |= changed;
	}
}

async fn run_shell_command(
	session: &mut ShellSessionCore,
	options: &ShellRunConfig,
	on_chunk: Option<Sender<String>>,
	cancel_token: CancellationToken,
	spawn_registry: Arc<process::SpawnRegistry>,
) -> Result<(ExecutionResult, Option<MinimizerResult>, Option<String>)> {
	if let Some(cwd) = options.cwd.as_deref() {
		set_shell_working_dir_if_changed(&mut session.shell, cwd)?;
	}

	let env_scope_pushed = apply_command_env(&mut session.shell, options.env.as_ref())?;

	let minimizer_mode = if let Some(config) = options.minimizer.as_ref() {
		minimizer::engine::mode_for(&options.command, config)
	} else {
		minimizer::engine::MinimizerMode::None
	};

	let result = match minimizer_mode {
		minimizer::engine::MinimizerMode::SegmentedChain => {
			run_shell_command_segmented_chain(session, options, on_chunk, cancel_token, spawn_registry)
				.await
		},
		minimizer::engine::MinimizerMode::WholeCommand | minimizer::engine::MinimizerMode::None => {
			run_shell_command_single(
				session,
				options,
				on_chunk,
				cancel_token,
				spawn_registry,
				minimizer_mode,
			)
			.await
		},
	};

	if env_scope_pushed {
		session
			.shell
			.env_mut()
			.pop_scope(EnvironmentScope::Command)
			.map_err(|err| Error::msg(format!("Failed to pop env scope: {err}")))?;
	}

	result.map(|(exec, minimized)| {
		let working_dir = Some(session.shell.working_dir().to_string_lossy().into_owned());
		(exec, minimized, working_dir)
	})
}

async fn run_shell_command_single(
	session: &mut ShellSessionCore,
	options: &ShellRunConfig,
	on_chunk: Option<Sender<String>>,
	cancel_token: CancellationToken,
	spawn_registry: Arc<process::SpawnRegistry>,
	minimizer_mode: minimizer::engine::MinimizerMode,
) -> Result<(ExecutionResult, Option<MinimizerResult>)> {
	debug_assert!(!matches!(minimizer_mode, minimizer::engine::MinimizerMode::SegmentedChain));

	let params = session.shell.default_exec_params();
	let capture_mode = match minimizer_mode {
		minimizer::engine::MinimizerMode::WholeCommand => {
			let Some(config) = options.minimizer.as_ref() else {
				return Err(Error::msg("Missing minimizer config for whole-command mode"));
			};
			CommandCaptureMode::Buffered { max_capture_bytes: config.max_capture_bytes as usize }
		},
		minimizer::engine::MinimizerMode::None => CommandCaptureMode::Streaming,
		minimizer::engine::MinimizerMode::SegmentedChain => CommandCaptureMode::Streaming,
	};

	let command_run = run_shell_command_once(
		session,
		options.command.clone(),
		params,
		on_chunk,
		cancel_token,
		spawn_registry,
		capture_mode,
	)
	.await?;

	let mut minimized_out = None;
	if let Some(buffered) = command_run.buffered
		&& let Some(config) = options.minimizer.as_ref()
		&& !buffered.exceeded
	{
		let minimized = match minimizer_mode {
			minimizer::engine::MinimizerMode::WholeCommand => minimizer::apply(
				&options.command,
				&buffered.text,
				exit_code(&command_run.result),
				config,
			),
			minimizer::engine::MinimizerMode::None => {
				minimizer::MinimizerOutput::passthrough(&buffered.text)
			},
			minimizer::engine::MinimizerMode::SegmentedChain => {
				minimizer::MinimizerOutput::passthrough(&buffered.text)
			},
		};

		if minimized.changed
			&& let Some(original_text) = minimized.original_text
		{
			let output_bytes = u32::try_from(minimized.text.len()).unwrap_or(u32::MAX);
			minimized_out = Some(MinimizerResult {
				filter: minimized.filter.to_string(),
				text: minimized.text,
				original_text,
				input_bytes: u32::try_from(minimized.input_bytes).unwrap_or(u32::MAX),
				output_bytes,
			});
		}
	}

	Ok((command_run.result, minimized_out))
}

async fn run_shell_command_segmented_chain(
	session: &mut ShellSessionCore,
	options: &ShellRunConfig,
	on_chunk: Option<Sender<String>>,
	cancel_token: CancellationToken,
	spawn_registry: Arc<process::SpawnRegistry>,
) -> Result<(ExecutionResult, Option<MinimizerResult>)> {
	let Some(config) = options.minimizer.as_ref() else {
		return run_shell_command_single(
			session,
			options,
			on_chunk,
			cancel_token,
			spawn_registry,
			minimizer::engine::MinimizerMode::None,
		)
		.await;
	};

	if !config.enabled {
		return run_shell_command_single(
			session,
			options,
			on_chunk,
			cancel_token,
			spawn_registry,
			minimizer::engine::MinimizerMode::None,
		)
		.await;
	}

	let minimizer::plan::CommandPlan::Chain { segments } =
		minimizer::plan::analyze(&options.command)
	else {
		return run_shell_command_single(
			session,
			options,
			on_chunk,
			cancel_token,
			spawn_registry,
			minimizer::engine::MinimizerMode::None,
		)
		.await;
	};

	let params = session.shell.default_exec_params();
	let mut aggregate = Some(ChainCapture::new());
	let mut previous_succeeded = true;
	let mut last_result = None;
	let max_capture_bytes = config.max_capture_bytes as usize;
	for segment in segments {
		if segment.run_if_previous_succeeded && !previous_succeeded {
			continue;
		}

		let mut segment_params = params.clone();
		segment_params.suppress_errexit = segment.suppress_errexit;
		let capture_mode = if aggregate.is_some() {
			CommandCaptureMode::Buffered { max_capture_bytes }
		} else {
			CommandCaptureMode::Streaming
		};

		let command_run = run_shell_command_once(
			session,
			segment.command.clone(),
			segment_params,
			on_chunk.clone(),
			cancel_token.clone(),
			spawn_registry.clone(),
			capture_mode,
		)
		.await?;

		let exit = exit_code(&command_run.result);
		previous_succeeded = exit == 0;

		if let Some(buffered) = command_run.buffered {
			if buffered.exceeded {
				aggregate = None;
			} else if let Some(capture) = aggregate.as_mut() {
				let next_input_bytes = capture.input_bytes.saturating_add(buffered.input_bytes);
				if next_input_bytes > max_capture_bytes {
					aggregate = None;
				} else {
					let minimized = minimizer::apply(&segment.command, &buffered.text, exit, config);
					capture.push(
						&buffered.text,
						buffered.input_bytes,
						&minimized.text,
						minimized.changed,
					);
				}
			}
		} else if aggregate.is_some() {
			aggregate = None;
		}

		let keep_running = session_keepalive(&command_run.result) && !cancel_token.is_cancelled();
		last_result = Some(command_run.result);
		if !keep_running {
			break;
		}
	}

	let Some(result) = last_result else {
		return Err(Error::msg("Segmented chain executed no segments"));
	};

	let minimized_out = aggregate.filter(|capture| capture.changed).map(|capture| {
		let minimized = minimizer::chain_output(
			capture.text,
			capture.original_text,
			capture.input_bytes,
			capture.changed,
		);
		MinimizerResult {
			filter:        minimized.filter.to_string(),
			text:          minimized.text,
			original_text: minimized.original_text.unwrap_or_default(),
			input_bytes:   u32::try_from(minimized.input_bytes).unwrap_or(u32::MAX),
			output_bytes:  u32::try_from(minimized.output_bytes).unwrap_or(u32::MAX),
		}
	});

	Ok((result, minimized_out))
}

async fn run_shell_command_once(
	session: &mut ShellSessionCore,
	mut command: String,
	mut params: ExecutionParameters,
	on_chunk: Option<Sender<String>>,
	cancel_token: CancellationToken,
	spawn_registry: Arc<process::SpawnRegistry>,
	capture_mode: CommandCaptureMode,
) -> Result<CommandRunOutput> {
	let (reader_file, writer_file) = pipe_to_files("output")?;

	let stdout_file = OpenFile::from(
		writer_file
			.try_clone()
			.map_err(|err| Error::msg(format!("Failed to clone pipe: {err}")))?,
	);
	let stderr_file = OpenFile::from(writer_file);

	params.set_fd(OpenFiles::STDIN_FD, null_file()?);
	params.set_fd(OpenFiles::STDOUT_FD, stdout_file);
	params.set_fd(OpenFiles::STDERR_FD, stderr_file);
	params.process_group_policy = ProcessGroupPolicy::NewProcessGroup;
	params.set_cancel_token(cancel_token.clone());
	params.set_spawn_observer(spawn_registry.clone());
	let reader_cancel = CancellationToken::new();
	let (activity_tx, activity_rx) = flume::bounded::<()>(1);
	let reader_callback = on_chunk;
	let mut reader_handle = tokio::spawn({
		let reader_cancel = reader_cancel.clone();
		async move {
			match capture_mode {
				CommandCaptureMode::Buffered { max_capture_bytes } => {
					let output = read_output_buffered(
						reader_file,
						reader_callback,
						reader_cancel,
						activity_tx,
						max_capture_bytes,
					)
					.await;
					Result::<OutputRead>::Ok(OutputRead::Buffered(output))
				},
				CommandCaptureMode::Streaming => {
					Box::pin(read_output(reader_file, reader_callback, reader_cancel, activity_tx))
						.await;
					Result::<OutputRead>::Ok(OutputRead::Streaming)
				},
			}
		}
	});

	const CANCEL_READER_GRACE: Duration = Duration::from_millis(500);
	let cancel_bridge = tokio::spawn({
		let cancel_token = cancel_token.clone();
		let reader_cancel = reader_cancel.clone();
		async move {
			cancel_token.cancelled().await;
			time::sleep(CANCEL_READER_GRACE).await;
			reader_cancel.cancel();
		}
	});
	ensure_trailing_newline_for_heredoc(&mut command);
	let source_info = SourceInfo::from("pi-natives:command");
	let result = session
		.shell
		.run_string(command, &source_info, &params)
		.await;

	if cancel_token.is_cancelled() {
		terminate_background_jobs(&mut session.shell);
	}

	drop(params);

	const POST_EXIT_IDLE: Duration = Duration::from_millis(250);
	const POST_EXIT_MAX: Duration = Duration::from_secs(2);
	const READER_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(250);

	let mut reader_finished = false;
	let mut reader_output = None;
	let mut idle_timer = Box::pin(time::sleep(POST_EXIT_IDLE));
	let mut max_timer = Box::pin(time::sleep(POST_EXIT_MAX));

	loop {
		tokio::select! {
			res = &mut reader_handle => {
				if let Ok(Ok(output)) = res {
					reader_output = Some(output);
				}
				reader_finished = true;
				break;
			}
			msg = activity_rx.recv_async() => {
				if msg.is_err() {
					break;
				}
				idle_timer.as_mut().reset(time::Instant::now() + POST_EXIT_IDLE);
			}
			() = &mut idle_timer => break,
			() = &mut max_timer => break,
		}
	}

	if !reader_finished {
		reader_cancel.cancel();
		match time::timeout(READER_SHUTDOWN_TIMEOUT, &mut reader_handle).await {
			Ok(Ok(Ok(output))) => reader_output = Some(output),
			Ok(_) => {},
			Err(_) => {
				reader_handle.abort();
				let _ = reader_handle.await;
			},
		}
	}
	cancel_bridge.abort();
	let _ = cancel_bridge.await;

	let result = result.map_err(|err| Error::msg(format!("Shell execution failed: {err}")))?;
	let buffered = match reader_output {
		Some(OutputRead::Buffered(output)) => Some(output),
		Some(OutputRead::Streaming) | None => None,
	};
	Ok(CommandRunOutput { result, buffered })
}

async fn run_shell_command_streams(
	session: &mut ShellSessionCore,
	options: &ShellRunConfig,
	streams: StreamSinks,
	cancel_token: CancellationToken,
	spawn_registry: Arc<process::SpawnRegistry>,
) -> Result<(ExecutionResult, Option<String>)> {
	if let Some(cwd) = options.cwd.as_deref() {
		set_shell_working_dir_if_changed(&mut session.shell, cwd)?;
	}

	let env_scope_pushed = apply_command_env(&mut session.shell, options.env.as_ref())?;

	let (stdout_reader, stdout_writer) = pipe_to_files("stdout")?;
	let (stderr_reader, stderr_writer) = pipe_to_files("stderr")?;

	let stdout_file = OpenFile::from(stdout_writer);
	let stderr_file = OpenFile::from(stderr_writer);

	let mut params = session.shell.default_exec_params();
	params.set_fd(OpenFiles::STDIN_FD, null_file()?);
	params.set_fd(OpenFiles::STDOUT_FD, stdout_file);
	params.set_fd(OpenFiles::STDERR_FD, stderr_file);
	params.process_group_policy = ProcessGroupPolicy::NewProcessGroup;
	params.set_cancel_token(cancel_token.clone());
	params.set_spawn_observer(spawn_registry.clone());
	let reader_cancel = CancellationToken::new();
	let (activity_tx, activity_rx) = flume::bounded::<()>(1);

	let StreamSinks { stdout: stdout_sink, stderr: stderr_sink } = streams;
	let mut stdout_handle = tokio::spawn(Box::pin(read_output_bytes(
		stdout_reader,
		stdout_sink,
		reader_cancel.clone(),
		activity_tx.clone(),
	)));
	let mut stderr_handle = tokio::spawn(Box::pin(read_output_bytes(
		stderr_reader,
		stderr_sink,
		reader_cancel.clone(),
		activity_tx,
	)));

	let cancel_bridge = tokio::spawn({
		let cancel_token = cancel_token.clone();
		let reader_cancel = reader_cancel.clone();
		async move {
			cancel_token.cancelled().await;
			reader_cancel.cancel();
		}
	});
	let mut command = options.command.clone();
	ensure_trailing_newline_for_heredoc(&mut command);
	let source_info = SourceInfo::from("pi-shell:streams");
	let result = session
		.shell
		.run_string(command, &source_info, &params)
		.await;

	if cancel_token.is_cancelled() {
		terminate_background_jobs(&mut session.shell);
	}

	if env_scope_pushed {
		session
			.shell
			.env_mut()
			.pop_scope(EnvironmentScope::Command)
			.map_err(|err| Error::msg(format!("Failed to pop env scope: {err}")))?;
	}

	drop(params);

	const POST_EXIT_IDLE: Duration = Duration::from_millis(250);
	const POST_EXIT_MAX: Duration = Duration::from_secs(2);
	const READER_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(250);

	let mut stdout_finished = false;
	let mut stderr_finished = false;
	let mut idle_timer = Box::pin(time::sleep(POST_EXIT_IDLE));
	let mut max_timer = Box::pin(time::sleep(POST_EXIT_MAX));

	loop {
		if stdout_finished && stderr_finished {
			break;
		}
		tokio::select! {
			res = &mut stdout_handle, if !stdout_finished => {
				let _ = res;
				stdout_finished = true;
			}
			res = &mut stderr_handle, if !stderr_finished => {
				let _ = res;
				stderr_finished = true;
			}
			msg = activity_rx.recv_async() => {
				if msg.is_err() {
					break;
				}
				idle_timer.as_mut().reset(time::Instant::now() + POST_EXIT_IDLE);
			}
			() = &mut idle_timer => break,
			() = &mut max_timer => break,
		}
	}

	if !stdout_finished || !stderr_finished {
		reader_cancel.cancel();
	}
	if !stdout_finished
		&& time::timeout(READER_SHUTDOWN_TIMEOUT, &mut stdout_handle)
			.await
			.is_err()
	{
		stdout_handle.abort();
		let _ = stdout_handle.await;
	}
	if !stderr_finished
		&& time::timeout(READER_SHUTDOWN_TIMEOUT, &mut stderr_handle)
			.await
			.is_err()
	{
		stderr_handle.abort();
		let _ = stderr_handle.await;
	}
	cancel_bridge.abort();
	let _ = cancel_bridge.await;

	let result = result.map_err(|err| Error::msg(format!("Shell execution failed: {err}")))?;
	let working_dir = Some(session.shell.working_dir().to_string_lossy().into_owned());
	Ok((result, working_dir))
}

async fn read_output_bytes(
	reader: fs::File,
	sink: Option<Sender<Bytes>>,
	cancel_token: CancellationToken,
	activity: Sender<()>,
) {
	const BUF: usize = 65536;

	#[cfg(unix)]
	let Ok(reader) = register_nonblocking_pipe(reader) else {
		return;
	};
	#[cfg(not(unix))]
	let mut reader = tokio::fs::File::from_std(reader);

	loop {
		let mut buf = vec![0u8; BUF];
		#[cfg(unix)]
		let n = {
			let Ok(mut readiness) = (tokio::select! {
				ready = reader.readable() => ready,
				() = cancel_token.cancelled() => break,
			}) else {
				break;
			};
			match readiness.try_io(|inner| read_nonblocking(inner.get_ref(), &mut buf)) {
				Ok(Ok(0)) => break,
				Ok(Ok(n)) => n,
				Ok(Err(e)) if e.kind() == io::ErrorKind::Interrupted => continue,
				Ok(Err(_)) => break,
				Err(_would_block) => continue,
			}
		};
		#[cfg(not(unix))]
		let n = {
			let read_future = reader.read(&mut buf);
			tokio::pin!(read_future);
			match tokio::select! {
				res = &mut read_future => res,
				() = cancel_token.cancelled() => break,
			} {
				Ok(0) => break,
				Ok(n) => n,
				Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
				Err(_) => break,
			}
		};
		let _ = activity.try_send(());
		buf.truncate(n);
		if let Some(sink) = sink.as_ref()
			&& sink.send(Bytes::from(buf)).is_err()
		{
			break;
		}
	}
}

impl SpawnObserver for process::SpawnRegistry {
	fn on_spawn(&self, pid: i32, pgid: Option<i32>) {
		let process = process::Process::from_pid(pid);
		self.record(pgid, process);
	}
}

async fn terminate_run(registry: &process::SpawnRegistry) {
	const WAVES: u32 = 3;
	let mut saw_targets = false;
	for wave in 0..WAVES {
		let targets = registry.build_targets();
		if targets.is_empty() {
			if saw_targets || wave + 1 == WAVES {
				return;
			}
		} else {
			saw_targets = true;
			let signal = if wave == 0 {
				process::TERM_SIGNAL
			} else {
				process::KILL_SIGNAL
			};
			targets.signal(signal);
		}
		if wave + 1 < WAVES {
			let pause = if wave == 0 {
				Duration::from_millis(75)
			} else {
				Duration::from_millis(150)
			};
			time::sleep(pause).await;
		}
	}
}
fn terminate_internal_background_jobs(shell: &mut BrushShell) {
	for job in &mut shell.jobs_mut().jobs {
		job.abort_internal_tasks();
	}
}

fn terminate_background_jobs(shell: &mut BrushShell) {
	let mut targets = process::TerminationTargets::new();
	terminate_internal_background_jobs(shell);
	for job in &shell.jobs().jobs {
		if let Some(pgid) = job.process_group_id() {
			targets.add_pgid(pgid);
		}
		if let Some(pid) = job.representative_pid() {
			targets.add_pid(pid);
		}
	}
	if targets.is_empty() {
		return;
	}

	targets.signal(process::TERM_SIGNAL);
	tokio::spawn(async move {
		time::sleep(Duration::from_millis(150)).await;
		targets.signal(process::KILL_SIGNAL);
	});
}

fn apply_command_env(
	shell: &mut BrushShell,
	env: Option<&HashMap<String, String>>,
) -> Result<bool> {
	let Some(env) = env else {
		return Ok(false);
	};
	shell.env_mut().push_scope(EnvironmentScope::Command);
	for (key, value) in env {
		let normalized_key = normalize_env_key(key);
		if should_skip_env_var(normalized_key) {
			continue;
		}
		let mut var = ShellVariable::new(ShellValue::String(value.clone()));
		var.export();
		if let Err(err) = shell
			.env_mut()
			.add(normalized_key, var, EnvironmentScope::Command)
		{
			let _ = shell.env_mut().pop_scope(EnvironmentScope::Command);
			return Err(Error::msg(format!("Failed to set env: {err}")));
		}
	}
	Ok(true)
}

fn apply_env_fallback(shell: &mut BrushShell) -> Result<()> {
	if shell.env().get("env").is_some() {
		return Ok(());
	}
	let var = ShellVariable::new(ShellValue::String("$env".to_string()));
	shell
		.env_mut()
		.set_global("env", var)
		.map_err(|err| Error::msg(format!("Failed to set env fallback: {err}")))
}

fn is_macos_malloc_stack_logging_var(key: &str) -> bool {
	matches!(key, "MallocStackLogging" | "MallocStackLoggingNoCompact")
}

fn should_skip_env_var(key: &str) -> bool {
	if key.starts_with("BASH_FUNC_") && key.ends_with("%%") {
		return true;
	}
	if is_macos_malloc_stack_logging_var(key) {
		return true;
	}

	matches!(
		key,
		"BASH_ENV"
			| "ENV"
			| "HISTFILE"
			| "HISTTIMEFORMAT"
			| "HISTCMD"
			| "PS0"
			| "PS1"
			| "PS2"
			| "PS4"
			| "BRUSH_PS_ALT"
			| "READLINE_LINE"
			| "READLINE_POINT"
			| "BRUSH_VERSION"
			| "BASH"
			| "BASHOPTS"
			| "BASH_ALIASES"
			| "BASH_ARGV0"
			| "BASH_CMDS"
			| "BASH_SOURCE"
			| "BASH_SUBSHELL"
			| "BASH_VERSINFO"
			| "BASH_VERSION"
			| "SHELLOPTS"
			| "SHLVL"
			| "SHELL"
			| "COMP_WORDBREAKS"
			| "DIRSTACK"
			| "EPOCHREALTIME"
			| "EPOCHSECONDS"
			| "FUNCNAME"
			| "GROUPS"
			| "IFS"
			| "LINENO"
			| "MACHTYPE"
			| "OSTYPE"
			| "OPTERR"
			| "OPTIND"
			| "PIPESTATUS"
			| "PPID"
			| "PWD"
			| "OLDPWD"
			| "RANDOM"
			| "SRANDOM"
			| "SECONDS"
			| "UID"
			| "EUID"
			| "HOSTNAME"
			| "HOSTTYPE"
	)
}

fn ensure_trailing_newline_for_heredoc(command: &mut String) {
	if command.ends_with('\n') || !command.as_bytes().windows(2).any(|window| window == b"<<") {
		return;
	}
	command.push('\n');
}

const fn session_keepalive(result: &ExecutionResult) -> bool {
	match result.next_control_flow {
		ExecutionControlFlow::Normal => true,
		ExecutionControlFlow::BreakLoop { .. } => false,
		ExecutionControlFlow::ContinueLoop { .. } => false,
		ExecutionControlFlow::ReturnFromFunctionOrScript => false,
		ExecutionControlFlow::ExitShell => false,
	}
}

enum OutputRead {
	Streaming,
	Buffered(BufferedOutput),
}

struct BufferedOutput {
	text:        String,
	input_bytes: usize,
	exceeded:    bool,
}

async fn read_output(
	reader: fs::File,
	on_chunk: Option<Sender<String>>,
	cancel_token: CancellationToken,
	activity: Sender<()>,
) {
	const REPLACEMENT: &str = "\u{FFFD}";
	const BUF: usize = 65536;
	let mut buf = vec![0u8; BUF + 4];
	let mut it = 0;

	#[cfg(unix)]
	let Ok(reader) = register_nonblocking_pipe(reader) else {
		return;
	};
	#[cfg(not(unix))]
	let reader = tokio::fs::File::from_std(reader);
	#[cfg(not(unix))]
	tokio::pin!(reader);

	loop {
		#[cfg(unix)]
		let n = {
			let Ok(mut readiness) = (tokio::select! {
				ready = reader.readable() => ready,
				() = cancel_token.cancelled() => break,
			}) else {
				break;
			};
			match readiness.try_io(|inner| read_nonblocking(inner.get_ref(), &mut buf[it..BUF])) {
				Ok(Ok(0)) => break,
				Ok(Ok(n)) => n,
				Ok(Err(e)) if e.kind() == io::ErrorKind::Interrupted => continue,
				Ok(Err(_)) => break,
				Err(_would_block) => continue,
			}
		};
		#[cfg(not(unix))]
		let n = {
			let read_future = reader.read(&mut buf[it..BUF]);
			tokio::pin!(read_future);
			match tokio::select! {
				res = &mut read_future => res,
				() = cancel_token.cancelled() => break,
			} {
				Ok(0) => break,
				Ok(n) => n,
				Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
				Err(_) => break,
			}
		};
		if n > 0 {
			let _ = activity.try_send(());
		}
		it += n;

		while it > 0 {
			let pending = &buf[..it];
			match str::from_utf8(pending) {
				Ok(text) => {
					emit_chunk(text, on_chunk.as_ref()).await;
					it = 0;
					break;
				},
				Err(err) => {
					let p = err.valid_up_to();
					if p > 0 {
						let text = unsafe { str::from_utf8_unchecked(&pending[..p]) };
						emit_chunk(text, on_chunk.as_ref()).await;

						buf.copy_within(p..it, 0);
						it -= p;
					}

					match err.error_len() {
						Some(p) => {
							emit_chunk(REPLACEMENT, on_chunk.as_ref()).await;

							buf.copy_within(p..it, 0);
							it -= p;
						},
						None => {
							break;
						},
					}
				},
			}
		}
	}

	for chunk in buf[..it].utf8_chunks() {
		let valid = chunk.valid();
		if !valid.is_empty() {
			emit_chunk(valid, on_chunk.as_ref()).await;
		}
		if !chunk.invalid().is_empty() {
			emit_chunk(REPLACEMENT, on_chunk.as_ref()).await;
		}
	}
}

async fn read_output_buffered(
	reader: fs::File,
	on_chunk: Option<Sender<String>>,
	cancel_token: CancellationToken,
	activity: Sender<()>,
	max_capture_bytes: usize,
) -> BufferedOutput {
	const REPLACEMENT: &str = "\u{FFFD}";
	const BUF: usize = 65536;
	let mut buf = vec![0u8; BUF];
	let mut input_bytes = 0usize;
	let mut captured = Vec::new();
	let mut exceeded = false;

	let mut pending = Vec::<u8>::new();

	#[cfg(unix)]
	let Ok(reader) = register_nonblocking_pipe(reader) else {
		return BufferedOutput { text: String::new(), input_bytes: 0, exceeded: true };
	};
	#[cfg(not(unix))]
	let reader = tokio::fs::File::from_std(reader);
	#[cfg(not(unix))]
	tokio::pin!(reader);

	loop {
		#[cfg(unix)]
		let n = {
			let Ok(mut readiness) = (tokio::select! {
				ready = reader.readable() => ready,
				() = cancel_token.cancelled() => break,
			}) else {
				break;
			};
			match readiness.try_io(|inner| read_nonblocking(inner.get_ref(), &mut buf)) {
				Ok(Ok(0)) => break,
				Ok(Ok(n)) => n,
				Ok(Err(e)) if e.kind() == io::ErrorKind::Interrupted => continue,
				Ok(Err(_)) => break,
				Err(_would_block) => continue,
			}
		};
		#[cfg(not(unix))]
		let n = {
			let read_future = reader.read(&mut buf);
			tokio::pin!(read_future);
			match tokio::select! {
				res = &mut read_future => res,
				() = cancel_token.cancelled() => break,
			} {
				Ok(0) => break,
				Ok(n) => n,
				Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
				Err(_) => break,
			}
		};
		if n > 0 {
			let _ = activity.try_send(());
			input_bytes = input_bytes.saturating_add(n);
		}

		if !exceeded {
			if captured.len().saturating_add(n) > max_capture_bytes {
				exceeded = true;
			} else {
				captured.extend_from_slice(&buf[..n]);
			}
		}

		if let Some(cb) = on_chunk.as_ref() {
			pending.extend_from_slice(&buf[..n]);
			while !pending.is_empty() {
				match str::from_utf8(&pending) {
					Ok(text) => {
						emit_chunk(text, Some(cb)).await;
						pending.clear();
						break;
					},
					Err(err) => {
						let p = err.valid_up_to();
						if p > 0 {
							let text = unsafe { str::from_utf8_unchecked(&pending[..p]) };
							emit_chunk(text, Some(cb)).await;
							pending.drain(..p);
						}
						match err.error_len() {
							Some(skip) => {
								emit_chunk(REPLACEMENT, Some(cb)).await;
								pending.drain(..skip);
							},
							None => break,
						}
					},
				}
			}
		}
	}

	if let Some(cb) = on_chunk.as_ref() {
		for chunk in pending.utf8_chunks() {
			let valid = chunk.valid();
			if !valid.is_empty() {
				emit_chunk(valid, Some(cb)).await;
			}
			if !chunk.invalid().is_empty() {
				emit_chunk(REPLACEMENT, Some(cb)).await;
			}
		}
	}

	BufferedOutput { text: String::from_utf8_lossy(&captured).into_owned(), input_bytes, exceeded }
}

#[cfg(unix)]
fn register_nonblocking_pipe(reader: fs::File) -> io::Result<tokio::io::unix::AsyncFd<fs::File>> {
	set_nonblocking(&reader)?;
	tokio::io::unix::AsyncFd::new(reader)
}

#[cfg(unix)]
fn set_nonblocking<T: std::os::fd::AsRawFd>(file: &T) -> io::Result<()> {
	let fd = file.as_raw_fd();

	let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
	if flags < 0 {
		return Err(io::Error::last_os_error());
	}
	if flags & libc::O_NONBLOCK != 0 {
		return Ok(());
	}

	let result = unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) };
	if result < 0 {
		Err(io::Error::last_os_error())
	} else {
		Ok(())
	}
}

#[cfg(unix)]
fn read_nonblocking<T: std::os::fd::AsRawFd>(file: &T, buf: &mut [u8]) -> io::Result<usize> {
	let read = unsafe { libc::read(file.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
	if read < 0 {
		Err(io::Error::last_os_error())
	} else {
		Ok(read as usize)
	}
}

async fn emit_chunk(text: &str, callback: Option<&Sender<String>>) {
	if let Some(callback) = callback {
		let _ = callback.send_async(text.to_string()).await;
	}
}

fn pipe_to_files(label: &str) -> Result<(fs::File, fs::File)> {
	let (r, w) =
		os_pipe::pipe().map_err(|err| Error::msg(format!("Failed to create {label} pipe: {err}")))?;

	#[cfg(unix)]
	let (r, w): (fs::File, fs::File) = {
		use std::os::unix::io::{FromRawFd, IntoRawFd};
		let r = r.into_raw_fd();
		let w = w.into_raw_fd();

		unsafe { (FromRawFd::from_raw_fd(r), FromRawFd::from_raw_fd(w)) }
	};

	Ok((r, w))
}

fn nohup_builtin_disabled(config: &ShellConfig) -> bool {
	uutils_env_disabled(config, "PI_DISABLE_NOHUP_BUILTIN")
}

fn uutils_env_disabled(config: &ShellConfig, key: &str) -> bool {
	let raw = config
		.session_env
		.as_ref()
		.and_then(|env| env.get(key).cloned())
		.or_else(|| std::env::var(key).ok());
	matches!(raw.as_deref(), Some(value) if !value.is_empty() && value != "0" && !value.eq_ignore_ascii_case("false"))
}
