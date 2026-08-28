

use std::{
	borrow::Cow,
	collections::HashMap,
	path::{Path, PathBuf},
};

use brush_parser::unquote_str;
use clap::ValueEnum;
use strum::IntoEnumIterator;

use crate::{
	Shell, commands, env, error, escape, expansion, extensions, interfaces, jobs, namedoptions,
	patterns,
	sys::{self, users},
	trace_categories, traps,
	variables::{self, ShellValueLiteral},
};


#[derive(Clone, Debug, ValueEnum)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum CompleteAction {

	#[clap(name = "alias")]
	Alias,

	#[clap(name = "arrayvar")]
	ArrayVar,

	#[clap(name = "binding")]
	Binding,

	#[clap(name = "builtin")]
	Builtin,

	#[clap(name = "command")]
	Command,

	#[clap(name = "directory")]
	Directory,

	#[clap(name = "disabled")]
	Disabled,

	#[clap(name = "enabled")]
	Enabled,

	#[clap(name = "export")]
	Export,

	#[clap(name = "file")]
	File,

	#[clap(name = "function")]
	Function,

	#[clap(name = "group")]
	Group,

	#[clap(name = "helptopic")]
	HelpTopic,

	#[clap(name = "hostname")]
	HostName,

	#[clap(name = "job")]
	Job,

	#[clap(name = "keyword")]
	Keyword,

	#[clap(name = "running")]
	Running,

	#[clap(name = "service")]
	Service,

	#[clap(name = "setopt")]
	SetOpt,

	#[clap(name = "shopt")]
	ShOpt,

	#[clap(name = "signal")]
	Signal,

	#[clap(name = "stopped")]
	Stopped,

	#[clap(name = "user")]
	User,

	#[clap(name = "variable")]
	Variable,
}


#[derive(Clone, Debug, Eq, Hash, PartialEq, ValueEnum)]
pub enum CompleteOption {

	#[clap(name = "bashdefault")]
	BashDefault,

	#[clap(name = "default")]
	Default,

	#[clap(name = "dirnames")]
	DirNames,

	#[clap(name = "filenames")]
	FileNames,

	#[clap(name = "noquote")]
	NoQuote,

	#[clap(name = "nosort")]
	NoSort,


	#[clap(name = "nospace")]
	NoSpace,

	#[clap(name = "plusdirs")]
	PlusDirs,
}


#[derive(Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Config {
	commands: HashMap<String, Spec>,



	pub default:      Option<Spec>,

	pub empty_line:   Option<Spec>,


	pub initial_word: Option<Spec>,



	pub current_completion_options: Option<GenerationOptions>,




	pub fallback_options: FallbackOptions,
}


#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct FallbackOptions {

	pub mark_directories:           bool,

	pub mark_symlinked_directories: bool,
}

impl Default for FallbackOptions {
	fn default() -> Self {
		Self { mark_directories: true, mark_symlinked_directories: false }
	}
}


#[derive(Clone, Debug, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct GenerationOptions {



	pub bash_default: bool,


	pub default:      bool,

	pub dir_names:    bool,

	pub file_names:   bool,

	pub no_quote:     bool,

	pub no_sort:      bool,

	pub no_space:     bool,

	pub plus_dirs:    bool,
}



#[derive(Clone, Debug, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Spec {



	pub options: GenerationOptions,




	pub actions:       Vec<CompleteAction>,

	pub glob_pattern:  Option<String>,

	pub word_list:     Option<String>,


	pub function_name: Option<String>,

	pub command:       Option<String>,




	pub filter_pattern:          Option<String>,


	pub filter_pattern_excludes: bool,





	pub prefix: Option<String>,


	pub suffix: Option<String>,
}


#[derive(Clone, Copy, Debug, Default)]
pub enum CompletionTrigger {

	#[default]
	InteractiveComplete,

	Programmatic,
}

impl CompletionTrigger {

	pub const fn comp_type(self) -> i32 {
		match self {
			Self::InteractiveComplete => 9,
			Self::Programmatic => 0,
		}
	}


	pub const fn comp_key(self) -> i32 {
		match self {
			Self::InteractiveComplete => 9,
			Self::Programmatic => 0,
		}
	}
}


#[derive(Debug)]
pub struct Context<'a> {

	pub token_to_complete: &'a str,


	pub command_name:    Option<&'a str>,

	pub preceding_token: Option<&'a str>,


	pub token_index: usize,


	pub input_line:   &'a str,

	pub cursor_index: usize,

	pub tokens:       &'a [&'a CompletionToken<'a>],


	pub trigger: CompletionTrigger,
}

impl Spec {






	#[expect(clippy::too_many_lines)]
	pub async fn get_completions(
		&self,
		shell: &mut Shell<impl extensions::ShellExtensions>,
		context: &Context<'_>,
	) -> Result<Answer, crate::error::Error> {



		shell.completion_config_mut().current_completion_options = Some(self.options.clone());


		let mut candidates = self.generate_action_completions(shell, context).await?;
		if let Some(word_list) = &self.word_list {
			let params = shell.default_exec_params();


			let options =
				crate::expansion::ExpanderOptions { pathname_expand: false, ..Default::default() };
			let words = crate::expansion::full_expand_and_split_word_with_options(
				shell, &params, word_list, &options,
			)
			.await?;
			for word in words {
				if word.starts_with(context.token_to_complete) {
					candidates.push(word);
				}
			}
		}

		if let Some(glob_pattern) = &self.glob_pattern {
			let pattern = patterns::Pattern::from(glob_pattern.as_str())
				.set_extended_globbing(shell.options().extended_globbing)
				.set_case_insensitive(shell.options().case_insensitive_pathname_expansion);

			let expansions = pattern
				.expand(
					shell.working_dir(),
					Some(&patterns::Pattern::accept_all_expand_filter),
					&patterns::FilenameExpansionOptions::default(),
				)?
				.into_paths();

			for expansion in expansions {
				candidates.push(expansion);
			}
		}
		if let Some(function_name) = &self.function_name {
			let call_result = self
				.call_completion_function(shell, function_name.as_str(), context)
				.await?;

			match call_result {
				Answer::RestartCompletionProcess => return Ok(call_result),
				Answer::Candidates(mut new_candidates, _options) => {
					candidates.append(&mut new_candidates);
				},
			}
		}
		if let Some(command) = &self.command {
			let mut new_candidates = self
				.call_completion_command(shell, command.as_str(), context)
				.await?;
			candidates.append(&mut new_candidates);
		}


		if let Some(filter_pattern) = &self.filter_pattern
			&& !filter_pattern.is_empty()
		{
			let mut updated = Vec::new();

			for candidate in candidates {
				let matches = completion_filter_pattern_matches(
					filter_pattern.as_str(),
					candidate.as_str(),
					context.token_to_complete,
					shell,
				)?;

				if self.filter_pattern_excludes != matches {
					updated.push(candidate);
				}
			}

			candidates = updated;
		}


		if self.prefix.is_some() || self.suffix.is_some() {
			let empty = String::new();
			let prefix = self.prefix.as_ref().unwrap_or(&empty);
			let suffix = self.suffix.as_ref().unwrap_or(&empty);

			let mut updated = Vec::new();
			for candidate in candidates {
				updated.push(std::format!("{prefix}{candidate}{suffix}"));
			}

			candidates = updated;
		}





		let options = if let Some(options) = &shell.completion_config().current_completion_options {
			options
		} else {
			&self.options
		};

		let mut processing_options = ProcessingOptions {
			treat_as_filenames:               options.file_names,
			no_autoquote_filenames:           options.no_quote,
			no_trailing_space_at_end_of_line: options.no_space,
		};

		if options.plus_dirs || options.dir_names {

			let mut dir_candidates =
				get_file_completions(shell, context.token_to_complete,  true).await;
			candidates.append(&mut dir_candidates);
		}



		if candidates.is_empty() && options.bash_default {



			tracing::debug!(target: trace_categories::COMPLETION, "unimplemented: complete -o bashdefault");
		}



		if candidates.is_empty() && options.default {


			let must_be_dir = options.dir_names;

			let mut default_candidates =
				get_file_completions(shell, context.token_to_complete, must_be_dir).await;
			candidates.append(&mut default_candidates);

			if shell.completion_config().fallback_options.mark_directories {
				processing_options.treat_as_filenames = true;
			}
		}


		if !self.options.no_sort {
			candidates.sort();
		}

		Ok(Answer::Candidates(candidates, processing_options))
	}

	#[expect(clippy::too_many_lines)]
	async fn generate_action_completions(
		&self,
		shell: &Shell<impl extensions::ShellExtensions>,
		context: &Context<'_>,
	) -> Result<Vec<String>, error::Error> {
		let mut candidates = Vec::new();

		let token = context.token_to_complete;

		for action in &self.actions {
			match action {
				CompleteAction::Alias => {
					for name in shell.aliases().keys() {
						if name.starts_with(token) {
							candidates.push(name.clone());
						}
					}
				},
				CompleteAction::ArrayVar => {
					for (name, var) in shell.env().iter() {
						if var.value().is_array() && name.starts_with(token) {
							candidates.push(name.to_owned());
						}
					}
				},
				CompleteAction::Binding => {
					for input_func in interfaces::InputFunction::iter() {
						let name: &'static str = input_func.into();
						if name.starts_with(token) {
							candidates.push(name.to_string());
						}
					}
				},
				CompleteAction::Builtin => {
					for name in shell.builtins().keys() {
						if name.starts_with(token) {
							candidates.push(name.to_owned());
						}
					}
				},
				CompleteAction::Command => {
					let mut command_completions =
						get_external_command_completions(shell, context.token_to_complete);
					candidates.append(&mut command_completions);
					for name in shell.builtins().keys() {
						if name.starts_with(token) {
							candidates.push(name.to_owned());
						}
					}
					for keyword in shell.get_keywords() {
						if keyword.starts_with(token) {
							candidates.push(keyword.to_string());
						}
					}
					for (name, _) in shell.funcs().iter() {
						candidates.push(name.to_owned());
					}
				},
				CompleteAction::Directory => {
					let mut file_completions =
						get_file_completions(shell, context.token_to_complete, true).await;
					candidates.append(&mut file_completions);
				},
				CompleteAction::Disabled => {
					for (name, registration) in shell.builtins() {
						if registration.disabled && name.starts_with(token) {
							candidates.push(name.to_owned());
						}
					}
				},
				CompleteAction::Enabled => {
					for (name, registration) in shell.builtins() {
						if !registration.disabled && name.starts_with(token) {
							candidates.push(name.to_owned());
						}
					}
				},
				CompleteAction::Export => {
					for (key, value) in shell.env().iter() {
						if value.is_exported() && key.starts_with(token) {
							candidates.push(key.to_owned());
						}
					}
				},
				CompleteAction::File => {
					let mut file_completions =
						get_file_completions(shell, context.token_to_complete, false).await;
					candidates.append(&mut file_completions);
				},
				CompleteAction::Function => {
					for (name, _) in shell.funcs().iter() {
						candidates.push(name.to_owned());
					}
				},
				CompleteAction::Group => {
					for group_name in users::get_all_groups()? {
						if group_name.starts_with(token) {
							candidates.push(group_name);
						}
					}
				},
				CompleteAction::HelpTopic => {

					for name in shell.builtins().keys() {
						if name.starts_with(token) {
							candidates.push(name.to_owned());
						}
					}
				},
				CompleteAction::HostName => {

					if let Ok(name) = sys::network::get_hostname() {
						let name = name.to_string_lossy();
						if name.starts_with(token) {
							candidates.push(name.to_string());
						}
					}
				},
				CompleteAction::Job => {
					for job in &shell.jobs().jobs {
						let command_name = job.command_name();
						if command_name.starts_with(token) {
							candidates.push(command_name.to_owned());
						}
					}
				},
				CompleteAction::Keyword => {
					for keyword in shell.get_keywords() {
						if keyword.starts_with(token) {
							candidates.push(keyword.to_string());
						}
					}
				},
				CompleteAction::Running => {
					for job in &shell.jobs().jobs {
						if matches!(job.state, jobs::JobState::Running) {
							let command_name = job.command_name();
							if command_name.starts_with(token) {
								candidates.push(command_name.to_owned());
							}
						}
					}
				},
				CompleteAction::Service => {
					tracing::debug!(target: trace_categories::COMPLETION, "unimplemented: complete -A service");
				},
				CompleteAction::SetOpt => {
					for option in namedoptions::options(namedoptions::ShellOptionKind::SetO).iter() {
						if option.name.starts_with(token) {
							candidates.push(option.name.to_owned());
						}
					}
				},
				CompleteAction::ShOpt => {
					for option in namedoptions::options(namedoptions::ShellOptionKind::Shopt).iter() {
						if option.name.starts_with(token) {
							candidates.push(option.name.to_owned());
						}
					}
				},
				CompleteAction::Signal => {
					for signal in traps::TrapSignal::iterator() {
						if signal.as_str().starts_with(token) {
							candidates.push(signal.as_str().to_string());
						}
					}
				},
				CompleteAction::Stopped => {
					for job in &shell.jobs().jobs {
						if matches!(job.state, jobs::JobState::Stopped) {
							let command_name = job.command_name();
							if command_name.starts_with(token) {
								candidates.push(job.command_name().to_owned());
							}
						}
					}
				},
				CompleteAction::User => {
					for user_name in users::get_all_users()? {
						if user_name.starts_with(token) {
							candidates.push(user_name);
						}
					}
				},
				CompleteAction::Variable => {
					for (key, _) in shell.env().iter() {
						if key.starts_with(token) {
							candidates.push(key.to_owned());
						}
					}
				},
			}
		}

		Ok(candidates)
	}

	async fn call_completion_command(
		&self,
		shell: &Shell<impl extensions::ShellExtensions>,
		command_name: &str,
		context: &Context<'_>,
	) -> Result<Vec<String>, error::Error> {

		let mut shell = shell.clone();

		let vars_and_values: Vec<(&str, ShellValueLiteral)> = vec![
			("COMP_LINE", context.input_line.into()),
			("COMP_POINT", context.cursor_index.to_string().into()),
			("COMP_KEY", context.trigger.comp_key().to_string().into()),
			("COMP_TYPE", context.trigger.comp_type().to_string().into()),
		];


		for (var, value) in vars_and_values {
			shell.env_mut().update_or_add(
				var,
				value,
				|v| {
					v.export();
					Ok(())
				},
				env::EnvironmentLookup::Anywhere,
				env::EnvironmentScope::Global,
			)?;
		}


		let mut args = vec![context.command_name.unwrap_or(""), context.token_to_complete];
		if let Some(preceding_token) = context.preceding_token {
			args.push(preceding_token);
		}


		let mut command_line = command_name.to_owned();
		for arg in args {
			command_line.push(' ');

			let escaped_arg = escape::quote_if_needed(arg, escape::QuoteMode::SingleQuote);
			command_line.push_str(escaped_arg.as_ref());
		}


		let params = shell.default_exec_params();
		let output =
			commands::invoke_command_in_subshell_and_get_output(&mut shell, &params, command_line)
				.await?;


		let mut candidates = Vec::new();
		for line in output.lines() {
			candidates.push(line.to_owned());
		}

		Ok(candidates)
	}

	async fn call_completion_function(
		&self,
		shell: &mut Shell<impl extensions::ShellExtensions>,
		function_name: &str,
		context: &Context<'_>,
	) -> Result<Answer, error::Error> {

		let vars_and_values: Vec<(&str, ShellValueLiteral)> = vec![
			("COMP_LINE", context.input_line.into()),
			("COMP_POINT", context.cursor_index.to_string().into()),
			("COMP_KEY", context.trigger.comp_key().to_string().into()),
			("COMP_TYPE", context.trigger.comp_type().to_string().into()),
			(
				"COMP_WORDS",
				context
					.tokens
					.iter()
					.map(|t| t.text)
					.collect::<Vec<_>>()
					.into(),
			),
			("COMP_CWORD", context.token_index.to_string().into()),
		];

		tracing::debug!(target: trace_categories::COMPLETION, "[calling completion func '{function_name}']: {}",
            vars_and_values.iter().map(|(k, v)| std::format!("{k}={v}")).collect::<Vec<String>>().join(" "));

		let mut vars_to_remove = Vec::with_capacity(vars_and_values.len());
		for (var, value) in vars_and_values {
			shell.env_mut().update_or_add(
				var,
				value,
				|_| Ok(()),
				env::EnvironmentLookup::Anywhere,
				env::EnvironmentScope::Global,
			)?;

			vars_to_remove.push(var);
		}

		let mut args = vec![context.command_name.unwrap_or(""), context.token_to_complete];
		if let Some(preceding_token) = context.preceding_token {
			args.push(preceding_token);
		}







		shell.acquire_trap_delivery_block();

		let params = shell.default_exec_params();
		let invoke_result = shell
			.invoke_function(function_name, args.iter(), &params)
			.await;

		tracing::debug!(target: trace_categories::COMPLETION, "[completion function '{function_name}' returned: {invoke_result:?}]");

		shell.release_trap_delivery_block();


		for var_name in vars_to_remove {
			let _ = shell.env_mut().unset(var_name);
		}

		let result = invoke_result.unwrap_or_else(|e| {
            tracing::warn!(target: trace_categories::COMPLETION, "error while running completion function '{function_name}': {e}");
            1
        });



		if result == 124 {
			Ok(Answer::RestartCompletionProcess)
		} else {
			if let Some(reply) = shell.env_mut().unset("COMPREPLY")? {
				tracing::debug!(target: trace_categories::COMPLETION, "[completion function yielded: {reply:?}]");

				match reply.value() {
					variables::ShellValue::IndexedArray(values) => {
						return Ok(Answer::Candidates(
							values.values().map(|v| v.to_owned()).collect(),
							ProcessingOptions::default(),
						));
					},
					variables::ShellValue::String(s) => {
						let candidates = vec![s.to_owned()];
						return Ok(Answer::Candidates(candidates, ProcessingOptions::default()));
					},
					_ => (),
				}
			}

			Ok(Answer::Candidates(Vec::new(), ProcessingOptions::default()))
		}
	}
}


#[derive(Debug, Default)]
pub struct Completions {



	pub insertion_index: usize,



	pub delete_count:    usize,

	pub candidates:      Vec<String>,

	pub options:         ProcessingOptions,
}



#[derive(Debug)]
pub struct ProcessingOptions {

	pub treat_as_filenames:               bool,

	pub no_autoquote_filenames:           bool,


	pub no_trailing_space_at_end_of_line: bool,
}


#[derive(Debug, Clone, Copy)]
pub struct CompletionToken<'a> {

	pub text:  &'a str,

	pub start: usize,
}

impl CompletionToken<'_> {

	pub const fn length(&self) -> usize {
		self.text.len()
	}



	pub const fn end(&self) -> usize {
		self.start + self.length()
	}
}

impl Default for ProcessingOptions {
	fn default() -> Self {
		Self {
			treat_as_filenames:               true,
			no_autoquote_filenames:           false,
			no_trailing_space_at_end_of_line: false,
		}
	}
}


pub enum Answer {


	Candidates(Vec<String>, ProcessingOptions),

	RestartCompletionProcess,
}

const EMPTY_COMMAND: &str = "_EmptycmD_";
const DEFAULT_COMMAND: &str = "_DefaultCmD_";
const INITIAL_WORD: &str = "_InitialWorD_";

impl Config {

	pub fn clear(&mut self) {
		self.commands.clear();
		self.empty_line = None;
		self.default = None;
		self.initial_word = None;
	}







	pub fn remove(&mut self, name: &str) -> bool {
		match name {
			EMPTY_COMMAND => {
				let result = self.empty_line.is_some();
				self.empty_line = None;
				result
			},
			DEFAULT_COMMAND => {
				let result = self.default.is_some();
				self.default = None;
				result
			},
			INITIAL_WORD => {
				let result = self.initial_word.is_some();
				self.initial_word = None;
				result
			},
			_ => self.commands.remove(name).is_some(),
		}
	}


	pub fn iter(&self) -> impl Iterator<Item = (&String, &Spec)> {
		self.commands.iter()
	}







	pub fn get(&self, name: &str) -> Option<&Spec> {
		match name {
			EMPTY_COMMAND => self.empty_line.as_ref(),
			DEFAULT_COMMAND => self.default.as_ref(),
			INITIAL_WORD => self.initial_word.as_ref(),
			_ => self.commands.get(name),
		}
	}








	pub fn set(&mut self, name: &str, spec: Spec) {
		match name {
			EMPTY_COMMAND => {
				self.empty_line = Some(spec);
			},
			DEFAULT_COMMAND => {
				self.default = Some(spec);
			},
			INITIAL_WORD => {
				self.initial_word = Some(spec);
			},
			_ => {
				self.commands.insert(name.to_owned(), spec);
			},
		}
	}









	#[allow(
		clippy::missing_panics_doc,
		clippy::unwrap_used,
		reason = "these unwrap calls should not fail"
	)]
	pub fn get_or_add_mut(&mut self, name: &str) -> &mut Spec {
		match name {
			EMPTY_COMMAND => {
				if self.empty_line.is_none() {
					self.empty_line = Some(Spec::default());
				}
				self.empty_line.as_mut().unwrap()
			},
			DEFAULT_COMMAND => {
				if self.default.is_none() {
					self.default = Some(Spec::default());
				}
				self.default.as_mut().unwrap()
			},
			INITIAL_WORD => {
				if self.initial_word.is_none() {
					self.initial_word = Some(Spec::default());
				}
				self.initial_word.as_mut().unwrap()
			},
			_ => self.commands.entry(name.to_owned()).or_default(),
		}
	}








	#[expect(clippy::string_slice)]
	pub async fn get_completions(
		&self,
		shell: &mut Shell<impl extensions::ShellExtensions>,
		input: &str,
		position: usize,
	) -> Result<Completions, error::Error> {
		const MAX_RESTARTS: u32 = 10;


		let tokens = Self::tokenize_input_for_completion(shell, input);

		let cursor = position;
		let mut preceding_token = None;
		let mut completion_prefix = "";
		let mut insertion_index = cursor;
		let mut completion_token_index = tokens.len();



		let mut adjusted_tokens: Vec<&CompletionToken<'_>> = tokens.iter().collect();


		for (i, token) in tokens.iter().enumerate() {



			if cursor < token.start {


				completion_token_index = i;
				break;
			}





			else if cursor >= token.start && cursor <= token.end() {

				insertion_index = token.start;


				let offset_into_token = cursor - insertion_index;
				let token_str = token.text;
				completion_prefix = &token_str[..offset_into_token];


				completion_token_index = i;

				break;
			}



			preceding_token = Some(token);
		}



		let empty_token = CompletionToken { text: "", start: input.len() };
		if completion_token_index == tokens.len() {
			adjusted_tokens.push(&empty_token);
		}


		let mut result = Answer::RestartCompletionProcess;
		let mut restart_count = 0;
		while matches!(result, Answer::RestartCompletionProcess) {
			if restart_count > MAX_RESTARTS {
				tracing::warn!("possible infinite loop detected in completion process");
				break;
			}

			let completion_context = Context {
				token_to_complete: completion_prefix,
				preceding_token:   preceding_token.map(|t| t.text),
				command_name:      adjusted_tokens.first().map(|token| token.text),
				input_line:        input,
				token_index:       completion_token_index,
				tokens:            adjusted_tokens.as_slice(),
				cursor_index:      position,
				trigger:           CompletionTrigger::InteractiveComplete,
			};

			result = self
				.get_completions_for_token(shell, completion_context)
				.await;

			restart_count += 1;
		}

		match result {
			Answer::Candidates(candidates, options) => Ok(Completions {
				insertion_index,
				delete_count: completion_prefix.len(),
				candidates,
				options,
			}),
			Answer::RestartCompletionProcess => Ok(Completions {
				insertion_index,
				delete_count: 0,
				candidates: Vec::new(),
				options: ProcessingOptions::default(),
			}),
		}
	}

	fn tokenize_input_for_completion<'a>(
		shell: &Shell<impl extensions::ShellExtensions>,
		input: &'a str,
	) -> Vec<CompletionToken<'a>> {
		const FALLBACK: &str = " \t\n\"\'@><=;|&(:";

		let delimiter_str = shell
			.env_str("COMP_WORDBREAKS")
			.unwrap_or_else(|| FALLBACK.into());

		let delimiters: Vec<_> = delimiter_str.chars().collect();

		simple_tokenize_by_delimiters(input, delimiters.as_slice())
	}

	async fn get_completions_for_token(
		&self,
		shell: &mut Shell<impl extensions::ShellExtensions>,
		context: Context<'_>,
	) -> Answer {

		let mut found_spec: Option<&Spec> = None;

		if let Some(command_name) = context.command_name {
			if context.token_index == 0 {
				if let Some(spec) = &self.initial_word {
					found_spec = Some(spec);
				}
			} else {
				if let Some(spec) = shell.completion_config().commands.get(command_name) {
					found_spec = Some(spec);
				} else if let Some(file_name) = PathBuf::from(command_name).file_name() {
					if let Some(spec) = shell
						.completion_config()
						.commands
						.get(&file_name.to_string_lossy().to_string())
					{
						found_spec = Some(spec);
					}
				}

				if found_spec.is_none() {
					if let Some(spec) = &self.default {
						found_spec = Some(spec);
					}
				}
			}
		} else {
			if let Some(spec) = &self.empty_line {
				found_spec = Some(spec);
			}
		}


		if let Some(spec) = found_spec {
			spec
				.to_owned()
				.get_completions(shell, &context)
				.await
				.unwrap_or_else(|_err| Answer::Candidates(Vec::new(), ProcessingOptions::default()))
		} else {

			get_completions_using_basic_lookup(shell, &context).await
		}
	}
}

async fn get_file_completions(
	shell: &Shell<impl extensions::ShellExtensions>,
	token_to_complete: &str,
	must_be_dir: bool,
) -> Vec<String> {


	let mut throwaway_shell = shell.clone();
	let params = throwaway_shell.default_exec_params();
	let options =
		expansion::ExpanderOptions { execute_command_substitutions: false, ..Default::default() };
	let expanded_token = expansion::basic_expand_word_with_options(
		&mut throwaway_shell,
		&params,
		&unquote_str(token_to_complete),
		&options,
	)
	.await
	.unwrap_or_else(|_err| token_to_complete.to_owned());




	let expanded_token = sys::fs::normalize_path_separators(&expanded_token).into_owned();

	let glob = std::format!("{expanded_token}*");

	let path_filter = |path: &Path| !must_be_dir || shell.absolute_path(path).is_dir();

	let pattern = patterns::Pattern::from(glob)
		.set_extended_globbing(shell.options().extended_globbing)
		.set_case_insensitive(shell.options().case_insensitive_pathname_expansion);

	let mut completions: Vec<String> = pattern
		.expand(
			shell.working_dir(),
			Some(&path_filter),
			&patterns::FilenameExpansionOptions::default(),
		)
		.unwrap_or_default()
		.into_paths()
		.into_iter()
		.map(|p| match sys::fs::normalize_path_separators(&p) {
			std::borrow::Cow::Borrowed(_) => p,
			std::borrow::Cow::Owned(normalized) => normalized,
		})
		.collect();

	match expanded_token.as_str() {
		"." => {
			completions.push(".".into());
			completions.push("..".into());
		},
		".." => {
			completions.push("..".into());
		},
		_ => {},
	}

	completions.sort();
	completions.dedup();
	completions
}

fn get_external_command_completions(
	shell: &Shell<impl extensions::ShellExtensions>,
	prefix: &str,
) -> Vec<String> {
	let mut candidates = Vec::new();


	for path in shell.find_executables_in_path_with_prefix(
		prefix,
		shell.options().case_insensitive_pathname_expansion,
	) {
		if let Some(file_name) = path.file_name() {
			candidates.push(file_name.to_string_lossy().to_string());
		}
	}

	candidates.into_iter().collect()
}









fn try_get_variable_completions(
	shell: &Shell<impl extensions::ShellExtensions>,
	token: &str,
) -> Option<Answer> {

	let (var_prefix, use_braces) = if let Some(prefix) = token.strip_prefix("${") {

		if prefix.contains('}') {
			return None;
		}
		(prefix, true)
	} else {
     let prefix = token.strip_prefix('$')?;
		(prefix, false)
	};



	if sys::fs::contains_path_separator(var_prefix) {
		return None;
	}


	let mut candidates: Vec<String> = shell
		.env()
		.iter()
		.filter(|(key, _)| key.starts_with(var_prefix))
		.map(|(key, _)| {
			if use_braces {
				format!("${{{key}}}")
			} else {
				format!("${key}")
			}
		})
		.collect();
	candidates.sort();


	let options = ProcessingOptions { treat_as_filenames: false, ..ProcessingOptions::default() };

	Some(Answer::Candidates(candidates, options))
}



fn add_command_completions(
	shell: &Shell<impl extensions::ShellExtensions>,
	prefix: &str,
	candidates: &mut Vec<String>,
) {

	let mut command_completions = get_external_command_completions(shell, prefix);
	candidates.append(&mut command_completions);


	for (name, registration) in shell.builtins() {
		if !registration.disabled && name.starts_with(prefix) {
			candidates.push(name.to_owned());
		}
	}


	for (name, _) in shell.funcs().iter() {
		if name.starts_with(prefix) {
			candidates.push(name.to_owned());
		}
	}


	for name in shell.aliases().keys() {
		if name.starts_with(prefix) {
			candidates.push(name.to_owned());
		}
	}


	for keyword in shell.get_keywords() {
		if keyword.starts_with(prefix) {
			candidates.push(keyword.to_string());
		}
	}
}

async fn get_completions_using_basic_lookup(
	shell: &Shell<impl extensions::ShellExtensions>,
	context: &Context<'_>,
) -> Answer {
	let token = context.token_to_complete;


	if let Some(answer) = try_get_variable_completions(shell, token) {
		return answer;
	}


	let mut candidates = get_file_completions(shell, token, false).await;





	let is_command_position =
		context.token_index == 0 && !token.is_empty() && !sys::fs::contains_path_separator(token);

	if is_command_position {
		add_command_completions(shell, token, &mut candidates);
		candidates.sort();
	}

	Answer::Candidates(candidates, ProcessingOptions::default())
}





#[allow(clippy::string_slice, reason = "used indices come from char_indices")]
fn simple_tokenize_by_delimiters<'a>(
	input: &'a str,
	delimiters: &[char],
) -> Vec<CompletionToken<'a>> {
	let mut tokens = vec![];
	let mut word_start = None;
	let mut word_is_delimiters = false;
	let mut quote_char: Option<char> = None;
	let mut escaped = false;

	for (i, c) in input.char_indices() {
		let mut is_active_delimiter = false;
		if escaped {
			escaped = false;
		} else if let Some(q) = quote_char {
			if c == '\\' && q == '"' {

				escaped = true;
			} else if c == q {

				quote_char = None;
			}
		} else {
			if c == '\\' {
				escaped = true;
			} else if word_start.is_none() && (c == '\'' || c == '\"') {

				quote_char = Some(c);
			} else {
				is_active_delimiter = delimiters.contains(&c);
			}
		}

		if is_active_delimiter {


			if let Some(start) = word_start {
				if !word_is_delimiters || c.is_ascii_whitespace() {
					tokens.push(CompletionToken { text: &input[start..i], start });
					word_start = None;
					word_is_delimiters = false;
				}

				if !c.is_ascii_whitespace() {
					if word_start.is_none() {
						word_start = Some(i);
						word_is_delimiters = true;
					}
				}
			} else if !c.is_ascii_whitespace() {

				if word_start.is_none() {
					word_start = Some(i);
					word_is_delimiters = true;
				}
			}
		} else {

			if word_is_delimiters {
				if let Some(start) = word_start {
					tokens.push(CompletionToken { text: &input[start..i], start });
					word_start = None;
					word_is_delimiters = false;
				}
			}


			if word_start.is_none() {
				word_start = Some(i);
			}
		}
	}


	if let Some(start) = word_start {
		tokens.push(CompletionToken { text: &input[start..], start });
	}

	tokens
}

fn completion_filter_pattern_matches(
	pattern: &str,
	candidate: &str,
	token_being_completed: &str,
	shell: &Shell<impl extensions::ShellExtensions>,
) -> Result<bool, error::Error> {
	let pattern = replace_unescaped_ampersands(pattern, token_being_completed);





	let pattern = patterns::Pattern::from(pattern.as_ref())
		.set_extended_globbing(shell.options().extended_globbing)
		.set_case_insensitive(shell.options().case_insensitive_pathname_expansion);

	let matches = pattern.exactly_matches(candidate)?;

	Ok(matches)
}

fn replace_unescaped_ampersands<'a>(pattern: &'a str, replacement: &str) -> Cow<'a, str> {
	let mut in_escape = false;
	let mut insertion_points = vec![];

	for (i, c) in pattern.char_indices() {
		if !in_escape && c == '&' {
			insertion_points.push(i);
		}
		in_escape = !in_escape && c == '\\';
	}

	if insertion_points.is_empty() {
		return pattern.into();
	}

	let mut result = pattern.to_owned();
	for i in insertion_points.iter().rev() {
		result.replace_range(*i..=*i, replacement);
	}

	result.into()
}


