use std::time::{Duration, Instant};

use pi_shell::{ShellExecuteOptions, cancel::CancelToken, execute_shell};

async fn run(command: &str) -> String {
	let (tx, rx) = flume::unbounded();
	let result = execute_shell(
		ShellExecuteOptions { command: command.to_string(), ..ShellExecuteOptions::default() },
		Some(tx),
		CancelToken::default(),
	)
	.await
	.expect("command should execute");
	assert_eq!(result.exit_code, Some(0), "command failed: {command}");
	rx.into_iter().collect()
}

fn field<'a>(output: &'a str, key: &str) -> &'a str {
	output
		.lines()
		.find_map(|line| line.strip_prefix(key))
		.unwrap_or_else(|| panic!("missing {key} in {output:?}"))
}

#[tokio::test]
async fn in_shell_background_job_pid_is_listed_killable_and_waitable() {
	let started = Instant::now();
	let output = run(
		"(sleep 5) & pid=$!; echo \"pid=$pid\"; jobs -l; kill \"$pid\"; wait \"$pid\"; echo \
		 \"status=$?\"",
	)
	.await;
	let pid = field(&output, "pid=");
	assert!(pid.parse::<i32>().is_ok_and(|pid| pid > 0), "$! was {pid:?}");
	assert!(output.contains(&format!("[1]+{pid}\t")), "jobs -l did not list {pid}: {output:?}");
	assert_eq!(field(&output, "status="), "143");
	assert!(started.elapsed() < Duration::from_secs(4), "kill did not stop the job");
}

#[tokio::test]
async fn job_spec_kill_terminates_in_shell_background_job() {
	let started = Instant::now();
	let output = run("{ sleep 5; } & kill %1; wait %1; echo \"status=$?\"").await;
	assert_eq!(field(&output, "status="), "143");
	assert!(started.elapsed() < Duration::from_secs(4), "kill %1 did not stop the job");
}

#[tokio::test]
async fn last_background_pid_survives_wait_and_tracks_builtins() {
	let output = run("true & first=$!; wait; echo \"first=$first\"; echo \"after=$!\"").await;
	let first = field(&output, "first=");
	assert!(first.parse::<i32>().is_ok(), "$! for a background builtin was {first:?}");
	assert_eq!(field(&output, "after="), first);
}

#[cfg(unix)]
#[tokio::test]
async fn external_background_process_reports_its_os_pid() {
	let output = run("/bin/sleep 1 & /bin/kill -0 \"$!\"; echo \"probe=$?\"; kill $!; wait").await;
	assert_eq!(field(&output, "probe="), "0");
}

#[cfg(unix)]
#[tokio::test]
async fn in_shell_job_pid_never_reaches_a_real_process() {
	let output =
		run("(sleep 5) & /bin/kill -0 \"$!\" 2>/dev/null; echo \"probe=$?\"; kill %1; wait").await;
	assert_ne!(field(&output, "probe="), "0");
}
