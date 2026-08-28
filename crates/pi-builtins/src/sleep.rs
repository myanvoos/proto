//! The `sleep` builtin, moved from `pi-shell`.

use std::{future::Future, io::Write, time::Duration};

use brush_core::{ExecutionContext, ExecutionExitCode, ExecutionResult, builtins};
use clap::Parser;
use tokio::time;

use crate::host::parse_duration;

/// Pause execution for the sum of the requested durations.
#[derive(Parser)]
#[command(disable_help_flag = true)]
pub(crate) struct SleepCommand {
	// GNU reports `sleep -1` as an invalid time interval (exit 1), not as an
	// unknown option; let hyphenated operands through to `parse_duration`.
	#[arg(required = true, allow_hyphen_values = true)]
	durations: Vec<String>,
}

impl builtins::Command for SleepCommand {
	type Error = brush_core::Error;

	fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> impl Future<Output = std::result::Result<ExecutionResult, brush_core::Error>> + Send {
		let durations = self.durations.clone();
		async move {
			if context.is_cancelled() {
				return Ok(ExecutionExitCode::Interrupted.into());
			}
			let mut total = Duration::ZERO;
			for duration in &durations {
				let Some(parsed) = parse_duration(duration) else {
					let _ = writeln!(context.stderr(), "sleep: invalid time interval '{duration}'");
					return Ok(ExecutionResult::new(1));
				};
				// `infinity` parses as `Duration::MAX`; keep the sum saturating.
				total = total.saturating_add(parsed);
			}
			let sleep = time::sleep(total);
			tokio::pin!(sleep);
			if let Some(cancel_token) = context.cancel_token() {
				tokio::select! {
					() = &mut sleep => Ok(ExecutionResult::success()),
					() = cancel_token.cancelled() => Ok(ExecutionExitCode::Interrupted.into()),
				}
			} else {
				sleep.await;
				Ok(ExecutionResult::success())
			}
		}
	}
}


