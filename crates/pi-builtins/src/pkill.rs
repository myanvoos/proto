//! `pkill` process-signalling builtin moved from `pi-shell`.

use brush_core::builtins;
use clap::Parser;

use crate::proc_match;

/// Selects processes by name or attributes and sends them a signal.
#[derive(Parser)]
#[command(disable_help_flag = true, disable_version_flag = true)]
pub(crate) struct PkillCommand {
	/// Arguments interpreted by the shared process-matching engine.
	#[arg(num_args = 0.., trailing_var_arg = true, allow_hyphen_values = true)]
	argv: Vec<String>,
}

impl builtins::Command for PkillCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		proc_match::run(proc_match::ProcMatchMode::Kill, self.argv.clone(), context).await
	}
}


