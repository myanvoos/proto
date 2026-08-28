use std::{io::Write, path::PathBuf};

use brush_core::{ExecutionResult, builtins};
use clap::Parser;


#[derive(Parser)]
pub(crate) struct CdCommand {

	#[arg(short = 'L', overrides_with = "use_physical_dir")]
	force_follow_symlinks: bool,


	#[arg(short = 'P', overrides_with = "force_follow_symlinks")]
	use_physical_dir: bool,



	#[arg(short = 'e')]
	exit_on_failed_cwd_resolution: bool,



	target_dir: Option<PathBuf>,
}

impl builtins::Command for CdCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		let mut should_print = false;
		let mut target_dir = if let Some(target_dir) = &self.target_dir {

			if target_dir.as_os_str() == "-" {
				should_print = true;
				if let Some(oldpwd) = context.shell.env_str("OLDPWD") {
					PathBuf::from(oldpwd.to_string())
				} else {
					writeln!(context.stderr(), "OLDPWD not set")?;
					return Ok(ExecutionResult::general_error());
				}
			} else {

				target_dir.clone()
			}

		} else {
			if let Some(home_var) = context.shell.env_str("HOME") {
				PathBuf::from(home_var.to_string())
			} else {
				writeln!(context.stderr(), "HOME not set")?;
				return Ok(ExecutionResult::general_error());
			}
		};

		if self.use_physical_dir
			|| context
				.shell
				.options()
				.do_not_resolve_symlinks_when_changing_dir
		{



			target_dir = context.shell.absolute_path(target_dir).canonicalize()?;
		}

		context.shell.set_working_dir(&target_dir)?;






		if should_print {
			writeln!(context.stdout(), "{}", target_dir.display())?;
		}

		Ok(ExecutionResult::success())
	}
}
