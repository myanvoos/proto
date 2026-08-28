use std::{
	io::Write,
	path::{Path, PathBuf},
};

use brush_core::{
	ExecutionResult, Shell, builtins,
	parser::ast,
	sys::{self, fs::PathExt},
};
use clap::Parser;


#[derive(Parser)]
pub(crate) struct TypeCommand {

	#[arg(short = 'a')]
	all_locations: bool,


	#[arg(short = 'f')]
	suppress_func_lookup: bool,



	#[arg(short = 'P')]
	force_path_search: bool,


	#[arg(short = 'p')]
	show_path_only: bool,


	#[arg(short = 't')]
	type_only: bool,


	names: Vec<String>,
}

enum ResolvedType<'a> {
	Alias(String),
	Keyword,
	Function(&'a ast::FunctionDefinition),
	Builtin,
	File { path: PathBuf, hashed: bool },
}

impl builtins::Command for TypeCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		let mut result = ExecutionResult::success();

		for name in &self.names {
			let resolved_types = self.resolve_types(context.shell, name);

			if resolved_types.is_empty() {
				if !self.type_only && !self.force_path_search && !self.show_path_only {
					writeln!(context.stderr(), "type: {name} not found")?;
				}

				result = ExecutionResult::general_error();
				continue;
			}

			for resolved_type in resolved_types {
				if self.show_path_only && !matches!(resolved_type, ResolvedType::File { .. }) {

				} else if self.type_only {
					match resolved_type {
						ResolvedType::Alias(_) => {
							writeln!(context.stdout(), "alias")?;
						},
						ResolvedType::Keyword => {
							writeln!(context.stdout(), "keyword")?;
						},
						ResolvedType::Function(_) => {
							writeln!(context.stdout(), "function")?;
						},
						ResolvedType::Builtin => {
							writeln!(context.stdout(), "builtin")?;
						},
						ResolvedType::File { path, .. } => {
							if self.show_path_only || self.force_path_search {
								writeln!(context.stdout(), "{}", path.to_string_lossy())?;
							} else {
								writeln!(context.stdout(), "file")?;
							}
						},
					}
				} else {
					match resolved_type {
						ResolvedType::Alias(target) => {
							writeln!(context.stdout(), "{name} is aliased to `{target}'")?;
						},
						ResolvedType::Keyword => {
							writeln!(context.stdout(), "{name} is a shell keyword")?;
						},
						ResolvedType::Function(def) => {
							writeln!(context.stdout(), "{name} is a function")?;
							writeln!(context.stdout(), "{def}")?;
						},
						ResolvedType::Builtin => {
							writeln!(context.stdout(), "{name} is a shell builtin")?;
						},
						ResolvedType::File { path, hashed } => {
							if hashed && self.all_locations && !self.force_path_search {


							} else if self.show_path_only || self.force_path_search {
								writeln!(context.stdout(), "{}", path.to_string_lossy())?;
							} else if hashed {
								writeln!(
									context.stdout(),
									"{name} is hashed ({path})",
									name = name,
									path = path.to_string_lossy()
								)?;
							} else {
								writeln!(
									context.stdout(),
									"{name} is {path}",
									name = name,
									path = path.to_string_lossy()
								)?;
							}
						},
					}
				}


				if !self.all_locations {
					break;
				}
			}
		}

		Ok(result)
	}
}

impl TypeCommand {
	fn resolve_types<'a, SE: brush_core::ShellExtensions>(
		&self,
		shell: &'a Shell<SE>,
		name: &str,
	) -> Vec<ResolvedType<'a>> {
		let mut types = vec![];

		if !self.force_path_search {

			if let Some(a) = shell.aliases().get(name) {
				types.push(ResolvedType::Alias(a.clone()));
				if !self.all_locations {
					return types;
				}
			}


			if shell.is_keyword(name) {
				types.push(ResolvedType::Keyword);
				if !self.all_locations {
					return types;
				}
			}


			if !self.suppress_func_lookup {
				if let Some(registration) = shell.funcs().get(name) {
					types.push(ResolvedType::Function(registration.definition()));
					if !self.all_locations {
						return types;
					}
				}
			}


			if shell.builtins().get(name).is_some_and(|b| !b.disabled) {
				types.push(ResolvedType::Builtin);
				if !self.all_locations {
					return types;
				}
			}
		}


		if sys::fs::contains_path_separator(name) {
			if shell.absolute_path(Path::new(name)).executable() {
				types.push(ResolvedType::File { path: PathBuf::from(name), hashed: false });

				if !self.all_locations {
					return types;
				}
			}
		} else {
			if let Some(path) = shell.program_location_cache().get(name) {
				types.push(ResolvedType::File { path, hashed: true });
				if !self.all_locations {
					return types;
				}
			}

			for item in shell.find_executables_in_path(name) {
				types.push(ResolvedType::File { path: item, hashed: false });

				if !self.all_locations {
					return types;
				}
			}
		}

		types
	}
}
