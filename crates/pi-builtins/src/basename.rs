




use std::{ffi::OsString, io::Write, path::PathBuf};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command, builder::ValueParser};
use uucore::{display::Quotable, line_ending::LineEnding};

use crate::host::{Host, Utility, format_usage, matches_parser, os_bytes, util};

mod options {
	pub static MULTIPLE: &str = "multiple";
	pub static NAME: &str = "name";
	pub static SUFFIX: &str = "suffix";
	pub static ZERO: &str = "zero";
}


pub(crate) struct Basename {
	matches: ArgMatches,
}

matches_parser!(Basename, app);

impl Utility for Basename {
	const NAME: &'static str = "basename";

	fn run(self, host: &mut Host) -> i32 {
		let line_ending = LineEnding::from_zero_flag(self.matches.get_flag(options::ZERO));

		let mut names = self
			.matches
			.get_many::<OsString>(options::NAME)
			.unwrap_or_default()
			.collect::<Vec<_>>();
		if names.is_empty() {
			host.error("missing operand", 1);
			return 1;
		}



		let explicit_suffix = self.matches.get_one::<OsString>(options::SUFFIX);
		let suffix = if explicit_suffix.is_some() || self.matches.get_flag(options::MULTIPLE) {
			explicit_suffix.cloned().unwrap_or_default()
		} else {
			match names.len() {
				1 => OsString::default(),
				2 => names.pop().cloned().unwrap_or_default(),
				_ => {
					host.error(format!("extra operand {}", names[2].quote()), 1);
					return 1;
				},
			}
		};

		for name in names {
			let Some(stripped) = basename(name, &suffix) else {
				host.error(format!("invalid argument {}", name.quote()), 1);
				return 1;
			};
			if host.stdout.write_all(&stripped).is_err() || write!(host.stdout, "{line_ending}").is_err()
			{
				return 1;
			}
		}
		if host.stdout.flush().is_err() {
			return 1;
		}
		host.exit_code()
	}
}






fn basename(fullname: &OsString, suffix: &OsString) -> Option<Vec<u8>> {
	let fullname_bytes = os_bytes(fullname)?;


	if fullname_bytes.ends_with(b"/.") {
		return Some(b".".into());
	}

	let path = PathBuf::from(fullname);
	let Some(last) = path.components().next_back() else {
		return Some(Vec::new());
	};

	let name = last.as_os_str();
	let name_bytes = os_bytes(name)?;

	if name == suffix.as_os_str() {
		return Some(name_bytes.into());
	}
	let suffix_bytes = os_bytes(suffix)?;
	Some(name_bytes.strip_suffix(suffix_bytes).unwrap_or(name_bytes).into())
}


fn app() -> Command {
	Command::new(Basename::NAME)
		.version("0.8.0")
		.about(
			"Print NAME with any leading directory components removed\nIf specified, also remove a \
			 trailing SUFFIX",
		)
		.override_usage(format_usage("basename [-z] NAME [SUFFIX]\n  basename OPTION... NAME..."))
		.infer_long_args(true)
		.arg(
			Arg::new(options::MULTIPLE)
				.short('a')
				.long(options::MULTIPLE)
				.help("support multiple arguments and treat each as a NAME")
				.action(ArgAction::SetTrue)
				.overrides_with(options::MULTIPLE),
		)
		.arg(
			Arg::new(options::NAME)
				.action(ArgAction::Append)
				.value_parser(ValueParser::os_string())
				.value_hint(clap::ValueHint::AnyPath)
				.hide(true)
				.trailing_var_arg(true),
		)
		.arg(
			Arg::new(options::SUFFIX)
				.short('s')
				.long(options::SUFFIX)
				.value_name("SUFFIX")
				.value_parser(ValueParser::os_string())
				.help("remove a trailing SUFFIX; implies -a")
				.overrides_with(options::SUFFIX),
		)
		.arg(
			Arg::new(options::ZERO)
				.short('z')
				.long(options::ZERO)
				.help("end each output line with NUL, not newline")
				.action(ArgAction::SetTrue)
				.overrides_with(options::ZERO),
		)
}


pub(crate) fn basename_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Basename, SE>()
}


