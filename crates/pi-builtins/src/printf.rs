use std::{ffi::OsString, io::Write, ops::ControlFlow};

use brush_core::{Error, ErrorKind, ExecutionResult, builtins, escape, expansion};
use clap::Parser;
use uucore::format;


#[derive(Parser)]
#[clap(disable_help_flag = true, disable_version_flag = true)]
pub(crate) struct PrintfCommand {

	#[arg(short = 'v')]
	output_variable: Option<String>,


	#[arg(trailing_var_arg = true, required = true, allow_hyphen_values = true)]
	format_and_args: Vec<String>,
}

impl builtins::Command for PrintfCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		if let Some(variable_name) = &self.output_variable {

			let mut result: Vec<u8> = vec![];
			format(self.format_and_args.as_slice(), &mut result)?;


			let result_str = String::from_utf8(result).map_err(|_| {
				brush_core::ErrorKind::PrintfInvalidUsage("invalid UTF-8 output".into())
			})?;


			expansion::assign_to_named_parameter(
				context.shell,
				&context.params,
				variable_name,
				result_str,
			)
			.await?;
		} else {
			format(self.format_and_args.as_slice(), context.stdout())?;
			context.stdout().flush()?;
		}

		Ok(ExecutionResult::success())
	}
}

fn format(format_and_args: &[String], writer: impl Write) -> Result<(), brush_core::Error> {
	match format_and_args {


		[fmt, arg] if fmt == "%q" => format_special_case_for_percent_q(None, arg, writer),
		[fmt, arg] if fmt == "~%q" => format_special_case_for_percent_q(Some("~"), arg, writer),

		[fmt, args @ ..] => format_via_uucore(fmt, args.iter(), writer),


		[] => Err(ErrorKind::PrintfInvalidUsage("missing operand".into()).into()),
	}
}

fn format_special_case_for_percent_q(
	prefix: Option<&str>,
	arg: &str,
	mut writer: impl Write,
) -> Result<(), brush_core::Error> {
	let mut result = escape::quote_if_needed(arg, escape::QuoteMode::BackslashEscape).to_string();

	if let Some(prefix) = prefix {
		result.insert_str(0, prefix);
	}

	write!(writer, "{result}")?;

	Ok(())
}

fn format_via_uucore(
	format_string: &str,
	args: impl Iterator<Item = impl Into<OsString>>,
	mut writer: impl Write,
) -> Result<(), brush_core::Error> {

	let format_args: Vec<_> = args
		.map(|s| format::FormatArgument::Unparsed(s.into()))
		.collect();


	let format_items = parse_format_string(format_string)?;


	let mut format_args_wrapper = format::FormatArguments::new(&format_args);



	while format_args.is_empty() || !format_args_wrapper.is_exhausted() {

		for item in &format_items {
			let control_flow =
				item
					.write(&mut writer, &mut format_args_wrapper)
					.map_err(|e| match e {

						format::FormatError::IoError(io_err) => Error::from(io_err),

						other => Error::from(ErrorKind::PrintfInvalidUsage(std::format!(
							"printf formatting error: {other}"
						))),
					})?;

			if control_flow == ControlFlow::Break(()) {
				break;
			}
		}


		if !format_args_wrapper.is_exhausted() {
			format_args_wrapper.start_next_batch();
		}

		if format_args.is_empty() {
			break;
		}
	}

	Ok(())
}

fn parse_format_string(
	format_string: &str,
) -> Result<Vec<format::FormatItem<format::EscapedChar>>, brush_core::Error> {
	let format_items: Result<Vec<_>, _> =
		format::parse_spec_and_escape(format_string.as_bytes()).collect();


	let format_items = format_items
		.map_err(|e| ErrorKind::PrintfInvalidUsage(format!("printf parsing error: {e}")))?;

	Ok(format_items)
}


