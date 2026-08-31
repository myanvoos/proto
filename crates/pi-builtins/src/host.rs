

























#![allow(dead_code, reason = "consumed by the feature-gated utility modules")]

use std::{
	cell::Cell,
	collections::HashMap,
	ffi::OsString,
	io::{self, BufWriter, LineWriter, Read, Write},
	marker::PhantomData,
	panic::{AssertUnwindSafe, catch_unwind},
	path::{Path, PathBuf},
	time::Duration,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
};

use parking_lot::Mutex;

use brush_core::{
	Error, ExecutionContext, ExecutionResult, ShellExtensions,
	builtins::{self, Registration},
	openfiles::{self, OpenFile, OpenFiles},
};






pub(crate) trait Utility: clap::Parser + Send + Sync + 'static {

	const NAME: &'static str;



	const USAGE_ERROR: u8 = 1;







	fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		Ok(argv)
	}






	fn run(self, host: &mut Host) -> i32;
}







pub(crate) struct Host {


	pub stdin:  Stdin,


	pub stdout: OpenFile,





	pub stderr: StreamWriter,

	name:                  String,
	cwd:                   PathBuf,
	env:                   HashMap<String, String>,
	cancel:                Arc<AtomicBool>,
	exit_code:             i32,
	stdin_is_search_input: bool,


	merged_out:            Option<Arc<Mutex<StreamWriter>>>,
}

struct CancelOnDrop(Arc<AtomicBool>);

impl Drop for CancelOnDrop {
	fn drop(&mut self) {
		self.0.store(true, Ordering::Relaxed);
	}
}

impl Host {


	pub fn name(&self) -> &str {
		&self.name
	}


	pub fn cwd(&self) -> &Path {
		&self.cwd
	}






	pub fn resolve(&self, path: impl AsRef<Path>) -> PathBuf {
		let normalized_path = brush_core::sys::fs::normalize_shell_path(path.as_ref());
		let path = normalized_path.as_ref();
		if path.is_absolute() {
			path.to_path_buf()
		} else {
			self.cwd.join(path)
		}
	}





	pub fn var(&self, key: &str) -> Option<&str> {
		self.env.get(key).map(String::as_str)
	}



	pub fn env(&self) -> impl Iterator<Item = (&str, &str)> {
		self.env.iter().map(|(k, v)| (k.as_str(), v.as_str()))
	}





	pub fn is_cancelled(&self) -> bool {
		self.cancel.load(Ordering::Relaxed)
	}



	pub fn cancel_flag(&self) -> Arc<AtomicBool> {
		Arc::clone(&self.cancel)
	}




	pub const fn stdin_is_search_input(&self) -> bool {
		self.stdin_is_search_input
	}



	pub const fn fail(&mut self, code: i32) {
		if code != 0 {
			self.exit_code = code;
		}
	}


	pub const fn exit_code(&self) -> i32 {
		self.exit_code
	}


	pub fn error(&mut self, message: impl std::fmt::Display, code: i32) {
		let _ = writeln!(self.stderr, "{}: {message}", self.name);
		self.fail(code);
	}


	pub fn stdout_clone(&self) -> OpenFile {
		self.stdout.clone()
	}




	pub fn stderr_clone(&self) -> OpenFile {
		self.stderr.dup_file()
	}









	pub fn stdout_writer(&self) -> StreamWriter {
		match &self.merged_out {
			Some(shared) => StreamWriter::Shared(Arc::clone(shared)),
			None => StreamWriter::new(self.stdout.clone()),
		}
	}






	pub fn child_env(&self) -> ChildEnv {
		ChildEnv {
			cwd:    self.cwd.clone(),
			env:    Arc::new(
				self
					.env
					.iter()
					.map(|(k, v)| (k.clone(), v.clone()))
					.collect(),
			),
			stderr: self.stderr.dup_file(),
		}
	}












	pub fn run_captured(
		&mut self,
		command: &mut std::process::Command,
	) -> io::Result<std::process::ExitStatus> {
		command
			.stdin(std::process::Stdio::null())
			.stdout(std::process::Stdio::piped())
			.stderr(std::process::Stdio::piped());
		let mut child = command.spawn()?;

		let mut child_err = child.stderr.take();
		let stderr_thread = std::thread::spawn(move || {
			let mut buf = Vec::new();
			if let Some(err) = child_err.as_mut() {
				let _ = err.read_to_end(&mut buf);
			}
			buf
		});

		if let Some(mut out) = child.stdout.take() {
			let _ = io::copy(&mut out, &mut self.stdout);
		}
		let status = child.wait();
		if let Ok(buf) = stderr_thread.join() {
			let _ = self.stderr.write_all(&buf);
		}
		status
	}
}
















pub(crate) enum StreamWriter {

	Block(BufWriter<OpenFile>),


	Line(LineWriter<OpenFile>),




	Shared(Arc<Mutex<StreamWriter>>),
}

impl StreamWriter {
	const BLOCK_CAPACITY: usize = 64 * 1024;
	const LINE_CAPACITY: usize = 16 * 1024;


	pub fn new(file: OpenFile) -> Self {
		if is_regular_file(&file) { Self::block(file) } else { Self::line(file) }
	}


	pub fn line(file: OpenFile) -> Self {
		Self::Line(LineWriter::with_capacity(Self::LINE_CAPACITY, file))
	}


	pub fn block(file: OpenFile) -> Self {
		Self::Block(BufWriter::with_capacity(Self::BLOCK_CAPACITY, file))
	}





	pub fn dup_file(&self) -> OpenFile {
		match self {
			Self::Block(w) => w.get_ref().clone(),
			Self::Line(w) => w.get_ref().clone(),
			Self::Shared(shared) => shared.lock().dup_file(),
		}
	}



	pub fn is_terminal(&self) -> bool {
		match self {
			Self::Block(w) => w.get_ref().is_terminal(),
			Self::Line(w) => w.get_ref().is_terminal(),
			Self::Shared(shared) => shared.lock().is_terminal(),
		}
	}
}

impl Write for StreamWriter {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		match self {
			Self::Block(w) => w.write(buf),
			Self::Line(w) => w.write(buf),
			Self::Shared(shared) => shared.lock().write(buf),
		}
	}

	fn flush(&mut self) -> io::Result<()> {
		match self {
			Self::Block(w) => w.flush(),
			Self::Line(w) => w.flush(),
			Self::Shared(shared) => shared.lock().flush(),
		}
	}

	fn write_vectored(&mut self, bufs: &[io::IoSlice<'_>]) -> io::Result<usize> {
		match self {
			Self::Block(w) => w.write_vectored(bufs),
			Self::Line(w) => w.write_vectored(bufs),
			Self::Shared(shared) => shared.lock().write_vectored(bufs),
		}
	}
}








pub(crate) fn is_regular_file(file: &OpenFile) -> bool {
	match file {
		OpenFile::File(f) => f.metadata().is_ok_and(|m| m.is_file()),
		_ => false,
	}
}










#[cfg(unix)]
fn same_destination(a: &OpenFile, b: &OpenFile) -> bool {
	use std::os::unix::fs::MetadataExt;
	fn id(file: &OpenFile) -> Option<(u64, u64)> {
		let fd = file.try_borrow_as_fd().ok()?;
		let dup = fd.try_clone_to_owned().ok()?;
		let meta = std::fs::File::from(dup).metadata().ok()?;
		if meta.file_type().is_file() {
			return None;
		}
		Some((meta.dev(), meta.ino()))
	}
	match (id(a), id(b)) {
		(Some(a), Some(b)) => a == b,
		_ => false,
	}
}

#[cfg(not(unix))]
fn same_destination(_a: &OpenFile, _b: &OpenFile) -> bool {
	false
}













#[derive(Clone)]
pub(crate) struct ChildEnv {
	cwd:    PathBuf,
	env:    Arc<Vec<(String, String)>>,
	stderr: OpenFile,
}

impl ChildEnv {





	pub fn command(&self, program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
		let mut command = std::process::Command::new(program);
		command
			.current_dir(&self.cwd)
			.env_clear()
			.envs(self.env.iter().map(|(k, v)| (k, v)))
			.stderr(std::process::Stdio::piped());
		command
	}








	pub fn forward_stderr(
		&self,
		mut child_stderr: std::process::ChildStderr,
	) -> std::thread::JoinHandle<()> {
		let mut stderr = self.stderr.clone();
		std::thread::spawn(move || {
			let _ = io::copy(&mut child_stderr, &mut stderr);
		})
	}
}








pub(crate) struct Stdin {
	file:   OpenFile,
	#[cfg_attr(not(unix), allow(dead_code, reason = "readiness polling is unix-only"))]
	fd:     Option<i32>,
	cancel: Arc<AtomicBool>,
}

impl Stdin {


	pub const fn lock(&mut self) -> &mut Self {
		self
	}



	pub const fn file(&self) -> &OpenFile {
		&self.file
	}
}

impl Read for Stdin {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		if self.cancel.load(Ordering::Relaxed) {
			return Ok(0);
		}
		#[cfg(unix)]
		if let Some(fd) = self.fd {
			loop {
				if self.cancel.load(Ordering::Relaxed) {
					return Ok(0);
				}
				let mut pfd = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };


				let ready = unsafe { libc::poll(&mut pfd, 1, 200) };
				if ready < 0 {
					let err = io::Error::last_os_error();
					if err.kind() == io::ErrorKind::Interrupted {
						continue;
					}
					return Err(err);
				}
				if ready > 0 {
					break;
				}
			}
		}
		self.file.read(buf)
	}
}

thread_local! {





	static PANIC_SCOPE_DEPTH: Cell<usize> = const { Cell::new(0) };
}






#[must_use]
pub fn panic_scope_active() -> bool {
	PANIC_SCOPE_DEPTH.with(|depth| depth.get() > 0)
}

static RAYON_GLOBAL_POOL_AVAILABLE: AtomicBool = AtomicBool::new(true);



pub fn set_rayon_global_pool_available(available: bool) {
	RAYON_GLOBAL_POOL_AVAILABLE.store(available, Ordering::SeqCst);
}


#[must_use]
pub fn rayon_global_pool_available() -> bool {
	RAYON_GLOBAL_POOL_AVAILABLE.load(Ordering::SeqCst)
}



pub(crate) fn format_usage(usage: &str) -> String {
	debug_assert!(
		!usage.contains("{}"),
		"usage strings must name the command explicitly, not via a '{{}}' placeholder"
	);
	usage.replace('\n', "\n       ")
}






pub(crate) fn os_bytes(value: &std::ffi::OsStr) -> Option<&[u8]> {
	#[cfg(unix)]
	{
		use std::os::unix::ffi::OsStrExt;
		Some(value.as_bytes())
	}
	#[cfg(not(unix))]
	{
		value.to_str().map(str::as_bytes)
	}
}



pub(crate) fn os_bytes_lossy(value: &std::ffi::OsStr) -> std::borrow::Cow<'_, [u8]> {
	match os_bytes(value) {
		Some(bytes) => std::borrow::Cow::Borrowed(bytes),
		None => std::borrow::Cow::Owned(value.to_string_lossy().into_owned().into_bytes()),
	}
}








pub(crate) fn parse_duration(input: &str) -> Option<Duration> {
	let trimmed = input.trim();
	if trimmed.is_empty() {
		return None;
	}
	let unsigned = trimmed.strip_prefix('+').unwrap_or(trimmed);
	if unsigned.eq_ignore_ascii_case("inf") || unsigned.eq_ignore_ascii_case("infinity") {
		return Some(Duration::MAX);
	}
	let (number, multiplier) = match trimmed.chars().last()? {
		's' => (&trimmed[..trimmed.len() - 1], 1.0),
		'm' => (&trimmed[..trimmed.len() - 1], 60.0),
		'h' => (&trimmed[..trimmed.len() - 1], 3600.0),
		'd' => (&trimmed[..trimmed.len() - 1], 86400.0),
		ch if ch.is_ascii_alphabetic() => return None,
		_ => (trimmed, 1.0),
	};
	let value = number.parse::<f64>().ok()?;
	if value.is_nan() || value.is_sign_negative() {
		return None;
	}
	if value.is_infinite() {
		return Some(Duration::MAX);
	}

	Duration::try_from_secs_f64(value * multiplier).map_or(Some(Duration::MAX), Some)
}







pub(crate) fn quote_arg(arg: &str) -> String {
	if arg.is_empty() {
		return "''".to_string();
	}
	let safe = arg
		.chars()
		.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '/' | ':' | '+'));
	if safe {
		return arg.to_string();
	}
	let escaped = arg.replace('\'', "'\"'\"'");
	format!("'{escaped}'")
}






pub(crate) fn util<U: Utility, SE: ShellExtensions>() -> Registration<SE> {
	builtins::builtin::<Util<U>, SE>()
}








pub(crate) struct Util<U: Utility> {
	argv:    Vec<String>,
	_marker: PhantomData<fn() -> U>,
}

impl<U: Utility> clap::FromArgMatches for Util<U> {
	fn from_arg_matches(_matches: &clap::ArgMatches) -> Result<Self, clap::Error> {
		Ok(Self { argv: Vec::new(), _marker: PhantomData })
	}

	fn update_from_arg_matches(&mut self, _matches: &clap::ArgMatches) -> Result<(), clap::Error> {
		Ok(())
	}
}

impl<U: Utility> clap::CommandFactory for Util<U> {
	fn command() -> clap::Command {
		U::command()
	}

	fn command_for_update() -> clap::Command {
		U::command_for_update()
	}
}

impl<U: Utility> clap::Parser for Util<U> {}

impl<U: Utility> builtins::Command for Util<U> {
	type Error = Error;

	fn new<I>(args: I) -> Result<Self, clap::Error>
	where
		I: IntoIterator<Item = String>,
	{
		Ok(Self { argv: args.into_iter().collect(), _marker: PhantomData })
	}

	async fn execute<SE: ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		run_utility::<U, SE>(context, self.argv.clone()).await
	}
}


async fn run_utility<U: Utility, SE: ShellExtensions>(
	context: ExecutionContext<'_, SE>,
	argv: Vec<String>,
) -> Result<ExecutionResult, Error> {



	#[cfg_attr(not(unix), expect(unused_mut, reason = "rewritten only on unix"))]
	let mut argv: Vec<OsString> = argv.into_iter().map(OsString::from).collect();
	#[cfg(unix)]
	let process_substitution_fds = materialize_process_substitution_fds(&context, &mut argv)?;

	let argv = match U::rewrite_argv(argv) {
		Ok(argv) => argv,
		Err(message) => {
			let _ = writeln!(context.stderr(), "{}: {message}", U::NAME);
			return Ok(ExecutionResult::new(U::USAGE_ERROR));
		},
	};

	let parsed = match U::try_parse_from(&argv) {
		Ok(parsed) => parsed,
		Err(err) => {


			let rendered = err.to_string();
			if err.use_stderr() {
				let _ = write!(context.stderr(), "{rendered}");
				return Ok(ExecutionResult::new(U::USAGE_ERROR));
			}
			let _ = write!(context.stdout(), "{rendered}");
			return Ok(ExecutionResult::success());
		},
	};

	let mut host = build_host(&context, U::NAME)?;
	let cancel = context.cancel_token();
	let cancel_flag = host.cancel_flag();
	let _cancel_on_drop = CancelOnDrop(Arc::clone(&cancel_flag));
	drop(context);

	let mut handle = tokio::task::spawn_blocking(move || {
		#[cfg(unix)]
		let _process_substitution_fds = process_substitution_fds;
		run_caught::<U>(parsed, &mut host)
	});






	let code = match cancel {
		Some(token) => {
			let token_check = token.clone();
			tokio::select! {
				biased;
				() = token.cancelled() => {
					cancel_flag.store(true, Ordering::Relaxed);
					let _ = (&mut handle).await;
					130
				},
				result = &mut handle => {


					if token_check.is_cancelled() { 130 } else { result.unwrap_or(1) }
				},
			}
		},
		None => handle.await.unwrap_or(1),
	};

	Ok(ExecutionResult::new((code & 0xff) as u8))
}







pub(crate) fn run_caught<U: Utility>(parsed: U, host: &mut Host) -> i32 {
	struct Guard;
	impl Drop for Guard {
		fn drop(&mut self) {
			PANIC_SCOPE_DEPTH.with(|depth| depth.set(depth.get().saturating_sub(1)));
		}
	}
	PANIC_SCOPE_DEPTH.with(|depth| depth.set(depth.get() + 1));
	let _guard = Guard;

	match catch_unwind(AssertUnwindSafe(|| parsed.run(host))) {
		Ok(code) => code,
		Err(_) => {
			let _ = writeln!(host.stderr, "{}: internal error", U::NAME);
			1
		},
	}
}



fn build_host<SE: ShellExtensions>(
	context: &ExecutionContext<'_, SE>,
	name: &str,
) -> Result<Host, Error> {
	let stdin = context.try_fd(OpenFiles::STDIN_FD);


	#[cfg(unix)]
	let stdin_fd: Option<i32> = {
		use std::os::fd::AsRawFd;
		stdin
			.as_ref()
			.and_then(|file| file.try_borrow_as_fd().ok())
			.map(|fd| fd.as_raw_fd())
	};
	#[cfg(not(unix))]
	let stdin_fd: Option<i32> = None;
	let stdin_is_search_input = stdin
		.as_ref()
		.is_some_and(|file| matches!(file, OpenFile::PipeReader(_) | OpenFile::Stream(_)));

	let mut env = HashMap::new();
	for (key, var) in context.shell.env().iter_exported() {
		if var.value().is_set() {
			env.insert(key.clone(), var.value().to_cow_str(context.shell).into_owned());
		}
	}

	let invoked = if context.command_name.is_empty() {
		name.to_string()
	} else {
		context.command_name.clone()
	};



	let cancel = Arc::new(AtomicBool::new(false));

	let stdout = or_null(context.try_fd(OpenFiles::STDOUT_FD))?;
	let stderr_file = or_null(context.try_fd(OpenFiles::STDERR_FD))?;


	let (merged_out, stderr) = if same_destination(&stdout, &stderr_file) {
		let shared = Arc::new(Mutex::new(StreamWriter::new(stderr_file)));
		(Some(Arc::clone(&shared)), StreamWriter::Shared(shared))
	} else {
		(None, StreamWriter::new(stderr_file))
	};

	Ok(Host {
		stdin: Stdin {
			file:   or_null(stdin)?,
			fd:     stdin_fd,
			cancel: Arc::clone(&cancel),
		},
		stdout,
		stderr,
		name: invoked,
		cwd: context.shell.working_dir().to_path_buf(),
		env,
		cancel,
		exit_code: 0,
		stdin_is_search_input,
		merged_out,
	})
}



fn or_null(file: Option<OpenFile>) -> Result<OpenFile, Error> {
	match file {
		Some(file) => Ok(file),
		None => openfiles::null(),
	}
}


#[cfg(unix)]
fn process_substitution_fd(arg: &std::ffi::OsStr) -> Option<brush_core::ShellFd> {
	arg.to_str()?
		.strip_prefix("/dev/fd/")?
		.parse::<brush_core::ShellFd>()
		.ok()
}







#[cfg(unix)]
fn materialize_process_substitution_fds<SE: ShellExtensions>(
	context: &ExecutionContext<'_, SE>,
	argv: &mut [OsString],
) -> Result<Vec<std::os::fd::OwnedFd>, Error> {
	use std::os::fd::AsRawFd;

	let mut fds = Vec::new();
	for arg in argv {
		let Some(shell_fd) = process_substitution_fd(arg) else {
			continue;
		};
		let Some(file) = context.try_fd(shell_fd) else {
			continue;
		};
		let fd = file.try_borrow_as_fd()?.try_clone_to_owned()?;
		*arg = OsString::from(format!("/dev/fd/{}", fd.as_raw_fd()));
		fds.push(fd);
	}
	Ok(fds)
}







#[allow(unused_macros, reason = "used by utility modules, which are feature-gated")]
macro_rules! matches_parser {
	($ty:ident, $app:path) => {
		impl clap::FromArgMatches for $ty {
			fn from_arg_matches(matches: &clap::ArgMatches) -> Result<Self, clap::Error> {
				Ok(Self { matches: matches.clone() })
			}

			fn update_from_arg_matches(
				&mut self,
				matches: &clap::ArgMatches,
			) -> Result<(), clap::Error> {
				self.matches = matches.clone();
				Ok(())
			}
		}

		impl clap::CommandFactory for $ty {
			fn command() -> clap::Command {
				$app()
			}

			fn command_for_update() -> clap::Command {
				$app()
			}
		}

		impl clap::Parser for $ty {}
	};
}

#[allow(unused_imports, reason = "used by utility modules, which are feature-gated")]
pub(crate) use matches_parser;




