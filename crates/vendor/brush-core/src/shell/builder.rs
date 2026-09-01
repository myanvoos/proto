

use std::{collections::HashMap, path::PathBuf};

pub use shell_builder::State as ShellBuilderState;

use super::Shell;
use crate::{
	ProfileLoadBehavior, RcLoadBehavior, ShellFd, ShellVariable, builtins, callstack, completion,
	env, error, extensions, fsobserve, functions, jobs, openfiles, options, pathcache,
	shell::KeyBindingsHelper, traps,
};

impl<SE: extensions::ShellExtensions, S: shell_builder::IsComplete> ShellBuilder<SE, S> {


	pub async fn build(self) -> Result<Shell<SE>, error::Error> {
		let mut options = self.build_settings();

		let profile = std::mem::take(&mut options.profile);
		let rc = std::mem::take(&mut options.rc);


		let mut shell = Shell::new(options)?;


		if !profile.skip() || !rc.skip() {
			shell.load_config(&profile, &rc).await?;
		}

		Ok(shell)
	}
}

impl<SE: extensions::ShellExtensions, S: shell_builder::State> ShellBuilder<SE, S> {

	pub fn disable_option(mut self, option: impl Into<String>) -> Self {
		self.disabled_options.push(option.into());
		self
	}


	pub fn enable_option(mut self, option: impl Into<String>) -> Self {
		self.enabled_options.push(option.into());
		self
	}


	pub fn disable_options(mut self, options: impl IntoIterator<Item: Into<String>>) -> Self {
		self
			.disabled_options
			.extend(options.into_iter().map(Into::into));
		self
	}


	pub fn enable_options(mut self, options: impl IntoIterator<Item: Into<String>>) -> Self {
		self
			.enabled_options
			.extend(options.into_iter().map(Into::into));
		self
	}


	pub fn disable_shopt_option(mut self, option: impl Into<String>) -> Self {
		self.disabled_shopt_options.push(option.into());
		self
	}


	pub fn enable_shopt_option(mut self, option: impl Into<String>) -> Self {
		self.enabled_shopt_options.push(option.into());
		self
	}


	pub fn disable_shopt_options(mut self, options: impl IntoIterator<Item: Into<String>>) -> Self {
		self
			.disabled_shopt_options
			.extend(options.into_iter().map(Into::into));
		self
	}


	pub fn enable_shopt_options(mut self, options: impl IntoIterator<Item: Into<String>>) -> Self {
		self
			.enabled_shopt_options
			.extend(options.into_iter().map(Into::into));
		self
	}


	pub fn builtin(mut self, name: impl Into<String>, reg: builtins::Registration<SE>) -> Self {
		self.builtins.insert(name.into(), reg);
		self
	}


	pub fn builtins(
		mut self,
		builtins: impl IntoIterator<Item = (String, builtins::Registration<SE>)>,
	) -> Self {
		self.builtins.extend(builtins);
		self
	}


	pub fn var(mut self, name: impl Into<String>, variable: ShellVariable) -> Self {
		self.vars.insert(name.into(), variable);
		self
	}
}


#[derive(Default, bon::Builder)]
#[builder(
    builder_type(
        name = ShellBuilder,
        doc {

    }),
    finish_fn(
        name = build_settings,
        vis = "pub(self)",
    ),
    start_fn(
        vis = "pub(self)"
    )
)]
pub struct CreateOptions<SE: extensions::ShellExtensions = extensions::DefaultShellExtensions> {

	#[builder(field)]
	pub disabled_options: Vec<String>,

	#[builder(field)]
	pub enabled_options: Vec<String>,

	#[builder(field)]
	pub disabled_shopt_options: Vec<String>,

	#[builder(field)]
	pub enabled_shopt_options: Vec<String>,

	#[builder(field)]
	pub builtins: HashMap<String, builtins::Registration<SE>>,



	#[builder(field)]
	pub vars: HashMap<String, ShellVariable>,

	#[builder(default)]
	pub error_formatter: SE::ErrorFormatter,

	#[builder(default)]
	pub disallow_overwriting_regular_files_via_output_redirection: bool,

	#[builder(default)]
	pub do_not_execute_commands: bool,

	#[builder(default)]
	pub exit_after_one_command: bool,

	#[builder(default)]
	pub interactive: bool,

	#[builder(default)]
	pub login: bool,

	#[builder(default)]
	pub no_editing: bool,

	#[builder(default)]
	pub profile: ProfileLoadBehavior,

	#[builder(default)]
	pub rc: RcLoadBehavior,


	#[builder(default)]
	pub do_not_inherit_env: bool,

	#[builder(default)]
	pub skip_well_known_vars: bool,

	#[builder(default)]
	pub fds: HashMap<ShellFd, openfiles::OpenFile>,

	#[builder(default)]
	pub external_cmd_leads_session: bool,


	pub working_dir: Option<PathBuf>,

	#[builder(default)]
	pub posix: bool,

	#[builder(default)]
	pub print_commands_and_arguments: bool,

	#[builder(default)]
	pub read_commands_from_stdin: bool,

	pub shell_name: Option<String>,

	pub shell_args: Option<Vec<String>>,


	pub shell_product_display_str: Option<String>,

	#[builder(default)]
	pub sh_mode: bool,

	#[builder(default)]
	pub treat_unset_variables_as_error: bool,

	#[builder(default)]
	pub exit_on_nonzero_command_exit: bool,

	#[builder(default)]
	pub disable_pathname_expansion: bool,

	#[builder(default)]
	pub verbose: bool,

	#[builder(default)]
	pub parser: crate::parser::ParserImpl,

	#[builder(default)]
	pub command_string_mode: bool,

	pub max_function_call_depth: Option<usize>,

	pub key_bindings: Option<KeyBindingsHelper>,

	pub shell_version: Option<String>,
}

impl<SE: extensions::ShellExtensions> Default for Shell<SE> {
	fn default() -> Self {
		Self {
			error_formatter: SE::ErrorFormatter::default(),
			traps: traps::TrapHandlerConfig::default(),
			open_files: openfiles::OpenFiles::default(),
			working_dir: PathBuf::default(),
			env: env::ShellEnvironment::default(),
			funcs: functions::FunctionEnv::default(),
			options: options::RuntimeOptions::default(),
			jobs: jobs::JobManager::default(),
			aliases: HashMap::default(),
			last_exit_status: 0,
			last_exit_status_change_count: 0,
			last_pipeline_statuses: vec![0],
			depth: 0,
			name: None,
			args: vec![],
			version: None,
			product_display_str: None,
			call_stack: callstack::CallStack::new(),
			directory_stack: vec![],
			completion_config: completion::Config::default(),
			builtins: HashMap::default(),
			program_location_cache: pathcache::PathCache::default(),
			last_stopwatch_time: std::time::SystemTime::now(),
			last_stopwatch_offset: 0,
			parser_impl: crate::parser::ParserImpl::default(),
			key_bindings: None,
			fs_observations: fsobserve::FsObservationLog::default(),
			history: None,
		}
	}
}

impl Shell {

	pub fn builder() -> ShellBuilder<extensions::DefaultShellExtensions, shell_builder::Empty> {
		CreateOptions::builder()
	}



	pub fn builder_with_extensions<SE: extensions::ShellExtensions>()
	-> ShellBuilder<SE, shell_builder::Empty> {
		CreateOptions::builder()
	}
}
