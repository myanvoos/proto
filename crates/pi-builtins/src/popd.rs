use brush_core::{ExecutionResult, builtins};
use clap::Parser;


#[derive(Parser)]
pub(crate) struct PopdCommand {

	#[clap(short = 'n')]
	no_directory_change: bool,


}

impl builtins::Command for PopdCommand {
	type Error = crate::dirs::DirError;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		if let Some(popped) = context.shell.directory_stack_mut().pop() {
			if !self.no_directory_change {
				context.shell.set_working_dir(&popped)?;
			}


			let dirs_cmd = crate::dirs::DirsCommand::default();
			dirs_cmd.execute(context).await?;

			Ok(ExecutionResult::success())
		} else {
			Err(crate::dirs::DirError::DirStackEmpty)
		}
	}
}
