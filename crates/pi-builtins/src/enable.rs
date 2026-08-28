use std::io::Write;

use brush_core::{ExecutionResult, builtins};
use clap::Parser;
use itertools::Itertools;


#[derive(Parser)]
pub(crate) struct EnableCommand {

	#[arg(short = 'a')]
	print_list: bool,


	#[arg(short = 'n')]
	disable: bool,


	#[arg(short = 'p')]
	print_reusably: bool,


	#[arg(short = 's')]
	special_only: bool,


	#[arg(short = 'f', value_name = "PATH")]
	shared_object_path: Option<String>,


	#[arg(short = 'd')]
	remove_loaded_builtin: bool,


	names: Vec<String>,
}

impl builtins::Command for EnableCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		let mut result = ExecutionResult::success();

		if let Some(shared_object_path) = &self.shared_object_path {
			writeln!(
				context.stderr(),
				"{}: cannot open shared object {shared_object_path}: dynamic loading is not supported",
				context.command_name
			)?;
			return Ok(ExecutionResult::general_error());
		}

		if !self.names.is_empty() {
			for name in &self.names {
				if self.remove_loaded_builtin {
					if context.shell.builtins().contains_key(name) {
						writeln!(context.stderr(), "{name}: not dynamically loaded")?;
					} else {
						writeln!(context.stderr(), "{name}: not a shell builtin")?;
					}
					result = ExecutionResult::general_error();
					continue;
				}
				if let Some(builtin) = context.shell.builtin_mut(name) {
					builtin.disabled = self.disable;
				} else {
					writeln!(context.stderr(), "{name}: not a shell builtin")?;
					result = ExecutionResult::general_error();
				}
			}
		} else {
			let builtins: Vec<_> = context
				.shell
				.builtins()
				.iter()
				.sorted_by_key(|(name, _reg)| *name)
				.collect();

			for (builtin_name, builtin) in builtins {
				if self.disable {
					if !builtin.disabled {
						continue;
					}
				} else if self.print_list {
					if builtin.disabled {
						continue;
					}
				}

				if self.special_only && !builtin.special_builtin {
					continue;
				}

				let prefix = if builtin.disabled { "-n " } else { "" };

				writeln!(context.stdout(), "enable {prefix}{builtin_name}")?;
			}
		}

		Ok(result)
	}
}
