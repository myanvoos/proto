use brush_parser::{
	ParserOptions, SourceInfo,
	ast::{
		AndOr, Command, CommandPrefixOrSuffixItem, CompoundListItem, IoFileRedirectTarget,
		IoRedirect, Pipeline, Program, SeparatorOperator, SimpleCommand, Word,
	},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainSegment {
	pub command:                   String,
	pub program:                   String,
	pub run_if_previous_succeeded: bool,
	pub suppress_errexit:          bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandPlan {
	Single { program: String },

	Piped,

	Chain { segments: Vec<ChainSegment> },

	Compound,

	Unsupported,
}

#[must_use]
pub fn analyze(command: &str) -> CommandPlan {
	if command.trim().is_empty() {
		return CommandPlan::Unsupported;
	}
	let Some(program) = parse(command) else {
		return CommandPlan::Unsupported;
	};
	classify(&program)
}

fn parse(command: &str) -> Option<Program> {
	let options = ParserOptions::default();
	let source_info = SourceInfo::default();
	let reader = std::io::Cursor::new(command.as_bytes());
	let mut parser = brush_parser::Parser::new(reader, &options, &source_info);
	parser.parse_program().ok()
}

fn classify(program: &Program) -> CommandPlan {
	if let Some(chain) = classify_chain(program) {
		return chain;
	}

	let items: Vec<&CompoundListItem> = program
		.complete_commands
		.iter()
		.flat_map(|cl| cl.0.iter())
		.collect();

	if items.is_empty() {
		return CommandPlan::Unsupported;
	}

	if items.len() > 1 {
		return CommandPlan::Compound;
	}

	let CompoundListItem(and_or, separator) = items[0];

	if matches!(separator, SeparatorOperator::Async) {
		return CommandPlan::Compound;
	}

	if !and_or.additional.is_empty() {
		return CommandPlan::Compound;
	}

	classify_pipeline(&and_or.first).unwrap_or(CommandPlan::Unsupported)
}

fn classify_chain(program: &Program) -> Option<CommandPlan> {
	let items: Vec<&CompoundListItem> = program
		.complete_commands
		.iter()
		.flat_map(|cl| cl.0.iter())
		.collect();

	if items.is_empty() {
		return None;
	}

	let mut segments = Vec::new();
	let mut run_if_previous_succeeded = false;

	for (item_index, item) in items.iter().enumerate() {
		if matches!(item.1, SeparatorOperator::Async) {
			return None;
		}

		let is_last_item = item_index + 1 == items.len();
		let mut pipeline = &item.0.first;
		let mut additional = item.0.additional.iter().peekable();

		loop {
			let (command, program) = simple_segment(pipeline)?;

			let suppress_errexit = additional
				.peek()
				.is_some_and(|and_or| matches!(and_or, AndOr::And(_)));
			segments.push(ChainSegment {
				command,
				program,
				run_if_previous_succeeded,
				suppress_errexit,
			});

			let Some(and_or) = additional.next() else {
				run_if_previous_succeeded = false;
				break;
			};

			match and_or {
				AndOr::And(next_pipeline) => {
					run_if_previous_succeeded = true;
					pipeline = next_pipeline;
				},
				AndOr::Or(_) => return None,
			}
		}

		if !is_last_item {
			run_if_previous_succeeded = false;
		}
	}

	(segments.len() >= 2).then_some(CommandPlan::Chain { segments })
}

fn word_has_command_substitution(word: &Word) -> bool {
	word.value.contains("$(") || word.value.contains('`')
}

fn command_prefix_or_suffix_item_is_safe(item: &CommandPrefixOrSuffixItem) -> bool {
	match item {
		CommandPrefixOrSuffixItem::IoRedirect(io) => io_redirect_is_safe(io),
		CommandPrefixOrSuffixItem::Word(word) => !word_has_command_substitution(word),
		CommandPrefixOrSuffixItem::AssignmentWord(_, word) => !word_has_command_substitution(word),
		CommandPrefixOrSuffixItem::ProcessSubstitution(..) => false,
	}
}

fn io_redirect_is_safe(io: &IoRedirect) -> bool {
	match io {
		IoRedirect::File(_, _, target) => match target {
			IoFileRedirectTarget::Filename(word) | IoFileRedirectTarget::Duplicate(word) => {
				!word_has_command_substitution(word)
			},
			IoFileRedirectTarget::Fd(_) => true,
			IoFileRedirectTarget::ProcessSubstitution(..) => false,
		},

		IoRedirect::HereDocument(..) => false,
		IoRedirect::HereString(_, word) => !word_has_command_substitution(word),
		IoRedirect::OutputAndError(word, _) => !word_has_command_substitution(word),
	}
}

fn simple_command_is_safe(simple: &SimpleCommand) -> bool {
	if let Some(prefix) = simple.prefix.as_ref()
		&& prefix
			.0
			.iter()
			.any(|item| !command_prefix_or_suffix_item_is_safe(item))
	{
		return false;
	}
	if let Some(suffix) = simple.suffix.as_ref()
		&& suffix
			.0
			.iter()
			.any(|item| !command_prefix_or_suffix_item_is_safe(item))
	{
		return false;
	}
	if let Some(word) = simple.word_or_name.as_ref()
		&& word_has_command_substitution(word)
	{
		return false;
	}
	true
}

fn simple_segment(pipeline: &Pipeline) -> Option<(String, String)> {
	if pipeline.timed.is_some() || pipeline.bang || pipeline.seq.is_empty() {
		return None;
	}

	for command in &pipeline.seq {
		let Command::Simple(simple) = command else {
			return None;
		};
		if !simple_command_is_safe(simple) {
			return None;
		}
	}

	let Command::Simple(first) = pipeline.seq.first()? else {
		return None;
	};
	let program_word = first.word_or_name.as_ref()?;
	let program = program_word.to_string();
	if program.trim().is_empty() {
		return None;
	}

	let command = pipeline.to_string();
	if !reconstruction_reparses_to_same_shape(&command, pipeline.seq.len()) {
		return None;
	}
	Some((command, program))
}

fn reconstruction_reparses_to_same_shape(reconstructed: &str, expected_stages: usize) -> bool {
	let Some(program) = parse(reconstructed) else {
		return false;
	};
	let mut items = program.complete_commands.iter().flat_map(|cl| cl.0.iter());
	let Some(CompoundListItem(and_or, separator)) = items.next() else {
		return false;
	};

	if items.next().is_some()
		|| !and_or.additional.is_empty()
		|| matches!(separator, SeparatorOperator::Async)
	{
		return false;
	}
	let pipeline = &and_or.first;
	!pipeline.bang && pipeline.timed.is_none() && pipeline.seq.len() == expected_stages
}

fn classify_pipeline(pipeline: &Pipeline) -> Option<CommandPlan> {
	if pipeline.seq.len() > 1 {
		return Some(CommandPlan::Piped);
	}
	let single = pipeline.seq.first()?;
	match single {
		Command::Simple(simple) => {
			let program_word = simple.word_or_name.as_ref()?;
			let program_text = program_word.to_string();
			if program_text.trim().is_empty() {
				return None;
			}
			Some(CommandPlan::Single { program: program_text })
		},

		Command::Compound(..) | Command::Function(_) | Command::ExtendedTest(..) => {
			Some(CommandPlan::Compound)
		},
	}
}
