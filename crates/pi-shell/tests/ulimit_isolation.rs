//! Kept in a separate test executable: a regression lowers the host's NOFILE
//! limit.
#![cfg(unix)]

use pi_shell::{ShellExecuteOptions, cancel::CancelToken, execute_shell};

fn host_nofile() -> (libc::rlim_t, libc::rlim_t) {
	let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
	// SAFETY: lim is a valid writable rlimit for the duration of the call.
	assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &raw mut lim) }, 0);
	(lim.rlim_cur, lim.rlim_max)
}

fn format_limit(value: libc::rlim_t) -> String {
	if value == libc::RLIM_INFINITY {
		"unlimited".to_string()
	} else {
		value.to_string()
	}
}

async fn run(command: &str) -> (Option<i32>, Vec<String>) {
	let (tx, rx) = flume::unbounded::<String>();
	let result = execute_shell(
		ShellExecuteOptions {
			command: command.to_string(),
			timeout_ms: Some(5_000),
			..Default::default()
		},
		Some(tx),
		CancelToken::default(),
	)
	.await
	.expect("shell execution");
	let output: String = rx.try_iter().collect();
	(result.exit_code, output.lines().map(str::to_string).collect())
}

#[tokio::test]
async fn bare_ulimit_caps_children_without_touching_host() {
	let (soft, hard) = host_nofile();
	let lowered = soft.min(4096) - 11;
	let (code, lines) =
		run(&format!("ulimit -S -n {lowered}; ulimit -S -n; /bin/sh -c 'ulimit -S -n'")).await;
	assert_eq!(code, Some(0), "output: {lines:?}");
	assert_eq!(lines, [lowered.to_string(), lowered.to_string()]);
	assert_eq!(host_nofile(), (soft, hard), "host RLIMIT_NOFILE must be unchanged");

	let (code, lines) = run("ulimit -S -n; /bin/sh -c 'ulimit -S -n'").await;
	assert_eq!(code, Some(0), "output: {lines:?}");
	assert_eq!(lines, [format_limit(soft), format_limit(soft)], "other shells keep host limits");
}

#[tokio::test]
async fn subshell_inherits_limits_but_cannot_change_parent_limits() {
	let (soft, hard) = host_nofile();
	let parent = soft.min(4096) - 7;
	let child = parent - 7;
	let (code, lines) = run(&format!(
		"ulimit -S -n {parent}; ( ulimit -S -n; ulimit -S -n {child}; ulimit -S -n; /bin/sh -c \
		 'ulimit -S -n' ); ulimit -S -n; /bin/sh -c 'ulimit -S -n'"
	))
	.await;
	assert_eq!(code, Some(0), "output: {lines:?}");
	assert_eq!(lines, [
		parent.to_string(),
		child.to_string(),
		child.to_string(),
		parent.to_string(),
		parent.to_string()
	]);
	assert_eq!(host_nofile(), (soft, hard), "host RLIMIT_NOFILE must be unchanged");
}

#[tokio::test]
async fn pipeline_inherits_limits_but_cannot_change_parent_limits() {
	let (soft, hard) = host_nofile();
	let parent = soft.min(4096) - 13;
	let child = parent - 13;
	let (code, lines) = run(&format!(
		"ulimit -S -n {parent}; {{ ulimit -S -n; ulimit -S -n {child}; /bin/sh -c 'ulimit -S -n'; \
		 }} | /bin/cat; ulimit -S -n; /bin/sh -c 'ulimit -S -n'"
	))
	.await;
	assert_eq!(code, Some(0), "output: {lines:?}");
	assert_eq!(lines, [
		parent.to_string(),
		child.to_string(),
		parent.to_string(),
		parent.to_string()
	]);
	assert_eq!(host_nofile(), (soft, hard), "host RLIMIT_NOFILE must be unchanged");
}

#[tokio::test]
async fn hard_limit_changes_only_children_and_invalid_soft_limit_is_rejected() {
	let (soft, hard) = host_nofile();
	let lowered = soft.min(4096) - 17;
	let invalid = lowered + 1;
	let (code, lines) = run(&format!(
		"ulimit -S -n {lowered}; ulimit -H -n {lowered}; if ulimit -S -n {invalid} 2>/dev/null; \
		 then echo accepted; else echo rejected; fi; ulimit -S -n; ulimit -H -n; /bin/sh -c 'ulimit \
		 -S -n; ulimit -H -n'"
	))
	.await;
	assert_eq!(code, Some(0), "output: {lines:?}");
	assert_eq!(lines, [
		"rejected".to_string(),
		lowered.to_string(),
		lowered.to_string(),
		lowered.to_string(),
		lowered.to_string()
	]);
	assert_eq!(host_nofile(), (soft, hard), "host RLIMIT_NOFILE must be unchanged");
}
