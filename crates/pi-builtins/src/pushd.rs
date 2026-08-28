use brush_core::{ExecutionResult, builtins};
use clap::Parser;


#[derive(Parser)]
pub(crate) struct PushdCommand {

	#[clap(short = 'n')]
	no_directory_change: bool,


	dir: String,


}

impl builtins::Command for PushdCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		if self.no_directory_change {
			context
				.shell
				.directory_stack_mut()
				.push(std::path::PathBuf::from(&self.dir));
		} else {
			let prev_working_dir = context.shell.working_dir().to_path_buf();

			let dir = std::path::Path::new(&self.dir);
			context.shell.set_working_dir(dir)?;

			context.shell.directory_stack_mut().push(prev_working_dir);
		}


		let dirs_cmd = crate::dirs::DirsCommand::default();
		dirs_cmd.execute(context).await?;

		Ok(ExecutionResult::success())
	}
}
