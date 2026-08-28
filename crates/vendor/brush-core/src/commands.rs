

use std::{
	borrow::Cow,
	ffi::OsStr,
	fmt::Display,
	io::{self, Write},
	path::{Path, PathBuf},
};

use brush_parser::ast;
use itertools::Itertools;
use sys::commands::{CommandExt, CommandFdInjectionExt, CommandFgControlExt, CommandSessionExt};

use crate::{
	ErrorKind, ExecutionControlFlow, ExecutionExitCode, ExecutionParameters, ExecutionResult, Shell,
	ShellFd, builtins, commands, env, error, escape,
	extensions::{self, ShellExtensions},
	functions,
	interp::{self, Execute, ExternalCommandInfo, ExternalCommandOutputMarkers, ProcessGroupPolicy},
	openfiles::{self, OpenFiles},
	pathsearch, processes,
	results::{ExecutionSpawnResult, ExecutionWaitResult},
	sys, trace_categories, traps, variables,
};


pub enum CommandWaitResult {

	CommandCompleted(ExecutionResult),

	CommandStopped(ExecutionResult, processes::ChildProcess),
}


pub struct ExecutionContext<'a, SE: ShellExtensions = extensions::DefaultShellExtensions> {

	pub shell:        &'a mut Shell<SE>,

	pub command_name: String,

	pub params:       ExecutionParameters,
}

impl<SE: ShellExtensions> ExecutionContext<'_, SE> {

	pub fn stdin(&self) -> impl std::io::Read + 'static {
		self.params.stdin(self.shell)
	}


	pub fn stdout(&self) -> impl std::io::Write + 'static {
		self.params.stdout(self.shell)
	}


	pub fn stderr(&self) -> impl std::io::Write + 'static {
		self.params.stderr(self.shell)
	}


	pub fn cancel_token(&self) -> Option<tokio_util::sync::CancellationToken> {
		self.params.cancel_token()
	}


	pub fn is_cancelled(&self) -> bool {
		self.params.is_cancelled()
	}







	pub fn try_fd(&self, fd: ShellFd) -> Option<openfiles::OpenFile> {
		self.params.try_fd(self.shell, fd)
	}


	pub fn iter_fds(&self) -> impl Iterator<Item = (ShellFd, openfiles::OpenFile)> {
		self.params.iter_fds(self.shell)
	}
}


#[derive(Clone, Debug)]
pub enum CommandArg {

	String(String),


	Assignment(ast::Assignment),
}

impl Display for CommandArg {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::String(s) => f.write_str(s),
			Self::Assignment(a) => write!(f, "{a}"),
		}
	}
}

impl From<String> for CommandArg {
	fn from(s: String) -> Self {
		Self::String(s)
	}
}

impl From<&String> for CommandArg {
	fn from(value: &String) -> Self {
		Self::String(value.clone())
	}
}

impl CommandArg {
	pub(crate) fn quote_for_tracing(&self) -> Cow<'_, str> {
		match self {
			Self::String(s) => escape::quote_if_needed(s, escape::QuoteMode::SingleQuote),
			Self::Assignment(a) => {
				let mut s = a.name.to_string();
				let op = if a.append { "+=" } else { "=" };
				s.push_str(op);
				s.push_str(&escape::quote_if_needed(
					a.value.to_string().as_str(),
					escape::QuoteMode::SingleQuote,
				));
				s.into()
			},
		}
	}
}


pub enum ShellForCommand<'a, SE: extensions::ShellExtensions> {


	ParentShell(&'a mut Shell<SE>),

	OwnedShell {

		target: Box<Shell<SE>>,

		parent: &'a mut Shell<SE>,
	},
}

impl<SE: extensions::ShellExtensions> std::ops::Deref for ShellForCommand<'_, SE> {
	type Target = Shell<SE>;

	fn deref(&self) -> &Self::Target {
		match self {
			ShellForCommand::ParentShell(shell) => shell,
			ShellForCommand::OwnedShell { target, .. } => target,
		}
	}
}

impl<SE: extensions::ShellExtensions> std::ops::DerefMut for ShellForCommand<'_, SE> {
	fn deref_mut(&mut self) -> &mut Self::Target {
		match self {
			ShellForCommand::ParentShell(shell) => shell,
			ShellForCommand::OwnedShell { target, .. } => target,
		}
	}
}















#[allow(unused_variables, reason = "argv0 is only used on unix platforms")]
pub fn compose_std_command<S: AsRef<OsStr>, SE: extensions::ShellExtensions>(
	context: &ExecutionContext<'_, SE>,
	command_name: &str,
	argv0: &str,
	args: &[S],
	empty_env: bool,
) -> Result<std::process::Command, error::Error> {
	let mut cmd = std::process::Command::new(command_name);



	cmd.arg0(argv0);


	cmd.args(args);


	cmd.current_dir(context.shell.working_dir());


	cmd.env_clear();


	if !empty_env {
		for (k, v) in context.shell.env().iter_exported() {



			if v.value().is_set() {
				cmd.env(k.as_str(), v.value().to_cow_str(context.shell).as_ref());
			}
		}

		cmd.env("_", command_name);
	}


	if !empty_env {
		for (func_name, registration) in context.shell.funcs().iter() {
			if registration.is_exported() {
				let var_name = std::format!("BASH_FUNC_{func_name}%%");
				let value = std::format!("() {}", registration.definition().body);
				cmd.env(var_name, value);
			}
		}
	}


	match context.try_fd(OpenFiles::STDIN_FD) {
		None => (),
		Some(stdin_file) => {
			let as_stdio = stdin_file.into_stdio()?;
			cmd.stdin(as_stdio);
		},
	}


	match context.try_fd(OpenFiles::STDOUT_FD) {
		None => (),
		Some(stdout_file) => {
			let as_stdio = stdout_file.into_stdio()?;
			cmd.stdout(as_stdio);
		},
	}


	match context.try_fd(OpenFiles::STDERR_FD) {
		None => {},
		Some(stderr_file) => {
			let as_stdio = stderr_file.into_stdio()?;
			cmd.stderr(as_stdio);
		},
	}


	let other_files = context.iter_fds().filter(|(fd, _)| {
		*fd != OpenFiles::STDIN_FD && *fd != OpenFiles::STDOUT_FD && *fd != OpenFiles::STDERR_FD
	});
	cmd.inject_fds(other_files)?;

	Ok(cmd)
}

pub(crate) async fn on_preexecute(
	cmd: &mut commands::SimpleCommand<'_, impl extensions::ShellExtensions>,
) -> Result<(), error::Error> {


	let full_cmd = cmd.args.iter().map(|arg| arg.to_string()).join(" ");
	cmd.shell.env_mut().update_or_add(
		"BASH_COMMAND",
		variables::ShellValueLiteral::Scalar(full_cmd),
		|_| Ok(()),
		env::EnvironmentLookup::Anywhere,
		env::EnvironmentScope::Global,
	)?;


	if cmd.shell.traps().handles(traps::TrapSignal::Debug) {
		let _ = cmd
			.shell
			.invoke_trap_handler(traps::TrapSignal::Debug, &cmd.params)
			.await?;
	}

	Ok(())
}


pub struct SimpleCommand<'a, SE: extensions::ShellExtensions> {

	shell: ShellForCommand<'a, SE>,


	pub params: ExecutionParameters,


	pub command_name: String,


	pub args: Vec<CommandArg>,



	pub use_functions: bool,



	pub path_dirs: Option<Vec<PathBuf>>,



	pub process_group_id: Option<i32>,

	pub in_pipeline: bool,



	pub argv0: Option<String>,




	#[allow(clippy::type_complexity)]
	pub post_execute: Option<fn(&mut Shell<SE>) -> Result<(), error::Error>>,
}

impl<'a, SE: extensions::ShellExtensions> SimpleCommand<'a, SE> {








	pub const fn new(
		shell: ShellForCommand<'a, SE>,
		params: ExecutionParameters,
		command_name: String,
		args: Vec<CommandArg>,
	) -> Self {
		Self {
			shell,
			params,
			command_name,
			args,
			use_functions: true,
			path_dirs: None,
			process_group_id: None,
			in_pipeline: false,
			argv0: None,
			post_execute: None,
		}
	}






	#[allow(clippy::missing_panics_doc, reason = "these unwrap calls should not panic")]
	pub async fn execute(mut self) -> Result<ExecutionSpawnResult, error::Error> {

		let builtin = self.shell.builtins().get(&self.command_name).cloned();



		if self.shell.options().posix_mode
			&& builtin
				.as_ref()
				.is_some_and(|r| !r.disabled && r.special_builtin)
		{
			#[allow(clippy::unwrap_used, reason = "we just checked that builtin is Some")]
			let builtin = builtin.unwrap();
			return self.execute_via_builtin(builtin).await;
		}



		if self.use_functions {
			if let Some(func_registration) =
				self.shell.funcs().get(self.command_name.as_str()).cloned()
			{
				return self.execute_via_function(func_registration).await;
			}
		}



		if let Some(builtin) = builtin {
			if !builtin.disabled {
				return self.execute_via_builtin(builtin).await;
			}
		}



		if !sys::fs::contains_path_separator(&self.command_name) {



			let path = if let Some(path_dirs) = &self.path_dirs {
				pathsearch::search_for_executable(path_dirs.iter(), self.command_name.as_str()).next()
			} else {
				self
					.shell
					.find_first_executable_in_path_using_cache(&self.command_name)
			};

			if let Some(path) = path {
				self.execute_via_external(&path)
			} else {


				let last_arg = Self::take_last_arg(&self.args);
				self.shell.update_last_arg_variable(last_arg);

				if let Some(post_execute) = self.post_execute {
					let _ = post_execute(&mut self.shell);
				}

				Err(ErrorKind::CommandNotFound(self.command_name).into())
			}
		} else {
			let command_name = PathBuf::from(self.command_name.clone());
			self.execute_via_external(command_name.as_path())
		}
	}



	fn take_last_arg(args: &[CommandArg]) -> Option<String> {
		args.last().map(ToString::to_string)
	}

	async fn execute_via_builtin(
		self,
		builtin: builtins::Registration<SE>,
	) -> Result<ExecutionSpawnResult, error::Error> {
		match self.shell {
			ShellForCommand::OwnedShell { target, .. } => {
				Ok(Self::execute_via_builtin_in_owned_shell(
					*target,
					self.params,
					builtin,
					self.command_name,
					self.args,
				))
			},
			ShellForCommand::ParentShell(..) => {
				self.execute_via_builtin_in_parent_shell(builtin).await
			},
		}
	}

	fn execute_via_builtin_in_owned_shell(
		mut shell: Shell<SE>,
		params: ExecutionParameters,
		builtin: builtins::Registration<SE>,
		command_name: String,
		args: Vec<CommandArg>,
	) -> ExecutionSpawnResult {
		let last_arg = Self::take_last_arg(&args);
		let join_handle = tokio::task::spawn_blocking(move || {
			let cmd_context = ExecutionContext { shell: &mut shell, command_name, params };

			let rt = tokio::runtime::Handle::current();
			let result = rt.block_on(execute_builtin_command(&builtin, cmd_context, args));


			shell.update_last_arg_variable(last_arg);

			result
		});

		ExecutionSpawnResult::StartedTask(join_handle)
	}

	async fn execute_via_builtin_in_parent_shell(
		self,
		builtin: builtins::Registration<SE>,
	) -> Result<ExecutionSpawnResult, error::Error> {
		let mut shell = self.shell;
		let last_arg = Self::take_last_arg(&self.args);

		let cmd_context = ExecutionContext {
			shell:        &mut shell,
			command_name: self.command_name,
			params:       self.params,
		};

		let result = execute_builtin_command(&builtin, cmd_context, self.args).await;


		shell.update_last_arg_variable(last_arg);

		if let Some(post_execute) = self.post_execute {
			let _ = post_execute(&mut shell);
		}

		let result = result?;

		Ok(result.into())
	}

	async fn execute_via_function(
		self,
		func_registration: functions::Registration,
	) -> Result<ExecutionSpawnResult, error::Error> {
		let mut params = self.params;
		params.disable_command_output_marking();

		let last_arg = Self::take_last_arg(&self.args);

		match self.shell {





			ShellForCommand::OwnedShell { target, .. } => {
				let mut shell = *target;
				let command_name = self.command_name;
				let args = self.args;
				let join_handle = tokio::spawn(async move {
					let cmd_context = ExecutionContext { shell: &mut shell, command_name, params };
					let result =
						invoke_shell_function(func_registration, cmd_context, &args[1..]).await;



					shell.update_last_arg_variable(last_arg);

					match result?.wait().await? {
						ExecutionWaitResult::Completed(result) => Ok(result),
						ExecutionWaitResult::Stopped(_) => Ok(ExecutionResult::stopped()),
					}
				});
				Ok(ExecutionSpawnResult::StartedTask(join_handle))
			},
			mut shell => {
				let cmd_context = ExecutionContext {
					shell:        &mut shell,
					command_name: self.command_name,
					params,
				};


				let result = invoke_shell_function(func_registration, cmd_context, &self.args[1..]).await;





				shell.update_last_arg_variable(last_arg);

				if let Some(post_execute) = self.post_execute {
					let _ = post_execute(&mut shell);
				}

				result
			},
		}
	}

	fn execute_via_external(self, path: &Path) -> Result<ExecutionSpawnResult, error::Error> {
		let mut shell = self.shell;
		let last_arg = Self::take_last_arg(&self.args);

		let cmd_context = ExecutionContext {
			shell:        &mut shell,
			command_name: self.command_name,
			params:       self.params,
		};

		let resolved_path = path.to_string_lossy();
		let result = execute_external_command(
			cmd_context,
			resolved_path.as_ref(),
			self.in_pipeline,
			self.process_group_id,
			self.argv0.as_deref(),
			&self.args[1..],
		);


		shell.update_last_arg_variable(last_arg);

		if let Some(post_execute) = self.post_execute {
			let _ = post_execute(&mut shell);
		}

		result
	}
}

pub(crate) fn execute_external_command(
	context: ExecutionContext<'_, impl extensions::ShellExtensions>,
	executable_path: &str,
	in_pipeline: bool,
	process_group_id: Option<i32>,
	argv0_override: Option<&str>,
	args: &[CommandArg],
) -> Result<ExecutionSpawnResult, error::Error> {

	let cmd_args = args
		.iter()
		.filter_map(|e| {
			if let CommandArg::String(s) = e {
				Some(s)
			} else {
				None
			}
		})
		.collect::<Vec<_>>();



	let child_stdin_is_terminal = context
		.try_fd(openfiles::OpenFiles::STDIN_FD)
		.is_some_and(|f| f.is_terminal());


	let new_pg = matches!(context.params.process_group_policy, ProcessGroupPolicy::NewProcessGroup);
	let session_action = child_session_action(new_pg, child_stdin_is_terminal, in_pipeline);




	let argv0 = argv0_override.unwrap_or(context.command_name.as_str());
	#[allow(unused_mut, reason = "only mutated on unix platforms")]
	let mut cmd = compose_std_command(
		&context,
		executable_path,
		argv0,
		cmd_args.as_slice(),
		false,
	)?;
	let mut marker_output = prepare_output_markers(&context, executable_path, cmd_args.as_slice());











	let command_leads_session = new_pg
		&& matches!(session_action, ChildSessionAction::TakeForeground)
		&& context.shell.options().external_cmd_leads_session;

	match session_action {
		ChildSessionAction::DetachSession => {



			if context.params.detach_reparent {
				cmd.detach_session_reparent();
			} else {
				cmd.detach_session();
			}
		}
		ChildSessionAction::TakeForeground if command_leads_session => {

			cmd.lead_session();
		}
		ChildSessionAction::TakeForeground => {


			if new_pg {
				cmd.process_group(0);
			} else if let Some(pgid) = process_group_id {
				cmd.process_group(pgid);
			}
			cmd.take_foreground();
		}
		ChildSessionAction::None => {


			if new_pg {
				cmd.process_group(0);
			} else if let Some(pgid) = process_group_id {
				cmd.process_group(pgid);
			}
		}
	}


	tracing::debug!(
		 target: trace_categories::COMMANDS,
		 "Spawning: cmd='{} {}'",
		 cmd.get_program().to_string_lossy().to_string(),
		 cmd.get_args()
			  .map(|a| a.to_string_lossy().to_string())
			  .join(" ")
	);

	match sys::process::spawn(cmd) {
		Ok(child) => {

			#[expect(clippy::cast_possible_wrap)]
			let pid = child.id().map(|id| id as i32);
			let mut actual_pgid = process_group_id;
			if let Some(pid) = &pid {
				if new_pg {
					actual_pgid = Some(*pid);
				}
			} else {
				tracing::warn!("could not retrieve pid for child process");
			}





			if !context.params.detach_reparent
				&& let Some(observer) = context.params.spawn_observer()
				&& let Some(pid) = pid
			{
				observer.on_spawn(pid, actual_pgid);
			}

			let mut child_process = processes::ChildProcess::new(child, pid, actual_pgid);
			if let Some((output, markers)) = marker_output.take() {
				child_process.set_completion_marker(
					output,
					markers.end_marker_prefix,
					markers.end_marker_suffix,
				);
			}
			Ok(ExecutionSpawnResult::StartedProcess(child_process))
		},
		Err(spawn_err) => {
			if let Some((mut output, markers)) = marker_output.take() {
				let _ = write_completion_marker(&mut output, &markers, 127);
			}

			if context.shell.options().interactive {
				sys::terminal::move_self_to_foreground()?;
			}

			if spawn_err.kind() == std::io::ErrorKind::NotFound {
				if !context.shell.working_dir().exists() {
					Err(
						error::ErrorKind::WorkingDirMissing(context.shell.working_dir().to_owned())
							.into(),
					)
				} else {
					Err(error::ErrorKind::CommandNotFound(context.command_name).into())
				}
			} else {
				Err(error::ErrorKind::FailedToExecuteCommand(context.command_name, spawn_err).into())
			}
		},
	}
}

fn prepare_output_markers<SE: extensions::ShellExtensions>(
	context: &ExecutionContext<'_, SE>,
	executable_path: &str,
	args: &[&String],
) -> Option<(openfiles::OpenFile, ExternalCommandOutputMarkers)> {
	let marker = context.params.command_output_marker()?;
	let markers = marker.markers_for_external_command(ExternalCommandInfo {
		command_name:    context.command_name.as_str(),
		executable_path,
		args:            args.iter().map(|arg| arg.as_str()).collect(),
	})?;
	let mut output = context.params.try_stdout(context.shell)?;
	if output.write_all(markers.start_marker.as_bytes()).is_err() {
		return None;
	}
	if output.flush().is_err() {
		return None;
	}
	Some((output, markers))
}

fn write_completion_marker(
	output: &mut openfiles::OpenFile,
	markers: &ExternalCommandOutputMarkers,
	exit_code: i32,
) -> io::Result<()> {
	write!(output, "{}{}{}", markers.end_marker_prefix, exit_code, markers.end_marker_suffix)?;
	output.flush()
}

async fn execute_builtin_command<SE: extensions::ShellExtensions>(
	builtin: &builtins::Registration<SE>,
	context: ExecutionContext<'_, SE>,
	args: Vec<CommandArg>,
) -> Result<ExecutionResult, error::Error> {


	let mark_errors_fatal = builtin.special_builtin && context.shell.options().posix_mode;

	match (builtin.execute_func)(context, args).await {
		Ok(result) => Ok(result),
		Err(e) => {

			if let Some(io_err) = e.as_io_error() {
				if io_err.kind() == std::io::ErrorKind::BrokenPipe {
					return Ok(ExecutionExitCode::from(io_err).into());
				}
			}

			Err(if mark_errors_fatal { e.into_fatal() } else { e })
		},
	}
}

pub(crate) async fn invoke_shell_function(
	function: functions::Registration,
	mut context: ExecutionContext<'_, impl extensions::ShellExtensions>,
	args: &[CommandArg],
) -> Result<ExecutionSpawnResult, error::Error> {
	let ast::FunctionBody(body, redirects) = &function.definition().body;


	if let Some(redirects) = redirects {
		for redirect in &redirects.0 {
			interp::setup_redirect(context.shell, &mut context.params, redirect).await?;
		}
	}

	let positional_args = args.iter().map(|a| a.to_string());


	let params = context.params.clone();



	context.shell.enter_function(
		context.command_name.as_str(),
		&function,
		positional_args,
		&context.params,
	)?;


	let result = body.execute(context.shell, &params).await;


	drop(params);


	context.shell.leave_function()?;


	let mut result = result?;


	match result.next_control_flow {
		ExecutionControlFlow::BreakLoop { .. } => {
			writeln!(
				context.params.stderr(context.shell),
				"break: only meaningful in a `for', `while', or `until' loop"
			)?;
			result.next_control_flow = ExecutionControlFlow::Normal;
		},
		ExecutionControlFlow::ContinueLoop { .. } => {
			writeln!(
				context.params.stderr(context.shell),
				"continue: only meaningful in a `for', `while', or `until' loop"
			)?;
			result.next_control_flow = ExecutionControlFlow::Normal;
		},
		ExecutionControlFlow::ReturnFromFunctionOrScript => {

			result.next_control_flow = ExecutionControlFlow::Normal;
		},
		_ => {},
	}

	Ok(result.into())
}

pub(crate) async fn invoke_command_in_subshell_and_get_output(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
	s: String,
) -> Result<String, error::Error> {

	let mut subshell = shell.clone();




	if !shell.options().command_subst_inherits_errexit {
		subshell.options_mut().exit_on_nonzero_command_exit = false;
	}


	let mut params = params.clone();
	params.process_group_policy = ProcessGroupPolicy::SameProcessGroup;
	params.disable_command_output_marking();


	let (reader, writer) = std::io::pipe()?;
	params.set_fd(OpenFiles::STDOUT_FD, writer.into());

	let mut async_reader = sys::async_pipe::AsyncPipeReader::new(reader)?;

	let cmd_join_handle = tokio::spawn(run_substitution_command(subshell, params, s));

	let output_str = async_reader.read_to_string().await?;


	let run_result = cmd_join_handle.await?;
	let cmd_result = run_result?;


	shell.set_last_exit_status(cmd_result.exit_code.into());




	Ok(output_str)
}

async fn run_substitution_command(
	mut shell: Shell<impl extensions::ShellExtensions>,
	mut params: ExecutionParameters,
	command: String,
) -> Result<ExecutionResult, error::Error> {

	let parse_result = shell.parse_string(command);




	if let Ok(program) = &parse_result {
		if let Some(redir) = try_unwrap_bare_input_redir_program(program) {
			interp::setup_redirect(&mut shell, &mut params, redir).await?;
			std::io::copy(&mut params.stdin(&shell), &mut params.stdout(&shell))?;
			return Ok(ExecutionResult::new(0));
		}
	}


	let source_info = crate::SourceInfo::from("main");


	shell
		.run_parsed_result(parse_result, &source_info, &params)
		.await
}



fn try_unwrap_bare_input_redir_program(program: &ast::Program) -> Option<&ast::IoRedirect> {

	let [complete] = program.complete_commands.as_slice() else {
		return None;
	};


	let ast::CompoundList(items) = complete;
	let [item] = items.as_slice() else {
		return None;
	};


	let and_or = &item.0;
	if !and_or.additional.is_empty() {
		return None;
	}


	let pipeline = &and_or.first;
	if pipeline.bang {
		return None;
	}


	let [ast::Command::Simple(simple_cmd)] = pipeline.seq.as_slice() else {
		return None;
	};


	if simple_cmd.word_or_name.is_some() || simple_cmd.suffix.is_some() {
		return None;
	}


	let prefix = simple_cmd.prefix.as_ref()?;
	let [ast::CommandPrefixOrSuffixItem::IoRedirect(redir)] = prefix.0.as_slice() else {
		return None;
	};


	match redir {
		ast::IoRedirect::File(
			fd,
			ast::IoFileRedirectKind::Read,
			ast::IoFileRedirectTarget::Filename(..),
		) if fd.is_none_or(|fd| fd == openfiles::OpenFiles::STDIN_FD) => Some(redir),
		_ => None,
	}
}



#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChildSessionAction {


	DetachSession,


	TakeForeground,

	None,
}


























pub const fn child_session_action(
	new_pg: bool,
	child_stdin_is_terminal: bool,
	_in_pipeline_group: bool,
) -> ChildSessionAction {
	if new_pg && child_stdin_is_terminal {
		return ChildSessionAction::TakeForeground;
	}

	if child_stdin_is_terminal {
		return ChildSessionAction::None;
	}

	ChildSessionAction::DetachSession
}
