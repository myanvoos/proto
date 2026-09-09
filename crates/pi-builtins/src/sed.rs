


// Copyright (c) 2025 Diomidis Spinellis


pub mod command {


// Copyright (c) 2025 Diomidis Spinellis


use std::path::PathBuf;
use std::{cell::RefCell, collections::HashMap, rc::Rc};

use crate::sed::error_handling::SedResult;

use crate::sed::{
	error_handling::{ScriptLocation, runtime_error},
	fast_regex::{Captures, Match, Regex},
	named_writer::NamedWriter,
	script_char_provider::ScriptCharProvider,
	script_line_provider::ScriptLineProvider,
};

#[derive(Debug, Default, Clone)]
#[allow(dead_code, reason = "upstream options retained for command-line compatibility")]


pub struct ProcessingContext {

	pub all_output_files: bool,
	pub debug:            bool,
	pub regex_extended:   bool,
	pub follow_symlinks:  bool,
	pub in_place:         bool,
	pub in_place_suffix:  Option<String>,
	pub length:           usize,
	pub quiet:            bool,
	pub posix:            bool,
	pub separate:         bool,
	pub sandbox:          bool,
	pub unbuffered:       bool,
	pub null_data:        bool,

	pub cwd:              PathBuf,


	pub input_name:           String,

	pub line_number:          usize,

	pub last_address:         bool,

	pub last_line:            bool,

	pub last_file:            bool,

	pub stop_processing:      bool,

	pub saved_regex:          Option<Regex>,


	pub input_action: Option<InputAction>,

	pub hold:                 StringSpace,

	pub parsed_block_nesting: usize,

	pub label_to_command_map: HashMap<String, Rc<RefCell<Command>>>,

	pub range_commands:       Vec<Rc<RefCell<Command>>>,

	pub substitution_made:    bool,

	pub append_elements:      Vec<AppendElement>,
}

#[derive(Clone, Debug)]

pub enum AppendElement {
	Text(Rc<str>),
	Path(PathBuf),
}

#[derive(Clone, Debug, Default, PartialEq)]

pub struct StringSpace {
	pub content:     String,
	pub has_newline: bool,
}

#[derive(Debug)]

pub enum Address {
	Re(Option<Regex>),
	Line(usize),
	RelLine(usize),
	Last,
	StepMatch(usize),
	StepEnd(usize),
}

#[derive(Debug)]

pub enum ReplacementPart {
	Literal(String),
	WholeMatch,
	Group(u32),
}


pub const RE_DUP_MAX: usize = 32767;


#[derive(Copy, Clone, Debug)]
pub enum RegexMode {
	Basic,
	Extended,
}

#[derive(Debug)]

pub struct ReplacementTemplate {
	pub parts:            Vec<ReplacementPart>,
	pub max_group_number: usize,
}

impl Default for ReplacementTemplate {

	fn default() -> Self {
		ReplacementTemplate::new(Vec::new())
	}
}

impl ReplacementTemplate {

	pub fn new(parts: Vec<ReplacementPart>) -> Self {
		let max_group_number = parts
			.iter()
			.filter_map(|part| match part {
				ReplacementPart::Group(n) => Some(*n),
				_ => None,
			})
			.max()
			.unwrap_or(0);

		Self { parts, max_group_number: max_group_number.try_into().unwrap() }
	}


	pub fn apply_captures(&self, command: &Command, caps: &Captures) -> SedResult<String> {
		let mut result = String::new();


		if self.max_group_number > caps.len() - 1 {
			return runtime_error(
				&command.location,
				format!("invalid reference \\{} on command's RHS", self.max_group_number),
			);
		}

		for part in &self.parts {
			match part {
				ReplacementPart::Literal(s) => result.push_str(s),

				ReplacementPart::WholeMatch => {
					result.push_str(caps.get(0)?.map(|m| m.as_str()).unwrap_or_default());
				},

				ReplacementPart::Group(n) => {
					let i: usize = (*n).try_into().unwrap();
					result.push_str(caps.get(i)?.map(|m| m.as_str()).unwrap_or_default());
				},
			}
		}

		Ok(result)
	}


	pub fn apply_match(&self, m: &Match) -> String {
		let mut result = String::new();

		for part in &self.parts {
			match part {
				ReplacementPart::Literal(s) => result.push_str(s),

				ReplacementPart::WholeMatch => result.push_str(m.as_str()),

				ReplacementPart::Group(_) => {
					panic!("unexpected Regex group replacement")
				},
			}
		}
		result
	}
}

#[derive(Debug, Default)]

pub struct Substitution {
	pub regex:       Option<Regex>,
	pub replacement: ReplacementTemplate,
	pub occurrence:  usize,
	pub print_flag:  bool,
	pub ignore_case: bool,
	pub execute:     bool,
	pub multiline:   bool,
	pub write_file:  Option<Rc<RefCell<NamedWriter>>>,
}


const COMMON_UNICODE: usize = 2048;

#[derive(Debug)]

pub struct Transliteration {
	fast: [char; COMMON_UNICODE],
	slow: HashMap<char, char>,
}

impl Default for Transliteration {

	fn default() -> Self {
		let mut fast = ['\0'; COMMON_UNICODE];
		for (i, slot) in fast.iter_mut().enumerate() {
			*slot = char::from_u32(i as u32).unwrap_or('\0');
		}
		Self { fast, slow: HashMap::new() }
	}
}

impl Transliteration {

	pub fn from_strings(source: &str, target: &str) -> Self {
		let mut result = Self::default();
		for (from, to) in source.chars().zip(target.chars()) {
			result.insert(from, to);
		}
		result
	}


	fn insert(&mut self, from: char, to: char) {
		let cp = from as usize;
		if cp < COMMON_UNICODE {
			self.fast[cp] = to;
		} else {
			self.slow.insert(from, to);
		}
	}


	pub fn lookup(&self, ch: char) -> char {
		let cp = ch as usize;
		if cp < COMMON_UNICODE {
			self.fast[cp]
		} else {
			self.slow.get(&ch).copied().unwrap_or(ch)
		}
	}
}

#[derive(Debug)]

pub struct Command {
	pub code:       char,
	pub addr1:      Option<Address>,
	pub addr2:      Option<Address>,
	pub non_select: bool,
	pub start_line: Option<usize>,
	pub data:       CommandData,
	pub next:       Option<Rc<RefCell<Command>>>,
	pub location:   ScriptLocation,
}

impl Default for Command {
	fn default() -> Self {
		Command {
			code:       '_',
			addr1:      None,
			addr2:      None,
			non_select: false,
			start_line: None,
			data:       CommandData::None,
			next:       None,
			location:   ScriptLocation::default(),
		}
	}
}

impl Command {

	pub fn at_position(lines: &ScriptLineProvider, line: &ScriptCharProvider) -> Self {
		Command { location: ScriptLocation::at_position(lines, line), ..Default::default() }
	}
}

#[derive(Debug)]


pub enum CommandData {
	None,
	BranchTarget(Option<Rc<RefCell<Command>>>),
	Label(Option<String>),
	Path(PathBuf),
	NamedWriter(Rc<RefCell<NamedWriter>>),
	Number(usize),
	Substitution(Box<Substitution>),
	Text(Rc<str>),
	Transliteration(Box<Transliteration>),
}

#[derive(Debug, Clone)]

pub struct InputAction {

	pub next_command: Option<Rc<RefCell<Command>>>,

	pub prepend:      String,
}


}
pub mod compiler {


// Copyright (c) 2025 Diomidis Spinellis


use std::{cell::RefCell, mem, path::PathBuf, rc::Rc};

use crate::sed::error_handling::{SedError, SedResult};

use brush_core::openfiles::OpenFile;
use crate::sed::{
	command::{
		Address, Command, CommandData, ProcessingContext, RegexMode, ReplacementPart,
		ReplacementTemplate, Substitution, Transliteration,
	},
	delimited_parser::{parse_char_escape, parse_regex, parse_transliteration},
	error_handling::{ScriptLocation, compilation_error, semantic_error},
	fast_regex::Regex,
	named_writer::NamedWriter,
	script_char_provider::ScriptCharProvider,
	script_line_provider::{ScriptLineProvider, ScriptValue},
};

const DEFAULT_OUTPUT_WIDTH: usize = 60;

const ERR_ADDRESS_0_USAGE: &str =
	"address 0 can only be used with ~step, a second regular expression, or a read command";
const ERR_SANDBOX: &str = "command not allowed with --sandbox";

const ERR_UNKNOWN_OPTION_TO_S: &str = "unknown option to 's'";


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CommandHandling {
	GetNext,
	Return,
	Continue,
}


type CommandHandler = fn(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	context: &mut ProcessingContext,
) -> SedResult<CommandHandling>;


#[derive(Debug, Clone, Copy)]
struct CommandSpec {
	n_addr:  usize,
	handler: CommandHandler,
}


pub fn compile_with_stdin(
	scripts: Vec<ScriptValue>,
	context: &mut ProcessingContext,
	stdin: OpenFile,
	cwd: PathBuf,
) -> SedResult<Option<Rc<RefCell<Command>>>> {
	compile_with_provider(ScriptLineProvider::with_stdin(scripts, stdin, cwd), context)
}

fn compile_with_provider(
	mut make_providers: ScriptLineProvider,
	context: &mut ProcessingContext,
) -> SedResult<Option<Rc<RefCell<Command>>>> {

	let mut empty_line = ScriptCharProvider::new("");
	let result = compile_sequence(&mut make_providers, &mut empty_line, context)?;


	#[cfg(any())]
	dbg!(&result);


	populate_label_map(result.clone(), context)?;
	populate_range_commands(result.clone(), context);
	resolve_branch_targets(result.clone(), context)?;


	if context.parsed_block_nesting > 0 {
		return Err(SedError::new(1, "unmatched `{'"));
	}
	patch_block_endings(result.clone());

	Ok(result)
}


fn patch_block_endings(head: Option<Rc<RefCell<Command>>>) {
	fn patch_block_endings_to_parent(
		mut cur: Option<Rc<RefCell<Command>>>,
		parent_next: Option<Rc<RefCell<Command>>>,
	) {
		while let Some(rc_cmd) = cur {

			let cmd = rc_cmd.borrow_mut();

			let own_next = cmd.next.clone();


			let splice_target = own_next.clone().or(parent_next.clone());


			if let CommandData::BranchTarget(Some(ref sub_head)) = cmd.data
				&& cmd.code == '{'
			{

				patch_block_endings_to_parent(Some(sub_head.clone()), splice_target.clone());


				let mut tail = sub_head.clone();
				loop {
					let next_in_sub = tail.borrow().next.clone();
					match next_in_sub {
						Some(n) => tail = n,
						None => break,
					}
				}


				tail.borrow_mut().next.clone_from(&splice_target);
			}


			drop(cmd);


			cur = own_next;
		}
	}


	patch_block_endings_to_parent(head, None);
}


fn populate_label_map(
	mut cur: Option<Rc<RefCell<Command>>>,
	context: &mut ProcessingContext,
) -> SedResult<()> {
	while let Some(rc_cmd) = cur.take() {

		let cmd = rc_cmd.borrow_mut();


		let maybe_label = match &cmd.data {
			CommandData::BranchTarget(Some(sub_head)) => {
				populate_label_map(Some(sub_head.clone()), context)?;
				None
			},
			CommandData::Label(Some(label)) => Some(label.clone()),
			_ => None,
		};

		if let Some(label) = maybe_label
			&& cmd.code == ':'
		{
			if context.label_to_command_map.contains_key(&label) {
				return semantic_error(&cmd.location, format!("duplicate label `{label}'"));
			}
			context.label_to_command_map.insert(label, rc_cmd.clone());
		}

		cur.clone_from(&cmd.next);
	}
	Ok(())
}


fn populate_range_commands(mut cur: Option<Rc<RefCell<Command>>>, context: &mut ProcessingContext) {
	while let Some(rc_cmd) = cur.take() {

		let cmd = rc_cmd.borrow_mut();


		if let CommandData::BranchTarget(Some(sub_head)) = &cmd.data {
			populate_range_commands(Some(Rc::clone(sub_head)), context);
		}

		if cmd.addr2.is_some() {

			context.range_commands.push(Rc::clone(&rc_cmd));
		}

		cur.clone_from(&cmd.next);
	}
}


fn resolve_branch_targets(
	mut cur: Option<Rc<RefCell<Command>>>,
	context: &mut ProcessingContext,
) -> SedResult<()> {
	while let Some(rc_cmd) = cur.take() {

		let mut cmd = rc_cmd.borrow_mut();


		if let CommandData::BranchTarget(Some(sub_head)) = &cmd.data {
			resolve_branch_targets(Some(sub_head.clone()), context)?;
		}


		if matches!(cmd.code, 't' | 'b') {

			let old_data = mem::replace(&mut cmd.data, CommandData::None);


			let new_data = match old_data {
				CommandData::Label(Some(label)) => {
					let target = context
						.label_to_command_map
						.get(&label)
						.cloned()
						.ok_or_else(|| {
							semantic_error::<()>(&cmd.location, format!("undefined label `{label}'"))
								.unwrap_err()
						})?;
					CommandData::BranchTarget(Some(target))
				},
				CommandData::Label(None) => CommandData::BranchTarget(None),
				other => other,
			};


			cmd.data = new_data;
		}


		cur.clone_from(&cmd.next);
	}
	Ok(())
}


fn compile_sequence(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	context: &mut ProcessingContext,
) -> SedResult<Option<Rc<RefCell<Command>>>> {
	let mut head: Option<Rc<RefCell<Command>>> = None;
	let mut tail: Option<Rc<RefCell<Command>>> = None;

	loop {
		line.eat_spaces();


		if !line.eol() && line.current() == '#' && lines.get_line_number() == 1 && line.get_pos() == 0
		{
			line.advance();
			if !line.eol() && line.current() == 'n' {
				context.quiet = true;
			}

			while !line.eol() {
				line.advance();
			}
		}

		if line.eol() || line.current() == '#' {
			match lines.next_line()? {
				None => {
					return Ok(head);
				},
				Some(line_string) => {
					*line = ScriptCharProvider::new(&line_string);
				},
			}
			continue;
		} else if line.current() == ';' {
			line.advance();
			continue;
		}

		let mut cmd = Rc::new(RefCell::new(Command::at_position(lines, line)));
		let n_addr = compile_address_range(lines, line, &mut cmd, context)?;
		line.eat_spaces();
		let mut cmd_spec = get_verified_cmd_spec(lines, line, n_addr, context.posix)?;

		let mut cmd_mut = cmd.borrow_mut();
		cmd_mut.code = line.current();
		match (cmd_spec.handler)(lines, line, &mut cmd_mut, context)? {
			CommandHandling::GetNext => {
				cmd_spec = get_verified_cmd_spec(lines, line, n_addr, context.posix)?;
				cmd_mut.code = line.current();
				(cmd_spec.handler)(lines, line, &mut cmd_mut, context)?;
			},
			CommandHandling::Return => return Ok(head),
			CommandHandling::Continue => (),
		}
		drop(cmd_mut);

		if let Some(ref t) = tail {

			t.borrow_mut().next = Some(cmd.clone());
		} else {

			head = Some(cmd.clone());
		}
		tail = Some(cmd);
	}
}


fn is_address_char(c: char) -> bool {
	matches!(c, '0'..='9' | '/' | '\\' | '$')
}


fn compile_address_range(
	lines: &ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Rc<RefCell<Command>>,
	context: &ProcessingContext,
) -> SedResult<usize> {
	let mut n_addr = 0;
	let mut cmd = cmd.borrow_mut();

	let mut is_line0 = false;

	line.eat_spaces();
	if !line.eol() && is_address_char(line.current()) {
		let addr1 = compile_address(lines, line, context)?;
		is_line0 = matches!(addr1, Address::Line(0));
		cmd.addr1 = Some(addr1);
		if is_line0 && context.posix {

			return compilation_error(lines, line, "address 0 is invalid in POSIX mode");
		}
		n_addr += 1;
	}

	line.eat_spaces();
	if n_addr == 1 && !line.eol() && matches!(line.current(), ',' | '~') {
		let is_step_match = line.current() == '~';
		line.advance();
		line.eat_spaces();
		let is_step_end = if line.current() == '~' {


			line.advance();
			line.eat_spaces();
			true
		} else {
			false
		};

		if (is_step_match || is_step_end) && context.posix {

			return compilation_error(lines, line, "~step is invalid in POSIX mode");
		}


		if !line.eol() {
			let addr2 = compile_address(lines, line, context)?;

			let step_n = if is_step_match || is_step_end {
				match addr2 {
					Address::Line(n) => n,
					_ => {
						return compilation_error(
							lines,
							line,
							"~step can only be specified on numeric addresses",
						);
					},
				}
			} else {
				0
			};

			if is_line0 && !matches!(addr2, Address::Re(_)) && !is_step_match {
				return compilation_error(lines, line, ERR_ADDRESS_0_USAGE);
			}


			cmd.addr2 = if is_step_match {
				Some(Address::StepMatch(step_n))
			} else if is_step_end {
				Some(Address::StepEnd(step_n))
			} else {
				Some(addr2)
			};
			n_addr += 1;
		}
	}


	if is_line0 && n_addr == 1 {


		if line.eol() || line.current() != 'r' {
			return compilation_error(lines, line, ERR_ADDRESS_0_USAGE);
		}
	}

	Ok(n_addr)
}


fn read_file_path(lines: &ScriptLineProvider, line: &mut ScriptCharProvider) -> SedResult<PathBuf> {
	line.advance();
	line.eat_spaces();

	let mut path = String::new();
	while !line.eol() {
		path.push(line.current());
		line.advance();
	}

	if path.is_empty() {
		compilation_error(lines, line, "missing file path")
	} else {


		Ok(PathBuf::from(path))
	}
}


fn compile_address(
	lines: &ScriptLineProvider,
	line: &mut ScriptCharProvider,
	context: &ProcessingContext,
) -> SedResult<Address> {
	let mut icase = false;

	if line.eol() {
		return compilation_error(lines, line, "expected context address");
	}

	match line.current() {
		'\\' | '/' => {

			if line.current() == '\\' {

				line.advance();
			}
			let regex_mode = if context.regex_extended {
				RegexMode::Extended
			} else {
				RegexMode::Basic
			};
			let re = parse_regex(lines, line, regex_mode)?;

			line.advance();

			line.eat_spaces();
			if !line.eol() && line.current() == 'I' {
				icase = true;
				line.advance();
			}

			Ok(Address::Re(compile_regex(lines, line, &re, context, icase, false)?))
		},
		'$' => {
			line.advance();
			Ok(Address::Last)
		},
		'+' => {
			line.advance();
			let number = parse_number(lines, line, true)?.unwrap();
			Ok(Address::RelLine(number))
		},
		c if c.is_ascii_digit() => {
			let number = parse_number(lines, line, true)?.unwrap();
			Ok(Address::Line(number))
		},
		_ => panic!("invalid context address"),
	}
}


fn parse_number(
	lines: &ScriptLineProvider,
	line: &mut ScriptCharProvider,
	required: bool,
) -> SedResult<Option<usize>> {
	let mut num_str = String::new();

	while !line.eol() && line.current().is_ascii_digit() {
		num_str.push(line.current());
		line.advance();
	}

	if num_str.is_empty() {
		if required {
			return compilation_error(lines, line, "number expected");
		}
		return Ok(None);
	}

	num_str
		.parse::<usize>()
		.map_err(|_| format!("invalid number '{num_str}'"))
		.map_err(|msg| compilation_error::<usize>(lines, line, msg).unwrap_err())
		.map(Some)
}


fn parse_command_ending(
	lines: &ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
) -> SedResult<()> {
	if !line.eol() && line.current() == ';' {
		line.advance();
		return Ok(());
	}

	if !line.eol() {
		return compilation_error(
			lines,
			line,
			format!("extra characters at the end of the {} command", cmd.code),
		);
	}

	Ok(())
}


// BRE translation is shared with grep in `crate::bre`.
fn compile_regex(
	lines: &ScriptLineProvider,
	line: &ScriptCharProvider,
	pattern: &str,
	context: &ProcessingContext,
	icase: bool,
	multiline: bool,
) -> SedResult<Option<Regex>> {
	if pattern.is_empty() {
		return Ok(None);
	}


	let translated = if context.regex_extended {
		None
	} else {
		Some(
			crate::bre::bre_to_ere(pattern, crate::bre::Backrefs::Supported).map_err(|error| {
				compilation_error::<Regex>(
					lines,
					line,
					format!("invalid regex '{pattern}': {}", error.message()),
				)
				.unwrap_err()
			})?,
		)
	};
	let pattern = translated.as_deref().unwrap_or(pattern);

	let mut modifiers = String::new();
	if icase {
		modifiers.push('i');
	}
	if multiline {
		modifiers.push('m');
	}
	let pattern = if modifiers.is_empty() {
		pattern.to_string()
	} else {
		format!("(?{modifiers}){pattern}")
	};


	let compiled = Regex::new(&pattern).map_err(|e| {
		compilation_error::<Regex>(lines, line, format!("invalid regex '{pattern}': {e}"))
			.unwrap_err()
	})?;

	Ok(Some(compiled))
}


pub fn compile_replacement(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
) -> SedResult<ReplacementTemplate> {
	let mut parts = Vec::new();
	let mut literal = String::new();

	let delimiter = line.current();
	line.advance();

	loop {
		while !line.eol() {
			match line.current() {
				'\\' => {
					line.advance();


					if line.eol() {
						if let Some(next_line_string) = lines.next_line()? {
							literal.push('\n');
							*line = ScriptCharProvider::new(&next_line_string);
							continue;
						}
						return compilation_error(
							lines,
							line,
							"unterminated substitute replacement (unexpected EOF)",
						);
					}

					match line.current() {

						c @ '0'..='9' => {
							let ref_num = c.to_digit(10).unwrap();

							if !literal.is_empty() {
								parts.push(ReplacementPart::Literal(std::mem::take(&mut literal)));
							}
							if ref_num == 0 {
								parts.push(ReplacementPart::WholeMatch);
							} else {
								parts.push(ReplacementPart::Group(ref_num));
							}
							line.advance();
						},


						'\\' | '&' => {
							literal.push(line.current());
							line.advance();
						},


						v if v == delimiter => {
							literal.push(line.current());
							line.advance();
						},


						_ => {
							if let Some(decoded) = parse_char_escape(line) {
								literal.push(decoded);
							} else {
								literal.push('\\');
								literal.push(line.current());
								line.advance();
							}
						},
					}
				},

				'&' => {
					if !literal.is_empty() {
						parts.push(ReplacementPart::Literal(std::mem::take(&mut literal)));
					}
					parts.push(ReplacementPart::WholeMatch);
					line.advance();
				},

				'\n' => {
					return compilation_error(
						lines,
						line,
						"unescaped newline inside substitute replacement",
					);
				},

				c if c == delimiter => {
					line.advance();
					if !literal.is_empty() {
						parts.push(ReplacementPart::Literal(literal));
					}
					return Ok(ReplacementTemplate::new(parts));
				},

				c => {
					literal.push(c);
					line.advance();
				},
			}
		}


		if let Some(next_line_string) = lines.next_line()? {
			*line = ScriptCharProvider::new(&next_line_string);
		} else {
			return compilation_error(lines, line, "unterminated substitute replacement");
		}
	}
}


fn compile_subst_command(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	line.advance();

	let delimiter = line.current();
	if delimiter == '\0' || delimiter == '\\' {
		return compilation_error(
			lines,
			line,
			"substitute pattern cannot be delimited by newline or backslash",
		);
	}

	let regex_mode = if context.regex_extended {
		RegexMode::Extended
	} else {
		RegexMode::Basic
	};
	let pattern = parse_regex(lines, line, regex_mode)?;
	let mut subst = Box::new(Substitution::default());

	subst.replacement = compile_replacement(lines, line)?;
	compile_subst_flags(lines, line, &mut subst, context.posix, context.sandbox, Some(&context.cwd))?;

	if pattern.is_empty() && (subst.ignore_case || subst.multiline) {
		return compilation_error(
			lines,
			line,
			"cannot specify modifiers on an empty regular expression",
		);
	}


	subst.regex = compile_regex(lines, line, &pattern, context, subst.ignore_case, subst.multiline)?;


	if let Some(regex) = &subst.regex
		&& subst.replacement.max_group_number > regex.captures_len() - 1
	{
		return compilation_error(
			lines,
			line,
			format!("invalid reference \\{} on `s' command's RHS", subst.replacement.max_group_number),
		);
	}
	cmd.data = CommandData::Substitution(subst);

	parse_command_ending(lines, line, cmd)?;
	Ok(CommandHandling::Continue)
}


fn compile_trans_command(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	_context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	line.advance();

	let delimiter = line.current();
	if delimiter == '\0' || delimiter == '\\' {
		return compilation_error(
			lines,
			line,
			"transliteration string cannot be delimited by newline or backslash",
		);
	}

	let source = parse_transliteration(lines, line)?;
	let target = parse_transliteration(lines, line)?;
	if source.chars().count() != target.chars().count() {
		return compilation_error(lines, line, "transliteration strings are not the same length");
	}

	let transliteration = Box::new(Transliteration::from_strings(&source, &target));
	cmd.data = CommandData::Transliteration(transliteration);

	line.advance();
	parse_command_ending(lines, line, cmd)?;
	Ok(CommandHandling::Continue)
}


pub fn compile_subst_flags(
	lines: &ScriptLineProvider,
	line: &mut ScriptCharProvider,
	subst: &mut Substitution,
	posix: bool,
	sandbox: bool,
	cwd: Option<&std::path::Path>,
) -> SedResult<()> {
	let mut seen_g_or_n = false;

	subst.occurrence = 1;
	subst.print_flag = false;
	subst.ignore_case = false;
	subst.execute = false;
	subst.multiline = false;
	subst.write_file = None;

	loop {
		line.eat_spaces();
		if line.eol() {
			break;
		}

		match line.current() {
			'g' => {
				if seen_g_or_n {
					return compilation_error(
						lines,
						line,
						"multiple 'g' or numeric flags in substitute command",
					);
				}
				seen_g_or_n = true;
				subst.occurrence = 0;
				line.advance();
			},

			'p' => {
				subst.print_flag = true;
				line.advance();
			},

			'i' | 'I' => {
				if posix {
					return compilation_error(lines, line, ERR_UNKNOWN_OPTION_TO_S);
				}
				subst.ignore_case = true;
				line.advance();
			},

			'm' | 'M' => {
				if posix {
					return compilation_error(lines, line, ERR_UNKNOWN_OPTION_TO_S);
				}
				subst.multiline = true;
				line.advance();
			},

			'e' => {
				if posix || sandbox {
					return compilation_error(
						lines,
						line,
						"the 'e' substitute flag is not allowed with --posix or --sandbox",
					);
				}
				subst.execute = true;
				line.advance();
			},

			_c @ '1'..='9' => {
				if seen_g_or_n {
					return compilation_error(
						lines,
						line,
						"multiple 'g' or numeric flags in substitute command",
					);
				}

				let mut number = 0usize;
				while !line.eol() && line.current().is_ascii_digit() {
					number = number
						.checked_mul(10)
						.and_then(|n| n.checked_add(line.current().to_digit(10).unwrap() as usize))
						.ok_or_else(|| {
							compilation_error::<()>(lines, line, "overflow in numeric substitute flag")
								.unwrap_err()
						})?;
					line.advance();
				}

				subst.occurrence = number;
				seen_g_or_n = true;
			},

			'w' => {
				if sandbox {
					return compilation_error(lines, line, ERR_SANDBOX);
				}
				let location = ScriptLocation::at_position(lines, line);
				let mut path = read_file_path(lines, line)?;
				if let Some(cwd) = cwd {
					let normalized = brush_core::sys::fs::normalize_shell_path(&path);
					path = if normalized.is_absolute() {
						normalized.into_owned()
					} else {
						cwd.join(normalized)
					};
				}
				subst.write_file = Some(NamedWriter::new(path, location)?);
				return Ok(());
			},

			';' | '\n' => break,

			other => {
				return compilation_error(lines, line, format!("invalid substitute flag: '{other}'"));
			},
		}
	}

	Ok(())
}


fn compile_end_group_command(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	if context.parsed_block_nesting == 0 {
		return compilation_error(lines, line, "unexpected `}'");
	}
	context.parsed_block_nesting -= 1;
	line.advance();
	line.eat_spaces();
	parse_command_ending(lines, line, cmd)?;
	Ok(CommandHandling::Return)
}


fn compile_negation_command(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	_context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	line.advance();
	line.eat_spaces();
	if cmd.non_select {
		return compilation_error(lines, line, "negation already applied");
	}
	cmd.non_select = true;
	Ok(CommandHandling::GetNext)
}


fn compile_empty_command(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	_context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	line.advance();
	line.eat_spaces();

	parse_command_ending(lines, line, cmd)?;
	Ok(CommandHandling::Continue)
}


fn compile_read_file_command(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	if context.sandbox {
		return compilation_error(lines, line, ERR_SANDBOX);
	}
	let mut path = read_file_path(lines, line)?;
	let normalized = brush_core::sys::fs::normalize_shell_path(&path);
	path = if normalized.is_absolute() {
		normalized.into_owned()
	} else {
		context.cwd.join(normalized)
	};
	cmd.data = CommandData::Path(path);
	Ok(CommandHandling::Continue)
}


fn compile_write_file_command(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	if context.sandbox {
		return compilation_error(lines, line, ERR_SANDBOX);
	}
	let location = ScriptLocation::at_position(lines, line);
	let mut path = read_file_path(lines, line)?;
	let normalized = brush_core::sys::fs::normalize_shell_path(&path);
	path = if normalized.is_absolute() {
		normalized.into_owned()
	} else {
		context.cwd.join(normalized)
	};
	cmd.data = CommandData::NamedWriter(NamedWriter::new(path, location)?);
	Ok(CommandHandling::Continue)
}


fn compile_block_command(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	line.advance();
	context.parsed_block_nesting += 1;
	let block_body = compile_sequence(lines, line, context)?;
	cmd.data = CommandData::BranchTarget(block_body);
	Ok(CommandHandling::Continue)
}


fn compile_label_command(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	_context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {

	fn is_portable_filename_char(c: char) -> bool {
		c.is_ascii_alphanumeric()
        || matches!(c, '.' | '_' | '-')
	}

	line.advance();
	line.eat_spaces();

	let mut label = String::new();
	while !line.eol() && is_portable_filename_char(line.current()) {
		label.push(line.current());
		line.advance();
	}

	if label.is_empty() {
		if cmd.code == ':' {
			return compilation_error(lines, line, "empty label");
		}
		cmd.data = CommandData::Label(None);
	} else {
		cmd.data = CommandData::Label(Some(label));
	}

	line.eat_spaces();
	parse_command_ending(lines, line, cmd)?;
	Ok(CommandHandling::Continue)
}


fn output_width() -> usize {
	DEFAULT_OUTPUT_WIDTH
}


fn compile_number_command(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	_context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	line.advance();
	line.eat_spaces();

	match parse_number(lines, line, false)? {
		Some(n) => {
			cmd.data = CommandData::Number(n);
		},
		None => match cmd.code {
			'q' | 'Q' => {
				cmd.data = CommandData::Number(0);
			},
			'l' => {
				cmd.data = CommandData::Number(output_width());
			},
			_ => panic!("invalid number-expecting command"),
		},
	}

	line.eat_spaces();
	parse_command_ending(lines, line, cmd)?;
	Ok(CommandHandling::Continue)
}


fn compile_text_command(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	line.advance();
	line.eat_spaces();
	if context.posix {
		compile_text_command_posix(lines, line, cmd, context)
	} else {
		compile_text_command_gnu(lines, line, cmd, context)
	}
}


fn compile_text_command_gnu(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	_context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {

	let mut escaped_newline = false;

	if line.eol() {
		return compilation_error(
			lines,
			line,
			format!("command `{}' expects \\ followed by text", cmd.code),
		);
	}


	if !line.eol() && line.current() == '\\' {
		line.advance();
		escaped_newline = line.eol();
	}


	let mut text = String::new();
	'text_content: loop {
		if escaped_newline {
			match lines.next_line()? {
				None => {
					break 'text_content;
				},
				Some(line_string) => {
					*line = ScriptCharProvider::new(&line_string);
				},
			}
			escaped_newline = false;
		}


		if line.eol() {
			text.push('\n');
			break 'text_content;
		}

		if line.current() == '\\' {
			line.advance();

			if line.eol() {
				escaped_newline = true;
				text.push('\n');
				continue 'text_content;
			}

			if let Some(decoded) = parse_char_escape(line) {
				text.push(decoded);
			} else {

				text.push(line.current());
				line.advance();
			}
		} else {
			text.push(line.current());
			line.advance();
		}
	}
	cmd.data = CommandData::Text(Rc::from(text));
	Ok(CommandHandling::Continue)
}


fn compile_text_command_posix(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	_context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	if line.eol() || line.current() != '\\' {
		return compilation_error(
			lines,
			line,
			format!("command `{}' expects \\ followed by text", cmd.code),
		);
	}

	line.advance();
	line.eat_spaces();
	if !line.eol() {
		return compilation_error(
			lines,
			line,
			format!("extra characters after \\ at the end of `{}' command", cmd.code),
		);
	}

	let mut text = String::new();
	while let Some(line) = lines.next_line()? {
		if line.ends_with('\\') {

			text.push_str(&line[..line.len() - 1]);
			text.push('\n');
		} else {
			text.push_str(&line);
			text.push('\n');
			break;
		}
	}

	if text.is_empty() {
		compilation_error(lines, line, "incomplete command")?;
	}

	cmd.data = CommandData::Text(Rc::from(text));
	Ok(CommandHandling::Continue)
}


fn get_verified_cmd_spec(
	lines: &ScriptLineProvider,
	line: &ScriptCharProvider,
	n_addr: usize,
	posix: bool,
) -> SedResult<CommandSpec> {
	if line.eol() {
		return compilation_error(lines, line, "command expected");
	}

	let ch = line.current();
	let cmd_spec = get_cmd_spec(lines, line, ch, posix)?;

	if n_addr > cmd_spec.n_addr {
		return compilation_error(
			lines,
			line,
			format!("command {} expects up to {} address(es), found {}", ch, cmd_spec.n_addr, n_addr),
		);
	}

	Ok(cmd_spec)
}


fn get_cmd_spec(
	lines: &ScriptLineProvider,
	line: &ScriptCharProvider,
	cmd_code: char,
	posix: bool,
) -> SedResult<CommandSpec> {
	match cmd_code {
		'!' => Ok(CommandSpec { n_addr: 2, handler: compile_negation_command }),
		'=' => Ok(CommandSpec { n_addr: if posix { 1 } else { 2 }, handler: compile_empty_command }),
		':' => Ok(CommandSpec { n_addr: 0, handler: compile_label_command }),
		'{' => Ok(CommandSpec { n_addr: 2, handler: compile_block_command }),
		'}' => Ok(CommandSpec { n_addr: 0, handler: compile_end_group_command }),
		'a' | 'i' => {
			Ok(CommandSpec { n_addr: if posix { 1 } else { 2 }, handler: compile_text_command })
		},
		'b' | 't' => Ok(CommandSpec { n_addr: 2, handler: compile_label_command }),
		'c' => Ok(CommandSpec { n_addr: 2, handler: compile_text_command }),
		'd' | 'D' | 'g' | 'G' | 'h' | 'H' | 'n' | 'N' | 'p' | 'P' | 'x' => {
			Ok(CommandSpec { n_addr: 2, handler: compile_empty_command })
		},
		'z' if !posix => Ok(CommandSpec { n_addr: 2, handler: compile_empty_command }),
		'l' => Ok(CommandSpec { n_addr: 2, handler: compile_number_command }),
		'q' => {
			Ok(CommandSpec { n_addr: if posix { 1 } else { 2 }, handler: compile_number_command })
		},

		'Q' => Ok(CommandSpec { n_addr: 1, handler: compile_number_command }),
		'r' => {
			Ok(CommandSpec { n_addr: if posix { 1 } else { 2 }, handler: compile_read_file_command })
		},
		's' => Ok(CommandSpec { n_addr: 2, handler: compile_subst_command }),
		'w' => Ok(CommandSpec { n_addr: 2, handler: compile_write_file_command }),
		'y' => Ok(CommandSpec { n_addr: 2, handler: compile_trans_command }),
		_ => compilation_error(lines, line, format!("invalid command code `{cmd_code}'")),
	}
}



	#[cfg(test)]
	mod tests {
		use fancy_regex::Regex as FancyRegex;

		fn matches(pattern: &str, extended: bool, text: &str) -> bool {
			let translated = (!extended).then(|| {
				crate::bre::bre_to_ere(pattern, crate::bre::Backrefs::Supported).expect("valid BRE")
			});
			let pattern = translated.as_deref().unwrap_or(pattern);
			FancyRegex::new(&format!("^(?:{pattern})$"))
				.expect("valid test pattern")
				.is_match(text)
				.expect("match succeeds")
		}

		#[test]
		fn basic_and_extended_metacharacters_have_inverse_sed_meanings() {
			let cases = [
				(r"\(ab\)", "ab", "(ab)", "(ab)", "ab"),
				("(ab)", "(ab)", "ab", "ab", "(ab)"),
				(r"a\{2\}", "aa", "a{2}", "a{2}", "aa"),
				("a{2}", "a{2}", "aa", "aa", "a{2}"),
				(r"a\|b", "b", "a|b", "a|b", "b"),
				("a|b", "a|b", "b", "b", "a|b"),
				(r"a\+", "aaa", "a+", "a+", "aaa"),
				("a+", "a+", "aaa", "aaa", "a+"),
				(r"a\?", "", "a?", "a?", ""),
				("a?", "a?", "", "", "a?"),
			];
			for (pattern, bre_yes, bre_no, ere_yes, ere_no) in cases {
				assert!(matches(pattern, false, bre_yes), "BRE {pattern:?} must match {bre_yes:?}");
				assert!(!matches(pattern, false, bre_no), "BRE {pattern:?} must not match {bre_no:?}");
				assert!(matches(pattern, true, ere_yes), "ERE {pattern:?} must match {ere_yes:?}");
				assert!(!matches(pattern, true, ere_no), "ERE {pattern:?} must not match {ere_no:?}");
			}
		}
	}
}


pub mod delimited_parser {


// Copyright (c) 2025 Diomidis Spinellis


use std::char;

use crate::sed::error_handling::SedResult;

use crate::sed::{
	command::{RE_DUP_MAX, RegexMode},
	error_handling::compilation_error,
	script_char_provider::ScriptCharProvider,
	script_line_provider::ScriptLineProvider,
};


fn is_ascii_octal_digit(c: char) -> bool {
	matches!(c, '0'..='7')
}


fn parse_numeric_escape(
	line: &mut ScriptCharProvider,
	is_allowed_char: fn(char) -> bool,
	ndigits: usize,
	radix: u32,
) -> Option<char> {
	let mut valid_chars = Vec::new();

	for _ in 0..ndigits {
		if !line.eol() && is_allowed_char(line.current()) {
			valid_chars.push(line.current());
			line.advance();
		} else {
			break;
		}
	}

	if valid_chars.is_empty() {
		return None;
	}

	if ndigits > 3 && valid_chars.len() != ndigits {
		line.retreat(valid_chars.len());
		return None;
	}

	let char_string: String = valid_chars.into_iter().collect();
	match u32::from_str_radix(&char_string, radix)
		.ok()
		.and_then(char::from_u32)
	{
		Some(decoded) => Some(decoded),
		None => panic!("Unable to decode numeric character escape."),
	}
}


fn create_control_char(x: char) -> Option<char> {
	if !x.is_ascii() {
		return None;
	}

	let c = x.to_ascii_uppercase();

	let transformed = (c as u8) ^ 0x40;
	char::from_u32(u32::from(transformed))
}


pub fn parse_char_escape(line: &mut ScriptCharProvider) -> Option<char> {
	match line.current() {
		'a' => {
			line.advance();
			Some('\x07')
		},
		'b' => {
			line.advance();
			Some('\x08')
		},
		'f' => {
			line.advance();
			Some('\x0c')
		},
		'n' => {
			line.advance();
			Some('\n')
		},
		'r' => {
			line.advance();
			Some('\r')
		},
		't' => {
			line.advance();
			Some('\t')
		},
		'v' => {
			line.advance();
			Some('\x0b')
		},

		'c' => {

			line.advance();
			match create_control_char(line.current()) {
				Some(decoded) => {
					line.advance();
					Some(decoded)
				},
				None => Some('c'),
			}
		},

		'd' => {

			line.advance();
			match parse_numeric_escape(line, |c| c.is_ascii_digit(), 3, 10) {
				Some(decoded) => Some(decoded),
				None => Some('d'),
			}
		},

		'o' => {

			line.advance();
			match parse_numeric_escape(line, is_ascii_octal_digit, 3, 8) {
				Some(decoded) => Some(decoded),
				None => Some('o'),
			}
		},

		'u' => {

			line.advance();
			match parse_numeric_escape(line, |c| c.is_ascii_hexdigit(), 4, 16) {
				Some(decoded) => Some(decoded),
				None => Some('u'),
			}
		},

		'U' => {

			line.advance();
			match parse_numeric_escape(line, |c| c.is_ascii_hexdigit(), 8, 16) {
				Some(decoded) => Some(decoded),
				None => Some('U'),
			}
		},

		'x' => {

			line.advance();
			match parse_numeric_escape(line, |c| c.is_ascii_hexdigit(), 2, 16) {
				Some(decoded) => Some(decoded),
				None => Some('x'),
			}
		},
		_ => None,
	}
}


fn parse_character_class(
	lines: &ScriptLineProvider,
	line: &mut ScriptCharProvider,
) -> SedResult<String> {
	let mut result = String::new();

	assert!(!line.eol() && line.current() == '[', "Invalid character class.");

	line.advance();
	result.push('[');


	if !line.eol() && line.current() == '^' {
		result.push('^');
		line.advance();
	}


	if !line.eol() && line.current() == ']' {
		result.push(']');
		line.advance();
	}

	while !line.eol() {
		let ch = line.current();

		if ch == ']' {
			result.push(']');
			line.advance();
			return Ok(result);
		}

		if ch == '[' {
			line.advance();
			if line.eol() {
				result.push('[');
				continue;
			}
			let marker = line.current();

			if marker == ':' || marker == '.' || marker == '=' {
				line.advance();

				result.push('[');
				result.push(marker);

				let mut inner = String::new();
				let mut terminated = false;

				while !line.eol() {
					let c = line.current();
					if c == marker {
						line.advance();
						if !line.eol() && line.current() == ']' {
							line.advance();
							result.push_str(&inner);
							result.push(marker);
							result.push(']');
							terminated = true;
							break;
						}

						inner.push(marker);
					} else {
						inner.push(c);
						line.advance();
					}
				}

				if !terminated {
					return compilation_error(
						lines,
						line,
						"Unterminated POSIX character class, equivalence or collating symbol",
					);
				}

				continue;
			}

			result.push('[');
			result.push(marker);
			line.advance();
			continue;
		}

		if ch == '\\' {

			line.advance();
			if line.eol() {
				break;
			}
			if let Some(decoded) = parse_char_escape(line) {
				result.push(decoded);
			} else {
				result.push('\\');
				result.push(line.current());
				line.advance();
			}
		} else {
			result.push(ch);
			line.advance();
		}
	}

	compilation_error(lines, line, "Unterminated bracket expression")
}


fn scan_delimiter(lines: &ScriptLineProvider, line: &mut ScriptCharProvider) -> SedResult<char> {

	if line.eol() {
		return compilation_error(lines, line, "unexpected end of line".to_string());
	}

	let delimiter = line.current();
	if delimiter == '\\' {
		return compilation_error(lines, line, "\\ cannot be used as a string delimiter");
	}
	line.advance();
	Ok(delimiter)
}


pub fn parse_regex(
	lines: &ScriptLineProvider,
	line: &mut ScriptCharProvider,
	regex_mode: RegexMode,
) -> SedResult<String> {
	let delimiter = scan_delimiter(lines, line)?;
	let mut result = String::new();
	while !line.eol() {
		match line.current() {
			'[' if delimiter != '[' => {
				let cc = parse_character_class(lines, line)?;
				result.push_str(&cc);
				continue;
			},
			'\\' => {
				line.advance();
				if line.eol() {
					return compilation_error(lines, line, "unterminated regular expression");
				}
				if line.current() == delimiter {

					result.push(line.current());
					line.advance();
					continue;
				}
				if line.current() == '{' && matches!(regex_mode, RegexMode::Basic) {
					validate_quantifier_structure(lines, line, delimiter, RegexMode::Basic)?;
					let quantifier = validate_quantifier_numbers(lines, line)?;
					result.push('\\');
					result.push('{');
					result.push_str(&quantifier);
					continue;
				}
				if line.current() == '}' {
					result.push('\\');
					result.push('}');
					line.advance();
					continue;
				}
				if let Some(decoded) = parse_char_escape(line) {
					result.push(decoded);
				} else {

					result.push('\\');
					result.push(line.current());
					line.advance();
				}
				continue;
			},
			'{' if delimiter != '{' && matches!(regex_mode, RegexMode::Extended) => {
				validate_quantifier_structure(lines, line, delimiter, RegexMode::Extended)?;
				let quantifier = validate_quantifier_numbers(lines, line)?;
				result.push('{');
				result.push_str(&quantifier);
				continue;
			},
			'}' if delimiter != '}' => {
				result.push('}');
				line.advance();
				continue;
			},

			c if c == delimiter => return Ok(result),
			c => result.push(c),
		}
		line.advance();
	}
	compilation_error(lines, line, "unterminated regular expression")
}


fn validate_quantifier_structure(
	lines: &ScriptLineProvider,
	line: &mut ScriptCharProvider,
	delimiter: char,
	regex_mode: RegexMode,
) -> SedResult<()> {
	let invalid_content_error_msg = "Invalid content of \\{\\}";
	let mut found_closing_brace = false;
	let mut seen_comma = false;
	let mut invalid_content_detected = false;
	let mut is_quantifier_empty = true;
	let initial_pos = line.get_pos();
	line.advance();

	while !line.eol() && line.current() != delimiter {
		match regex_mode {
			RegexMode::Extended => {

				if line.current() == '}' {

					if is_quantifier_empty {
						invalid_content_detected = true;
					}
					found_closing_brace = true;
					break;
				}

				is_quantifier_empty = false;

				if line.current() == ',' {
					if seen_comma {
						invalid_content_detected = true;
					}
					seen_comma = true;
				} else if !line.current().is_ascii_digit() {
					invalid_content_detected = true;
				}
				line.advance();
			},
			RegexMode::Basic => {

				if line.current() == '\\' {
					line.advance();
					if !line.eol() && line.current() == '}' {
						if is_quantifier_empty {
							invalid_content_detected = true;
						}
						found_closing_brace = true;
					} else {
						invalid_content_detected = true;
					}
					break;
				}
				is_quantifier_empty = false;
				if line.current() == ',' {
					if seen_comma {
						invalid_content_detected = true;
					}
					seen_comma = true;
				} else if !line.current().is_ascii_digit() {
					invalid_content_detected = true;
				}
				line.advance();
			},
		}
	}

	if !found_closing_brace {
		return compilation_error(lines, line, "Unmatched \\{");
	}

	if invalid_content_detected {
		return compilation_error(lines, line, invalid_content_error_msg);
	}

	line.set_position(initial_pos);
	Ok(())
}


fn parse_quantifier_bound(
	lines: &ScriptLineProvider,
	line: &mut ScriptCharProvider,
	digits: &str,
) -> SedResult<usize> {
	match digits.parse::<usize>() {
		Ok(val) if val <= RE_DUP_MAX => Ok(val),
		_ => compilation_error(lines, line, "Regular expression too big"),
	}
}


fn validate_quantifier_numbers(
	lines: &ScriptLineProvider,
	line: &mut ScriptCharProvider,
) -> SedResult<String> {
	line.advance();


	let mut m = String::new();
	while line.current() != ',' && line.current() != '}' && line.current() != '\\' {
		m.push(line.current());
		line.advance();
	}


	let has_comma = line.current() == ',';
	let mut n = String::new();
	if has_comma {
		line.advance();
		while line.current() != '}' && line.current() != '\\' {
			n.push(line.current());
			line.advance();
		}
	}


	let m_val = if m.is_empty() {
		0
	} else {
		parse_quantifier_bound(lines, line, &m)?
	};
	let n_val = if n.is_empty() {
		None
	} else {
		Some(parse_quantifier_bound(lines, line, &n)?)
	};


	if let Some(n_val) = n_val
		&& m_val > n_val
	{
		return compilation_error(lines, line, "Invalid content of \\{\\}");
	}


	let mut result = if m.is_empty() { "0".to_string() } else { m };
	if has_comma {
		result.push(',');
		result.push_str(&n);
	}

	Ok(result)
}


pub fn parse_transliteration(
	lines: &ScriptLineProvider,
	line: &mut ScriptCharProvider,
) -> SedResult<String> {
	let delimiter = scan_delimiter(lines, line)?;
	let mut result = String::new();

	while !line.eol() {
		match line.current() {
			'\\' => {
				line.advance();
				if line.eol() {
					return compilation_error(lines, line, "unterminated transliteration string");
				}
				if line.current() == delimiter || line.current() == '\\' {

					result.push(line.current());
					line.advance();
					continue;
				}
				if let Some(decoded) = parse_char_escape(line) {
					result.push(decoded);
				} else {

					result.push('\\');
					result.push(line.current());
					line.advance();
				}
				continue;
			},
			c if c == delimiter => return Ok(result),
			c => result.push(c),
		}
		line.advance();
	}
	compilation_error(lines, line, "unterminated transliteration string")
}


}
pub mod error_handling {


// Copyright (c) 2025 Diomidis Spinellis

use std::{fmt, io, rc::Rc};

use crate::sed::{
	command::ProcessingContext, script_char_provider::ScriptCharProvider,
	script_line_provider::ScriptLineProvider,
};


#[derive(Debug)]
pub struct SedError {
	code: i32,
	message: String,
}

impl SedError {

	pub fn new(code: i32, message: impl ToString) -> Self {
		Self { code, message: message.to_string() }
	}


	pub fn io(_kind: io::ErrorKind, message: impl ToString) -> Self {
		Self::new(2, message)
	}


	pub const fn code(&self) -> i32 {
		self.code
	}
}

impl fmt::Display for SedError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(&self.message)
	}
}

impl std::error::Error for SedError {}

impl From<io::Error> for SedError {
	fn from(error: io::Error) -> Self {
		Self::new(2, error)
	}
}

impl From<std::str::Utf8Error> for SedError {
	fn from(error: std::str::Utf8Error) -> Self {
		Self::new(2, error)
	}
}

impl From<std::string::FromUtf8Error> for SedError {
	fn from(error: std::string::FromUtf8Error) -> Self {
		Self::new(2, error)
	}
}

impl From<std::num::ParseIntError> for SedError {
	fn from(error: std::num::ParseIntError) -> Self {
		Self::new(1, error)
	}
}

impl From<fancy_regex::Error> for SedError {
	fn from(error: fancy_regex::Error) -> Self {
		Self::new(2, error)
	}
}


pub type SedResult<T> = Result<T, SedError>;


pub trait IoContext<T> {

	fn map_err_context(self, context: impl FnOnce() -> String) -> SedResult<T>;
}

impl<T> IoContext<T> for io::Result<T> {
	fn map_err_context(self, context: impl FnOnce() -> String) -> SedResult<T> {
		self.map_err(|error| SedError::new(2, format!("{}: {error}", context())))
	}
}

#[derive(Clone, Debug)]

pub struct ScriptLocation {
	pub input_name: Rc<str>,
	pub line_number: usize,
	pub column_number: usize,
}

impl Default for ScriptLocation {
	fn default() -> Self {
		Self { input_name: Rc::from("<unknown>"), line_number: 1, column_number: 1 }
	}
}

impl ScriptLocation {

	pub fn at_position(lines: &ScriptLineProvider, line: &ScriptCharProvider) -> Self {
		Self {
			line_number: lines.get_line_number(),
			column_number: line.get_pos() + 1,
			input_name: Rc::from(lines.get_input_name()),
		}
	}
}


pub fn compilation_error<T>(
	lines: &ScriptLineProvider,
	line: &ScriptCharProvider,
	msg: impl ToString,
) -> SedResult<T> {
	Err(SedError::new(
		1,
		format!(
			"{}:{}:{}: error: {}",
			lines.get_input_name(), lines.get_line_number(), line.get_pos() + 1, msg.to_string()
		),
	))
}

fn location_error<T>(location: &ScriptLocation, msg: impl ToString, code: i32) -> SedResult<T> {
	Err(SedError::new(
		code,
		format!(
			"{}:{}:{}: error: {}",
			location.input_name, location.line_number, location.column_number, msg.to_string()
		),
	))
}


pub fn semantic_error<T>(location: &ScriptLocation, msg: impl ToString) -> SedResult<T> {
	location_error(location, msg, 1)
}


pub fn runtime_error<T>(location: &ScriptLocation, msg: impl ToString) -> SedResult<T> {
	location_error(location, msg, 2)
}


pub fn input_runtime_error<T>(
	location: &ScriptLocation,
	context: &ProcessingContext,
	msg: impl ToString,
) -> SedResult<T> {
	Err(SedError::new(
		2,
		format!(
			"{}:{}:{}: {}:{} error: {}",
			location.input_name,
			location.line_number,
			location.column_number,
			context.input_name,
			context.line_number,
			msg.to_string()
		),
	))
}
}
pub mod fast_io {


// Copyright (c) 2025 Diomidis Spinellis


#[cfg(not(unix))]
use std::marker::PhantomData;
use std::{
	cell::Cell,
	fs::File,
	io::{self, BufRead, BufReader, BufWriter, Read, Write},
	path::PathBuf,
	str,
};

#[cfg(unix)]
use memchr::memchr;
#[cfg(unix)]
use memmap2::Mmap;
use crate::{host::Host, sed::error_handling::SedError};


#[cfg(unix)]
pub struct MmapLineCursor<'a> {
	_file: File,
	data:  &'a [u8],
	pos:   usize,
}

#[cfg(unix)]

pub struct NextMmapLine<'a> {
	pub content:   &'a [u8],
	pub full_span: &'a [u8],
}

#[cfg(unix)]
impl<'a> MmapLineCursor<'a> {
	fn new(file: File, data: &'a [u8]) -> Self {
		Self { _file: file, data, pos: 0 }
	}


	fn get_line(&mut self) -> io::Result<Option<NextMmapLine<'a>>> {
		if self.pos >= self.data.len() {
			return Ok(None);
		}

		let start = self.pos;

		let mut end = if let Some(pos) = memchr(b'\n', &self.data[start..]) {
			pos + start
		} else {
			self.data.len()
		};

		if end < self.data.len() {
			end += 1;
		}

		self.pos = end;
		let full_span = &self.data[start..end];
		let content = if full_span.ends_with(b"\n") {
			&full_span[..full_span.len() - 1]
		} else {
			full_span
		};

		Ok(Some(NextMmapLine { content, full_span }))
	}


	fn last_line(&mut self) -> io::Result<bool> {
		Ok(self.pos >= self.data.len())
	}
}


pub struct ReadLineCursor {
	reader: Box<dyn BufRead>,
	buffer: String,
}

impl ReadLineCursor {

	fn new<R: Read + 'static>(r: R) -> Self {
		let buf = BufReader::new(r);
		Self { reader: Box::new(buf), buffer: String::new() }
	}


	fn get_line(&mut self) -> io::Result<Option<(String, bool)>> {
		self.buffer.clear();

		let bytes_read = self.reader.read_line(&mut self.buffer)?;
		if bytes_read == 0 {
			return Ok(None);
		}

		let has_newline = self.buffer.ends_with('\n');

		if has_newline { self.buffer.pop(); }
		let line = std::mem::take(&mut self.buffer);
		Ok(Some((line, has_newline)))
	}


	fn last_line(&mut self) -> io::Result<bool> {


		Ok(self.reader.fill_buf()?.is_empty())
	}
}


#[derive(Debug, PartialEq, Eq)]
pub struct IOChunk<'a> {
	utf8_verified: Cell<bool>,
	content:       IOChunkContent<'a>,
}

impl<'a> IOChunk<'a> {

	fn from_content(content: IOChunkContent<'a>) -> Self {
		Self { utf8_verified: Cell::new(false), content }
	}


	pub fn clear(&mut self) {
		self.utf8_verified.set(true);
		match &mut self.content {
			IOChunkContent::Owned { content, has_newline, .. } => {
				content.clear();
				*has_newline = false;
			},
			#[cfg(unix)]
			_ => {
				self.content = IOChunkContent::new_owned(String::new(), false);
			},
		}
	}


	pub fn is_empty(&self) -> bool {
		self.content.len() == 0
	}


	pub fn is_newline_terminated(&self) -> bool {
		match &self.content {
			IOChunkContent::Owned { has_newline, .. } => *has_newline,
			#[cfg(unix)]
			IOChunkContent::MmapInput { full_span, .. } => {
				if let Some(&last) = full_span.last() {
					last == b'\n'
				} else {
					false
				}
			},
		}
	}


	pub fn set_to_string(&mut self, new_content: String, add_newline: bool) {
		self.utf8_verified.set(true);
		match &mut self.content {
			IOChunkContent::Owned { content, has_newline, .. } => {
				*content = new_content;
				*has_newline = add_newline;
			},
			#[cfg(unix)]
			_ => {
				self.content = IOChunkContent::new_owned(new_content, add_newline);
			},
		}
	}


	pub fn as_str(&self) -> Result<&str, SedError> {
		match &self.content {
			#[cfg(unix)]
			IOChunkContent::MmapInput { content, .. } => {
				if self.utf8_verified.get() {

					Ok(unsafe { self.content.as_str_unchecked() })
				} else {
					let result = str::from_utf8(content);
					self.utf8_verified.set(true);
					result.map_err(|e| SedError::new(2, e.to_string()))
				}
			},
			IOChunkContent::Owned { content, .. } => Ok(content),
		}
	}


	pub fn as_bytes(&self) -> &[u8] {
		match &self.content {
			#[cfg(unix)]
			IOChunkContent::MmapInput { content, .. } => content,
			IOChunkContent::Owned { content, .. } => content.as_bytes(),
		}
	}


	pub fn ensure_owned(&mut self) -> Result<(), SedError> {
		match &self.content {
			IOChunkContent::Owned { .. } => Ok(()),
			#[cfg(unix)]
			IOChunkContent::MmapInput { content, full_span, .. } => match std::str::from_utf8(content) {
				Ok(valid_str) => {
					let has_newline = full_span.last().copied() == Some(b'\n');
					self.content = IOChunkContent::new_owned(valid_str.to_string(), has_newline);
					self.utf8_verified.set(true);
					Ok(())
				},
				Err(e) => Err(SedError::new(2, e.to_string())),
			},
		}
	}


	pub fn fields_mut(&mut self) -> Result<(&mut String, &mut bool), SedError> {
		self.ensure_owned()?;

		match &mut self.content {
			IOChunkContent::Owned { content, has_newline, .. } => Ok((content, has_newline)),
			#[allow(unreachable_patterns)]
			_ => unreachable!("ensure_owned should convert to Owned"),
		}
	}
}


#[derive(Debug, PartialEq, Eq)]
enum IOChunkContent<'a> {
	#[cfg(unix)]
	MmapInput {
		content:   &'a [u8],
		full_span: &'a [u8],
	},
	Owned {
		content:     String,
		has_newline: bool,
		#[cfg(not(unix))]
		_phantom:    PhantomData<&'a ()>,
	},
}

impl IOChunkContent<'_> {

	pub fn new_owned(content: String, has_newline: bool) -> Self {
		#[cfg(unix)]
		return IOChunkContent::Owned { content, has_newline };

		#[cfg(not(unix))]
		return IOChunkContent::Owned {
			content,
			has_newline,

			_phantom: std::marker::PhantomData,
		};
	}

	#[cfg(unix)]
	unsafe fn as_str_unchecked(&self) -> &str {
		match self {
			IOChunkContent::MmapInput { content, .. } => unsafe {
				std::str::from_utf8_unchecked(content)
			},
			IOChunkContent::Owned { content, .. } => content,
		}
	}


	pub fn len(&self) -> usize {
		match self {
			#[cfg(unix)]
			IOChunkContent::MmapInput { content, .. } => content.len(),

			IOChunkContent::Owned { content, .. } => content.len(),
		}
	}
}


pub enum LineReader<'a> {
	#[cfg(unix)]
	MmapInput {
		_mapped_file: Mmap,
		cursor:      MmapLineCursor<'a>,
	},
	ReadInput(ReadLineCursor),
	#[cfg(not(unix))]
	_Phantom(std::marker::PhantomData<&'a ()>),
}


fn line_reader_read_input(file: File) -> io::Result<LineReader<'static>> {
	let boxed: Box<dyn Read> = Box::new(file);
	let reader = BufReader::new(boxed);
	Ok(LineReader::ReadInput(ReadLineCursor::new(reader)))
}

impl<'a> LineReader<'a> {


	pub fn open_with_host(path: &PathBuf, host: &mut Host) -> io::Result<Self> {
		if path.as_os_str() == "-" {

			let boxed: Box<dyn Read> = Box::new(host.stdin.file().clone());
			let reader = BufReader::new(boxed);
			return Ok(LineReader::ReadInput(ReadLineCursor::new(reader)));
		}


		let file = host.open_read(path)?;

		#[cfg(unix)]
		{
			match unsafe { Mmap::map(&file) } {
				Ok(mapped_file) => {

					let slice: &'static [u8] =
						unsafe { std::slice::from_raw_parts(mapped_file.as_ptr(), mapped_file.len()) };
					let cursor = MmapLineCursor::new(file, slice);
					Ok(LineReader::MmapInput { _mapped_file: mapped_file, cursor })
				},

				Err(_) => line_reader_read_input(file),
			}
		}

		#[cfg(not(unix))]
		{
			line_reader_read_input(file)
		}
	}


	pub fn get_line(&mut self) -> io::Result<Option<IOChunk<'a>>> {
		match self {
			#[cfg(unix)]
			LineReader::MmapInput { cursor, .. } => {
				if let Some(NextMmapLine { content, full_span }) = cursor.get_line()? {
					let chunk = IOChunk::from_content(IOChunkContent::MmapInput { content, full_span });

					Ok(Some(chunk))
				} else {
					Ok(None)
				}
			},

			LineReader::ReadInput(cursor) => {
				if let Some((line, _has_newline)) = cursor.get_line()? {
					let chunk = IOChunk::from_content(IOChunkContent::new_owned(line, _has_newline));
					Ok(Some(chunk))
				} else {
					Ok(None)
				}
			},

			#[cfg(not(unix))]
			LineReader::_Phantom(_) => unreachable!("_Phantom should never be constructed"),
		}
	}


	pub fn last_line(&mut self) -> io::Result<bool> {
		match self {
			#[cfg(unix)]
			LineReader::MmapInput { cursor, .. } => cursor.last_line(),

			LineReader::ReadInput(cursor) => cursor.last_line(),

			#[cfg(not(unix))]
			LineReader::_Phantom(_) => unreachable!("_Phantom should never be constructed"),
		}
	}
}


pub trait OutputWrite: Write {}
impl<T: Write> OutputWrite for T {}


#[cfg(unix)]
#[derive(Clone)]
struct MmapOutput {
	out_ptr: *const u8,
	len:     usize,
}


pub struct OutputBuffer {
	out:               BufWriter<Box<dyn OutputWrite + 'static>>,
	line_buffered:     bool,
	#[cfg(unix)]
	max_pending_write: usize,

	#[cfg(unix)]
	mmap_chunk:        Option<MmapOutput>,


	pending_newline:   bool,
}


#[cfg(unix)]
const MAX_PENDING_WRITE_NON_FILE: usize = 64 * 1024;

impl OutputBuffer {
	#[cfg(not(unix))]
	pub fn new(w: Box<dyn OutputWrite + 'static>, line_buffered: bool) -> Self {
		Self {
			out: BufWriter::new(w),
			line_buffered,
			pending_newline: false,
		}
	}

	#[cfg(unix)]
	pub fn new(w: Box<dyn OutputWrite + 'static>, line_buffered: bool) -> Self {
		Self {
			out: BufWriter::new(w),
			line_buffered,
			max_pending_write: if line_buffered {
				MAX_PENDING_WRITE_NON_FILE
			} else {
				usize::MAX
			},
			mmap_chunk: None,
			pending_newline: false,
		}
	}


	pub fn write_str<S: Into<String>>(&mut self, s: S) -> io::Result<()> {
		let mut s = s.into();
		let has_newline = s.ends_with('\n');
		if has_newline {
			s.truncate(s.len() - 1);
		}
		self.write_chunk(&IOChunk::from_content(IOChunkContent::new_owned(s, has_newline)))
	}


	pub fn copy_file(&mut self, path: &PathBuf) -> io::Result<()> {

		#[cfg(unix)]
		{
			self.flush_mmap(WriteRange::Complete)?;
		}

		let Ok(file) = File::open(path) else {

			return Ok(());
		};

		let mut reader = BufReader::new(file);
		if self.line_buffered {
			let mut buf = [0; 8 * 1024];
			loop {
				let len = reader.read(&mut buf)?;
				if len == 0 {
					break;
				}
				self.out.write_all(&buf[..len])?;
				if buf[..len].contains(&b'\n') {
					self.flush_completed_line()?;
				}
			}
		} else {
			io::copy(&mut reader, &mut self.out)?;
		}
		Ok(())
	}


	fn flush_completed_line(&mut self) -> io::Result<()> {
		if self.line_buffered {
			self.out.flush()?;
		}
		Ok(())
	}
}


impl Write for OutputBuffer {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		let s =
			std::str::from_utf8(buf).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
		self.write_str(s)?;
		Ok(buf.len())
	}

	fn flush(&mut self) -> io::Result<()> {
		self.flush()
	}
}

#[cfg(unix)]
#[derive(Debug, PartialEq)]
enum WriteRange {
	Complete,
	Blocks,
	None,
}

#[cfg(unix)]
impl OutputBuffer {

	pub fn write_chunk(&mut self, new_chunk: &IOChunk) -> io::Result<()> {
		if new_chunk.is_empty() && !new_chunk.is_newline_terminated() {
			return Ok(());
		}

		if self.pending_newline {
			self.flush_mmap(WriteRange::Complete)?;
			self.out.write_all(b"\n")?;
			self.pending_newline = false;
			self.flush_completed_line()?;
		}

		match &new_chunk.content {
			IOChunkContent::MmapInput { full_span, .. } => {
				let new_ptr = full_span.as_ptr();
				let new_len = full_span.len();


				let (flush_action, reset) = if let Some(old_chunk) = self.mmap_chunk.as_mut() {

					if unsafe { old_chunk.out_ptr.add(old_chunk.len) } == new_ptr {

						old_chunk.len += new_len;
						if old_chunk.len > self.max_pending_write {

							(WriteRange::Blocks, false)
						} else {
							(WriteRange::None, false)
						}
					} else {

						(WriteRange::Complete, true)
					}
				} else {

					(WriteRange::None, true)
				};

				if flush_action != WriteRange::None {
					self.flush_mmap(flush_action)?;
				}
				if reset {
					self.mmap_chunk = Some(MmapOutput { out_ptr: new_ptr, len: new_len });
				}
				self.pending_newline = !new_chunk.is_newline_terminated();
			},

			IOChunkContent::Owned { content, has_newline, .. } => {
				self.flush_mmap(WriteRange::Complete)?;
				self.out.write_all(content.as_bytes())?;
				if *has_newline {
					self.out.write_all(b"\n")?;
				}
				self.pending_newline = !has_newline;
			},
		}

		if self.line_buffered && new_chunk.is_newline_terminated() {


			self.flush_mmap(WriteRange::Complete)?;
			self.flush_completed_line()?;
		}
		Ok(())
	}


	#[cfg(unix)]
	fn flush_mmap(&mut self, _cover: WriteRange) -> io::Result<()> {
		if let Some(chunk) = self.mmap_chunk.as_mut() {
			let slice = unsafe { std::slice::from_raw_parts(chunk.out_ptr, chunk.len) };
			self.out.write_all(slice)?;
			let written = slice.len();
			chunk.len -= written;
			unsafe { chunk.out_ptr = chunk.out_ptr.add(written) };
		}
		Ok(())
	}


	pub fn flush_pending_newline(&mut self) -> io::Result<()> {
		if self.pending_newline {
			self.flush_mmap(WriteRange::Complete)?;
			self.out.write_all(b"\n")?;
			self.pending_newline = false;
			self.flush_completed_line()?;
		}
		Ok(())
	}


	pub fn flush(&mut self) -> io::Result<()> {
		self.flush_mmap(WriteRange::Complete)?;
		self.out.flush()
	}
}

#[cfg(not(unix))]
impl OutputBuffer {

	pub fn write_chunk(&mut self, chunk: &IOChunk) -> io::Result<()> {
		if chunk.is_empty() && !chunk.is_newline_terminated() {
			return Ok(());
		}

		if self.pending_newline {
			self.out.write_all(b"\n")?;
			self.pending_newline = false;
			self.flush_completed_line()?;
		}

		match &chunk.content {
			IOChunkContent::Owned { content, has_newline, .. } => {
				self.out.write_all(content.as_bytes())?;
				if *has_newline {
					self.out.write_all(b"\n")?;
				}
				self.pending_newline = !has_newline;
				if *has_newline {
					self.flush_completed_line()?;
				}
				Ok(())
			},
		}
	}


	pub fn flush_pending_newline(&mut self) -> io::Result<()> {
		if self.pending_newline {
			self.out.write_all(b"\n")?;
			self.pending_newline = false;
			self.flush_completed_line()?;
		}
		Ok(())
	}


	pub fn flush(&mut self) -> io::Result<()> {
		self.out.flush()
	}
}


}
pub mod fast_regex {


// Copyright (c) 2025 Diomidis Spinellis


use std::{error::Error, sync::LazyLock};

use fancy_regex::{
	CaptureMatches as FancyCaptureMatches, Captures as FancyCaptures, Regex as FancyRegex,
};
use memchr::memmem;
use regex::{
	Regex as RustRegex,
	bytes::{CaptureMatches as ByteCaptureMatches, Captures as ByteCaptures, Regex as ByteRegex},
};
use crate::sed::error_handling::{SedError, SedResult};

use crate::sed::fast_io::IOChunk;


static NEEDS_FANCY_RE: LazyLock<RustRegex> =
	LazyLock::new(|| regex::Regex::new(r"\\[1-9]").unwrap());


static NEEDS_RE: LazyLock<RustRegex> = LazyLock::new(|| {
	regex::Regex::new(
		r"(?x) # Turn on verbose mode
          ( ^                   # Non-escaped: i.e. at BOL
             | ^[^\\]            # or after a BOL non \
             | [^\\] {2}         # or after two non \ characters
             | \\.               # or after a consumed or escaped \
           )
           (                     # A potentially incompatible match
              [.?|+(\[{*]        # Any magic RE character
                                 # Some are operators so illegal at
                                 # BOL but they should error there,
                                 # not use them as literals.
             | \\[WwDdSsPp]      # Unicode classes
             | \\[AzBb]          # Empty matches
             | \\[0-9]           # Back-references
           )
        ",
	)
	.unwrap()
});

#[derive(Clone, Debug)]

enum AnchoredMatch {
	Begin,
	End,
	Both,
	Free,
}

#[derive(Clone, Debug)]

pub struct LiteralMatcher {
	needle:     Vec<u8>,
	match_type: AnchoredMatch,
}

impl LiteralMatcher {

	pub fn new(needle: &str) -> Self {
		let needle_bytes = needle.as_bytes();
		if needle_bytes[0] == b'^' && needle_bytes[needle_bytes.len() - 1] == b'$' {
			LiteralMatcher {
				match_type: AnchoredMatch::Both,
				needle:     needle_bytes[1..needle_bytes.len() - 1].to_vec(),
			}
		} else if needle_bytes[0] == b'^' {
			LiteralMatcher {
				match_type: AnchoredMatch::Begin,
				needle:     needle_bytes[1..needle_bytes.len()].to_vec(),
			}
		} else if needle_bytes[needle_bytes.len() - 1] == b'$' {
			LiteralMatcher {
				match_type: AnchoredMatch::End,
				needle:     needle_bytes[0..needle_bytes.len() - 1].to_vec(),
			}
		} else {
			LiteralMatcher { match_type: AnchoredMatch::Free, needle: needle_bytes.to_vec() }
		}
	}


	fn anchored_find(&self, haystack: &[u8]) -> Option<usize> {
		let nlen = self.needle.len();
		let hlen = haystack.len();

		match self.match_type {
			AnchoredMatch::Both => {
				if hlen == nlen && haystack == self.needle.as_slice() {
					Some(0)
				} else {
					None
				}
			},
			AnchoredMatch::Begin => {
				if hlen >= nlen && &haystack[..nlen] == self.needle.as_slice() {
					Some(0)
				} else {
					None
				}
			},
			AnchoredMatch::End => {
				if hlen >= nlen && &haystack[hlen - nlen..] == self.needle.as_slice() {
					Some(hlen - nlen)
				} else {
					None
				}
			},
			AnchoredMatch::Free => memmem::find(haystack, &self.needle),
		}
	}


	pub fn is_match(&self, haystack: &[u8]) -> bool {
		self.anchored_find(haystack).is_some()
	}


	pub fn find<'t>(&self, haystack: &'t [u8]) -> Option<(usize, usize, &'t str)> {
		self.anchored_find(haystack).and_then(|start| {
			let end = start + self.needle.len();
			std::str::from_utf8(&haystack[start..end])
				.ok()
				.map(|s| (start, end, s))
		})
	}


	pub fn iter<'t>(
		&'t self,
		haystack: &'t [u8],
	) -> Box<dyn Iterator<Item = (usize, usize, &'t str)> + 't> {
		let needle = &self.needle;
		let nlen = needle.len();

		match self.match_type {
			AnchoredMatch::Both | AnchoredMatch::Begin | AnchoredMatch::End => {

				Box::new(self.find(haystack).into_iter())
			},
			AnchoredMatch::Free => {

				Box::new(memmem::find_iter(haystack, needle).filter_map(move |start| {
					let end = start + nlen;
					std::str::from_utf8(&haystack[start..end])
						.ok()
						.map(|s| (start, end, s))
				}))
			},
		}
	}
}


pub fn remove_escapes(pattern: &str) -> String {
	let mut chars = pattern.chars().peekable();
	let mut result = String::with_capacity(pattern.len());

	while let Some(c) = chars.next() {
		if c == '\\' {

			if let Some(&next) = chars.peek() {
				result.push(next);
				chars.next();
			}
		} else {
			result.push(c);
		}
	}

	result
}

#[derive(Clone, Debug)]

pub enum Regex {
	Literal(LiteralMatcher),
	Byte(ByteRegex),
	Fancy(FancyRegex),
}


pub fn ensure_dotall(pattern: &str) -> String {

	if !pattern.starts_with("(?") {
		return format!("(?s){pattern}");
	}

	let Some(close) = pattern.find(')') else {

		return pattern.to_owned();
	};


	let flags = &pattern[2..close];

	if flags.contains('m') || flags.contains('s') {
		pattern.to_owned()
	} else {
		format!("(?{flags}s){}", &pattern[close + 1..])
	}
}

impl Regex {

	pub fn new(pattern: &str) -> Result<Self, Box<dyn Error>> {
		if NEEDS_FANCY_RE.is_match(pattern) {
			Ok(Self::Fancy(FancyRegex::new(&ensure_dotall(pattern))?))
		} else if NEEDS_RE.is_match(pattern) {
			Ok(Self::Byte(ByteRegex::new(&ensure_dotall(pattern))?))
		} else {
			Ok(Self::Literal(LiteralMatcher::new(&remove_escapes(pattern))))
		}
	}


	pub fn is_match(&self, chunk: &mut IOChunk) -> SedResult<bool> {
		match self {
			Regex::Literal(m) => Ok(m.is_match(chunk.as_bytes())),
			Regex::Byte(re) => Ok(re.is_match(chunk.as_bytes())),
			Regex::Fancy(re) => {
				let text = chunk.as_str()?;
				re.is_match(text)
					.map_err(|e| SedError::new(2, e.to_string()))
			},
		}
	}


	pub fn captures_iter<'t>(&'t self, chunk: &'t IOChunk) -> SedResult<CaptureMatches<'t>> {
		match self {
			Regex::Literal(m) => {
				let haystack = chunk.as_bytes();
				Ok(CaptureMatches::Literal(Box::new(
					m.iter(haystack)
						.map(|(start, end, text)| Ok(Captures::Literal(Match { start, end, text }))),
				)))
			},

			Regex::Byte(re) => Ok(CaptureMatches::Byte(re.captures_iter(chunk.as_bytes()))),

			Regex::Fancy(re) => {
				let text = chunk.as_str()?;
				Ok(CaptureMatches::Fancy(re.captures_iter(text)))
			},
		}
	}


	pub fn captures_len(&self) -> usize {
		match self {
			Regex::Literal(_) => 1,
			Regex::Byte(re) => re.captures_len(),
			Regex::Fancy(re) => re.captures_len(),
		}
	}


	pub fn captures<'t>(&self, chunk: &'t IOChunk) -> SedResult<Option<Captures<'t>>> {
		match self {
			Regex::Literal(m) => {
				let haystack = chunk.as_bytes();
				match m.find(haystack) {
					Some((start, end, text)) => Ok(Some(Captures::Literal(Match { start, end, text }))),
					None => Ok(None),
				}
			},

			Regex::Byte(re) => {
				let bytes = chunk.as_bytes();
				Ok(re.captures(bytes).map(Captures::Byte))
			},

			Regex::Fancy(re) => {
				let text = chunk.as_str()?;
				match re.captures(text) {
					Ok(Some(caps)) => Ok(Some(Captures::Fancy(caps))),
					Ok(None) => Ok(None),
					Err(e) => Err(SedError::new(2, e.to_string())),
				}
			},
		}
	}


	pub fn find<'t>(&self, chunk: &'t IOChunk) -> SedResult<Option<Match<'t>>> {
		match self {
			Regex::Literal(m) => {
				let haystack = chunk.as_bytes();
				match m.find(haystack) {
					Some((start, end, text)) => Ok(Some(Match { start, end, text })),
					None => Ok(None),
				}
			},

			Regex::Byte(re) => {
				let haystack = chunk.as_bytes();
				if let Some(m) = re.find(haystack) {

					let text = std::str::from_utf8(&haystack[m.start()..m.end()])
						.map_err(|e| SedError::new(2, e.to_string()))?;
					Ok(Some(Match { start: m.start(), end: m.end(), text }))
				} else {
					Ok(None)
				}
			},

			Regex::Fancy(re) => {
				let text = chunk.as_str()?;
				match re.find(text) {
					Ok(Some(m)) => {
						Ok(Some(Match { start: m.start(), end: m.end(), text: m.as_str() }))
					},
					Ok(None) => Ok(None),
					Err(e) => Err(SedError::new(2, e.to_string())),
				}
			},
		}
	}
}


pub enum CaptureMatches<'t> {
	Literal(Box<dyn Iterator<Item = SedResult<Captures<'t>>> + 't>),
	Byte(ByteCaptureMatches<'t, 't>),
	Fancy(FancyCaptureMatches<'t, 't>),
}

impl<'t> Iterator for CaptureMatches<'t> {
	type Item = SedResult<Captures<'t>>;

	fn next(&mut self) -> Option<Self::Item> {
		match self {
			CaptureMatches::Literal(iter) => iter.next(),
			CaptureMatches::Byte(iter) => iter.next().map(|caps| Ok(Captures::Byte(caps))),
			CaptureMatches::Fancy(iter) => match iter.next() {
				Some(Ok(caps)) => Some(Ok(Captures::Fancy(caps))),
				Some(Err(e)) => {
					Some(Err(SedError::new(2, format!("error retrieving RE captures: {e}"))))
				},
				None => None,
			},
		}
	}
}

#[derive(Clone, Debug)]

pub struct Match<'t> {
	start: usize,
	end:   usize,
	text:  &'t str,
}


impl<'t> Match<'t> {
	pub fn start(&self) -> usize {
		self.start
	}

	pub fn end(&self) -> usize {
		self.end
	}

	pub fn as_str(&self) -> &'t str {
		self.text
	}
}


pub enum Captures<'t> {
	Literal(Match<'t>),
	Byte(ByteCaptures<'t>),
	Fancy(FancyCaptures<'t>),
}

impl<'t> Captures<'t> {


	pub fn get(&self, i: usize) -> SedResult<Option<Match<'t>>> {
		match self {
			Captures::Literal(m) => Ok(if i == 0 { Some(m.clone()) } else { None }),
			Captures::Byte(caps) => match caps.get(i) {
				Some(m) => Ok(Some(Match {
					start: m.start(),
					end:   m.end(),
					text:  std::str::from_utf8(m.as_bytes())
						.map_err(|e| SedError::new(1, e.to_string()))?,
				})),
				None => Ok(None),
			},
			Captures::Fancy(caps) => match caps.get(i) {
				Some(m) => Ok(Some(Match { start: m.start(), end: m.end(), text: m.as_str() })),
				None => Ok(None),
			},
		}
	}


	pub fn len(&self) -> usize {
		match self {
			Captures::Literal(_) => 1,
			Captures::Byte(caps) => caps.len(),
			Captures::Fancy(caps) => caps.len(),
		}
	}

}


}
pub mod in_place {


// Copyright (c) 2025 Diomidis Spinellis


#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
	fs,
	path::{Path, PathBuf},
};

use tempfile::NamedTempFile;
use uucore::display::Quotable;

use brush_core::openfiles::OpenFile;
use crate::{
	host::is_regular_file,
	sed::{
		command::ProcessingContext,
		error_handling::{IoContext, SedError, SedResult},
		fast_io::OutputBuffer,
	},
};


pub struct InPlace {
	stdout:              OpenFile,
	pub output:          OutputBuffer,
	pub in_place:        bool,
	pub in_place_suffix: Option<String>,
	pub follow_symlinks: bool,
	pub temp_file:       Option<NamedTempFile>,
	pub original_path:   Option<PathBuf>,
}

impl InPlace {


	pub fn new_with_stdout(context: ProcessingContext, stdout: OpenFile) -> Self {
		let line_buffered = !is_regular_file(&stdout);
		Self {
			stdout: stdout.clone(),
			output:          OutputBuffer::new(Box::new(stdout.clone()), line_buffered),
			in_place:        context.in_place,
			in_place_suffix: context.in_place_suffix,
			follow_symlinks: context.follow_symlinks,
			temp_file:       None,
			original_path:   None,
		}
	}


	pub fn begin(&mut self, file_name: &Path) -> SedResult<&mut OutputBuffer> {
		let resolved = if self.follow_symlinks {
			fs::canonicalize(file_name)
				.map_err_context(|| format!("resolving symlink {}", file_name.quote()))?
		} else {
			file_name.to_path_buf()
		};
		self.begin_resolved(&resolved)
	}


	fn begin_resolved(&mut self, file_name: &Path) -> SedResult<&mut OutputBuffer> {
		if !self.in_place {
			self.output =
				OutputBuffer::new(Box::new(self.stdout.clone()), !is_regular_file(&self.stdout));
			return Ok(&mut self.output);
		}

		let metadata = fs::metadata(file_name).map_err_context(|| {
			format!("error Reading metadata of {} for in-place edit", file_name.quote())
		})?;

		if !metadata.is_file() {
			return Err(SedError::new(
				2,
				format!("cannot in-place edit non-regular file {}", file_name.quote()),
			));
		}

		let dir = file_name.parent().unwrap_or_else(|| Path::new("."));
		let temp_file = NamedTempFile::new_in(dir)
			.map_err_context(|| format!("error creating temporary file in {}", dir.quote()))?;


		#[cfg(unix)]
		{
			let mode = metadata.mode() & 0o7777;
			let perms = fs::Permissions::from_mode(mode);
			fs::set_permissions(temp_file.path(), perms)?;
		}

		let output = OutputBuffer::new(
			Box::new(temp_file.reopen().expect("reopening NamedTempFile")),
			false,
		);
		self.output = output;
		self.temp_file = Some(temp_file);
		self.original_path = Some(file_name.to_path_buf());

		Ok(&mut self.output)
	}


	pub fn end(&mut self) -> SedResult<()> {
		self.output.flush()?;

		if !self.in_place {
			return Ok(());
		}

		let orig = self.original_path.take().expect("original_path unset");
		let temp = self.temp_file.take().expect("temp_file unset");


		if let Some(ref suffix) = self.in_place_suffix {
			let mut backup_path = orig.clone();
			let file_name = backup_path
				.file_name()
				.expect("Missing file name for backup")
				.to_os_string();
			let mut backup_name = file_name;
			backup_name.push(suffix);
			backup_path.set_file_name(backup_name);

			let _ = fs::remove_file(&backup_path);

			fs::rename(&orig, &backup_path).map_err_context(|| {
				format!("error backing up {} to {}", orig.quote(), backup_path.quote())
			})?;
		} else {
			if orig.exists() {
				fs::remove_file(&orig).map_err_context(|| {
					format!("error removing original input file {}", orig.quote())
				})?;
			}
		}


		match temp.persist(&orig) {
			Ok(_) => {},
			Err(e) => {
				return Err(SedError::io(
					e.error.kind(),
					format!(
						"error persisting temporary file {} to {}",
						e.file.path().quote(),
						orig.quote()
					),
				));
			},
		}

		Ok(())
	}
}


}
pub mod named_writer {


// Copyright (c) 2025 Diomidis Spinellis


use std::{
	cell::RefCell,
	fs::{File, OpenOptions},
	io::{BufWriter, Write},
	path::PathBuf,
	rc::Rc,
};

use uucore::display::Quotable;
use crate::sed::error_handling::SedResult;

use crate::sed::error_handling::{ScriptLocation, runtime_error};

thread_local! {

	 static FLUSH_LIST: RefCell<Vec<Rc<RefCell<NamedWriter>>>> = const { RefCell::new(Vec::new()) };
}

#[derive(Debug)]

pub struct NamedWriter {
	pub path: PathBuf,
	writer:   BufWriter<File>,
	location: ScriptLocation,
}

impl NamedWriter {

	pub fn new(path: PathBuf, location: ScriptLocation) -> SedResult<Rc<RefCell<Self>>> {

		let file = OpenOptions::new()
			.create(true)
			.write(true)
			.truncate(true)
			.open(&path)
			.map_err(|e| {
				runtime_error::<()>(&location, format!("creating file {}: {}", path.quote(), e))
					.unwrap_err()
			})?;

		let writer =
			Rc::new(RefCell::new(NamedWriter { path, writer: BufWriter::new(file), location }));

		FLUSH_LIST.with(|list| list.borrow_mut().push(Rc::clone(&writer)));
		Ok(writer)
	}


	pub fn write_line(&mut self, line: &str) -> SedResult<()> {
		writeln!(self.writer, "{line}").map_err(|e| {
			runtime_error::<()>(&self.location, format!("writing to file {}: {e}", self.path.quote()))
				.unwrap_err()
		})
	}


	pub fn flush(&mut self) -> SedResult<()> {
		self.writer.flush().map_err(|e| {
			runtime_error::<()>(
				&self.location,
				format!("writing to file {}: {}", self.path.quote(), e),
			)
			.unwrap_err()
		})
	}
}


pub fn flush_all() -> SedResult<()> {
	FLUSH_LIST.with(|cell| {
		for handle in cell.borrow_mut().drain(..) {
			handle.borrow_mut().flush()?;
		}

		Ok(())
	})
}


pub fn reset() {
	FLUSH_LIST.with(|cell| cell.borrow_mut().clear());
}
}
pub mod processor {


// Copyright (c) 2025 Diomidis Spinellis


use std::{borrow::Cow, cell::RefCell, path::PathBuf, rc::Rc};

use uucore::display::Quotable;

use crate::host::Host;
use crate::sed::error_handling::{IoContext, SedResult};

use crate::sed::{
	command::{
		Address, AppendElement, Command, CommandData, InputAction, ProcessingContext, Transliteration,
	},
	error_handling::{ScriptLocation, input_runtime_error},
	fast_io::{IOChunk, LineReader, OutputBuffer},
	fast_regex::Regex,
	in_place::InPlace,
	named_writer,
};


macro_rules! extract_variant {
	($cmd:expr, $variant:ident) => {
		match &$cmd.data {
			CommandData::$variant(inner) => inner,
			_ => panic!(concat!("Expected ", stringify!($variant), " command data")),
		}
	};
}


fn match_address(
	addr: &Address,
	reader: &mut LineReader,
	pattern: &mut IOChunk,
	context: &mut ProcessingContext,
	location: &ScriptLocation,
) -> SedResult<bool> {
	match addr {
		Address::Re(re) => {
			let regex = re_or_saved_re(re.as_ref(), context, location)?;
			match regex.is_match(pattern) {
				Ok(result) => Ok(result),
				Err(e) => input_runtime_error(location, context, e.to_string()),
			}
		},

		Address::Line(lineno) => Ok(context.line_number == *lineno),


		Address::Last => Ok(reader.last_line()? && (context.last_file || context.separate)),

		_ => panic!("invalid address type in match_address"),
	}
}

#[allow(dead_code)]

fn applies(
	command: &mut Command,
	reader: &mut LineReader,
	pattern: &mut IOChunk,
	context: &mut ProcessingContext,
) -> SedResult<bool> {
	let linenum = context.line_number;

	let result = if command.addr1.is_none() && command.addr2.is_none() {

		Ok(true)
	} else if let Some(addr2) = &command.addr2 {

		if let Some(start) = command.start_line {

			match addr2 {
				Address::RelLine(n) => {
					if linenum - start > *n {
						command.start_line = None;
						Ok(false)
					} else {
						Ok(true)
					}
				},
				Address::Line(n) => {

					if linenum > *n {
						command.start_line = None;
						Ok(false)
					} else {
						Ok(true)
					}
				},
				Address::StepMatch(step) => Ok((linenum - start).is_multiple_of(*step)),
				Address::StepEnd(step) => {

					if linenum.is_multiple_of(*step) {
						command.start_line = None;
					}
					Ok(true)
				},
				_ => {
					if match_address(addr2, reader, pattern, context, &command.location)? {
						command.start_line = None;
						context.last_address = true;
					}
					Ok(true)
				},
			}
		} else if let Some(addr1) = &command.addr1 {

			if match_address(addr1, reader, pattern, context, &command.location)? {
				match addr2 {
					Address::Line(n) if linenum >= *n => {
						context.last_address = true;
					},
					Address::RelLine(n) if *n == 0 => {
						context.last_address = true;
					},
					_ => {
						command.start_line = Some(linenum);
					},
				}
				Ok(true)
			} else {
				Ok(false)
			}
		} else {
			Ok(false)
		}
	} else if let Some(addr1) = &command.addr1 {

		Ok(match_address(addr1, reader, pattern, context, &command.location)?)
	} else {

		panic!("impossible address combination");
	};

	if command.non_select {
		result.map(|v| !v)
	} else {
		result
	}
}


fn write_chunk(
	output: &mut OutputBuffer,
	context: &ProcessingContext,
	chunk: &IOChunk,
) -> std::io::Result<()> {
	output.write_chunk(chunk)?;

	if context.unbuffered {
		output.flush()?;
	}

	Ok(())
}


fn re_or_saved_re<'a>(
	regex: Option<&Regex>,
	context: &'a mut ProcessingContext,
	location: &ScriptLocation,
) -> SedResult<&'a Regex> {
	if let Some(re) = regex {

		context.saved_regex = Some(re.clone());

		Ok(context.saved_regex.as_ref().unwrap())
	} else if let Some(ref saved_re) = context.saved_regex {

		Ok(saved_re)
	} else {
		input_runtime_error(location, context, "no previous regular expression")
	}
}

#[cfg(unix)]
fn shell_command(cmd: &str, host: &Host) -> std::process::Command {
	let mut c = std::process::Command::new("sh");
	c.arg("-c").arg(cmd);


	c.current_dir(host.cwd());
	c.env_clear().envs(host.env());
	c
}


fn substitute(
	pattern: &mut IOChunk,
	command: &Command,
	context: &mut ProcessingContext,
	output: &mut OutputBuffer,
	host: &mut Host,
) -> SedResult<()> {
	let sub = extract_variant!(command, Substitution);

	let mut count = 0;
	let mut last_end = 0;
	let mut result = String::new();
	let mut replaced = false;

	let mut text: Option<&str> = None;

	let regex = re_or_saved_re(sub.regex.as_ref(), context, &command.location)?;


	let subst_result = match (sub.occurrence, sub.replacement.max_group_number) {
		(1, 0) => {

			match regex.find(pattern) {
				Err(e) => Err(e),
				Ok(Some(m)) => {
					text = Some(pattern.as_str()?);
					result.push_str(&text.unwrap()[last_end..m.start()]);

					let replacement = sub.replacement.apply_match(&m);
					result.push_str(&replacement);
					replaced = true;
					last_end = m.end();
					Ok(())
				},
				Ok(None) => Ok(()),
			}
		},

		(1, _) => {

			match regex.captures(pattern) {
				Err(e) => Err(e),
				Ok(Some(caps)) => {
					let m = caps.get(0)?.unwrap();
					text = Some(pattern.as_str()?);
					result.push_str(&text.unwrap()[last_end..m.start()]);

					let replacement = sub.replacement.apply_captures(command, &caps)?;
					result.push_str(&replacement);
					replaced = true;
					last_end = m.end();
					Ok(())
				},
				Ok(None) => Ok(()),
			}
		},

		(..) => {


			'captures: {
				for caps_result in regex.captures_iter(pattern)? {
					let caps = match caps_result {
						Ok(caps) => caps,
						Err(e) => break 'captures Err(e),
					};
					count += 1;

					let m = caps.get(0)?.unwrap();


					if text.is_none() {
						text = Some(pattern.as_str()?);
					}
					result.push_str(&text.unwrap()[last_end..m.start()]);

					if sub.occurrence == 0 || count == sub.occurrence {
						let replacement = sub.replacement.apply_captures(command, &caps)?;
						result.push_str(&replacement);
						replaced = true;
					} else {

						result.push_str(m.as_str());
					}

					last_end = m.end();


					if count == sub.occurrence {
						break 'captures Ok(());
					}
				}
				break 'captures Ok(());
			}
		},
	};


	if let Err(e) = subst_result {
		return input_runtime_error(&command.location, context, e.to_string());
	}


	if replaced {
		result.push_str(&text.unwrap()[last_end..]);

		pattern.set_to_string(result, pattern.is_newline_terminated());


		if sub.execute {
			let cmd_str = pattern.as_str()?.to_string();
			let output_bytes = shell_command(&cmd_str, host).output().map_err(|e| {
				input_runtime_error::<()>(
					&command.location,
					context,
					format!("failed to execute shell command: {e}"),
				)
				.unwrap_err()
			})?;
			let mut shell_out = String::from_utf8_lossy(&output_bytes.stdout).into_owned();
			if shell_out.ends_with("\r\n") {

				shell_out.truncate(shell_out.len() - 2);
			} else if shell_out.ends_with('\n') {

				shell_out.pop();
			}
			pattern.set_to_string(shell_out, pattern.is_newline_terminated());
		}

		if sub.print_flag {
			write_chunk(output, context, pattern)?;
		}


		if let Some(ref writer) = sub.write_file {
			writer.borrow_mut().write_line(pattern.as_str()?)?;
		}
		context.substitution_made = true;
	}

	Ok(())
}


fn transliterate(pattern: &mut IOChunk, trans: &Transliteration) -> SedResult<()> {
	let text = pattern.as_str()?;
	let mut result = String::with_capacity(text.len());
	let mut replaced = false;


	for ch in text.chars() {
		let mapped = trans.lookup(ch);
		if mapped != ch {
			replaced = true;
		}
		result.push(mapped);
	}


	if replaced {
		pattern.set_to_string(result, pattern.is_newline_terminated());
	}

	Ok(())
}


fn flush_appends(output: &mut OutputBuffer, context: &mut ProcessingContext) -> SedResult<()> {
	for elem in &context.append_elements {
		match elem {
			AppendElement::Text(text) => {
				output.write_str(&**text)?;
			},
			AppendElement::Path(path) => {
				output.copy_file(path)?;
			},
		}
	}
	context.append_elements.clear();
	Ok(())
}


fn list(output: &mut OutputBuffer, line: &IOChunk, max_width: usize) -> SedResult<()> {

	if line.is_empty() {
		if line.is_newline_terminated() {
			output.write_str("$\n")?;
		}
		return Ok(());
	}

	let line = line.as_str()?;
	let mut buff = String::new();
	let mut line_width = 0;

	for ch in line.chars() {
		if ch == '\n' {
			buff.push_str("$\n");
			output.write_str(&buff)?;
			line_width = 0;
			continue;
		}

		let mut char_buff = [0u8; 1];
		let out_str: Cow<str> = match ch {
			'\x07' => Cow::Borrowed(r"\a"),
			'\x08' => Cow::Borrowed(r"\b"),
			'\x0b' => Cow::Borrowed(r"\v"),
			'\x0c' => Cow::Borrowed(r"\f"),
			'\\' => Cow::Borrowed(r"\\"),
			'\r' => Cow::Borrowed(r"\r"),
			'\t' => Cow::Borrowed(r"\t"),
			c if c.is_ascii_control() => Cow::Owned(format!("\\{:03o}", ch as u8)),
			c if c == ' ' || c.is_ascii_graphic() => Cow::Borrowed(ch.encode_utf8(&mut char_buff)),
			c if (c as u32) <= 0xffff => Cow::Owned(format!("\\u{:04X}", c as u32)),
			_ => Cow::Owned(format!("\\U{:08X}", ch as u32)),
		};


		let out_len = out_str.len();
		if line_width + out_len + 1 > max_width {
			buff.push_str("\\\n");
			output.write_str(&buff)?;
			line_width = 0;
			buff.clear();
		}
		buff.push_str(out_str.as_ref());
		line_width += out_len;
	}

	if !buff.is_empty() {
		buff.push_str("$\n");
		output.write_str(buff)?;
	}
	Ok(())
}


fn process_address_0(
	commands: Option<Rc<RefCell<Command>>>,
	output: &mut OutputBuffer,
) -> SedResult<()> {


	{
		let mut current = commands;
		while let Some(cmd_rc) = current {
			let next = {
				let cmd = cmd_rc.borrow();

				if cmd.code == 'r' && matches!(cmd.addr1, Some(Address::Line(0))) && cmd.addr2.is_none()
				{
					let path = extract_variant!(cmd, Path);
					output.copy_file(path)?;
				}

				cmd.next.clone()
			};
			current = next;
		}
	}
	Ok(())
}

#[allow(clippy::cognitive_complexity)]

fn process_file(
	commands: Option<Rc<RefCell<Command>>>,
	reader: &mut LineReader,
	output: &mut OutputBuffer,
	context: &mut ProcessingContext,
	host: &mut Host,
) -> SedResult<()> {
	process_address_0(commands.clone(), output)?;


	'lines: while let Some(mut pattern) = reader.get_line()? {


		if host.is_cancelled() {
			break;
		}
		context.line_number += 1;
		context.substitution_made = false;

		let mut current: Option<Rc<RefCell<Command>>> =
			if let Some(action) = context.input_action.take() {

				let current_line = pattern.as_str()?;
				let mut combined_lines = action.prepend;
				combined_lines.push('\n');
				combined_lines.push_str(current_line);

				pattern.set_to_string(combined_lines, pattern.is_newline_terminated());
				action.next_command
			} else {

				commands.clone()
			};


		while let Some(command_rc) = current.take() {
			let mut command = command_rc.borrow_mut();

			if !applies(&mut command, reader, &mut pattern, context)? {

				current.clone_from(&command.next);
				continue;
			}

			match command.code {
				'{' => {

					let body = extract_variant!(command, BranchTarget);
					current.clone_from(body);
					continue;
				},
				'}' => {

				},
				'a' => {

					let text = extract_variant!(command, Text);
					context
						.append_elements
						.push(AppendElement::Text(text.clone()));
				},
				'b' => {

					let target = extract_variant!(command, BranchTarget);
					if target.is_some() {

						current.clone_from(target);
						continue;
					}

					break;
				},
				'c' => {


					pattern.clear();
					if command.addr2.is_none() || context.last_address || reader.last_line()? {
						let text = extract_variant!(command, Text);
						output.write_str(text.as_ref())?;
					}
					break;
				},
				'd' => {

					pattern.clear();
					break;
				},
				'D' => {

					if let Some(pos) = pattern.as_str()?.find('\n') {
						let (s, _) = pattern.fields_mut()?;
						s.drain(..=pos);
						current.clone_from(&commands);
						continue;
					}

					pattern.clear();
					break;
				},
				'g' => {

					pattern.set_to_string(context.hold.content.clone(), context.hold.has_newline);
				},
				'G' => {

					let (pat_content, pat_has_newline) = pattern.fields_mut()?;
					pat_content.push('\n');
					pat_content.push_str(&context.hold.content);
					*pat_has_newline = context.hold.has_newline;
				},
				'h' => {

					context.hold.content = pattern.as_str()?.to_string();
					context.hold.has_newline = pattern.is_newline_terminated();
				},
				'H' => {

					context.hold.content.push('\n');
					context.hold.content.push_str(pattern.as_str()?);
					context.hold.has_newline = pattern.is_newline_terminated();
				},
				'i' => {

					let text = extract_variant!(command, Text);
					output.write_str(text.as_ref())?;
				},
				'l' => {
					let width = *extract_variant!(command, Number);
					list(output, &pattern, width)?;
				},
				'n' => {
					break;
				},
				'N' => {
					flush_appends(output, context)?;


					context.input_action = Some(InputAction {
						next_command: command.next.clone(),
						prepend:      pattern.as_str()?.to_string(),
					});
					continue 'lines;
				},
				'p' => {
					write_chunk(output, context, &pattern)?;
				},
				'P' => {
					let line = pattern.as_str()?;
					if let Some(pos) = line.find('\n') {
						output.write_str(&line[..=pos])?;
					} else {
						write_chunk(output, context, &pattern)?;
					}
				},
				'q' => {

					host.fail(*extract_variant!(command, Number) as i32);
					context.stop_processing = true;
					break;
				},
				'Q' => {

					host.fail(*extract_variant!(command, Number) as i32);
					context.stop_processing = true;
					context.quiet = true;
					break;
				},
				'r' => {

					let path = extract_variant!(command, Path);
					context
						.append_elements
						.push(AppendElement::Path(path.clone()));
				},
				's' => {
					substitute(&mut pattern, &command, context, output, host)?;
				},
				't' if !context.substitution_made => {  },
				't' => {


					let target = extract_variant!(command, BranchTarget);
					context.substitution_made = false;
					if target.is_some() {

						current.clone_from(target);
						continue;
					}

					break;
				},
				'w' => {

					let writer = extract_variant!(command, NamedWriter);
					writer.borrow_mut().write_line(pattern.as_str()?)?;
				},
				'x' => {

					let (pat_content, pat_has_newline) = pattern.fields_mut()?;


					if !context.hold.content.is_empty() || context.hold.has_newline {
						std::mem::swap(pat_has_newline, &mut context.hold.has_newline);
					}
					std::mem::swap(pat_content, &mut context.hold.content);
				},
				'y' => {
					let trans = extract_variant!(command, Transliteration);
					transliterate(&mut pattern, trans)?;
				},
				'z' => {


					let (pat_content, _) = pattern.fields_mut()?;
					pat_content.clear();
				},
				':' => {

				},
				'=' => {

					output.write_str(format!("{}\n", context.line_number))?;
				},

				_ => panic!("invalid command code"),
			}

			current.clone_from(&command.next);
		}

		if !context.quiet {
			write_chunk(output, context, &pattern)?;
		}

		flush_appends(output, context)?;

		if context.stop_processing {
			output.flush_pending_newline()?;
			break;
		}
	}


	if context.separate
		&& !context.quiet
		&& let Some(action) = context.input_action.take()
	{
		let mut pending = action.prepend;
		pending.push('\n');
		output.write_str(pending)?;
		if context.unbuffered {
			output.flush()?;
		}
	}

	Ok(())
}


fn reset_latched_address_ranges(range_commands: &mut [Rc<RefCell<Command>>]) {
	for cmd_rc in range_commands.iter() {
		let mut cmd = cmd_rc.borrow_mut();

		cmd.start_line =

            if let Some(addr1) = &cmd.addr1 && matches!(addr1, Address::Line(0)) {
                Some(0)
            } else {
                None
            };
	}
}


pub fn process_all_files(
	commands: Option<Rc<RefCell<Command>>>,
	files: Vec<PathBuf>,
	context: &mut ProcessingContext,
	host: &mut Host,
) -> SedResult<()> {


	let mut in_place = InPlace::new_with_stdout(context.clone(), host.stdout_clone());
	let last_file_index = files.len() - 1;

	for (index, path) in files.iter().enumerate() {
		context.last_file = index == last_file_index;
		let mut reader = LineReader::open_with_host(path, host)
			.map_err_context(|| format!("error opening input file {}", path.quote()))?;
		let resolved_path = host.resolve(path);
		if in_place.in_place {
			host.note_write(&resolved_path);
		}
		let output = in_place.begin(&resolved_path)?;

		if context.separate || index == 0 {
			context.line_number = 0;
			reset_latched_address_ranges(&mut context.range_commands);


			context.hold.content.clear();
			context.hold.has_newline = true;
		}

		context.input_name = path.quote().to_string();
		process_file(commands.clone(), &mut reader, output, context, host)?;


		if context.last_file
			&& !context.separate
			&& !context.quiet
			&& let Some(action) = context.input_action.take()
		{
			let mut pending = action.prepend;
			pending.push('\n');
			output.write_str(pending)?;
		}

		in_place.end()?;

		if context.stop_processing {
			break;
		}
	}


	named_writer::flush_all()?;

	Ok(())
}
}
pub mod script_char_provider {


// Copyright (c) 2025 Diomidis Spinellis


#[derive(Debug)]
pub struct ScriptCharProvider {
	line: Vec<char>,
	pos:  usize,
}

impl ScriptCharProvider {
	pub fn new(line_string: &str) -> Self {
		Self { line: line_string.chars().collect(), pos: 0 }
	}


	pub fn advance(&mut self) {
		if self.pos < self.line.len() {
			self.pos += 1;
		}
	}


	pub fn retreat(&mut self, n: usize) {
		self.pos = self.pos.saturating_sub(n);
	}


	pub fn set_position(&mut self, pos: usize) {
		self.pos = pos;
	}


	pub fn current(&self) -> char {
		self.line[self.pos]
	}


	pub fn eol(&self) -> bool {
		self.pos >= self.line.len()
	}


	pub fn eat_spaces(&mut self) {
		while self.pos < self.line.len() && self.line[self.pos].is_whitespace() {
			self.pos += 1;
		}
	}


	pub fn get_pos(&self) -> usize {
		self.pos
	}
}


}
pub mod script_line_provider {


// Copyright (c) 2025 Diomidis Spinellis


use std::{
	fmt,
	fs::File,
	io::{BufRead, BufReader},
	path::PathBuf,
};

use uucore::display::Quotable;

use brush_core::openfiles::OpenFile;
use crate::sed::error_handling::{IoContext, SedResult};

#[derive(Debug, PartialEq)]

pub enum ScriptValue {
	StringVal(String),
	PathVal(PathBuf),
}


pub struct ScriptLineProvider {
	sources: Vec<ScriptValue>,
	state:   State,
	stdin:   Option<OpenFile>,
	cwd:     PathBuf,
}


enum State {
	NotStarted,
	Active {
		index:       usize,
		reader:      Box<dyn BufRead>,
		input_name:  String,
		line_number: usize,
	},
	Done,
}

impl ScriptLineProvider {


	pub fn with_stdin(sources: Vec<ScriptValue>, stdin: OpenFile, cwd: PathBuf) -> Self {
		Self { sources, state: State::NotStarted, stdin: Some(stdin), cwd }
	}


	pub fn get_line_number(&self) -> usize {
		match &self.state {
			State::Active { line_number, .. } => *line_number,
			_ => 0,
		}
	}


	pub fn get_input_name(&self) -> &str {
		match &self.state {
			State::Active { input_name, .. } => input_name.as_str(),
			_ => "",
		}
	}


	pub fn next_line(&mut self) -> SedResult<Option<String>> {
		let mut line = String::new();

		loop {
			let advance = match &mut self.state {
				State::NotStarted => Some(0),
				State::Active { index, reader, line_number, .. } => {
					line.clear();
					let bytes = reader.read_line(&mut line)?;
					if bytes == 0 {
						Some(*index + 1)
					} else {
						*line_number += 1;

						if line.ends_with('\n') {
							line.pop();
						}
						return Ok(Some(line));
					}
				},
				State::Done => {
					return Ok(None);
				},
			};

			if let Some(next_index) = advance {
				self.advance_source(next_index)?;
			}
		}
	}


	fn advance_source(&mut self, next_index: usize) -> SedResult<()> {
		if next_index >= self.sources.len() {
			self.state = State::Done;
			return Ok(());
		}

		match &self.sources[next_index] {
			ScriptValue::StringVal(s) => {
				let cursor = std::io::Cursor::new(s.clone());
				self.state = State::Active {
					index:       next_index,
					reader:      Box::new(BufReader::new(cursor)),
					input_name:  format!("<script argument {}>", next_index + 1),
					line_number: 0,
				};
			},
			ScriptValue::PathVal(p) => {
				if p.to_string_lossy() == "-" {
					self.state = State::Active {
						index:       next_index,
						reader:      Box::new(BufReader::new(self.stdin.as_ref().expect("stdin stream missing").clone())),
						input_name:  "<stdin>".to_string(),
						line_number: 0,
					};
				} else {


					let normalized = brush_core::sys::fs::normalize_shell_path(p);
					let resolved = if normalized.is_absolute() {
						normalized.into_owned()
					} else {
						self.cwd.join(normalized)
					};
					let file = File::open(resolved)
						.map_err_context(|| format!("error opening script file {}", p.quote()))?;
					self.state = State::Active {
						index:       next_index,
						reader:      Box::new(BufReader::new(file)),
						input_name:  p.to_string_lossy().to_string(),
						line_number: 0,
					};
				}
			},
		}

		Ok(())
	}
}

impl fmt::Debug for State {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			State::NotStarted => f.debug_struct("NotStarted").finish(),
			State::Done => f.debug_struct("Done").finish(),
			State::Active { index, input_name, line_number, .. } => f
				.debug_struct("Active")
				.field("index", index)
				.field("input_name", input_name)
				.field("line_number", line_number)
				.field("reader", &"<BufRead>")
				.finish(),
		}
	}
}


}

use std::{collections::HashMap, ffi::OsString, io::Write, path::PathBuf};

use brush_core::{ShellExtensions, builtins::Registration};

use clap::{Arg, ArgMatches, Command, arg};

use crate::host::{Host, Utility, format_usage, matches_parser, util};
use crate::sed::error_handling::{SedError, SedResult};

use crate::sed::{
	command::{ProcessingContext, StringSpace},
	processor::process_all_files,
	script_line_provider::ScriptValue,
};

const ABOUT: &str = "Stream editor for filtering and transforming text";
const USAGE: &str = "sed [OPTION]... [script] [file]...";


fn sed_main(matches: &ArgMatches, host: &mut Host) -> SedResult<()> {
	let (scripts, files) = get_scripts_files(matches)?;
	let mut context = build_context(matches, host.cwd());

	let executable = compiler::compile_with_stdin(scripts, &mut context, host.stdin.file().clone(), host.resolve("."))?;
	process_all_files(executable, files, &mut context, host)?;
	Ok(())
}


fn normalize_args(argv: Vec<OsString>) -> Vec<OsString> {
	let mut out = Vec::with_capacity(argv.len());
	let mut iter = argv.into_iter().peekable();

	if let Some(first) = iter.next() {
		out.push(first);
	}
	let mut past_separator = false;
	while let Some(arg) = iter.next() {
		if !past_separator {
			if arg == "--" {
				past_separator = true;
			} else if is_in_place_flag(&arg) && iter.peek().is_some_and(|next| next.is_empty()) {


				out.push(arg);
				iter.next();
				continue;
			} else if let Some(s) = arg.to_str()
				&& let Some(suffix) = s.strip_prefix("-i")
				&& !suffix.is_empty()
				&& !suffix.starts_with('=')
			{
				out.push(format!("-i={suffix}").into());
				continue;
			}
		}
		out.push(arg);
	}
	out
}


fn is_in_place_flag(arg: &OsString) -> bool {
	let Some(cluster) = arg.to_str().and_then(|arg| arg.strip_prefix('-')) else {
		return false;
	};
	let Some(prefix) = cluster.strip_suffix('i') else {
		return false;
	};

	!cluster.is_empty()
		&& !cluster.starts_with('-')
		&& prefix
			.chars()
			.all(|flag| matches!(flag, 'a' | 'E' | 'r' | 'n' | 's' | 'u' | 'z'))
}

#[allow(clippy::cognitive_complexity)]
fn uu_app() -> Command {
	let util_name = "sed";

	Command::new(util_name)
		.version("0.1.1")
		.about(ABOUT)
		.override_usage(format_usage(USAGE))
		.args_override_self(true)
		.infer_long_args(true)
		.args([
			arg!([script] "Script to execute if not otherwise provided."),
			Arg::new("file")
				.help("Input files")
				.value_parser(clap::value_parser!(PathBuf))
				.num_args(0..),
			Arg::new("all-output-files")
				.long("all-output-files")
				.short('a')
				.help("Create or truncate all output files before processing.")
				.action(clap::ArgAction::SetTrue),
			arg!(--debug "Annotate program execution."),
			Arg::new("regexp-extended")
				.short('E')
				.long("regexp-extended")
				.short_alias('r')
				.help("Use extended regular expressions.")
				.action(clap::ArgAction::SetTrue),
			arg!(-e --expression <SCRIPT> "Add script to executed commands.")
				.action(clap::ArgAction::Append),

			Arg::new("script-file")
				.short('f')
				.long("script-file")
				.help("Specify script file.")
				.value_parser(clap::value_parser!(PathBuf))
				.action(clap::ArgAction::Append),
			Arg::new("follow-symlinks")
				.long("follow-symlinks")
				.help("Follow symlinks when processing in place.")
				.action(clap::ArgAction::SetTrue),

			Arg::new("in-place")
				.short('i')
				.long("in-place")
				.help("Edit files in place, making a backup if SUFFIX is supplied.")
				.num_args(0..=1)


				.require_equals(true)
				.default_missing_value(""),

			arg!(-l --length <NUM> "Specify the 'l' command line-wrap length.")
				.value_parser(clap::value_parser!(u32)),
			arg!(-n --quiet "Suppress automatic printing of pattern space.").aliases(["silent"]),
			arg!(--posix "Disable non-POSIX extensions."),
			arg!(-s --separate "Consider files as separate rather than as a long stream."),
			arg!(--sandbox "Operate in a sandbox by disabling e/r/w commands."),
			arg!(-u --unbuffered "Load minimal input data and flush output buffers regularly."),
			Arg::new("null-data")
				.short('z')
				.long("null-data")
				.help("Separate lines by NUL characters.")
				.action(clap::ArgAction::SetTrue),
		])
}


fn get_scripts_files(matches: &ArgMatches) -> SedResult<(Vec<ScriptValue>, Vec<PathBuf>)> {
	let mut indexed_scripts: Vec<(usize, ScriptValue)> = Vec::new();
	let mut files: Vec<PathBuf> = Vec::new();

	let script_through_options =

        matches.contains_id("expression") || matches.contains_id("script-file");

	if script_through_options {


		if let Some(val) = matches.get_one::<String>("script") {
			files.push(PathBuf::from(val.to_owned()));
		}
	} else {


		if let Some(val) = matches.get_one::<String>("script") {
			indexed_scripts.push((0, ScriptValue::StringVal(val.to_owned())));
		} else {
			return Err(SedError::new(1, "missing script"));
		}
	}


	if let Some(indices) = matches.indices_of("expression") {
		for (idx, val) in indices.zip(matches.get_many::<String>("expression").unwrap_or_default()) {
			indexed_scripts.push((idx, ScriptValue::StringVal(val.to_owned())));
		}
	}


	if let Some(indices) = matches.indices_of("script-file") {
		for (idx, val) in indices.zip(
			matches
				.get_many::<PathBuf>("script-file")
				.unwrap_or_default(),
		) {
			indexed_scripts.push((idx, ScriptValue::PathVal(val.to_owned())));
		}
	}


	indexed_scripts.sort_by_key(|k| k.0);

	let scripts = indexed_scripts
		.into_iter()
		.map(|(_, value)| value)
		.collect();

	let rest_files: Vec<PathBuf> = matches
		.get_many::<PathBuf>("file")
		.unwrap_or_default()
		.cloned()
		.collect();
	if !rest_files.is_empty() {
		files.extend(rest_files);
	}


	if files.is_empty() {
		files.push(PathBuf::from("-"));
	}

	Ok((scripts, files))
}


fn build_context(matches: &ArgMatches, cwd: &std::path::Path) -> ProcessingContext {
	ProcessingContext {
		all_output_files: matches.get_flag("all-output-files"),
		debug:            matches.get_flag("debug"),
		regex_extended:   matches.get_flag("regexp-extended"),
		follow_symlinks:  matches.get_flag("follow-symlinks"),
		in_place:         matches.contains_id("in-place"),
		in_place_suffix:  matches
			.get_one::<String>("in-place")
			.and_then(|s| if s.is_empty() { None } else { Some(s.clone()) }),
		length:           matches.get_one::<u32>("length").map_or(70, |v| *v as usize),
		quiet:            matches.get_flag("quiet"),
		posix:            matches.get_flag("posix"),
		separate:         matches.get_flag("separate"),
		sandbox:          matches.get_flag("sandbox"),
		unbuffered:       matches.get_flag("unbuffered"),
		null_data:        matches.get_flag("null-data"),
		cwd:              cwd.to_path_buf(),


		input_name:           "<stdin>".to_string(),
		line_number:          0,
		last_address:         false,
		last_line:            false,
		last_file:            false,
		stop_processing:      false,
		saved_regex:          None,
		input_action:         None,
		hold:                 StringSpace { content: String::new(), has_newline: true },
		parsed_block_nesting: 0,
		label_to_command_map: HashMap::new(),
		range_commands:       Vec::new(),
		substitution_made:    false,
		append_elements:      Vec::new(),
	}
}


pub(crate) struct Sed {
	matches: ArgMatches,
}

matches_parser!(Sed, uu_app);

impl Utility for Sed {
	const NAME: &'static str = "sed";

	fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		Ok(normalize_args(argv))
	}

	fn run(self, host: &mut Host) -> i32 {
		named_writer::reset();
		if !self.matches.args_present() {
			let _ = write!(host.stdout, "{}", uu_app().render_help());
			return 1;
		}
		match sed_main(&self.matches, host) {
			Ok(()) => host.exit_code(),
			Err(error) => {
				let code = error.code();
				host.error(error, if code == 0 { 1 } else { code });
				host.exit_code()
			}
		}
	}
}


pub(crate) fn sed_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Sed, SE>()
}


