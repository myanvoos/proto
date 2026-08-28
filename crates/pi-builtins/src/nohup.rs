







use std::{future::Future, io::Write};

use brush_core::{
	ExecutionContext, ExecutionExitCode, ExecutionResult, ProcessGroupPolicy, SourceInfo, builtins,
};
use clap::Parser;

use crate::host::quote_arg;


#[derive(Parser)]
#[command(disable_help_flag = true)]
pub(crate) struct NohupCommand {

	#[clap(skip)]
	help:    bool,

	#[clap(skip)]
	version: bool,
	#[arg(num_args = 0.., trailing_var_arg = true, allow_hyphen_values = true)]
	command: Vec<String>,
}

impl NohupCommand {




	fn from_argv(mut argv: Vec<String>) -> Self {
		match argv.first().map(String::as_str) {
			Some("--help") => {
				return Self { help: true, version: false, command: Vec::new() };
			},
			Some("--version") => {
				return Self { help: false, version: true, command: Vec::new() };
			},
			Some("--") => {
				argv.remove(0);
			},
			_ => {},
		}
		Self { help: false, version: false, command: argv }
	}
}

impl builtins::Command for NohupCommand {
	type Error = brush_core::Error;




	fn new<I>(args: I) -> std::result::Result<Self, clap::Error>
	where
		I: IntoIterator<Item = String>,
	{

		Ok(Self::from_argv(args.into_iter().skip(1).collect()))
	}

	fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> impl Future<Output = std::result::Result<ExecutionResult, brush_core::Error>> + Send {
		let command = self.command.clone();
		let (help, version) = (self.help, self.version);
		async move {
			if context.is_cancelled() {
				return Ok(ExecutionExitCode::Interrupted.into());
			}
			if help {
				let _ = write!(context.stdout(), "{NOHUP_HELP}");
				return Ok(ExecutionResult::success());
			}
			if version {
				let _ = writeln!(
					context.stdout(),
					"nohup (pi-builtins) {}",
					env!("CARGO_PKG_VERSION")
				);
				return Ok(ExecutionResult::success());
			}

			if command.is_empty() {
				return Ok(report_missing_operand(context.stderr()));
			}








			let command_line = rebuild_command_line(&command);

			let mut params = context.params.clone();
			params.process_group_policy = ProcessGroupPolicy::NewProcessGroup;
			let source_info = SourceInfo::from("pi-natives:nohup");
			context
				.shell
				.run_string(command_line, &source_info, &params)
				.await
		}
	}
}

const NOHUP_HELP: &str = "\
Usage: nohup COMMAND [ARG]...
  or:  nohup OPTION
Run COMMAND immune to the shell's teardown, in a new process group.

      --help     display this help and exit
      --version  output version information and exit
";

fn report_missing_operand(mut stderr: impl Write) -> ExecutionResult {
	let _ = writeln!(stderr, "nohup: missing operand");
	ExecutionResult::new(125)
}

fn rebuild_command_line(command: &[String]) -> String {
	let mut command_line = String::new();
	for (idx, arg) in command.iter().enumerate() {
		if idx > 0 {
			command_line.push(' ');
		}
		command_line.push_str(&quote_arg(arg));
	}
	command_line
}


