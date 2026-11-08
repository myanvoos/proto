//! The engine result surface: stage records, file observations and
//! `force_close`.

#![cfg(unix)]

use std::{fs, path::Path};

use pi_shell::{FsObservationKind, Shell, ShellRunOptions, cancel::CancelToken};
use serde_json::Value;

fn options(command: &str, cwd: Option<&Path>) -> ShellRunOptions {
	ShellRunOptions {
		command: command.to_owned(),
		cwd: cwd.map(|cwd| cwd.to_string_lossy().into_owned()),
		..Default::default()
	}
}

async fn run(shell: &Shell, command: &str, cwd: Option<&Path>) -> pi_shell::ShellRunResult {
	shell
		.run(options(command, cwd), None, None, None, CancelToken::default())
		.await
		.expect("shell run")
}

fn stages(result: &pi_shell::ShellRunResult) -> Vec<Value> {
	result
		.stage_records
		.iter()
		.map(|record| serde_json::from_str(record).expect("stage record JSON"))
		.collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn stage_records_carry_command_output_and_status() {
	let shell = Shell::new(None);
	let (tx, rx) = flume::unbounded();
	let result = shell
		.run(
			options("printf 'one\\n'; printf 'two\\n'", None),
			Some(tx),
			None,
			None,
			CancelToken::default(),
		)
		.await
		.expect("shell run");
	assert_eq!(result.exit_code, Some(0));
	assert_eq!(rx.drain().collect::<String>(), "one\ntwo\n");
	let stages = stages(&result);
	let one = stages
		.iter()
		.find(|stage| stage["command"].as_str().is_some_and(|c| c.contains("one")))
		.expect("first stage");
	assert_eq!(one["state"], "exited");
	assert_eq!(one["exitCode"], 0);
	assert_eq!(one["stdout"]["text"], "one\n");
	let two = stages
		.iter()
		.find(|stage| stage["command"].as_str().is_some_and(|c| c.contains("two")))
		.expect("second stage");
	assert_eq!(two["stdout"]["text"], "two\n");
	assert!(one["index"].as_u64() != two["index"].as_u64());
}

#[tokio::test(flavor = "multi_thread")]
async fn fs_observations_record_writes_reads_and_refuse_a_stale_write() {
	let dir = tempfile::tempdir().expect("temp dir");
	let shell = Shell::new(None);
	let write = run(&shell, "printf 'out\\n' > written.txt", Some(dir.path())).await;
	assert_eq!(write.exit_code, Some(0));
	let observation = write
		.fs_observations
		.iter()
		.find(|observation| observation.path.ends_with("written.txt"))
		.expect("write observation");
	assert_eq!(observation.kind, FsObservationKind::Write);
	let mutation = observation.mutation.as_ref().expect("write snapshot");
	assert!(!mutation.existed);
	assert!(mutation.exists);
	assert_eq!(mutation.after.as_deref(), Some("out\n"));

	let read = run(&shell, "read line < written.txt", Some(dir.path())).await;
	assert_eq!(read.exit_code, Some(0));
	let observation = read
		.fs_observations
		.iter()
		.find(|observation| observation.path.ends_with("written.txt"))
		.expect("read observation");
	assert_eq!(observation.kind, FsObservationKind::Read);
	assert!(observation.mtime_ns.is_some());
	assert!(observation.size.is_some());

	fs::write(dir.path().join("written.txt"), b"changed elsewhere\n").expect("external edit");
	let stale = run(&shell, "printf 'mine\\n' > written.txt", Some(dir.path())).await;
	assert_ne!(stale.exit_code, Some(0));
	assert_eq!(
		fs::read_to_string(dir.path().join("written.txt")).expect("untouched file"),
		"changed elsewhere\n"
	);
}

#[tokio::test(flavor = "multi_thread")]
async fn force_close_releases_the_session() {
	let shell = Shell::new(None);
	assert_eq!(run(&shell, "kept=value", None).await.exit_code, Some(0));
	assert!(shell.force_close());
	let (tx, rx) = flume::unbounded();
	let result = shell
		.run(
			options("printf '%s' \"${kept:-none}\"", None),
			Some(tx),
			None,
			None,
			CancelToken::default(),
		)
		.await
		.expect("fresh session");
	assert_eq!(result.exit_code, Some(0));
	assert_eq!(rx.drain().collect::<String>(), "none");
	// Nothing left to close.
	assert!(shell.force_close());
}
