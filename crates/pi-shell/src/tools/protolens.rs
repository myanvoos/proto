//! `protolens`: dispatch a mounted agent tool through the session's
//! [`ProtolensDispatcher`](crate::protolens::ProtolensDispatcher).
//!
//! The callout reads at most 1 MiB of stdin, hands the request to the
//! dispatcher (on the session runtime, observing the run's cancellation),
//! writes the response's stdout/stderr to the caller's fds and exits with the
//! response's status. Exit mapping: 0–255 verbatim; out-of-range or dispatcher
//! failure 125; no dispatcher 127; cancelled 130; a closed output pipe 141.

use std::collections::VecDeque;

use bstr::{BString, ByteSlice};

use super::{Child, Turn};
use crate::{
	bash::{CallOutcome, IoPoll, ShellApi, ToolCall},
	protolens::{ProtolensBridge, ProtolensDispatchRequest, ProtolensDispatchResponse},
};

/// Most stdin bytes a dispatch reads; the rest is left in the pipe.
const STDIN_LIMIT: usize = 1024 * 1024;
/// Exit status of a dispatcher that failed or answered out of range.
const BRIDGE_FAILURE_EXIT: i32 = 125;
/// Exit status when no dispatcher is attached.
const NO_DISPATCHER_EXIT: i32 = 127;
/// Exit status of a cancelled dispatch.
const INTERRUPTED_EXIT: i32 = 130;
/// Exit status of a dispatch whose output pipe closed.
const BROKEN_PIPE_EXIT: i32 = 141;

/// One dispatch's result from the runtime task.
enum Dispatched {
	Response(ProtolensDispatchResponse),
	Failed(String),
	Cancelled,
}

/// Where a `protolens` call is.
enum Stage {
	/// Reading stdin.
	Reading,
	/// The dispatcher runs on the runtime.
	Dispatching(flume::Receiver<Dispatched>),
	/// Writing the response's streams and then exiting.
	Responding {
		code: i32,
	},
	Done(i32),
}

/// A `protolens` call.
pub(super) struct Protolens {
	pub(super) child: Child,
	call:             ToolCall,
	stage:            Stage,
	stdin:            Vec<u8>,
	stdin_truncated:  bool,
	out:              ResponseOut,
}

impl Protolens {
	pub(super) fn new(call: ToolCall) -> Self {
		Self {
			child: Child::default(),
			call,
			stage: Stage::Reading,
			stdin: Vec::new(),
			stdin_truncated: false,
			out: ResponseOut::default(),
		}
	}

	pub(super) fn advance(
		&mut self,
		api: &mut ShellApi<'_, '_>,
		turn: &Turn<'_>,
	) -> Option<CallOutcome> {
		loop {
			match std::mem::replace(&mut self.stage, Stage::Done(1)) {
				Stage::Reading => {
					if self.stdin.len() > STDIN_LIMIT {
						self.stdin_truncated = true;
						self.stdin.truncate(STDIN_LIMIT);
						self.start_dispatch(api, turn);
						continue;
					}
					let mut buf = [0u8; 8192];
					match api.read(0, &mut buf) {
						IoPoll::Ready(Ok(0)) => self.start_dispatch(api, turn),
						IoPoll::Ready(Ok(n)) => {
							self.stdin.extend_from_slice(&buf[..n]);
							self.stage = Stage::Reading;
						},
						IoPoll::Ready(Err(error)) => {
							self.out.push(
								2,
								format!("protolens: failed to read stdin: {error}\n").into_bytes(),
							);
							self.stage = Stage::Responding { code: BRIDGE_FAILURE_EXIT };
						},
						IoPoll::WouldBlock(_) => {
							self.stage = Stage::Reading;
							return None;
						},
					}
				},
				Stage::Dispatching(rx) => match rx.try_recv() {
					Ok(dispatched) => {
						self.finish_dispatch(dispatched, turn);
					},
					Err(flume::TryRecvError::Empty) => {
						self.stage = Stage::Dispatching(rx);
						return None;
					},
					Err(flume::TryRecvError::Disconnected) => {
						self.finish_dispatch(
							Dispatched::Failed("dispatch task ended without a result".to_owned()),
							turn,
						);
					},
				},
				Stage::Responding { code } => match self.out.flush(api) {
					Flush::Done => {
						self.stage = Stage::Done(code);
						return Some(CallOutcome::Exit(code));
					},
					Flush::Blocked => {
						self.stage = Stage::Responding { code };
						return None;
					},
					Flush::Broken => {
						self.stage = Stage::Done(BROKEN_PIPE_EXIT);
						return Some(CallOutcome::Exit(BROKEN_PIPE_EXIT));
					},
				},
				Stage::Done(code) => {
					self.stage = Stage::Done(code);
					return Some(CallOutcome::Exit(code));
				},
			}
		}
	}

	/// Parse the arguments and hand the request to the dispatcher.
	fn start_dispatch(&mut self, api: &ShellApi<'_, '_>, turn: &Turn<'_>) {
		if self.stdin_truncated {
			self.stdin.truncate(STDIN_LIMIT);
		}
		let mut plain: Vec<BString> = self.call.argv.clone();
		if plain
			.first()
			.is_some_and(|arg| arg.as_slice() == b"protolens")
		{
			plain.remove(0);
		}
		let (name, args) = match plain.as_slice() {
			[] => (None, Vec::new()),
			[arg] if is_help_arg(&arg.to_str_lossy()) => (None, Vec::new()),
			[name, rest @ ..] => (
				Some(name.to_str_lossy().into_owned()),
				rest
					.iter()
					.map(|arg| arg.to_str_lossy().into_owned())
					.collect(),
			),
		};
		let bridge = turn.config.protolens.clone();
		let dispatcher = bridge.as_ref().and_then(ProtolensBridge::dispatcher);
		let Some(dispatcher) = dispatcher else {
			self
				.out
				.push(2, b"protolens: no agent dispatcher is attached\n".to_vec());
			self.stage = Stage::Responding { code: NO_DISPATCHER_EXIT };
			return;
		};
		let request = ProtolensDispatchRequest {
			name,
			args,
			stdin: String::from_utf8_lossy(&self.stdin).into_owned(),
			stdin_truncated: self.stdin_truncated,
			stage_index: usize::try_from(self.call.tag.seq).ok(),
			cwd: api.cwd().to_str_lossy().into_owned(),
			call_id: bridge.as_ref().and_then(ProtolensBridge::call_id),
		};
		let (tx, rx) = flume::bounded(1);
		let waker = turn.waker.clone();
		let cancel = turn.config.cancel.get();
		let Some(runtime) = turn.config.runtime.clone() else {
			self
				.out
				.push(2, b"protolens: no runtime for the dispatcher\n".to_vec());
			self.stage = Stage::Responding { code: BRIDGE_FAILURE_EXIT };
			return;
		};
		runtime.spawn(async move {
			let dispatched = dispatch(dispatcher, request, cancel).await;
			let _ = tx.send(dispatched);
			waker.wake();
		});
		self.stage = Stage::Dispatching(rx);
	}

	/// Turn a dispatcher result into output and a status.
	fn finish_dispatch(&mut self, dispatched: Dispatched, turn: &Turn<'_>) {
		match dispatched {
			Dispatched::Response(response) => {
				if let (Some(record), Some(bridge)) = (&response.record, &turn.config.protolens) {
					bridge.push_record(record.clone());
				}
				if !response.stdout.is_empty() {
					self.out.push(1, response.stdout.into_bytes());
				}
				if !response.stderr.is_empty() {
					self.out.push(2, response.stderr.into_bytes());
				}
				let code = if (0..=255).contains(&response.exit_code) {
					response.exit_code
				} else {
					BRIDGE_FAILURE_EXIT
				};
				self.stage = Stage::Responding { code };
			},
			Dispatched::Failed(message) => {
				self
					.out
					.push(2, format!("protolens: dispatcher failed: {message}\n").into_bytes());
				self.stage = Stage::Responding { code: BRIDGE_FAILURE_EXIT };
			},
			Dispatched::Cancelled => {
				self.stage = Stage::Done(INTERRUPTED_EXIT);
			},
		}
	}
}

/// Await one dispatch, stopping at the run's cancellation.
async fn dispatch(
	dispatcher: std::sync::Arc<dyn crate::protolens::ProtolensDispatcher>,
	request: ProtolensDispatchRequest,
	cancel: Option<tokio_util::sync::CancellationToken>,
) -> Dispatched {
	let future = dispatcher.dispatch(request);
	let result = match cancel {
		Some(cancel) => {
			tokio::select! {
				biased;
				() = cancel.cancelled() => return Dispatched::Cancelled,
				result = future => result,
			}
		},
		None => future.await,
	};
	match result {
		Ok(response) => Dispatched::Response(response),
		Err(error) => Dispatched::Failed(error.to_string()),
	}
}

/// Bare `protolens ?` / `help` / `--help` / `-h` prints the device listing.
fn is_help_arg(arg: &str) -> bool {
	matches!(arg, "?" | "-h" | "--help") || arg.eq_ignore_ascii_case("help")
}

/// Output a dispatch writes to the caller's fds.
#[derive(Default)]
struct ResponseOut(VecDeque<(i32, Vec<u8>)>);

impl ResponseOut {
	fn push(&mut self, fd: i32, bytes: Vec<u8>) {
		if !bytes.is_empty() {
			self.0.push_back((fd, bytes));
		}
	}

	fn flush(&mut self, api: &mut ShellApi<'_, '_>) -> Flush {
		while let Some((fd, bytes)) = self.0.front_mut() {
			match api.write(*fd, bytes) {
				IoPoll::Ready(Ok(n)) if n > 0 && n < bytes.len() => {
					bytes.drain(..n);
				},
				IoPoll::Ready(Ok(_)) => {
					self.0.pop_front();
				},
				IoPoll::Ready(Err(_)) => return Flush::Broken,
				IoPoll::WouldBlock(_) => return Flush::Blocked,
			}
		}
		Flush::Done
	}
}

enum Flush {
	Done,
	Blocked,
	Broken,
}
