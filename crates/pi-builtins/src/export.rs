use std::io::Write;

use brush_core::{
	ExecutionExitCode, ExecutionResult, builtins,
	env::{EnvironmentLookup, EnvironmentScope},
	parser::ast,
	variables,
};
use clap::Parser;
use itertools::Itertools;


#[derive(Parser)]
pub(crate) struct ExportCommand {

	#[arg(short = 'f')]
	names_are_functions: bool,


	#[arg(short = 'n')]
	unexport: bool,


	#[arg(short = 'p')]
	display_exported_names: bool,





	#[clap(skip)]
	declarations: Vec<brush_core::CommandArg>,
}

impl builtins::DeclarationCommand for ExportCommand {
	fn set_declarations(&mut self, declarations: Vec<brush_core::CommandArg>) {
		self.declarations = declarations;
	}
}

impl builtins::Command for ExportCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		mut context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		if self.declarations.is_empty() {
			display_all_exported_vars(&context)?;
			return Ok(ExecutionResult::success());
		}

		let mut result = ExecutionResult::success();
		for decl in &self.declarations {
			let current_result = self.process_decl(&mut context, decl)?;
			if !current_result.is_success() {
				result = current_result;
			}
		}

		Ok(result)
	}
}

impl ExportCommand {
	fn process_decl(
		&self,
		context: &mut brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
		decl: &brush_core::CommandArg,
	) -> Result<ExecutionResult, brush_core::Error> {
		match decl {
			brush_core::CommandArg::String(s) => {

				if self.names_are_functions {


					if let Some(func) = context.shell.func_mut(s) {
						if self.unexport {
							func.unexport();
						} else {
							func.export();
						}
					} else {
						writeln!(context.stderr(), "{s}: not a function")?;
						return Ok(ExecutionExitCode::InvalidUsage.into());
					}
				}


				else if let Some((_, variable)) = context.shell.env_mut().get_mut(s) {
					if self.unexport {
						variable.unexport();
					} else {
						variable.export();
					}
				}
			},
			brush_core::CommandArg::Assignment(assignment) => {
				let name = match &assignment.name {
					ast::AssignmentName::VariableName(name) => name,
					ast::AssignmentName::ArrayElementName(..) => {
						writeln!(context.stderr(), "not a valid variable name")?;
						return Ok(ExecutionExitCode::InvalidUsage.into());
					},
				};

				let value = match &assignment.value {
					ast::AssignmentValue::Scalar(s) => variables::ShellValueLiteral::Scalar(s.flatten()),
					ast::AssignmentValue::Array(a) => {
						variables::ShellValueLiteral::Array(variables::ArrayLiteral(
							a.iter()
								.map(|(k, v)| (k.as_ref().map(|k| k.flatten()), v.flatten()))
								.collect(),
						))
					},
				};


				context.shell.env_mut().update_or_add(
					name,
					value,
					|var| {
						if self.unexport {
							var.unexport();
						} else {
							var.export();
						}
						Ok(())
					},
					EnvironmentLookup::Anywhere,
					EnvironmentScope::Global,
				)?;
			},
		}

		Ok(ExecutionResult::success())
	}
}

fn display_all_exported_vars(
	context: &brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
) -> Result<(), brush_core::Error> {

	for (name, variable) in context.shell.env().iter().sorted_by_key(|v| v.0) {
		if variable.is_exported() {
			let value = variable.value().try_get_cow_str(context.shell);
			if let Some(value) = value {
				writeln!(context.stdout(), "declare -x {name}=\"{value}\"")?;
			} else {
				writeln!(context.stdout(), "declare -x {name}")?;
			}
		}
	}

	Ok(())
}
