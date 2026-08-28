

use itertools::Itertools;

use crate::{CreateOptions, extensions, namedoptions};


#[derive(Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[expect(clippy::module_name_repetitions)]
pub struct RuntimeOptions {



	pub export_variables_on_modification: bool,

	pub notify_job_termination_immediately: bool,

	pub exit_on_nonzero_command_exit: bool,

	pub disable_filename_globbing: bool,

	pub remember_command_locations: bool,

	pub place_all_assignment_args_in_command_env: bool,

	pub enable_job_control: bool,

	pub do_not_execute_commands: bool,

	pub real_effective_uid_mismatch: bool,

	pub exit_after_one_command: bool,

	pub treat_unset_variables_as_error: bool,

	pub print_shell_input_lines: bool,

	pub print_commands_and_arguments: bool,

	pub perform_brace_expansion: bool,

	pub disallow_overwriting_regular_files_via_output_redirection: bool,

	pub shell_functions_inherit_err_trap: bool,

	pub enable_bang_style_history_substitution: bool,

	pub do_not_resolve_symlinks_when_changing_dir: bool,

	pub shell_functions_inherit_debug_and_return_traps: bool,




	pub emacs_mode: bool,

	pub enable_command_history: bool,

	pub ignore_eof: bool,

	pub return_last_failure_from_pipeline: bool,

	pub posix_mode: bool,

	pub vi_mode: bool,




	pub array_expand_once: bool,

	pub assoc_expand_once: bool,

	pub auto_cd: bool,

	pub bash_source_full_path: bool,

	pub cdable_vars: bool,

	pub cd_autocorrect_spelling: bool,

	pub check_hashtable_before_command_exec: bool,

	pub check_jobs_before_exit: bool,

	pub check_window_size_after_external_commands: bool,

	pub save_multiline_cmds_in_history: bool,

	pub compat31: bool,

	pub compat32: bool,

	pub compat40: bool,

	pub compat41: bool,

	pub compat42: bool,

	pub compat43: bool,

	pub compat44: bool,

	pub quote_all_metachars_in_completion: bool,

	pub expand_dir_names_on_completion: bool,

	pub autocorrect_dir_spelling_on_completion: bool,

	pub glob_matches_dotfiles: bool,

	pub exit_on_exec_fail: bool,

	pub expand_aliases: bool,

	pub enable_debugger: bool,

	pub extended_globbing: bool,

	pub extquote: bool,

	pub fail_expansion_on_globs_without_match: bool,

	pub force_fignore: bool,

	pub glob_ranges_use_c_locale: bool,

	pub glob_skip_dots: bool,

	pub enable_star_star_glob: bool,

	pub errors_in_gnu_format: bool,

	pub append_to_history_file: bool,

	pub allow_reedit_failed_history_subst: bool,

	pub allow_modifying_history_substitution: bool,

	pub enable_hostname_completion: bool,

	pub send_sighup_to_all_jobs_on_exit: bool,

	pub command_subst_inherits_errexit: bool,

	pub interactive_comments: bool,

	pub run_last_pipeline_cmd_in_current_shell: bool,

	pub embed_newlines_in_multiline_cmds_in_history: bool,

	pub local_vars_inherit_value_and_attrs: bool,

	pub localvar_unset: bool,

	pub login_shell: bool,

	pub mail_warn: bool,

	pub no_empty_cmd_completion: bool,

	pub case_insensitive_pathname_expansion: bool,

	pub case_insensitive_conditionals: bool,

	pub no_expand_translation: bool,

	pub expand_non_matching_patterns_to_null: bool,

	pub patsub_replacement: bool,

	pub programmable_completion: bool,

	pub programmable_completion_alias: bool,

	pub expand_prompt_strings: bool,

	pub restricted_shell: bool,

	pub shift_verbose: bool,

	pub source_builtin_searches_path: bool,

	pub var_redir_close: bool,

	pub echo_builtin_expands_escape_sequences: bool,




	pub interactive:                bool,

	pub read_commands_from_stdin:   bool,

	pub command_string_mode:        bool,

	pub sh_mode:                    bool,

	pub external_cmd_leads_session: bool,

	pub max_function_call_depth:    Option<usize>,
}

impl RuntimeOptions {






	pub fn defaults_from<SE: extensions::ShellExtensions>(
		create_options: &CreateOptions<SE>,
	) -> Self {

		let mut options = Self {
			interactive: create_options.interactive,
			disallow_overwriting_regular_files_via_output_redirection: create_options
				.disallow_overwriting_regular_files_via_output_redirection,
			do_not_execute_commands: create_options.do_not_execute_commands,
			enable_command_history: create_options.interactive,
			enable_job_control: create_options.interactive,
			exit_after_one_command: create_options.exit_after_one_command,
			read_commands_from_stdin: create_options.read_commands_from_stdin,
			command_string_mode: create_options.command_string_mode,
			sh_mode: create_options.sh_mode,
			posix_mode: create_options.posix,
			print_commands_and_arguments: create_options.print_commands_and_arguments,
			print_shell_input_lines: create_options.verbose,
			treat_unset_variables_as_error: create_options.treat_unset_variables_as_error,
			exit_on_nonzero_command_exit: create_options.exit_on_nonzero_command_exit,
			external_cmd_leads_session: create_options.external_cmd_leads_session,
			login_shell: create_options.login,
			disable_filename_globbing: create_options.disable_pathname_expansion,
			remember_command_locations: true,
			check_window_size_after_external_commands: true,
			save_multiline_cmds_in_history: true,
			extquote: true,
			force_fignore: true,
			case_insensitive_pathname_expansion:
				crate::sys::fs::default_case_insensitive_path_expansion(),
			enable_hostname_completion: true,
			interactive_comments: true,
			expand_prompt_strings: true,
			source_builtin_searches_path: true,
			perform_brace_expansion: true,
			quote_all_metachars_in_completion: true,
			programmable_completion: true,
			glob_ranges_use_c_locale: true,
			glob_skip_dots: true,
			patsub_replacement: true,
			max_function_call_depth: create_options.max_function_call_depth,
			..Self::default()
		};


		if create_options.interactive {
			options.enable_bang_style_history_substitution = true;
			options.emacs_mode = !create_options.no_editing;
			options.expand_aliases = true;
		}


		for enabled_option in &create_options.enabled_options {
			if let Some(option) =
				namedoptions::options(namedoptions::ShellOptionKind::SetO).get(enabled_option.as_str())
			{
				option.set(&mut options, true);
			}
		}
		for disabled_option in &create_options.disabled_options {
			if let Some(option) =
				namedoptions::options(namedoptions::ShellOptionKind::SetO).get(disabled_option.as_str())
			{
				option.set(&mut options, false);
			}
		}


		for enabled_option in &create_options.enabled_shopt_options {
			if let Some(shopt_option) =
				namedoptions::options(namedoptions::ShellOptionKind::Shopt).get(enabled_option.as_str())
			{
				shopt_option.set(&mut options, true);
			}
		}
		for disabled_option in &create_options.disabled_shopt_options {
			if let Some(shopt_option) = namedoptions::options(namedoptions::ShellOptionKind::Shopt)
				.get(disabled_option.as_str())
			{
				shopt_option.set(&mut options, false);
			}
		}

		options
	}



	pub fn option_flags(&self) -> String {
		let mut cs = vec![];

		for o in namedoptions::options(namedoptions::ShellOptionKind::Set).iter() {
			if o.definition.get(self)
				&& let Some(c) = o.name.chars().next()
			{
				cs.push(c);
			}
		}


		cs.sort_by_key(|flag| option_flag_sort_key(*flag));

		cs.into_iter().collect()
	}


	pub fn seto_optstr(&self) -> String {
		let mut cs = vec![];

		for option in namedoptions::options(namedoptions::ShellOptionKind::SetO).iter() {
			if option.definition.get(self) {
				cs.push(option.name);
			}
		}

		cs.sort_unstable();
		cs.into_iter().join(":")
	}


	pub fn shopt_optstr(&self) -> String {
		let mut cs = vec![];

		for option in namedoptions::options(namedoptions::ShellOptionKind::Shopt).iter() {
			if option.definition.get(self) {
				cs.push(option.name);
			}
		}

		cs.sort_unstable();
		cs.into_iter().join(":")
	}
}






const fn option_flag_sort_key(ch: char) -> (u8, char) {




	let group = if ch.is_ascii_lowercase() && !matches!(ch, 'c' | 's') {
		0
	} else if ch.is_ascii_uppercase() {
		1
	} else {
		2
	};

	(group, ch)
}


