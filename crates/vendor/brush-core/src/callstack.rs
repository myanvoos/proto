

use std::{
	borrow::Cow,
	collections::{HashSet, VecDeque},
	sync::Arc,
};

use brush_parser::ast::SourceLocation;

use crate::{functions, traps};


#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct ScriptCall {

	pub call_type:   ScriptCallType,

	pub source_info: crate::SourceInfo,
}

impl ScriptCall {

	pub fn name(&self) -> Cow<'_, str> {
		self.source_info.source.as_str().into()
	}
}


#[derive(Clone, Copy, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum ScriptCallType {

	Source,

	Run,
}

impl std::fmt::Display for ScriptCall {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self.call_type {
			ScriptCallType::Source => write!(f, "source({})", self.source_info),
			ScriptCallType::Run => write!(f, "script({})", self.source_info),
		}
	}
}



#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum FrameType {

	Script(ScriptCall),

	Function(FunctionCall),

	TrapHandler(traps::TrapSignal),

	Eval,

	CommandString,

	InteractiveSession,
}

impl FrameType {

	pub fn name(&self) -> Cow<'_, str> {
		match self {
			Self::Script(call) => call.name(),
			Self::Function(call) => call.name(),
			Self::TrapHandler(_) => "trap".into(),
			Self::Eval => "eval".into(),
			Self::CommandString => "-c".into(),
			Self::InteractiveSession => "interactive".into(),
		}
	}


	pub const fn is_function(&self) -> bool {
		matches!(self, Self::Function(..))
	}


	pub const fn is_script(&self) -> bool {
		matches!(self, Self::Script(..))
	}


	pub const fn is_trap_handler(&self) -> bool {
		matches!(self, Self::TrapHandler(_))
	}


	pub const fn is_interactive_session(&self) -> bool {
		matches!(self, Self::InteractiveSession)
	}


	pub const fn is_command_string(&self) -> bool {
		matches!(self, Self::CommandString)
	}


	pub const fn is_sourced_script(&self) -> bool {
		matches!(self, Self::Script(call) if matches!(call.call_type, ScriptCallType::Source))
	}


	pub const fn is_run_script(&self) -> bool {
		matches!(self, Self::Script(call) if matches!(call.call_type, ScriptCallType::Run))
	}
}

impl std::fmt::Display for FrameType {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Script(call) => call.fmt(f),
			Self::Function(call) => call.fmt(f),
			Self::TrapHandler(_) => write!(f, "trap"),
			Self::Eval => write!(f, "eval"),
			Self::CommandString => write!(f, "-c"),
			Self::InteractiveSession => write!(f, "interactive"),
		}
	}
}


#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct FunctionCall {

	pub function_name: String,

	pub function:      functions::Registration,
}

impl FunctionCall {

	pub fn name(&self) -> Cow<'_, str> {
		self.function_name.as_str().into()
	}
}

impl std::fmt::Display for FunctionCall {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		write!(f, "func({})", self.function_name)
	}
}


#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Frame {

	pub frame_type:          FrameType,



	pub source_info:         crate::SourceInfo,



	pub entry:               Option<Arc<crate::SourcePosition>>,






	pub current:             Option<Arc<crate::SourcePosition>>,


	pub args:                Vec<String>,


	pub current_line_offset: usize,
}

impl Frame {


	pub fn adjusted_source_info(&self) -> crate::SourceInfo {
		self.pos_as_source_info(None)
	}



	pub fn current_pos_as_source_info(&self) -> crate::SourceInfo {
		self.pos_as_source_info(self.current.as_ref())
	}

	fn pos_as_source_info(&self, pos: Option<&Arc<crate::SourcePosition>>) -> crate::SourceInfo {
		let mut new_start = if let Some(existing_start) = &self.source_info.start {
			if let Some(current) = pos {
				Some(Arc::new(crate::SourcePosition {
					index:  existing_start.index + current.index,
					line:   existing_start.line + (current.line - 1),
					column: if current.line <= 1 {
						existing_start.column + (current.column - 1)
					} else {
						current.column
					},
				}))
			} else {
				Some(existing_start.clone())
			}
		} else {
			pos.cloned()
		};

		if self.current_line_offset > 0 {
			new_start = if let Some(new_start) = new_start {
				let mut pos = (*new_start).clone();
				pos.line += self.current_line_offset;

				Some(Arc::new(pos))
			} else {
				Some(Arc::new(crate::SourcePosition {
					index:  0,
					line:   self.current_line_offset + 1,
					column: 1,
				}))
			};
		}

		crate::SourceInfo { source: self.source_info.source.clone(), start: new_start }
	}


	pub fn current_line(&self) -> Option<usize> {
		let start_line = self.source_info.start.as_ref().map_or(1, |pos| pos.line);
		let current_line = self.current.as_ref().map(|pos| pos.line)?;

		Some(start_line.saturating_sub(1) + current_line + self.current_line_offset)
	}


	pub fn current_frame_relative_line(&self) -> Option<usize> {
		let current_line = self.current.as_ref().map(|pos| pos.line)?;
		let entry_line = self.entry.as_ref().map_or(1, |pos| pos.line);

		Some(current_line.saturating_sub(entry_line) + self.current_line_offset + 1)
	}
}


#[derive(Default)]
pub struct FormatOptions {

	pub show_args:         bool,

	pub show_entry_points: bool,
}





pub struct FormatCallStack<'a> {
	stack:   &'a CallStack,
	options: &'a FormatOptions,
}

impl<'a> FormatCallStack<'a> {







	pub const fn new(stack: &'a CallStack, options: &'a FormatOptions) -> Self {
		Self { stack, options }
	}
}

impl std::fmt::Display for FormatCallStack<'_> {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		self.stack.fmt_with_options(f, self.options)
	}
}


#[derive(Clone, Debug, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct CallStack {
	frames: VecDeque<Frame>,
	func_call_depth: usize,
	script_source_depth: usize,
	active_trap_signals: HashSet<traps::TrapSignal>,
	trap_delivery_suppress_count: usize,
}

impl CallStack {





	pub const fn format<'a>(&'a self, options: &'a FormatOptions) -> FormatCallStack<'a> {
		FormatCallStack::new(self, options)
	}







	fn fmt_with_options(
		&self,
		f: &mut std::fmt::Formatter<'_>,
		options: &FormatOptions,
	) -> std::fmt::Result {
		if self.is_empty() {
			return Ok(());
		}

		color_print::cwriteln!(f, "<underline>Call stack (most recent first):</underline>")?;

		for (index, frame) in self.iter().enumerate() {
			let si = frame.current_pos_as_source_info();

			color_print::cwrite!(
				f,
				"   <dim>#{index}</dim><yellow>|</yellow> <strong>{}</strong>",
				si.source
			)?;

			if let Some(pos) = &si.start {
				color_print::cwrite!(f, ":<cyan>{}</cyan>,<cyan>{}</cyan>", pos.line, pos.column)?;
			}

			color_print::cwrite!(f, " (<dim>{}</dim>", frame.frame_type)?;

			if options.show_entry_points {
				if let Some(entry) = &frame.entry {
					let entry_si = frame.pos_as_source_info(Some(entry));
					if let Some(entry_start) = &entry_si.start {
						color_print::cwrite!(
							f,
							" <dim>entered at {}:{}</dim>",
							entry_si.source,
							entry_start
						)?;
					}
				}
			}

			color_print::cwriteln!(f, ")")?;

			if !frame.args.is_empty() && options.show_args {
				for (i, arg) in frame.args.iter().enumerate() {
					color_print::cwriteln!(f, "     <yellow>${}</yellow>: <blue>{}</blue>", i + 1, arg)?;
				}
			}
		}

		Ok(())
	}
}

impl std::fmt::Display for CallStack {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		self.fmt_with_options(f, &FormatOptions::default())
	}
}

impl std::ops::Index<usize> for CallStack {
	type Output = Frame;

	fn index(&self, index: usize) -> &Self::Output {
		&self.frames[index]
	}
}

impl CallStack {

	pub fn new() -> Self {
		Self::default()
	}



	pub fn pop(&mut self) -> Option<Frame> {
		let frame = self.frames.pop_front()?;

		if frame.frame_type.is_function() {
			self.func_call_depth = self.func_call_depth.saturating_sub(1);
		}

		if frame.frame_type.is_sourced_script() {
			self.script_source_depth = self.script_source_depth.saturating_sub(1);
		}

		if let FrameType::TrapHandler(signal) = &frame.frame_type {
			self.active_trap_signals.remove(signal);
		}

		Some(frame)
	}



	pub fn current_frame(&self) -> Option<&Frame> {
		self.frames.front()
	}





	pub fn current_pos_as_source_info(&self) -> crate::SourceInfo {
		let Some(frame) = self.frames.front() else {
			return crate::SourceInfo::default();
		};

		frame.current_pos_as_source_info()
	}


	pub fn set_current_pos(&mut self, position: Option<Arc<crate::SourcePosition>>) {
		if let Some(frame) = self.frames.front_mut() {
			frame.current = position;
		}
	}







	pub(crate) fn increment_current_line_offset(&mut self, delta: usize) {
		let Some(frame) = self.frames.front_mut() else {
			return;
		};

		frame.current_line_offset += delta;
	}








	pub fn push_script(
		&mut self,
		call_type: ScriptCallType,
		source_info: &crate::SourceInfo,
		args: impl IntoIterator<Item = String>,
	) {
		self.frames.push_front(Frame {
			frame_type:          FrameType::Script(ScriptCall {
				call_type,
				source_info: source_info.to_owned(),
			}),
			args:                args.into_iter().collect(),
			source_info:         source_info.to_owned(),
			current_line_offset: 0,
			current:             None,
			entry:               None,
		});

		if matches!(call_type, ScriptCallType::Source) {
			self.script_source_depth += 1;
		}
	}







	pub fn push_trap_handler(
		&mut self,
		signal: traps::TrapSignal,
		handler: Option<&traps::TrapHandler>,
	) {
		let source_info = handler.map_or_else(crate::SourceInfo::default, |h| h.source_info.clone());

		self.frames.push_front(Frame {
			frame_type: FrameType::TrapHandler(signal),
			args: vec![],
			source_info,
			current_line_offset: 0,
			current: None,
			entry: None,
		});

		self.active_trap_signals.insert(signal);
	}


	pub fn push_eval(&mut self) {
		self.frames.push_front(Frame {
			frame_type:          FrameType::Eval,
			args:                vec![],
			source_info:         crate::SourceInfo::from("eval"),
			current_line_offset: 0,
			current:             None,
			entry:               None,
		});
	}


	pub fn push_command_string(&mut self) {
		self.frames.push_front(Frame {
			frame_type:          FrameType::CommandString,
			args:                vec![],
			source_info:         crate::SourceInfo::from("environment"),
			current_line_offset: 0,
			current:             None,
			entry:               None,
		});
	}


	pub fn push_interactive_session(&mut self) {
		self.frames.push_front(Frame {
			frame_type:          FrameType::InteractiveSession,
			args:                vec![],
			current_line_offset: 0,
			source_info:         crate::SourceInfo::from("main"),
			current:             None,
			entry:               None,
		});
	}








	pub fn push_function(
		&mut self,
		name: impl Into<String>,
		function: &functions::Registration,
		args: impl IntoIterator<Item = String>,
	) {
		self.frames.push_front(Frame {
			frame_type:          FrameType::Function(FunctionCall {
				function_name: name.into(),
				function:      function.to_owned(),
			}),
			args:                args.into_iter().collect(),
			source_info:         function.source().clone(),
			entry:               function.definition().location().map(|span| span.start),
			current:             None,
			current_line_offset: 0,
		});

		self.func_call_depth += 1;
	}


	pub fn iter_function_calls(&self) -> impl Iterator<Item = &FunctionCall> {
		self.iter().filter_map(|frame| {
			if let FrameType::Function(call) = &frame.frame_type {
				Some(call)
			} else {
				None
			}
		})
	}


	pub fn iter_script_calls(&self) -> impl Iterator<Item = &ScriptCall> {
		self.iter().filter_map(|frame| {
			if let FrameType::Script(call) = &frame.frame_type {
				Some(call)
			} else {
				None
			}
		})
	}



	pub fn in_sourced_script(&self) -> bool {
		self
			.iter_script_calls()
			.next()
			.is_some_and(|call| matches!(call.call_type, ScriptCallType::Source))
	}


	pub const fn function_call_depth(&self) -> usize {
		self.func_call_depth
	}


	pub const fn script_source_depth(&self) -> usize {
		self.script_source_depth
	}



	pub fn is_trap_signal_active(&self, signal: traps::TrapSignal) -> bool {
		self.active_trap_signals.contains(&signal)
	}




	pub fn clear_active_trap_signals(&mut self) {
		self.active_trap_signals.clear();
	}


	pub const fn is_trap_delivery_suppressed(&self) -> bool {
		self.trap_delivery_suppress_count > 0
	}




	pub const fn acquire_trap_delivery_block(&mut self) {
		self.trap_delivery_suppress_count += 1;
	}



	pub const fn release_trap_delivery_block(&mut self) {
		self.trap_delivery_suppress_count = self.trap_delivery_suppress_count.saturating_sub(1);
	}



	pub fn in_function(&self) -> bool {
		self.iter_function_calls().next().is_some()
	}


	pub fn depth(&self) -> usize {
		self.frames.len()
	}


	pub fn is_empty(&self) -> bool {
		self.frames.is_empty()
	}



	pub fn iter(&self) -> impl Iterator<Item = &Frame> {
		self.frames.iter()
	}



	pub fn iter_mut(&mut self) -> impl Iterator<Item = &mut Frame> {
		self.frames.iter_mut()
	}
}


