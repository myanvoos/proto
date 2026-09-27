//! The JS kernel-cell builtins tell the bridge host which runtime a cell
//! targets, and fall through to a real interpreter when the host declines.

#![cfg(unix)]

use std::{
	collections::HashMap,
	io::{BufRead, BufReader, Write},
	net::TcpListener,
	thread::JoinHandle,
};

use pi_shell::{ShellExecuteOptions, ShellExecuteResult, cancel::CancelToken, execute_shell};
use serde_json::Value;

const TOKEN: &str = "routing-test-token";

/// A one-shot bridge host: records the cell request and answers with `reply`.
fn bridge(reply: &'static str) -> (String, JoinHandle<Value>) {
	let listener = TcpListener::bind("127.0.0.1:0").expect("bridge should bind");
	let addr = listener.local_addr().expect("bridge addr").to_string();
	let host = std::thread::spawn(move || {
		let (stream, _) = listener.accept().expect("builtin should connect");
		let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
		let mut line = String::new();
		reader.read_line(&mut line).expect("request line");
		(&stream).write_all(reply.as_bytes()).expect("reply");
		serde_json::from_str(&line).expect("request is JSON")
	});
	(addr, host)
}

async fn run(command: &str, addr: &str, path: &str) -> (ShellExecuteResult, String) {
	let env: HashMap<String, String> =
		[("PI_KERNEL_BRIDGE_ADDR", addr), ("PI_KERNEL_BRIDGE_TOKEN", TOKEN), ("PATH", path)]
			.into_iter()
			.map(|(key, value)| (key.to_string(), value.to_string()))
			.collect();
	let (tx, rx) = flume::unbounded();
	let result = execute_shell(
		ShellExecuteOptions {
			command: command.to_string(),
			env: Some(env),
			..ShellExecuteOptions::default()
		},
		Some(tx),
		CancelToken::default(),
	)
	.await
	.expect("command should execute");
	(result, rx.into_iter().collect())
}

fn stage_route(result: &ShellExecuteResult) -> String {
	let stage: Value = serde_json::from_str(result.stage_records.first().expect("one stage"))
		.expect("stage record is JSON");
	stage["route"].as_str().expect("stage route").to_string()
}

#[tokio::test]
async fn js_cells_name_their_runtime_to_the_bridge() {
	for (command, lang) in [("node", "node"), ("nodejs", "node"), ("bun", "bun")] {
		let (addr, host) = bridge("{\"t\":\"o\",\"d\":\"ran\\n\"}\n{\"t\":\"x\",\"c\":0}\n");
		let (result, output) = run(&format!("{command} -e 'cell()'"), &addr, "/usr/bin:/bin").await;
		let request = host.join().expect("bridge host");

		assert_eq!(request["lang"], lang, "{command} requested the wrong runtime");
		assert_eq!(request["code"], "cell()");
		assert_eq!(request["token"], TOKEN);
		assert_eq!(result.exit_code, Some(0), "{command}: {output:?}");
		assert_eq!(output, "ran\n");
		assert_eq!(stage_route(&result), lang, "{command} traced the wrong route");
	}
}

#[tokio::test]
async fn kernel_requests_preserve_interpreter_visible_arguments() {
	for (command, expected, filename) in [
		("python3 -c 'cell()' --flag value", vec!["-c", "--flag", "value"], None),
		("python3 - first second <<'PY'\ncell()\nPY", vec!["-", "first", "second"], Some("<stdin>")),
		("node -e 'cell()' -- --flag value", vec!["--flag", "value"], None),
		("bun -e 'cell()' first --flag", vec!["first", "--flag"], None),
	] {
		let (addr, host) = bridge("{\"t\":\"x\",\"c\":0}\n");
		let (result, output) = run(command, &addr, "/usr/bin:/bin").await;
		let request = host.join().expect("bridge request");
		let argv = request["invocation"]["argv"]
			.as_array()
			.expect("invocation argv");
		let arguments = if request["lang"] == "py" {
			&argv[..]
		} else {
			&argv[1..]
		};
		assert_eq!(arguments, expected, "{command}");
		assert_eq!(request["invocation"]["filename"].as_str(), filename);
		assert_eq!(result.exit_code, Some(0), "{output:?}");
	}
}

#[tokio::test]
async fn declined_node_cell_without_interpreter_reports_both_names() {
	let (addr, host) = bridge("{\"t\":\"f\"}\n");
	let missing = std::env::temp_dir().join(format!("pi-shell-no-node-{}", std::process::id()));
	let (result, output) = run("node -e 'cell()'", &addr, &missing.to_string_lossy()).await;
	assert_eq!(host.join().expect("bridge host")["lang"], "node");

	assert_eq!(result.exit_code, Some(127), "{output:?}");
	assert_eq!(output, "node: command not found (no node or nodejs on PATH)\n");
	assert_eq!(stage_route(&result), "external");
}
