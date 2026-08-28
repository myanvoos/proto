//! `pidwait` process-waiting builtin, moved from `pi-shell`.

use brush_core::builtins;
use clap::Parser;

use crate::proc_match;

/// Waits for processes selected by process attributes or a name pattern.
#[derive(Parser)]
#[command(disable_help_flag = true, disable_version_flag = true)]
pub(crate) struct PidwaitCommand {
	#[arg(num_args = 0.., trailing_var_arg = true, allow_hyphen_values = true)]
	argv: Vec<String>,
}

impl builtins::Command for PidwaitCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		proc_match::run(proc_match::ProcMatchMode::Wait, self.argv.clone(), context).await
	}
}


