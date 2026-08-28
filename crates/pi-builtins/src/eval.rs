use brush_core::{ExecutionResult, builtins};
use clap::Parser;


#[derive(Parser)]
pub(crate) struct EvalCommand {

	#[clap(allow_hyphen_values = true)]
	args: Vec<String>,
}

impl builtins::Command for EvalCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		if !self.args.is_empty() {
			let args_concatenated = self.args.join(" ");

			tracing::debug!("Applying eval to: {:?}", args_concatenated);





			let source_info = context.shell.call_stack().current_pos_as_source_info();





			context
				.shell
				.run_string(args_concatenated, &source_info, &context.params)
				.await
		} else {
			Ok(ExecutionResult::success())
		}
	}
}
