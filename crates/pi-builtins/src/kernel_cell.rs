//! JavaScript kernel cells: a `node`/`bun` invocation whose program travels
//! to the agent's kernel over the shell bridge instead of a fresh interpreter
//! process.
//!
//! The builtin decides from [`crate::kernel_route`] whether the invocation is
//! a cell (`-e CODE`, `- CODE` on stdin, or a script under the fleet root).
//! A cell connects to the bridge the agent registered in the shell's
//! environment (`PI_KERNEL_BRIDGE_ADDR`/`PI_KERNEL_BRIDGE_TOKEN`), streams the
//! program's output back into its own descriptors, and relays stdin when the
//! program reads it. Anything the kernel does not model — a script path, an
//! unsupported option, a missing bridge — falls through to the real
//! interpreter, which the builtin runs in a subshell of the caller so the
//! engine still owns its signals and exit status.
//!
//! Cancellation, SIGPIPE and a kernel that exits without a status all end the
//! cell the way the process would have ended: status 130 on cancel, 141 when
//! the output consumer went away, and a fall-through while nothing has been
//! written yet.

use std::{
	ffi::OsString,
	io::{self, ErrorKind, Read, Write},
	net::TcpStream,
	path::{Path, PathBuf},
	time::{Duration, Instant},
};

use tokio_util::sync::CancellationToken;

use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use serde_json::{Value, json};

use crate::{
	host::{Host, ShellCommand},
	kernel_route::{ArgvRoute, KernelArgv, route_argv},
	openfile::{Fd, OpenFile},
};

const ADDR_VAR: &str = "PI_KERNEL_BRIDGE_ADDR";
const TOKEN_VAR: &str = "PI_KERNEL_BRIDGE_TOKEN";
const FLEET_VAR: &str = "PI_KERNEL_FLEET_ROOT";
const CANCEL_GRACE: Duration = Duration::from_secs(2);
const SIGPIPE_EXIT_CODE: i32 = 141;
const READ_TIMEOUT: Duration = Duration::from_millis(100);

/// The interpreter a kernel-cell builtin stands in for.
pub(crate) struct KernelLang {
	pub lang:             &'static str,
	pub argv:             &'static KernelArgv,
	pub fleet_extensions: &'static [&'static str],
	/// PATH names to try, in order, when the invocation falls through to a
	/// real interpreter (the invoked builtin name is always tried first).
	pub interpreters:     &'static [&'static str],
}

/// Runs one `node`/`bun` invocation, as a cell when possible.
pub(crate) fn run_kernel_lang(spec: &KernelLang, argv: &[OsString], host: &mut Host) -> i32 {
	let interpreter = resolve_interpreter(spec, host);
	match plan(spec, argv, host, interpreter.as_deref()) {
		Plan::Cell { code, stdin_body, program_input, invocation } => {
			match run_kernel_cell(
				spec,
				host,
				&code,
				program_input,
				interpreter.as_deref(),
				&invocation,
			) {
				CellOutcome::Exit(code) => code,
				CellOutcome::FallThrough(note) => {
					if let Some(note) = note {
						let _ = writeln!(host.stderr, "{note}");
					}
					spawn_external(spec, host, argv, stdin_body)
				},
			}
		},
		Plan::External { stdin_body } => spawn_external(spec, host, argv, stdin_body),
	}
}

enum Plan {
	Cell {
		code:          String,
		stdin_body:    Option<Vec<u8>>,
		program_input: bool,
		invocation:    Value,
	},
	External {
		stdin_body: Option<Vec<u8>>,
	},
}

fn plan(spec: &KernelLang, argv: &[OsString], host: &mut Host, interpreter: Option<&Path>) -> Plan {
	let args: Vec<Option<&str>> = argv.iter().map(|arg| arg.to_str()).collect();
	match route_argv(spec.argv, &args) {
		ArgvRoute::Code(index) => {
			let program_input = carries_program_input(host);
			let code = args[index].unwrap_or_default();
			let mut arguments = &argv[index + 1..];
			if arguments.first().is_some_and(|arg| arg == "--") {
				arguments = &arguments[1..];
			}
			let invocation = cell_invocation(host, interpreter, None, arguments, None);
			Plan::Cell { code: code.to_string(), stdin_body: None, program_input, invocation }
		},
		ArgvRoute::Script(index) => plan_positional(spec, argv, index, host, interpreter),
		ArgvRoute::External => Plan::External { stdin_body: None },
		ArgvRoute::Stdin => {
			if host.stdin.file().is_terminal() {
				return Plan::External { stdin_body: None };
			}
			let mut body = Vec::new();
			if host.stdin.read_to_end(&mut body).is_err() {
				return Plan::External { stdin_body: Some(body) };
			}
			match str::from_utf8(&body) {
				Ok(code) => {
					let dash = argv.iter().position(|arg| arg == "-");
					let arguments = dash.map_or(&[][..], |index| &argv[index + 1..]);
					let argv0 = dash.map(|_| "-");
					let invocation =
						cell_invocation(host, interpreter, argv0, arguments, Some("<stdin>"));
					Plan::Cell {
						code: code.to_string(),
						stdin_body: Some(body),
						program_input: false,
						invocation,
					}
				},
				Err(_) => Plan::External { stdin_body: Some(body) },
			}
		},
	}
}

fn plan_positional(
	spec: &KernelLang,
	argv: &[OsString],
	index: usize,
	host: &mut Host,
	interpreter: Option<&Path>,
) -> Plan {
	let Some(script) = argv[index].to_str() else {
		return Plan::External { stdin_body: None };
	};
	let candidate = host.paths().resolve(script);
	if !is_fleet_script(spec, host, &candidate) {
		return Plan::External { stdin_body: None };
	}
	let Ok(code) = host.paths().fs().read_to_string(&candidate) else {
		return Plan::External { stdin_body: None };
	};
	let filename = candidate.to_string_lossy();
	let invocation =
		cell_invocation(host, interpreter, Some(&filename), &argv[index + 1..], Some(&filename));
	Plan::Cell { code, stdin_body: None, program_input: false, invocation }
}

/// Program identity belongs to the invocation, not the retained runner
/// bootstrap.
fn cell_invocation(
	host: &Host,
	interpreter: Option<&Path>,
	argv0: Option<&str>,
	arguments: &[OsString],
	filename: Option<&str>,
) -> Value {
	let mut argv = Vec::<String>::new();
	argv.push(
		interpreter
			.map(|path| {
				// Native JS runtimes expose the resolved executable as argv[0].
				std::fs::canonicalize(path)
					.unwrap_or_else(|_| path.to_path_buf())
					.to_string_lossy()
					.into_owned()
			})
			.unwrap_or_else(|| host.name().to_string()),
	);
	if let Some(argv0) = argv0 {
		argv.push(argv0.to_string());
	}
	argv.extend(arguments.iter().map(|arg| arg.to_string_lossy().into_owned()));
	json!({"argv": argv, "filename": filename})
}

fn is_fleet_script(spec: &KernelLang, host: &Host, candidate: &Path) -> bool {
	let Some(root) = host.var(FLEET_VAR).map(PathBuf::from) else {
		return false;
	};
	let extension_matches = candidate
		.extension()
		.and_then(|extension| extension.to_str())
		.is_some_and(|extension| {
			spec
				.fleet_extensions
				.iter()
				.any(|allowed| allowed.trim_start_matches('.') == extension)
		});
	extension_matches && under_root(candidate, &root)
}

fn under_root(candidate: &Path, root: &Path) -> bool {
	if candidate.starts_with(root) {
		return true;
	}
	match (std::fs::canonicalize(candidate), std::fs::canonicalize(root)) {
		(Ok(candidate), Ok(root)) => candidate.starts_with(root),
		_ => false,
	}
}

enum CellOutcome {
	Exit(i32),
	/// Run a real interpreter instead, after printing the kernel's note (if
	/// any).
	FallThrough(Option<String>),
}

/// Reads the cell's stdin when it has no OS descriptor to poll (an engine
/// pipe, a provider file).
///
/// The kernel asks for input one chunk at a time; a request is forwarded to
/// the reader thread, which reads exactly one chunk and wakes the poll loop
/// through a pipe. Dropping the feeder cancels a blocked provider read, so an
/// early-exiting cell releases its upstream writer instead of holding it open.
struct Feeder {
	requests: flume::Sender<()>,
	chunks:   flume::Receiver<io::Result<(Vec<u8>, bool)>>,
	/// Readable once `chunks` holds a result.
	wake:     std::io::PipeReader,
	cancel:   CancellationToken,
}

impl Feeder {
	fn start(mut file: OpenFile) -> std::io::Result<Self> {
		let (wake, mut signal) = std::io::pipe()?;
		let (requests, requested) = flume::bounded(1);
		let (chunk_tx, chunks) = flume::bounded(1);
		let cancel = CancellationToken::new();
		let thread_cancel = cancel.clone();
		std::thread::spawn(move || {
			while requested.recv().is_ok() {
				let mut buf = vec![0u8; 64 * 1024];
				let read = match file.as_vfs() {
					Some(vfs) => vfs.read_until_cancelled(&mut buf, &thread_cancel),
					None => file.read(&mut buf),
				};
				let (chunk, stop) = match read {
					Ok(0) => (Ok((Vec::new(), true)), true),
					Ok(n) => {
						buf.truncate(n);
						(Ok((buf, false)), false)
					},
					Err(err) => (Err(err), true),
				};
				let _ = chunk_tx.send(chunk);
				let _ = signal.write_all(&[1]);
				if stop {
					break;
				}
			}
		});
		Ok(Self { requests, chunks, wake, cancel })
	}

	#[cfg(unix)]
	fn wake_fd(&self) -> std::os::fd::RawFd {
		use std::os::fd::AsRawFd;
		self.wake.as_raw_fd()
	}

	/// Asks for the next chunk.
	fn request(&self) {
		let _ = self.requests.try_send(());
	}

	/// The chunk the reader produced, if it has.
	fn take(&mut self) -> Option<io::Result<(Vec<u8>, bool)>> {
		self.chunks.try_recv().ok()
	}
}

impl Drop for Feeder {
	fn drop(&mut self) {
		self.cancel.cancel();
	}
}

fn run_kernel_cell(
	spec: &KernelLang,
	host: &mut Host,
	code: &str,
	stdin: bool,
	interpreter: Option<&Path>,
	invocation: &Value,
) -> CellOutcome {
	let (Some(addr), Some(token)) = (host.var(ADDR_VAR), host.var(TOKEN_VAR)) else {
		return CellOutcome::FallThrough(None);
	};
	let Ok(mut stream) = TcpStream::connect(addr) else {
		return CellOutcome::FallThrough(None);
	};
	let _ = stream.set_nodelay(true);
	let request = json!({
		"token": token,
		"lang": spec.lang,
		"code": code,
		// The command word as typed and the executable the shell would run for it.
		"program": host.name(),
		"interpreter": interpreter.map(|path| path.to_string_lossy()),
		"cwd": host.cwd().to_string_lossy(),
		"shellEnv": host.env().map(|(key, value)| (key.to_string(), Value::String(value.to_string()))).collect::<serde_json::Map<String, Value>>(),
		"stdin": stdin,
		"invocation": invocation,
	});
	let mut payload = request.to_string();
	payload.push('\n');
	if stream.write_all(payload.as_bytes()).is_err() {
		return CellOutcome::FallThrough(None);
	}
	let _ = stream.set_read_timeout(Some(READ_TIMEOUT));

	let mut buffer = Vec::new();
	let mut chunk = [0u8; 8192];
	let mut streamed = false;
	let mut input_requested = false;
	let mut cancel_deadline: Option<Instant> = None;
	// A stdin with no descriptor (an engine pipe or provider file) is read by
	// a helper thread, one chunk per request.
	let mut feeder = if stdin && host.stdin.file().raw_fd().is_none() {
		match host.stdin.try_clone().and_then(|stdin| Feeder::start(stdin.file().clone())) {
			Ok(feeder) => Some(feeder),
			Err(error) => {
				host.error(format!("cannot read cell stdin: {error}"), 1);
				return CellOutcome::Exit(1);
			},
		}
	} else {
		None
	};
	loop {
		// Our stdout consumer exited (`node -e '…big loop…' | head -1`). A real
		// interpreter takes SIGPIPE here and dies; the cell runs in the kernel
		// process, which never sees the broken pipe, so without this it keeps
		// producing output nobody reads until the command deadline. Ask the kernel to
		// stop and leave; dropping the stream tells it too.
		if host.sigpipe_hit() {
			let _ = stream.write_all(b"{\"t\":\"c\"}\n");
			return CellOutcome::Exit(SIGPIPE_EXIT_CODE);
		}
		if host.is_cancelled() && cancel_deadline.is_none() {
			cancel_deadline = Some(Instant::now() + CANCEL_GRACE);
			let _ = stream.write_all(b"{\"t\":\"c\"}\n");
		}
		if let Some(deadline) = cancel_deadline
			&& Instant::now() >= deadline
		{
			return CellOutcome::Exit(130);
		}
		// Wait for either direction. Never block in stdin.read while the kernel may
		// finish, cancel, or write output before consuming the requested input.
		#[cfg(unix)]
		{
			use std::os::fd::AsRawFd;
			let input_fd = host
				.stdin
				.file()
				.try_borrow_as_fd()
				.ok()
				.map(|fd| fd.as_raw_fd())
				.or_else(|| feeder.as_ref().map(Feeder::wake_fd));
			let mut fds = [
				libc::pollfd { fd: stream.as_raw_fd(), events: libc::POLLIN, revents: 0 },
				libc::pollfd {
					fd:      if input_requested {
						input_fd.unwrap_or(-1)
					} else {
						-1
					},
					events:  libc::POLLIN,
					revents: 0,
				},
			];
			// SAFETY: both descriptors remain owned and open for this call.
			if unsafe { libc::poll(fds.as_mut_ptr(), 2, 100) } <= 0 {
				continue;
			}
			if fds[1].revents != 0 {
				if let Some(feeder) = feeder.as_mut() {
					let mut wake = [0u8; 64];
					let _ = feeder.wake.read(&mut wake);
					if let Some(chunk) = feeder.take() {
						match chunk {
							Ok((bytes, eof)) => {
								let frame =
									json!({"t": "i", "d": BASE64.encode(&bytes), "eof": eof});
								if writeln!(stream, "{frame}").is_err() {
									return CellOutcome::Exit(1);
								}
								input_requested = false;
							},
							Err(error) => {
								host.error(format!("cannot read cell stdin: {error}"), 1);
								return CellOutcome::Exit(1);
							},
						}
					}
				} else {
					let mut bytes = [0u8; 65536];
					match host.stdin.read(&mut bytes) {
						Ok(n) => {
							let frame = json!({"t": "i", "d": BASE64.encode(&bytes[..n]), "eof": n == 0});
							if writeln!(stream, "{frame}").is_err() {
								return CellOutcome::Exit(1);
							}
							input_requested = false;
						},
						Err(error) => {
							host.error(format!("cannot read cell stdin: {error}"), 1);
							return CellOutcome::Exit(1);
						},
					}
				}
			}
			if fds[0].revents == 0 {
				continue;
			}
		}
		match stream.read(&mut chunk) {
			Ok(0) => {
				return if cancel_deadline.is_some() {
					CellOutcome::Exit(130)
				} else if streamed {
					host.error("kernel bridge connection closed unexpectedly", 1);
					CellOutcome::Exit(1)
				} else {
					CellOutcome::FallThrough(None)
				};
			},
			Ok(read) => {
				let mut scan_start = buffer.len();
				buffer.extend_from_slice(&chunk[..read]);
				// Previously buffered bytes contain no delimiter. Scan only new bytes,
				// rather than rescanning a large output frame after every socket read.
				while let Some(offset) = memchr::memchr(b'\n', &buffer[scan_start..]) {
					let newline = scan_start + offset;
					match handle_frame(host, &buffer[..=newline], &mut streamed) {
						FrameOutcome::Continue => {},
						FrameOutcome::Input => {
							streamed = true;
							input_requested = stdin;
							if input_requested && let Some(feeder) = feeder.as_ref() {
								feeder.request();
							}
						},
						FrameOutcome::Exit(code) => return CellOutcome::Exit(code),
						FrameOutcome::FallThrough(note) => {
							return if streamed {
								CellOutcome::Exit(1)
							} else {
								CellOutcome::FallThrough(note)
							};
						},
					}
					drop(buffer.drain(..=newline));
					scan_start = 0;
				}
			},
			Err(err)
				if matches!(
					err.kind(),
					ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
				) => {},
			Err(err) => {
				if streamed {
					host.error(format!("kernel bridge: {err}"), 1);
					return CellOutcome::Exit(1);
				}
				return CellOutcome::FallThrough(None);
			},
		}
	}
}

enum FrameOutcome {
	Continue,
	Input,
	Exit(i32),
	FallThrough(Option<String>),
}

fn handle_frame(host: &mut Host, line: &[u8], streamed: &mut bool) -> FrameOutcome {
	let Ok(frame) = serde_json::from_slice::<Value>(line) else {
		return FrameOutcome::Continue;
	};
	match frame.get("t").and_then(Value::as_str) {
		Some(kind @ ("o" | "e")) => {
			if let Some(data) = frame.get("d").and_then(Value::as_str) {
				let bytes = if frame.get("encoding").and_then(Value::as_str) == Some("base64") {
					match BASE64.decode(data) {
						Ok(bytes) => bytes,
						Err(_) => {
							host.error("invalid binary kernel frame", 1);
							return FrameOutcome::Exit(1);
						},
					}
				} else {
					data.as_bytes().to_vec()
				};
				*streamed = true;
				if kind == "e" {
					let _ = host.stderr.write_all(&bytes);
					let _ = host.stderr.flush();
				} else {
					let _ = host.stdout.write_all(&bytes);
					let _ = host.stdout.flush();
				}
			}
			FrameOutcome::Continue
		},
		Some("i") => FrameOutcome::Input,
		Some("x") => {
			let code = frame.get("c").and_then(Value::as_i64).unwrap_or(0);
			FrameOutcome::Exit(code as i32)
		},
		Some("f") => FrameOutcome::FallThrough(
			frame
				.get("note")
				.and_then(Value::as_str)
				.map(str::to_string),
		),
		_ => FrameOutcome::Continue,
	}
}

/// Runs the real interpreter for an invocation the kernel did not take.
fn spawn_external(
	spec: &KernelLang,
	host: &mut Host,
	argv: &[OsString],
	stdin_body: Option<Vec<u8>>,
) -> i32 {
	let program = host.name().to_string();
	let Some(resolved) = resolve_interpreter(spec, host) else {
		if program.contains('/') {
			let (message, code) = if is_executable_file(&host.paths().resolve(&program)) {
				("Permission denied", 126)
			} else {
				// pi's wording: a command word that names nothing, path or not.
				let _ = writeln!(host.stderr, "command not found: {program}");
				return 127;
			};
			host.error(message, code);
			return code;
		}
		let tried = interpreter_candidates(spec, &program).collect::<Vec<_>>().join(" or ");
		host.error(format!("command not found (no {tried} on PATH)"), 127);
		return 127;
	};
	// `argv` holds the interpreter's arguments only (the command name is the
	// extra's own); the child is presented the name it was invoked as.
	let mut command_argv = Vec::with_capacity(argv.len() + 1);
	command_argv.push(resolved.into_os_string());
	command_argv.extend(argv.iter().cloned());
	let mut command = ShellCommand::new(command_argv).argv0(program.clone());
	if let Some(body) = stdin_body {
		// A program read from stdin has already consumed it; the interpreter
		// gets the same bytes.
		let (reader, mut writer) = match std::io::pipe() {
			Ok(pipe) => pipe,
			Err(error) => {
				host.error(error, 1);
				return 1;
			},
		};
		std::thread::spawn(move || {
			let _ = writer.write_all(&body);
		});
		command = command.stdin(Fd::File(std::fs::File::from(std::os::fd::OwnedFd::from(reader))));
	} else if let Ok(fd) = host.stdin.file().to_fd() {
		command = command.stdin(fd);
	}
	match host.run_command(command) {
		Ok(status) => status.code(),
		Err(error) if error.kind() == ErrorKind::Interrupted => 130,
		Err(error) => {
			let code = match error.kind() {
				ErrorKind::NotFound => 127,
				_ => 126,
			};
			host.error(error, code);
			code
		},
	}
}

/// The executable the shell would run for this command word: a path as
/// given, otherwise a PATH lookup of the name (then its alternates).
fn resolve_interpreter(spec: &KernelLang, host: &Host) -> Option<PathBuf> {
	let program = host.name();
	if program.contains('/') || program.contains('\\') {
		let path = host.paths().resolve(program);
		return is_executable_file(&path).then_some(path);
	}
	interpreter_candidates(spec, program).find_map(|name| resolve_on_path(host, name))
}

/// The invoked name first, then the JavaScript runtime's alternate names.
fn interpreter_candidates<'a>(
	spec: &'a KernelLang,
	program: &'a str,
) -> impl Iterator<Item = &'a str> + 'a {
	let alternates = if spec.interpreters.contains(&program) {
		spec.interpreters
	} else {
		&[]
	};
	std::iter::once(program).chain(
		alternates
			.iter()
			.copied()
			.filter(move |name| *name != program),
	)
}

fn resolve_on_path(host: &Host, program: &str) -> Option<PathBuf> {
	for dir in std::env::split_paths(host.var("PATH").unwrap_or_default()) {
		let base = if dir.is_absolute() {
			dir
		} else {
			host.cwd().join(dir)
		};
		let candidate = host.paths().resolve(base.join(program));
		if is_executable_file(&candidate) {
			return Some(candidate);
		}
	}
	None
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
	use std::os::unix::fs::PermissionsExt;
	std::fs::metadata(path)
		.is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
	path.is_file() || path.with_extension("exe").is_file()
}

/// True when fd 0 carries bytes the invoked program is expected to read
/// itself: a pipe (`cmd | prog`), a redirected file (`prog < f`), or a
/// socket. A terminal or `/dev/null` carries nothing.
#[cfg(unix)]
fn carries_program_input(host: &Host) -> bool {
	let Some(fd) = host.stdin.file().raw_fd() else {
		// No descriptor: an engine pipe or provider file the command reads.
		return host.stdin.file().as_vfs().is_some();
	};
	let mut status = std::mem::MaybeUninit::<libc::stat>::uninit();
	// SAFETY: `fd` is an open descriptor owned by the host's stdin for the
	// duration of the call.
	if unsafe { libc::fstat(fd, status.as_mut_ptr()) } != 0 {
		return false;
	}
	// SAFETY: fstat returned 0, so the struct is initialized.
	let status = unsafe { status.assume_init() };
	let mode = u32::from(status.st_mode) & u32::from(libc::S_IFMT);
	mode == u32::from(libc::S_IFIFO)
		|| mode == u32::from(libc::S_IFREG)
		|| mode == u32::from(libc::S_IFSOCK)
}

#[cfg(not(unix))]
fn carries_program_input(_host: &Host) -> bool {
	false
}
