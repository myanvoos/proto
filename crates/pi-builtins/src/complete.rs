use std::{collections::HashMap, fmt::Write as _, io::Write};

use brush_core::{
	ExecutionExitCode, ExecutionResult, builtins,
	completion::{self, CompleteAction, CompleteOption, Spec},
	escape,
};
use clap::Parser;

#[derive(Parser)]
struct CommonCompleteCommandArgs {

	#[arg(short = 'o')]
	options: Vec<CompleteOption>,


	#[arg(short = 'A')]
	actions: Vec<CompleteAction>,


	#[arg(short = 'G', allow_hyphen_values = true, value_name = "GLOB")]
	glob_pattern: Option<String>,


	#[arg(short = 'W', allow_hyphen_values = true)]
	word_list: Option<String>,


	#[arg(short = 'F', allow_hyphen_values = true, value_name = "FUNC_NAME")]
	function_name: Option<String>,


	#[arg(short = 'C', allow_hyphen_values = true)]
	command: Option<String>,


	#[arg(short = 'X', allow_hyphen_values = true, value_name = "PATTERN")]
	filter_pattern: Option<String>,


	#[arg(short = 'P', allow_hyphen_values = true)]
	prefix: Option<String>,


	#[arg(short = 'S', allow_hyphen_values = true)]
	suffix: Option<String>,


	#[arg(short = 'a')]
	action_alias: bool,


	#[arg(short = 'b')]
	action_builtin: bool,


	#[arg(short = 'c')]
	action_command: bool,


	#[arg(short = 'd')]
	action_directory: bool,


	#[arg(short = 'e')]
	action_exported: bool,


	#[arg(short = 'f')]
	action_file: bool,


	#[arg(short = 'g')]
	action_group: bool,


	#[arg(short = 'j')]
	action_job: bool,


	#[arg(short = 'k')]
	action_keyword: bool,


	#[arg(short = 's')]
	action_service: bool,


	#[arg(short = 'u')]
	action_user: bool,


	#[arg(short = 'v')]
	action_variable: bool,
}

impl CommonCompleteCommandArgs {
	fn create_spec(&self, extglob_enabled: bool) -> completion::Spec {
		let filter_pattern_excludes;
		let filter_pattern = if let Some(filter_pattern) = self.filter_pattern.as_ref() {


			if let Some(remaining_pattern) = filter_pattern.strip_prefix('!') {
				if !extglob_enabled || !remaining_pattern.starts_with('(') {
					filter_pattern_excludes = false;
					Some(remaining_pattern.to_owned())
				} else {
					filter_pattern_excludes = true;
					Some(filter_pattern.to_owned())
				}
			} else {
				filter_pattern_excludes = true;
				Some(filter_pattern.clone())
			}
		} else {
			filter_pattern_excludes = false;
			None
		};

		let mut spec = completion::Spec {
			options: completion::GenerationOptions::default(),
			actions: self.resolve_actions(),
			glob_pattern: self.glob_pattern.clone(),
			word_list: self.word_list.clone(),
			function_name: self.function_name.clone(),
			command: self.command.clone(),
			filter_pattern,
			filter_pattern_excludes,
			prefix: self.prefix.clone(),
			suffix: self.suffix.clone(),
		};

		for option in &self.options {
			match option {
				CompleteOption::BashDefault => spec.options.bash_default = true,
				CompleteOption::Default => spec.options.default = true,
				CompleteOption::DirNames => spec.options.dir_names = true,
				CompleteOption::FileNames => spec.options.file_names = true,
				CompleteOption::NoQuote => spec.options.no_quote = true,
				CompleteOption::NoSort => spec.options.no_sort = true,
				CompleteOption::NoSpace => spec.options.no_space = true,
				CompleteOption::PlusDirs => spec.options.plus_dirs = true,
			}
		}

		spec
	}

	fn resolve_actions(&self) -> Vec<CompleteAction> {
		let mut actions = self.actions.clone();

		if self.action_alias {
			actions.push(CompleteAction::Alias);
		}
		if self.action_builtin {
			actions.push(CompleteAction::Builtin);
		}
		if self.action_command {
			actions.push(CompleteAction::Command);
		}
		if self.action_directory {
			actions.push(CompleteAction::Directory);
		}
		if self.action_exported {
			actions.push(CompleteAction::Export);
		}
		if self.action_file {
			actions.push(CompleteAction::File);
		}
		if self.action_group {
			actions.push(CompleteAction::Group);
		}
		if self.action_job {
			actions.push(CompleteAction::Job);
		}
		if self.action_keyword {
			actions.push(CompleteAction::Keyword);
		}
		if self.action_service {
			actions.push(CompleteAction::Service);
		}
		if self.action_user {
			actions.push(CompleteAction::User);
		}
		if self.action_variable {
			actions.push(CompleteAction::Variable);
		}

		actions
	}

	const fn has_completion_spec(&self) -> bool {
		!self.options.is_empty()
			|| !self.actions.is_empty()
			|| self.glob_pattern.is_some()
			|| self.word_list.is_some()
			|| self.function_name.is_some()
			|| self.command.is_some()
			|| self.filter_pattern.is_some()
			|| self.prefix.is_some()
			|| self.suffix.is_some()
			|| self.action_alias
			|| self.action_builtin
			|| self.action_command
			|| self.action_directory
			|| self.action_exported
			|| self.action_file
			|| self.action_group
			|| self.action_job
			|| self.action_keyword
			|| self.action_service
			|| self.action_user
			|| self.action_variable
	}
}


#[derive(Parser)]
pub(crate) struct CompleteCommand {

	#[arg(short = 'p')]
	print: bool,


	#[arg(short = 'r')]
	remove: bool,


	#[arg(short = 'D')]
	use_as_default: bool,


	#[arg(short = 'E')]
	use_for_empty_line: bool,


	#[arg(short = 'I')]
	use_for_initial_word: bool,

	#[clap(flatten)]
	common_args: CommonCompleteCommandArgs,

	names: Vec<String>,
}

impl builtins::Command for CompleteCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		mut context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		let mut result = ExecutionResult::success();


		if self.use_as_default
			|| self.use_for_empty_line
			|| self.use_for_initial_word
			|| self.names.is_empty()
		{
			result = self.process_global(&mut context)?;
		} else {
			for name in &self.names {
				if !self.try_process_for_command(&mut context, name.as_str())? {
					result = ExecutionResult::general_error();
				}
			}
		}

		Ok(result)
	}
}

impl CompleteCommand {
	fn process_global(
		&self,
		context: &mut brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
	) -> Result<ExecutionResult, brush_core::Error> {

		let extended_globbing = context.shell.options().extended_globbing;


		let special_option_name;
		let target_spec = if self.use_as_default {
			special_option_name = "-D";
			Some(&mut context.shell.completion_config_mut().default)
		} else if self.use_for_empty_line {
			special_option_name = "-E";
			Some(&mut context.shell.completion_config_mut().empty_line)
		} else if self.use_for_initial_word {
			special_option_name = "-I";
			Some(&mut context.shell.completion_config_mut().initial_word)
		} else {
			special_option_name = "";
			None
		};


		if self.print
			|| (!self.remove && target_spec.is_none() && !self.common_args.has_completion_spec())
		{
			if let Some(target_spec) = target_spec {
				if let Some(existing_spec) = target_spec {
					let existing_spec = existing_spec.clone();
					Self::display_spec(context, Some(special_option_name), None, &existing_spec)?;
				} else {
					writeln!(
						context.stderr(),
						"complete: {}: no completion specification",
						Self::special_spec_name(special_option_name)
					)?;
					return Ok(ExecutionResult::general_error());
				}
			} else {
				for (command_name, spec) in context.shell.completion_config().iter() {
					Self::display_spec(context, None, Some(command_name.as_str()), spec)?;
				}
			}
		} else if self.remove {
			if let Some(target_spec) = target_spec {
				let mut new_spec = None;
				std::mem::swap(&mut new_spec, target_spec);
			} else {
				context.shell.completion_config_mut().clear();
			}
		} else {
			if let Some(target_spec) = target_spec {
				let mut new_spec = Some(self.common_args.create_spec(extended_globbing));
				std::mem::swap(&mut new_spec, target_spec);
			} else {
				debug_assert!(self.common_args.has_completion_spec());
				writeln!(context.stderr(), "complete: invalid usage")?;
				return Ok(ExecutionExitCode::InvalidUsage.into());
			}
		}

		Ok(ExecutionResult::success())
	}

	fn special_spec_name(option_name: &str) -> &'static str {
		match option_name {
			"-D" => "_DefaultCmD_",
			"-E" => "_EmptycmD_",
			"-I" => "_InitialWorD_",
			_ => "",
		}
	}

	fn try_display_spec_for_command(
		context: &brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
		name: &str,
	) -> Result<bool, brush_core::Error> {
		if let Some(spec) = context.shell.completion_config().get(name) {
			Self::display_spec(context, None, Some(name), spec)?;
			Ok(true)
		} else {
			writeln!(context.stderr(), "no completion found for command")?;
			Ok(false)
		}
	}

	#[expect(clippy::too_many_lines)]
	fn display_spec(
		context: &brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
		special_name: Option<&str>,
		command_name: Option<&str>,
		spec: &Spec,
	) -> Result<(), brush_core::Error> {
		let mut s = String::from("complete");

		if let Some(special_name) = special_name {
			s.push(' ');
			s.push_str(special_name);
		}

		for action in &spec.actions {
			s.push(' ');

			let action_str = match action {
				CompleteAction::Alias => "-a",
				CompleteAction::ArrayVar => "-A arrayvar",
				CompleteAction::Binding => "-A binding",
				CompleteAction::Builtin => "-b",
				CompleteAction::Command => "-c",
				CompleteAction::Directory => "-d",
				CompleteAction::Disabled => "-A disabled",
				CompleteAction::Enabled => "-A enabled",
				CompleteAction::Export => "-e",
				CompleteAction::File => "-f",
				CompleteAction::Function => "-A function",
				CompleteAction::Group => "-g",
				CompleteAction::HelpTopic => "-A helptopic",
				CompleteAction::HostName => "-A hostname",
				CompleteAction::Job => "-j",
				CompleteAction::Keyword => "-k",
				CompleteAction::Running => "-A running",
				CompleteAction::Service => "-s",
				CompleteAction::SetOpt => "-A setopt",
				CompleteAction::ShOpt => "-A shopt",
				CompleteAction::Signal => "-A signal",
				CompleteAction::Stopped => "-A stopped",
				CompleteAction::User => "-u",
				CompleteAction::Variable => "-v",
			};

			s.push_str(action_str);
		}

		if spec.options.bash_default {
			s.push_str(" -o bashdefault");
		}
		if spec.options.default {
			s.push_str(" -o default");
		}
		if spec.options.dir_names {
			s.push_str(" -o dirnames");
		}
		if spec.options.file_names {
			s.push_str(" -o filenames");
		}
		if spec.options.no_quote {
			s.push_str(" -o noquote");
		}
		if spec.options.no_sort {
			s.push_str(" -o nosort");
		}
		if spec.options.no_space {
			s.push_str(" -o nospace");
		}
		if spec.options.plus_dirs {
			s.push_str(" -o plusdirs");
		}

		if let Some(glob_pattern) = &spec.glob_pattern {
			write!(s, " -G {}", escape::force_quote(glob_pattern, escape::QuoteMode::SingleQuote))?;
		}
		if let Some(word_list) = &spec.word_list {
			write!(s, " -W {}", escape::force_quote(word_list, escape::QuoteMode::SingleQuote))?;
		}
		if let Some(function_name) = &spec.function_name {
			write!(s, " -F {function_name}")?;
		}
		if let Some(command) = &spec.command {
			write!(s, " -C {}", escape::force_quote(command, escape::QuoteMode::SingleQuote))?;
		}
		if let Some(filter_pattern) = &spec.filter_pattern {
			write!(s, " -X {}", escape::force_quote(filter_pattern, escape::QuoteMode::SingleQuote))?;
		}
		if let Some(prefix) = &spec.prefix {
			write!(s, " -P {}", escape::force_quote(prefix, escape::QuoteMode::SingleQuote))?;
		}
		if let Some(suffix) = &spec.suffix {
			write!(s, " -S {}", escape::force_quote(suffix, escape::QuoteMode::SingleQuote))?;
		}

		if let Some(command_name) = command_name {
			s.push(' ');
			s.push_str(command_name);
		}

		writeln!(context.stdout(), "{s}")?;

		Ok(())
	}

	fn try_process_for_command(
		&self,
		context: &mut brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
		name: &str,
	) -> Result<bool, brush_core::Error> {
		if self.print {
			return Self::try_display_spec_for_command(context, name);
		} else if self.remove {
			let mut result = context.shell.completion_config_mut().remove(name);

			if !result {
				if context.shell.options().interactive {
					writeln!(context.stderr(), "complete: {name}: not found")?;
				} else {


					result = true;
				}
			}

			return Ok(result);
		}

		let config = self
			.common_args
			.create_spec(context.shell.options().extended_globbing);

		context.shell.completion_config_mut().set(name, config);

		Ok(true)
	}
}


#[derive(Parser)]
pub(crate) struct CompGenCommand {
	#[clap(flatten)]
	common_args: CommonCompleteCommandArgs,


	word: Option<String>,
}

impl builtins::Command for CompGenCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		let mut spec = self
			.common_args
			.create_spec(context.shell.options().extended_globbing);
		spec.options.no_sort = true;

		let token_to_complete = self.word.as_deref().unwrap_or_default();



		let unquoted_token = brush_parser::unquote_str(token_to_complete);

		let completion_context = completion::Context {
			token_to_complete: unquoted_token.as_str(),
			preceding_token:   None,
			command_name:      None,
			token_index:       0,
			tokens:            &[&completion::CompletionToken { text: token_to_complete, start: 0 }],
			input_line:        token_to_complete,
			cursor_index:      token_to_complete.len(),
			trigger:           completion::CompletionTrigger::Programmatic,
		};

		let result = spec
			.get_completions(context.shell, &completion_context)
			.await?;

		match result {
			completion::Answer::Candidates(candidates, _options) => {


				if candidates.is_empty() {
					return Ok(ExecutionResult::general_error());
				}

				for candidate in candidates {
					writeln!(context.stdout(), "{candidate}")?;
				}
			},
			completion::Answer::RestartCompletionProcess => {
				return Ok(ExecutionResult::general_error());
			},
		}

		Ok(ExecutionResult::success())
	}
}


#[derive(Parser)]
pub(crate) struct CompOptCommand {

	#[arg(short = 'D')]
	update_default: bool,


	#[arg(short = 'E')]
	update_empty: bool,


	#[arg(short = 'I')]
	update_initial_word: bool,


	#[arg(short = 'o', value_name = "OPT")]
	enabled_options:  Vec<CompleteOption>,
	#[arg(long = concat!("+o"), hide = true)]
	disabled_options: Vec<CompleteOption>,


	names: Vec<String>,
}

impl builtins::Command for CompOptCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		let mut options = HashMap::new();
		for option in &self.disabled_options {
			options.insert(option.clone(), false);
		}
		for option in &self.enabled_options {
			options.insert(option.clone(), true);
		}

		if !self.names.is_empty() {
			if self.update_default || self.update_empty || self.update_initial_word {
				writeln!(context.stderr(), "compopt: cannot specify names with -D, -E, or -I")?;
				return Ok(ExecutionExitCode::InvalidUsage.into());
			}

			for name in &self.names {
				let spec = context.shell.completion_config_mut().get_or_add_mut(name);
				Self::set_options_for_spec(spec, &options);
			}
		} else if self.update_default {
			if let Some(spec) = &mut context.shell.completion_config_mut().default {
				Self::set_options_for_spec(spec, &options);
			} else {
				let mut spec = Spec::default();
				Self::set_options_for_spec(&mut spec, &options);
				context.shell.completion_config_mut().default = Some(spec);
			}
		} else if self.update_empty {
			if let Some(spec) = &mut context.shell.completion_config_mut().empty_line {
				Self::set_options_for_spec(spec, &options);
			} else {
				let mut spec = Spec::default();
				Self::set_options_for_spec(&mut spec, &options);
				context.shell.completion_config_mut().empty_line = Some(spec);
			}
		} else if self.update_initial_word {
			if let Some(spec) = &mut context.shell.completion_config_mut().initial_word {
				Self::set_options_for_spec(spec, &options);
			} else {
				let mut spec = Spec::default();
				Self::set_options_for_spec(&mut spec, &options);
				context.shell.completion_config_mut().initial_word = Some(spec);
			}
		} else {

			if let Some(in_flight_options) = context
				.shell
				.completion_config_mut()
				.current_completion_options
				.as_mut()
			{
				Self::set_options(in_flight_options, &options);
			}
		}

		Ok(ExecutionResult::success())
	}
}

impl CompOptCommand {
	fn set_options_for_spec(spec: &mut Spec, options: &HashMap<CompleteOption, bool>) {
		Self::set_options(&mut spec.options, options);
	}

	fn set_options(
		target_options: &mut completion::GenerationOptions,
		options: &HashMap<CompleteOption, bool>,
	) {
		for (option, value) in options {
			match option {
				CompleteOption::BashDefault => target_options.bash_default = *value,
				CompleteOption::Default => target_options.default = *value,
				CompleteOption::DirNames => target_options.dir_names = *value,
				CompleteOption::FileNames => target_options.file_names = *value,
				CompleteOption::NoQuote => target_options.no_quote = *value,
				CompleteOption::NoSort => target_options.no_sort = *value,
				CompleteOption::NoSpace => target_options.no_space = *value,
				CompleteOption::PlusDirs => target_options.plus_dirs = *value,
			}
		}
	}
}
