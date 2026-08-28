



mod args {

	use std::{ffi::OsString, io::Write, time::Duration};

	use clap::{Arg, ArgAction, ArgMatches, Command, value_parser};
	use uucore::{
		display::Quotable,
		parser::{
			parse_signed_num::{SignPrefix, parse_signed_num_max},
			parse_size::ParseSizeError,
			parse_time,
			shortcut_value_parser::ShortcutValueParser,
		},
	};

	use crate::{
		host::{Host, format_usage},
		tail::{TailError, TailResult, paths::Input, platform},
	};


	pub mod options {
		pub mod verbosity {
			pub const QUIET: &str = "quiet";
			pub const VERBOSE: &str = "verbose";
		}
		pub const BYTES: &str = "bytes";
		pub const FOLLOW: &str = "follow";
		pub const LINES: &str = "lines";
		pub const PID: &str = "pid";
		pub const SLEEP_INT: &str = "sleep-interval";
		pub const ZERO_TERM: &str = "zero-terminated";
		pub const DISABLE_INOTIFY_TERM: &str = "-disable-inotify";
		pub const USE_POLLING: &str = "use-polling";
		pub const RETRY: &str = "retry";
		pub const FOLLOW_RETRY: &str = "F";
		pub const MAX_UNCHANGED_STATS: &str = "max-unchanged-stats";
		pub const ARG_FILES: &str = "files";
		pub const PRESUME_INPUT_PIPE: &str = "-presume-input-pipe";
		pub const DEBUG: &str = "debug";
		pub const REVERSE: &str = "reverse";
		pub const BLOCKS: &str = "blocks";
	}

	#[derive(Clone, Copy, Debug, PartialEq, Eq)]
	pub enum Signum {
		Negative(u64),
		Positive(u64),
		PlusZero,
		MinusZero,
	}

	#[derive(Debug, PartialEq, Eq)]
	pub enum FilterMode {
		Bytes(Signum),


		Lines(Signum, u8),
	}

	impl FilterMode {


		fn from(matches: &ArgMatches) -> TailResult<Self> {
			let zero_term = matches.get_flag(options::ZERO_TERM);
			let mode = if let Some(arg) = matches.get_one::<String>(options::BYTES) {
				match parse_num(arg) {
					Ok(signum) => Self::Bytes(signum),
					Err(e) => {
						return Err(TailError::message(format!("invalid number of bytes: {e}")));
					},
				}
			} else if let Some(arg) = matches.get_one::<String>(options::LINES) {
				match parse_num(arg) {
					Ok(signum) => {
						let delimiter = if zero_term { 0 } else { b'\n' };
						Self::Lines(signum, delimiter)
					},
					Err(_) => {
						return Err(TailError::message(format!(
							"invalid number of lines: {}",
							arg.quote()
						)));
					},
				}
			} else if zero_term {
				Self::default_zero()
			} else {
				Self::default()
			};

			Ok(mode)
		}

		fn default_zero() -> Self {
			Self::Lines(Signum::Negative(10), 0)
		}
	}

	impl Default for FilterMode {
		fn default() -> Self {
			Self::Lines(Signum::Negative(10), b'\n')
		}
	}

	#[derive(Debug, PartialEq, Eq, Clone, Copy)]
	pub enum FollowMode {
		Descriptor,
		Name,
	}

	#[derive(Debug)]
	pub enum VerificationResult {
		Ok,
		CannotFollowStdinByName,
		NoOutput,
	}

	#[derive(Debug)]
	pub struct Settings {
		pub follow:              Option<FollowMode>,
		pub max_unchanged_stats: u32,
		pub mode:                FilterMode,
		pub pid:                 platform::Pid,
		pub retry:               bool,
		pub sleep_sec:           Duration,
		pub use_polling:         bool,
		pub verbose:             bool,
		pub presume_input_pipe:  bool,
		pub debug:               bool,

		pub inputs:              Vec<Input>,
	}

	impl Default for Settings {
		fn default() -> Self {
			Self {
				max_unchanged_stats: 5,
				sleep_sec:           Duration::from_secs_f32(1.0),
				follow:              Option::default(),
				mode:                FilterMode::default(),
				pid:                 Default::default(),
				retry:               Default::default(),
				use_polling:         Default::default(),
				verbose:             Default::default(),
				presume_input_pipe:  Default::default(),
				debug:               Default::default(),
				inputs:              Vec::default(),
			}
		}
	}

	impl Settings {


		pub fn from(matches: &ArgMatches) -> TailResult<Self> {





			let follow_retry = matches.get_flag(options::FOLLOW_RETRY);


			let retry = follow_retry || matches.get_flag(options::RETRY);
			let follow = match (
	            follow_retry,
	            matches
	                .get_one::<String>(options::FOLLOW)
	                .map(String::as_str),
	        ) {


	            (true, Some(_))


	                if matches.index_of(options::FOLLOW_RETRY) > matches.index_of(options::FOLLOW) =>
	            {
	                Some(FollowMode::Name)
	            }



	            (_, Some("name")) | (true, None) => Some(FollowMode::Name),



	            (_, Some(_)) => Some(FollowMode::Descriptor),

	            (false, None) => None,
	        };

			let mut settings: Self = Self {
				follow,
				retry,
				use_polling: matches.get_flag(options::USE_POLLING),
				mode: FilterMode::from(matches)?,
				verbose: matches.get_flag(options::verbosity::VERBOSE),
				presume_input_pipe: matches.get_flag(options::PRESUME_INPUT_PIPE),
				debug: matches.get_flag(options::DEBUG),
				..Default::default()
			};

			if let Some(source) = matches.get_one::<String>(options::SLEEP_INT) {
				settings.sleep_sec = parse_time::from_str(source, false)
					.map_err(|_| TailError::message(format!("invalid number of seconds: '{source}'")))?;
			}

			if let Some(s) = matches.get_one::<String>(options::MAX_UNCHANGED_STATS) {
				settings.max_unchanged_stats = match s.parse::<u32>() {
					Ok(s) => s,
					Err(_) => {
						return Err(TailError::message(format!(
							"invalid maximum number of unchanged stats between opens: {}",
							s.quote()
						)));
					},
				};
			}
			if let Some(pid_str) = matches.get_one::<String>(options::PID) {
				match pid_str.parse() {
					Ok(pid) => {

						#[cfg(unix)]
						if pid < 0 {

							return Err(TailError::message(format!("invalid PID: {}", pid_str.quote())));
						}

						settings.pid = pid;
					},
					Err(e) => {
						return Err(TailError::message(format!(
							"invalid PID: {}: {}",
							pid_str.quote(),
							e
						)));
					},
				}
			}

			settings.inputs = matches
				.get_many::<OsString>(options::ARG_FILES)
				.map_or_else(|| vec![Input::default()], |v| v.map(Input::from).collect());

			settings.verbose = (matches.get_flag(options::verbosity::VERBOSE)
				|| settings.inputs.len() > 1)
				&& !matches.get_flag(options::verbosity::QUIET);

			Ok(settings)
		}


		pub fn resolve_paths(&mut self, host: &Host) {
			for input in &mut self.inputs {
				input.resolve_path(host);
			}
		}



		pub fn check_warnings(&self, stderr: &mut impl Write) {
			if self.retry {
				if self.follow.is_none() {
					let _ = writeln!(
						stderr,
						"tail: warning: --retry ignored; --retry is useful only when following"
					);
				} else if self.follow == Some(FollowMode::Descriptor) {
					let _ = writeln!(
						stderr,
						"tail: warning: --retry only effective for the initial open"
					);
				}
			}

			if self.pid != 0 {
				if self.follow.is_none() {
					let _ = writeln!(
						stderr,
						"tail: warning: PID ignored; --pid=PID is useful only when following"
					);
				} else if !platform::supports_pid_checks(self.pid) {
					let _ = writeln!(
						stderr,
						"tail: warning: --pid=PID is not supported on this system"
					);
				}
			}
		}





		pub fn verify(&self) -> VerificationResult {

			if self.inputs.iter().any(Input::is_stdin) && self.follow == Some(FollowMode::Name) {
				return VerificationResult::CannotFollowStdinByName;
			}


			if self.follow.is_none()
				&& matches!(
					self.mode,
					FilterMode::Lines(Signum::MinusZero, _) | FilterMode::Bytes(Signum::MinusZero)
				) {
				return VerificationResult::NoOutput;
			}

			VerificationResult::Ok
		}
	}

	fn parse_num(src: &str) -> Result<Signum, ParseSizeError> {
		let result = parse_signed_num_max(src)?;
		let is_plus = result.sign == Some(SignPrefix::Plus);

		match (result.value, is_plus) {
			(0, true) => Ok(Signum::PlusZero),
			(0, false) => Ok(Signum::MinusZero),
			(n, true) => Ok(Signum::Positive(n)),
			(n, false) => Ok(Signum::Negative(n)),
		}
	}


	pub fn uu_app() -> Command {
		#[cfg(target_os = "linux")]
		let polling_help = "Disable 'inotify' support and use polling instead";
		#[cfg(all(unix, not(target_os = "linux")))]
		let polling_help = "Disable 'kqueue' support and use polling instead";
		#[cfg(target_os = "windows")]
		let polling_help = "Disable 'ReadDirectoryChanges' support and use polling instead";
		#[cfg(not(any(unix, target_os = "windows")))]
		let polling_help = "Disable 'kqueue' support and use polling instead";

		Command::new("tail")
			.version("0.8.0")
			.about(
				"Print the last 10 lines of each FILE to standard output.\nWith more than one FILE, \
				 precede each with a header giving the file name.\nWith no FILE, or when FILE is -, read \
				 standard input.\nMandatory arguments to long flags are mandatory for short flags too.",
			)
			.override_usage(format_usage("tail [FLAG]... [FILE]..."))
			.infer_long_args(true)
			.arg(
				Arg::new(options::BYTES)
					.short('c')
					.long(options::BYTES)
					.allow_hyphen_values(true)
					.overrides_with_all([options::BYTES, options::LINES])
					.help("Number of bytes to print"),
			)
			.arg(
				Arg::new(options::FOLLOW)
					.short('f')
					.long(options::FOLLOW)
					.default_missing_value("descriptor")
					.num_args(0..=1)
					.require_equals(true)
					.value_parser(ShortcutValueParser::new(["descriptor", "name"]))
					.overrides_with(options::FOLLOW)
					.help("Print the file as it grows"),
			)
			.arg(
				Arg::new(options::LINES)
					.short('n')
					.long(options::LINES)
					.allow_hyphen_values(true)
					.overrides_with_all([options::BYTES, options::LINES])
					.help("Number of lines to print"),
			)
			.arg(
				Arg::new(options::PID)
					.long(options::PID)
					.value_name("PID")
					.help("With -f, terminate after process ID, PID dies")
					.overrides_with(options::PID),
			)
			.arg(
				Arg::new(options::verbosity::QUIET)
					.short('q')
					.long(options::verbosity::QUIET)
					.visible_alias("silent")
					.overrides_with_all([options::verbosity::QUIET, options::verbosity::VERBOSE])
					.help("Never output headers giving file names")
					.action(ArgAction::SetTrue),
			)
			.arg(
				Arg::new(options::SLEEP_INT)
					.short('s')
					.value_name("N")
					.long(options::SLEEP_INT)
					.help("Number of seconds to sleep between polling the file when running with -f"),
			)
			.arg(
				Arg::new(options::MAX_UNCHANGED_STATS)
					.value_name("N")
					.long(options::MAX_UNCHANGED_STATS)
					.help(
						"Reopen a FILE which has not changed size after N (default 5) iterations to see if \
						 it has been unlinked or renamed (this is the usual case of rotated log files); \
						 This option is meaningful only when polling (i.e., with --use-polling) and when \
						 --follow=name",
					),
			)
			.arg(
				Arg::new(options::verbosity::VERBOSE)
					.short('v')
					.long(options::verbosity::VERBOSE)
					.overrides_with_all([options::verbosity::QUIET, options::verbosity::VERBOSE])
					.help("Always output headers giving file names")
					.action(ArgAction::SetTrue),
			)
			.arg(
				Arg::new(options::ZERO_TERM)
					.short('z')
					.long(options::ZERO_TERM)
					.help("Line delimiter is NUL, not newline")
					.action(ArgAction::SetTrue),
			)
			.arg(
				Arg::new(options::USE_POLLING)
					.alias(options::DISABLE_INOTIFY_TERM)
					.alias("dis")
					.long(options::USE_POLLING)
					.help(polling_help)
					.action(ArgAction::SetTrue),
			)
			.arg(
				Arg::new(options::RETRY)
					.long(options::RETRY)
					.help("Keep trying to open a file if it is inaccessible")
					.overrides_with(options::RETRY)
					.action(ArgAction::SetTrue),
			)
			.arg(
				Arg::new(options::FOLLOW_RETRY)
					.short('F')
					.help("Same as --follow=name --retry")
					.overrides_with(options::FOLLOW_RETRY)
					.action(ArgAction::SetTrue),
			)
			.arg(
				Arg::new(options::DEBUG)
					.long(options::DEBUG)
					.help("indicate which --follow implementation is used")
					.action(ArgAction::SetTrue),
			)
			.arg(
				Arg::new(options::PRESUME_INPUT_PIPE)
					.long("presume-input-pipe")
					.alias(options::PRESUME_INPUT_PIPE)
					.hide(true)
					.action(ArgAction::SetTrue),
			)
			.arg(
				Arg::new(options::REVERSE)
					.short('r')
					.long(options::REVERSE)
					.hide(true)
					.action(ArgAction::SetTrue),
			)
			.arg(
				Arg::new(options::BLOCKS)
					.short('b')
					.hide(true)
					.action(ArgAction::SetTrue),
			)
			.arg(
				Arg::new(options::ARG_FILES)
					.action(ArgAction::Append)
					.num_args(1..)
					.value_parser(value_parser!(OsString))
					.value_hint(clap::ValueHint::FilePath),
			)
	}


}

mod chunks {













	use std::{
		collections::VecDeque,
		fs::File,
		io::{self, BufRead, Read, Seek, SeekFrom, Write},
	};



	pub const BLOCK_SIZE: u64 = 1 << 16;







	pub const BUFFER_SIZE: usize = 8192;






	pub struct ReverseChunks<'a> {

		file: &'a File,


		size: u64,


		max_blocks_to_read: usize,


		block_idx: usize,
	}

	impl<'a> ReverseChunks<'a> {
		pub fn new(file: &'a mut File) -> Self {
			let current = if cfg!(unix) {
				file.stream_position().unwrap()
			} else {
				0
			};
			let size = file.seek(SeekFrom::End(0)).unwrap() - current;
			let max_blocks_to_read = (size as f64 / BLOCK_SIZE as f64).ceil() as usize;
			let block_idx = 0;
			ReverseChunks { file, size, max_blocks_to_read, block_idx }
		}
	}

	impl Iterator for ReverseChunks<'_> {
		type Item = Vec<u8>;

		fn next(&mut self) -> Option<Self::Item> {

			if self.block_idx >= self.max_blocks_to_read {
				return None;
			}




			let block_size = if self.block_idx == self.max_blocks_to_read - 1 {
				self.size % BLOCK_SIZE
			} else {
				BLOCK_SIZE
			};



			let mut buf = vec![0; BLOCK_SIZE as usize];
			let pos = self
				.file
				.seek(SeekFrom::Current(-(block_size as i64)))
				.unwrap();
			self
				.file
				.read_exact(&mut buf[0..(block_size as usize)])
				.unwrap();
			let pos2 = self
				.file
				.seek(SeekFrom::Current(-(block_size as i64)))
				.unwrap();
			assert_eq!(pos, pos2);

			self.block_idx += 1;

			Some(buf[0..(block_size as usize)].to_vec())
		}
	}



	type ChunkBuffer = [u8; BUFFER_SIZE];


	#[derive(Clone, PartialEq, Eq, Debug)]
	pub struct BytesChunk {


		buffer: ChunkBuffer,







		bytes: usize,
	}

	impl BytesChunk {
		#[allow(clippy::new_without_default, reason = "upstream chunk constructor is intentionally explicit")]
		pub fn new() -> Self {
			Self { buffer: [0; BUFFER_SIZE], bytes: 0 }
		}



























		fn from_chunk(chunk: &Self, offset: usize) -> Self {
			if offset >= chunk.bytes {
				return Self::new();
			}

			let mut buffer: ChunkBuffer = [0; BUFFER_SIZE];
			let slice = chunk.get_buffer_with(offset);
			buffer[..slice.len()].copy_from_slice(slice);
			Self { buffer, bytes: chunk.bytes - offset }
		}














		pub fn get_buffer(&self) -> &[u8] {
			&self.buffer[..self.bytes]
		}














		pub fn get_buffer_with(&self, offset: usize) -> &[u8] {
			&self.buffer[offset..self.bytes]
		}

		pub fn has_data(&self) -> bool {
			self.bytes > 0
		}






		pub fn fill(&mut self, filehandle: &mut impl BufRead) -> io::Result<Option<usize>> {
			let num_bytes = filehandle.read(&mut self.buffer)?;
			self.bytes = num_bytes;
			if num_bytes == 0 {
				return Ok(None);
			}

			Ok(Some(self.bytes))
		}
	}



	pub struct BytesChunkBuffer {

		num_print: u64,




		bytes:     u64,

		chunks:    VecDeque<Box<BytesChunk>>,
	}

	impl BytesChunkBuffer {




















		pub fn new(num_print: u64) -> Self {
			Self { bytes: 0, num_print, chunks: VecDeque::new() }
		}

























		pub fn fill(&mut self, reader: &mut impl BufRead) -> io::Result<()> {
			let mut chunk = Box::new(BytesChunk::new());



			while chunk.fill(reader)?.is_some() {
				self.bytes += chunk.bytes as u64;
				self.chunks.push_back(chunk.clone());

				let first = &self.chunks[0];
				if self.bytes - first.bytes as u64 > self.num_print {
					chunk = self.chunks.pop_front().unwrap();
					self.bytes -= chunk.bytes as u64;
				} else {
					*chunk = BytesChunk::new();
				}
			}


			if self.chunks.is_empty() {
				return Ok(());
			}

			let chunk = self.chunks.pop_front().unwrap();





			let offset = self.bytes.saturating_sub(self.num_print) as usize;
			self
				.chunks
				.push_front(Box::new(BytesChunk::from_chunk(&chunk, offset)));

			Ok(())
		}

		pub fn print(&self, writer: &mut impl Write) -> io::Result<()> {
			for chunk in &self.chunks {
				writer.write_all(chunk.get_buffer())?;
			}
			Ok(())
		}

		pub fn has_data(&self) -> bool {
			!self.chunks.is_empty()
		}
	}




	#[derive(Clone, Debug)]
	pub struct LinesChunk {

		chunk:     BytesChunk,




		lines:     usize,

		delimiter: u8,
	}

	impl LinesChunk {
		pub fn new(delimiter: u8) -> Self {
			Self { chunk: BytesChunk::new(), lines: 0, delimiter }
		}

















		fn count_lines(&self) -> usize {
			memchr::memchr_iter(self.delimiter, self.get_buffer()).count()
		}




























		fn from_chunk(chunk: &Self, offset: usize) -> Self {
			if offset > chunk.lines {
				return Self::new(chunk.delimiter);
			}

			let bytes_offset = chunk.calculate_bytes_offset_from(offset);
			let new_chunk = BytesChunk::from_chunk(&chunk.chunk, bytes_offset);

			Self { chunk: new_chunk, lines: chunk.lines - offset, delimiter: chunk.delimiter }
		}















		pub fn has_data(&self) -> bool {
			self.chunk.has_data()
		}




		pub fn get_buffer(&self) -> &[u8] {
			self.chunk.get_buffer()
		}





		pub fn get_buffer_with(&self, offset: usize) -> &[u8] {
			self.chunk.get_buffer_with(offset)
		}




		pub fn get_lines(&self) -> usize {
			self.lines
		}






		pub fn fill(&mut self, filehandle: &mut impl BufRead) -> io::Result<Option<usize>> {
			match self.chunk.fill(filehandle)? {
				None => {
					self.lines = 0;
					Ok(None)
				},
				Some(bytes) => {
					self.lines = self.count_lines();
					Ok(Some(bytes))
				},
			}
		}
























		fn calculate_bytes_offset_from(&self, offset: usize) -> usize {
			let mut lines_offset = offset;
			let mut bytes_offset = 0;
			for byte in self.get_buffer() {
				if lines_offset == 0 {
					break;
				}
				if byte == &self.delimiter {
					lines_offset -= 1;
				}
				bytes_offset += 1;
			}
			bytes_offset
		}








		pub fn write_lines(&self, writer: &mut impl Write, offset: usize) -> io::Result<()> {
			self.write_bytes(writer, self.calculate_bytes_offset_from(offset))
		}








		pub fn write_bytes(&self, writer: &mut impl Write, offset: usize) -> io::Result<()> {
			writer.write_all(self.get_buffer_with(offset))?;
			Ok(())
		}
	}





	pub struct LinesChunkBuffer {

		delimiter: u8,




		lines:     u64,

		num_print: u64,

		chunks:    VecDeque<Box<LinesChunk>>,
	}

	impl LinesChunkBuffer {

		pub fn new(delimiter: u8, num_print: u64) -> Self {
			Self { delimiter, num_print, lines: 0, chunks: VecDeque::new() }
		}








		pub fn fill(&mut self, reader: &mut impl BufRead) -> io::Result<()> {
			let mut chunk = Box::new(LinesChunk::new(self.delimiter));

			while chunk.fill(reader)?.is_some() {
				self.lines += chunk.lines as u64;
				self.chunks.push_back(chunk.clone());

				let first = &self.chunks[0];
				if self.lines - first.lines as u64 > self.num_print {
					chunk = self.chunks.pop_front().unwrap();

					self.lines -= chunk.lines as u64;
				} else {
					*chunk = LinesChunk::new(self.delimiter);
				}
			}

			if self.chunks.is_empty() {

				return Ok(());
			}

			let length = &self.chunks.len();
			let last = &mut self.chunks[length - 1];
			if !last.get_buffer().ends_with(&[self.delimiter]) {
				last.lines += 1;
				self.lines += 1;
			}



			let chunk = loop {


				let chunk = self.chunks.pop_front().unwrap();


				let skip = self.lines - chunk.lines as u64 > self.num_print;
				if skip {
					self.lines -= chunk.lines as u64;
				} else {
					break chunk;
				}
			};




			let skip_lines = self.lines.saturating_sub(self.num_print) as usize;
			let chunk = LinesChunk::from_chunk(&chunk, skip_lines);
			self.chunks.push_front(Box::new(chunk));

			Ok(())
		}

		pub fn write(&self, mut writer: impl Write) -> io::Result<()> {
			for chunk in &self.chunks {
				chunk.write_bytes(&mut writer, 0)?;
			}
			Ok(())
		}
	}


}

mod follow {





	#[cfg(not(target_os = "wasi"))]
	mod files {

		use std::{
			collections::{HashMap, hash_map::Keys},
			fs::{File, Metadata},
			io::{BufRead, BufReader, Write},
			path::{Path, PathBuf},
		};

		use crate::tail::{
			TailResult,
			args::Settings,
			chunks::BytesChunkBuffer,
			paths::{HeaderPrinter, PathExtTail},
			text,
		};






		pub struct FileHandling {
			map:            HashMap<PathBuf, PathData>,
			last:           Option<PathBuf>,
			header_printer: HeaderPrinter,
		}

		impl FileHandling {
			pub fn from(settings: &Settings) -> Self {
				Self {
					map:            HashMap::with_capacity(settings.inputs.len()),
					last:           None,
					header_printer: HeaderPrinter::new(settings.verbose, false),
				}
			}


			pub fn insert(&mut self, k: &Path, v: PathData, update_last: bool) {
				let k = Self::canonicalize_path(k);
				if update_last {
					self.last = Some(k.clone());
				}
				let _ = self.map.insert(k, v);
			}


			pub fn remove(&mut self, k: &Path) -> PathData {
				self.map.remove(&Self::canonicalize_path(k)).unwrap()
			}


			pub fn get(&self, k: &Path) -> &PathData {
				self.map.get(&Self::canonicalize_path(k)).unwrap()
			}


			pub fn get_mut(&mut self, k: &Path) -> &mut PathData {
				self.map.get_mut(&Self::canonicalize_path(k)).unwrap()
			}


			fn canonicalize_path(path: &Path) -> PathBuf {
				if path.is_relative()
					&& !path.is_stdin()
					&& let Ok(p) = path.canonicalize()
				{
					return p;
				}
				path.to_owned()
			}

			pub fn get_mut_metadata(&mut self, path: &Path) -> Option<&Metadata> {
				self.get_mut(path).metadata.as_ref()
			}

			pub fn keys(&self) -> Keys<'_, PathBuf, PathData> {
				self.map.keys()
			}

			pub fn contains_key(&self, k: &Path) -> bool {
				self.map.contains_key(k)
			}

			pub fn get_last(&self) -> Option<&PathBuf> {
				self.last.as_ref()
			}


			pub fn only_stdin_remaining(&self) -> bool {
				self.map.len() == 1 && (self.map.contains_key(Path::new(text::DASH)))
			}


			pub fn files_remaining(&self) -> bool {
				for path in self.map.keys() {
					if path.is_tailable() || path.is_stdin() {
						return true;
					}
				}
				false
			}


			pub fn no_files_remaining(&self, settings: &Settings) -> bool {
				self.map.is_empty() || !self.files_remaining() && !settings.retry
			}



			pub fn reset_reader(&mut self, path: &Path) {
				self.get_mut(path).reader = None;
			}


			pub fn update_reader(&mut self, path: &Path) -> TailResult<()> {






				self
					.get_mut(path)
					.reader
					.replace(Box::new(BufReader::new(File::open(path)?)));
				Ok(())
			}


			pub fn update_metadata(&mut self, path: &Path, metadata: Option<Metadata>) {
				self.get_mut(path).metadata = if metadata.is_some() {
					metadata
				} else {
					path.metadata().ok()
				};
			}


			pub fn tail_file(
				&mut self,
				path: &Path,
				verbose: bool,
				writer: &mut impl Write,
			) -> TailResult<bool> {
				let mut chunks = BytesChunkBuffer::new(u64::MAX);
				if let Some(reader) = self.get_mut(path).reader.as_mut() {
					chunks.fill(reader)?;
				}
				if chunks.has_data() {
					if self.needs_header(path, verbose) {
						let display_name = self.get(path).display_name.clone();
						self.header_printer.print(display_name.as_str(), writer);
					}

					chunks.print(writer).map_err(crate::tail::map_output_error)?;
					writer.flush().map_err(crate::tail::map_output_error)?;

					self.last.replace(path.to_owned());
					self.update_metadata(path, None);
					Ok(true)
				} else {
					Ok(false)
				}
			}



			pub fn needs_header(&self, path: &Path, verbose: bool) -> bool {
				if verbose {
					if let Some(ref last) = self.last {
						!last.eq(&path)
					} else {
						true
					}
				} else {
					false
				}
			}
		}



		pub struct PathData {
			pub reader:       Option<Box<dyn BufRead>>,
			pub metadata:     Option<Metadata>,
			pub display_name: String,
		}

		impl PathData {
			pub fn new(
				reader: Option<Box<dyn BufRead>>,
				metadata: Option<Metadata>,
				display_name: &str,
			) -> Self {
				Self { reader, metadata, display_name: display_name.to_owned() }
			}

			pub fn from_other_with_path(data: Self, path: &Path) -> Self {

				let old_reader = data.reader;
				let reader = if old_reader.is_some() {

					old_reader
				} else if let Ok(file) = File::open(path) {

					Some(Box::new(BufReader::new(file)) as Box<dyn BufRead>)
				} else {

					None
				};

				Self::new(reader, path.metadata().ok(), data.display_name.as_str())
			}
		}
	}

	#[cfg(not(target_os = "wasi"))]
	mod watch {

		use std::{
			io::{BufRead, Write},
			path::{Path, PathBuf},
			sync::{
				Arc,
				atomic::{AtomicBool, Ordering},
				mpsc::{self, Receiver, channel},
			},
			time::Duration,
		};

		use notify::{RecommendedWatcher, RecursiveMode, Watcher, WatcherKind};
		#[cfg(target_os = "linux")]
		use uucore::signals::ensure_stdout_not_broken;
		use uucore::display::Quotable;

		use brush_core::openfiles::OpenFile;

		use crate::{
			host::{Host, StreamWriter},
			tail::{
				TailError,
				TailResult,
				args::{FollowMode, Settings},
				follow::files::{FileHandling, PathData},
				paths::{Input, InputKind, MetadataExtTail, PathExtTail},
				platform, text,
			},
		};

		pub struct WatcherRx {
			watcher:  Box<dyn Watcher>,
			receiver: Receiver<Result<notify::Event, notify::Error>>,
		}

		impl WatcherRx {
			fn new(
				watcher: Box<dyn Watcher>,
				receiver: Receiver<Result<notify::Event, notify::Error>>,
			) -> Self {
				Self { watcher, receiver }
			}



			fn watch_with_parent(&mut self, path: &Path) -> TailResult<()> {
				let mut path = path.to_owned();
				#[cfg(target_os = "linux")]
				if path.is_file() {









					if let Some(parent) = path.parent() {
						if parent.is_dir() {
							path = parent.to_owned();
						} else {
							path = PathBuf::from(".");
						}
					} else {
						return Err(TailError::message(format!("cannot watch parent directory of {}", path.quote())));
					}
				}
				if path.is_relative() {
					path = path.canonicalize()?;
				}



				self.watch(&path, RecursiveMode::NonRecursive)?;
				Ok(())
			}

			fn watch(&mut self, path: &Path, mode: RecursiveMode) -> TailResult<()> {
				self
					.watcher
					.watch(path, mode)
					.map_err(|err| TailError::message(err.to_string()))
			}

			fn unwatch(&mut self, path: &Path) -> TailResult<()> {
				self
					.watcher
					.unwatch(path)
					.map_err(|err| TailError::message(err.to_string()))
			}
		}

		pub struct Observer {

			pub retry: bool,


			pub follow: Option<FollowMode>,




			pub use_polling: bool,

			pub watcher_rx: Option<WatcherRx>,
			pub orphans:    Vec<PathBuf>,
			pub files:      FileHandling,

			pub pid: platform::Pid,
			pub stdout: StreamWriter,
			pub stderr: OpenFile,
			pub cancel: Arc<AtomicBool>,
		}

		impl Observer {
			pub fn new(
				retry: bool,
				follow: Option<FollowMode>,
				use_polling: bool,
				files: FileHandling,
				pid: platform::Pid,
				stdout: StreamWriter,
				stderr: OpenFile,
				cancel: Arc<AtomicBool>,
			) -> Self {
				let pid = if platform::supports_pid_checks(pid) {
					pid
				} else {
					0
				};

				Self {
					retry,
					follow,
					use_polling,
					watcher_rx: None,
					orphans: Vec::new(),
					files,
					pid,
					stdout,
					stderr,
					cancel,
				}
			}

			pub fn from(
				settings: &Settings,
				stdout: StreamWriter,
				stderr: OpenFile,
				cancel: Arc<AtomicBool>,
			) -> Self {
				Self::new(
					settings.retry,
					settings.follow,
					settings.use_polling,
					FileHandling::from(settings),
					settings.pid,
					stdout,
					stderr,
					cancel,
				)
			}

			pub fn add_path(
				&mut self,
				path: &Path,
				display_name: &str,
				reader: Option<Box<dyn BufRead>>,
				update_last: bool,
			) -> TailResult<()> {
				if self.follow.is_some() {
					let path = if path.is_relative() {
						std::env::current_dir()?.join(path)
					} else {
						path.to_owned()
					};
					let metadata = path.metadata().ok();
					self
						.files
						.insert(&path, PathData::new(reader, metadata, display_name), update_last);
				}

				Ok(())
			}

			pub fn add_bad_path(
				&mut self,
				path: &Path,
				display_name: &str,
				update_last: bool,
			) -> TailResult<()> {
				if self.retry && self.follow.is_some() {
					return self.add_path(path, display_name, None, update_last);
				}

				Ok(())
			}

			pub fn start(&mut self, settings: &Settings, host: &mut Host) -> TailResult<()> {
				if settings.follow.is_none() {
					return Ok(());
				}

				let (tx, rx) = channel();


















				let watcher: Box<dyn Watcher>;
				let watcher_config = notify::Config::default()
					.with_poll_interval(settings.sleep_sec)





					.with_compare_contents(true);
				if self.use_polling || RecommendedWatcher::kind() == WatcherKind::PollWatcher {
					self.use_polling = true;
					watcher = Box::new(notify::PollWatcher::new(tx, watcher_config).unwrap());
				} else {
					let tx_clone = tx.clone();
					match RecommendedWatcher::new(tx, notify::Config::default()) {
						Ok(w) => watcher = Box::new(w),
						Err(e) if e.to_string().starts_with("Too many open files") => {






							let _ = writeln!(
								self.stderr,
								"tail: {} cannot be used, reverting to polling: Too many open files",
								text::BACKEND
							);
							host.fail(1);
							self.use_polling = true;
							watcher = Box::new(notify::PollWatcher::new(tx_clone, watcher_config).unwrap());
						},
						Err(e) => return Err(TailError::message(e.to_string())),
					}
				}

				self.watcher_rx = Some(WatcherRx::new(watcher, rx));
				self.init_files(&settings.inputs)?;

				Ok(())
			}

			pub fn follow_descriptor(&self) -> bool {
				self.follow == Some(FollowMode::Descriptor)
			}

			pub fn follow_name(&self) -> bool {
				self.follow == Some(FollowMode::Name)
			}

			pub fn follow_descriptor_retry(&self) -> bool {
				self.follow_descriptor() && self.retry
			}

			pub fn follow_name_retry(&self) -> bool {
				self.follow_name() && self.retry
			}

			fn init_files(&mut self, inputs: &Vec<Input>) -> TailResult<()> {
				if let Some(watcher_rx) = &mut self.watcher_rx {
					for input in inputs {
						match input.kind() {
							InputKind::Stdin => (),
							InputKind::File(path) => {
								#[cfg(all(unix, not(target_os = "linux")))]
								if !path.is_file() {
									continue;
								}
								let mut path = path.clone();
								if path.is_relative() {
									path = std::env::current_dir()?.join(path);
								}

								if path.is_tailable() {

									watcher_rx.watch_with_parent(&path)?;
								} else if !path.is_orphan() {

									watcher_rx.watch(path.parent().unwrap(), RecursiveMode::NonRecursive)?;

									if path.is_symlink() {
										self.orphans.push(path);
									}
								} else {

									self.orphans.push(path);
								}
							},
						}
					}
				}
				Ok(())
			}

			#[allow(clippy::cognitive_complexity, reason = "preserves upstream notify event state machine")]
			fn handle_event(&mut self, event: &notify::Event, settings: &Settings) -> TailResult<Vec<PathBuf>> {
				use notify::event::{
					CreateKind, DataChange, EventKind, MetadataKind, ModifyKind, RemoveKind, RenameMode,
				};

				let event_path = event.paths.first().unwrap();
				let mut paths: Vec<PathBuf> = vec![];
				let display_name = self.files.get(event_path).display_name.clone();

				match event.kind {
		            EventKind::Modify(ModifyKind::Metadata(MetadataKind::Any | MetadataKind::WriteTime) | ModifyKind::Data(DataChange::Any) | ModifyKind::Name(RenameMode::To)) |
		            EventKind::Create(CreateKind::File | CreateKind::Folder | CreateKind::Any) => {
		                if let Ok(new_md) = event_path.metadata() {
		                    let is_tailable = new_md.is_tailable();
		                    let pd = self.files.get(event_path);
		                    if let Some(old_md) = &pd.metadata {
		                        if is_tailable {



		                            if !old_md.is_tailable() {
		                                let _ = writeln!(
		                                    self.stderr,
		                                    "tail: {} has become accessible",
		                                    display_name.quote()
		                                );
		                                self.files.update_reader(event_path)?;
		                            } else if pd.reader.is_none() {
		                                let _ = writeln!(
		                                    self.stderr,
		                                    "tail: {} has appeared;  following new file",
		                                    display_name.quote()
		                                );
		                                self.files.update_reader(event_path)?;
		                            } else if event.kind == EventKind::Modify(ModifyKind::Name(RenameMode::To))
		                            || (self.use_polling && !old_md.file_id_eq(&new_md)) {
		                                let _ = writeln!(
		                                    self.stderr,
		                                    "tail: {} has been replaced;  following new file",
		                                    display_name.quote()
		                                );
		                                self.files.update_reader(event_path)?;
		                            } else if old_md.got_truncated(&new_md)? {
		                                let _ = writeln!(
		                                    self.stderr,
		                                    "tail: {}: file truncated",
		                                    display_name
		                                );
		                                self.files.update_reader(event_path)?;
		                            }
		                            paths.push(event_path.clone());
		                        } else if !is_tailable && old_md.is_tailable() {
		                            if pd.reader.is_some() {
		                                self.files.reset_reader(event_path);
		                            } else {
		                                let _ = writeln!(
		                                    self.stderr,
		                                    "tail: {} has been replaced with an untailable file",
		                                    display_name.quote()
		                                );
		                            }
		                        }
		                    } else if is_tailable {
		                        let _ = writeln!(
		                            self.stderr,
		                            "tail: {} has appeared;  following new file",
		                            display_name.quote()
		                        );
		                        self.files.update_reader(event_path)?;
		                        paths.push(event_path.clone());
		                    } else if settings.retry {
		                        if self.follow_descriptor() {
		                            let _ = writeln!(
		                                self.stderr,
		                                "tail: {} has been replaced with an untailable file; giving up on this name",
		                                display_name.quote()
		                            );
		                            let _ = self.watcher_rx.as_mut().unwrap().watcher.unwatch(event_path);
		                            self.files.remove(event_path);
		                            if self.files.no_files_remaining(settings) {
		                                return Err(TailError::message("no files remaining".to_string()));
		                            }
		                        } else {
		                            let _ = writeln!(
		                                self.stderr,
		                                "tail: {} has been replaced with an untailable file",
		                                display_name.quote()
		                            );
		                        }
		                    }
		                    self.files.update_metadata(event_path, Some(new_md));
		                } else if event_path.is_symlink() && settings.retry {
		                    self.files.reset_reader(event_path);
		                    self.orphans.push(event_path.clone());
		                }
		            }
		            EventKind::Remove(RemoveKind::File | RemoveKind::Any)


		                | EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
		                if self.follow_name() {
		                    if settings.retry {
		                        if let Some(old_md) = self.files.get_mut_metadata(event_path)
		                            && old_md.is_tailable() && self.files.get(event_path).reader.is_some() {
		                                let _ = writeln!(
		                                    self.stderr,
		                                    "tail: {} has become inaccessible: No such file or directory",
		                                    display_name.quote()
		                                );
		                            }
		                        if event_path.is_orphan() && !self.orphans.contains(event_path) {
		                            let _ = writeln!(
		                                self.stderr,
		                                "tail: directory containing watched file was removed"
		                            );
		                            let _ = writeln!(
		                                self.stderr,
		                                "tail: {} cannot be used, reverting to polling",
		                                text::BACKEND
		                            );
		                            self.orphans.push(event_path.clone());
		                            let _ = self.watcher_rx.as_mut().unwrap().unwatch(event_path);
		                        }
		                    } else {
		                        let _ = writeln!(
		                            self.stderr,
		                            "tail: {}: No such file or directory",
		                            display_name
		                        );
		                        if !self.files.files_remaining() && self.use_polling {

		                            return Err(TailError::message("no files remaining".to_string()));
		                        }
		                    }
		                    self.files.reset_reader(event_path);
		                } else if self.follow_descriptor_retry() {

		                    let _ = self.watcher_rx.as_mut().unwrap().unwatch(event_path);
		                    self.files.remove(event_path);
		                } else if self.use_polling && event.kind == EventKind::Remove(RemoveKind::Any) {










		                }
		            }
		            EventKind::Modify(ModifyKind::Name(RenameMode::Both))

















		                if self.follow_descriptor() => {
		                    let new_path = event.paths.last().unwrap();
		                    paths.push(new_path.clone());

		                    let new_data = PathData::from_other_with_path(self.files.remove(event_path), new_path);
		                    self.files.insert(
		                        new_path,
		                        new_data,
		                        self.files.get_last().unwrap() == event_path
		                    );


		                    let _ = self.watcher_rx.as_mut().unwrap().unwatch(event_path);
		                    self.watcher_rx.as_mut().unwrap().watch_with_parent(new_path)?;
		                }
		            _ => {}
		        }
				Ok(paths)
			}
		}

		#[allow(clippy::cognitive_complexity, reason = "preserves upstream follow loop")]
		pub fn follow(mut observer: Observer, settings: &Settings) -> TailResult<()> {
			if observer.files.no_files_remaining(settings) && !observer.files.only_stdin_remaining() {
				return Err(TailError::message("no files remaining".to_string()));
			}

			let process = platform::ProcessChecker::new(observer.pid);

			let mut timeout_counter = 0;


			loop {
				if observer.cancel.load(Ordering::Relaxed) {
					break;
				}
				let mut _read_some = false;



				if settings.follow.is_some() && observer.pid != 0 && process.is_dead() {

					break;
				}





				if observer.follow_name_retry() {
					for new_path in &observer.orphans {
						if new_path.exists() {
							let pd = observer.files.get(new_path);
							let md = new_path.metadata().unwrap();
							if md.is_tailable() && pd.reader.is_none() {
								let _ = writeln!(
									observer.stderr,
									"tail: {} has appeared;  following new file",
									pd.display_name.quote()
								);
								observer.files.update_metadata(new_path, Some(md));
								observer.files.update_reader(new_path)?;
								_read_some =
									observer.files.tail_file(new_path, settings.verbose, &mut observer.stdout)?;
								observer
									.watcher_rx
									.as_mut()
									.unwrap()
									.watch_with_parent(new_path)?;
							}
						}
					}
				}



				let rx_result = observer
					.watcher_rx
					.as_mut()
					.unwrap()
					.receiver
					.recv_timeout(settings.sleep_sec.min(Duration::from_millis(100)));

				if rx_result.is_ok() {
					timeout_counter = 0;
				}

				let mut paths = vec![];


				let process_event = |observer: &mut Observer,
				                     event: notify::Event,
				                     settings: &Settings,
				                     paths: &mut Vec<PathBuf>|
				 -> TailResult<()> {
					if let Some(event_path) = event.paths.first()
						&& observer.files.contains_key(event_path)
					{

						let new_paths = observer.handle_event(&event, settings)?;
						for p in new_paths {
							if !paths.contains(&p) {
								paths.push(p);
							}
						}
					}
					Ok(())
				};

				match rx_result {
					Ok(Ok(event)) => {
						process_event(&mut observer, event, settings, &mut paths)?;






						for _ in 0..100 {
							while let Ok(Ok(event)) = observer.watcher_rx.as_mut().unwrap().receiver.try_recv() {
								process_event(&mut observer, event, settings, &mut paths)?;
							}

							std::thread::yield_now();
							std::hint::spin_loop();
						}
					},
					Ok(Err(notify::Error { kind: notify::ErrorKind::Io(e), paths }))
						if e.kind() == std::io::ErrorKind::NotFound =>
					{
						if let Some(event_path) = paths.first()
							&& observer.files.contains_key(event_path)
						{
							let _ = observer
								.watcher_rx
								.as_mut()
								.unwrap()
								.watcher
								.unwatch(event_path);
						}
					},
					Ok(Err(notify::Error { kind: notify::ErrorKind::MaxFilesWatch, .. })) => {
						return Err(TailError::message(format!("{} resources exhausted", text::BACKEND)));
					},
					Ok(Err(e)) => {
						return Err(TailError::message(format!("NotifyError: {}", e)));
					},
					Err(mpsc::RecvTimeoutError::Timeout) => {
						timeout_counter += 1;

						#[cfg(target_os = "linux")]
						if let Ok(false) = ensure_stdout_not_broken() {
							return Ok(());
						}
					},
					Err(e) => {
						return Err(TailError::message(format!("RecvTimeoutError: {}", e)));
					},
				}

				if observer.use_polling && settings.follow.is_some() {



					paths = observer.files.keys().cloned().collect::<Vec<_>>();
				}


				for path in &paths {
					_read_some = observer.files.tail_file(path, settings.verbose, &mut observer.stdout)?;
				}

				if timeout_counter == settings.max_unchanged_stats {











				}
			}

			Ok(())
		}
	}


	#[cfg(not(target_os = "wasi"))]
	pub use watch::{Observer, follow};



	#[cfg(target_os = "wasi")]
	mod wasi_stubs {
		use std::{io::BufRead, path::Path};

		use crate::tail::{TailError, TailResult, args::Settings};

		pub struct Observer {
			pub use_polling: bool,
		}

		impl Observer {
			pub fn from(_settings: &Settings) -> Self {
				Self { use_polling: false }
			}

			#[allow(clippy::unnecessary_wraps, reason = "matches the native observer API")]
			pub fn start(&mut self, _settings: &Settings) -> TailResult<()> {
				Ok(())
			}

			#[allow(clippy::unnecessary_wraps, reason = "matches the native observer API")]
			pub fn add_path(
				&mut self,
				_path: &Path,
				_display_name: &str,
				_reader: Option<Box<dyn BufRead>>,
				_update_last: bool,
			) -> TailResult<()> {
				Ok(())
			}

			#[allow(clippy::unnecessary_wraps, reason = "matches the native observer API")]
			pub fn add_bad_path(
				&mut self,
				_path: &Path,
				_display_name: &str,
				_update_last: bool,
			) -> TailResult<()> {
				Ok(())
			}

			pub fn follow_name_retry(&self) -> bool {
				false
			}
		}

		pub fn follow(_observer: Observer, _settings: &Settings) -> TailResult<()> {
			Err(TailError::message("follow mode is not supported on this platform"))
		}
	}

	#[cfg(target_os = "wasi")]
	pub use wasi_stubs::{Observer, follow};
}

mod parse {





	use std::ffi::OsString;

	#[derive(PartialEq, Eq, Debug, Copy, Clone)]
	pub struct ObsoleteArgs {
		pub num:    u64,
		pub plus:   bool,
		pub lines:  bool,
		pub follow: bool,
	}

	impl Default for ObsoleteArgs {
		fn default() -> Self {
			Self { num: 10, plus: false, lines: true, follow: false }
		}
	}

	#[derive(PartialEq, Eq, Debug)]
	pub enum ParseError {
		Context,
		InvalidEncoding,
	}


	pub fn parse_obsolete(src: &OsString) -> Option<Result<ObsoleteArgs, ParseError>> {
		let Some(mut rest) = src.to_str() else {
			return Some(Err(ParseError::InvalidEncoding));
		};
		let sign = if let Some(r) = rest.strip_prefix('-') {
			rest = r;
			'-'
		} else {
			let r = rest.strip_prefix('+')?;
			rest = r;
			'+'
		};

		let end_num = rest
			.find(|c: char| !c.is_ascii_digit())
			.unwrap_or(rest.len());
		let has_num = !rest[..end_num].is_empty();
		let num: u64 = if has_num {
			rest[..end_num].parse().unwrap_or(u64::MAX)
		} else {
			10
		};
		rest = &rest[end_num..];

		let mode = if let Some(r) = rest.strip_prefix('l') {
			rest = r;
			'l'
		} else if let Some(r) = rest.strip_prefix('c') {
			rest = r;
			'c'
		} else if let Some(r) = rest.strip_prefix('b') {
			rest = r;
			'b'
		} else {
			'l'
		};

		let follow = rest.contains('f');
		if !rest.chars().all(|f| f == 'f') {

			if sign == '-' && has_num {
				return Some(Err(ParseError::Context));
			}
			return None;
		}

		let multiplier = if mode == 'b' { 512 } else { 1 };
		let num = num.saturating_mul(multiplier);

		Some(Ok(ObsoleteArgs { num, plus: sign == '+', lines: mode == 'l', follow }))
	}


}

mod paths {

	#[cfg(unix)]
	use std::os::unix::fs::{FileTypeExt, MetadataExt};
	use std::{
		ffi::OsStr,
		fs::{File, Metadata},
		io::{Seek, SeekFrom, Write},
		path::{Path, PathBuf},
	};

	use crate::{host::Host, tail::{TailResult, text}};

	#[derive(Debug, Clone)]
	pub enum InputKind {
		File(PathBuf),
		Stdin,
	}

	#[cfg(unix)]
	impl From<&OsStr> for InputKind {
		fn from(value: &OsStr) -> Self {
			if value == OsStr::new("-") {
				Self::Stdin
			} else {
				Self::File(PathBuf::from(value))
			}
		}
	}

	#[cfg(not(unix))]
	impl From<&OsStr> for InputKind {
		fn from(value: &OsStr) -> Self {
			if value == OsStr::new(text::DASH) {
				Self::Stdin
			} else {
				Self::File(PathBuf::from(value))
			}
		}
	}

	#[derive(Debug, Clone)]
	pub struct Input {
		kind:             InputKind,
		pub display_name: String,
	}

	impl Input {
		pub fn from<T: AsRef<OsStr>>(string: T) -> Self {
			let string = string.as_ref();

			let kind = string.into();
			let display_name = match kind {
				InputKind::File(_) => string.to_string_lossy().to_string(),
				InputKind::Stdin => "standard input".to_string(),
			};

			Self { kind, display_name }
		}


		pub fn resolve_path(&mut self, host: &Host) {
			if let InputKind::File(path) = &mut self.kind {
				*path = host.resolve(&*path);
			}
		}

		pub fn kind(&self) -> &InputKind {
			&self.kind
		}

		pub fn is_stdin(&self) -> bool {
			match self.kind {
				InputKind::File(_) => false,
				InputKind::Stdin => true,
			}
		}

		pub fn resolve(&self) -> Option<PathBuf> {
			match &self.kind {
				InputKind::File(path) if path != &PathBuf::from(text::DEV_STDIN) => {
					path.canonicalize().ok()
				},
				InputKind::File(_) | InputKind::Stdin => {




					#[cfg(target_os = "macos")]
					{
						None
					}
					#[cfg(not(target_os = "macos"))]
					{
						PathBuf::from(text::FD0).canonicalize().ok()
					}
				},
			}
		}

		pub fn is_tailable(&self) -> bool {
			match &self.kind {
				InputKind::File(path) => path_is_tailable(path),
				InputKind::Stdin => self.resolve().is_some_and(|path| path_is_tailable(&path)),
			}
		}
	}

	impl Default for Input {
		fn default() -> Self {
			Self { kind: InputKind::Stdin, display_name: "standard input".to_string() }
		}
	}

	#[derive(Debug, Default, Clone, Copy)]
	pub struct HeaderPrinter {
		verbose:      bool,
		first_header: bool,
	}

	impl HeaderPrinter {
		pub fn new(verbose: bool, first_header: bool) -> Self {
			Self { verbose, first_header }
		}

		pub fn print_input(&mut self, input: &Input, writer: &mut impl Write) {
			self.print(input.display_name.as_str(), writer);
		}

		pub fn print(&mut self, string: &str, writer: &mut impl Write) {
			if self.verbose {
				let _ = writeln!(
					writer,
					"{}==> {string} <==",
					if self.first_header { "" } else { "\n" },
				);
				self.first_header = false;
			}
		}
	}
	pub trait FileExtTail {
		#[allow(clippy::wrong_self_convention, reason = "preserves upstream file extension trait API")]
		fn is_seekable(&mut self, current_offset: u64) -> bool;
	}

	impl FileExtTail for File {


		fn is_seekable(&mut self, current_offset: u64) -> bool {
			self.stream_position().is_ok()
				&& self.seek(SeekFrom::End(0)).is_ok()
				&& self.seek(SeekFrom::Start(current_offset)).is_ok()
		}
	}

	pub trait MetadataExtTail {
		fn is_tailable(&self) -> bool;
		#[cfg(not(target_os = "wasi"))]
		fn got_truncated(&self, other: &Metadata) -> TailResult<bool>;
		#[cfg(not(target_os = "wasi"))]
		fn file_id_eq(&self, other: &Metadata) -> bool;
	}

	impl MetadataExtTail for Metadata {
		fn is_tailable(&self) -> bool {
			let ft = self.file_type();
			#[cfg(unix)]
			{
				ft.is_file() || ft.is_char_device() || ft.is_fifo()
			}
			#[cfg(not(unix))]
			{
				ft.is_file()
			}
		}


		#[cfg(not(target_os = "wasi"))]
		fn got_truncated(&self, other: &Metadata) -> TailResult<bool> {
			Ok(other.len() < self.len() && other.modified()? != self.modified()?)
		}

		#[cfg(not(target_os = "wasi"))]
		fn file_id_eq(&self, #[cfg(unix)] other: &Metadata, #[cfg(not(unix))] _: &Metadata) -> bool {
			#[cfg(unix)]
			{
				self.ino().eq(&other.ino())
			}
			#[cfg(windows)]
			{









				false
			}
		}
	}

	#[cfg(not(target_os = "wasi"))]
	pub trait PathExtTail {
		fn is_stdin(&self) -> bool;
		fn is_orphan(&self) -> bool;
		fn is_tailable(&self) -> bool;
	}

	#[cfg(not(target_os = "wasi"))]
	impl PathExtTail for Path {
		fn is_stdin(&self) -> bool {
			self.eq(Self::new(text::DASH))
				|| self.eq(Self::new(text::DEV_STDIN))
				|| self.eq(Self::new("standard input"))
		}


		fn is_orphan(&self) -> bool {
			!matches!(self.parent(), Some(parent) if parent.is_dir())
		}


		fn is_tailable(&self) -> bool {
			path_is_tailable(self)
		}
	}

	pub fn path_is_tailable(path: &Path) -> bool {
		path.is_file() || path.exists() && path.metadata().is_ok_and(|meta| meta.is_tailable())
	}
}

mod platform {





	#[cfg(unix)]
	pub use self::unix::{
		Pid,
		ProcessChecker,

		supports_pid_checks,
	};
	#[cfg(windows)]
	pub use self::windows::{Pid, ProcessChecker, supports_pid_checks};


	#[cfg(target_os = "wasi")]
	pub type Pid = u64;

	#[cfg(target_os = "wasi")]
	pub fn supports_pid_checks(_pid: Pid) -> bool {
		false
	}

	#[cfg(unix)]
	mod unix {






		use std::io::Error;

		pub type Pid = libc::pid_t;

		pub struct ProcessChecker {
			pid: Pid,
		}

		impl ProcessChecker {
			pub fn new(process_id: Pid) -> Self {
				Self { pid: process_id }
			}

			pub fn is_dead(&self) -> bool {
				unsafe { libc::kill(self.pid, 0) != 0 && get_errno() != libc::EPERM }
			}
		}

		impl Drop for ProcessChecker {
			fn drop(&mut self) {}
		}

		pub fn supports_pid_checks(pid: Pid) -> bool {
			unsafe { !(libc::kill(pid, 0) != 0 && get_errno() == libc::ENOSYS) }
		}

		#[inline]
		fn get_errno() -> i32 {
			Error::last_os_error().raw_os_error().unwrap()
		}









	}

	#[cfg(windows)]
	mod windows {





		use std::cell::Cell;

		use windows_sys::{
			Win32::{
				Foundation::{CloseHandle, HANDLE, WAIT_FAILED, WAIT_OBJECT_0},
				System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
			},
			core::BOOL,
		};

		pub type Pid = u32;

		pub struct ProcessChecker {
			dead:   Cell<bool>,
			handle: HANDLE,
		}

		impl ProcessChecker {
			pub fn new(process_id: Pid) -> Self {
				#[allow(non_snake_case, reason = "matches the Windows API constant name")]
				let FALSE: BOOL = 0;
				let h = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, FALSE, process_id) };
				Self { dead: Cell::new(h.is_null()), handle: h }
			}

			pub fn is_dead(&self) -> bool {
				if !self.dead.get() {
					self.dead.set(unsafe {
						let status = WaitForSingleObject(self.handle, 0);
						status == WAIT_OBJECT_0 || status == WAIT_FAILED
					});
				}

				self.dead.get()
			}
		}

		impl Drop for ProcessChecker {
			fn drop(&mut self) {
				unsafe {
					CloseHandle(self.handle);
				}
			}
		}

		pub fn supports_pid_checks(_pid: Pid) -> bool {
			true
		}
	}
}

mod text {







	pub const DASH: &str = "-";
	pub const DEV_STDIN: &str = "/dev/stdin";
	#[cfg(not(target_os = "macos"))]
	pub const FD0: &str = "/dev/fd/0";

	#[cfg(target_os = "linux")]
	pub const BACKEND: &str = "inotify";
	#[cfg(all(unix, not(target_os = "linux")))]
	pub const BACKEND: &str = "kqueue";
	#[cfg(target_os = "windows")]
	pub const BACKEND: &str = "ReadDirectoryChanges";
	#[cfg(not(any(unix, target_os = "windows")))]
	pub const BACKEND: &str = "polling";
}

use std::{
	cmp::Ordering,
	ffi::OsString,
	fs::File,
	io::{self, BufReader, ErrorKind, Read, Seek, SeekFrom, Write},
	path::{Path, PathBuf},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::ArgMatches;
use memchr::{memchr_iter, memrchr_iter};
use uucore::display::Quotable;

use crate::host::{Host, Utility, matches_parser, util};

use args::{FilterMode, Settings, Signum};
use chunks::ReverseChunks;
use follow::Observer;
use paths::{FileExtTail, HeaderPrinter, Input, InputKind};


const SIGPIPE_EXIT_CODE: i32 = 141;

#[derive(Debug)]
pub(crate) enum TailError {
	Io(io::Error),
	Message(String),
	BrokenPipe,
}

impl TailError {
	pub(crate) fn message(message: impl Into<String>) -> Self {
		Self::Message(message.into())
	}

	fn code(&self) -> i32 {
		if matches!(self, Self::BrokenPipe) {
			SIGPIPE_EXIT_CODE
		} else {
			1
		}
	}
}

impl std::fmt::Display for TailError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Io(error) => error.fmt(f),
			Self::Message(message) => f.write_str(message),
			Self::BrokenPipe => f.write_str("Broken pipe"),
		}
	}
}

impl std::error::Error for TailError {}

impl From<io::Error> for TailError {
	fn from(error: io::Error) -> Self {
		if error.kind() == ErrorKind::BrokenPipe {
			Self::BrokenPipe
		} else {
			Self::Io(error)
		}
	}
}

pub(crate) type TailResult<T> = Result<T, TailError>;

pub(crate) fn map_output_error(error: io::Error) -> TailError {
	error.into()
}




fn consumes_separate_value(token: &str) -> bool {
	if let Some(long) = token.strip_prefix("--") {
		if long.is_empty() || long.contains('=') {
			return false;
		}


		return ["lines", "bytes", "pid", "sleep-interval", "max-unchanged-stats"]
			.iter()
			.any(|name| name.starts_with(long));
	}
	let Some(cluster) = token.strip_prefix('-') else {
		return false;
	};
	let mut chars = cluster.chars();
	while let Some(c) = chars.next() {
		match c {


			'n' | 'c' | 's' => return chars.next().is_none(),
			'q' | 'v' | 'z' | 'f' | 'F' | 'r' | 'b' => {},
			_ => return false,
		}
	}
	false
}




fn rewrite_tail_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
	let mut rewritten = Vec::with_capacity(argv.len() + 2);
	let mut iter = argv.into_iter();
	rewritten.extend(iter.next());
	let mut follow = false;
	let mut has_operand = false;
	let mut skip_value = false;
	let mut seen_ddash = false;
	for arg in iter {
		if skip_value {
			skip_value = false;
			rewritten.push(arg);
			continue;
		}
		if seen_ddash {
			has_operand = true;
			rewritten.push(arg);
			continue;
		}
		let token = arg.to_string_lossy();
		if token == "--" {
			seen_ddash = true;
			rewritten.push(arg);
			continue;
		}
		let bytes = token.as_bytes();


		let candidate =
			bytes.first() == Some(&b'+') || matches!(bytes, [b'-', b'0'..=b'9', ..]);
		if candidate {
			match parse::parse_obsolete(&arg) {
				Some(Ok(obsolete)) => {
					follow |= obsolete.follow;
					rewritten.push(OsString::from(if obsolete.lines { "-n" } else { "-c" }));
					rewritten.push(OsString::from(format!(
						"{}{}",
						if obsolete.plus { "+" } else { "" },
						obsolete.num
					)));
					continue;
				},
				Some(Err(parse::ParseError::Context)) => {
					return Err(format!(
						"option used in invalid context -- {}",
						token.chars().nth(1).unwrap_or_default()
					));
				},
				Some(Err(parse::ParseError::InvalidEncoding)) => {
					return Err(format!("bad argument encoding: {}", arg.quote()));
				},
				None => {},
			}
		}
		if bytes.len() > 1 && bytes[0] == b'-' {
			skip_value = consumes_separate_value(&token);
		} else {
			has_operand = true;
		}
		rewritten.push(arg);
	}
	if follow {


		rewritten.insert(
			1,
			OsString::from(if has_operand { "--follow=name" } else { "--follow=descriptor" }),
		);
	}
	Ok(rewritten)
}

pub(crate) struct Tail {
	matches: ArgMatches,
}

matches_parser!(Tail, args::uu_app);

impl Utility for Tail {
	fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		rewrite_tail_argv(argv)
	}
	const NAME: &'static str = "tail";

	fn run(self, host: &mut Host) -> i32 {
		if self.matches.get_flag(args::options::REVERSE) {
			return run_reverse(&self.matches, host);
		}
		let mut settings = match Settings::from(&self.matches) {
			Ok(settings) => settings,
			Err(error) => {
				let _ = writeln!(host.stderr, "tail: {error}");
				return error.code();
			},
		};
		settings.resolve_paths(host);

		match tail_main(&settings, host) {
			Ok(()) => host.exit_code(),
			Err(error) => {
				let code = error.code();
				if code != SIGPIPE_EXIT_CODE {
					let _ = writeln!(host.stderr, "tail: {error}");
				}
				code
			},
		}
	}
}


pub(crate) fn tail_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Tail, SE>()
}



fn run_reverse(matches: &ArgMatches, host: &mut Host) -> i32 {
	if matches.contains_id(args::options::BYTES)
		|| matches.get_flag(args::options::BLOCKS)
		|| matches.contains_id(args::options::FOLLOW)
		|| matches.get_flag(args::options::FOLLOW_RETRY)
	{
		let _ = writeln!(
			host.stderr,
			"tail: -r with -c, -b, or -f is not supported by this builtin; pipe through tac"
		);
		return 1;
	}

	let mut settings = match Settings::from(matches) {
		Ok(settings) => settings,
		Err(error) => {
			let _ = writeln!(host.stderr, "tail: {error}");
			return error.code();
		},
	};



	let all_lines = !matches.contains_id(args::options::LINES);
	if all_lines && !settings.verbose {
		let mut argv = vec![OsString::from("tac"), OsString::from("--")];
		if let Some(files) = matches.get_many::<OsString>(args::options::ARG_FILES) {
			argv.extend(files.cloned());
		}
		return crate::tac::run_argv(argv, host);
	}
	settings.resolve_paths(host);

	match reverse_main(&settings, all_lines, host) {
		Ok(()) => host.exit_code(),
		Err(error) => {
			let code = error.code();
			if code != SIGPIPE_EXIT_CODE {
				let _ = writeln!(host.stderr, "tail: {error}");
			}
			code
		},
	}
}

fn reverse_main(settings: &Settings, all_lines: bool, host: &mut Host) -> TailResult<()> {
	let FilterMode::Lines(signum, sep) = &settings.mode else {
		unreachable!("-r with -c is rejected before dispatch");
	};
	let (signum, sep) = (*signum, *sep);
	let mut stdout = host.stdout_writer();
	let mut printer = HeaderPrinter::new(settings.verbose, true);
	for input in &settings.inputs {
		let path = match input.kind() {
			InputKind::File(path) if !(cfg!(unix) && path == &PathBuf::from(text::DEV_STDIN)) => {
				Some(path)
			},
			InputKind::File(_) | InputKind::Stdin => None,
		};
		let mut data = Vec::new();
		if let Some(path) = path {
			if path.is_dir() {
				host.fail(1);
				printer.print_input(input, &mut stdout);
				let _ = writeln!(
					host.stderr,
					"tail: error reading '{}': Is a directory",
					input.display_name
				);
				continue;
			}
			match File::open(path) {
				Ok(mut file) => {
					printer.print_input(input, &mut stdout);
					file.read_to_end(&mut data)?;
				},
				Err(error) if error.kind() == ErrorKind::NotFound => {
					host.fail(1);
					let _ = writeln!(
						host.stderr,
						"tail: cannot open '{}' for reading: No such file or directory",
						input.display_name
					);
					continue;
				},
				Err(error) => {
					host.fail(1);
					let _ = writeln!(
						host.stderr,
						"tail: cannot open '{}' for reading: {error}",
						input.display_name
					);
					continue;
				},
			}
		} else {
			printer.print_input(input, &mut stdout);
			host.stdin.read_to_end(&mut data)?;
		}
		write_reversed_lines(&data, signum, sep, all_lines, &mut stdout)?;
	}
	stdout.flush()?;
	Ok(())
}




fn write_reversed_lines(
	data: &[u8],
	signum: Signum,
	sep: u8,
	all_lines: bool,
	writer: &mut impl Write,
) -> io::Result<()> {
	let mut segments: Vec<&[u8]> = Vec::new();
	let mut start = 0;
	for end in memchr_iter(sep, data) {
		segments.push(&data[start..=end]);
		start = end + 1;
	}
	if start < data.len() {
		segments.push(&data[start..]);
	}
	let keep: &[&[u8]] = if all_lines {
		&segments[..]
	} else {
		match signum {
			Signum::Negative(count) => {
				let count = usize::try_from(count).unwrap_or(usize::MAX);
				&segments[segments.len().saturating_sub(count)..]
			},
			Signum::MinusZero => &[],
			Signum::PlusZero => &segments[..],
			Signum::Positive(count) => {

				let skip = usize::try_from(count.saturating_sub(1)).unwrap_or(usize::MAX);
				&segments[skip.min(segments.len())..]
			},
		}
	};
	for segment in keep.iter().rev() {
		writer.write_all(segment)?;
	}
	writer.flush()
}

fn tail_main(settings: &Settings, host: &mut Host) -> TailResult<()> {
	settings.check_warnings(&mut host.stderr);

	match settings.verify() {
		args::VerificationResult::CannotFollowStdinByName => {
			return Err(TailError::message(format!(
				"cannot follow {} by name",
				text::DASH.quote()
			)));
		},
		args::VerificationResult::NoOutput => return Ok(()),
		args::VerificationResult::Ok => {},
	}

	uu_tail(settings, host)
}

fn uu_tail(settings: &Settings, host: &mut Host) -> TailResult<()> {
	let mut printer = HeaderPrinter::new(settings.verbose, true);
	let mut observer = Observer::from(
		settings,
		host.stdout_writer(),
		host.stderr_clone(),
		host.cancel_flag(),
	);

	observer.start(settings, host)?;

	if settings.debug && settings.follow.is_some() {
		let mode = if observer.use_polling { "polling" } else { "notification" };
		let _ = writeln!(observer.stderr, "tail: using {mode} mode");
	}



	for input in &settings.inputs.clone() {
		match input.kind() {
			InputKind::Stdin => {
				tail_stdin(settings, &mut printer, input, &mut observer, &mut host.stdin)?;
			},
			InputKind::File(path) if cfg!(unix) && path == &PathBuf::from(text::DEV_STDIN) => {
				tail_stdin(settings, &mut printer, input, &mut observer, &mut host.stdin)?;
			},
			InputKind::File(path) => {
				tail_file(settings, &mut printer, input, path, &mut observer, 0, host)?;
			},
		}
	}
	observer.stdout.flush()?;

	if settings.follow.is_some() {









		follow::follow(observer, settings)?;
	}

	Ok(())
}

fn tail_file(
	settings: &Settings,
	header_printer: &mut HeaderPrinter,
	input: &Input,
	path: &Path,
	observer: &mut Observer,
	offset: u64,
	host: &mut Host,
) -> TailResult<()> {
	let fs_path = path;
	let md = fs_path.metadata();
	if let Err(ref e) = md
		&& e.kind() == ErrorKind::NotFound
	{
		host.fail(1);
		let _ = writeln!(
			observer.stderr,
			"tail: cannot open '{}' for reading: No such file or directory",
			input.display_name
		);
		observer.add_bad_path(path, input.display_name.as_str(), false)?;
		return Ok(());
	}

	if fs_path.is_dir() {
		host.fail(1);

		header_printer.print_input(input, &mut observer.stdout);

		let _ = writeln!(
			observer.stderr,
			"tail: error reading '{}': Is a directory",
			input.display_name
		);
		if settings.follow.is_some() {
			let msg = if settings.retry {
				""
			} else {
				"; giving up on this name"
			};
			let _ = writeln!(
				observer.stderr,
				"tail: {}: cannot follow end of this type of file{}",
				input.display_name,
				msg
			);
		}
		if !observer.follow_name_retry() {
			return Ok(());
		}
		observer.add_bad_path(path, input.display_name.as_str(), false)?;
	} else {
		#[cfg(unix)]
		let open_result = open_file(&fs_path, settings.pid != 0);
		#[cfg(not(unix))]
		let open_result = File::open(&fs_path);

		match open_result {
			Ok(mut file) => {
				let st = file.metadata()?;
				let blksize_limit = uucore::fs::sane_blksize::sane_blksize_from_metadata(&st);
				header_printer.print_input(input, &mut observer.stdout);
				let mut reader;
				if !settings.presume_input_pipe
					&& file.is_seekable(if input.is_stdin() { offset } else { 0 })
					&& (!st.is_file() || st.len() > blksize_limit)
				{
					bounded_tail(&mut file, settings, &mut observer.stdout)?;
					reader = BufReader::new(file);
				} else {
					reader = BufReader::new(file);
					unbounded_tail(&mut reader, settings, &mut observer.stdout)?;
				}
				if input.is_tailable() {
					observer.add_path(
						path,
						input.display_name.as_str(),
						Some(Box::new(reader)),
						true,
					)?;
				} else {
					observer.add_bad_path(path, input.display_name.as_str(), false)?;
				}
			},
			Err(e) if e.kind() == ErrorKind::PermissionDenied => {
				observer.add_bad_path(path, input.display_name.as_str(), false)?;
				let message = format!("cannot open '{}' for reading: {e}", input.display_name);
				let _ = writeln!(observer.stderr, "tail: {message}");
				host.fail(1);
			},
			Err(e) => {
				observer.add_bad_path(path, input.display_name.as_str(), false)?;
				return Err(TailError::message(format!(
					"cannot open '{}' for reading: {e}",
					input.display_name
				)));
			},
		}
	}

	Ok(())
}











#[cfg(unix)]
fn open_file(path: &Path, use_nonblock_for_fifo: bool) -> io::Result<File> {
	use std::{
		fs::OpenOptions,
		os::{
			fd::AsFd,
			unix::fs::{FileTypeExt, OpenOptionsExt},
		},
	};

	use rustix::fs::{OFlags, fcntl_getfl, fcntl_setfl};

	let is_fifo = path
		.metadata()
		.ok()
		.is_some_and(|m| m.file_type().is_fifo());

	if is_fifo && use_nonblock_for_fifo {
		let file = OpenOptions::new()
			.read(true)
			.custom_flags(libc::O_NONBLOCK)
			.open(path)?;


		let flags = fcntl_getfl(file.as_fd())?;
		let new_flags = flags & !OFlags::NONBLOCK;
		fcntl_setfl(file.as_fd(), new_flags)?;

		Ok(file)
	} else {
		File::open(path)
	}
}

fn tail_stdin(
	settings: &Settings,
	header_printer: &mut HeaderPrinter,
	input: &Input,
	observer: &mut Observer,
	stdin: &mut impl Read,
) -> TailResult<()> {
	header_printer.print_input(input, &mut observer.stdout);
	let mut reader = BufReader::new(stdin);
	unbounded_tail(&mut reader, settings, &mut observer.stdout)?;
	Ok(())
}
















































fn forwards_thru_file(
	reader: &mut impl Read,
	num_delimiters: u64,
	delimiter: u8,
) -> io::Result<usize> {

	if num_delimiters == 0 {
		return Ok(0);
	}

	let mut buf = [0; 32 * 1024];
	let mut total = 0;
	let mut count = 0;



	loop {
		match reader.read(&mut buf) {


			Ok(0) => return Ok(total),
			Ok(n) => {

				for offset in memchr_iter(delimiter, &buf[..n]) {
					count += 1;
					if count == num_delimiters {

						return Ok(total + offset + 1);
					}
				}
				total += n;
			},
			Err(e) if e.kind() == ErrorKind::Interrupted => (),
			Err(e) => return Err(e),
		}
	}
}




fn backwards_thru_file(file: &mut File, num_delimiters: u64, delimiter: u8) {
	if num_delimiters == 0 {
		file.seek(SeekFrom::End(0)).unwrap();
		return;
	}


	let mut counter = 0;
	let mut first_slice = true;
	for slice in ReverseChunks::new(file) {

		let mut iter = memrchr_iter(delimiter, &slice);


		if first_slice {
			if let Some(c) = slice.last()
				&& *c == delimiter
			{
				iter.next();
			}
			first_slice = false;
		}





		for i in iter {
			counter += 1;
			if counter >= num_delimiters {

				assert_eq!(counter, num_delimiters);




				file.seek(SeekFrom::Current((i + 1) as i64)).unwrap();
				return;
			}
		}
	}
}






fn bounded_tail(file: &mut File, settings: &Settings, writer: &mut impl Write) -> io::Result<()> {
	debug_assert!(!settings.presume_input_pipe);
	let mut limit = None;


	match &settings.mode {
		FilterMode::Lines(Signum::Negative(count), delimiter) => {
			backwards_thru_file(file, *count, *delimiter);
		},
		FilterMode::Lines(Signum::Positive(count), delimiter) if count > &1 => {
			let i = forwards_thru_file(file, *count - 1, *delimiter).unwrap();
			file.seek(SeekFrom::Start(i as u64)).unwrap();
		},
		FilterMode::Lines(Signum::MinusZero, _) => {
			file.seek(SeekFrom::End(0)).unwrap();
		},
		FilterMode::Bytes(Signum::Negative(count)) => {
			if file.seek(SeekFrom::End(-(*count as i64))).is_err() {
				file.seek(SeekFrom::Start(0)).unwrap();
			}
			limit = Some(*count);
		},
		FilterMode::Bytes(Signum::Positive(count)) if count > &1 => {


			file.seek(SeekFrom::Start(*count - 1)).unwrap();
		},
		FilterMode::Bytes(Signum::MinusZero) => {
			file.seek(SeekFrom::End(0)).unwrap();
		},
		_ => {},
	}

	print_target_section(file, limit, writer)?;
	Ok(())
}

fn unbounded_tail<T: Read>(
	reader: &mut BufReader<T>,
	settings: &Settings,
	writer: &mut impl Write,
) -> io::Result<()> {
	match &settings.mode {
		FilterMode::Lines(Signum::Negative(count), sep) => {
			let mut chunks = chunks::LinesChunkBuffer::new(*sep, *count);
			chunks.fill(reader)?;
			chunks.write(&mut *writer)?;
		},

		FilterMode::Lines(Signum::PlusZero | Signum::Positive(1), _) => {
			io::copy(reader, &mut *writer)?;
		},
		FilterMode::Lines(Signum::Positive(count), sep) => {
			let mut num_skip = *count - 1;
			let mut chunk = chunks::LinesChunk::new(*sep);
			while chunk.fill(reader)?.is_some() {
				let lines = chunk.get_lines() as u64;
				if lines < num_skip {
					num_skip -= lines;
				} else {
					break;
				}
			}
			if chunk.has_data() {
				chunk.write_lines(&mut *writer, num_skip as usize)?;
				io::copy(reader, &mut *writer)?;
			}
		},
		FilterMode::Bytes(Signum::Negative(count)) => {
			let mut chunks = chunks::BytesChunkBuffer::new(*count);
			chunks.fill(reader)?;
			chunks.print(&mut *writer)?;
		},
		FilterMode::Lines(Signum::MinusZero, sep) => {
			let mut chunks = chunks::LinesChunkBuffer::new(*sep, 0);
			chunks.fill(reader)?;
			chunks.write(&mut *writer)?;
		},
		FilterMode::Bytes(Signum::PlusZero | Signum::Positive(1)) => {
			io::copy(reader, &mut *writer)?;
		},
		FilterMode::Bytes(Signum::Positive(count)) => {
			let mut num_skip = *count - 1;
			let mut chunk = chunks::BytesChunk::new();
			loop {
				if let Some(bytes) = chunk.fill(reader)? {
					let bytes: u64 = bytes as u64;
					match bytes.cmp(&num_skip) {
						Ordering::Less => num_skip -= bytes,
						Ordering::Equal => {
							break;
						},
						Ordering::Greater => {
							writer.write_all(chunk.get_buffer_with(num_skip as usize))?;
							break;
						},
					}
				} else {
					return Ok(());
				}
			}

			io::copy(reader, &mut *writer)?;
		},
		_ => {},
	}


	writer.flush()?;
	Ok(())
}

fn print_target_section<R>(
	file: &mut R,
	limit: Option<u64>,
	stdout: &mut impl Write,
) -> io::Result<()>
where
	R: Read + ?Sized,
{
	if let Some(limit) = limit {
		let mut reader = file.take(limit);
		io::copy(&mut reader, stdout)?;
	} else {
		io::copy(file, stdout)?;
	}
	Ok(())
}


