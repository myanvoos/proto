use std::{
	ffi::OsString,
	io::{ErrorKind, Read, Write},
	net::TcpStream,
	path::{Path, PathBuf},
	process::{Command as ProcessCommand, Stdio},
	time::{Duration, Instant},
};

use brush_core::openfiles::OpenFile;
use clap::{Arg, Command as ClapCommand, builder::ValueParser};
use serde_json::{Value, json};

use crate::host::Host;

const ADDR_VAR: &str = "PI_KERNEL_BRIDGE_ADDR";
const TOKEN_VAR: &str = "PI_KERNEL_BRIDGE_TOKEN";
const FLEET_VAR: &str = "PI_KERNEL_FLEET_ROOT";
const CANCEL_GRACE: Duration = Duration::from_secs(2);
const READ_TIMEOUT: Duration = Duration::from_millis(100);

pub(crate) struct KernelLang {
	pub lang:             &'static str,
	pub code_flag:        &'static str,
	pub passthrough:      &'static [&'static str],
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
	match plan(spec, argv, host) {
		Plan::Cell { code, stdin_body } => match run_kernel_cell(spec, host, &code) {
			CellOutcome::Exit(code) => code,
			CellOutcome::FallThrough => spawn_external(spec, host, argv, stdin_body),
		},
		Plan::External => spawn_external(spec, host, argv, None),
	}
}

enum Plan {
	Cell {
		code:       String,
		stdin_body: Option<Vec<u8>>,
	},
	External,
}

fn plan(spec: &KernelLang, argv: &[OsString], host: &mut Host) -> Plan {
	let mut index = 0;
	while index < argv.len() {
		let Some(arg) = argv[index].to_str() else {
			return Plan::External;
		};
		if spec.passthrough.contains(&arg) {
			index += 1;
			continue;
		}
		if arg == spec.code_flag {
			let code = argv.get(index + 1).and_then(|value| value.to_str());
			let Some(code) = code else {
				return Plan::External;
			};
			if index + 2 < argv.len() {
				return Plan::External;
			}
			return Plan::Cell { code: code.to_string(), stdin_body: None };
		}
		if arg == "-" {
			if index + 1 < argv.len() {
				return Plan::External;
			}
		} else if arg.starts_with('-') {
			return Plan::External;
		} else {
			return plan_positional(spec, argv, index, host);
		}
		index += 1;
	}
	if host.stdin.file().is_terminal() {
		return Plan::External;
	}
	let mut body = Vec::new();
	if host.stdin.read_to_end(&mut body).is_err() {
		return Plan::External;
	}
	match str::from_utf8(&body) {
		Ok(code) => Plan::Cell { code: code.to_string(), stdin_body: Some(body) },
		Err(_) => Plan::External,
	}
}

fn plan_positional(spec: &KernelLang, argv: &[OsString], index: usize, host: &mut Host) -> Plan {
	let Some(script) = argv[index].to_str() else {
		return Plan::External;
	};
	let candidate = host.resolve(script);
	if !is_fleet_script(spec, host, &candidate) {
		return Plan::External;
	}
	let mut code = String::new();
	let read = host
		.open_read(&candidate)
		.and_then(|mut file| file.read_to_string(&mut code));
	if read.is_err() {
		return Plan::External;
	}
	if index + 1 < argv.len() {
		host.error("extra argv after a fleet script is ignored (kernel cells have no argv)", 0);
	}
	Plan::Cell { code, stdin_body: None }
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
	FallThrough,
}

fn run_kernel_cell(spec: &KernelLang, host: &mut Host, code: &str) -> CellOutcome {
	let (Some(addr), Some(token)) = (host.var(ADDR_VAR), host.var(TOKEN_VAR)) else {
		return CellOutcome::FallThrough;
	};
	let Ok(mut stream) = TcpStream::connect(addr) else {
		return CellOutcome::FallThrough;
	};
	let _ = stream.set_nodelay(true);
	let request = json!({
		"token": token,
		"lang": spec.lang,
		"code": code,
		"cwd": host.cwd().to_string_lossy(),
	});
	let mut payload = request.to_string();
	payload.push('\n');
	if stream.write_all(payload.as_bytes()).is_err() {
		return CellOutcome::FallThrough;
	}
	let _ = stream.set_read_timeout(Some(READ_TIMEOUT));

	let mut buffer = Vec::new();
	let mut chunk = [0u8; 8192];
	let mut streamed = false;
	let mut cancel_deadline: Option<Instant> = None;
	loop {
		if host.is_cancelled() && cancel_deadline.is_none() {
			cancel_deadline = Some(Instant::now() + CANCEL_GRACE);
			let _ = stream.write_all(b"{\"t\":\"c\"}\n");
		}
		if let Some(deadline) = cancel_deadline
			&& Instant::now() >= deadline
		{
			return CellOutcome::Exit(130);
		}
		match stream.read(&mut chunk) {
			Ok(0) => {
				return if cancel_deadline.is_some() {
					CellOutcome::Exit(130)
				} else if streamed {
					host.error("kernel bridge connection closed unexpectedly", 1);
					CellOutcome::Exit(1)
				} else {
					CellOutcome::FallThrough
				};
			},
			Ok(read) => {
				buffer.extend_from_slice(&chunk[..read]);
				while let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
					let line: Vec<u8> = buffer.drain(..=newline).collect();
					match handle_frame(host, &line, &mut streamed) {
						FrameOutcome::Continue => {},
						FrameOutcome::Exit(code) => return CellOutcome::Exit(code),
						FrameOutcome::FallThrough => {
							return if streamed {
								CellOutcome::Exit(1)
							} else {
								CellOutcome::FallThrough
							};
						},
					}
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
				return CellOutcome::FallThrough;
			},
		}
	}
}

enum FrameOutcome {
	Continue,
	Exit(i32),
	FallThrough,
}

fn handle_frame(host: &mut Host, line: &[u8], streamed: &mut bool) -> FrameOutcome {
	let Ok(frame) = serde_json::from_slice::<Value>(line) else {
		return FrameOutcome::Continue;
	};
	match frame.get("t").and_then(Value::as_str) {
		Some("o") => {
			if let Some(data) = frame.get("d").and_then(Value::as_str) {
				*streamed = true;
				let _ = host.stdout.write_all(data.as_bytes());
				let _ = host.stdout.flush();
			}
			FrameOutcome::Continue
		},
		Some("e") => {
			if let Some(data) = frame.get("d").and_then(Value::as_str) {
				*streamed = true;
				let _ = host.stderr.write_all(data.as_bytes());
				let _ = host.stderr.flush();
			}
			FrameOutcome::Continue
		},
		Some("x") => {
			let code = frame.get("c").and_then(Value::as_i64).unwrap_or(0);
			FrameOutcome::Exit(code as i32)
		},
		Some("f") => FrameOutcome::FallThrough,
		_ => FrameOutcome::Continue,
	}
}

fn spawn_external(spec: &KernelLang, host: &mut Host, argv: &[OsString], stdin_body: Option<Vec<u8>>) -> i32 {
	let program = host.name().to_string();
	let Some(resolved) = interpreter_candidates(spec, &program).find_map(|name| resolve_on_path(host, name)) else {
		let tried = interpreter_candidates(spec, &program).collect::<Vec<_>>().join(" or ");
		host.error(format!("{program}: command not found (no {tried} on PATH)"), 127);
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
			host.error(format!("{program}: {err}"), 126);
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
				host.error(format!("{program}: {err}"), 1);
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

/// The invoked name first, then the spec's alternates (`python` → `python3`).
fn interpreter_candidates<'a>(spec: &'a KernelLang, program: &'a str) -> impl Iterator<Item = &'a str> + 'a {
	std::iter::once(program).chain(spec.interpreters.iter().copied().filter(move |name| *name != program))
}

fn resolve_on_path(host: &Host, program: &str) -> Option<PathBuf> {
	for dir in std::env::split_paths(host.var("PATH").unwrap_or_default()) {
		if dir.as_os_str().is_empty() {
			continue;
		}
		let base = if dir.is_absolute() { dir } else { host.cwd().join(dir) };
		let candidate = base.join(program);
		if is_executable_file(&candidate) {
			return Some(candidate);
		}
	}
	None
}

fn is_executable_file(path: &Path) -> bool {
	use std::os::unix::fs::PermissionsExt;
	std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}
