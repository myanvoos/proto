#![cfg(unix)]

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

async fn run(command: &str, cwd: &std::path::Path) -> (Option<i32>, String) {
	let (tx, rx) = flume::unbounded();
	let result = Shell::new(None)
		.run(
			ShellRunOptions {
				command: command.into(),
				cwd: Some(cwd.to_string_lossy().into_owned()),
				timeout_ms: Some(5_000),
				..Default::default()
			},
			Some(tx),
			CancelToken::default(),
		)
		.await
		.unwrap();
	(result.exit_code, rx.into_iter().collect())
}

#[tokio::test]
async fn command_describes_all_operands_and_reports_misses() {
	let dir = tempfile::tempdir().unwrap();
	let (code, output) = run("command -v true missing-proto-command false pwd", dir.path()).await;
	assert_eq!(code, Some(0), "{output}");
	assert_eq!(output, "true\nfalse\npwd\n");
	let (code, output) = run("command -V missing-proto-command true", dir.path()).await;
	assert_eq!(code, Some(0), "{output}");
	assert!(output.contains("command: missing-proto-command: not found"), "{output}");
	assert!(output.contains("true is a shell builtin"), "{output}");
	assert_eq!(
		run("command -v missing-proto-command missing-proto-command2", dir.path())
			.await
			.0,
		Some(1)
	);
	assert_eq!(run("command -v", dir.path()).await.0, Some(0));
}

#[tokio::test]
async fn rg_crlf_anchors_match_without_configuration_errors() {
	let dir = tempfile::tempdir().unwrap();
	let (code, output) = run("printf 'ax\r\nbx\nc\r\n' | rg --crlf -c 'x$'", dir.path()).await;
	assert_eq!(code, Some(0), "{output}");
	assert_eq!(output, "2\n");
}

#[tokio::test]
async fn rg_skips_redirected_output_and_its_hardlinks() {
	let dir = tempfile::tempdir().unwrap();
	std::fs::write(dir.path().join("data.txt"), "needle\n").unwrap();
	std::fs::write(dir.path().join("z-output.txt"), "needle\n").unwrap();
	std::fs::hard_link(dir.path().join("z-output.txt"), dir.path().join("alias.txt")).unwrap();
	let (code, output) =
		run("search() { rg --sort path --max-count 1 needle; }; search >> z-output.txt", dir.path())
			.await;
	assert_eq!(code, Some(0), "{output}");
	assert_eq!(
		std::fs::read_to_string(dir.path().join("z-output.txt")).unwrap(),
		"needle\ndata.txt:needle\n"
	);
	let (code, output) = run("rg --files --sort path > z-output.txt", dir.path()).await;
	assert_eq!(code, Some(0), "{output}");
	assert_eq!(std::fs::read_to_string(dir.path().join("z-output.txt")).unwrap(), "data.txt\n");
	let (code, output) =
		run("search() { rg --files --sort path | cat; }; search > z-output.txt", dir.path()).await;
	assert_eq!(code, Some(0), "{output}");
	assert_eq!(
		std::fs::read_to_string(dir.path().join("z-output.txt")).unwrap(),
		"alias.txt\ndata.txt\nz-output.txt\n"
	);
}
