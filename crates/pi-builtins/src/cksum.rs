


#![allow(dead_code, reason = "upstream checksum-common also supports cksum-only formats")]

use std::{
	borrow::Borrow,
	ffi::{OsStr, OsString},
	fmt::{Display, Formatter},
	io::{self, BufReader, Read, Write},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command, ValueHint, builder::ValueParser};
use os_display::Quotable;
use uucore::{
	checksum::{
		AlgoKind, BlakeLength, ChecksumError, ReadingMode, ShaLength, SizedAlgoKind,
		digest_reader, escape_filename, parse_blake_length, unescape_filename, SUPPORTED_ALGORITHMS,
	},
	hardware::{HasHardwareFeatures as _, SimdPolicy},
	line_ending::LineEnding,
	os_str_from_bytes,
	quoting_style::{QuotingStyle, locale_aware_escape_name},
	read_os_string_lines,
	sum::{self, Blake2b, Blake3, DigestOutput},
};

use crate::host::{Host, Utility, matches_parser, os_bytes, util};

#[derive(Debug, Clone)]
struct Failure(String);

impl Display for Failure {
	fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
		f.write_str(&self.0)
	}
}

impl From<io::Error> for Failure {
	fn from(error: io::Error) -> Self {
		Self(error.to_string())
	}
}

type ExecResult<T> = Result<T, Failure>;

fn failure(error: impl Display) -> Failure {
	Failure(error.to_string())
}

mod options {

	pub(super) const ALGORITHM: &str = "algorithm";
	pub(super) const DEBUG: &str = "debug";


	pub(super) const FILE: &str = "file";

	pub(super) const UNTAGGED: &str = "untagged";
	pub(super) const TAG: &str = "tag";
	pub(super) const LENGTH: &str = "length";
	pub(super) const RAW: &str = "raw";
	pub(super) const BASE64: &str = "base64";
	pub(super) const CHECK: &str = "check";
	pub(super) const TEXT: &str = "text";
	pub(super) const BINARY: &str = "binary";
	pub(super) const ZERO: &str = "zero";


	pub(super) const STRICT: &str = "strict";
	pub(super) const STATUS: &str = "status";
	pub(super) const WARN: &str = "warn";
	pub(super) const IGNORE_MISSING: &str = "ignore-missing";
	pub(super) const QUIET: &str = "quiet";
}



trait ChecksumCommand {
	fn with_algo(self) -> Self;

	fn with_length(self) -> Self;

	fn with_check_and_opts(self) -> Self;

	fn with_binary(self) -> Self;

	fn with_text(self, is_default: bool) -> Self;

	fn with_tag(self, is_default: bool) -> Self;

	fn with_untagged(self) -> Self;

	fn with_raw(self) -> Self;

	fn with_base64(self) -> Self;

	fn with_zero(self) -> Self;

	fn with_debug(self) -> Self;
}

impl ChecksumCommand for Command {
	fn with_algo(self) -> Self {
		self.arg(
			Arg::new(options::ALGORITHM)
				.long(options::ALGORITHM)
				.short('a')
				.help("select the digest type to use. See DIGEST below")
				.value_name("ALGORITHM")
				.value_parser(SUPPORTED_ALGORITHMS),
		)
	}

	fn with_length(self) -> Self {
		self.arg(
			Arg::new(options::LENGTH)
				.long(options::LENGTH)
				.short('l')
				.help(
					"digest length in bits; must not exceed the maximum and must be a multiple of 8 \
					 for BLAKE2b",
				)
				.action(ArgAction::Set),
		)
	}

	fn with_check_and_opts(self) -> Self {
		self
			.arg(
				Arg::new(options::CHECK)
					.short('c')
					.long(options::CHECK)
					.help("read checksums from the FILEs and check them")
					.action(ArgAction::SetTrue),
			)
			.arg(
				Arg::new(options::WARN)
					.short('w')
					.long("warn")
					.help("warn about improperly formatted checksum lines")
					.action(ArgAction::SetTrue)
					.overrides_with_all([options::STATUS, options::QUIET]),
			)
			.arg(
				Arg::new(options::STATUS)
					.long("status")
					.help("don't output anything, status code shows success")
					.action(ArgAction::SetTrue)
					.overrides_with_all([options::WARN, options::QUIET]),
			)
			.arg(
				Arg::new(options::QUIET)
					.long(options::QUIET)
					.help("don't print OK for each successfully verified file")
					.action(ArgAction::SetTrue)
					.overrides_with_all([options::STATUS, options::WARN]),
			)
			.arg(
				Arg::new(options::IGNORE_MISSING)
					.long(options::IGNORE_MISSING)
					.help("don't fail or report status for missing files")
					.action(ArgAction::SetTrue),
			)
			.arg(
				Arg::new(options::STRICT)
					.long(options::STRICT)
					.help("exit non-zero for improperly formatted checksum lines")
					.action(ArgAction::SetTrue),
			)
	}

	fn with_binary(self) -> Self {
		self.arg(
			Arg::new(options::BINARY)
				.long(options::BINARY)
				.short('b')
				.hide(true)
				.overrides_with(options::TEXT)
				.action(ArgAction::SetTrue),
		)
	}

	fn with_text(self, is_default: bool) -> Self {
		let mut arg = Arg::new(options::TEXT)
			.long(options::TEXT)
			.short('t')
			.action(ArgAction::SetTrue);

		arg = if is_default {
			arg.help("read in text mode (default)")
		} else {
			arg.hide(true)
		};

		self.arg(arg)
	}

	fn with_tag(self, default: bool) -> Self {
		let mut arg = Arg::new(options::TAG)
			.long(options::TAG)
			.action(ArgAction::SetTrue);

		arg = if default {
			arg.help("create a BSD style checksum (default)")
		} else {
			arg.help("create a BSD style checksum")
		};

		self.arg(arg)
	}

	fn with_untagged(self) -> Self {
		self.arg(
			Arg::new(options::UNTAGGED)
				.long(options::UNTAGGED)
				.help("create a reversed style checksum, without digest type")
				.overrides_with(options::TAG)
				.action(ArgAction::SetTrue),
		)
	}

	fn with_raw(self) -> Self {
		self.arg(
			Arg::new(options::RAW)
				.long(options::RAW)
				.help("emit a raw binary digest, not hexadecimal")
				.action(ArgAction::SetTrue),
		)
	}

	fn with_base64(self) -> Self {
		self.arg(
			Arg::new(options::BASE64)
				.long(options::BASE64)
				.help("emit base64-encoded digests, not hexadecimal")
				.action(ArgAction::SetTrue)


				.conflicts_with(options::RAW),
		)
	}

	fn with_zero(self) -> Self {
		self.arg(
			Arg::new(options::ZERO)
				.long(options::ZERO)
				.short('z')
				.help("end each output line with NUL, not newline, and disable file name escaping")
				.action(ArgAction::SetTrue),
		)
	}

	fn with_debug(self) -> Self {
		self.arg(
			Arg::new(options::DEBUG)
				.long(options::DEBUG)
				.help("print CPU hardware capability detection info used by cksum")
				.action(ArgAction::SetTrue),
		)
	}
}

fn standalone_strings(bin: &str) -> (&'static str, &'static str) {
	match bin {
		"md5sum" => ("Print or check the MD5 checksums", "md5sum [OPTIONS] [FILE]..."),
		"sha1sum" => ("Print or check SHA1 (160-bit) checksums", "sha1sum [OPTION]... [FILE]..."),
		"sha224sum" => {
			("Print or check SHA224 (224-bit) checksums", "sha224sum [OPTION]... [FILE]...")
		},
		"sha256sum" => {
			("Print or check SHA256 (256-bit) checksums", "sha256sum [OPTION]... [FILE]...")
		},
		"sha384sum" => {
			("Print or check SHA384 (384-bit) checksums", "sha384sum [OPTION]... [FILE]...")
		},
		"sha512sum" => {
			("Print or check SHA512 (512-bit) checksums", "sha512sum [OPTION]... [FILE]...")
		},
		"b2sum" => ("Print or check BLAKE2b (512-bit) checksums", "b2sum [OPTION]... [FILE]..."),
		_ => ("Print or check checksums", "checksum [OPTION]... [FILE]..."),
	}
}

fn default_checksum_app(about: impl Into<String>, usage: impl Into<String>) -> Command {
	Command::new("")
		.version("0.8.0")
		.about(about.into())
		.override_usage(usage.into())
		.infer_long_args(true)
		.args_override_self(true)
		.after_help("With no FILE or when FILE is -, read standard input")
		.arg(
			Arg::new(options::FILE)
				.hide(true)
				.action(ArgAction::Append)
				.value_parser(ValueParser::os_string())
				.default_value("-")
				.hide_default_value(true)
				.value_hint(ValueHint::FilePath),
		)
}

fn standalone_checksum_app_with_length(
	about: impl Into<String>,
	usage: impl Into<String>,
) -> Command {
	default_checksum_app(about, usage)
		.with_binary()
		.with_check_and_opts()
		.with_length()
		.with_tag(false)
		.with_text(true)
		.with_zero()
}

fn standalone_checksum_app(about: impl Into<String>, usage: impl Into<String>) -> Command {
	default_checksum_app(about, usage)
		.with_binary()
		.with_check_and_opts()
		.with_tag(false)
		.with_text(true)
		.with_zero()
}

fn checksum_main(
	host: &mut Host,
	algo: Option<AlgoKind>,
	length: Option<usize>,
	matches: ArgMatches,
	output_format: OutputFormat,
) -> ExecResult<()> {
	let check = matches.get_flag(options::CHECK);
	let check_flag = |flag| match (check, matches.get_flag(flag)) {
		(_, false) => Ok(false),
		(true, true) => Ok(true),
		(false, true) => Err(failure(ChecksumError::CheckOnlyFlag(flag.into()))),
	};
	let ignore_missing = check_flag(options::IGNORE_MISSING)?;
	let warn = check_flag(options::WARN)?;
	let quiet = check_flag(options::QUIET)?;
	let strict = check_flag(options::STRICT)?;
	let status = check_flag(options::STATUS)?;
	let text_flag = matches.get_flag(options::TEXT);
	let binary_flag = matches.get_flag(options::BINARY);
	let tag = matches.get_flag(options::TAG);
	let files = matches
		.get_many::<OsString>(options::FILE)
		.expect("FILE has a default value")
		.map(Borrow::borrow);

	if text_flag && tag {
		return Err(failure(ChecksumError::TextAfterTag));
	}
	if check {
		if algo.is_some_and(AlgoKind::is_legacy) {
			return Err(failure(ChecksumError::AlgorithmNotSupportedWithCheck));
		}
		if tag {
			return Err(failure(ChecksumError::TagCheck));
		}
		if binary_flag || text_flag {
			return Err(failure(ChecksumError::BinaryTextConflict));
		}
		let opts = ChecksumValidateOptions {
			ignore_missing,
			strict,
			verbose: ChecksumVerbose::new(status, quiet, warn),
		};
		return perform_checksum_validation(host, files, algo, length, opts);
	}

	let algo = SizedAlgoKind::from_unsized(algo.unwrap_or(AlgoKind::Crc), length)
		.map_err(failure)?;
	let opts = ChecksumComputeOptions {
		algo_kind: algo,
		output_format,
		line_ending: LineEnding::from_zero_flag(matches.get_flag(options::ZERO)),
	};
	perform_checksum_computation(host, opts, files)
}


pub(crate) fn command(name: &'static str, with_length: bool) -> Command {
	let (about, usage) = standalone_strings(name);
	if with_length {
		standalone_checksum_app_with_length(
			"Print or check BLAKE2b (512-bit) checksums.",
			usage,
		)
		.name(name)
	} else {
		standalone_checksum_app(about, usage).name(name)
	}
}


pub(crate) fn run(
	host: &mut Host,
	algo: AlgoKind,
	matches: ArgMatches,
	length: Option<usize>,
) -> i32 {
	let text = !matches.get_flag(options::BINARY);
	let tag = matches.get_flag(options::TAG);
	let format = OutputFormat::from_standalone(text, tag);
	match checksum_main(host, Some(algo), length, matches, format) {
		Ok(()) => host.exit_code(),
		Err(error) => {
			if !error.0.is_empty() {
				host.error(error, 1);
			}
			1
		},
	}
}


pub(crate) struct Cksum {
	matches: ArgMatches,
}

matches_parser!(Cksum, cksum_app);

impl Utility for Cksum {
	const NAME: &'static str = "cksum";

	fn run(self, host: &mut Host) -> i32 {
		match run_cksum(host, self.matches) {
			Ok(()) => host.exit_code(),
			Err(error) => {
				if !error.0.is_empty() {
					host.error(error, 1);
				}
				1
			},
		}
	}
}


fn cksum_app() -> Command {
	default_checksum_app(
		"Print or verify checksums; without --algorithm, prints the POSIX CRC and byte count",
		"cksum [OPTION]... [FILE]...",
	)
	.name("cksum")
	.with_algo()
	.with_untagged()
	.with_tag(true)
	.with_length()
	.with_raw()
	.with_check_and_opts()
	.with_base64()
	.with_text(false)
	.with_binary()
	.with_zero()
	.with_debug()
}


pub(crate) fn cksum_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Cksum, SE>()
}


fn sanitize_cksum_length(
	host: &mut Host,
	algo: Option<AlgoKind>,
	input_length: Option<&str>,
) -> ExecResult<Option<usize>> {
	match (algo, input_length) {

		(_, None) => Ok(None),


		(Some(algo @ (AlgoKind::Sha2 | AlgoKind::Sha3)), Some(len)) => {



			let parsed = match len.parse::<usize>() {
				Ok(parsed) => Some(parsed),
				Err(error) if *error.kind() == std::num::IntErrorKind::PosOverflow => None,
				Err(_) => return Err(failure(ChecksumError::InvalidLength(len.into()))),
			};
			match parsed {
				Some(parsed @ (224 | 256 | 384 | 512)) => Ok(Some(parsed)),
				_ => {
					host.error(ChecksumError::InvalidLength(len.into()), 1);
					Err(failure(ChecksumError::InvalidLengthForSha(algo.to_uppercase().into())))
				},
			}
		},



		(Some(AlgoKind::Shake128 | AlgoKind::Shake256), Some(len)) => match len.parse::<usize>() {
			Ok(0) => Ok(None),
			Ok(parsed) => Ok(Some(parsed)),
			Err(_) => Err(failure(ChecksumError::InvalidLength(len.into()))),
		},


		(Some(algo @ (AlgoKind::Blake2b | AlgoKind::Blake3)), Some(len)) => {
			parse_blake_length(algo, BlakeLength::String(len)).map(Some).map_err(failure)
		},



		(_, Some(len)) if len.parse::<u32>() == Ok(0) => Ok(None),
		(_, Some(_)) => Err(failure(ChecksumError::LengthOnlyForBlake2bSha2Sha3)),
	}
}



fn print_cpu_debug_info(host: &mut Host) {
	let features = SimdPolicy::detect();

	let mut print_feature = |name: &str, available: bool| {
		if available {
			let _ = writeln!(host.stderr, "using {name} hardware support");
		} else {
			let _ = writeln!(host.stderr, "{name} support not detected");
		}
	};


	print_feature("avx512", features.has_avx512());
	print_feature("avx2", features.has_avx2());
	print_feature("pclmul", features.has_pclmul());


	if cfg!(target_arch = "aarch64") {
		print_feature("vmull", features.has_vmull());
	}
}




fn run_cksum(host: &mut Host, matches: ArgMatches) -> ExecResult<()> {
	let algo = matches
		.get_one::<String>(options::ALGORITHM)
		.map(AlgoKind::from_cksum)
		.transpose()
		.map_err(failure)?;

	let input_length = matches.get_one::<String>(options::LENGTH).map(String::as_str);
	let length = sanitize_cksum_length(host, algo, input_length)?;

	let tag = !matches.get_flag(options::UNTAGGED);
	let binary = matches.get_flag(options::BINARY);
	let text = matches.get_flag(options::TEXT);


	if text && tag {
		return Err(failure(ChecksumError::TextWithoutUntagged));
	}

	let output_format = OutputFormat::from_cksum(
		algo.unwrap_or(AlgoKind::Crc),
		tag,
		binary,
		matches.get_flag(options::RAW),
		matches.get_flag(options::BASE64),
	);

	if matches.get_flag(options::DEBUG) {
		print_cpu_debug_info(host);
	}

	checksum_main(host, algo, length, matches, output_format)
}



const READ_BUFFER_SIZE: usize = 32 * 1024;






struct ChecksumComputeOptions {

	algo_kind: SizedAlgoKind,


	output_format: OutputFormat,


	line_ending: LineEnding,
}


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DigestFormat {
	Hexadecimal,
	Base64,
}

impl DigestFormat {
	#[inline]
	fn is_base64(self) -> bool {
		self == Self::Base64
	}
}


#[derive(Debug, PartialEq, Eq)]
enum OutputFormat {

	Raw,




	Legacy,


	Tagged(DigestFormat),





	Untagged(DigestFormat, ReadingMode),
}

impl OutputFormat {
	#[inline]
	fn is_raw(&self) -> bool {
		*self == Self::Raw
	}


	fn from_cksum(algo: AlgoKind, tag: bool, binary: bool, raw: bool, base64: bool) -> Self {

		if raw {
			return Self::Raw;
		}


		if algo.is_legacy() {
			return Self::Legacy;
		}

		let digest_format = if base64 {
			DigestFormat::Base64
		} else {
			DigestFormat::Hexadecimal
		};


		if tag {
			Self::Tagged(digest_format)
		} else {
			let reading_mode = if binary {
				ReadingMode::Binary
			} else {
				ReadingMode::Text
			};
			Self::Untagged(digest_format, reading_mode)
		}
	}






	fn from_standalone(text: bool, tag: bool) -> Self {
		if tag {
			Self::Tagged(DigestFormat::Hexadecimal)
		} else {
			Self::Untagged(
				DigestFormat::Hexadecimal,
				if text {
					ReadingMode::Text
				} else {
					ReadingMode::Binary
				},
			)
		}
	}
}

fn print_legacy_checksum(
	host: &mut Host,
	options: &ChecksumComputeOptions,
	filename: &OsStr,
	sum: &DigestOutput,
	size: usize,
) {
	debug_assert!(options.algo_kind.is_legacy());
	debug_assert!(matches!(sum, DigestOutput::U16(_) | DigestOutput::Crc(_)));

	let (escaped_filename, prefix) = if options.line_ending == LineEnding::Nul {
		(filename.to_string_lossy().to_string(), "")
	} else {
		escape_filename(filename)
	};


	match (options.algo_kind, sum) {
		(SizedAlgoKind::Sysv, DigestOutput::U16(sum)) => {
			let _ = write!(
				&mut host.stdout,
				"{prefix}{sum} {}",
				size.div_ceil(options.algo_kind.bitlen()),
			);
		},
		(SizedAlgoKind::Bsd, DigestOutput::U16(sum)) => {

			let bsd_width = 5;
			let _ = write!(
				&mut host.stdout,
				"{prefix}{sum:0bsd_width$} {:bsd_width$}",
				size.div_ceil(options.algo_kind.bitlen()),
			);
		},
		(SizedAlgoKind::Crc | SizedAlgoKind::Crc32b, DigestOutput::Crc(sum)) => {
			let _ = write!(&mut host.stdout, "{prefix}{sum} {size}");
		},
		(algo, output) => unreachable!("Bug: Invalid legacy checksum ({algo:?}, {output:?})"),
	}


	if escaped_filename != "-" {
		let _ = write!(&mut host.stdout, " ");
		let _dropped_result = &mut host.stdout.write_all(escaped_filename.as_bytes());
	}
}

fn print_tagged_checksum(host: &mut Host, options: &ChecksumComputeOptions, filename: &OsStr, sum: &String) {
	let (escaped_filename, prefix) = if options.line_ending == LineEnding::Nul {
		(filename.to_string_lossy().to_string(), "")
	} else {
		escape_filename(filename)
	};


	let _ = write!(&mut host.stdout, "{prefix}{} (", options.algo_kind.to_tag());


	let _dropped_result = &mut host.stdout.write_all(escaped_filename.as_bytes());


	let _ = write!(&mut host.stdout, ") = {sum}");
}

fn print_untagged_checksum(
	host: &mut Host,
	options: &ChecksumComputeOptions,
	filename: &OsStr,
	sum: &String,
	reading_mode: ReadingMode,
) {
	let (escaped_filename, prefix) = if options.line_ending == LineEnding::Nul {
		(filename.to_string_lossy().to_string(), "")
	} else {
		escape_filename(filename)
	};


	let _ = write!(&mut host.stdout, "{prefix}{sum} {}", match reading_mode {
		ReadingMode::Binary => '*',
		ReadingMode::Text => ' ',
	});


	let _dropped_result = &mut host.stdout.write_all(escaped_filename.as_bytes());
}








fn perform_checksum_computation<'a, I>(
	host: &mut Host,
	options: ChecksumComputeOptions,
	files: I,
) -> ExecResult<()>
where
	I: Iterator<Item = &'a OsStr>,
{
	let mut files = files.peekable();

	while let Some(filename) = files.next() {

		if options.output_format.is_raw() && files.peek().is_some() {
			return Err(failure(ChecksumError::RawMultipleFiles));
		}

		let filepath = std::path::Path::new(filename);
		let resolved_filepath = host.resolve(filepath);
		let stdin_buf;
		let file_buf;
		if resolved_filepath.is_dir() {
			host.error(format!("{}: Is a directory", filepath.display()), 1);
			continue;
		}


		let mut file = BufReader::with_capacity(
			READ_BUFFER_SIZE,
			if filename == "-" {
				stdin_buf = &mut host.stdin;
				Box::new(stdin_buf) as Box<dyn Read>
			} else {
				file_buf = match host.open_read(&resolved_filepath) {
					Ok(file) => file,
					Err(err) => {
						host.error(format!("{}: {err}", filepath.to_string_lossy()), 1);
						continue;
					},
				};
				Box::new(file_buf) as Box<dyn Read>
			},
		);

		let mut digest = options.algo_kind.create_digest();



		let (digest_output, sz) = digest_reader(&mut digest, &mut file, ReadingMode::Binary)
			.map_err(|error| failure(format!("failed to read input: {error}")))?;
		drop(file);


		let encode_sum = |sum: DigestOutput, df: DigestFormat| {
			if df.is_base64() {
				sum.to_base64()
			} else {
				sum.to_hex()
			}
		};

		match options.output_format {
			OutputFormat::Raw => {

				digest_output.write_raw(&mut host.stdout)?;
				return Ok(());
			},
			OutputFormat::Legacy => {
				print_legacy_checksum(host, &options, filename, &digest_output, sz);
			},
			OutputFormat::Tagged(digest_format) => {
				print_tagged_checksum(host, &options, filename, &encode_sum(digest_output, digest_format).map_err(failure)?);
			},
			OutputFormat::Untagged(digest_format, reading_mode) => {
				print_untagged_checksum(
					host,
					&options,
					filename,
					&encode_sum(digest_output, digest_format).map_err(failure)?,
					reading_mode,
				);
			},
		}

		let _ = write!(&mut host.stdout, "{}", options.line_ending);
	}
	Ok(())
}


#[derive(Debug, PartialEq, Eq, PartialOrd, Clone, Copy, Default)]
enum ChecksumVerbose {
	Status,
	Quiet,
	#[default]
	Normal,
	Warning,
}

impl ChecksumVerbose {
	fn new(status: bool, quiet: bool, warn: bool) -> Self {
		use ChecksumVerbose::*;



		match (status, quiet, warn) {
			(true, ..) => Status,
			(_, true, _) => Quiet,
			(_, _, true) => Warning,
			_ => Normal,
		}
	}

	#[inline]
	fn over_status(self) -> bool {
		self > Self::Status
	}

	#[inline]
	fn over_quiet(self) -> bool {
		self > Self::Quiet
	}

	#[inline]
	fn at_least_warning(self) -> bool {
		self >= Self::Warning
	}
}


#[derive(Debug, Default, Clone, Copy)]
struct ChecksumValidateOptions {
	ignore_missing: bool,
	strict:         bool,
	verbose:        ChecksumVerbose,
}


#[derive(Default)]
struct ChecksumResult {


	correct:          u32,


	failed_cksum:     u32,
	failed_open_file: u32,

	bad_format:       u32,

	total:            u32,
}

impl ChecksumResult {
	#[inline]
	fn total_properly_formatted(&self) -> u32 {
		self.total - self.bad_format
	}
}



enum LineCheckError {

	Critical(Failure),

	DigestMismatch,

	Skipped,

	ImproperlyFormatted,

	CantOpenFile,

	FileNotFound,

	FileIsDirectory,
}

impl From<Failure> for LineCheckError {
	fn from(value: Failure) -> Self {
		Self::Critical(value)
	}
}

impl From<ChecksumError> for LineCheckError {
	fn from(value: ChecksumError) -> Self {
		Self::Critical(failure(value))
	}
}


enum FileCheckError {

	Critical(Failure),

	CantOpenChecksumFile,



	Failed,
}

impl From<Failure> for FileCheckError {
	fn from(value: Failure) -> Self {
		Self::Critical(value)
	}
}

impl From<ChecksumError> for FileCheckError {
	fn from(value: ChecksumError) -> Self {
		Self::Critical(failure(value))
	}
}

fn print_cksum_report(host: &mut Host, res: &ChecksumResult) {
	if res.bad_format > 0 {
		let name = host.name().to_owned();
		let _ = writeln!(host.stderr, "{name}: WARNING: {} line(s) are improperly formatted", res.bad_format);
	}
	if res.failed_cksum > 0 {
		let name = host.name().to_owned();
		let _ = writeln!(host.stderr, "{name}: WARNING: {} computed checksum(s) did NOT match", res.failed_cksum);
	}
	if res.failed_open_file > 0 {
		let name = host.name().to_owned();
		let _ = writeln!(host.stderr, "{name}: WARNING: {} listed file(s) could not be read", res.failed_open_file);
	}
}

#[inline]
fn log_no_properly_formatted(host: &mut Host, filename: impl Display) {
	let name = host.name().to_owned();
	let _ = writeln!(host.stderr, "{name}: {filename}: no properly formatted checksum lines found");
}

#[inline]
fn log_no_file_verified(host: &mut Host, filename: impl Display) {
	let name = host.name().to_owned();
	let _ = writeln!(host.stderr, "{name}: {filename}: no file was verified");
}



#[derive(Debug, Clone, Copy)]
enum FileChecksumResult {
	Ok,
	Failed,
	CantOpen,
}

impl FileChecksumResult {


	fn from_bool(checksum_correct: bool) -> Self {
		if checksum_correct {
			Self::Ok
		} else {
			Self::Failed
		}
	}



	fn can_display(self, verbose: ChecksumVerbose) -> bool {
		match self {
			Self::Ok => verbose.over_quiet(),
			Self::Failed => verbose.over_status(),
			Self::CantOpen => true,
		}
	}
}

impl Display for FileChecksumResult {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Ok => write!(f, "OK"),
			Self::Failed => write!(f, "FAILED"),
			Self::CantOpen => write!(f, "FAILED open or read"),
		}
	}
}



fn write_file_report<W: Write>(
	mut w: W,
	filename: &[u8],
	result: FileChecksumResult,
	prefix: &str,
	verbose: ChecksumVerbose,
) {
	if result.can_display(verbose) {
		let _ = write!(w, "{prefix}");
		let _ = w.write_all(filename);
		let _ = writeln!(w, ": {result}");
	}
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum LineFormat {
	AlgoBased,
	SingleSpace,
	Untagged,
}

impl LineFormat {





	fn parse_algo_based(line: &[u8]) -> Option<LineInfo> {



		let trimmed = line.trim_ascii_start();
		let algo_start = usize::from(trimmed.starts_with(b"\\"));
		let rest = &trimmed[algo_start..];

		enum SubCase {
			Posix,
			OpenSSL,
		}



		let par_idx = rest.iter().position(|&b| b == b'(')?;
		let sub_case = if rest[par_idx - 1] == b' ' {
			SubCase::Posix
		} else {
			SubCase::OpenSSL
		};

		let algo_substring = match sub_case {
			SubCase::Posix => &rest[..par_idx - 1],
			SubCase::OpenSSL => &rest[..par_idx],
		};
		let mut algo_parts = algo_substring.splitn(2, |&b| b == b'-');
		let algo = algo_parts.next()?;


		let algo_bits = algo_parts
			.next()
			.and_then(|s| std::str::from_utf8(s).ok()?.parse::<usize>().ok());


		let is_valid_algo = algo == b"BLAKE2b"
			|| algo
				.iter()
				.all(|&b| b.is_ascii_uppercase() || b.is_ascii_digit());
		if !is_valid_algo {
			return None;
		}


		let algo_utf8 = unsafe { String::from_utf8_unchecked(algo.to_vec()) };


		let after_paren = rest.get(par_idx + 1..)?;
		let (filename, checksum) = match sub_case {
			SubCase::Posix => ByteSliceExt::rsplit_once(after_paren, b") = ")?,
			SubCase::OpenSSL => ByteSliceExt::rsplit_once(after_paren, b")= ")?,
		};

		let checksum_utf8 = Self::validate_checksum_format(checksum)?;

		Some(LineInfo {
			algo_name:    Some(algo_utf8),
			algo_bit_len: algo_bits,
			checksum:     checksum_utf8,
			filename:     filename.to_vec(),
			format:       Self::AlgoBased,
		})
	}

	#[allow(rustdoc::invalid_html_tags)]





	fn parse_untagged(line: &[u8]) -> Option<LineInfo> {
		let space_idx = line.iter().position(|&b| b == b' ')?;
		let checksum = &line[..space_idx];

		let checksum_utf8 = Self::validate_checksum_format(checksum)?;

		let rest = &line[space_idx..];
		let filename = rest
			.strip_prefix(b"  ")
			.or_else(|| rest.strip_prefix(b" *"))?;

		Some(LineInfo {
			algo_name:    None,
			algo_bit_len: None,
			checksum:     checksum_utf8,
			filename:     filename.to_vec(),
			format:       Self::Untagged,
		})
	}

	#[allow(rustdoc::invalid_html_tags)]









	fn parse_single_space(line: &[u8]) -> Option<LineInfo> {

		let space_idx = line.iter().position(|&b| b == b' ')?;
		let checksum = &line[..space_idx];
		if !checksum.iter().all(|&b| b.is_ascii_hexdigit()) || checksum.is_empty() {
			return None;
		}


		let checksum_utf8 = unsafe { String::from_utf8_unchecked(checksum.to_vec()) };

		let filename = line.get(space_idx + 1..)?;

		Some(LineInfo {
			algo_name:    None,
			algo_bit_len: None,
			checksum:     checksum_utf8,
			filename:     filename.to_vec(),
			format:       Self::SingleSpace,
		})
	}



	fn validate_checksum_format(checksum: &[u8]) -> Option<String> {
		if checksum.is_empty() {
			return None;
		}

		let mut is_base64 = false;

		for index in 0..checksum.len() {
			match checksum[index..] {

				[b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9', ..] => (),

				[b'+' | b'/', ..] => is_base64 = true,

				[b'='] | [b'=', b'='] | [b'=', b'=', b'='] => {
					is_base64 = true;
					break;
				},

				_ => return None,
			}
		}








		if is_base64 && !checksum.len().is_multiple_of(4) {
			return None;
		}



		Some(unsafe { String::from_utf8_unchecked(checksum.to_vec()) })
	}
}


trait ByteSliceExt {

	fn rsplit_once(&self, pattern: &[u8]) -> Option<(&Self, &Self)>;
}

impl ByteSliceExt for [u8] {
	fn rsplit_once(&self, pattern: &[u8]) -> Option<(&Self, &Self)> {
		let pos = self
			.windows(pattern.len())
			.rev()
			.position(|w| w == pattern)?;
		Some((&self[..self.len() - pattern.len() - pos], &self[self.len() - pos..]))
	}
}


struct LineInfo {
	algo_name:    Option<String>,
	algo_bit_len: Option<usize>,
	checksum:     String,
	filename:     Vec<u8>,
	format:       LineFormat,
}

impl LineInfo {









	fn parse(s: impl AsRef<OsStr>, cached_line_format: &mut Option<LineFormat>) -> Option<Self> {
		let line_bytes = os_bytes(s.as_ref())?;

		if let Some(info) = LineFormat::parse_algo_based(line_bytes) {
			return Some(info);
		}
		if let Some(cached_format) = cached_line_format {
			match cached_format {
				LineFormat::Untagged => LineFormat::parse_untagged(line_bytes),
				LineFormat::SingleSpace => LineFormat::parse_single_space(line_bytes),
				LineFormat::AlgoBased => unreachable!("we never catch the algo based format"),
			}
		} else if let Some(info) = LineFormat::parse_untagged(line_bytes) {
			*cached_line_format = Some(LineFormat::Untagged);
			Some(info)
		} else if let Some(info) = LineFormat::parse_single_space(line_bytes) {
			*cached_line_format = Some(LineFormat::SingleSpace);
			Some(info)
		} else {
			None
		}
	}
}


fn forgiving_base64_decode(input: &[u8]) -> Option<Vec<u8>> {
	let input = input.strip_suffix(b"==").or_else(|| input.strip_suffix(b"=")).unwrap_or(input);
	if input.len() % 4 == 1 {
		return None;
	}

	fn sextet(byte: u8) -> Option<u8> {
		match byte {
			b'A'..=b'Z' => Some(byte - b'A'),
			b'a'..=b'z' => Some(byte - b'a' + 26),
			b'0'..=b'9' => Some(byte - b'0' + 52),
			b'+' => Some(62),
			b'/' => Some(63),
			_ => None,
		}
	}

	let mut output = Vec::with_capacity(input.len() / 4 * 3 + 2);
	let mut chunks = input.chunks_exact(4);
	for chunk in &mut chunks {
		let a = sextet(chunk[0])?;
		let b = sextet(chunk[1])?;
		let c = sextet(chunk[2])?;
		let d = sextet(chunk[3])?;
		output.extend_from_slice(&[
			(a << 2) | (b >> 4),
			(b << 4) | (c >> 2),
			(c << 6) | d,
		]);
	}
	match chunks.remainder() {
		[] => {},
		[a, b] => output.push((sextet(*a)? << 2) | (sextet(*b)? >> 4)),
		[a, b, c] => {
			let a = sextet(*a)?;
			let b = sextet(*b)?;
			let c = sextet(*c)?;
			output.extend_from_slice(&[(a << 2) | (b >> 4), (b << 4) | (c >> 2)]);
		},
		_ => return None,
	}
	Some(output)
}


fn get_raw_expected_digest(checksum: &str, bit_len_hint: Option<usize>) -> Option<Vec<u8>> {



	if !checksum.len().is_multiple_of(2) {
		return None;
	}

	let byte_len_hint = bit_len_hint.map(|n| n.div_ceil(8));

	let checks_hint = |len| byte_len_hint.is_none_or(|hint| hint == len);



	if checks_hint(checksum.len() / 2)
		&& let Ok(raw_ck) = hex::decode(checksum)
	{
		return Some(raw_ck);
	}










	if !checksum.len().is_multiple_of(4) {
		return None;
	}





	forgiving_base64_decode(checksum.as_bytes()).filter(|raw| checks_hint(raw.len()))
}



fn get_file_to_check<'a>(
	host: &'a mut Host,
	filename: &OsStr,
	opts: ChecksumValidateOptions,
) -> Result<Box<dyn Read + 'a>, LineCheckError> {
	let filename_bytes = os_bytes(filename).ok_or_else(|| failure("invalid filename"))?;

	if filename == "-" {
		return Ok(Box::new(&mut host.stdin));
	}

	match host.open_read(filename) {
		Ok(file) => {
			if file.metadata().map_err(|_| LineCheckError::CantOpenFile)?.is_dir() {
				let escaped = locale_aware_escape_name(filename, QuotingStyle::SHELL_ESCAPE);
				host.error(format!("{}: Is a directory", escaped.to_string_lossy()), 1);
				write_file_report(
					&mut host.stdout,
					filename_bytes,
					FileChecksumResult::CantOpen,
					"",
					opts.verbose,
				);
				Err(LineCheckError::FileIsDirectory)
			} else {
				Ok(Box::new(file))
			}
		},
		Err(error) => {
			if !opts.ignore_missing {
				let escaped = locale_aware_escape_name(filename, QuotingStyle::SHELL_ESCAPE);
				host.error(format!("{}: {error}", escaped.to_string_lossy()), 1);
				write_file_report(
					&mut host.stdout,
					filename_bytes,
					FileChecksumResult::CantOpen,
					"",
					opts.verbose,
				);
			}
			Err(LineCheckError::FileNotFound)
		},
	}
}


fn get_input_file(host: &Host, filename: &OsStr) -> ExecResult<Box<dyn Read>> {
	match host.open_read(filename) {
		Ok(file) => {
			if file.metadata()?.is_dir() {
				Err(failure(format!("{}: Is a directory", filename.maybe_quote())))
			} else {
				Ok(Box::new(file))
			}
		},
		Err(_) => Err(failure(format!(
			"{}: No such file or directory",
			filename.maybe_quote()
		))),
	}
}



fn identify_algo_name_and_length(
	line_info: &LineInfo,
	algo_name_input: Option<AlgoKind>,
	last_algo: &mut Option<String>,
) -> Result<(AlgoKind, Option<usize>), LineCheckError> {
	use AlgoKind as ak;
	let algo_from_line = line_info.algo_name.clone().unwrap_or_default();
	let Ok(line_algo) = AlgoKind::from_cksum(algo_from_line.to_lowercase()) else {

		return Err(LineCheckError::ImproperlyFormatted);
	};
	*last_algo = Some(algo_from_line);





	if let Some(algo_name_input) = algo_name_input {
		match (algo_name_input, line_algo) {
			(l, r) if l == r => (),

			(ak::Sha2, ak::Sha224 | ak::Sha256 | ak::Sha384 | ak::Sha512) => (),
			_ => return Err(LineCheckError::ImproperlyFormatted),
		}
	}

	let bytes = if let Some(bitlen) = line_info.algo_bit_len {
		match line_algo {
			algo @ (ak::Blake2b | ak::Blake3) => {
				match parse_blake_length(algo, BlakeLength::Int(bitlen)) {
					Ok(len) => Some(len),
					Err(_) => return Err(LineCheckError::ImproperlyFormatted),
				}
			},
			ak::Sha2 | ak::Sha3 if [224, 256, 384, 512].contains(&bitlen) => Some(bitlen),
			ak::Shake128 | ak::Shake256 => Some(bitlen),









			_ => return Err(LineCheckError::ImproperlyFormatted),
		}
	} else if line_algo == ak::Blake2b {

		Some(Blake2b::DEFAULT_BYTE_SIZE)
	} else if line_algo == ak::Blake3 {

		Some(Blake3::DEFAULT_BYTE_SIZE)
	} else {
		None
	};

	Ok((line_algo, bytes))
}



fn compute_and_check_digest_from_file(
	host: &mut Host,
	filename: &[u8],
	expected_checksum: &[u8],
	algo: SizedAlgoKind,
	opts: ChecksumValidateOptions,
) -> Result<(), LineCheckError> {
	let (filename_to_check_unescaped, prefix) = unescape_filename(filename);
	let real_filename_to_check = os_str_from_bytes(&filename_to_check_unescaped)
		.map_err(|error| failure(error))?;

	let file_to_check = get_file_to_check(host, &real_filename_to_check, opts)?;
	let mut file_reader = BufReader::new(file_to_check);
	let mut digest = algo.create_digest();
	let calculated_checksum = match digest_reader(&mut digest, &mut file_reader, ReadingMode::Text) {
		Ok((result, _)) => result,
		Err(error) => {
			drop(file_reader);
			let escaped = locale_aware_escape_name(
				&real_filename_to_check,
				QuotingStyle::SHELL_ESCAPE,
			);
			host.error(format!("{}: {error}", escaped.to_string_lossy()), 1);
			write_file_report(
				&mut host.stdout,
				filename,
				FileChecksumResult::CantOpen,
				prefix,
				opts.verbose,
			);
			return Err(LineCheckError::CantOpenFile);
		},
	};
	drop(file_reader);

	let checksum_correct = match calculated_checksum {
		DigestOutput::Vec(data) => data == expected_checksum,
		DigestOutput::Crc(n) => n.to_be_bytes() == expected_checksum,
		DigestOutput::U16(n) => n.to_be_bytes() == expected_checksum,
	};
	write_file_report(
		&mut host.stdout,
		filename,
		FileChecksumResult::from_bool(checksum_correct),
		prefix,
		opts.verbose,
	);

	if checksum_correct { Ok(()) } else { Err(LineCheckError::DigestMismatch) }
}


fn process_algo_based_line(
	host: &mut Host,
	line_info: &LineInfo,
	cli_algo_kind: Option<AlgoKind>,
	opts: ChecksumValidateOptions,
	last_algo: &mut Option<String>,
) -> Result<(), LineCheckError> {
	let filename_to_check = line_info.filename.as_slice();

	let (algo_kind, algo_len) = identify_algo_name_and_length(line_info, cli_algo_kind, last_algo)?;



	let digest_bit_length_hint = match (algo_kind, algo_len) {
		(AlgoKind::Blake2b | AlgoKind::Blake3, Some(byte_len)) => Some(byte_len * 8),
		(AlgoKind::Shake128 | AlgoKind::Shake256, Some(bit_len)) => Some(bit_len),
		(AlgoKind::Shake128, None) => Some(sum::Shake128::DEFAULT_BIT_SIZE),
		(AlgoKind::Shake256, None) => Some(sum::Shake256::DEFAULT_BIT_SIZE),
		_ => None,
	};

	let expected_checksum = get_raw_expected_digest(&line_info.checksum, digest_bit_length_hint)
		.ok_or(LineCheckError::ImproperlyFormatted)?;

	let algo = SizedAlgoKind::from_unsized(algo_kind, algo_len)
		.map_err(|_| LineCheckError::ImproperlyFormatted)?;

	compute_and_check_digest_from_file(host, filename_to_check, &expected_checksum, algo, opts)
}


fn process_non_algo_based_line(
	host: &mut Host,
	line_number: usize,
	line_info: &LineInfo,
	cli_algo_kind: AlgoKind,
	cli_algo_length: Option<usize>,
	opts: ChecksumValidateOptions,
) -> Result<(), LineCheckError> {
	use AlgoKind as ak;
	let mut filename_to_check = line_info.filename.as_slice();
	if filename_to_check.starts_with(b"*")
		&& line_number == 0
		&& line_info.format == LineFormat::SingleSpace
	{

		filename_to_check = &filename_to_check[1..];
	}

	let expected_digest_sum = cli_algo_kind.expected_digest_bit_len();
	let expected_checksum = get_raw_expected_digest(&line_info.checksum, expected_digest_sum)
		.ok_or(LineCheckError::ImproperlyFormatted)?;




	let algo_byte_len = match cli_algo_kind {
		ak::Blake2b | ak::Blake3 => Some(expected_checksum.len()),
		ak::Sha2 | ak::Sha3 => {

			Some(
				ShaLength::try_from(expected_checksum.len() * 8)
					.map_err(|_| LineCheckError::ImproperlyFormatted)?
					.as_usize(),
			)
		},
		_ => cli_algo_length,
	};

	let algo = SizedAlgoKind::from_unsized(cli_algo_kind, algo_byte_len)
		.map_err(|error| LineCheckError::Critical(failure(error)))?;

	compute_and_check_digest_from_file(host, filename_to_check, &expected_checksum, algo, opts)
}







fn process_checksum_line(
	host: &mut Host,
	line: &OsStr,
	i: usize,
	cli_algo_name: Option<AlgoKind>,
	cli_algo_length: Option<usize>,
	opts: ChecksumValidateOptions,
	cached_line_format: &mut Option<LineFormat>,
	last_algo: &mut Option<String>,
) -> Result<(), LineCheckError> {
	let line_bytes = os_bytes(line).ok_or_else(|| failure("invalid checksum line"))?;
	if line.is_empty() || line_bytes.starts_with(b"#") {
		return Err(LineCheckError::Skipped);
	}

	let Some(line_info) = LineInfo::parse(line, cached_line_format) else {
		return Err(LineCheckError::ImproperlyFormatted);
	};

	if line_info.format == LineFormat::AlgoBased {
		process_algo_based_line(host, &line_info, cli_algo_name, opts, last_algo)
	} else if let Some(cli_algo) = cli_algo_name {
		process_non_algo_based_line(host, i, &line_info, cli_algo, cli_algo_length, opts)
	} else {
		Err(LineCheckError::ImproperlyFormatted)
	}
}

fn process_checksum_file(
	host: &mut Host,
	filename_input: &OsStr,
	cli_algo_kind: Option<AlgoKind>,
	cli_algo_length: Option<usize>,
	opts: ChecksumValidateOptions,
) -> Result<(), FileCheckError> {
	let mut res = ChecksumResult::default();
	let input_is_stdin = filename_input == OsStr::new("-");

	let lines = {
		let file: Box<dyn Read + '_> = if input_is_stdin {
			Box::new(&mut host.stdin)
		} else {
			match get_input_file(host, filename_input) {
				Ok(file) => file,
				Err(error) => {
					let name = host.name().to_owned();
					let _ = writeln!(host.stderr, "{name}: {error}");
					return Err(FileCheckError::CantOpenChecksumFile);
				},
			}
		};
		read_os_string_lines(BufReader::new(file))
			.collect::<Result<Vec<_>, _>>()
			.map_err(|_| failure(format!("{}: read error", filename_input.maybe_quote())))?
	};

	let mut cached_line_format = None;
	let mut last_algo = None;
	for (i, line) in lines.into_iter().enumerate() {
		let line_result = process_checksum_line(
			host,
			&line,
			i,
			cli_algo_kind,
			cli_algo_length,
			opts,
			&mut cached_line_format,
			&mut last_algo,
		);

		use LineCheckError::*;
		match &line_result {
			Err(Critical(error)) => return Err(FileCheckError::Critical(error.clone())),
			Err(Skipped) => (),
			_ => res.total += 1,
		}

		match line_result {
			Ok(()) => res.correct += 1,
			Err(DigestMismatch) => res.failed_cksum += 1,
			Err(ImproperlyFormatted) => {
				res.bad_format += 1;
				if opts.verbose.at_least_warning() {
					let algo = if let Some(input) = cli_algo_kind {
						input.to_uppercase()
					} else if let Some(algo) = &last_algo {
						algo.as_str()
					} else {
						"Unknown algorithm"
					};
					let name = host.name().to_owned();
					let _ = writeln!(
						host.stderr,
						"{name}: {}: line {}: improperly formatted {algo} checksum line",
						filename_input.maybe_quote(),
						i + 1,
					);
				}
			},
			Err(CantOpenFile | FileIsDirectory) => res.failed_open_file += 1,
			Err(FileNotFound) if !opts.ignore_missing => res.failed_open_file += 1,
			_ => (),
		}
	}

	let filename_display = || {
		if input_is_stdin { "standard input".maybe_quote() } else { filename_input.maybe_quote() }
	};
	if res.total_properly_formatted() == 0 {
		if opts.verbose.over_status() {
			log_no_properly_formatted(host, filename_display());
		}
		return Err(FileCheckError::Failed);
	}
	if opts.verbose.over_status() {
		print_cksum_report(host, &res);
	}
	if opts.ignore_missing && res.correct == 0 {
		if opts.verbose.over_status() {
			log_no_file_verified(host, filename_display());
		}
		return Err(FileCheckError::Failed);
	}
	if opts.strict && res.bad_format > 0 {
		return Err(FileCheckError::Failed);
	}
	if res.failed_open_file > 0 && !opts.ignore_missing {
		return Err(FileCheckError::Failed);
	}
	if res.failed_cksum > 0 {
		return Err(FileCheckError::Failed);
	}
	Ok(())
}


fn perform_checksum_validation<'a, I>(
	host: &mut Host,
	files: I,
	algo_kind: Option<AlgoKind>,
	length_input: Option<usize>,
	opts: ChecksumValidateOptions,
) -> ExecResult<()>
where
	I: Iterator<Item = &'a OsStr>,
{
	let mut failed = false;
	for filename_input in files {
		use FileCheckError::*;
		match process_checksum_file(host, filename_input, algo_kind, length_input, opts) {
			Err(Critical(error)) => return Err(error),
			Err(Failed | CantOpenChecksumFile) => failed = true,
			Ok(()) => (),
		}
	}
	if failed { Err(Failure(String::new())) } else { Ok(()) }
}



