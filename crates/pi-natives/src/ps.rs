use std::time::Duration;

use napi::{
	Env, JsString, Result,
	bindgen_prelude::{PromiseRaw, Unknown},
};
use napi_derive::napi;
use pi_shell::process::{self as core_process, ProcessStatus as CoreProcessStatus};
pub use pi_shell::process::{KILL_SIGNAL, TERM_SIGNAL, TerminationTargets, kill_process_group};

use crate::{js::into_string, task};

#[derive(Default)]
#[napi(object)]
pub struct ProcessTerminateOptions<'env> {
	pub group: Option<bool>,

	pub graceful_ms: Option<i32>,

	pub timeout_ms: Option<u32>,

	pub signal: Option<Unknown<'env>>,
}

#[derive(Default)]
#[napi(object)]
pub struct ProcessWaitOptions<'env> {
	pub timeout_ms: Option<u32>,

	pub signal: Option<Unknown<'env>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum ProcessStatus {
	#[napi(value = "running")]
	Running,

	#[napi(value = "exited")]
	Exited,
}

impl From<CoreProcessStatus> for ProcessStatus {
	fn from(value: CoreProcessStatus) -> Self {
		match value {
			CoreProcessStatus::Running => Self::Running,
			CoreProcessStatus::Exited => Self::Exited,
		}
	}
}

#[napi]
#[derive(Clone)]
pub struct Process {
	inner: core_process::Process,
}

#[napi]
#[allow(clippy::use_self, reason = "napi return types must name the exported class")]
impl Process {
	#[napi]
	pub fn from_pid(pid: i32) -> Option<Process> {
		core_process::Process::from_pid(pid).map(Self::from_inner)
	}

	#[napi]
	pub fn from_path(path: JsString) -> Result<Vec<Process>> {
		Ok(core_process::Process::from_path(into_string(path)?)
			.into_iter()
			.map(Self::from_inner)
			.collect())
	}

	#[napi(getter)]
	pub const fn pid(&self) -> i32 {
		self.inner.pid()
	}

	#[napi(getter)]
	pub fn ppid(&self) -> Option<i32> {
		self.inner.ppid()
	}

	#[napi]
	pub fn args(&self) -> Vec<String> {
		self.inner.args()
	}

	#[napi]
	pub fn kill_tree(&self, signal: Option<i32>) -> u32 {
		self.inner.kill_tree(signal)
	}

	#[napi]
	pub fn terminate<'env>(
		&self,
		env: &'env Env,
		options: Option<ProcessTerminateOptions<'env>>,
	) -> Result<PromiseRaw<'env, bool>> {
		let options = options.unwrap_or_default();
		let group = options.group.unwrap_or(false);
		let graceful_ms = options.graceful_ms.unwrap_or(1000);
		let timeout_ms = options.timeout_ms.unwrap_or(5000);
		let ct = task::CancelToken::new(None, options.signal);
		let process = self.inner.clone();
		task::future(env, "process.terminate", async move {
			process
				.terminate_tree(group, graceful_ms, timeout_ms, ct.into_core())
				.await
				.map_err(|err| napi::Error::from_reason(err.to_string()))
		})
	}

	#[napi]
	pub fn wait_for_exit<'env>(
		&self,
		env: &'env Env,
		options: Option<ProcessWaitOptions<'env>>,
	) -> Result<PromiseRaw<'env, bool>> {
		let options = options.unwrap_or_default();
		let ct = task::CancelToken::new(None, options.signal);
		let timeout = options
			.timeout_ms
			.map(|ms| Duration::from_millis(u64::from(ms)));
		let process = self.inner.clone();
		task::future(env, "process.wait_for_exit", async move {
			process
				.wait_for_exit(timeout, ct.into_core())
				.await
				.map_err(|err| napi::Error::from_reason(err.to_string()))
		})
	}

	#[napi]
	#[allow(clippy::missing_const_for_fn, reason = "#[napi] generates a non-const wrapper")]
	pub fn group_id(&self) -> Option<i32> {
		self.inner.group_id()
	}

	#[napi]
	pub fn children(&self) -> Vec<Process> {
		self
			.inner
			.children()
			.into_iter()
			.map(Self::from_inner)
			.collect()
	}

	#[napi]
	pub fn status(&self) -> ProcessStatus {
		self.inner.status().into()
	}
}

impl Process {
	const fn from_inner(inner: core_process::Process) -> Self {
		Self { inner }
	}
}
