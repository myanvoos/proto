use std::{
	collections::VecDeque,
	io::{Read, Write},
	time::{Duration, Instant},
};

use brush_core::{ErrorKind, builtins, env, error, variables};
use clap::Parser;
use itertools::Itertools;



const TIMEOUT_EXIT_CODE: u8 = 142;


const CTRL_C: char = '\x03';

const CTRL_D: char = '\x04';

const BACKSLASH: char = '\\';

const DEFAULT_DELIMITER: char = '\n';

const NUL_DELIMITER: char = '\0';


#[derive(Parser)]
pub(crate) struct ReadCommand {


	#[clap(short = 'a', value_name = "VAR_NAME")]
	array_variable: Option<String>,


	#[clap(short = 'd')]
	delimiter: Option<String>,


	#[clap(short = 'e')]
	use_readline: bool,


	#[clap(short = 'i', value_name = "STR")]
	initial_text: Option<String>,



	#[clap(short = 'n', value_name = "COUNT")]
	return_after_n_chars: Option<usize>,


	#[clap(short = 'N', value_name = "COUNT")]
	return_after_n_chars_no_delimiter: Option<usize>,


	#[clap(short = 'p')]
	prompt: Option<String>,


	#[clap(short = 'r')]
	raw_mode: bool,


	#[clap(short = 's')]
	silent: bool,



	#[clap(short = 't', value_name = "SECONDS", allow_hyphen_values = true)]
	timeout_in_seconds: Option<f64>,


	#[clap(short = 'u', name = "FD")]
	fd_num_to_read: Option<u8>,


	variable_names: Vec<String>,
}

impl builtins::Command for ReadCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {


		if let Some(result) = self.validate_timeout(&context)? {
			return Ok(result);
		}


		let fd_num = self
			.fd_num_to_read
			.map_or(brush_core::openfiles::OpenFiles::STDIN_FD, brush_core::ShellFd::from);


		let input_stream = context
			.try_fd(fd_num)
			.ok_or_else(|| ErrorKind::BadFileDescriptor(fd_num))?;




		if self.use_readline && input_stream.is_terminal() {
			return error::unimp(if self.initial_text.is_some() {
				"read -e -i"
			} else {
				"read -e"
			});
		}




		let ifs = context.shell.ifs().into_owned();


		let timeout = self.timeout_in_seconds.map(Duration::from_secs_f64);


		let read_result =
			self.read_line(input_stream, context.stderr(), timeout, || context.is_cancelled())?;


		let skip_ifs_splitting = self.return_after_n_chars_no_delimiter.is_some();


		let (input_line, result) = match &read_result {
			ReadResult::Line(line) => (Some(line.clone()), brush_core::ExecutionResult::success()),
			ReadResult::Eof(Some(line)) => {
				(Some(line.clone()), brush_core::ExecutionResult::general_error())
			},
			ReadResult::Eof(None) | ReadResult::Interrupted | ReadResult::InputNotReady => {
				(None, brush_core::ExecutionResult::general_error())
			},
			ReadResult::TimedOut(partial) => {
				(partial.clone(), brush_core::ExecutionResult::new(TIMEOUT_EXIT_CODE))
			},
			ReadResult::InputReady => (None, brush_core::ExecutionResult::success()),
		};


		assign_input_to_variables(
			context.shell,
			input_line.as_deref(),
			&ifs,
			skip_ifs_splitting,
			self.array_variable.as_deref(),
			&self.variable_names,
		)?;

		Ok(result)
	}
}








fn assign_input_to_variables(
	shell: &mut brush_core::Shell<impl brush_core::ShellExtensions>,
	input_line: Option<&str>,
	ifs: &str,
	skip_ifs_splitting: bool,
	array_variable: Option<&str>,
	variable_names: &[String],
) -> Result<(), brush_core::Error> {
	if let Some(array_variable) = array_variable {
		let literal_fields = build_array_fields(input_line, ifs, skip_ifs_splitting);
		shell.env_mut().update_or_add(
			array_variable,
			variables::ShellValueLiteral::Array(variables::ArrayLiteral(literal_fields)),
			|_| Ok(()),
			env::EnvironmentLookup::Anywhere,
			env::EnvironmentScope::Global,
		)?;
	} else if !variable_names.is_empty() {
		assign_to_named_variables(shell, input_line, ifs, skip_ifs_splitting, variable_names)?;
	} else {
		shell.env_mut().update_or_add(
			"REPLY",
			variables::ShellValueLiteral::Scalar(input_line.unwrap_or_default().to_owned()),
			|_| Ok(()),
			env::EnvironmentLookup::Anywhere,
			env::EnvironmentScope::Global,
		)?;
	}
	Ok(())
}






fn assign_to_named_variables(
	shell: &mut brush_core::Shell<impl brush_core::ShellExtensions>,
	input_line: Option<&str>,
	ifs: &str,
	skip_ifs_splitting: bool,
	variable_names: &[String],
) -> Result<(), brush_core::Error> {
	let mut fields =
		build_variable_fields(input_line, ifs, skip_ifs_splitting, variable_names.len());

	for (i, name) in variable_names.iter().enumerate() {
		let is_last = i == variable_names.len() - 1;

		let value = if fields.is_empty() {
			String::new()
		} else if is_last {

			std::mem::take(&mut fields).into_iter().join(" ")
		} else {
			fields.pop_front().unwrap_or_default()
		};

		shell.env_mut().update_or_add(
			name,
			variables::ShellValueLiteral::Scalar(value),
			|_| Ok(()),
			env::EnvironmentLookup::Anywhere,
			env::EnvironmentScope::Global,
		)?;

		if is_last {
			break;
		}
	}
	Ok(())
}


fn build_array_fields(
	input_line: Option<&str>,
	ifs: &str,
	skip_ifs_splitting: bool,
) -> Vec<(Option<String>, String)> {
	match input_line {
		Some(line) if skip_ifs_splitting => {

			vec![(None, line.to_string())]
		},
		Some(line) => {
			let fields: VecDeque<_> = split_line_by_ifs(ifs, line, None );
			fields.into_iter().map(|f| (None, f)).collect()
		},
		None => vec![],
	}
}


fn build_variable_fields(
	input_line: Option<&str>,
	ifs: &str,
	skip_ifs_splitting: bool,
	num_variables: usize,
) -> VecDeque<String> {
	match input_line {
		Some(line) if skip_ifs_splitting => {

			let mut fields = VecDeque::new();
			fields.push_back(line.to_string());
			fields
		},
		Some(line) => split_line_by_ifs(ifs, line, Some(num_variables)),
		None => VecDeque::new(),
	}
}





#[derive(Debug)]
enum ReadResult {

	Line(String),

	Eof(Option<String>),

	Interrupted,


	TimedOut(Option<String>),

	InputReady,

	InputNotReady,
}






struct InputReader {

	input:      brush_core::openfiles::OpenFile,

	deadline:   Option<Instant>,








	buffer:     [u8; 1],






	_term_mode: Option<brush_core::terminal::AutoModeGuard>,
}


enum InputEvent {

	Char(char),

	Eof,

	Timeout,

	CtrlC,

	CtrlD,
}

fn ensure_not_cancelled<F>(is_cancelled: &F) -> Result<(), brush_core::Error>
where
	F: Fn() -> bool,
{
	if is_cancelled() {
		return Err(ErrorKind::Interrupted.into());
	}

	Ok(())
}

impl InputReader {

	fn new(
		input: brush_core::openfiles::OpenFile,
		timeout: Option<Duration>,
		term_mode: Option<brush_core::terminal::AutoModeGuard>,
	) -> Self {
		Self {
			input,
			deadline: timeout.map(|t| Instant::now() + t),
			buffer: [0; 1],
			_term_mode: term_mode,
		}
	}



	fn check_input_available(&self) -> bool {
		brush_core::sys::poll::poll_for_input(&self.input, Duration::ZERO).unwrap_or(false)
	}

	#[cfg(unix)]
	fn wait_for_input<F>(&self, is_cancelled: &F) -> Result<Option<InputEvent>, brush_core::Error>
	where
		F: Fn() -> bool,
	{
		const INPUT_POLL_INTERVAL_MS: u64 = 100;

		if self.deadline.is_none() && self.input.try_borrow_as_fd().is_err() {
			ensure_not_cancelled(is_cancelled)?;
			return Ok(None);
		}

		loop {
			ensure_not_cancelled(is_cancelled)?;

			let timeout = if let Some(deadline) = self.deadline {
				let remaining = deadline.saturating_duration_since(Instant::now());
				if remaining.is_zero() {
					return Ok(Some(InputEvent::Timeout));
				}

				remaining.min(Duration::from_millis(INPUT_POLL_INTERVAL_MS))
			} else {
				Duration::from_millis(INPUT_POLL_INTERVAL_MS)
			};

			match brush_core::sys::poll::poll_for_input(&self.input, timeout) {
				Ok(true) => return Ok(None),
				Ok(false) => continue,
				Err(e) => return Err(e.into()),
			}
		}
	}

	#[cfg(not(unix))]
	fn wait_for_input<F>(&self, is_cancelled: &F) -> Result<Option<InputEvent>, brush_core::Error>
	where
		F: Fn() -> bool,
	{
		ensure_not_cancelled(is_cancelled)?;

		if let Some(deadline) = self.deadline {
			let remaining = deadline.saturating_duration_since(Instant::now());
			if remaining.is_zero() {
				return Ok(Some(InputEvent::Timeout));
			}

			match brush_core::sys::poll::poll_for_input(&self.input, remaining) {
				Ok(true) => {},
				Ok(false) => return Ok(Some(InputEvent::Timeout)),
				Err(e) => return Err(e.into()),
			}
		}

		Ok(None)
	}


	fn read_event<F>(&mut self, is_cancelled: &F) -> Result<InputEvent, brush_core::Error>
	where
		F: Fn() -> bool,
	{
		if let Some(event) = self.wait_for_input(is_cancelled)? {
			return Ok(event);
		}

		ensure_not_cancelled(is_cancelled)?;

		let n = self.input.read(&mut self.buffer)?;
		if n == 0 {
			return Ok(InputEvent::Eof);
		}

		let ch = self.buffer[0] as char;


		Ok(match ch {
			CTRL_C => InputEvent::CtrlC,
			CTRL_D => InputEvent::CtrlD,
			_ => InputEvent::Char(ch),
		})
	}
}


struct LineReaderConfig {

	delimiter:       Option<char>,

	char_limit:      Option<usize>,

	process_escapes: bool,
}











fn read_line_with_reader<F>(
	reader: &mut InputReader,
	config: &LineReaderConfig,
	is_cancelled: &F,
) -> Result<ReadResult, brush_core::Error>
where
	F: Fn() -> bool,
{
	let mut line = String::new();
	let mut pending_backslash = false;

	loop {
		let event = reader.read_event(is_cancelled)?;

		match event {
			InputEvent::Eof => {

				return Ok(ReadResult::Eof(if line.is_empty() { None } else { Some(line) }));
			},

			InputEvent::Timeout => {

				if pending_backslash {
					line.push(BACKSLASH);
				}
				return Ok(ReadResult::TimedOut(if line.is_empty() { None } else { Some(line) }));
			},

			InputEvent::CtrlC => {
				return Ok(ReadResult::Interrupted);
			},

			InputEvent::CtrlD => {


				return Ok(if line.is_empty() && !pending_backslash {
					ReadResult::Eof(None)
				} else {
					ReadResult::Line(line)
				});
			},

			InputEvent::Char(ch) => {

				if config.process_escapes {
					if pending_backslash {
						pending_backslash = false;


						if let Some(delim) = config.delimiter
							&& ch == delim
						{
							continue;
						}


						line.push(ch);


						if let Some(limit) = config.char_limit
							&& line.len() >= limit
						{
							return Ok(ReadResult::Line(line));
						}
						continue;
					}

					if ch == BACKSLASH {
						pending_backslash = true;
						continue;
					}
				}


				if let Some(delim) = config.delimiter
					&& ch == delim
				{
					return Ok(ReadResult::Line(line));
				}


				if ch.is_ascii_control() && !ch.is_ascii_whitespace() {
					continue;
				}

				line.push(ch);


				if let Some(limit) = config.char_limit
					&& line.len() >= limit
				{
					return Ok(ReadResult::Line(line));
				}
			},
		}
	}
}

impl ReadCommand {






	fn read_line<F>(
		&self,
		input_file: brush_core::openfiles::OpenFile,
		mut stderr_file: impl std::io::Write,
		timeout: Option<Duration>,
		is_cancelled: F,
	) -> Result<ReadResult, brush_core::Error>
	where
		F: Fn() -> bool,
	{
		let term_mode = self.setup_terminal_settings(&input_file)?;



		if let Some(prompt) = &self.prompt {
			if input_file.is_terminal() {
				write!(stderr_file, "{prompt}")?;
				stderr_file.flush()?;
			}
		}


		let delimiter = if self.return_after_n_chars_no_delimiter.is_some() {
			None
		} else if let Some(delimiter_str) = &self.delimiter {
			if delimiter_str.is_empty() {
				Some(NUL_DELIMITER)
			} else {
				delimiter_str.chars().next()
			}
		} else {
			Some(DEFAULT_DELIMITER)
		};

		let char_limit = self
			.return_after_n_chars_no_delimiter
			.or(self.return_after_n_chars);


		let mut reader = InputReader::new(input_file, timeout, term_mode);


		if timeout == Some(Duration::ZERO) {
			ensure_not_cancelled(&is_cancelled)?;
			return Ok(if reader.check_input_available() {
				ReadResult::InputReady
			} else {
				ReadResult::InputNotReady
			});
		}


		let config = LineReaderConfig { delimiter, char_limit, process_escapes: !self.raw_mode };

		read_line_with_reader(&mut reader, &config, &is_cancelled)
	}

	fn setup_terminal_settings(
		&self,
		file: &brush_core::openfiles::OpenFile,
	) -> Result<Option<brush_core::terminal::AutoModeGuard>, brush_core::Error> {
		let mode = brush_core::terminal::AutoModeGuard::new(file.to_owned()).ok();
		if let Some(mode) = &mode {
			let config = brush_core::terminal::Settings::builder()
				.line_input(false)
				.interrupt_signals(false)
				.echo_input(!self.silent)
				.build();

			mode.apply_settings(&config)?;
		}

		Ok(mode)
	}








	fn validate_timeout(
		&self,
		context: &brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
	) -> Result<Option<brush_core::ExecutionResult>, brush_core::Error> {
		if let Some(timeout) = self.timeout_in_seconds {
			if timeout < 0.0 {
				writeln!(
					context.stderr(),
					"{}: -t: invalid timeout specification",
					context.command_name
				)?;
				return Ok(Some(brush_core::ExecutionResult::general_error()));
			}
		}
		Ok(None)
	}
}














fn split_line_by_ifs(ifs: &str, line: &str, max_fields: Option<usize>) -> VecDeque<String> {
	let ifs_chars: Vec<char> = ifs.chars().collect();



	let is_ifs_whitespace =
		|c: char| -> bool { (c == ' ' || c == '\t' || c == '\n') && ifs_chars.contains(&c) };


	let trimmed_line = line.trim_matches(&is_ifs_whitespace);
	if trimmed_line.is_empty() {
		return VecDeque::new();
	}

	let max_fields = max_fields.unwrap_or(usize::MAX);






	let mut fields = VecDeque::new();
	let mut current_field = String::new();
	let mut consuming_whitespace_run = false;
	let mut prev_was_non_ws_delim = false;
	let mut collecting_remainder = false;

	for c in trimmed_line.chars() {

		if consuming_whitespace_run && is_ifs_whitespace(c) {
			continue;
		}
		consuming_whitespace_run = false;

		let is_delimiter = ifs_chars.contains(&c);
		let at_field_limit = fields.len() + 1 >= max_fields;

		if !at_field_limit && is_delimiter {

			fields.push_back(std::mem::take(&mut current_field));
			consuming_whitespace_run = is_ifs_whitespace(c);
			prev_was_non_ws_delim = !consuming_whitespace_run;
		} else if at_field_limit && !collecting_remainder && is_delimiter {


			if is_ifs_whitespace(c) {
				consuming_whitespace_run = true;
			} else {


				collecting_remainder = true;
				current_field.push(c);
			}
		} else {

			collecting_remainder = at_field_limit;
			current_field.push(c);
			prev_was_non_ws_delim = false;
		}
	}




	if !current_field.is_empty() || !prev_was_non_ws_delim {
		fields.push_back(current_field);
	}

	fields
}


