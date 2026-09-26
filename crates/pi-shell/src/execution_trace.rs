//! Bounded, out-of-band records of commands actually executed by Brush.
use std::{
	io::{Read, Write},
	sync::Arc,
	time::Instant,
};

use brush_core::{CommandObserver, SourceSpan, openfiles::OpenFile};
use parking_lot::Mutex;

const STAGE_LIMIT: usize = 128;
const STREAM_LIMIT: usize = 16 * 1024;

#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Capture {
	#[serde(rename = "text", serialize_with = "serialize_text")]
	data:      Vec<u8>,
	bytes:     usize,
	truncated: bool,
	complete:  bool,
}
fn serialize_text<S: serde::Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
	serializer.serialize_str(&String::from_utf8_lossy(bytes))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Stage {
	index:             usize,
	#[serde(skip_serializing_if = "Option::is_none")]
	parent:            Option<usize>,
	command:           String,
	command_truncated: bool,
	route:             String,
	omitted_after:     usize,
	#[serde(skip_serializing_if = "Option::is_none")]
	source_span:       Option<[usize; 2]>,
	state:             &'static str,
	#[serde(skip_serializing_if = "Option::is_none")]
	exit_code:         Option<i32>,
	#[serde(skip_serializing_if = "Option::is_none")]
	signal:            Option<i32>,
	#[serde(skip_serializing_if = "Option::is_none")]
	elapsed_ms:        Option<u64>,
	stdout:            Capture,
	stderr:            Capture,
	#[serde(skip)]
	started:           Instant,
	#[serde(skip)]
	drains:            Vec<tokio::sync::oneshot::Receiver<()>>,
}

#[derive(Clone)]
pub(crate) struct CommandTrace(Arc<Mutex<Vec<Stage>>>, bool);
impl Default for CommandTrace {
	fn default() -> Self {
		Self(Arc::default(), true)
	}
}

impl CommandTrace {
	pub fn omit_source_spans(&mut self) {
		self.1 = false;
	}

	pub fn interrupt(&self) {
		for stage in self
			.0
			.lock()
			.iter_mut()
			.filter(|stage| stage.state == "running")
		{
			stage.state = "unknown";
		}
	}

	pub fn records(&self) -> Vec<String> {
		self
			.0
			.lock()
			.iter()
			.filter_map(|stage| serde_json::to_string(stage).ok())
			.collect()
	}
}

impl CommandObserver for CommandTrace {
	fn start(
		&self,
		mut command: String,
		span: Option<SourceSpan>,
		parent: Option<usize>,
	) -> Option<usize> {
		let mut stages = self.0.lock();
		if stages.len() >= STAGE_LIMIT {
			if let Some(stage) = stages.last_mut() {
				stage.omitted_after += 1;
			}
			return None;
		}
		let command_truncated = command.len() > STREAM_LIMIT;
		if command_truncated {
			command.truncate(command.floor_char_boundary(STREAM_LIMIT));
		}
		let index = stages.len();
		stages.push(Stage {
			index,
			parent,
			command,
			command_truncated,
			route: "shell".into(),
			omitted_after: 0,
			source_span: span
				.filter(|_| self.1 && parent.is_none())
				.map(|span| [span.start.index, span.end.index]),
			state: "running",
			exit_code: None,
			signal: None,
			elapsed_ms: None,
			stdout: Capture::default(),
			stderr: Capture::default(),
			started: Instant::now(),
			drains: Vec::new(),
		});
		Some(index)
	}

	fn route(&self, id: usize, route: &str) {
		if let Some(stage) = self.0.lock().get_mut(id) {
			stage.route = route.into();
		}
	}

	fn finish(
		&self,
		id: usize,
		exit_code: Option<i32>,
		signal: Option<i32>,
	) -> std::pin::Pin<Box<dyn Future<Output = ()> + Send>> {
		let drains = if let Some(stage) = self.0.lock().get_mut(id) {
			stage.exit_code = exit_code;
			stage.signal = signal;
			stage.state = if exit_code.is_some() {
				"exited"
			} else {
				"unknown"
			};
			stage.elapsed_ms = Some(
				stage
					.started
					.elapsed()
					.as_millis()
					.min(u128::from(u64::MAX)) as u64,
			);
			std::mem::take(&mut stage.drains)
		} else {
			Vec::new()
		};
		Box::pin(async move {
			// Inherited background descriptors need not close with their parent.
			// Preserve sequential output ordering, but report incomplete captures rather
			// than waiting forever for a daemon holding a descriptor open.
			let _ = tokio::time::timeout(std::time::Duration::from_millis(250), async move {
				for drain in drains {
					let _ = drain.await;
				}
			})
			.await;
		})
	}

	fn capture(&self, id: usize, fd: u32, mut output: OpenFile) -> OpenFile {
		let Ok((mut reader, writer)) = std::io::pipe() else {
			return output;
		};
		let trace = self.clone();
		let (finished, drain) = tokio::sync::oneshot::channel();
		if let Some(stage) = self.0.lock().get_mut(id) {
			stage.drains.push(drain);
		}
		// Forward every byte, but retain only bounded diagnostic previews. Broken
		// downstream pipes close this reader too, preserving backpressure and SIGPIPE
		// propagation.
		std::thread::spawn(move || {
			let mut buffer = [0u8; 8192];
			loop {
				let count = match reader.read(&mut buffer) {
					Ok(0) => {
						if let Some(stage) = trace.0.lock().get_mut(id) {
							let capture = if fd == 1 {
								&mut stage.stdout
							} else {
								&mut stage.stderr
							};
							capture.complete = true;
						}
						break;
					},
					Err(_) => break,
					Ok(count) => count,
				};
				{
					let mut stages = trace.0.lock();
					if let Some(stage) = stages.get_mut(id) {
						let capture = if fd == 1 {
							&mut stage.stdout
						} else {
							&mut stage.stderr
						};
						capture.bytes = capture.bytes.saturating_add(count);
						let remaining = STREAM_LIMIT.saturating_sub(capture.data.len());
						capture
							.data
							.extend_from_slice(&buffer[..count.min(remaining)]);
						capture.truncated = capture.bytes > STREAM_LIMIT;
					}
				}
				if output.write_all(&buffer[..count]).is_err() {
					break;
				}
			}
			let _ = output.flush();
			let _ = finished.send(());
		});
		writer.into()
	}
}
