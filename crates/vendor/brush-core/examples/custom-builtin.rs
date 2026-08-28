














use std::io::Write;

use anyhow::Result;
use brush_core::{ExecutionResult, builtins};
use clap::Parser;








#[derive(Debug, thiserror::Error)]
enum GreetError {

	#[error("repeat count out of range")]
	RepeatCountOutOfRange,



	#[error(transparent)]
	ShellError(#[from] brush_core::Error),


	#[error("I/O error occurred during greeting: {0}")]
	IoError(#[from] std::io::Error),
}



impl brush_core::BuiltinError for GreetError {}




impl From<&GreetError> for brush_core::ExecutionExitCode {
	fn from(value: &GreetError) -> Self {
		match value {
			GreetError::RepeatCountOutOfRange => Self::InvalidUsage,
			GreetError::ShellError(e) => e.into(),
			GreetError::IoError(_) => Self::GeneralError,
		}
	}
}











#[derive(Parser)]
struct GreetCommand {

	#[arg(short = 'n', long = "repeat", default_value_t = 1)]
	repeat_count: usize,
}







impl builtins::Command for GreetCommand {


	type Error = GreetError;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {

		if self.repeat_count == 0 || self.repeat_count > 10 {
			return Err(GreetError::RepeatCountOutOfRange);
		}




		let greeting = context
			.shell
			.basic_expand_string(&context.params, "Hello, ${USER}!")
			.await?;


		for _ in 0..self.repeat_count {
			writeln!(context.stdout(), "{greeting}")?;
		}


		Ok(ExecutionResult::success())
	}
}







type SE = brush_core::extensions::DefaultShellExtensions;

async fn run_example() -> Result<()> {

	let mut shell = brush_core::Shell::builder()
		.builtin("greet", brush_core::builtins::builtin::<GreetCommand, SE>())
		.build()
		.await?;


	let result = shell
		.run_string("greet -n 4", &brush_core::SourceInfo::default(), &shell.default_exec_params())
		.await?;
	println!("Exit code: {}\n", u8::from(result.exit_code));

	Ok(())
}

fn main() -> Result<()> {

	let rt = tokio::runtime::Builder::new_multi_thread()
		.enable_all()
		.build()?;

	rt.block_on(run_example())?;

	Ok(())
}
