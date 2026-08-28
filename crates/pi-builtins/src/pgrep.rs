//! The `pgrep` process-matching command, moved from `pi-shell`.

use brush_core::builtins;
use clap::Parser;

use crate::proc_match;

/// Finds processes matching the supplied selection criteria.
#[derive(Parser)]
#[command(disable_help_flag = true, disable_version_flag = true)]
pub(crate) struct PgrepCommand {
	#[arg(num_args = 0.., trailing_var_arg = true, allow_hyphen_values = true)]
	argv: Vec<String>,
}

impl builtins::Command for PgrepCommand {
	type Error = brush_core::Error;

	fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> impl Future<Output = Result<brush_core::ExecutionResult, Self::Error>> + Send {
		proc_match::run(proc_match::ProcMatchMode::Grep, self.argv.clone(), context)
	}
}


