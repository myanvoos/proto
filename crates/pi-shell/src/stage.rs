//! Per-command stage records: the opaque JSON the coding agent renders as one
//! card per command.
//!
//! A stage is one simple command of a run. Its identity is the engine's
//! [`CmdTag::seq`](crate::bash::CmdTag::seq), the same tag output bytes carry,
//! so a stage record, its output and a `protolens` dispatch's `stageIndex`
//! all name the same execution.
//!
//! The shape matches the former shell's `CommandTrace`: `index`, `command`,
//! `route`, `state`, `exitCode`, `elapsedMs`, `sourceSpan` and bounded
//! `stdout`/`stderr` previews.

use std::{collections::HashMap, sync::Arc};

use bstr::ByteSlice;
use parking_lot::Mutex;
use serde::Serializer;

use crate::bash::{
	CmdTag, Event, EventData, EventKind, EventMask, EventSink, UnitId, event::ResolvedKind,
};

/// Most stages one run records.
const STAGE_LIMIT: usize = 128;
/// Most bytes of one command's source a stage keeps.
const COMMAND_LIMIT: usize = 16 * 1024;
/// Most bytes of one stage's stdout or stderr a stage keeps.
const STREAM_LIMIT: usize = 16 * 1024;
/// Most bytes of one compiled unit kept for slicing command text.
const UNIT_LIMIT: usize = 1024 * 1024;

#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Capture {
	#[serde(rename = "text", serialize_with = "serialize_text")]
	data:      Vec<u8>,
	bytes:     usize,
	truncated: bool,
	complete:  bool,
}

fn serialize_text<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
	serializer.serialize_str(&String::from_utf8_lossy(bytes))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Stage {
	index:             u64,
	#[serde(skip_serializing_if = "Option::is_none")]
	parent:            Option<u64>,
	command:           String,
	command_truncated: bool,
	route:             String,
	omitted_after:     usize,
	#[serde(skip_serializing_if = "Option::is_none")]
	source_span:       Option<[u64; 2]>,
	state:             &'static str,
	#[serde(skip_serializing_if = "Option::is_none")]
	exit_code:         Option<i32>,
	#[serde(skip_serializing_if = "Option::is_none")]
	signal:            Option<i32>,
	#[serde(skip_serializing_if = "Option::is_none")]
	elapsed_ms:        Option<u64>,
	stdout:            Capture,
	stderr:            Capture,
}

/// The stage records of one run. Cheap to clone; clones share the records.
#[derive(Clone, Default)]
pub struct StageTrace {
	inner: Arc<Mutex<Inner>>,
}

#[derive(Default)]
struct Inner {
	stages: Vec<Stage>,
	/// Compiled unit sources, for slicing a command's text from its span.
	units:  HashMap<UnitId, Vec<u8>>,
}

impl StageTrace {
	/// A run with no stages yet.
	pub fn new() -> Self {
		Self::default()
	}

	/// Mark the stage `index` as routed to `route` (the `protolens` callout
	/// uses this to split tool cards per dispatch).
	pub fn set_route(&self, index: u64, route: &str) {
		if let Some(stage) = self
			.inner
			.lock()
			.stages
			.iter_mut()
			.find(|stage| stage.index == index)
		{
			route.clone_into(&mut stage.route);
		}
	}

	/// Mark every running stage unknown (the run was cancelled).
	pub fn interrupt(&self) {
		let mut inner = self.inner.lock();
		for stage in inner
			.stages
			.iter_mut()
			.filter(|stage| stage.state == "running")
		{
			stage.state = "unknown";
		}
	}

	/// The records, one JSON object per stage.
	pub fn records(&self) -> Vec<String> {
		let mut inner = self.inner.lock();
		for stage in &mut inner.stages {
			stage.stdout.complete = true;
			stage.stderr.complete = true;
		}
		inner
			.stages
			.iter()
			.filter_map(|stage| serde_json::to_string(stage).ok())
			.collect()
	}
}

impl EventSink for StageTrace {
	fn mask(&self) -> EventMask {
		EventMask::of(EventKind::CmdStart)
			.with(EventKind::CmdExpanded)
			.with(EventKind::CmdEnd)
			.with(EventKind::UnitCompiled)
	}

	fn event(&self, ev: &Event<'_>) {
		match &ev.data {
			EventData::UnitCompiled(unit) => {
				let source = unit.source();
				if source.len() <= UNIT_LIMIT {
					self.inner.lock().units.insert(unit.id(), source.to_vec());
				}
			},
			EventData::CmdStart { .. } => {
				let Some(tag) = ev.command_tag() else {
					return;
				};
				let mut inner = self.inner.lock();
				if inner.stages.len() >= STAGE_LIMIT {
					if let Some(stage) = inner.stages.last_mut() {
						stage.omitted_after += 1;
					}
					return;
				}
				let span = ev.span();
				let (command, source_span) = match span {
					Some(span) => {
						let text = inner.units.get(&span.unit).map_or_default(|source| {
							let lo = (span.lo as usize).min(source.len());
							let hi = (span.hi as usize).min(source.len()).max(lo);
							source[lo..hi].to_vec()
						});
						(
							String::from_utf8_lossy(&text).into_owned(),
							Some([u64::from(span.lo), u64::from(span.hi)]),
						)
					},
					None => (String::new(), None),
				};
				let command_truncated = command.len() > COMMAND_LIMIT;
				let command = if command_truncated {
					String::from_utf8_lossy(
						&command.as_bytes()[..command.floor_char_boundary(COMMAND_LIMIT)],
					)
					.into_owned()
				} else {
					command
				};
				inner.stages.push(Stage {
					index: tag.seq,
					parent: None,
					command,
					command_truncated,
					route: "shell".into(),
					omitted_after: 0,
					source_span,
					state: "running",
					exit_code: None,
					signal: None,
					elapsed_ms: None,
					stdout: Capture::default(),
					stderr: Capture::default(),
				});
			},
			EventData::CmdExpanded { argv, resolved, .. } => {
				let Some(tag) = ev.command_tag() else {
					return;
				};
				let mut inner = self.inner.lock();
				let Some(stage) = inner.stages.iter_mut().find(|stage| stage.index == tag.seq) else {
					return;
				};
				if stage.command.is_empty() {
					stage.command = argv
						.iter()
						.map(|arg| arg.to_str_lossy())
						.collect::<Vec<_>>()
						.join(" ");
					stage.command_truncated = stage.command.len() > COMMAND_LIMIT;
					if stage.command_truncated {
						stage
							.command
							.truncate(stage.command.floor_char_boundary(COMMAND_LIMIT));
					}
				}
				stage.route = if argv
					.first()
					.is_some_and(|arg| arg.as_slice() == b"protolens")
				{
					"protolens"
				} else {
					match resolved {
						ResolvedKind::External => "external",
						ResolvedKind::Function => "function",
						// The JavaScript kernel builtins report the runtime
						// they stand in for, as pi's kernel cell did.
						ResolvedKind::Tool => kernel_route_name(argv.first()).unwrap_or("tool"),
						_ => "shell",
					}
				}
				.into();
			},
			EventData::CmdEnd { status, dur_ns, signal, .. } => {
				let Some(tag) = ev.command_tag() else {
					return;
				};
				let mut inner = self.inner.lock();
				let Some(stage) = inner.stages.iter_mut().find(|stage| stage.index == tag.seq) else {
					return;
				};
				stage.exit_code = Some(*status);
				stage.signal = *signal;
				stage.state = "exited";
				stage.elapsed_ms = Some(*dur_ns / 1_000_000);
			},
			_ => {},
		}
	}

	fn output_end(&self, _t_ns: u64, _fd: i32) {
		let mut inner = self.inner.lock();
		for stage in &mut inner.stages {
			stage.stdout.complete = true;
			stage.stderr.complete = true;
		}
	}

	fn wants_output(&self) -> bool {
		// A stage's own output is the bytes its command wrote to the run's
		// visible streams, an external's included. The host gives each
		// stream its own relay, so the writer's descriptor reaches
		// `output_tagged` even when the run merges stdout and stderr; the
		// command's spawn, process group and cancellation are unchanged.
		true
	}

	/// A stage card splits stdout and stderr, so an external's streams get
	/// separate relays even when the run's capture merges them.
	fn split_output(&self) -> bool {
		true
	}

	/// Pipeline pipes never reach the run's visible capture; their bytes are
	/// the writing stage's output.
	fn pipe_output(&self, tag: Option<CmdTag>, merged: bool, bytes: &[u8]) {
		self.output_tagged(tag, 0, 1, merged, bytes);
	}

	fn wants_pipe_output(&self) -> bool {
		true
	}

	fn output_tagged(&self, tag: Option<CmdTag>, t_ns: u64, fd: i32, _merged: bool, bytes: &[u8]) {
		self.output(tag, t_ns, fd, bytes);
	}

	fn output(&self, tag: Option<CmdTag>, _t_ns: u64, fd: i32, bytes: &[u8]) {
		let Some(tag) = tag else {
			return;
		};
		let mut inner = self.inner.lock();
		let Some(stage) = inner.stages.iter_mut().find(|stage| stage.index == tag.seq) else {
			return;
		};
		let capture = if fd == 2 {
			&mut stage.stderr
		} else {
			&mut stage.stdout
		};
		capture.bytes = capture.bytes.saturating_add(bytes.len());
		let remaining = STREAM_LIMIT.saturating_sub(capture.data.len());
		let take = bytes.len().min(remaining);
		capture.data.extend_from_slice(&bytes[..take]);
		if take < bytes.len() {
			// The preview ends on a character boundary; the byte count still
			// reports everything the command wrote.
			let end = complete_utf8_prefix(&capture.data);
			capture.data.truncate(end);
		}
		capture.truncated = capture.bytes > STREAM_LIMIT;
	}
}

/// Length of the longest prefix of `bytes` that does not end inside a UTF-8
/// character: the length itself when the last character is complete.
fn complete_utf8_prefix(bytes: &[u8]) -> usize {
	let mut lead = bytes.len();
	// A UTF-8 character has at most four bytes, so its lead is at most three
	// bytes back from the end.
	for _ in 0..4 {
		let Some(&byte) = lead.checked_sub(1).and_then(|at| bytes.get(at)) else {
			return 0;
		};
		if byte & 0xc0 != 0x80 {
			let width = match byte {
				0x00..=0x7f => 1,
				0xc0..=0xdf => 2,
				0xe0..=0xef => 3,
				0xf0..=0xf7 => 4,
				// An invalid byte: leave it to the lossy rendering.
				_ => 1,
			};
			return if lead - 1 + width <= bytes.len() {
				bytes.len()
			} else {
				lead - 1
			};
		}
		lead -= 1;
	}
	// Four continuation bytes without a lead: not a cut character.
	bytes.len()
}

/// The runtime a JavaScript kernel builtin is routed as, from its command
/// word; `None` for any other tool.
fn kernel_route_name(arg: Option<&bstr::BString>) -> Option<&'static str> {
	let name = arg?.to_str().ok()?;
	let base = name.rsplit('/').next().unwrap_or(name);
	match base {
		"node" | "nodejs" => Some("node"),
		"bun" => Some("bun"),
		_ => None,
	}
}

/// Forward every event and output to each sink (a run trace and the stage
/// recorder).
pub(crate) struct TeeSink {
	sinks: Vec<std::sync::Arc<dyn EventSink>>,
	mask:  EventMask,
}

impl TeeSink {
	pub(crate) fn new(sinks: Vec<std::sync::Arc<dyn EventSink>>) -> Self {
		let mask = sinks.iter().fold(EventMask::NONE, |mask, sink| {
			EventMask::from_bits(mask.bits() | sink.mask().bits())
		});
		Self { sinks, mask }
	}
}

impl EventSink for TeeSink {
	fn mask(&self) -> EventMask {
		self.mask
	}

	fn event(&self, ev: &Event<'_>) {
		for sink in &self.sinks {
			sink.event(ev);
		}
	}

	fn wants_output(&self) -> bool {
		self.sinks.iter().any(|sink| sink.wants_output())
	}

	fn split_output(&self) -> bool {
		self.sinks.iter().any(|sink| sink.split_output())
	}

	fn pipe_output(&self, tag: Option<CmdTag>, merged: bool, bytes: &[u8]) {
		for sink in &self.sinks {
			sink.pipe_output(tag, merged, bytes);
		}
	}

	fn wants_pipe_output(&self) -> bool {
		self.sinks.iter().any(|sink| sink.wants_pipe_output())
	}

	fn run_submitted(&self, run: crate::bash::RunId) {
		for sink in &self.sinks {
			sink.run_submitted(run);
		}
	}

	fn output_end(&self, t_ns: u64, fd: i32) {
		for sink in &self.sinks {
			sink.output_end(t_ns, fd);
		}
	}

	fn output(&self, tag: Option<CmdTag>, t_ns: u64, fd: i32, bytes: &[u8]) {
		for sink in &self.sinks {
			sink.output(tag, t_ns, fd, bytes);
		}
	}

	fn output_tagged(&self, tag: Option<CmdTag>, t_ns: u64, fd: i32, merged: bool, bytes: &[u8]) {
		for sink in &self.sinks {
			sink.output_tagged(tag, t_ns, fd, merged, bytes);
		}
	}
}

#[cfg(test)]
mod tests {
	use super::complete_utf8_prefix;

	/// A preview cut inside a character must end before it, so a consumer
	/// never renders a replacement glyph for bytes the capture did not keep.
	#[test]
	fn a_truncated_preview_ends_on_a_character_boundary() {
		assert_eq!(complete_utf8_prefix("a😀".as_bytes()), 5);
		// Cut after the emoji's lead and first continuation byte.
		assert_eq!(complete_utf8_prefix(b"a\xF0\x9F"), 1);
		// Cut after a complete three-byte character.
		assert_eq!(complete_utf8_prefix("a€".as_bytes()), 4);
		assert_eq!(complete_utf8_prefix(b"a\xE2\x82"), 1);
		// Invalid bytes are not a cut character: the lossy rendering keeps
		// them.
		assert_eq!(complete_utf8_prefix(b"a\xFF"), 2);
	}
}
