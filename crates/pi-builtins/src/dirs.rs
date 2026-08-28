use std::io::Write;

use brush_core::{ExecutionResult, builtins};
use clap::Parser;

#[derive(Debug, thiserror::Error)]
pub(crate) enum DirError {

	#[error("directory stack is empty")]
	DirStackEmpty,


	#[error(transparent)]
	ShellError(#[from] brush_core::Error),
}

impl From<&DirError> for brush_core::ExecutionExitCode {
	fn from(value: &DirError) -> Self {
		match value {
			DirError::DirStackEmpty => Self::GeneralError,
			DirError::ShellError(e) => e.into(),
		}
	}
}

impl brush_core::BuiltinError for DirError {}


#[derive(Default, Parser)]
pub(crate) struct DirsCommand {

	#[arg(short = 'c')]
	clear: bool,


	#[arg(short = 'l')]
	tilde_long: bool,


	#[arg(short = 'p')]
	print_one_per_line: bool,


	#[arg(short = 'v')]
	print_one_per_line_with_index: bool,


}

impl builtins::Command for DirsCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		if self.clear {
			context.shell.directory_stack_mut().clear();
		} else {
			let dirs = vec![context.shell.working_dir()]
				.into_iter()
				.chain(
					context
						.shell
						.directory_stack()
						.iter()
						.rev()
						.map(|p| p.as_path()),
				)
				.collect::<Vec<_>>();

			let one_per_line = self.print_one_per_line || self.print_one_per_line_with_index;

			for (i, dir) in dirs.iter().enumerate() {
				if !one_per_line && i > 0 {
					write!(context.stdout(), " ")?;
				}

				if self.print_one_per_line_with_index {
					write!(context.stdout(), "{i:2}  ")?;
				}

				let mut dir_str = dir.to_string_lossy().to_string();

				if !self.tilde_long {
					dir_str = context.shell.tilde_shorten(dir_str);
				}

				write!(context.stdout(), "{dir_str}")?;

				if one_per_line || i == dirs.len() - 1 {
					writeln!(context.stdout())?;
				}
			}

			return Ok(ExecutionResult::success());
		}

		Ok(ExecutionResult::success())
	}
}
