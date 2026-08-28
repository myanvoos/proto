use std::path::Path;

use brush_core::builtins;
use clap::Parser;


#[derive(Parser)]
pub(crate) struct DotCommand {

	script_path: String,


	#[arg(trailing_var_arg = true, allow_hyphen_values = true)]
	script_args: Vec<String>,
}

impl builtins::Command for DotCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {

		context
			.shell
			.source_script(Path::new(&self.script_path), self.script_args.iter(), &context.params)
			.await
	}
}
