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

#[tokio::test]
async fn jq_preserves_bom_variables_streaming_inputs_and_sorted_json() {
	let dir = tempfile::tempdir().unwrap();
	let (code, output) = run(
		"printf '\\357\\273\\277{\"n\":2}\\n{\"n\":3}\\n' | jq -cS --arg label total --argjson \
		 offset 4 '{label: $label, value: (.n + $offset), rest: [inputs | .n]}'",
		dir.path(),
	)
	.await;
	assert_eq!(code, Some(0), "{output}");
	assert_eq!(output, "{\"label\":\"total\",\"rest\":[3],\"value\":6}\n");

	let (code, output) =
		run("printf 'one\\ntwo\\n' | jq -Rnr '[inputs] | join(\"-\")'", dir.path()).await;
	assert_eq!(code, Some(0), "{output}");
	assert_eq!(output, "one-two\n");
	let (code, output) = run("jq -nc '[nan, infinite, -infinite]'", dir.path()).await;
	assert_eq!(code, Some(0), "{output}");
	assert_eq!(output, "[null,null,null]\n");
}

#[tokio::test]
async fn jq_keeps_shell_environment_modules_halt_codes_and_diagnostics() {
	let dir = tempfile::tempdir().unwrap();
	std::fs::write(dir.path().join("helpers.jq"), "def twice: . * 2;\n").unwrap();
	let (code, output) = run(
		"export PROTO_JQ_VALUE=7; jq -nr -L . 'include \"helpers\"; env.PROTO_JQ_VALUE | tonumber | \
		 twice'",
		dir.path(),
	)
	.await;
	assert_eq!(code, Some(0), "{output}");
	assert_eq!(output, "14\n");
	let (code, output) = run("jq -nc '{x: 1} | debug'", dir.path()).await;
	assert_eq!(code, Some(0), "{output}");
	assert!(output.contains("[\"DEBUG:\", {\"x\":1}]"), "{output}");
	assert!(output.ends_with("{\"x\":1}\n"), "{output}");
	let (code, output) = run("jq -n 'try halt catch \"caught\"'; printf alive", dir.path()).await;
	assert_eq!(code, Some(0), "{output}");
	assert_eq!(output, "alive");
	let (code, output) = run("jq -n '\"stopped\" | halt_error(7)'", dir.path()).await;
	assert_eq!(code, Some(7), "{output}");
	assert_eq!(output, "stopped");
	let (code, output) = run("jq -n 'missing_proto_filter'", dir.path()).await;
	assert_ne!(code, Some(0), "{output}");
	assert!(output.contains("undefined filter"), "{output}");
	let (code, output) = run("jq -n --argjson value '1 2' '$value'", dir.path()).await;
	assert_ne!(code, Some(0), "{output}");
	assert!(output.contains("--argjson value"), "{output}");
}

#[tokio::test]
async fn jq_run_tests_checks_expected_values_and_reports_failures() {
	let dir = tempfile::tempdir().unwrap();
	std::fs::write(dir.path().join("passing.jqtest"), "# a jq test\n.[]\n[1,2]\n1\n2\n\n").unwrap();
	std::fs::write(dir.path().join("failing.jqtest"), ". + 1\n1\n3\n\n").unwrap();
	let (code, output) = run("jq --run-tests passing.jqtest", dir.path()).await;
	assert_eq!(code, Some(0), "{output}");
	assert!(output.contains("1 out of 1 tests passed"), "{output}");
	let (code, output) = run("jq --run-tests failing.jqtest", dir.path()).await;
	assert_eq!(code, Some(1), "{output}");
	assert!(output.contains("expected [3], obtained [2]"), "{output}");
}

#[tokio::test]
async fn checksum_lengths_remain_bits_and_tagged_checksums_validate() {
	let dir = tempfile::tempdir().unwrap();
	std::fs::write(dir.path().join("data"), b"abc").unwrap();
	let (code, output) = run("b2sum -l 128 data", dir.path()).await;
	assert_eq!(code, Some(0), "{output}");
	assert_eq!(output, "cf4ab791c62b8d2b2109c90275287816  data\n");
	std::fs::write(dir.path().join("blake.check"), &output).unwrap();
	let (code, output) = run("b2sum -c blake.check", dir.path()).await;
	assert_eq!(code, Some(0), "{output}");
	assert_eq!(output, "data: OK\n");
	let (code, output) = run("cksum -a sha3 -l 256 --tag data", dir.path()).await;
	assert_eq!(code, Some(0), "{output}");
	assert_eq!(
		output,
		"SHA3-256 (data) = 3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532\n"
	);
	std::fs::write(dir.path().join("sha3.check"), &output).unwrap();
	let (code, output) = run("cksum -c sha3.check", dir.path()).await;
	assert_eq!(code, Some(0), "{output}");
	assert_eq!(output, "data: OK\n");
}

#[tokio::test]
async fn date_touch_and_large_seq_preserve_conversion_boundaries() {
	let dir = tempfile::tempdir().unwrap();
	let (code, output) = run(
		"TZ=UTC date -d '2001-02-03 04:05:06 UTC' '+%Y-%m-%dT%H:%M:%S%z'; TZ=UTC touch -d \
		 '2001-02-03 04:05:06 UTC' stamp; seq 18446744073709551616 18446744073709551618",
		dir.path(),
	)
	.await;
	assert_eq!(code, Some(0), "{output}");
	assert_eq!(
		output,
		concat!(
			"2001-02-03T04:05:06+0000\n",
			"18446744073709551616\n",
			"18446744073709551617\n",
			"18446744073709551618\n",
		)
	);
	assert_eq!(
		std::fs::metadata(dir.path().join("stamp"))
			.unwrap()
			.modified()
			.unwrap()
			.duration_since(std::time::UNIX_EPOCH)
			.unwrap()
			.as_secs(),
		981_173_106
	);
}

#[tokio::test]
async fn backups_refuse_destroying_the_source_and_follow_shell_environment() {
	let dir = tempfile::tempdir().unwrap();
	std::fs::write(dir.path().join("data"), "target").unwrap();
	std::fs::write(dir.path().join("data~"), "source").unwrap();
	let (code, output) = run("mv --backup=simple ./data~ data", dir.path()).await;
	assert_eq!(code, Some(1), "{output}");
	assert_eq!(std::fs::read_to_string(dir.path().join("data~")).unwrap(), "source");
	assert_eq!(std::fs::read_to_string(dir.path().join("data")).unwrap(), "target");
	let (code, output) = run("VERSION_CONTROL=numbered ln -b data data~", dir.path()).await;
	assert_eq!(code, Some(0), "{output}");
	assert_eq!(std::fs::read_to_string(dir.path().join("data~.~1~")).unwrap(), "source");
	assert_eq!(std::fs::read_to_string(dir.path().join("data~")).unwrap(), "target");
}

#[tokio::test]
async fn shell_regex_and_expansion_caches_preserve_matching_and_case_conversion() {
	let dir = tempfile::tempdir().unwrap();
	let (code, output) = run(
		"value=abC; for pass in 1 2; do printf '%s\\n' \"${value^^[a-z]}\" \"${value,,[A-Z]}\"; [[ \
		 $value =~ (bC) ]] && printf '%s\\n' \"${BASH_REMATCH[1]}\"; done",
		dir.path(),
	)
	.await;
	assert_eq!(code, Some(0), "{output}");
	assert_eq!(output, "ABC\nabc\nbC\nABC\nabc\nbC\n");
}
