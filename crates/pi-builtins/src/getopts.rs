use std::{collections::HashMap, io::Write};

use brush_core::{ExecutionResult, builtins, env, variables};
use clap::Parser;


#[derive(Parser)]
pub(crate) struct GetOptsCommand {

	options_string: String,


	variable_name: String,


	#[arg(trailing_var_arg = true, allow_hyphen_values = true)]
	args: Vec<String>,
}




const VAR_GETOPTS_NEXT_CHAR_INDEX: &str = "__GETOPTS_NEXT_CHAR";
const VAR_GETOPTS_LAST_OPTIND: &str = "__GETOPTS_LAST_OPTIND";
const DEFAULT_NEXT_CHAR_INDEX: usize = 1;


struct GetOptsResult {


	variable_value: String,


	optarg:         Option<String>,

	optind:         usize,


	exit_code:      ExecutionResult,
}


struct OptionSpec {

	defs:          HashMap<char, bool>,


	silent_errors: bool,
}





fn parse_option_spec(spec: &str) -> OptionSpec {
	let mut defs = HashMap::<char, bool>::new();
	let mut silent_errors = false;

	let mut last_char = None;
	for c in spec.chars() {
		if c == ':' {
			if let Some(last_char) = last_char {
				defs.insert(last_char, true);
			} else if defs.is_empty() {

				silent_errors = true;
			}
			continue;
		}

		if let std::collections::hash_map::Entry::Vacant(e) = defs.entry(c) {
			e.insert(false);
			last_char = Some(c);
		} else {


			last_char = None;
		}
	}

	OptionSpec { defs, silent_errors }
}

impl builtins::Command for GetOptsCommand {
	type Error = brush_core::Error;





	fn new<I>(args: I) -> Result<Self, clap::Error>
	where
		I: IntoIterator<Item = String>,
	{
		let (mut this, rest_args) = brush_core::builtins::try_parse_known::<Self>(args)?;
		if let Some(args) = rest_args {
			this.args.extend(args);
		}
		Ok(this)
	}

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		mut context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {

		if !env::valid_variable_name(&self.variable_name) {
			writeln!(
				context.stderr(),
				"{}: `{}': not a valid identifier",
				context.command_name,
				self.variable_name
			)?;
			return Ok(ExecutionResult::new(1));
		}

		let spec = parse_option_spec(&self.options_string);


		let next_index_signed = context
			.shell
			.env_str("OPTIND")
			.and_then(|s| brush_core::int_utils::parse::<i32>(s.as_ref(), 10).ok())
			.unwrap_or(1);




		let last_optind = context
			.shell
			.env_str(VAR_GETOPTS_LAST_OPTIND)
			.and_then(|s| s.parse::<i32>().ok());
		if last_optind != Some(next_index_signed) {
			context.shell.env_mut().unset(VAR_GETOPTS_NEXT_CHAR_INDEX)?;
		}

		#[allow(clippy::cast_sign_loss)]
		let next_index = next_index_signed.max(1) as usize;





		let owned_args;
		let args_to_parse = if !self.args.is_empty() {
			&self.args
		} else {
			owned_args = context.shell.current_shell_args().to_vec();
			&owned_args
		};

		let result = parse_next_option(&mut context, &spec, args_to_parse, next_index)?;

		update_variables(&mut context, &self.variable_name, result)
	}
}






fn parse_next_option<SE: brush_core::ShellExtensions>(
	context: &mut brush_core::ExecutionContext<'_, SE>,
	spec: &OptionSpec,
	args_to_parse: &[String],
	mut next_index: usize,
) -> Result<GetOptsResult, brush_core::Error> {

	if next_index > args_to_parse.len() {
		return Ok(GetOptsResult {
			variable_value: String::from("?"),
			optarg:         None,

			optind:         args_to_parse.len() + 1,
			exit_code:      ExecutionResult::general_error(),
		});
	}

	let arg = args_to_parse[next_index - 1].as_str();


	if !arg.starts_with('-') || arg == "--" || arg == "-" {

		return Ok(GetOptsResult {
			variable_value: String::from("?"),
			optarg:         None,
			optind:         if arg == "--" {
				next_index + 1
			} else {
				next_index
			},
			exit_code:      ExecutionResult::general_error(),
		});
	}


	let mut next_char_index = context
		.shell
		.env_str(VAR_GETOPTS_NEXT_CHAR_INDEX)
		.map_or(DEFAULT_NEXT_CHAR_INDEX, |s| s.parse().unwrap_or(DEFAULT_NEXT_CHAR_INDEX));



	let mut c = arg.chars().nth(next_char_index);
	if c.is_none() {
		next_char_index = DEFAULT_NEXT_CHAR_INDEX;
		c = arg.chars().nth(next_char_index);
	}
	let Some(c) = c else {

		return Ok(GetOptsResult {
			variable_value: String::from("?"),
			optarg:         None,
			optind:         next_index,
			exit_code:      ExecutionResult::general_error(),
		});
	};

	let arg_char_count = arg.chars().count();
	let mut is_last_char_in_option = next_char_index == arg_char_count - 1;

	let mut variable_value;
	let optarg;


	if let Some(takes_arg) = spec.defs.get(&c) {
		variable_value = String::from(c);

		if *takes_arg {
			(variable_value, optarg, is_last_char_in_option, next_index) = resolve_option_argument(
				context,
				spec,
				c,
				arg,
				args_to_parse,
				next_char_index,
				is_last_char_in_option,
				next_index,
			)?;
		} else {
			optarg = None;
		}
	} else {
		(variable_value, optarg) = report_unknown_option(context, spec, c)?;
	}

	let optind = if is_last_char_in_option {


		context.shell.env_mut().unset(VAR_GETOPTS_NEXT_CHAR_INDEX)?;
		next_index + 1
	} else {


		context.shell.env_mut().update_or_add(
			VAR_GETOPTS_NEXT_CHAR_INDEX,
			variables::ShellValueLiteral::Scalar((next_char_index + 1).to_string()),
			|v| {
				v.hide_from_enumeration();
				Ok(())
			},
			brush_core::env::EnvironmentLookup::Anywhere,
			brush_core::env::EnvironmentScope::Global,
		)?;
		next_index
	};

	Ok(GetOptsResult { variable_value, optarg, optind, exit_code: ExecutionResult::success() })
}



#[allow(clippy::too_many_arguments)]
fn resolve_option_argument<SE: brush_core::ShellExtensions>(
	context: &brush_core::ExecutionContext<'_, SE>,
	spec: &OptionSpec,
	c: char,
	arg: &str,
	args_to_parse: &[String],
	next_char_index: usize,
	is_last_char_in_option: bool,
	mut next_index: usize,
) -> Result<(String, Option<String>, bool, usize), brush_core::Error> {


	if is_last_char_in_option {
		if next_index >= args_to_parse.len() {

			let (variable_value, optarg) = if spec.silent_errors {
				(String::from(":"), Some(String::from(c)))
			} else {
				if is_opterr_enabled(context) {
					writeln!(context.stderr(), "getopts: option requires an argument -- {c}")?;
				}
				(String::from("?"), None)
			};
			Ok((variable_value, optarg, true, next_index))
		} else {
			next_index += 1;
			Ok((String::from(c), Some(args_to_parse[next_index - 1].clone()), true, next_index))
		}
	} else {
		let optarg: String = arg.chars().skip(next_char_index + 1).collect();
		Ok((String::from(c), Some(optarg), true, next_index))
	}
}


fn report_unknown_option<SE: brush_core::ShellExtensions>(
	context: &brush_core::ExecutionContext<'_, SE>,
	spec: &OptionSpec,
	c: char,
) -> Result<(String, Option<String>), brush_core::Error> {
	if !spec.silent_errors && is_opterr_enabled(context) {
		writeln!(context.stderr(), "getopts: illegal option -- {c}")?;
	}

	let optarg = if spec.silent_errors {
		Some(String::from(c))
	} else {
		None
	};

	Ok((String::from("?"), optarg))
}



fn update_variables<SE: brush_core::ShellExtensions>(
	context: &mut brush_core::ExecutionContext<'_, SE>,
	variable_name: &str,
	result: GetOptsResult,
) -> Result<ExecutionResult, brush_core::Error> {

	context.shell.env_mut().update_or_add(
		variable_name,
		variables::ShellValueLiteral::Scalar(result.variable_value),
		|_| Ok(()),
		brush_core::env::EnvironmentLookup::Anywhere,
		brush_core::env::EnvironmentScope::Global,
	)?;


	if let Some(optarg) = result.optarg {
		context.shell.env_mut().update_or_add(
			"OPTARG",
			variables::ShellValueLiteral::Scalar(optarg),
			|_| Ok(()),
			brush_core::env::EnvironmentLookup::Anywhere,
			brush_core::env::EnvironmentScope::Global,
		)?;
	} else {
		context.shell.env_mut().unset("OPTARG")?;
	}


	let optind_str = result.optind.to_string();
	context.shell.env_mut().update_or_add(
		"OPTIND",
		variables::ShellValueLiteral::Scalar(optind_str.clone()),
		|_| Ok(()),
		brush_core::env::EnvironmentLookup::Anywhere,
		brush_core::env::EnvironmentScope::Global,
	)?;
	context.shell.env_mut().update_or_add(
		VAR_GETOPTS_LAST_OPTIND,
		variables::ShellValueLiteral::Scalar(optind_str),
		|v| {
			v.hide_from_enumeration();
			Ok(())
		},
		brush_core::env::EnvironmentLookup::Anywhere,
		brush_core::env::EnvironmentScope::Global,
	)?;

	Ok(result.exit_code)
}



fn is_opterr_enabled<SE: brush_core::ShellExtensions>(
	context: &brush_core::ExecutionContext<'_, SE>,
) -> bool {
	context
		.shell
		.env_str("OPTERR")
		.is_none_or(|s| s.parse::<i64>().unwrap_or(1) != 0)
}
