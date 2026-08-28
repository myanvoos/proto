

use std::{
	borrow::Cow,
	collections::HashMap,
	path::{Path, PathBuf},
};

use crate::{
	completion, env::ShellEnvironment, jobs, openfiles, options::RuntimeOptions, pathcache,
	shell::KeyBindingsHelper,
};


pub trait ShellState {

	fn is_subshell(&self) -> bool;


	fn last_stopwatch_time(&self) -> std::time::SystemTime;


	fn last_stopwatch_offset(&self) -> u32;


	fn env(&self) -> &ShellEnvironment;


	fn env_mut(&mut self) -> &mut ShellEnvironment;


	fn options(&self) -> &RuntimeOptions;


	fn options_mut(&mut self) -> &mut RuntimeOptions;


	fn aliases(&self) -> &HashMap<String, String>;


	fn aliases_mut(&mut self) -> &mut HashMap<String, String>;


	fn jobs(&self) -> &jobs::JobManager;


	fn jobs_mut(&mut self) -> &mut jobs::JobManager;


	fn traps(&self) -> &crate::traps::TrapHandlerConfig;


	fn traps_mut(&mut self) -> &mut crate::traps::TrapHandlerConfig;


	fn directory_stack(&self) -> &[PathBuf];


	fn directory_stack_mut(&mut self) -> &mut Vec<PathBuf>;


	fn last_pipeline_statuses(&self) -> &[u8];



	fn last_pipeline_statuses_mut(&mut self) -> &mut Vec<u8>;


	fn program_location_cache(&self) -> &pathcache::PathCache;


	fn program_location_cache_mut(&mut self) -> &mut pathcache::PathCache;


	fn completion_config(&self) -> &completion::Config;


	fn completion_config_mut(&mut self) -> &mut completion::Config;


	fn open_files(&self) -> &openfiles::OpenFiles;


	fn open_files_mut(&mut self) -> &mut openfiles::OpenFiles;


	fn current_shell_name(&self) -> Option<Cow<'_, str>>;



	fn depth(&self) -> usize;


	fn call_stack(&self) -> &crate::callstack::CallStack;


	fn history(&self) -> Option<&crate::history::History>;


	fn history_mut(&mut self) -> Option<&mut crate::history::History>;


	fn version(&self) -> Option<&str>;


	fn last_exit_status(&self) -> u8;


	fn set_last_exit_status(&mut self, status: u8);


	fn key_bindings(&self) -> Option<&KeyBindingsHelper>;


	fn set_key_bindings(&mut self, key_bindings: Option<KeyBindingsHelper>);


	fn working_dir(&self) -> &Path;



	fn working_dir_mut(&mut self) -> &mut PathBuf;


	fn product_display_str(&self) -> Option<&str>;
}
