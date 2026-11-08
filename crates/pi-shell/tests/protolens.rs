//! `protolens` on the in-house engine: the callout contract, the
//! `protolens://` provider, stage indices and the result surface.

#![cfg(unix)]

use std::sync::{Arc, Mutex};

use anyhow::anyhow;
use pi_shell::{
	ProtolensDispatchFuture, ProtolensDispatchRequest, ProtolensDispatchResponse,
	ProtolensDispatcher, Shell, ShellRunOptions, cancel::CancelToken,
};
use serde_json::Value;

/// A dispatcher that records every request and answers with `answer`.
struct Fake {
	requests: Mutex<Vec<ProtolensDispatchRequest>>,
	answer: Mutex<
		Box<
			dyn Fn(&ProtolensDispatchRequest) -> anyhow::Result<ProtolensDispatchResponse>
				+ Send
				+ Sync,
		>,
	>,
}

impl Fake {
	fn new(
		answer: impl Fn(&ProtolensDispatchRequest) -> anyhow::Result<ProtolensDispatchResponse>
		+ Send
		+ Sync
		+ 'static,
	) -> Arc<Self> {
		Arc::new(Self { requests: Mutex::new(Vec::new()), answer: Mutex::new(Box::new(answer)) })
	}

	fn requests(&self) -> Vec<ProtolensDispatchRequest> {
		self.requests.lock().unwrap().clone()
	}
}

impl ProtolensDispatcher for Fake {
	fn dispatch(&self, request: ProtolensDispatchRequest) -> ProtolensDispatchFuture {
		let answer = self.answer.lock().unwrap();
		let response = answer(&request);
		self.requests.lock().unwrap().push(request);
		Box::pin(async move { response })
	}
}

fn run_options(command: &str) -> ShellRunOptions {
	ShellRunOptions { command: command.to_owned(), ..Default::default() }
}

fn stages(result: &pi_shell::ShellRunResult) -> Vec<Value> {
	result
		.stage_records
		.iter()
		.map(|record| serde_json::from_str(record).expect("stage record JSON"))
		.collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn round_trip_reports_streams_status_record_and_stage_index() {
	let fake = Fake::new(|_| {
		Ok(ProtolensDispatchResponse {
			stdout:    "out\n".into(),
			stderr:    "err\n".into(),
			exit_code: 0,
			record:    Some("{\"kind\":\"probe\"}".into()),
		})
	});
	let shell = Shell::new(None);
	let (tx, rx) = flume::unbounded();
	let result = shell
		.run(
			run_options("echo before; protolens probe --x"),
			Some(tx),
			Some(fake.clone()),
			Some("call-1".into()),
			CancelToken::default(),
		)
		.await
		.expect("shell run");
	assert_eq!(result.exit_code, Some(0));
	assert_eq!(rx.drain().collect::<String>(), "before\nout\nerr\n");
	assert_eq!(result.protolens_dispatches, ["{\"kind\":\"probe\"}"]);

	let request = &fake.requests()[0];
	assert_eq!(request.name.as_deref(), Some("probe"));
	assert_eq!(request.args, ["--x"]);
	assert_eq!(request.call_id.as_deref(), Some("call-1"));
	assert!(!request.stdin_truncated);
	let stage_index = request
		.stage_index
		.expect("protolens carries its stage tag");
	let stage = stages(&result)
		.into_iter()
		.find(|stage| stage["index"] == stage_index as u64)
		.expect("stage record for the dispatch");
	assert_eq!(stage["route"], "protolens");
	assert_eq!(stage["stdout"]["text"], "out\n");
	assert_eq!(stage["stderr"]["text"], "err\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn stdin_is_capped_at_one_mebibyte() {
	let fake = Fake::new(|_| Ok(ProtolensDispatchResponse { exit_code: 0, ..Default::default() }));
	let shell = Shell::new(None);
	let result = shell
		.run(
			run_options("/usr/bin/yes a | /usr/bin/head -c 1048600 | protolens probe"),
			None,
			Some(fake.clone()),
			None,
			CancelToken::default(),
		)
		.await
		.expect("shell run");
	assert_eq!(result.exit_code, Some(0));
	let request = &fake.requests()[0];
	assert_eq!(request.stdin.len(), 1024 * 1024);
	assert!(request.stdin_truncated);
}

#[tokio::test(flavor = "multi_thread")]
async fn exit_mapping_covers_out_of_range_failure_and_no_dispatcher() {
	let out_of_range =
		Fake::new(|_| Ok(ProtolensDispatchResponse { exit_code: 300, ..Default::default() }));
	let failed = Fake::new(|_| Err(anyhow!("bridge exploded")));
	let shell = Shell::new(None);
	for (dispatcher, expected) in [
		(Some(out_of_range as Arc<dyn ProtolensDispatcher>), 125),
		(Some(failed as Arc<dyn ProtolensDispatcher>), 125),
		(None, 127),
	] {
		let result = shell
			.run(run_options("protolens probe"), None, dispatcher, None, CancelToken::default())
			.await
			.expect("shell run");
		assert_eq!(result.exit_code, Some(expected));
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn a_closed_output_pipe_reports_141() {
	let fake = Fake::new(|_| {
		Ok(ProtolensDispatchResponse {
			stdout: "x".repeat(1024 * 1024),
			exit_code: 0,
			..Default::default()
		})
	});
	let shell = Shell::new(None);
	let result = shell
		.run(
			run_options("set -o pipefail; protolens probe | /usr/bin/true"),
			None,
			Some(fake),
			None,
			CancelToken::default(),
		)
		.await
		.expect("shell run");
	assert_eq!(result.exit_code, Some(141));
}

#[tokio::test(flavor = "multi_thread")]
async fn cancellation_stops_an_in_flight_dispatch() {
	struct Hanging;
	impl ProtolensDispatcher for Hanging {
		fn dispatch(&self, _request: ProtolensDispatchRequest) -> ProtolensDispatchFuture {
			Box::pin(async {
				std::future::pending::<anyhow::Result<ProtolensDispatchResponse>>().await
			})
		}
	}
	let shell = Shell::new(None);
	let mut cancel = CancelToken::default();
	let abort = cancel.emplace_abort_token();
	let task = tokio::spawn(async move {
		shell
			.run(
				run_options("protolens probe"),
				None,
				Some(Arc::new(Hanging) as Arc<dyn ProtolensDispatcher>),
				None,
				cancel,
			)
			.await
	});
	tokio::time::sleep(std::time::Duration::from_millis(100)).await;
	abort.abort(pi_shell::cancel::AbortReason::Signal);
	let result = tokio::time::timeout(std::time::Duration::from_secs(5), task)
		.await
		.expect("cancellation returns")
		.expect("run task")
		.expect("shell result");
	assert!(result.cancelled);
	assert_eq!(result.exit_code, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn cat_and_ls_read_protolens_urls_through_the_provider() {
	let fake = Fake::new(|request| {
		if request.name.is_none() {
			return Ok(ProtolensDispatchResponse {
				stdout: "probe - returns a value\n".into(),
				exit_code: 0,
				record: Some(
					"{\"xdev\":{\"tool\":\"\",\"mode\":\"listing\",\"devices\":[{\"name\":\"probe\",\"\
					 summary\":\"returns a value\"}]}}"
						.into(),
				),
				..Default::default()
			});
		}
		Ok(ProtolensDispatchResponse {
			stdout: "device output\n".into(),
			exit_code: 0,
			..Default::default()
		})
	});
	let shell = Shell::new(None);
	let (tx, rx) = flume::unbounded();
	let result = shell
		.run(
			run_options("cat protolens://probe; ls protolens://"),
			Some(tx),
			Some(fake),
			None,
			CancelToken::default(),
		)
		.await
		.expect("shell run");
	assert_eq!(result.exit_code, Some(0));
	let output = rx.drain().collect::<String>();
	assert_eq!(output, "device output\nprobe\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn external_commands_receive_the_literal_protolens_url() {
	let fake = Fake::new(|_| {
		Ok(ProtolensDispatchResponse { stdout: "unused".into(), exit_code: 0, ..Default::default() })
	});
	let shell = Shell::new(None);
	let (tx, rx) = flume::unbounded();
	let result = shell
		.run(
			run_options("/bin/sh -c 'printf \"%s\\n\" \"$0\"' protolens://probe"),
			Some(tx),
			Some(fake.clone()),
			None,
			CancelToken::default(),
		)
		.await
		.expect("shell run");
	assert_eq!(result.exit_code, Some(0));
	assert_eq!(rx.drain().collect::<String>(), "protolens://probe\n");
	assert!(fake.requests().is_empty(), "an external never dispatches the device");
}
