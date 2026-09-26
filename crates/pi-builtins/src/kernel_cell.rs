use std::{
	ffi::OsString,
	io::{ErrorKind, Read, Write},
	net::TcpStream,
	path::{Path, PathBuf},
	process::{Command as ProcessCommand, Stdio},
	time::{Duration, Instant},
};

use ::base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use brush_core::openfiles::OpenFile;
use clap::{Arg, Command as ClapCommand, builder::ValueParser};
use serde_json::{Value, json};

use crate::{
	host::Host,
	kernel_route::{ArgvRoute, KernelArgv, kernel_builtin_alias, route_argv},
};

const ADDR_VAR: &str = "PI_KERNEL_BRIDGE_ADDR";
const TOKEN_VAR: &str = "PI_KERNEL_BRIDGE_TOKEN";
const FLEET_VAR: &str = "PI_KERNEL_FLEET_ROOT";
const CANCEL_GRACE: Duration = Duration::from_secs(2);
const SIGPIPE_EXIT_CODE: i32 = 141;
const READ_TIMEOUT: Duration = Duration::from_millis(100);

pub(crate) struct KernelLang {
	pub lang:             &'static str,
	pub argv:             &'static KernelArgv,
	pub fleet_extensions: &'static [&'static str],
	/// PATH names to try, in order, when the invocation falls through to a real
	/// interpreter (the invoked builtin name is always tried first). Lets
	/// `python file.py` find `python3` on hosts that ship no `python`.
	pub interpreters:     &'static [&'static str],
}

pub(crate) fn kernel_lang_app(name: &'static str) -> ClapCommand {
	ClapCommand::new(name)
		.disable_help_flag(true)
		.disable_version_flag(true)
		.arg(
			Arg::new("args")
				.value_name("args")
				.value_parser(ValueParser::os_string())
				.allow_hyphen_values(true)
				.trailing_var_arg(true)
				.num_args(0..),
		)
}

pub(crate) fn run_kernel_lang(spec: &KernelLang, argv: &[OsString], host: &mut Host) -> i32 {
	let interpreter = resolve_interpreter(spec, host);
	if interpreter.is_none() && kernel_builtin_alias(host.name()).is_some() {
		// A named interpreter that does not exist: report it exactly as the shell
		// would.
		return spawn_external(spec, host, argv, None);
	}
	if let Some(observation) = &host.command_observation {
		observation.route(spec.lang);
	}
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
			let program_input = host.stdin.carries_program_input();
			let code = args[index].unwrap_or_default();
			{
				let mut arguments = &argv[index + 1..];
				if spec.lang != "py" && arguments.first().is_some_and(|arg| arg == "--") {
					arguments = &arguments[1..];
				}
				let invocation = cell_invocation(
					spec,
					host,
					interpreter,
					(spec.lang == "py").then_some("-c"),
					arguments,
					None,
				);
				Plan::Cell { code: code.to_string(), stdin_body: None, program_input, invocation }
			}
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
					let argv0 = if dash.is_some() {
						Some("-")
					} else if spec.lang == "py" {
						Some("")
					} else {
						None
					};
					let invocation =
						cell_invocation(spec, host, interpreter, argv0, arguments, Some("<stdin>"));
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
	let candidate = host.resolve(script);
	if !is_fleet_script(spec, host, &candidate) {
		return Plan::External { stdin_body: None };
	}
	let mut code = String::new();
	let read = host
		.open_read(&candidate)
		.and_then(|mut file| file.read_to_string(&mut code));
	if read.is_err() {
		return Plan::External { stdin_body: None };
	}
	let filename = candidate.to_string_lossy();
	let invocation = cell_invocation(
		spec,
		host,
		interpreter,
		Some(&filename),
		&argv[index + 1..],
		Some(&filename),
	);
	Plan::Cell { code, stdin_body: None, program_input: false, invocation }
}

/// Program identity belongs to the invocation, not the retained runner
/// bootstrap.
fn cell_invocation(
	spec: &KernelLang,
	host: &Host,
	interpreter: Option<&Path>,
	argv0: Option<&str>,
	arguments: &[OsString],
	filename: Option<&str>,
) -> Value {
	let mut argv = Vec::<String>::new();
	if spec.lang != "py" {
		argv.push(
			interpreter
				.map(|path| path.to_string_lossy().into_owned())
				.unwrap_or_else(|| host.name().to_string()),
		);
	}
	if let Some(argv0) = argv0 {
		argv.push(argv0.to_string());
	}
	argv.extend(
		arguments
			.iter()
			.map(|arg| arg.to_string_lossy().into_owned()),
	);
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
		"interpreter": interpreter.map(|path| path.to_string_lossy()),		"cwd": host.cwd().to_string_lossy(),
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
	loop {
		// Our stdout consumer exited (`python -c '…big loop…' | head -1`). A real
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
				.map(|fd| fd.as_raw_fd());
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

fn spawn_external(
	spec: &KernelLang,
	host: &mut Host,
	argv: &[OsString],
	stdin_body: Option<Vec<u8>>,
) -> i32 {
	if let Some(observation) = &host.command_observation {
		observation.route("external");
	}
	let program = host.name().to_string();
	let Some(resolved) = resolve_interpreter(spec, host) else {
		if program.contains('/') {
			let (message, code) = if host.resolve(&program).exists() {
				("Permission denied", 126)
			} else {
				("No such file or directory", 127)
			};
			host.error(message, code);
			return code;
		}
		let tried = interpreter_candidates(spec, &program)
			.collect::<Vec<_>>()
			.join(" or ");
		host.error(format!("command not found (no {tried} on PATH)"), 127);
		return 127;
	};
	let mut command = ProcessCommand::new(resolved);
	command
		.args(argv)
		.current_dir(host.cwd())
		.env_clear()
		.envs(host.env());
	command.stdin(match &stdin_body {
		Some(_) => Stdio::piped(),
		None => stdio_of(host.stdin.file()).unwrap_or_else(Stdio::null),
	});
	command.stdout(stdio_of(&host.stdout).unwrap_or_else(Stdio::null));
	command.stderr(stdio_of(&host.stderr_clone()).unwrap_or_else(Stdio::null));

	let mut child = match command.spawn() {
		Ok(child) => child,
		Err(err) => {
			host.error(err, 126);
			return 126;
		},
	};
	let writer = stdin_body.and_then(|body| {
		let mut child_stdin = child.stdin.take()?;
		Some(std::thread::spawn(move || {
			let _ = child_stdin.write_all(&body);
		}))
	});
	let code = loop {
		if host.is_cancelled() {
			let _ = child.kill();
			let _ = child.wait();
			break 130;
		}
		match child.try_wait() {
			Ok(Some(status)) => break exit_code(status),
			Ok(None) => std::thread::sleep(Duration::from_millis(20)),
			Err(err) => {
				host.error(err, 1);
				break 1;
			},
		}
	};
	if let Some(writer) = writer {
		let _ = writer.join();
	}
	code
}

fn exit_code(status: std::process::ExitStatus) -> i32 {
	#[cfg(unix)]
	{
		use std::os::unix::process::ExitStatusExt;
		if let Some(signal) = status.signal() {
			return 128 + signal;
		}
	}
	status.code().unwrap_or(1)
}

fn stdio_of(file: &OpenFile) -> Option<Stdio> {
	let fd = file.try_borrow_as_fd().ok()?;
	let owned = fd.try_clone_to_owned().ok()?;
	Some(Stdio::from(owned))
}

/// The executable the shell would run for this command word: a path as
/// given, otherwise a PATH lookup of the name (then its alternates).
fn resolve_interpreter(spec: &KernelLang, host: &Host) -> Option<PathBuf> {
	let program = host.name();
	if program.contains('/') {
		let path = host.resolve(program);
		return is_executable_file(&path).then_some(path);
	}
	interpreter_candidates(spec, program).find_map(|name| resolve_on_path(host, name))
}

/// The invoked name first, then the spec's alternates (`python` → `python3`).
/// A version-specific name (`python3.13`) has none: nothing else stands in for
/// it.
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
		let candidate = base.join(program);
		if is_executable_file(&candidate) {
			return Some(candidate);
		}
	}
	None
}

fn is_executable_file(path: &Path) -> bool {
	use std::os::unix::fs::PermissionsExt;
	std::fs::metadata(path)
		.is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}
