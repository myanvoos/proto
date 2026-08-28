

#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;

use tokio_util::sync::CancellationToken;

use crate::{error, processes};


#[derive(Default)]
pub struct ExecutionResult {

	pub next_control_flow: ExecutionControlFlow,

	pub exit_code:         ExecutionExitCode,
}

impl ExecutionResult {





	pub fn new(exit_code: u8) -> Self {
		Self { exit_code: exit_code.into(), ..Self::default() }
	}


	pub fn stopped() -> Self {

		const SIGTSTP: std::os::raw::c_int = 20;

		#[expect(clippy::cast_possible_truncation)]
		Self::new(128 + SIGTSTP as u8)
	}


	pub const fn success() -> Self {
		Self {
			next_control_flow: ExecutionControlFlow::Normal,
			exit_code:         ExecutionExitCode::Success,
		}
	}


	pub const fn general_error() -> Self {
		Self {
			next_control_flow: ExecutionControlFlow::Normal,
			exit_code:         ExecutionExitCode::GeneralError,
		}
	}


	pub const fn is_success(&self) -> bool {
		self.exit_code.is_success()
	}



	pub const fn is_normal_flow(&self) -> bool {
		matches!(self.next_control_flow, ExecutionControlFlow::Normal)
	}


	pub const fn is_break(&self) -> bool {
		matches!(self.next_control_flow, ExecutionControlFlow::BreakLoop { .. })
	}


	pub const fn is_continue(&self) -> bool {
		matches!(self.next_control_flow, ExecutionControlFlow::ContinueLoop { .. })
	}




	pub const fn is_return_or_exit(&self) -> bool {
		matches!(
			self.next_control_flow,
			ExecutionControlFlow::ReturnFromFunctionOrScript | ExecutionControlFlow::ExitShell
		)
	}
}

impl From<ExecutionExitCode> for ExecutionResult {
	fn from(exit_code: ExecutionExitCode) -> Self {
		Self { next_control_flow: ExecutionControlFlow::Normal, exit_code }
	}
}

impl From<ExecutionWaitResult> for ExecutionResult {
	fn from(wait_result: ExecutionWaitResult) -> Self {
		match wait_result {
			ExecutionWaitResult::Completed(result) => result,

			ExecutionWaitResult::Stopped(..) => Self::stopped(),
		}
	}
}

impl From<std::process::Output> for ExecutionResult {
	fn from(output: std::process::Output) -> Self {
		if let Some(code) = output.status.code() {
			#[expect(clippy::cast_sign_loss)]
			return Self::new((code & 0xff) as u8);
		}

		#[cfg(unix)]
		if let Some(signal) = output.status.signal() {
			#[expect(clippy::cast_sign_loss)]
			return Self::new((signal & 0xff) as u8 + 128);
		}

		tracing::error!("unhandled process exit");
		Self::new(127)
	}
}


#[derive(Clone, Copy, Default)]
pub enum ExecutionExitCode {

	#[default]
	Success,

	GeneralError,

	InvalidUsage,

	CannotExecute,

	NotFound,

	Interrupted,

	BrokenPipe,

	Unimplemented,

	Custom(u8),
}

impl ExecutionExitCode {

	pub const fn is_success(&self) -> bool {
		matches!(self, Self::Success)
	}
}

impl From<u8> for ExecutionExitCode {
	fn from(code: u8) -> Self {
		match code {
			0 => Self::Success,
			1 => Self::GeneralError,
			2 => Self::InvalidUsage,
			99 => Self::Unimplemented,
			126 => Self::CannotExecute,
			127 => Self::NotFound,
			130 => Self::Interrupted,
			141 => Self::BrokenPipe,
			code => Self::Custom(code),
		}
	}
}

impl From<ExecutionExitCode> for u8 {
	fn from(code: ExecutionExitCode) -> Self {
		Self::from(&code)
	}
}

impl From<&ExecutionExitCode> for u8 {
	fn from(code: &ExecutionExitCode) -> Self {
		match code {
			ExecutionExitCode::Success => 0,
			ExecutionExitCode::GeneralError => 1,
			ExecutionExitCode::InvalidUsage => 2,
			ExecutionExitCode::Unimplemented => 99,
			ExecutionExitCode::CannotExecute => 126,
			ExecutionExitCode::NotFound => 127,
			ExecutionExitCode::Interrupted => 130,
			ExecutionExitCode::BrokenPipe => 141,
			ExecutionExitCode::Custom(code) => *code,
		}
	}
}


#[derive(Clone, Copy, Default)]
pub enum ExecutionControlFlow {

	#[default]
	Normal,

	BreakLoop {


		levels: usize,
	},

	ContinueLoop {


		levels: usize,
	},

	ReturnFromFunctionOrScript,

	ExitShell,
}

impl ExecutionControlFlow {



	#[must_use]
	pub const fn try_decrement_loop_levels(&self) -> Self {
		match self {
			Self::BreakLoop { levels: 0 } | Self::ContinueLoop { levels: 0 } => Self::Normal,
			Self::BreakLoop { levels } => Self::BreakLoop { levels: *levels - 1 },
			Self::ContinueLoop { levels } => Self::ContinueLoop { levels: *levels - 1 },
			control_flow => *control_flow,
		}
	}
}




pub enum ExecutionSpawnResult {

	Completed(ExecutionResult),

	StartedProcess(processes::ChildProcess),

	StartedTask(tokio::task::JoinHandle<Result<ExecutionResult, error::Error>>),
}

impl From<ExecutionResult> for ExecutionSpawnResult {
	fn from(result: ExecutionResult) -> Self {
		Self::Completed(result)
	}
}

impl ExecutionSpawnResult {

	pub async fn wait(self) -> Result<ExecutionWaitResult, error::Error> {
		self.wait_with_cancel(None).await
	}




	pub async fn wait_with_cancel(
		self,
		cancel_token: Option<CancellationToken>,
	) -> Result<ExecutionWaitResult, error::Error> {
		let result = match self {
			Self::StartedProcess(mut child) => {


				match child.wait(cancel_token).await? {
					processes::ProcessWaitResult::Completed(output) => {
						ExecutionWaitResult::Completed(ExecutionResult::from(output))
					},
					processes::ProcessWaitResult::Stopped => ExecutionWaitResult::Stopped(child),
					processes::ProcessWaitResult::Cancelled => {
						ExecutionWaitResult::Completed(ExecutionResult::new(130))
					},
				}
			},
			Self::Completed(result) => ExecutionWaitResult::Completed(result),
			Self::StartedTask(join_handle) => {
				let result = join_handle.await?;
				ExecutionWaitResult::Completed(result?)
			},
		};

		Ok(result)
	}
	pub(crate) async fn poll(self) -> Result<ExecutionWaitResult, error::Error> {
		let result = match self {
			Self::StartedProcess(child) => ExecutionWaitResult::Stopped(child),
			Self::Completed(result) => ExecutionWaitResult::Completed(result),
			Self::StartedTask(join_handle) => {

				let result = join_handle.await?;
				ExecutionWaitResult::Completed(result?)
			},
		};

		Ok(result)
	}
}


pub enum ExecutionWaitResult {

	Completed(ExecutionResult),

	Stopped(processes::ChildProcess),
}
