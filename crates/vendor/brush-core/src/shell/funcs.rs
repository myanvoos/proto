

use std::io::Write;

use crate::{
	ExecutionParameters, commands, error, extensions, functions, jobs,
	results::{ExecutionResult, ExecutionWaitResult},
};

impl<SE: extensions::ShellExtensions> crate::Shell<SE> {

	pub const fn funcs(&self) -> &functions::FunctionEnv {
		&self.funcs
	}



	pub const fn funcs_mut(&mut self) -> &mut functions::FunctionEnv {
		&mut self.funcs
	}







	pub fn undefine_func(&mut self, name: &str) -> bool {
		self.funcs.remove(name).is_some()
	}









	pub fn define_func(
		&mut self,
		name: impl Into<String>,
		definition: brush_parser::ast::FunctionDefinition,
		source_info: &crate::SourceInfo,
	) {
		let reg = functions::Registration::new(definition, source_info);
		self.funcs.update(name.into(), reg);
	}







	pub fn func_mut(&mut self, name: &str) -> Option<&mut functions::Registration> {
		self.funcs.get_mut(name)
	}








	pub fn define_func_from_str(
		&mut self,
		name: impl Into<String>,
		body_text: &str,
	) -> Result<(), error::Error> {
		let name = name.into();

		let mut parser = super::parsing::create_parser(body_text.as_bytes(), &self.parser_options());
		let func_body = parser
			.parse_function_parens_and_body()
			.map_err(|e| error::Error::from(error::ErrorKind::FunctionParseError(name.clone(), e)))?;

		let def =
			brush_parser::ast::FunctionDefinition { fname: name.clone().into(), body: func_body };

		self.define_func(name, def, &crate::SourceInfo::default());

		Ok(())
	}









	pub async fn invoke_function<N: AsRef<str>, I: IntoIterator<Item = A>, A: AsRef<str>>(
		&mut self,
		name: N,
		args: I,
		params: &ExecutionParameters,
	) -> Result<u8, error::Error> {
		let name = name.as_ref();
		let command_name = String::from(name);

		let func_registration = self
			.funcs
			.get(name)
			.ok_or_else(|| error::ErrorKind::FunctionNotFound(name.to_owned()))?
			.to_owned();

		let context =
			commands::ExecutionContext { shell: self, command_name, params: params.clone() };

		let command_args = args
			.into_iter()
			.map(|s| commands::CommandArg::String(String::from(s.as_ref())))
			.collect::<Vec<_>>();

		let result =
			commands::invoke_shell_function(func_registration, context, &command_args).await?;

		match result.wait_with_cancel(params.cancel_token()).await? {
			ExecutionWaitResult::Completed(result) => Ok(result.exit_code.into()),
			ExecutionWaitResult::Stopped(child) => {
				let result = ExecutionResult::stopped();
				let job = self.jobs_mut().add_as_current(jobs::Job::new(
					[jobs::JobTask::External(child)],
					name.to_owned(),
					jobs::JobState::Stopped,
				));
				let formatted = job.to_string();


				writeln!(params.stderr(self), "\r{formatted}")?;

				Ok(result.exit_code.into())
			},
		}
	}
}
