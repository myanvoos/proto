//! Static scan of a shell command for the program text it hands to
//! interpreters (`python -c …`, `.venv/bin/python - "$f" <<EOF`, `node -e …`)
//! and the source it writes through heredocs (`cat > f.py <<EOF`).
//!
//! The command is tokenized by the brush tokenizer the embedded shell executes
//! with, so quoting, heredocs, operators and redirections read exactly as they
//! run. What remains modelled here is the part no shell parser knows: which
//! argv words name an interpreter and where each interpreter's CLI takes its
//! program from. Kernel routing reuses the builtins' own argv rule.
//!
//! Streaming input is expected: an unterminated heredoc, quote or substitution
//! is closed synthetically so a partial command still yields its code.

use std::sync::LazyLock;

use brush_core::escape::{EscapeExpansionMode, expand_backslash_escapes};
use brush_parser::{
	ParserOptions, Token, TokenizerError, TokenizerOptions, uncached_tokenize_str, unquote_str,
	word::{self, WordPiece, WordPieceWithSource},
};

use crate::kernel_route::{ArgvRoute, kernel_builtin_argv, route_argv};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodeLanguage {
	Python,
	Js,
}

/// Program text an interpreter invocation carries inline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeCell {
	pub language: CodeLanguage,
	/// The program as the interpreter receives it.
	pub code:     String,
	/// UTF-16 range of the raw region in the command: the heredoc body, or the
	/// code word with its quoting.
	pub start:    usize,
	pub end:      usize,
	/// Executes as a persistent kernel cell (vs. a real interpreter process).
	pub kernel:   bool,
	/// The command holds shell source besides this interpreter call.
	pub mixed:    bool,
}

/// Source a `cat`/`tee` heredoc writes to a file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileWrite {
	/// Destination path after shell quote removal.
	pub path:  String,
	pub code:  String,
	/// UTF-16 range of the heredoc body in the command.
	pub start: usize,
	pub end:   usize,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct EmbeddedCode {
	/// Interpreter programs in source order.
	pub cells:  Vec<CodeCell>,
	/// Heredoc file writes in source order.
	pub writes: Vec<FileWrite>,
}

static PARSER_OPTIONS: LazyLock<ParserOptions> = LazyLock::new(ParserOptions::default);
static TOKENIZER_OPTIONS: LazyLock<TokenizerOptions> =
	LazyLock::new(|| PARSER_OPTIONS.tokenizer_options());

/// Bound on synthetic closers appended to recover a partial command.
const MAX_RECOVERY_STEPS: usize = 32;

/// Scan `command` for inline interpreter programs and heredoc file writes.
#[must_use]
pub fn scan_embedded_code(command: &str) -> EmbeddedCode {
	let Some((text, tokens)) = tokenize_recovering(command) else {
		return EmbeddedCode::default();
	};
	let source = Source::new(command, text);
	let mut scan = Scan { source: &source, cells: Vec::new(), writes: Vec::new() };
	scan.scan_tokens(&tokens, 0, source.chars(), false);
	let mut cells = scan.cells;
	let mut writes = scan.writes;
	cells.sort_by_key(|cell| cell.start);
	writes.sort_by_key(|write| write.start);
	EmbeddedCode { cells, writes }
}

/// Tokenize `command`, appending closers for whatever a partial command left
/// open. Returns the closed text with its tokens. Bypasses brush's tokenizer
/// memo: every streamed prefix is a new string, so caching would only pin up
/// to 64 large command copies.
fn tokenize_recovering(command: &str) -> Option<(String, Vec<Token>)> {
	let mut text = command.to_owned();
	for _ in 0..MAX_RECOVERY_STEPS {
		let error = match uncached_tokenize_str(&text, &TOKENIZER_OPTIONS) {
			Ok(tokens) => return Some((text, tokens)),
			Err(error) => error,
		};
		match error {
			TokenizerError::UnterminatedHereDocuments(tag, _) => {
				if !text.ends_with('\n') {
					text.push('\n');
				}
				text.push_str(&unquote_str(&tag));
				text.push('\n');
			},
			TokenizerError::UnterminatedSingleQuote(_) | TokenizerError::UnterminatedAnsiCQuote(_) => {
				text.push('\'');
			},
			TokenizerError::UnterminatedDoubleQuote(_) => text.push('"'),
			TokenizerError::UnterminatedBackquote(_) => text.push('`'),
			TokenizerError::UnterminatedExtendedGlob(_) => text.push(')'),
			TokenizerError::UnterminatedCommandSubstitution
			| TokenizerError::UnterminatedExpansion
			| TokenizerError::UnterminatedVariable => {
				// The error does not say whether `$(` or `${` is open: take the
				// closer that resolves it, else `)` and let the next pass continue.
				let closer = [")", "}"]
					.into_iter()
					.find(|closer| {
						!matches!(
							uncached_tokenize_str(&format!("{text}{closer}"), &TOKENIZER_OPTIONS),
							Err(
								TokenizerError::UnterminatedCommandSubstitution
									| TokenizerError::UnterminatedExpansion
									| TokenizerError::UnterminatedVariable
							)
						)
					})
					.unwrap_or(")");
				text.push_str(closer);
			},
			TokenizerError::UnterminatedEscapeSequence => {
				text.pop();
			},
			_ => return None,
		}
	}
	None
}

/// The (possibly recovery-extended) command text addressed by char index, the
/// unit brush token locations use.
struct Source {
	text:           String,
	/// Byte offset of each char index in `text` (plus the end).
	byte_at:        Vec<usize>,
	/// UTF-16 offset of each char index of the original command (plus the end).
	utf16_at:       Vec<usize>,
	original_chars: usize,
}

impl Source {
	fn new(original: &str, text: String) -> Self {
		let mut byte_at: Vec<usize> = text.char_indices().map(|(byte, _)| byte).collect();
		byte_at.push(text.len());
		let mut utf16_at = Vec::with_capacity(byte_at.len());
		let mut utf16 = 0;
		for ch in original.chars() {
			utf16_at.push(utf16);
			utf16 += ch.len_utf16();
		}
		utf16_at.push(utf16);
		let original_chars = utf16_at.len() - 1;
		Self { text, byte_at, utf16_at, original_chars }
	}

	fn chars(&self) -> usize {
		self.byte_at.len() - 1
	}

	fn slice(&self, start: usize, end: usize) -> &str {
		let end = end.min(self.chars());
		&self.text[self.byte_at[start.min(end)]..self.byte_at[end]]
	}

	fn char_at(&self, index: usize) -> Option<char> {
		self.slice(index, index + 1).chars().next()
	}

	/// UTF-16 offset of a char index, clamped to the original command so a
	/// synthetic closer never leaks into a reported range.
	fn utf16(&self, index: usize) -> usize {
		self.utf16_at[index.min(self.original_chars)]
	}

	/// Brush reports some token starts at the whitespace before the token; move
	/// such a start onto the token text.
	fn snap(&self, mut start: usize, end: usize) -> usize {
		while start < end {
			match self.char_at(start) {
				Some(' ' | '\t') => start += 1,
				Some('\\') if self.char_at(start + 1) == Some('\n') => start += 2,
				_ => break,
			}
		}
		start
	}

	/// End of the line starting at `index` (the `\n` index, or the text end).
	fn line_end(&self, index: usize) -> usize {
		let from = self.byte_at[index.min(self.chars())];
		self.text[from..]
			.find('\n')
			.map_or(self.chars(), |offset| index + self.text[from..from + offset].chars().count())
	}
}

#[derive(Debug, Clone)]
struct WordTok {
	raw:   String,
	start: usize,
	end:   usize,
}

#[derive(Debug, Clone)]
enum Target {
	Word(WordTok),
	HereDoc(HereDoc),
	Missing,
}

#[derive(Debug, Clone)]
struct HereDoc {
	/// Body as the program reads it (tab-stripped for `<<-`), final newline kept.
	body:          String,
	body_start:    usize,
	/// End of the raw body, excluding the newline before the terminator line.
	body_end:      usize,
	/// End of the terminator line, including its newline.
	consumed_end:  usize,
}

#[derive(Debug, Clone)]
struct Redirect {
	fd:     Option<u32>,
	op:     String,
	target: Target,
}

impl Redirect {
	fn reads_stdin(&self) -> bool {
		matches!(self.fd, None | Some(0)) && matches!(self.op.as_str(), "<" | "<<" | "<<-" | "<<<" | "<>" | "<&")
	}

	fn writes_stdout(&self) -> bool {
		match self.op.as_str() {
			">" | ">>" | ">|" => matches!(self.fd, None | Some(1)),
			"&>" | "&>>" => true,
			_ => false,
		}
	}
}

#[derive(Debug, Default)]
struct Command {
	words:     Vec<WordTok>,
	redirects: Vec<Redirect>,
	piped_in:  bool,
	/// Parsed as something other than a simple command (a function
	/// definition, `for`/`case` header, `[[ … ]]`, or a syntax error).
	invalid:   bool,
	start:     Option<usize>,
	end:       usize,
}

impl Command {
	fn is_empty(&self) -> bool {
		self.words.is_empty() && self.redirects.is_empty()
	}

	fn extend(&mut self, start: usize, end: usize) {
		self.start = Some(self.start.map_or(start, |current| current.min(start)));
		self.end = self.end.max(end);
	}

	/// The redirect stdin ends up reading (the last one wins).
	fn stdin(&self) -> Option<&Redirect> {
		self.redirects.iter().rev().find(|redirect| redirect.reads_stdin())
	}
}

/// A word after shell quote removal. Expansions keep their source text since
/// their value is only known at run time.
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

fn word_value(raw: &str) -> WordValue {
	let mut value = WordValue::default();
	match word::parse(raw, &PARSER_OPTIONS) {
		Ok(pieces) => {
			for piece in &pieces {
				push_piece(&mut value, raw, piece);
			}
		},
		Err(_) => {
			value.text = raw.to_owned();
			value.literal = true;
			value.dynamic = true;
		},
	}
	value
}

fn push_piece(value: &mut WordValue, raw: &str, piece: &WordPieceWithSource) {
	match &piece.piece {
		WordPiece::Text(text) | WordPiece::SingleQuotedText(text) => {
			value.text.push_str(text);
			value.literal = true;
		},
		WordPiece::AnsiCQuotedText(text) => {
			match expand_backslash_escapes(text, EscapeExpansionMode::AnsiCQuotes) {
				Ok((bytes, _)) => value.text.push_str(&String::from_utf8_lossy(&bytes)),
				Err(_) => value.text.push_str(text),
			}
			value.literal = true;
		},
		WordPiece::DoubleQuotedSequence(pieces) | WordPiece::GettextDoubleQuotedSequence(pieces) => {
			value.literal = true;
			for inner in pieces {
				push_piece(value, raw, inner);
			}
		},
		WordPiece::EscapeSequence(escape) => {
			// A backslash-newline is a line continuation: it vanishes.
			let escaped = escape.strip_prefix('\\').unwrap_or(escape);
			if escaped != "\n" {
				value.text.push_str(escaped);
				value.literal = true;
			}
		},
		WordPiece::TildeExpansion(_)
		| WordPiece::ParameterExpansion(_)
		| WordPiece::CommandSubstitution(_)
		| WordPiece::BackquotedCommandSubstitution(_)
		| WordPiece::ArithmeticExpression(_) => {
			value.text.push_str(raw.get(piece.start_index..piece.end_index).unwrap_or_default());
			value.dynamic = true;
		},
	}
}

/// Command substitutions (`$(…)`) inside a word, as byte ranges of their body.
fn command_substitutions(raw: &str) -> Vec<(usize, usize)> {
	fn collect(raw: &str, pieces: &[WordPieceWithSource], out: &mut Vec<(usize, usize)>) {
		for piece in pieces {
			match &piece.piece {
				WordPiece::CommandSubstitution(body) => {
					let start = piece.start_index + 2;
					if raw.get(piece.start_index..start) == Some("$(")
						&& raw.get(start..start + body.len()) == Some(body.as_str())
					{
						out.push((start, start + body.len()));
					}
				},
				WordPiece::DoubleQuotedSequence(inner) | WordPiece::GettextDoubleQuotedSequence(inner) => {
					collect(raw, inner, out);
				},
				_ => {},
			}
		}
	}
	if !raw.contains("$(") {
		return Vec::new();
	}
	let mut out = Vec::new();
	if let Ok(pieces) = word::parse(raw, &PARSER_OPTIONS) {
		collect(raw, &pieces, &mut out);
	}
	out
}

fn is_assignment(raw: &str) -> bool {
	let Some(eq) = raw.find('=') else {
		return false;
	};
	let name = raw[..eq].strip_suffix('+').unwrap_or(&raw[..eq]);
	let name = name.split_once('[').map_or(name, |(base, _)| base);
	let mut chars = name.chars();
	chars.next().is_some_and(|ch| ch == '_' || ch.is_ascii_alphabetic())
		&& chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn is_control_operator(op: &str) -> bool {
	!matches!(op, "<" | ">" | ">>" | ">|" | "<>" | "<&" | ">&" | "&>" | "&>>" | "<<<" | "<<" | "<<-")
}

/// Reserved words that open or close a compound command and are skipped at
/// command position; the command they introduce follows them.
fn is_passthrough_reserved(word: &str) -> bool {
	matches!(
		word,
		"if" | "then" | "else" | "elif" | "fi" | "do" | "done" | "while" | "until" | "{" | "}" | "!" | "esac"
	)
}

/// Reserved words whose segment is a header, not a command (`for x in …`).
fn is_header_reserved(word: &str) -> bool {
	matches!(word, "for" | "select" | "case" | "function" | "[[" | "coproc")
}

struct Scan<'a> {
	source: &'a Source,
	cells:  Vec<CodeCell>,
	writes: Vec<FileWrite>,
}

impl Scan<'_> {
	/// Walk one token stream. `base` is the char offset of the stream's text
	/// in the command; `[base, limit)` is the stream's extent; `nested` marks
	/// the body of a command substitution.
	fn scan_tokens(&mut self, tokens: &[Token], base: usize, limit: usize, nested: bool) {
		let commands = self.segment(tokens, base);
		let count = commands.iter().filter(|command| !command.is_empty()).count();
		for command in &commands {
			for word in &command.words {
				self.scan_substitutions(word);
			}
			for redirect in &command.redirects {
				if let Target::Word(word) = &redirect.target {
					self.scan_substitutions(word);
				}
			}
			if command.invalid || command.words.is_empty() {
				continue;
			}
			let alone = !nested && count == 1 && self.only_whitespace_outside(command, base, limit);
			self.classify(command, alone);
		}
	}

	fn only_whitespace_outside(&self, command: &Command, base: usize, limit: usize) -> bool {
		let start = command.start.unwrap_or(base);
		self.source.slice(base, start).trim().is_empty()
			&& self.source.slice(command.end, limit.min(self.source.original_chars)).trim().is_empty()
	}

	fn scan_substitutions(&mut self, word: &WordTok) {
		for (start, end) in command_substitutions(&word.raw) {
			let inner = &word.raw[start..end];
			let Ok(tokens) = uncached_tokenize_str(inner, &TOKENIZER_OPTIONS) else {
				continue;
			};
			let offset = word.start + word.raw[..start].chars().count();
			self.scan_tokens(&tokens, offset, offset + inner.chars().count(), true);
		}
	}

	fn segment(&self, tokens: &[Token], base: usize) -> Vec<Command> {
		let mut commands = Vec::new();
		let mut current = Command::default();
		let mut index = 0;
		while index < tokens.len() {
			let token = &tokens[index];
			index += 1;
			let span = token.location();
			let raw_start = base + span.start.index;
			let end = base + span.end.index;
			let start = self.source.snap(raw_start, end);
			match token {
				Token::Operator(op, _) if is_control_operator(op) => {
					let piped = matches!(op.as_str(), "|" | "|&");
					if op == "(" {
						// `name (` is a function definition or a syntax error, never a call.
						if !current.is_empty() {
							current.invalid = true;
						}
						let piped_in = current.piped_in;
						commands.push(std::mem::take(&mut current));
						current.piped_in = piped_in;
						continue;
					}
					commands.push(std::mem::take(&mut current));
					current.piped_in = piped;
				},
				Token::Operator(op, _) => {
					let fd = self.take_io_number(&mut current, start);
					current.extend(start, end);
					let target = if matches!(op.as_str(), "<<" | "<<-") {
						let Some(here) = self.read_heredoc(tokens, &mut index, base, op == "<<-") else {
							current.invalid = true;
							continue;
						};
						current.extend(here.body_start, here.consumed_end);
						Target::HereDoc(here)
					} else {
						match tokens.get(index) {
							Some(Token::Word(raw, span)) => {
								index += 1;
								let word_end = base + span.end.index;
								let word = WordTok {
									raw:   raw.clone(),
									start: self.source.snap(base + span.start.index, word_end),
									end:   word_end,
								};
								current.extend(word.start, word.end);
								Target::Word(word)
							},
							_ => Target::Missing,
						}
					};
					current.redirects.push(Redirect { fd, op: op.clone(), target });
				},
				Token::Word(raw, _) => {
					if current.is_empty() && !current.invalid {
						if is_passthrough_reserved(raw) {
							continue;
						}
						if is_header_reserved(raw) {
							current.invalid = true;
						}
					}
					current.extend(start, end);
					current.words.push(WordTok { raw: raw.clone(), start, end });
				},
			}
		}
		commands.push(current);
		commands
	}

	/// A digit word written flush against a redirection operator is its fd.
	fn take_io_number(&self, command: &mut Command, op_start: usize) -> Option<u32> {
		let last = command.words.last()?;
		if last.end != op_start || !last.raw.bytes().all(|byte| byte.is_ascii_digit()) {
			return None;
		}
		let fd = last.raw.parse().ok()?;
		command.words.pop();
		Some(fd)
	}

	/// Consume the delimiter, body and end-tag tokens brush emits after `<<`.
	fn read_heredoc(&self, tokens: &[Token], index: &mut usize, base: usize, strip_tabs: bool) -> Option<HereDoc> {
		let Some(Token::Word(delimiter, _)) = tokens.get(*index) else {
			return None;
		};
		let Some(Token::Word(body, body_span)) = tokens.get(*index + 1) else {
			return None;
		};
		*index += 2;
		if matches!(tokens.get(*index), Some(Token::Word(..))) {
			*index += 1;
		}
		let delimiter = word_value(delimiter).text;
		let body_start = base + body_span.start.index;
		// Find the terminator line the way the shell does, rather than trusting
		// the body token's end (brush folds the terminator line into it).
		let mut line_start = body_start;
		loop {
			let line_end = self.source.line_end(line_start);
			let line = self.source.slice(line_start, line_end);
			let line = if strip_tabs { line.trim_start_matches('\t') } else { line };
			if line == delimiter {
				let body_end = if line_start > body_start { line_start - 1 } else { body_start };
				let consumed_end = (line_end + 1).min(self.source.chars());
				return Some(HereDoc { body: body.clone(), body_start, body_end, consumed_end });
			}
			if line_end >= self.source.chars() {
				let mut body_end = line_end;
				if body_end > body_start && self.source.char_at(body_end - 1) == Some('\n') {
					body_end -= 1;
				}
				return Some(HereDoc { body: body.clone(), body_start, body_end, consumed_end: line_end });
			}
			line_start = line_end + 1;
		}
	}

	fn classify(&mut self, command: &Command, alone: bool) {
		let first = command.words.iter().position(|word| !is_assignment(&word.raw));
		let Some(first) = first else {
			return;
		};
		let words = &command.words[first..];
		let values: Vec<WordValue> = words.iter().map(|word| word_value(&word.raw)).collect();
		let context = CellContext { command, words, values: &values, alone: alone && first == 0 };
		if let Some(interpreter) = values[0].static_text().and_then(Interpreter::named) {
			// The command itself is the interpreter: the rest is its argv.
			self.try_cell(&context, 0, interpreter);
			return;
		}
		if self.try_write(&context) {
			return;
		}
		// A runner (`sudo`, `uv run`, `timeout 5`, `ssh host`, `xargs`, …)
		// execs an interpreter named later in its argv.
		for (index, value) in values.iter().enumerate().skip(1) {
			if let Some(interpreter) = value.static_text().and_then(Interpreter::named)
				&& self.try_cell(&context, index, interpreter)
			{
				return;
			}
		}
	}

	fn try_cell(&mut self, context: &CellContext<'_>, index: usize, interpreter: Interpreter) -> bool {
		let args = &context.values[index + 1..];
		let stdin = context.command.stdin();
		let source = interpreter.program_source(args);
		let (code, start, end) = match source {
			ProgramSource::Arg { index: arg, skip } => {
				let value = &args[arg];
				if !value.literal {
					return false;
				}
				let word = &context.words[index + 1 + arg];
				(value.text.chars().skip(skip).collect::<String>(), word.start + skip, word.end)
			},
			ProgramSource::Stdin => match stdin.map(|redirect| &redirect.target) {
				Some(Target::HereDoc(here)) => {
					let code = here.body.strip_suffix('\n').unwrap_or(&here.body).to_owned();
					(code, here.body_start, here.body_end)
				},
				Some(Target::Word(word)) if stdin.is_some_and(|redirect| redirect.op == "<<<") => {
					let value = word_value(&word.raw);
					if !value.literal {
						return false;
					}
					(value.text, word.start, word.end)
				},
				_ => return false,
			},
			ProgramSource::None => return false,
		};
		if code.trim().is_empty() {
			return false;
		}
		let route = self.kernel_route(context, index);
		// The kernel must execute the very program shown: its `-c`/`-e` word, or
		// the inline stdin. `-c` with program input on stdin falls through.
		let kernel = match (route, source) {
			(Some(ArgvRoute::Code(code_index)), ProgramSource::Arg { index: arg, skip: 0 }) => {
				code_index == arg && stdin.is_none() && !context.command.piped_in
			},
			(Some(ArgvRoute::Stdin), ProgramSource::Stdin) => true,
			_ => false,
		};
		let pure_argv = match route {
			Some(ArgvRoute::Code(_)) => context.command.redirects.is_empty(),
			Some(ArgvRoute::Stdin) => context.command.redirects.len() == 1,
			_ => false,
		};
		let mixed = !(context.alone && index == 0 && pure_argv);
		self.cells.push(CodeCell {
			language: interpreter.language,
			code,
			start: self.source.utf16(start),
			end: self.source.utf16(end),
			kernel,
			mixed,
		});
		true
	}

	/// The kernel builtin's routing of this invocation, when the shell would
	/// dispatch it to one: a bare builtin name, reached directly or through
	/// wrappers that run builtins in-process.
	fn kernel_route(&self, context: &CellContext<'_>, index: usize) -> Option<ArgvRoute> {
		let name = context.values[index].static_text()?;
		let spec = kernel_builtin_argv(name)?;
		if index > 0 && !dispatches_builtin(&context.values[..index]) {
			return None;
		}
		let argv: Vec<Option<&str>> = context.values[index + 1..]
			.iter()
			.map(|value| Some(value.text.as_str()))
			.collect();
		Some(route_argv(spec, &argv))
	}

	fn try_write(&mut self, context: &CellContext<'_>) -> bool {
		let Some(Target::HereDoc(here)) = context.command.stdin().map(|redirect| &redirect.target) else {
			return false;
		};
		let path = match context.values[0].static_text() {
			Some("cat") => {
				if context.values[1..].iter().any(|value| value.text != "-") {
					return false;
				}
				let Some(Target::Word(word)) = context
					.command
					.redirects
					.iter()
					.rev()
					.find(|redirect| redirect.writes_stdout())
					.map(|redirect| &redirect.target)
				else {
					return false;
				};
				word_value(&word.raw).text
			},
			Some("tee") => {
				let mut options = true;
				let file = context.values[1..].iter().find(|value| {
					if options && value.text == "--" {
						options = false;
						return false;
					}
					!(options && value.text.starts_with('-'))
				});
				let Some(file) = file else {
					return false;
				};
				file.text.clone()
			},
			_ => return false,
		};
		self.writes.push(FileWrite {
			path,
			code: here.body.strip_suffix('\n').unwrap_or(&here.body).to_owned(),
			start: self.source.utf16(here.body_start),
			end: self.source.utf16(here.body_end),
		});
		true
	}
}

struct CellContext<'a> {
	command: &'a Command,
	/// The command's words from its name on (leading assignments dropped).
	words:   &'a [WordTok],
	values:  &'a [WordValue],
	/// The command is the whole script, with no assignments before it.
	alone:   bool,
}

/// Whether the words before an interpreter only ever reach it as a builtin:
/// the in-process wrappers and their options/durations. `env`, `sudo`, and
/// friends exec a real interpreter instead.
fn dispatches_builtin(prefix: &[WordValue]) -> bool {
	let Some(head) = prefix.first().and_then(WordValue::static_text) else {
		return false;
	};
	if !is_builtin_dispatcher(head) {
		return false;
	}
	let mut after_option = false;
	prefix[1..].iter().all(|value| {
		let Some(text) = value.static_text() else {
			return false;
		};
		let allowed = is_builtin_dispatcher(text) || text.starts_with('-') || after_option || is_duration(text);
		after_option = text.starts_with('-') && !text.contains('=');
		allowed
	})
}

fn is_builtin_dispatcher(word: &str) -> bool {
	matches!(word, "command" | "builtin" | "nohup" | "time" | "timeout")
}

fn is_duration(word: &str) -> bool {
	let number = word.strip_suffix(['s', 'm', 'h', 'd']).unwrap_or(word);
	!number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit() || byte == b'.')
}

#[derive(Debug, Clone, Copy)]
enum ProgramSource {
	/// The argument at `index` (relative to the interpreter's argv) holds the
	/// program, starting `skip` chars in (`-cCODE`, `--eval=CODE`).
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

	fn program_source(self, args: &[WordValue]) -> ProgramSource {
		match self.language {
			CodeLanguage::Python => python_program_source(args),
			CodeLanguage::Js => js_program_source(args),
		}
	}
}

/// `""`, `3`, `3.12`, `3.13t`: the tail of a versioned interpreter name.
fn is_version_suffix(rest: &str) -> bool {
	let rest = rest.strip_suffix(|ch: char| ch.is_ascii_lowercase()).filter(|trimmed| !trimmed.is_empty()).unwrap_or(rest);
	rest.is_empty()
		|| (rest.starts_with(|ch: char| ch.is_ascii_digit())
			&& rest.split('.').all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())))
}

/// CPython's command line: `python [option…] (-c cmd | -m mod | file | -) [arg…]`.
fn python_program_source(args: &[WordValue]) -> ProgramSource {
	let mut index = 0;
	while index < args.len() {
		let Some(arg) = args[index].static_text() else {
			return ProgramSource::None;
		};
		match arg {
			"-" => return ProgramSource::Stdin,
			"--" => return stdin_after_double_dash(args, index),
			"--check-hash-based-pycs" => index += 2,
			_ if arg.starts_with("--") => {
				if matches!(arg, "--help" | "--version" | "--help-env" | "--help-xoptions" | "--help-all") {
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
						'c' => return ProgramSource::Arg { index, skip: 1 + cluster[..offset].chars().count() + 1 },
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
fn js_program_source(args: &[WordValue]) -> ProgramSource {
	let mut index = 0;
	while index < args.len() {
		let Some(arg) = args[index].static_text() else {
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
			"-r" | "--require" | "--import" | "--loader" | "--experimental-loader" | "-C" | "--conditions"
			| "--input-type" | "--env-file" | "--title" => index += 2,
			"-h" | "--help" | "-v" | "--version" => return ProgramSource::None,
			_ => {
				if let Some(eval) = ["--eval=", "--print="].iter().find(|prefix| arg.starts_with(**prefix)) {
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

fn stdin_after_double_dash(args: &[WordValue], index: usize) -> ProgramSource {
	match args.get(index + 1).map(|value| value.text.as_str()) {
		None | Some("-") => ProgramSource::Stdin,
		Some(_) => ProgramSource::None,
	}
}
