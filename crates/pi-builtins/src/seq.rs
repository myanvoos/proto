



use std::{
	error::Error,
	ffi::{OsStr, OsString},
	io::{BufWriter, Write},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};
use num_bigint::BigUint;
use num_traits::{ToPrimitive, Zero};
use uucore::{
	extendedbigdecimal::ExtendedBigDecimal,
	fast_inc::fast_inc,
	format::{Format, num_format, num_format::FloatVariant},
};

use crate::host::{Host, Utility, format_usage, matches_parser, util};

mod number {
use num_traits::Zero;
use uucore::extendedbigdecimal::ExtendedBigDecimal;















#[derive(Debug)]
pub struct PreciseNumber {
	pub number:                ExtendedBigDecimal,
	pub num_integral_digits:   usize,
	pub num_fractional_digits: Option<usize>,
}

impl PreciseNumber {
		pub fn one() -> Self {



		Self {
			number:                ExtendedBigDecimal::one(),
			num_integral_digits:   1,
			num_fractional_digits: Some(0),
		}
	}


	pub fn is_zero(&self) -> bool {



		self.number.is_zero()
	}
}
}

mod numberparse {




use std::str::FromStr;

use uucore::{
	extendedbigdecimal::ExtendedBigDecimal,
	parser::num_parser::{ExtendedParser, ExtendedParserError},
};

use super::number::PreciseNumber;


#[derive(Debug, PartialEq, Eq)]
pub enum ParseNumberError {
	Float,
	Nan,
}





fn compute_num_digits(input: &str, ebd: ExtendedBigDecimal) -> PreciseNumber {
	let input = input.to_lowercase();
	let input = input.trim_start();


	let input = input.strip_prefix('+').unwrap_or(input);





	if input.starts_with("0x") || input.starts_with("-0x") {
		return PreciseNumber {
			number:                ebd,
			num_integral_digits:   0,
			num_fractional_digits: if input.contains('.') || input.contains('p') {
				None
			} else {
				Some(0)
			},
		};
	}


	let parts: Vec<&str> = input.split('e').collect();
	debug_assert!(parts.len() <= 2);


	let (mut int_digits, mut frac_digits) = match parts[0].find('.') {
		Some(i) => {


			let int_digits = match i {
				0 => 1,
				1 if parts[0].starts_with('-') => 2,
				_ => i,
			};

			(int_digits, parts[0].len() - i - 1)
		},
		None => (parts[0].len(), 0),
	};



	if parts.len() == 2 {
		let exp = parts[1].parse::<i64>().unwrap_or(0);


		if exp > 0 {
			int_digits += exp.try_into().unwrap_or(0);
		}
		frac_digits = if exp < frac_digits as i64 {

			(frac_digits as i128 - exp as i128).try_into().unwrap_or(0)
		} else {
			0
		}
	}

	PreciseNumber {
		number:                ebd,
		num_integral_digits:   int_digits,
		num_fractional_digits: Some(frac_digits),
	}
}



impl FromStr for PreciseNumber {
	type Err = ParseNumberError;

	fn from_str(input: &str) -> Result<Self, Self::Err> {
		let ebd = match ExtendedBigDecimal::extended_parse(input) {
			Ok(ebd) => match ebd {

				ExtendedBigDecimal::BigDecimal(_) | ExtendedBigDecimal::MinusZero => {


					ebd
				},
				ExtendedBigDecimal::Infinity | ExtendedBigDecimal::MinusInfinity => {
					return Ok(Self {
						number:                ebd,
						num_integral_digits:   0,
						num_fractional_digits: Some(0),
					});
				},
				ExtendedBigDecimal::Nan | ExtendedBigDecimal::MinusNan => {
					return Err(ParseNumberError::Nan);
				},
			},
			Err(ExtendedParserError::Underflow(ebd)) => ebd,
			Err(_) => return Err(ParseNumberError::Float),
		};

		Ok(compute_num_digits(input, ebd))
	}
}


}

mod error {





use thiserror::Error;
use uucore::display::Quotable;

use super::numberparse::ParseNumberError;

#[derive(Debug, Error)]
pub enum SeqError {




	#[error("invalid {} argument: {}", parse_error_type(.1), .0.quote())]
	ParseError(String, ParseNumberError),





	#[error("invalid Zero increment value: {}", .0.quote())]
	ZeroIncrement(String),


	#[error("missing operand")]
	NoArguments,


	#[error("format string may not be specified when printing equal width strings")]
	FormatAndEqualWidth,
}

fn parse_error_type(e: &ParseNumberError) -> &'static str {
	match e {
		ParseNumberError::Float => "floating point",
		ParseNumberError::Nan => "'not-a-number'",
	}
}

}

use self::{error::SeqError, number::PreciseNumber};

const OPT_SEPARATOR: &str = "separator";
const OPT_TERMINATOR: &str = "terminator";
const OPT_EQUAL_WIDTH: &str = "equal-width";
const OPT_FORMAT: &str = "format";

const ARG_NUMBERS: &str = "numbers";


const CANCEL_POLL_INTERVAL: u64 = 4096;

#[derive(Clone)]
struct SeqOptions<'a> {
	separator:   OsString,
	terminator:  OsString,
	equal_width: bool,
	format:      Option<&'a str>,
}




type RangeFloat = (ExtendedBigDecimal, ExtendedBigDecimal, ExtendedBigDecimal);



fn split_short_args_with_value(args: Vec<OsString>) -> Vec<OsString> {
	let mut v: Vec<OsString> = Vec::new();

	for arg in args {
		let bytes = arg.as_encoded_bytes();

		if bytes.len() > 2
			&& (bytes.starts_with(b"-f") || bytes.starts_with(b"-s") || bytes.starts_with(b"-t"))
		{
			let (short_arg, value) = bytes.split_at(2);



			v.push(unsafe { OsString::from_encoded_bytes_unchecked(short_arg.to_vec()) });
			v.push(unsafe { OsString::from_encoded_bytes_unchecked(value.to_vec()) });
		} else {
			v.push(arg);
		}
	}

	v
}

fn select_precision(
	first: &PreciseNumber,
	increment: &PreciseNumber,
	last: &PreciseNumber,
) -> Option<usize> {
	match (first.num_fractional_digits, increment.num_fractional_digits, last.num_fractional_digits)
	{
		(Some(0), Some(0), Some(0)) => Some(0),
		(Some(f), Some(i), Some(_)) => Some(f.max(i)),
		_ => None,
	}
}


pub(crate) struct Seq {
	matches: ArgMatches,
}

matches_parser!(Seq, uu_app);

impl Utility for Seq {
	const NAME: &'static str = "seq";

	fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		Ok(split_short_args_with_value(argv))
	}

	fn run(self, host: &mut Host) -> i32 {
		match seq_main(&self.matches, host) {
			Ok(()) => host.exit_code(),
			Err(err) => {
				host.error(err, 1);
				1
			},
		}
	}
}

fn seq_main(matches: &ArgMatches, host: &mut Host) -> Result<(), Box<dyn Error>> {
	let numbers_option = matches.get_many::<String>(ARG_NUMBERS);

	if numbers_option.is_none() {
		return Err(SeqError::NoArguments.into());
	}

	let numbers = numbers_option.unwrap().collect::<Vec<_>>();

	let options = SeqOptions {
		separator:   matches
			.get_one::<OsString>(OPT_SEPARATOR)
			.cloned()
			.unwrap_or_else(|| OsString::from("\n")),
		terminator:  matches
			.get_one::<OsString>(OPT_TERMINATOR)
			.cloned()
			.unwrap_or_else(|| OsString::from("\n")),
		equal_width: matches.get_flag(OPT_EQUAL_WIDTH),
		format:      matches.get_one::<String>(OPT_FORMAT).map(String::as_str),
	};

	if options.equal_width && options.format.is_some() {
		return Err(SeqError::FormatAndEqualWidth.into());
	}

	let first = if numbers.len() > 1 {
		match numbers[0].parse() {
			Ok(num) => num,
			Err(e) => return Err(SeqError::ParseError(numbers[0].to_owned(), e).into()),
		}
	} else {
		PreciseNumber::one()
	};
	let increment = if numbers.len() > 2 {
		match numbers[1].parse() {
			Ok(num) => num,
			Err(e) => return Err(SeqError::ParseError(numbers[1].to_owned(), e).into()),
		}
	} else {
		PreciseNumber::one()
	};
	if increment.is_zero() {
		return Err(SeqError::ZeroIncrement(numbers[1].to_owned()).into());
	}
	let last: PreciseNumber = {



		let n: usize = numbers.len();
		match numbers[n - 1].parse() {
			Ok(num) => num,
			Err(e) => return Err(SeqError::ParseError(numbers[n - 1].to_owned(), e).into()),
		}
	};



	let (format, padding, fast_allowed) = if let Some(str) = options.format {
		(Format::<num_format::Float, &ExtendedBigDecimal>::parse(str)?, 0, false)
	} else {
		let precision = select_precision(&first, &increment, &last);

		let padding = if options.equal_width {
			let precision_value = precision.unwrap_or(0);
			first
				.num_integral_digits
				.max(increment.num_integral_digits)
				.max(last.num_integral_digits)
				+ if precision_value > 0 {
					precision_value + 1
				} else {
					0
				}
		} else {
			0
		};

		let formatter = match precision {

			Some(precision) => num_format::Float {
				variant: FloatVariant::Decimal,
				width: padding,
				alignment: num_format::NumberAlignment::RightZero,
				precision: Some(precision),
				..Default::default()
			},

			None => num_format::Float { variant: FloatVariant::Shortest, ..Default::default() },
		};


		(Format::from_formatter(formatter), padding, precision == Some(0))
	};

	let result = print_seq(
		host,
		(first.number, increment.number, last.number),
		&options.separator,
		&options.terminator,
		&format,
		fast_allowed,
		padding,
	);

	match result {
		Ok(()) => Ok(()),
		Err(err) if err.kind() == std::io::ErrorKind::BrokenPipe => {

			let _ = writeln!(host.stderr, "seq: write error: {err}");
			Ok(())
		},
		Err(err) => Err(format!("write error: {err}").into()),
	}
}

fn uu_app() -> Command {
	Command::new(Seq::NAME)
		.trailing_var_arg(true)
		.infer_long_args(true)
		.version("0.8.0")
		.about("Display numbers from FIRST to LAST, in steps of INCREMENT.")
		.override_usage(format_usage(
			"seq [OPTION]... LAST\nseq [OPTION]... FIRST LAST\nseq [OPTION]... FIRST INCREMENT LAST",
		))
		.arg(
			Arg::new(OPT_SEPARATOR)
				.short('s')
				.long("separator")
				.help("Separator character (defaults to \\n)")
				.value_parser(clap::value_parser!(OsString)),
		)
		.arg(
			Arg::new(OPT_TERMINATOR)
				.short('t')
				.long("terminator")
				.help("Terminator character (defaults to \\n)")
				.value_parser(clap::value_parser!(OsString)),
		)
		.arg(
			Arg::new(OPT_EQUAL_WIDTH)
				.short('w')
				.long("equal-width")
				.help("Equalize widths of all numbers by padding with zeros")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_FORMAT)
				.short('f')
				.long(OPT_FORMAT)
				.help("use printf style floating-point FORMAT"),
		)
		.arg(


			Arg::new(ARG_NUMBERS)
				.allow_hyphen_values(true)
				.action(ArgAction::Append)
				.num_args(1..=3),
		)
}



fn fast_print_seq(
	host: &Host,
	mut stdout: impl Write,
	first: &BigUint,
	increment: u64,
	last: &BigUint,
	separator: &OsStr,
	terminator: &OsStr,
	padding: usize,
) -> std::io::Result<()> {

	if last < first {
		return Ok(());
	}





	let loop_cnt = ((last - first) / increment).to_u64().unwrap_or(u64::MAX);


	let first_str = first.to_string();


	let last_length = last.to_string().len();









	let size = last_length.max(padding) + separator.len();

	let mut buf = vec![b'0'; size];
	let buf = buf.as_mut_slice();

	let num_end = buf.len() - separator.len();
	let mut start = num_end - first_str.len();


	buf[start..num_end].copy_from_slice(first_str.as_bytes());
	buf[num_end..].copy_from_slice(separator.as_encoded_bytes());



	start = start.min(num_end - padding);


	let inc_str = increment.to_string();
	let inc_str = inc_str.as_bytes();

	for i in 0..loop_cnt {

		if i % CANCEL_POLL_INTERVAL == 0 && host.is_cancelled() {
			return Ok(());
		}
		stdout.write_all(&buf[start..])?;
		fast_inc(buf, &mut start, num_end, inc_str);
	}

	stdout.write_all(&buf[start..num_end])?;
	stdout.write_all(terminator.as_encoded_bytes())?;
	stdout.flush()?;
	Ok(())
}

fn done_printing<T: Zero + PartialOrd>(next: &T, increment: &T, last: &T) -> bool {
	if increment >= &T::zero() {
		next > last
	} else {
		next < last
	}
}


fn print_seq(
	host: &Host,
	range: RangeFloat,
	separator: &OsStr,
	terminator: &OsStr,
	format: &Format<num_format::Float, &ExtendedBigDecimal>,
	fast_allowed: bool,
	padding: usize,
) -> std::io::Result<()> {
	let mut stdout = BufWriter::new(host.stdout_clone());
	let (first, increment, last) = range;

	if fast_allowed {


		let (first_bui, increment_u64, last_bui) =
			(first.to_biguint(), increment.to_biguint().and_then(|x| x.to_u64()), last.to_biguint());
		if let (Some(first_bui), Some(increment_u64), Some(last_bui)) =
			(first_bui, increment_u64, last_bui)
		{
			return fast_print_seq(
				host,
				stdout,
				&first_bui,
				increment_u64,
				&last_bui,
				separator,
				terminator,
				padding,
			);
		}
	}

	let mut value = first;

	let mut is_first_iteration = true;
	let mut iterations: u64 = 0;
	while !done_printing(&value, &increment, &last) {

		if iterations.is_multiple_of(CANCEL_POLL_INTERVAL) && host.is_cancelled() {
			return Ok(());
		}
		iterations += 1;
		if !is_first_iteration {
			stdout.write_all(separator.as_encoded_bytes())?;
		}
		format.fmt(&mut stdout, &value)?;

		value = value + increment.clone();
		is_first_iteration = false;
	}
	if !is_first_iteration {
		stdout.write_all(terminator.as_encoded_bytes())?;
	}
	stdout.flush()?;
	Ok(())
}

pub(crate) fn seq_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Seq, SE>()
}


