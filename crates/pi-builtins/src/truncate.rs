



#[cfg(unix)]
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::{
	ffi::OsString,
	fs::{Metadata, OpenOptions, metadata},
	io::ErrorKind,
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};
use uucore::{
	display::Quotable,
	parser::parse_size::{ParseSizeError, Parser, allow_list_with_all_suffixes},
};

use crate::host::{Host, Utility, format_usage, matches_parser, util};

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum TruncateMode {
	Absolute(u64),
	Extend(u64),
	Reduce(u64),
	AtMost(u64),
	AtLeast(u64),
	RoundDown(u64),
	RoundUp(u64),
}

impl TruncateMode {








	fn to_size(&self, fsize: u64) -> Option<u64> {
		match self {
			Self::Absolute(size) => Some(*size),
			Self::Extend(size) => Some(fsize + size),
			Self::Reduce(size) => Some(fsize.saturating_sub(*size)),
			Self::AtMost(size) => Some(fsize.min(*size)),
			Self::AtLeast(size) => Some(fsize.max(*size)),
			Self::RoundDown(size) => fsize.checked_rem(*size).map(|remainder| fsize - remainder),
			Self::RoundUp(size) => fsize.checked_next_multiple_of(*size),
		}
	}


	fn value(&self) -> u64 {
		match self {
			Self::Absolute(n)
			| Self::Extend(n)
			| Self::Reduce(n)
			| Self::AtMost(n)
			| Self::AtLeast(n)
			| Self::RoundDown(n)
			| Self::RoundUp(n) => *n,
		}
	}




	fn scale(&self, factor: u64) -> Option<Self> {
		let value = self.value().checked_mul(factor)?;
		Some(match self {
			Self::Absolute(_) => Self::Absolute(value),
			Self::Extend(_) => Self::Extend(value),
			Self::Reduce(_) => Self::Reduce(value),
			Self::AtMost(_) => Self::AtMost(value),
			Self::AtLeast(_) => Self::AtLeast(value),
			Self::RoundDown(_) => Self::RoundDown(value),
			Self::RoundUp(_) => Self::RoundUp(value),
		})
	}


	fn is_absolute(&self) -> bool {
		matches!(self, Self::Absolute(_))
	}
}

mod options {
	pub static IO_BLOCKS: &str = "io-blocks";
	pub static NO_CREATE: &str = "no-create";
	pub static REFERENCE: &str = "reference";
	pub static SIZE: &str = "size";
	pub static ARG_FILES: &str = "files";
}


pub(crate) struct Truncate {
	matches: ArgMatches,
}

matches_parser!(Truncate, app);

impl Utility for Truncate {
	const NAME: &'static str = "truncate";

	fn run(self, host: &mut Host) -> i32 {
		let files: Vec<OsString> = self
			.matches
			.get_many::<OsString>(options::ARG_FILES)
			.map(|values| values.cloned().collect())
			.unwrap_or_default();

		if files.is_empty() {
			host.error("missing file operand", 1);
			return 1;
		}

		let io_blocks = self.matches.get_flag(options::IO_BLOCKS);
		let no_create = self.matches.get_flag(options::NO_CREATE);
		let reference = self
			.matches
			.get_one::<String>(options::REFERENCE)
			.map(String::from);
		let size = self.matches.get_one::<String>(options::SIZE).map(String::from);

		if let Err(error) = truncate(host, no_create, io_blocks, reference, size, &files) {
			host.error(error, 1);
		}
		host.exit_code()
	}
}


fn app() -> Command {
	Command::new(Truncate::NAME)
		.version("0.8.0")
		.about("Shrink or extend the size of each file to the specified size.")
		.override_usage(format_usage("truncate [OPTION]... [FILE]..."))
		.after_help(
			"SIZE is an integer with an optional prefix and optional unit.\nThe available units (K, \
			 M, G, T, P, E, Z, and Y) use the following format:\n    'KB' => 1000 (kilobytes)\n    \
			 'K' => 1024 (kibibytes)\n    'MB' => 1000*1000 (megabytes)\n    'M' => 1024*1024 \
			 (mebibytes)\n    'GB' => 1000*1000*1000 (gigabytes)\n    'G' => 1024*1024*1024 \
			 (gibibytes)\nSIZE may also be prefixed by one of the following to adjust the size of \
			 each\nfile based on its current size:\n    '+' => extend by\n    '-' => reduce by\n    \
			 '<' => at most\n    '>' => at least\n    '/' => round down to multiple of\n    '%' => \
			 round up to multiple of",
		)
		.infer_long_args(true)
		.arg(
			Arg::new(options::IO_BLOCKS)
				.short('o')
				.long(options::IO_BLOCKS)
				.help("treat SIZE as the number of I/O blocks of the file rather than bytes")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::NO_CREATE)
				.short('c')
				.long(options::NO_CREATE)
				.help("do not create files that do not exist")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::REFERENCE)
				.short('r')
				.long(options::REFERENCE)
				.required_unless_present(options::SIZE)
				.help("base the size of each file on the size of RFILE")
				.value_name("RFILE")
				.value_hint(clap::ValueHint::FilePath),
		)
		.arg(
			Arg::new(options::SIZE)
				.short('s')
				.long(options::SIZE)
				.required_unless_present(options::REFERENCE)
				.help(
					"set or adjust the size of each file according to SIZE, which is in bytes unless \
					 --io-blocks is specified",
				)
				.allow_hyphen_values(true)
				.value_name("SIZE"),
		)
		.arg(
			Arg::new(options::ARG_FILES)
				.value_name("FILE")
				.action(ArgAction::Append)
				.required(true)
				.value_hint(clap::ValueHint::FilePath)
				.value_parser(clap::value_parser!(OsString)),
		)
}



#[cfg(unix)]
fn io_blocksize(file_metadata: &Metadata) -> u64 {
	match file_metadata.blksize() {
		0 => 512,
		blksize => blksize,
	}
}

#[cfg(not(unix))]
fn io_blocksize(_file_metadata: &Metadata) -> u64 {
	512
}








fn file_truncate(
	host: &Host,
	no_create: bool,
	io_blocks: bool,
	reference_size: Option<u64>,
	mode: &TruncateMode,
	filename: &OsString,
) -> Result<(), String> {
	let resolved = host.resolve(filename);



	#[cfg(unix)]
	if let Ok(pre_metadata) = metadata(&resolved) {
		if pre_metadata.file_type().is_fifo() {
			return Err(format!(
				"cannot open {} for writing: No such device or address",
				filename.to_string_lossy().quote()
			));
		}
	}

	let create = !no_create;
	let file = match OpenOptions::new().write(true).create(create).open(&resolved) {
		Ok(file) => {
			host.note_write(&resolved);
			file
		},
		Err(error) if error.kind() == ErrorKind::NotFound && !create => return Ok(()),
		Err(error) => {
			return Err(format!("cannot open {} for writing: {error}", filename.quote()));
		},
	};

	let file_metadata = file
		.metadata()
		.map_err(|error| format!("cannot fstat {}: {error}", filename.quote()))?;

	let mode = if io_blocks {
		let blksize = io_blocksize(&file_metadata);
		mode.scale(blksize).ok_or_else(|| {
			format!(
				"overflow in {} * {blksize} byte blocks for file {}",
				mode.value(),
				filename.quote()
			)
		})?
	} else {
		*mode
	};



	let actual_reference_size = reference_size.unwrap_or_else(|| file_metadata.len());
	let Some(truncate_size) = mode.to_size(actual_reference_size) else {
		return Err("division by zero".to_string());
	};

	file.set_len(truncate_size).map_err(|error| {
		format!(
			"failed to truncate {} at {truncate_size} bytes: {error}",
			filename.quote()
		)
	})
}

fn truncate(
	host: &mut Host,
	no_create: bool,
	io_blocks: bool,
	reference: Option<String>,
	size: Option<String>,
	filenames: &[OsString],
) -> Result<(), String> {
	if io_blocks && size.is_none() {
		return Err("--io-blocks was specified but --size was not".to_string());
	}

	let reference_size = match reference {
		Some(reference_path) => {
			let reference_metadata = metadata(host.resolve(&reference_path)).map_err(|error| {
				match error.kind() {
					ErrorKind::NotFound => format!(
						"cannot stat {}: No such file or directory",
						reference_path.quote()
					),
					_ => error.to_string(),
				}
			})?;
			Some(reference_metadata.len())
		},
		None => None,
	};


	let mode = match size.as_deref() {
		Some(string) => parse_mode_and_size(string)
			.map_err(|error| format!("Invalid number: {error}"))?,
		None => TruncateMode::Extend(0),
	};



	if matches!(mode, TruncateMode::RoundDown(0) | TruncateMode::RoundUp(0)) {
		return Err("division by zero".to_string());
	}


	if reference_size.is_some() && mode.is_absolute() {
		return Err("you must specify a relative '--size' with '--reference'".to_string());
	}

	for filename in filenames {
		if let Err(error) =
			file_truncate(host, no_create, io_blocks, reference_size, &mode, filename)
		{
			host.error(error, 1);
		}
	}

	Ok(())
}




fn is_modifier(c: char) -> bool {
	c == '+' || c == '-' || c == '<' || c == '>' || c == '/' || c == '%' || c == '='
}


fn parse_mode_and_size(size_string: &str) -> Result<TruncateMode, ParseSizeError> {
	let mut size_string = size_string.trim();

	if let Some(c) = size_string.chars().next() {
		if is_modifier(c) {
			size_string = &size_string[1..];
		}
		let mut allow_list = allow_list_with_all_suffixes("EgGkKmMPQRtTYZ");


		allow_list.push("b".to_string());
		let allow_list_ref = allow_list.iter().map(AsRef::as_ref).collect::<Vec<&str>>();
		Parser::default()
			.with_allow_list(&allow_list_ref)
			.parse_u64(size_string)
			.map(match c {
				'+' => TruncateMode::Extend,
				'-' => TruncateMode::Reduce,
				'<' => TruncateMode::AtMost,
				'>' => TruncateMode::AtLeast,
				'/' => TruncateMode::RoundDown,
				'%' => TruncateMode::RoundUp,
				_ => TruncateMode::Absolute,
			})
	} else {
		Err(ParseSizeError::ParseFailure(size_string.to_string()))
	}
}


pub(crate) fn truncate_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Truncate, SE>()
}


