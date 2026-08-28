



use std::{
	ffi::OsString,
	fs::File,
	io::{self, Read, Seek, SeekFrom, Write},
	num::TryFromIntError,
	path::PathBuf,
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::ArgMatches;
use memchr::memrchr_iter;
use thiserror::Error;
use uucore::{display::Quotable, line_ending::LineEnding};

use crate::host::{Host, Utility, matches_parser, util};

const BUF_SIZE: usize = 65536;

mod cli {


use std::ffi::OsString;

use clap::{Arg, ArgAction, Command};
use crate::host::format_usage;

pub(super) mod options {
	pub const BYTES: &str = "BYTES";
	pub const LINES: &str = "LINES";
	pub const QUIET: &str = "QUIET";
	pub const VERBOSE: &str = "VERBOSE";
	pub const ZERO: &str = "ZERO";
	pub const FILES: &str = "FILE";
	pub const PRESUME_INPUT_PIPE: &str = "-PRESUME-INPUT-PIPE";
}

pub(super) fn uu_app() -> Command {
	Command::new("head")
		.version("0.8.0")
		.about(
			"Print the first 10 lines of each FILE to standard output.\nWith more than one FILE, \
			 precede each with a header giving the file name.\nWith no FILE, or when FILE is -, read \
			 standard input.",
		)
		.override_usage(format_usage("head [FLAG]... [FILE]..."))
		.infer_long_args(true)
		.arg(
			Arg::new(options::BYTES)
				.short('c')
				.long("bytes")
				.value_name("[-]NUM")
				.help(
					"print the first NUM bytes of each file;\nwith a leading '-', print all but the \
					 last\nNUM bytes of each file",
				)
				.overrides_with_all([options::BYTES, options::LINES])
				.allow_hyphen_values(true),
		)
		.arg(
			Arg::new(options::LINES)
				.short('n')
				.long("lines")
				.value_name("[-]NUM")
				.help(
					"print the first NUM lines instead of the first 10;\nwith a leading '-', print all \
					 but the last\nNUM lines of each file",
				)
				.overrides_with_all([options::LINES, options::BYTES])
				.allow_hyphen_values(true),
		)
		.arg(
			Arg::new(options::QUIET)
				.short('q')
				.long("quiet")
				.visible_alias("silent")
				.help("never print headers giving file names")
				.overrides_with_all([options::VERBOSE, options::QUIET])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::VERBOSE)
				.short('v')
				.long("verbose")
				.help("always print headers giving file names")
				.overrides_with_all([options::QUIET, options::VERBOSE])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::PRESUME_INPUT_PIPE)
				.long("presume-input-pipe")
				.alias("-presume-input-pipe")
				.hide(true)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::ZERO)
				.short('z')
				.long("zero-terminated")
				.help("line delimiter is NUL, not newline")
				.overrides_with(options::ZERO)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::FILES)
				.action(ArgAction::Append)
				.value_parser(clap::value_parser!(OsString))
				.value_hint(clap::ValueHint::FilePath),
		)
}
}

use cli::{options, uu_app};

mod parse {


use std::ffi::OsString;

use uucore::parser::{
	parse_signed_num::{SignPrefix, parse_signed_num_max},
	parse_size::ParseSizeError,
};

#[derive(PartialEq, Eq, Debug)]
pub(super) struct ParseError;


pub(super) fn parse_obsolete(src: &str) -> Option<Result<Vec<OsString>, ParseError>> {
	let mut chars = src.char_indices();
	if let Some((mut num_start, '-')) = chars.next() {
		num_start += 1;
		let mut num_end = src.len();
		let mut has_num = false;
		let mut plus_possible = false;
		let mut last_char = 0 as char;
		for (n, c) in &mut chars {
			if c.is_ascii_digit() {
				has_num = true;
				plus_possible = false;
			} else if c == '+' && plus_possible {
				plus_possible = false;
				num_start += 1;
			} else {
				num_end = n;
				last_char = c;
				break;
			}
		}
		if has_num {
			Some(process_num_block(&src[num_start..num_end], last_char, &mut chars))
		} else {
			None
		}
	} else {
		None
	}
}



fn process_num_block(
	src: &str,
	last_char: char,
	chars: &mut std::str::CharIndices,
) -> Result<Vec<OsString>, ParseError> {
	let num = match src.parse::<usize>() {
		Ok(n) => n,
		Err(e) if *e.kind() == std::num::IntErrorKind::PosOverflow => usize::MAX,
		_ => return Err(ParseError),
	};
	let mut quiet = false;
	let mut verbose = false;
	let mut zero_terminated = false;



	let mut multiplier = None;
	let mut line_multiplier: usize = 1;
	let mut c = last_char;
	loop {
		match c {


			'q' => {
				quiet = true;
				verbose = false;
			},
			'v' => {
				verbose = true;
				quiet = false;
			},
			'z' => zero_terminated = true,
			'c' => multiplier = Some(1),
			'b' => multiplier = Some(512),
			'k' => multiplier = Some(1024),
			'm' => multiplier = Some(1024 * 1024),
			'K' => {
				line_multiplier = 1024;
				multiplier = None;
			},
			'M' => {
				line_multiplier = 1024 * 1024;
				multiplier = None;
			},
			'G' => {
				line_multiplier = 1024 * 1024 * 1024;
				multiplier = None;
			},
			'\0' => {},
			_ => return Err(ParseError),
		}
		if let Some((_, next)) = chars.next() {
			c = next;
		} else {
			break;
		}
	}
	let mut options = Vec::new();
	if quiet {
		options.push(OsString::from("-q"));
	}
	if verbose {
		options.push(OsString::from("-v"));
	}
	if zero_terminated {
		options.push(OsString::from("-z"));
	}
	if let Some(n) = multiplier {
		options.push(OsString::from("-c"));
		let num = num.saturating_mul(n);
		options.push(OsString::from(format!("{num}")));
	} else {
		options.push(OsString::from("-n"));
		let num = num.saturating_mul(line_multiplier);
		options.push(OsString::from(format!("{num}")));
	}
	Ok(options)
}



pub(super) fn parse_num(src: &str) -> Result<(u64, bool), ParseSizeError> {
	let result = parse_signed_num_max(src)?;

	let all_but_last = result.sign == Some(SignPrefix::Minus);
	Ok((result.value, all_but_last))
}


}

mod take {


use std::{
	collections::VecDeque,
	io::{ErrorKind, Read, Write},
};

use memchr::memchr_iter;

const BUF_SIZE: usize = 65536;

struct TakeAllBuffer {
	buffer:      Vec<u8>,
	start_index: usize,
}

impl TakeAllBuffer {
	fn new() -> Self {
		Self { buffer: vec![], start_index: 0 }
	}

	fn fill_buffer(&mut self, reader: &mut impl Read) -> std::io::Result<usize> {
		self.buffer.resize(BUF_SIZE, 0);
		self.start_index = 0;
		loop {
			match reader.read(&mut self.buffer[..]) {
				Ok(n) => {
					self.buffer.truncate(n);
					return Ok(n);
				},
				Err(e) if e.kind() == ErrorKind::Interrupted => (),
				Err(e) => return Err(e),
			}
		}
	}

	fn write_bytes_exact(&mut self, writer: &mut impl Write, bytes: usize) -> std::io::Result<()> {
		let buffer_to_write = &self.remaining_buffer()[..bytes];
		writer.write_all(buffer_to_write)?;
		self.start_index += bytes;
		assert!(self.start_index <= self.buffer.len());
		Ok(())
	}

	fn write_all(&mut self, writer: &mut impl Write) -> std::io::Result<usize> {
		let remaining_bytes = self.remaining_bytes();
		self.write_bytes_exact(writer, remaining_bytes)?;
		Ok(remaining_bytes)
	}

	fn write_bytes_limit(
		&mut self,
		writer: &mut impl Write,
		max_bytes: usize,
	) -> std::io::Result<usize> {
		let bytes_to_write = self.remaining_bytes().min(max_bytes);
		self.write_bytes_exact(writer, bytes_to_write)?;
		Ok(bytes_to_write)
	}

	fn remaining_buffer(&self) -> &[u8] {
		&self.buffer[self.start_index..]
	}

	fn remaining_bytes(&self) -> usize {
		self.remaining_buffer().len()
	}

	fn is_empty(&self) -> bool {
		assert!(self.start_index <= self.buffer.len());
		self.start_index == self.buffer.len()
	}
}

















pub(super) fn copy_all_but_n_bytes(
	reader: &mut impl Read,
	writer: &mut impl Write,
	n: usize,
) -> std::io::Result<usize> {
	let mut buffers: VecDeque<TakeAllBuffer> = VecDeque::new();
	let mut empty_buffer_pool: Vec<TakeAllBuffer> = vec![];
	let mut buffered_bytes: usize = 0;
	let mut total_bytes_copied = 0;
	loop {
		loop {

			let front_buffer = buffers.front();
			if let Some(front_buffer) = front_buffer
				&& buffered_bytes >= n + front_buffer.remaining_bytes()
			{
				break;
			}
			let mut new_buffer = empty_buffer_pool.pop().unwrap_or_else(TakeAllBuffer::new);
			let filled_bytes = new_buffer.fill_buffer(reader)?;
			if filled_bytes == 0 {

				break;
			}
			buffers.push_back(new_buffer);
			buffered_bytes += filled_bytes;
		}


		if buffered_bytes <= n {
			break;
		}

		let excess_buffered_bytes = buffered_bytes - n;


		let front_buffer = buffers.front_mut().unwrap();
		let bytes_written = front_buffer.write_bytes_limit(writer, excess_buffered_bytes)?;
		buffered_bytes -= bytes_written;
		total_bytes_copied += bytes_written;


		if front_buffer.is_empty() {
			empty_buffer_pool.push(buffers.pop_front().unwrap());
		}
	}
	Ok(total_bytes_copied)
}

struct TakeAllLinesBuffer {
	inner:            TakeAllBuffer,
	terminated_lines: usize,
	partial_line:     bool,
}

struct BytesAndLines {
	bytes:            usize,
	terminated_lines: usize,
}

impl TakeAllLinesBuffer {
	fn new() -> Self {
		Self { inner: TakeAllBuffer::new(), terminated_lines: 0, partial_line: false }
	}

	fn fill_buffer(
		&mut self,
		reader: &mut impl Read,
		separator: u8,
	) -> std::io::Result<BytesAndLines> {
		self.partial_line = false;
		let bytes_read = self.inner.fill_buffer(reader)?;

		self.terminated_lines = memchr_iter(separator, self.inner.remaining_buffer()).count();
		if let Some(last_char) = self.inner.remaining_buffer().last()
			&& *last_char != separator
		{
			self.partial_line = true;
		}
		Ok(BytesAndLines { bytes: bytes_read, terminated_lines: self.terminated_lines })
	}

	fn write_lines(
		&mut self,
		writer: &mut impl Write,
		max_lines: usize,
		separator: u8,
	) -> std::io::Result<BytesAndLines> {
		assert!(max_lines > 0, "Must request at least 1 line.");
		let ret;
		if max_lines > self.terminated_lines {
			ret = BytesAndLines {
				bytes:            self.inner.write_all(writer)?,
				terminated_lines: self.terminated_lines,
			};
			self.terminated_lines = 0;
		} else {
			let index = memchr_iter(separator, self.inner.remaining_buffer()).nth(max_lines - 1);
			assert!(
				index.is_some(),
				"Somehow we're being asked to write more lines than we have, that's a bug in \
				 copy_all_but_lines."
			);
			let index = index.unwrap();


			let bytes_to_write = index + 1;
			self.inner.write_bytes_exact(writer, bytes_to_write)?;
			ret = BytesAndLines { bytes: bytes_to_write, terminated_lines: max_lines };
			self.terminated_lines -= max_lines;
		}
		Ok(ret)
	}

	fn is_empty(&self) -> bool {
		self.inner.is_empty()
	}

	fn terminated_lines(&self) -> usize {
		self.terminated_lines
	}

	fn partial_line(&self) -> bool {
		self.partial_line
	}
}

























pub(super) fn copy_all_but_n_lines<R: Read, W: Write>(
	mut reader: R,
	writer: &mut W,
	n: usize,
	separator: u8,
) -> std::io::Result<usize> {

	assert!(n > 0);
	let mut buffers: VecDeque<TakeAllLinesBuffer> = VecDeque::new();
	let mut buffered_terminated_lines: usize = 0;
	let mut empty_buffers = vec![];
	let mut total_bytes_copied = 0;
	loop {

		loop {


			let front_buffer = buffers.front();
			if let Some(front_buffer) = front_buffer
				&& buffered_terminated_lines > n + front_buffer.terminated_lines()
			{
				break;
			}

			let mut new_buffer = empty_buffers.pop().unwrap_or_else(TakeAllLinesBuffer::new);
			let fill_result = new_buffer.fill_buffer(&mut reader, separator)?;
			if fill_result.bytes == 0 {

				break;
			}
			buffered_terminated_lines += fill_result.terminated_lines;
			buffers.push_back(new_buffer);
		}


		if buffered_terminated_lines < n
			|| (buffered_terminated_lines == n && !buffers.back().unwrap().partial_line())
		{
			break;
		}

		let excess_buffered_terminated_lines = buffered_terminated_lines - n;


		let lines_to_write = if buffers.back().unwrap().partial_line() {
			excess_buffered_terminated_lines + 1
		} else {
			excess_buffered_terminated_lines
		};
		let front_buffer = buffers.front_mut().unwrap();
		let write_result = front_buffer.write_lines(writer, lines_to_write, separator)?;
		buffered_terminated_lines -= write_result.terminated_lines;
		total_bytes_copied += write_result.bytes;


		if front_buffer.is_empty() {
			empty_buffers.push(buffers.pop_front().unwrap());
		}
	}
	Ok(total_bytes_copied)
}






pub(super) struct TakeLines<T> {
	inner:     T,
	limit:     u64,
	separator: u8,
}

impl<T: Read> Read for TakeLines<T> {

	fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
		if self.limit == 0 {
			return Ok(0);
		}
		match self.inner.read(buf) {
			Ok(0) => Ok(0),
			Ok(n) => {
				for i in memchr_iter(self.separator, &buf[..n]) {
					self.limit -= 1;
					if self.limit == 0 {
						return Ok(i + 1);
					}
				}
				Ok(n)
			},
			Err(e) => Err(e),
		}
	}
}









pub(super) fn take_lines<R>(reader: R, limit: u64, separator: u8) -> TakeLines<R> {
	TakeLines { inner: reader, limit, separator }
}


}

use take::{copy_all_but_n_bytes, copy_all_but_n_lines, take_lines};

#[derive(Error, Debug)]
enum HeadError {

	#[error("error reading {}: {}", name.quote(), err)]
	Io { name: PathBuf, err: io::Error },

	#[error("{0}")]
	ParseError(String),

	#[error("number of -bytes or -lines is too large")]
	NumTooLarge(#[from] TryFromIntError),


	#[error("{0}")]
	MatchOption(String),
}

type HeadResult<T> = Result<T, HeadError>;

#[derive(Debug, PartialEq)]
enum Mode {
	FirstLines(u64),
	AllButLastLines(u64),
	FirstBytes(u64),
	AllButLastBytes(u64),
}

impl Default for Mode {
	fn default() -> Self {
		Self::FirstLines(10)
	}
}

impl Mode {
	fn from(matches: &ArgMatches) -> Result<Self, String> {
		if let Some(v) = matches.get_one::<String>(options::BYTES) {
			let (n, all_but_last) =
				parse::parse_num(v).map_err(|err| format!("invalid number of bytes: {err}"))?;
			if all_but_last {
				Ok(Self::AllButLastBytes(n))
			} else {
				Ok(Self::FirstBytes(n))
			}
		} else if let Some(v) = matches.get_one::<String>(options::LINES) {
			let (n, all_but_last) =
				parse::parse_num(v).map_err(|err| format!("invalid number of lines: {err}"))?;
			if all_but_last {
				Ok(Self::AllButLastLines(n))
			} else {
				Ok(Self::FirstLines(n))
			}
		} else {
			Ok(Self::default())
		}
	}
}




fn consumes_separate_value(token: &str) -> bool {
	if let Some(long) = token.strip_prefix("--") {
		if long.is_empty() || long.contains('=') {
			return false;
		}

		return ["lines", "bytes"].iter().any(|name| name.starts_with(long));
	}
	let Some(cluster) = token.strip_prefix('-') else {
		return false;
	};
	let mut chars = cluster.chars();
	while let Some(c) = chars.next() {
		match c {


			'n' | 'c' => return chars.next().is_none(),
			'q' | 'v' | 'z' => {},
			_ => return false,
		}
	}
	false
}




fn arg_iterate(argv: Vec<OsString>) -> HeadResult<Vec<OsString>> {
	let mut rewritten = Vec::with_capacity(argv.len() + 1);
	let mut iter = argv.into_iter();

	rewritten.extend(iter.next());
	let mut skip_value = false;
	let mut seen_ddash = false;
	for arg in iter {
		if skip_value || seen_ddash {
			skip_value = false;
			rewritten.push(arg);
			continue;
		}
		let Some(token) = arg.to_str() else {


			rewritten.push(arg);
			continue;
		};
		if token == "--" {
			seen_ddash = true;
			rewritten.push(arg);
			continue;
		}
		if matches!(token.as_bytes(), [b'-', b'0'..=b'9', ..]) {
			match parse::parse_obsolete(token) {
				Some(Ok(options)) => {
					rewritten.extend(options);
					continue;
				},
				Some(Err(parse::ParseError)) => {
					return Err(HeadError::ParseError(format!(
						"bad argument format: {}",
						token.quote()
					)));
				},
				None => {},
			}
		}
		if token.len() > 1 && token.starts_with('-') {
			skip_value = consumes_separate_value(token);
		}
		rewritten.push(arg);
	}
	Ok(rewritten)
}

#[derive(Debug, PartialEq, Default)]
struct HeadOptions {
	pub quiet:              bool,
	pub verbose:            bool,
	pub line_ending:        LineEnding,
	pub presume_input_pipe: bool,
	pub mode:               Mode,
	pub files:              Vec<OsString>,
}

impl HeadOptions {

	pub fn get_from(matches: &ArgMatches) -> Result<Self, String> {
		let mut options = Self::default();

		options.quiet = matches.get_flag(options::QUIET);
		options.verbose = matches.get_flag(options::VERBOSE);
		options.line_ending = LineEnding::from_zero_flag(matches.get_flag(options::ZERO));
		options.presume_input_pipe = matches.get_flag(options::PRESUME_INPUT_PIPE);

		options.mode = Mode::from(matches)?;

		options.files = match matches.get_many::<OsString>(options::FILES) {
			Some(v) => v.cloned().collect(),
			None => vec![OsString::from("-")],
		};

		Ok(options)
	}
}

#[inline]
fn wrap_in_stdout_error(err: io::Error) -> io::Error {
	io::Error::new(err.kind(), format!("error writing 'standard output': {err}"))
}


fn read_n_bytes(input: impl Read, output: &mut impl Write, n: u64) -> io::Result<u64> {
	let mut reader = input.take(n);
	let bytes_written = io::copy(&mut reader, output).map_err(wrap_in_stdout_error)?;
	output.flush().map_err(wrap_in_stdout_error)?;
	Ok(bytes_written)
}

fn read_n_lines(
	input: &mut impl io::BufRead,
	output: &mut impl Write,
	n: u64,
	separator: u8,
) -> io::Result<u64> {
	let mut reader = take_lines(input, n, separator);
	let bytes_written = io::copy(&mut reader, output).map_err(wrap_in_stdout_error)?;
	output.flush().map_err(wrap_in_stdout_error)?;
	Ok(bytes_written)
}

fn catch_too_large_numbers_in_backwards_bytes_or_lines(n: u64) -> Option<usize> {
	usize::try_from(n).ok()
}

fn read_but_last_n_bytes(mut input: impl Read, output: &mut impl Write, n: u64) -> io::Result<u64> {
	let mut bytes_written: u64 = 0;
	if let Some(n) = catch_too_large_numbers_in_backwards_bytes_or_lines(n) {
		bytes_written = copy_all_but_n_bytes(&mut input, output, n)
			.map_err(wrap_in_stdout_error)?
			.try_into()
			.unwrap();




		output.flush().map_err(wrap_in_stdout_error)?;
	}
	Ok(bytes_written)
}

fn read_but_last_n_lines(mut input: impl Read, output: &mut impl Write, n: u64, separator: u8) -> io::Result<u64> {
	if n == 0 {
		return io::copy(&mut input, output).map_err(wrap_in_stdout_error);
	}
	let mut bytes_written: u64 = 0;
	if let Some(n) = catch_too_large_numbers_in_backwards_bytes_or_lines(n) {
		bytes_written = copy_all_but_n_lines(input, output, n, separator)
			.map_err(wrap_in_stdout_error)?
			.try_into()
			.unwrap();



		output.flush().map_err(wrap_in_stdout_error)?;
	}
	Ok(bytes_written)
}


































fn find_nth_line_from_end<R>(input: &mut R, n: u64, separator: u8) -> io::Result<u64>
where
	R: Read + Seek,
{
	let file_size = input.seek(SeekFrom::End(0))?;

	let mut buffer = [0u8; BUF_SIZE];

	let mut lines = 0u64;
	let mut check_last_byte_first_loop = true;
	let mut bytes_remaining_to_search = file_size;

	loop {

		let bytes_to_read_this_loop = bytes_remaining_to_search.min(buffer.len().try_into().unwrap());
		let read_start_offset = bytes_remaining_to_search - bytes_to_read_this_loop;
		let buffer = &mut buffer[..bytes_to_read_this_loop.try_into().unwrap()];
		bytes_remaining_to_search -= bytes_to_read_this_loop;

		input.seek(SeekFrom::Start(read_start_offset))?;
		input.read_exact(buffer)?;






		if check_last_byte_first_loop {
			check_last_byte_first_loop = false;
			if let Some(last_byte_of_file) = buffer.last()
				&& last_byte_of_file != &separator
			{
				if n == 0 {
					input.rewind()?;
					return Ok(file_size);
				}
				assert_eq!(lines, 0);
				lines = 1;
			}
		}

		for separator_offset in memrchr_iter(separator, &buffer[..]) {
			lines += 1;
			if lines == n + 1 {
				input.rewind()?;
				return Ok(read_start_offset + TryInto::<u64>::try_into(separator_offset).unwrap() + 1);
			}
		}
		if read_start_offset == 0 {
			input.rewind()?;
			return Ok(0);
		}
	}
}

fn is_seekable(input: &mut File) -> bool {
	let current_pos = input.stream_position();
	current_pos.is_ok()
		&& input.seek(SeekFrom::End(0)).is_ok()
		&& input.seek(SeekFrom::Start(current_pos.unwrap())).is_ok()
}

fn head_backwards_file(input: &mut File, output: &mut impl Write, options: &HeadOptions) -> io::Result<u64> {
	let st = input.metadata()?;
	let seekable = is_seekable(input);
	let blksize_limit = uucore::fs::sane_blksize::sane_blksize_from_metadata(&st);
	if !seekable || st.len() <= blksize_limit || options.presume_input_pipe {
		head_backwards_without_seek_file(input, output, options)
	} else {
		head_backwards_on_seekable_file(input, output, options)
	}
}

fn head_backwards_without_seek_file(input: &mut File, output: &mut impl Write, options: &HeadOptions) -> io::Result<u64> {
	match options.mode {
		Mode::AllButLastBytes(n) => read_but_last_n_bytes(input, output, n),
		Mode::AllButLastLines(n) => read_but_last_n_lines(input, output, n, options.line_ending.into()),
		_ => unreachable!(),
	}
}

fn head_backwards_on_seekable_file(input: &mut File, output: &mut impl Write, options: &HeadOptions) -> io::Result<u64> {
	match options.mode {
		Mode::AllButLastBytes(n) => {
			let size = input.metadata()?.len();
			if n >= size {
				Ok(0)
			} else {
				read_n_bytes(input, output, size - n)
			}
		},
		Mode::AllButLastLines(n) => {
			let found = find_nth_line_from_end(input, n, options.line_ending.into())?;
			read_n_bytes(input, output, found)
		},
		_ => unreachable!(),
	}
}

fn head_file(input: &mut File, output: &mut impl Write, options: &HeadOptions) -> io::Result<u64> {
	match options.mode {
		Mode::FirstBytes(n) => read_n_bytes(input, output, n),
		Mode::FirstLines(n) => read_n_lines(
			&mut io::BufReader::with_capacity(BUF_SIZE, input),
			output,
			n,
			options.line_ending.into(),
		),
		Mode::AllButLastBytes(_) | Mode::AllButLastLines(_) => head_backwards_file(input, output, options),
	}
}


pub(crate) struct Head {
	matches: ArgMatches,
}

matches_parser!(Head, uu_app);

impl Utility for Head {
	const NAME: &'static str = "head";


	fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		arg_iterate(argv).map_err(|err| err.to_string())
	}


	fn run(self, host: &mut Host) -> i32 {
		let options = match HeadOptions::get_from(&self.matches) {
			Ok(options) => options,
			Err(err) => {
				host.error(HeadError::MatchOption(err), 1);
				return 1;
			},
		};

		let print_headers = (options.files.len() > 1 && !options.quiet) || options.verbose;



		let mut first = true;
		fn print_header(out: &mut impl Write, name: &[u8], first: &mut bool) {
			if !*first {
				let _ = writeln!(out);
			}
			let _ = out.write_all(b"==> ");
			let _ = out.write_all(name);
			let _ = out.write_all(b" <==\n");
			*first = false;
		}
		let mut out = host.stdout_writer();
		for file in &options.files {
			let result = if file == "-" {
				if print_headers {
					print_header(&mut out, b"standard input", &mut first);
				}
				let mut input = io::BufReader::with_capacity(BUF_SIZE, &mut host.stdin);
				match options.mode {
					Mode::FirstBytes(n) => read_n_bytes(&mut input, &mut out, n),
					Mode::AllButLastBytes(n) => {
						read_but_last_n_bytes(&mut input, &mut out, n)
					},
					Mode::FirstLines(n) => {
						read_n_lines(&mut input, &mut out, n, options.line_ending.into())
					},
					Mode::AllButLastLines(n) => read_but_last_n_lines(
						&mut input,
						&mut out,
						n,
						options.line_ending.into(),
					),
				}
			} else {
				let resolved = host.resolve(file);
				if resolved.is_dir() {


					if print_headers {
						print_header(&mut out, file.as_encoded_bytes(), &mut first);
					}
					host.error(format!("error reading {}: Is a directory", file.quote()), 1);
					continue;
				}
				let mut input = match File::open(&resolved) {
					Ok(input) => input,
					Err(err) => {
						host.error(format!("cannot open {} for reading: {err}", file.quote()), 1);
						continue;
					},
				};
				if print_headers {
					print_header(&mut out, file.as_encoded_bytes(), &mut first);
				}
				head_file(&mut input, &mut out, &options)
			};
			if let Err(err) = result {
				let name = if file == "-" {
					PathBuf::from("standard input")
				} else {
					PathBuf::from(file)
				};


				let broken_pipe = err.kind() == io::ErrorKind::BrokenPipe;
				host.error(HeadError::Io { name, err }, 1);
				if broken_pipe {
					return 1;
				}
			}
		}
		if let Err(err) = out.flush() {
			host.error(wrap_in_stdout_error(err), 1);
		}
		host.exit_code()
	}
}


pub(crate) fn head_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Head, SE>()
}


