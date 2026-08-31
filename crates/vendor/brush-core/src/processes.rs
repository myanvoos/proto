

use futures::FutureExt;
use std::io::Write;

use tokio_util::sync::CancellationToken;

use crate::{error, openfiles::OpenFile, sys};

struct CompletionMarker {
	output:            OpenFile,
	end_marker_prefix: String,
	end_marker_suffix: String,
}


pub(crate) type WaitableChildProcess = std::pin::Pin<
	Box<dyn futures::Future<Output = Result<std::process::Output, std::io::Error>> + Send + Sync>,
>;


pub struct ChildProcess {


	exec_future: WaitableChildProcess,

	reaped:      bool,

	pid:         Option<sys::process::ProcessId>,

	pgid:        Option<sys::process::ProcessId>,

	completion_marker: Option<CompletionMarker>,
}

impl ChildProcess {

	pub fn new(
		child: sys::process::Child,
		pid: Option<sys::process::ProcessId>,
		pgid: Option<sys::process::ProcessId>,
	) -> Self {
		Self {
			exec_future: Box::pin(child.wait_with_output()),
			pid,
			pgid,
			reaped: false,
			completion_marker: None,
		}
	}


	pub const fn pid(&self) -> Option<sys::process::ProcessId> {
		self.pid
	}


	pub const fn pgid(&self) -> Option<sys::process::ProcessId> {
		self.pgid
	}


	pub(crate) fn set_completion_marker(
		&mut self,
		output: OpenFile,
		end_marker_prefix: String,
		end_marker_suffix: String,
	) {
		self.completion_marker =
			Some(CompletionMarker { output, end_marker_prefix, end_marker_suffix });
	}


	pub async fn wait(
		&mut self,
		cancel_token: Option<CancellationToken>,
	) -> Result<ProcessWaitResult, error::Error> {
		#[allow(unused_mut, reason = "only mutated on some platforms")]
		let mut sigtstp = sys::signal::tstp_signal_listener()?;
		#[allow(unused_mut, reason = "only mutated on some platforms")]
		let mut sigchld = sys::signal::chld_signal_listener()?;

		let cancelled = async {
			match &cancel_token {
				Some(token) => token.cancelled().await,
				None => std::future::pending().await,
			}
		};
		tokio::pin!(cancelled);

		#[allow(clippy::ignored_unit_patterns)]
		loop {
			tokio::select! {
				output = &mut self.exec_future => {
					let output = output?;
					let marker_exit_code = completion_exit_code(&output.status);
					self.reaped = true;
					self.write_completion_marker(marker_exit_code);
					break Ok(ProcessWaitResult::Completed(output))
				},
				_ = &mut cancelled => {
					self.kill();
					self.write_completion_marker(130);
					break Ok(ProcessWaitResult::Cancelled)
				},
				_ = sigtstp.recv() => {
					break Ok(ProcessWaitResult::Stopped)
				},
				_ = sigchld.recv() => {
					if sys::signal::poll_for_stopped_children()? {
						break Ok(ProcessWaitResult::Stopped);
					}
				},
				_ = sys::signal::await_ctrl_c() => {


				},
			}
		}
	}


	fn kill(&mut self) {
		if self.reaped {
			return;
		}
		#[cfg(unix)]
		{
			let Some(pid) = self.pid else { return };
			let _ = nix::sys::signal::kill(
				nix::unistd::Pid::from_raw(pid),
				nix::sys::signal::Signal::SIGKILL,
			);
		}

	}

	fn write_completion_marker(&mut self, exit_code: i32) {
		if let Some(mut marker) = self.completion_marker.take() {
			let _ = write!(
				marker.output,
				"{}{}{}",
				marker.end_marker_prefix, exit_code, marker.end_marker_suffix
			);
			let _ = marker.output.flush();
		}
	}

	pub(crate) fn poll(&mut self) -> Option<Result<std::process::Output, error::Error>> {
		let result = self.exec_future.as_mut().now_or_never()?;
		Some(match result {
			Ok(output) => {
				let marker_exit_code = completion_exit_code(&output.status);
				self.reaped = true;
				self.write_completion_marker(marker_exit_code);
				Ok(output)
			},
			Err(err) => Err(err.into()),
		})
	}
}

impl Drop for ChildProcess {
	fn drop(&mut self) {

		self.kill();
	}
}


fn completion_exit_code(status: &std::process::ExitStatus) -> i32 {
	if let Some(code) = status.code() {
		return code;
	}

	#[cfg(unix)]
	{
		use std::os::unix::process::ExitStatusExt as _;
		if let Some(signal) = status.signal() {
			return 128 + signal;
		}
	}

	127
}


pub enum ProcessWaitResult {

	Completed(std::process::Output),

	Stopped,

	Cancelled,
}
