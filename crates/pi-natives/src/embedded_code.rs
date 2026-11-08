//! Inline interpreter programs and heredoc file writes inside a shell command,
//! read with the embedded shell's own parser.
//!
//! The command is parsed by [`pi_shell::bash::syntax`], so quoting, heredocs,
//! operators and redirections read exactly as they run. What remains modelled
//! here is the part no shell parser knows: which argv words name an interpreter
//! and where each interpreter's CLI takes its program from. Kernel routing
//! reuses the builtins' own argv rule.
//!
//! Streaming input is expected: an unterminated quote, substitution or
//! compound is closed synthetically so a partial command still yields its code.

use napi_derive::napi;
use pi_shell::bash::syntax::{
	AssignValue, Command, CommandKind, Features, HereDoc, List, ParseErrorKind, Part, Redir,
	RedirFd, RedirOp, RedirTarget, Simple, Word, WordPart, ansi_decode_all, parse_all,
};

/// Program text an interpreter invocation carries inline.
#[napi(object)]
pub struct ShellCodeCell {
	#[napi(ts_type = "\"python\" | \"js\"")]
	pub language: String,
	/// The program as the interpreter receives it.
	pub code:     String,
	/// UTF-16 range of the raw region: heredoc body, or the code word with its
	/// quoting.
	pub start:    u32,
	pub end:      u32,
	/// Executes as a persistent kernel cell rather than a real interpreter.
	pub kernel:   bool,
	/// The command holds shell source besides this interpreter call.
	pub mixed:    bool,
}

/// Source a `cat`/`tee` heredoc writes to a file.
#[napi(object)]
pub struct ShellFileWrite {
	/// Destination path after shell quote removal.
	pub path:  String,
	pub code:  String,
	/// UTF-16 range of the heredoc body.
	pub start: u32,
	pub end:   u32,
}

#[napi(object)]
pub struct ShellEmbeddedCode {
	/// Interpreter programs in source order.
	pub cells:  Vec<ShellCodeCell>,
	/// Heredoc file writes in source order.
	pub writes: Vec<ShellFileWrite>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CodeLanguage {
	Python,
	Js,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CodeCell {
	language: CodeLanguage,
	code:     String,
	start:    usize,
	end:      usize,
	kernel:   bool,
	mixed:    bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileWrite {
	path:  String,
	code:  String,
	start: usize,
	end:   usize,
}

#[derive(Debug, Default)]
struct EmbeddedCode {
	cells:  Vec<CodeCell>,
	writes: Vec<FileWrite>,
}

/// Bound on synthetic closers appended to recover a partial command.
const MAX_RECOVERY_STEPS: usize = 32;

fn offset(value: usize) -> u32 {
	u32::try_from(value).unwrap_or(u32::MAX)
}

/// Find the interpreter programs (`python -c …`, `.venv/bin/python - <<EOF`,
/// `node -e …`) and heredoc file writes in a shell command. Partial
/// (streaming) commands are closed synthetically before scanning.
#[napi(catch_unwind)]
pub fn scan_shell_embedded_code(command: String) -> ShellEmbeddedCode {
	let scan = scan_embedded_code(&command);
	ShellEmbeddedCode {
		cells:  scan
			.cells
			.into_iter()
			.map(|cell| ShellCodeCell {
				language: match cell.language {
					CodeLanguage::Python => "python",
					CodeLanguage::Js => "js",
				}
				.to_owned(),
				code:     cell.code,
				start:    offset(cell.start),
				end:      offset(cell.end),
				kernel:   cell.kernel,
				mixed:    cell.mixed,
			})
			.collect(),
		writes: scan
			.writes
			.into_iter()
			.map(|write| ShellFileWrite {
				path:  write.path,
				code:  write.code,
				start: offset(write.start),
				end:   offset(write.end),
			})
			.collect(),
	}
}

/// Parse `command`, appending the closers the parser is waiting for so a
/// partial (streaming) command still parses.
fn parse_recovering(command: &str) -> Option<pi_shell::bash::syntax::Program> {
	let mut text = command.to_owned();
	for _ in 0..MAX_RECOVERY_STEPS {
		match parse_all(text.as_bytes(), Features::NONE) {
			Ok(program) => return Some(program),
			Err(error) => match error.kind {
				ParseErrorKind::Unmatched(close) => text.push_str(close),
				_ => return None,
			},
		}
	}
	None
}

fn scan_embedded_code(command: &str) -> EmbeddedCode {
	let Some(program) = parse_recovering(command) else {
		return EmbeddedCode::default();
	};
	let solo = program.commands.len() == 1 && is_solo_simple(program.commands[0].list());
	let mut scan =
		Scan { source: command, utf16: utf16_map(command), cells: Vec::new(), writes: Vec::new() };
	for (index, parsed) in program.commands.iter().enumerate() {
		scan.scan_list(parsed.list(), solo && index == 0);
	}
	let mut cells = scan.cells;
	let mut writes = scan.writes;
	cells.sort_by_key(|cell| cell.start);
	writes.sort_by_key(|write| write.start);
	EmbeddedCode { cells, writes }
}

/// Byte offset of every char in `source` as a UTF-16 offset (plus the end).
fn utf16_map(source: &str) -> Vec<usize> {
	let mut map = vec![0; source.len() + 1];
	let mut utf16 = 0;
	for (byte, ch) in source.char_indices() {
		map[byte] = utf16;
		utf16 += ch.len_utf16();
	}
	map[source.len()] = utf16;
	map
}

fn is_solo_simple(list: List<'_>) -> bool {
	let mut items = list.items().into_iter();
	let Some(item) = items.next() else {
		return false;
	};
	if items.next().is_some() {
		return false;
	}
	let and_or = item.and_or();
	if and_or.rest().count() != 0 {
		return false;
	}
	let mut stages = and_or.first().stages().into_iter();
	let Some(stage) = stages.next() else {
		return false;
	};
	if stages.next().is_some() {
		return false;
	}
	match stage.kind() {
		CommandKind::Simple(simple) => {
			simple.assigns().into_iter().next().is_none()
				&& stage.redirs().into_iter().next().is_none()
		},
		_ => false,
	}
}

#[derive(Debug, Clone, Default)]
struct WordValue {
	text:    String,
	/// Carries quoted or literal text, not only expansions.
	literal: bool,
	/// Contains an expansion (`$x`, `$(…)`, `` `…` ``, `~`, `$((…))`).
	dynamic: bool,
}

impl WordValue {
	fn static_text(&self) -> Option<&str> {
		(!self.dynamic).then_some(self.text.as_str())
	}
}

#[derive(Debug, Clone)]
struct WordInfo {
	value: WordValue,
	start: usize,
	end:   usize,
}

impl WordInfo {
	fn new(word: Word<'_>) -> Self {
		let span = word.span();
		Self { value: word_value(word), start: span.lo as usize, end: span.hi as usize }
	}
}

#[derive(Debug, Clone)]
enum Target {
	Word(WordInfo),
	HereDoc { code: String, start: usize, end: usize },
}

#[derive(Debug, Clone)]
struct Redirect {
	fd:     Option<u32>,
	op:     RedirOp,
	target: Target,
}

impl Redirect {
	const fn reads_stdin(&self) -> bool {
		matches!(self.fd, None | Some(0))
			&& matches!(
				self.op,
				RedirOp::In
					| RedirOp::HereDoc { .. }
					| RedirOp::HereString
					| RedirOp::ReadWrite
					| RedirOp::DupIn
			)
	}

	const fn writes_stdout(&self) -> bool {
		match self.op {
			RedirOp::Out | RedirOp::Append | RedirOp::Clobber => matches!(self.fd, None | Some(1)),
			RedirOp::OutErr
			| RedirOp::AppendErr
			| RedirOp::OutErrClobber
			| RedirOp::AppendErrClobber => true,
			_ => false,
		}
	}
}

#[derive(Debug, Default)]
struct CommandInfo {
	words:     Vec<WordInfo>,
	redirects: Vec<Redirect>,
	/// The command is the whole script, with no assignments before it and no
	/// redirections of its own.
	solo:      bool,
}

impl CommandInfo {
	fn stdin(&self) -> Option<&Redirect> {
		self
			.redirects
			.iter()
			.rev()
			.find(|redirect| redirect.reads_stdin())
	}
}

struct Scan<'a> {
	source: &'a str,
	utf16:  Vec<usize>,
	cells:  Vec<CodeCell>,
	writes: Vec<FileWrite>,
}

impl Scan<'_> {
	fn utf16(&self, byte: usize) -> usize {
		self
			.utf16
			.get(byte)
			.copied()
			.unwrap_or_else(|| self.utf16.last().copied().unwrap_or_default())
	}

	fn scan_list(&mut self, list: List<'_>, solo: bool) {
		for item in list.items() {
			let and_or = item.and_or();
			for pipeline in std::iter::once(and_or.first()).chain(and_or.rest().map(|(_, p)| p)) {
				for stage in pipeline.stages() {
					self.scan_command(stage, solo);
				}
			}
		}
	}

	fn scan_command(&mut self, command: Command<'_>, solo: bool) {
		match command.kind() {
			CommandKind::Simple(simple) => self.scan_simple(command, simple, solo),
			CommandKind::Brace(list) | CommandKind::Subshell(list) => self.scan_list(list, false),
			CommandKind::If(branch) => {
				for arm in branch.arms() {
					self.scan_list(arm.cond, false);
					self.scan_list(arm.body, false);
				}
				if let Some(body) = branch.else_body() {
					self.scan_list(body, false);
				}
			},
			CommandKind::While(loop_) => {
				self.scan_list(loop_.cond(), false);
				self.scan_list(loop_.body(), false);
			},
			CommandKind::For(loop_) | CommandKind::Select(loop_) => {
				if let Some(words) = loop_.words() {
					for word in words {
						self.scan_word_subs(word);
					}
				}
				self.scan_list(loop_.body(), false);
			},
			CommandKind::ArithFor(loop_) => self.scan_list(loop_.body(), false),
			CommandKind::Case(case) => {
				self.scan_word_subs(case.word());
				for arm in case.arms() {
					for pattern in arm.patterns() {
						self.scan_word_subs(pattern);
					}
					self.scan_list(arm.body(), false);
				}
			},
			CommandKind::FuncDef(def) => self.scan_command(def.body(), false),
			CommandKind::Coproc(coproc) => self.scan_command(coproc.body(), false),
			CommandKind::Repeat(repeat) => {
				self.scan_word_subs(repeat.count());
				self.scan_list(repeat.body(), false);
			},
			CommandKind::Try(try_) => {
				self.scan_list(try_.body(), false);
				self.scan_list(try_.always(), false);
			},
			CommandKind::AnonFunc(func) => {
				for arg in func.args() {
					self.scan_word_subs(arg);
				}
				self.scan_command(func.body(), false);
			},
			CommandKind::Arith(_) | CommandKind::Cond(_) => {},
		}
	}

	fn scan_simple(&mut self, command: Command<'_>, simple: Simple<'_>, solo: bool) {
		for assign in simple.assigns() {
			if let AssignValue::Scalar(word) = assign.value() {
				self.scan_word_subs(word);
			}
		}
		let mut words = Vec::new();
		for word in simple.words() {
			self.scan_word_subs(word);
			words.push(WordInfo::new(word));
		}
		let mut redirects = Vec::new();
		for redir in command.redirs() {
			if let RedirTarget::Word(word) = redir.target() {
				self.scan_word_subs(word);
			}
			redirects.push(self.redirect_info(redir));
		}
		let info = CommandInfo { words, redirects, solo };
		self.classify(&info);
	}

	fn redirect_info(&self, redir: Redir<'_>) -> Redirect {
		let fd = match redir.fd() {
			Some(RedirFd::Num(fd)) => Some(fd),
			_ => None,
		};
		let op = redir.op();
		let target = match redir.target() {
			RedirTarget::Word(word) => Target::Word(WordInfo::new(word)),
			RedirTarget::HereDoc(here) => {
				let (code, start, end) = self.heredoc_info(redir, here);
				Target::HereDoc { code, start, end }
			},
		};
		Redirect { fd, op, target }
	}

	fn heredoc_info(&self, redir: Redir<'_>, here: HereDoc<'_>) -> (String, usize, usize) {
		let body = here.text();
		let code = String::from_utf8_lossy(body)
			.strip_suffix('\n')
			.map_or_else(|| String::from_utf8_lossy(body).into_owned(), ToOwned::to_owned);
		let line_end = redir.span().hi as usize;
		let body_start = self.source[line_end.min(self.source.len())..]
			.find('\n')
			.map_or(self.source.len(), |offset| line_end + offset + 1);
		let strip = matches!(redir.op(), RedirOp::HereDoc { strip_tabs: true });
		let (start, end) = self.heredoc_range(body_start, here.delim(), strip);
		(code, start, end)
	}

	/// Source range of a heredoc body: from `start` to the newline before the
	/// delimiter line (or the end of the command for an unterminated body).
	fn heredoc_range(&self, start: usize, delim: &[u8], strip: bool) -> (usize, usize) {
		let bytes = self.source.as_bytes();
		let mut line_start = start.min(bytes.len());
		while line_start <= bytes.len() {
			let line_end = bytes[line_start..]
				.iter()
				.position(|&byte| byte == b'\n')
				.map_or(bytes.len(), |offset| line_start + offset);
			let mut line = &bytes[line_start..line_end];
			if strip {
				while line.first() == Some(&b'\t') {
					line = &line[1..];
				}
			}
			if line == delim {
				return (start, line_start.saturating_sub(1).max(start));
			}
			if line_end >= bytes.len() {
				let end = if bytes.last() == Some(&b'\n') && line_end > start {
					line_end - 1
				} else {
					line_end
				};
				return (start, end.max(start));
			}
			line_start = line_end + 1;
		}
		(start, start)
	}

	fn scan_word_subs(&mut self, word: Word<'_>) {
		for part in word.parts() {
			self.scan_part_subs(part);
		}
	}

	fn scan_part_subs(&mut self, part: WordPart<'_>) {
		match part.get() {
			Part::Comsub(comsub) => self.scan_list(comsub.body(), false),
			Part::DQuote(parts) | Part::Locale(parts) => {
				for inner in parts {
					self.scan_part_subs(inner);
				}
			},
			_ => {},
		}
	}

	fn classify(&mut self, command: &CommandInfo) {
		let Some(first) = command.words.first() else {
			return;
		};
		if let Some(interpreter) = first.value.static_text().and_then(Interpreter::named) {
			self.try_cell(command, 0, interpreter);
			return;
		}
		if self.try_write(command) {
			return;
		}
		if !first.value.static_text().is_some_and(is_interpreter_runner) {
			return;
		}
		for (index, word) in command.words.iter().enumerate().skip(1) {
			if let Some(interpreter) = word.value.static_text().and_then(Interpreter::named)
				&& self.try_cell(command, index, interpreter)
			{
				return;
			}
		}
	}

	fn try_cell(&mut self, command: &CommandInfo, index: usize, interpreter: Interpreter) -> bool {
		let args = &command.words[index + 1..];
		let stdin = command.stdin();
		let source = interpreter.program_source(args);
		let (code, start, end) = match source {
			ProgramSource::Arg { index: arg, skip } => {
				let Some(word) = args.get(arg) else {
					return false;
				};
				if !word.value.literal {
					return false;
				}
				(word.value.text.clone(), word.start + skip, word.end)
			},
			ProgramSource::Stdin => {
				let Some(redirect) = stdin else {
					return false;
				};
				match (&redirect.target, redirect.op) {
					(Target::HereDoc { code, start, end }, _) => (code.clone(), *start, *end),
					(Target::Word(word), RedirOp::HereString) => {
						if !word.value.literal {
							return false;
						}
						(word.value.text.clone(), word.start, word.end)
					},
					_ => return false,
				}
			},
			ProgramSource::None => return false,
		};
		if code.trim().is_empty() {
			return false;
		}
		let route = Self::kernel_route(command, index);
		let kernel = match (route, source) {
			(Some(ArgvRoute::Code(code_index)), ProgramSource::Arg { index: arg, skip: 0 }) => {
				code_index == arg
			},
			(Some(ArgvRoute::Stdin), ProgramSource::Stdin) => true,
			_ => false,
		};
		let pure_argv = match route {
			Some(ArgvRoute::Code(_)) => command.redirects.is_empty(),
			Some(ArgvRoute::Stdin) => command.redirects.len() == 1,
			_ => false,
		};
		let mixed = !(command.solo && index == 0 && pure_argv);
		self.cells.push(CodeCell {
			language: interpreter.language,
			code,
			start: self.utf16(start),
			end: self.utf16(end),
			kernel,
			mixed,
		});
		true
	}

	/// The kernel builtin's routing of this invocation, when the shell would
	/// dispatch it to one: a bare builtin name, reached directly or through
	/// wrappers that run builtins in-process.
	fn kernel_route(command: &CommandInfo, index: usize) -> Option<ArgvRoute> {
		let name = command.words[index].value.static_text()?;
		let spec = kernel_builtin_argv(name)?;
		if index > 0 && !dispatches_builtin(&command.words[..index]) {
			return None;
		}
		let argv: Vec<Option<&str>> = command.words[index + 1..]
			.iter()
			.map(|word| Some(word.value.text.as_str()))
			.collect();
		Some(route_argv(spec, &argv))
	}

	fn try_write(&mut self, command: &CommandInfo) -> bool {
		let Some(Target::HereDoc { code, start, end }) =
			command.stdin().map(|redirect| &redirect.target)
		else {
			return false;
		};
		let Some(first) = command.words.first() else {
			return false;
		};
		let path = match first.value.static_text() {
			Some("cat") => {
				if command.words[1..].iter().any(|word| word.value.text != "-") {
					return false;
				}
				let Some(Target::Word(word)) = command
					.redirects
					.iter()
					.rev()
					.find(|redirect| redirect.writes_stdout())
					.map(|redirect| &redirect.target)
				else {
					return false;
				};
				word.value.text.clone()
			},
			Some("tee") => {
				let mut options = true;
				let file = command.words[1..].iter().find(|word| {
					if options && word.value.text == "--" {
						options = false;
						return false;
					}
					!(options && word.value.text.starts_with('-'))
				});
				let Some(file) = file else {
					return false;
				};
				file.value.text.clone()
			},
			_ => return false,
		};
		self.writes.push(FileWrite {
			path,
			code: code.clone(),
			start: self.utf16(*start),
			end: self.utf16(*end),
		});
		true
	}
}

fn word_value(word: Word<'_>) -> WordValue {
	let mut value = WordValue::default();
	append_value(word.parts(), false, &mut value);
	value
}

fn append_value<'t>(
	parts: impl IntoIterator<Item = WordPart<'t>>,
	quoted: bool,
	value: &mut WordValue,
) {
	for part in parts {
		match part.get() {
			Part::Lit(bytes) => {
				if !quoted && bytes.starts_with(b"~") {
					value.dynamic = true;
				}
				value.text.push_str(&String::from_utf8_lossy(bytes));
				value.literal = true;
			},
			Part::Escaped(bytes) | Part::SQuote(bytes) => {
				value.text.push_str(&String::from_utf8_lossy(bytes));
				value.literal = true;
			},
			Part::AnsiC(bytes) => {
				let decoded = ansi_decode_all(bytes);
				let cut = decoded
					.iter()
					.position(|&byte| byte == 0)
					.unwrap_or(decoded.len());
				value
					.text
					.push_str(&String::from_utf8_lossy(&decoded[..cut]));
				value.literal = true;
			},
			Part::DQuote(inner) | Part::Locale(inner) => {
				append_value(inner, true, value);
			},
			Part::Param(_)
			| Part::Comsub(_)
			| Part::Arith(_)
			| Part::ProcSub(_)
			| Part::Compound(_)
			| Part::BadComsub(_)
			| Part::BadSubst(_)
			| Part::Zsh(_) => {
				value.dynamic = true;
			},
			Part::DroppedQuote => {},
		}
	}
}

/// Whether the words before an interpreter only ever reach it as a builtin:
/// the in-process wrappers and their options/durations. `env`, `sudo`, and
/// friends exec a real interpreter instead.
fn dispatches_builtin(prefix: &[WordInfo]) -> bool {
	let Some(head) = prefix.first().and_then(|word| word.value.static_text()) else {
		return false;
	};
	if !is_builtin_dispatcher(head) {
		return false;
	}
	let mut after_option = false;
	prefix[1..].iter().all(|word| {
		let Some(text) = word.value.static_text() else {
			return false;
		};
		let allowed =
			is_builtin_dispatcher(text) || text.starts_with('-') || after_option || is_duration(text);
		after_option = text.starts_with('-') && !text.contains('=');
		allowed
	})
}

fn is_interpreter_runner(word: &str) -> bool {
	let name = word.rsplit('/').next().unwrap_or(word);
	is_builtin_dispatcher(name)
		|| matches!(
			name,
			"uv"
				| "pixi"
				| "poetry"
				| "pipenv"
				| "pdm"
				| "hatch"
				| "rye"
				| "conda"
				| "mamba"
				| "micromamba"
				| "env"
				| "sudo"
				| "doas"
				| "ssh"
				| "xargs"
				| "find"
				| "nice"
				| "ionice"
				| "setsid"
				| "docker"
				| "podman"
		)
}

fn is_builtin_dispatcher(word: &str) -> bool {
	matches!(word, "command" | "builtin" | "nohup" | "time" | "timeout")
}

fn is_duration(word: &str) -> bool {
	let number = word.strip_suffix(['s', 'm', 'h', 'd']).unwrap_or(word);
	!number.is_empty()
		&& number
			.bytes()
			.all(|byte| byte.is_ascii_digit() || byte == b'.')
}

#[derive(Debug, Clone, Copy)]
enum ProgramSource {
	/// The argument at `index` (relative to the interpreter's argv) holds the
	/// program, starting `skip` bytes in (`-cCODE`, `--eval=CODE`).
	Arg { index: usize, skip: usize },
	/// The program is read from stdin.
	Stdin,
	/// A script file or module runs; no inline program.
	None,
}

#[derive(Debug, Clone, Copy)]
struct Interpreter {
	language: CodeLanguage,
}

impl Interpreter {
	/// Classify a command word by its basename: `python`, `python3.12`,
	/// `.venv/bin/python`, `pypy3`, `node`, `bun`, ….
	fn named(word: &str) -> Option<Self> {
		let base = word.rsplit(['/', '\\']).next().unwrap_or(word);
		let base = base.strip_suffix(".exe").unwrap_or(base);
		let versioned = |prefix: &str| base.strip_prefix(prefix).is_some_and(is_version_suffix);
		if versioned("python") || versioned("pypy") {
			return Some(Self { language: CodeLanguage::Python });
		}
		matches!(base, "node" | "nodejs" | "bun").then_some(Self { language: CodeLanguage::Js })
	}

	fn program_source(self, args: &[WordInfo]) -> ProgramSource {
		match self.language {
			CodeLanguage::Python => python_program_source(args),
			CodeLanguage::Js => js_program_source(args),
		}
	}
}

/// `""`, `3`, `3.12`, `3.13t`: the tail of a versioned interpreter name.
fn is_version_suffix(rest: &str) -> bool {
	let rest = rest
		.strip_suffix(|ch: char| ch.is_ascii_lowercase())
		.filter(|trimmed| !trimmed.is_empty())
		.unwrap_or(rest);
	rest.is_empty()
		|| (rest.starts_with(|ch: char| ch.is_ascii_digit())
			&& rest
				.split('.')
				.all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())))
}

/// `CPython`'s command line: `python [option…] (-c cmd | -m mod | file | -)
/// [arg…]`.
fn python_program_source(args: &[WordInfo]) -> ProgramSource {
	let mut index = 0;
	while index < args.len() {
		let Some(arg) = args[index].value.static_text() else {
			return ProgramSource::None;
		};
		match arg {
			"-" => return ProgramSource::Stdin,
			"--" => return stdin_after_double_dash(args, index),
			"--check-hash-based-pycs" => index += 2,
			_ if arg.starts_with("--") => {
				if matches!(
					arg,
					"--help" | "--version" | "--help-env" | "--help-xoptions" | "--help-all"
				) {
					return ProgramSource::None;
				}
				index += 1;
			},
			_ if arg.len() > 1 && arg.starts_with('-') => {
				let cluster = &arg[1..];
				let mut consumed_next = false;
				for (offset, flag) in cluster.char_indices() {
					let rest = &cluster[offset + flag.len_utf8()..];
					match flag {
						'c' if rest.is_empty() => {
							return if index + 1 < args.len() {
								ProgramSource::Arg { index: index + 1, skip: 0 }
							} else {
								ProgramSource::None
							};
						},
						'c' => {
							return ProgramSource::Arg { index, skip: 1 + cluster[..offset].len() + 1 };
						},
						'm' | 'h' | 'V' | '?' => return ProgramSource::None,
						'W' | 'X' => {
							consumed_next = rest.is_empty();
							break;
						},
						_ => {},
					}
				}
				index += if consumed_next { 2 } else { 1 };
			},
			_ => return ProgramSource::None,
		}
	}
	ProgramSource::Stdin
}

/// Node/Bun: `node [option…] (-e code | -p code | file | -) [arg…]`.
fn js_program_source(args: &[WordInfo]) -> ProgramSource {
	let mut index = 0;
	while index < args.len() {
		let Some(arg) = args[index].value.static_text() else {
			return ProgramSource::None;
		};
		match arg {
			"-" => return ProgramSource::Stdin,
			"--" => return stdin_after_double_dash(args, index),
			"-e" | "--eval" | "-p" | "--print" => {
				return if index + 1 < args.len() {
					ProgramSource::Arg { index: index + 1, skip: 0 }
				} else {
					ProgramSource::None
				};
			},
			"-r"
			| "--require"
			| "--import"
			| "--loader"
			| "--experimental-loader"
			| "-C"
			| "--conditions"
			| "--input-type"
			| "--env-file"
			| "--title" => index += 2,
			"-h" | "--help" | "-v" | "--version" => return ProgramSource::None,
			_ => {
				if let Some(eval) = ["--eval=", "--print="]
					.iter()
					.find(|prefix| arg.starts_with(**prefix))
				{
					return ProgramSource::Arg { index, skip: eval.len() };
				}
				if !arg.starts_with('-') {
					return ProgramSource::None;
				}
				index += 1;
			},
		}
	}
	ProgramSource::Stdin
}

fn stdin_after_double_dash(args: &[WordInfo], index: usize) -> ProgramSource {
	match args.get(index + 1).map(|word| word.value.text.as_str()) {
		None | Some("-") => ProgramSource::Stdin,
		Some(_) => ProgramSource::None,
	}
}

// ─── kernel argv routing ───────────────────────────────────────────────

/// The argv grammar a kernel-cell builtin accepts before it falls through.
struct KernelArgv {
	/// Flag whose following argument is the program text (`-c`, `-e`).
	code_flag:   &'static str,
	/// Interpreter flags the kernel honors implicitly and skips over.
	passthrough: &'static [&'static str],
}

const JS_ARGV: KernelArgv = KernelArgv { code_flag: "-e", passthrough: &[] };

/// Where a kernel-cell builtin takes its program from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArgvRoute {
	/// `-c CODE` / `-e CODE` followed by program arguments; the index is CODE's.
	Code(usize),
	/// No program argument: the program is read from stdin.
	Stdin,
	/// A script path at this index.
	Script(usize),
	/// Anything the kernel does not model; a real interpreter runs it.
	External,
}

/// Classify an argv (program name excluded). `None` marks an argument whose
/// text is unknown (non-UTF-8 at run time), which only a real interpreter can
/// take.
fn route_argv(spec: &KernelArgv, argv: &[Option<&str>]) -> ArgvRoute {
	if argv.iter().any(Option::is_none) {
		return ArgvRoute::External;
	}
	let mut index = 0;
	while index < argv.len() {
		let Some(arg) = argv[index] else {
			return ArgvRoute::External;
		};
		if spec.passthrough.contains(&arg) {
			index += 1;
			continue;
		}
		if arg == spec.code_flag {
			if argv.get(index + 1).is_none() {
				return ArgvRoute::External;
			}
			// Node/Bun still parse options until -- or the first positional
			// argument. Leave unsupported options to the native
			// interpreter.
			if argv
				.get(index + 2)
				.and_then(|arg| *arg)
				.is_some_and(|arg| arg.starts_with('-') && arg != "--")
			{
				return ArgvRoute::External;
			}
			return ArgvRoute::Code(index + 1);
		}
		if arg == "-" {
			return ArgvRoute::Stdin;
		}
		if arg.starts_with('-') {
			return ArgvRoute::External;
		}
		return ArgvRoute::Script(index);
	}
	ArgvRoute::Stdin
}

/// Only JavaScript runtimes have implicit persistent-cell routing.
fn kernel_builtin_argv(name: &str) -> Option<&'static KernelArgv> {
	match name {
		"node" | "nodejs" | "bun" if cfg!(unix) => Some(&JS_ARGV),
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn codes(command: &str) -> Vec<String> {
		scan_embedded_code(command)
			.cells
			.into_iter()
			.map(|cell| cell.code)
			.collect()
	}

	#[test]
	fn python_heredoc_and_code_word_yield_programs() {
		assert_eq!(codes("python <<'EOF'\nprint('ok')\nEOF"), ["print('ok')"]);
		assert_eq!(codes("python -c 'print(1)'"), ["print(1)"]);
		assert_eq!(codes("cd sub && python3 - <<EOF\nx = 1\nEOF"), ["x = 1"]);
	}

	#[test]
	fn javascript_runtimes_are_kernel_cells() {
		for command in [
			"node <<'JS'\nconsole.log(1)\nJS",
			"bun - <<'JS'\nconsole.log(1)\nJS",
			"node -e \"console.log(1)\"",
			"bun -e 'console.log(1)'",
		] {
			let scan = scan_embedded_code(command);
			let cell = scan.cells.first().expect(command);
			assert!(cell.kernel, "{command}");
			assert_eq!(cell.code, "console.log(1)");
		}
	}

	#[test]
	fn unfinished_quotes_and_substitutions_are_closed() {
		assert_eq!(codes("python -c 'print(1"), ["print(1"]);
		assert_eq!(codes("echo \"$(python -c 'import os"), ["import os"]);
	}

	#[test]
	fn heredoc_file_writes_are_extracted() {
		let scan = scan_embedded_code("cat > src/foo.ts <<'EOF'\nconst x: number = 1;\nEOF");
		assert_eq!(scan.writes.len(), 1);
		assert_eq!(scan.writes[0].path, "src/foo.ts");
		assert_eq!(scan.writes[0].code, "const x: number = 1;");
		assert_eq!((scan.writes[0].start, scan.writes[0].end), (25, 45));
	}

	#[test]
	fn tab_stripped_heredoc_reports_the_interpreter_program() {
		let scan = scan_embedded_code("\tpython <<-EOF\n\ty = 2\n\tEOF");
		assert_eq!(scan.cells[0].code, "y = 2");
	}

	#[test]
	fn code_cell_spans_address_the_raw_source_in_utf16() {
		let command =
			"python -c 'print(1)' && node -e 'console.log(2)' && python <<'PY'\nprint(3)\nPY";
		let scan = scan_embedded_code(command);
		let slices: Vec<_> = scan
			.cells
			.iter()
			.map(|cell| &command[cell.start..cell.end])
			.collect();
		assert_eq!(slices, ["'print(1)'", "'console.log(2)'", "print(3)"]);

		// `😀` is two UTF-16 units: the heredoc body starts at 35, not its byte
		// offset.
		let command = "echo 😀é && python <<-EOF | grep x\n\tprint('ü')\n\tEOF\necho";
		let scan = scan_embedded_code(command);
		let cell = &scan.cells[0];
		assert_eq!(cell.code, "print('ü')");
		assert_eq!((cell.start, cell.end), (35, 46));
	}
}
