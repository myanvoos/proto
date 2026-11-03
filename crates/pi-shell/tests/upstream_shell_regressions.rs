#![cfg(unix)]

use std::{path::Path, time::Duration};

use pi_shell::{
	Shell, ShellRunOptions, ShellRunResult,
	cancel::{AbortReason, CancelToken},
};

async fn run(
	shell: &Shell,
	cwd: &Path,
	command: &str,
	mut cancel: CancelToken,
) -> (ShellRunResult, String) {
	let (tx, rx) = flume::unbounded();
	let abort = cancel.emplace_abort_token();
	let result = {
		let future = shell.run(
			ShellRunOptions {
				command: command.into(),
				cwd: Some(cwd.to_string_lossy().into_owned()),
				..Default::default()
			},
			Some(tx),
			cancel,
		);
		tokio::pin!(future);
		let result = tokio::select! {
			result = &mut future => result.expect("shell command failed"),
			() = tokio::time::sleep(Duration::from_secs(8)) => {
				abort.abort(AbortReason::Signal);
				let _ = (&mut future).await;
				panic!("shell command did not settle: {command}; output: {:?}", rx.try_iter().collect::<String>());
			}
		};
		result
	};
	(result, rx.into_iter().collect())
}

#[tokio::test]
async fn exit_and_errexit_preserve_session_variables_functions_and_options() {
	let dir = tempfile::tempdir().unwrap();
	let shell = Shell::new(None);
	for (command, expected) in [
		("set -e; KEPT=kept; kept_fn() { printf '%s\\n' \"$KEPT\"; }", 0),
		("false; true", 1),
		("kept_fn", 0),
		("exit 3", 3),
		("kept_fn", 0),
		("false; exit 0", 1),
	] {
		let (result, output) = run(&shell, dir.path(), command, CancelToken::default()).await;
		assert_eq!(result.exit_code, Some(expected), "{command}: {output}");
		if command == "kept_fn" {
			assert_eq!(output, "kept\n");
		}
	}
}

#[tokio::test]
async fn globstar_recurses_keeps_duplicate_matches_and_rejects_missing_literal_tails() {
	let dir = tempfile::tempdir().unwrap();
	std::fs::create_dir_all(dir.path().join("b1/b2/c")).unwrap();
	for file in ["b1/x", "b1/b2/x", "b1/b2/c/x", "plain"] {
		std::fs::write(dir.path().join(file), "").unwrap();
	}
	let shell = Shell::new(None);
	let (result, output) = run(
		&shell,
		dir.path(),
		"shopt -s globstar nullglob; printf '<%s>\\n' **/b*/**/x; printf 'missing=<%s>\\n' */absent",
		CancelToken::default(),
	)
	.await;
	assert_eq!(result.exit_code, Some(0), "{output}");
	assert_eq!(output, "<b1/b2/c/x>\n<b1/b2/c/x>\n<b1/b2/x>\n<b1/b2/x>\n<b1/x>\nmissing=<>\n");
	let (_, output) = run(&shell, dir.path(), "compgen -G '**//x'", CancelToken::default()).await;
	assert_eq!(output, "b1/b2/c/x\nb1/b2/x\nb1/x\n");
}

#[tokio::test]
async fn background_fifo_redirection_returns_os_pid_and_preserves_later_redirect_order() {
	let dir = tempfile::tempdir().unwrap();
	let shell = Shell::new(None);
	let (result, output) = run(
		&shell,
		dir.path(),
		"mkfifo pipe; /bin/echo payload > pipe > final & pid=$!; /bin/kill -0 \"$pid\"; echo ready; \
		 cat < pipe; wait \"$pid\"; cat final",
		CancelToken::default(),
	)
	.await;
	assert_eq!(result.exit_code, Some(0), "{output}");
	assert_eq!(output, "ready\npayload\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn cancelled_fifo_open_releases_its_worker_before_the_next_reader() {
	let dir = tempfile::tempdir().unwrap();
	let shell = Shell::new(None);
	let (result, output) =
		run(&shell, dir.path(), "mkfifo pipe; cat < pipe", CancelToken::new(Some(100))).await;
	assert!(result.timed_out, "{output}");
	let (result, output) = run(
		&shell,
		dir.path(),
		"(printf live > pipe) & read -r value < pipe; printf '%s\\n' \"$value\"; wait",
		CancelToken::default(),
	)
	.await;
	assert_eq!(result.exit_code, Some(0), "{output}");
	assert_eq!(output, "live\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_keeps_output_open_until_term_cleanup_finishes() {
	let dir = tempfile::tempdir().unwrap();
	std::fs::write(
		dir.path().join("cleanup.sh"),
		"trap 'sleep 0.6; echo flushing; printf cleaned > cleaned; exit 0' TERM\n: > ready\nwhile \
		 :; do :; done\n",
	)
	.unwrap();
	let shell = Shell::new(None);
	let mut cancel = CancelToken::default();
	let abort = cancel.emplace_abort_token();
	let command = run(&shell, dir.path(), "/bin/sh cleanup.sh", cancel);
	let signal = async {
		tokio::time::timeout(Duration::from_secs(5), async {
			while !dir.path().join("ready").exists() {
				tokio::time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await
		.expect("child never became ready");
		abort.abort(AbortReason::Signal);
	};
	let ((result, output), ()) = tokio::join!(command, signal);
	assert!(result.cancelled, "{output}");
	assert_eq!(std::fs::read_to_string(dir.path().join("cleaned")).unwrap(), "cleaned");
}
