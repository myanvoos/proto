

use std::{
	borrow::Cow,
	collections::HashMap,
	path::{Path, PathBuf},
	sync::Arc,
};

use tokio::sync::Mutex;

use crate::{
	ExecutionControlFlow, ExecutionResult, builtins, env::ShellEnvironment, error, extensions,
	functions, interfaces, jobs, keywords, openfiles, options::RuntimeOptions, pathcache,
	wellknownvars,
};


pub type KeyBindingsHelper = Arc<Mutex<dyn interfaces::KeyBindings>>;


pub type ShellFd = i32;








mod builder;
mod builtin_registry;
mod callstack;
mod completion;
mod env;
mod execution;
mod expansion;
mod fs;
mod funcs;
mod history;
mod initscripts;
mod io;
mod job_control;
mod parsing;
mod prompts;
mod readline;
mod state;
mod traps;

pub use builder::{CreateOptions, ShellBuilder, ShellBuilderState};
pub use initscripts::{ProfileLoadBehavior, RcLoadBehavior};
pub use state::ShellState;









#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Shell<SE: extensions::ShellExtensions = extensions::DefaultShellExtensions> {

	#[cfg_attr(feature = "serde", serde(skip, default = "default_error_formatter"))]
	error_formatter: SE::ErrorFormatter,


	traps: crate::traps::TrapHandlerConfig,


	open_files: openfiles::OpenFiles,


	working_dir: PathBuf,


	env: ShellEnvironment,


	funcs: functions::FunctionEnv,


	options: RuntimeOptions,



	#[cfg_attr(feature = "serde", serde(skip))]
	jobs: jobs::JobManager,


	aliases: HashMap<String, String>,


	last_exit_status: u8,


	last_exit_status_change_count: usize,


	last_pipeline_statuses: Vec<u8>,


	depth: usize,


	name: Option<String>,


	args: Vec<String>,


	version: Option<String>,


	product_display_str: Option<String>,


	call_stack: crate::callstack::CallStack,


	directory_stack: Vec<PathBuf>,


	completion_config: crate::completion::Config,


	#[cfg_attr(feature = "serde", serde(skip))]
	builtins: HashMap<String, builtins::Registration<SE>>,


	program_location_cache: pathcache::PathCache,


	last_stopwatch_time: std::time::SystemTime,


	last_stopwatch_offset: u32,


	#[cfg_attr(feature = "serde", serde(skip))]
	parser_impl: crate::parser::ParserImpl,



	#[cfg_attr(feature = "serde", serde(skip))]
	key_bindings: Option<KeyBindingsHelper>,


	history: Option<crate::history::History>,
}

impl<SE: extensions::ShellExtensions> Clone for Shell<SE> {
	fn clone(&self) -> Self {
		Self {
			error_formatter: self.error_formatter.clone(),
			traps: self.traps.clone(),
			open_files: self.open_files.clone(),
			working_dir: self.working_dir.clone(),
			env: self.env.clone(),
			funcs: self.funcs.clone(),
			options: self.options.clone(),
			jobs: jobs::JobManager::new(),
			aliases: self.aliases.clone(),
			last_exit_status: self.last_exit_status,
			last_exit_status_change_count: self.last_exit_status_change_count,
			last_pipeline_statuses: self.last_pipeline_statuses.clone(),
			name: self.name.clone(),
			args: self.args.clone(),
			version: self.version.clone(),
			product_display_str: self.product_display_str.clone(),
			call_stack: {



				let mut cs = self.call_stack.clone();
				cs.clear_active_trap_signals();
				cs
			},
			directory_stack: self.directory_stack.clone(),
			completion_config: self.completion_config.clone(),
			builtins: self.builtins.clone(),
			program_location_cache: self.program_location_cache.clone(),
			last_stopwatch_time: self.last_stopwatch_time,
			last_stopwatch_offset: self.last_stopwatch_offset,
			parser_impl: self.parser_impl,
			key_bindings: self.key_bindings.clone(),
			history: self.history.clone(),
			depth: self.depth + 1,
		}
	}
}

impl<SE: extensions::ShellExtensions> AsRef<Self> for Shell<SE> {
	fn as_ref(&self) -> &Self {
		self
	}
}

impl<SE: extensions::ShellExtensions> AsMut<Self> for Shell<SE> {
	fn as_mut(&mut self) -> &mut Self {
		self
	}
}

impl<SE: extensions::ShellExtensions> Shell<SE> {






	pub(crate) fn new(options: CreateOptions<SE>) -> Result<Self, error::Error> {

		let runtime_options = RuntimeOptions::defaults_from(&options);


		let mut shell = Self {
			error_formatter: options.error_formatter,
			open_files: openfiles::OpenFiles::new(),
			options: runtime_options,
			name: options.shell_name,
			args: options.shell_args.unwrap_or_default(),
			version: options.shell_version,
			product_display_str: options.shell_product_display_str,
			working_dir: options.working_dir.map_or_else(std::env::current_dir, Ok)?,
			builtins: options.builtins,
			parser_impl: options.parser,
			key_bindings: options.key_bindings,
			..Self::default()
		};


		shell.open_files.update_from(options.fds.into_iter());



		shell.options.extended_globbing = true;


		if !options.do_not_inherit_env {
			wellknownvars::inherit_env_vars(&mut shell)?;
		}


		if !options.skip_well_known_vars {
			wellknownvars::init_well_known_vars(&mut shell)?;
		}


		for (var_name, var_value) in options.vars {
			shell.env.set_global(var_name, var_value)?;
		}


		if shell.options.enable_command_history {
			shell.history = shell
				.load_history()
				.unwrap_or_default()
				.or_else(|| Some(crate::history::History::default()));
		}

		Ok(shell)
	}
}

impl<SE: extensions::ShellExtensions> Shell<SE> {






	pub fn increment_interactive_line_offset(&mut self, delta: usize) {
		self.call_stack.increment_current_line_offset(delta);
	}


	pub fn set_current_cmd(&mut self, cmd: &impl brush_parser::ast::Node) {
		self
			.call_stack
			.set_current_pos(cmd.location().map(|span| span.start));
	}











	pub(crate) fn update_last_arg_variable(&mut self, last_arg: Option<String>) {




		if self
			.env
			.get_using_policy("_", crate::env::EnvironmentLookup::Anywhere)
			.is_some_and(|v| v.is_readonly())
		{
			return;
		}





		let value = last_arg.unwrap_or_default();
		let _ = self
			.env
			.set_global("_", crate::variables::ShellVariable::new(value));
	}








	pub const fn apply_errexit_if_enabled(&self, result: &mut ExecutionResult) {
		if self.options.exit_on_nonzero_command_exit
			&& !result.is_success()
			&& result.is_normal_flow()
		{
			result.next_control_flow = ExecutionControlFlow::ExitShell;
		}
	}


	pub(crate) fn get_keywords(&self) -> Vec<&str> {
		if self.options.sh_mode {
			keywords::SH_MODE_KEYWORDS.iter().copied().collect()
		} else {
			keywords::KEYWORDS.iter().copied().collect()
		}
	}






	pub fn is_keyword(&self, s: &str) -> bool {
		if self.options.sh_mode {
			keywords::SH_MODE_KEYWORDS.contains(s)
		} else {
			keywords::KEYWORDS.contains(s)
		}
	}

	pub(crate) const fn last_exit_status_change_count(&self) -> usize {
		self.last_exit_status_change_count
	}
}

#[inherent::inherent]
impl<SE: extensions::ShellExtensions> ShellState for Shell<SE> {

	pub fn is_subshell(&self) -> bool {
		self.depth > 0
	}


	pub fn last_stopwatch_time(&self) -> std::time::SystemTime {
		self.last_stopwatch_time
	}


	pub fn last_stopwatch_offset(&self) -> u32 {
		self.last_stopwatch_offset
	}


	pub fn env(&self) -> &ShellEnvironment {
		&self.env
	}


	pub fn env_mut(&mut self) -> &mut ShellEnvironment {
		&mut self.env
	}


	pub fn options(&self) -> &RuntimeOptions {
		&self.options
	}


	pub fn options_mut(&mut self) -> &mut RuntimeOptions {
		&mut self.options
	}


	pub fn aliases(&self) -> &HashMap<String, String> {
		&self.aliases
	}


	pub fn aliases_mut(&mut self) -> &mut HashMap<String, String> {
		&mut self.aliases
	}


	pub fn jobs(&self) -> &jobs::JobManager {
		&self.jobs
	}


	pub fn jobs_mut(&mut self) -> &mut jobs::JobManager {
		&mut self.jobs
	}


	pub fn traps(&self) -> &crate::traps::TrapHandlerConfig {
		&self.traps
	}


	pub fn traps_mut(&mut self) -> &mut crate::traps::TrapHandlerConfig {
		&mut self.traps
	}


	pub fn directory_stack(&self) -> &[PathBuf] {
		&self.directory_stack
	}


	pub fn directory_stack_mut(&mut self) -> &mut Vec<PathBuf> {
		&mut self.directory_stack
	}


	pub fn last_pipeline_statuses(&self) -> &[u8] {
		&self.last_pipeline_statuses
	}



	pub fn last_pipeline_statuses_mut(&mut self) -> &mut Vec<u8> {
		&mut self.last_pipeline_statuses
	}


	pub fn program_location_cache(&self) -> &pathcache::PathCache {
		&self.program_location_cache
	}


	pub fn program_location_cache_mut(&mut self) -> &mut pathcache::PathCache {
		&mut self.program_location_cache
	}


	pub fn completion_config(&self) -> &crate::completion::Config {
		&self.completion_config
	}


	pub fn completion_config_mut(&mut self) -> &mut crate::completion::Config {
		&mut self.completion_config
	}


	pub fn open_files(&self) -> &openfiles::OpenFiles {
		&self.open_files
	}


	pub fn open_files_mut(&mut self) -> &mut openfiles::OpenFiles {
		&mut self.open_files
	}



	pub fn current_shell_name(&self) -> Option<Cow<'_, str>> {
		for frame in self.call_stack.iter() {

			if frame.frame_type.is_run_script() {
				return Some(frame.frame_type.name());
			}
		}

		self.name.as_deref().map(|name| name.into())
	}



	pub fn depth(&self) -> usize {
		self.depth
	}


	pub fn call_stack(&self) -> &crate::callstack::CallStack {
		&self.call_stack
	}


	pub fn history(&self) -> Option<&crate::history::History> {
		self.history.as_ref()
	}


	pub fn history_mut(&mut self) -> Option<&mut crate::history::History> {
		self.history.as_mut()
	}


	pub fn version(&self) -> Option<&str> {
		self.version.as_deref()
	}


	pub fn last_exit_status(&self) -> u8 {
		self.last_exit_status
	}


	pub fn set_last_exit_status(&mut self, status: u8) {
		self.last_exit_status = status;
		self.last_exit_status_change_count += 1;
	}


	pub fn key_bindings(&self) -> Option<&KeyBindingsHelper> {
		self.key_bindings.as_ref()
	}


	pub fn set_key_bindings(&mut self, key_bindings: Option<KeyBindingsHelper>) {
		self.key_bindings = key_bindings;
	}


	pub fn working_dir(&self) -> &Path {
		&self.working_dir
	}



	pub(crate) fn working_dir_mut(&mut self) -> &mut PathBuf {
		&mut self.working_dir
	}


	pub fn product_display_str(&self) -> Option<&str> {
		self.product_display_str.as_deref()
	}
}

#[cfg(feature = "serde")]
fn default_error_formatter<EF: extensions::ErrorFormatter>() -> EF {
	EF::default()
}
