//! Container and cloud command output filters.

use std::fmt::Write as _;

use serde_json::Value;

use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

#[must_use]
pub fn supports(subcommand: Option<&str>) -> bool {
	matches!(
		subcommand,
		Some(
			"ps"
				| "images"
				| "logs" | "compose"
				| "build"
				| "pull" | "push"
				| "get" | "describe"
				| "status"
				| "list" | "ls"
				| "install"
				| "upgrade"
				| "template"
				| "lint" | "apply"
				| "delete"
				| "rollout"
				| "scale"
				| "create"
				| "wait" | "label"
				| "annotate"
				| "up" | "down"
				| "start"
				| "stop" | "restart"
				| "rm"
		)
	)
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let text = match ctx.program {
		"docker" => filter_docker(ctx, &cleaned, exit_code),
		"kubectl" => filter_kubectl(ctx, &cleaned, exit_code),
		"helm" => filter_helm(ctx, &cleaned, exit_code),
		_ => head_tail_dedup(&cleaned),
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn filter_docker(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> String {
	if is_log_command(ctx) {
		return filter_docker_logs(input);
	}
	if exit_code != 0 {
		return input.to_string();
	}
	if is_docker_listing_command(ctx) {
		return if is_table_command(ctx) {
			compact_table(input, 12)
		} else {
			input.to_string()
		};
	}
	// start/stop/restart/rm output is container names or confirmation messages;
	// compact_build_or_progress would strip legitimate lines that happen to
	// contain progress substrings (e.g. a container named "my-Downloading-app").
	if is_docker_lifecycle_command(ctx) {
		return head_tail_dedup(input);
	}
	// docker-compose up / docker compose up (attached mode) streams container
	// logs, not build progress.  Lines like "Downloading", "Waiting",
	// "Extracting" that appear here are real application log lines, not
	// layer-pull status noise.  Route through the log filter so they are
	// preserved.
	//
	// Two detection paths:
	//   • legacy `docker-compose up` — detect.rs normalises the binary name to
	//     "docker" and sets subcommand="up" directly.
	//   • Compose v2 `docker compose up` — subcommand="compose", action found
	//     by scanning past compose global options (same pattern as the listing
	//     and lifecycle helpers).
	if is_compose_up_command(ctx) {
		return filter_docker_logs(input);
	}
	compact_build_or_progress(input)
}

fn filter_kubectl(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> String {
	if exit_code != 0 && ctx.subcommand != Some("logs") {
		return input.to_string();
	}
	match ctx.subcommand {
		Some("logs") => filter_logs(input),
		Some("get") => {
			// Explicit JSON/YAML output — passthrough, never compact to table
			if is_explicit_kubectl_json_yaml(ctx.command) {
				return input.to_string();
			}
			if let Some(compacted) = try_compact_kubectl_json(input) {
				return compacted;
			}
			// `-o yaml` or single-object `-o json` from content (already
			// caught above by flag check, but handle content-detected too).
			if is_structured_kubectl_output(input) {
				return primitives::head_tail_lines(input, 80, 40);
			}
			// Non-table output formats produce listings, not tables
			if is_kubectl_non_table_format(ctx.command) {
				return primitives::head_tail_lines(input, 80, 40);
			}
			compact_table(input, 20)
		},
		Some("describe") => {
			primitives::head_tail_lines(&primitives::dedup_consecutive_lines(input), 120, 80)
		},
		Some("apply" | "delete" | "rollout" | "scale" | "create" | "wait" | "label" | "annotate") => {
			head_tail_dedup(input)
		},
		_ => compact_build_or_progress(input),
	}
}

// ── kubectl JSON compaction ──────────────────────────────────────────────────

/// Returns true when the `kubectl get` output is structured JSON or YAML
/// (i.e. `-o json` single-object or `-o yaml`) rather than a tabular listing.
/// Used to avoid rewriting manifests as a fake row-count table.
fn is_structured_kubectl_output(input: &str) -> bool {
	let t = input.trim_start();
	// Single-object -o json (starts with '{' but is not a List handled above)
	// or -o yaml (starts with "apiVersion:" or "kind:").
	t.starts_with('{') || t.starts_with("apiVersion:") || t.starts_with("kind:")
}

/// Whether `kubectl get` was invoked with explicit `-o json` or `-o yaml`.
///
/// Handles all three kubectl `-o` forms:
///   `-o json`      (space-separated)
///   `-o=json`      (attached with `=`)
///   `-ojson`       (fully attached, no separator — common CLI shorthand)
fn is_explicit_kubectl_json_yaml(command: &str) -> bool {
	let mut tokens = command.split_whitespace();
	while let Some(tok) = tokens.next() {
		if (tok == "-o" || tok == "--output")
			&& let Some(fmt) = tokens.next()
		{
			let base = fmt.split('=').next().unwrap_or(fmt);
			if matches!(base, "json" | "yaml") {
				return true;
			}
		}
		if let Some(val) = tok
			.strip_prefix("-o=")
			.or_else(|| tok.strip_prefix("--output="))
		{
			let base = val.split('=').next().unwrap_or(val);
			if matches!(base, "json" | "yaml") {
				return true;
			}
		}
		// Fully-attached form: `-ojson`, `-oyaml`, `-ojsonpath=...`, etc.
		if let Some(val) = tok
			.strip_prefix("-o")
			.filter(|v| !v.is_empty() && !v.starts_with('='))
		{
			let base = val.split('=').next().unwrap_or(val);
			if matches!(base, "json" | "yaml") {
				return true;
			}
		}
	}
	false
}

/// Whether `kubectl get` was invoked with a non-table output format.
/// These formats (`-o name`, `-o jsonpath/...`, `-o go-template/...`,
/// `-o template/...`, `-o custom-columns/...`, `--no-headers`) produce
/// listings or single values, not tables — `compact_table` would treat
/// the first entry as a header and corrupt the requested format.
///
/// Handles all three kubectl `-o` forms:
///   `-o name`      (space-separated)
///   `-o=name`      (attached with `=`)
///   `-oname`       (fully attached, no separator — common CLI shorthand)
fn is_kubectl_non_table_format(command: &str) -> bool {
	let mut tokens = command.split_whitespace();
	while let Some(tok) = tokens.next() {
		if (tok == "-o" || tok == "--output")
			&& let Some(fmt) = tokens.next()
		{
			let base = fmt.split('=').next().unwrap_or(fmt);
			if matches!(
				base,
				"name"
					| "jsonpath"
					| "go-template"
					| "go-template-file"
					| "template"
					| "templatefile"
					| "custom-columns"
					| "custom-columns-file"
			) {
				return true;
			}
		}
		if let Some(val) = tok
			.strip_prefix("-o=")
			.or_else(|| tok.strip_prefix("--output="))
		{
			let base = val.split('=').next().unwrap_or(val);
			if matches!(
				base,
				"name"
					| "jsonpath"
					| "go-template"
					| "go-template-file"
					| "template"
					| "templatefile"
					| "custom-columns"
					| "custom-columns-file"
			) {
				return true;
			}
		}
		// Fully-attached form: `-oname`, `-ojsonpath=...`, `-ogo-template=...`, etc.
		if let Some(val) = tok
			.strip_prefix("-o")
			.filter(|v| !v.is_empty() && !v.starts_with('='))
		{
			let base = val.split('=').next().unwrap_or(val);
			if matches!(
				base,
				"name"
					| "jsonpath"
					| "go-template"
					| "go-template-file"
					| "template"
					| "templatefile"
					| "custom-columns"
					| "custom-columns-file"
			) {
				return true;
			}
		}
		if tok == "--no-headers" {
			return true;
		}
	}
	false
}

/// Try to parse kubectl `get -o json` output and produce a compact table.
/// Returns None if input is not recognized JSON or if schema is unexpected.
fn try_compact_kubectl_json(input: &str) -> Option<String> {
	let trimmed = input.trim();
	if !trimmed.starts_with('{') {
		return None;
	}
	let root: Value = serde_json::from_str(trimmed).ok()?;

	// kubectl list JSON: {"kind":"List","items":[...]}
	if root.get("kind")?.as_str()? != "List" {
		return None;
	}
	let items = root.get("items")?.as_array()?;
	if items.is_empty() {
		return None;
	}

	// Determine resource kind from first item
	let first = &items[0];
	let kind = first.get("kind")?.as_str()?;

	match kind {
		"Pod" => Some(compact_kubectl_pods(items)),
		"Service" => Some(compact_kubectl_services(items)),
		_ => None,
	}
}

fn compact_kubectl_pods(items: &[Value]) -> String {
	let mut out = String::from("NAME\tREADY\tSTATUS\tRESTARTS\tAGE\tIP\tNODE\n");
	let mut count = 0usize;
	for item in items {
		let meta = item.get("metadata").unwrap_or(&Value::Null);
		let spec = item.get("spec").unwrap_or(&Value::Null);
		let status = item.get("status").unwrap_or(&Value::Null);

		let name = meta.get("name").and_then(|v| v.as_str()).unwrap_or("?");
		let namespace = meta
			.get("namespace")
			.and_then(|v| v.as_str())
			.unwrap_or("default");
		let phase = status.get("phase").and_then(|v| v.as_str()).unwrap_or("?");
		let pod_ip = status
			.get("podIP")
			.and_then(|v| v.as_str())
			.unwrap_or("<none>");
		let node = spec
			.get("nodeName")
			.and_then(|v| v.as_str())
			.unwrap_or("<none>");

		// Compute READY and RESTARTS from containerStatuses
		let (ready, total, restarts) = compute_pod_container_stats(status);

		let start_time = status
			.get("startTime")
			.and_then(|v| v.as_str())
			.unwrap_or("");
		// Simple age extraction (just show startTime if available)
		let age = start_time;

		let display = if namespace == "default" {
			name.to_string()
		} else {
			format!("{namespace}/{name}")
		};

		let _ =
			writeln!(out, "{display}\t{ready}/{total}\t{phase}\t{restarts}\t{age}\t{pod_ip}\t{node}");
		count += 1;
	}
	out.push('\n');
	let _ = writeln!(out, "{count} pod(s)");
	out
}

fn compute_pod_container_stats(status: &Value) -> (usize, usize, i32) {
	let Some(container_statuses) = status.get("containerStatuses").and_then(|v| v.as_array()) else {
		return (0, 0, 0);
	};
	let total = container_statuses.len();
	let mut ready = 0usize;
	let mut restarts = 0i32;
	for cs in container_statuses {
		if cs
			.get("ready")
			.and_then(serde_json::Value::as_bool)
			.unwrap_or(false)
		{
			ready += 1;
		}
		restarts += cs
			.get("restartCount")
			.and_then(serde_json::Value::as_i64)
			.unwrap_or(0) as i32;
	}
	(ready, total, restarts)
}

fn compact_kubectl_services(items: &[Value]) -> String {
	let mut out = String::from("NAME\tTYPE\tCLUSTER-IP\tEXTERNAL-IP\tPORT(S)\n");
	let mut count = 0usize;
	for item in items {
		let meta = item.get("metadata").unwrap_or(&Value::Null);
		let spec = item.get("spec").unwrap_or(&Value::Null);

		let name = meta.get("name").and_then(|v| v.as_str()).unwrap_or("?");
		let namespace = meta
			.get("namespace")
			.and_then(|v| v.as_str())
			.unwrap_or("default");
		let svc_type = spec
			.get("type")
			.and_then(|v| v.as_str())
			.unwrap_or("ClusterIP");
		let cluster_ip = spec
			.get("clusterIP")
			.and_then(|v| v.as_str())
			.unwrap_or("<none>");

		// External IP from loadBalancer status
		let external_ip = item
			.get("status")
			.and_then(|s| s.get("loadBalancer"))
			.and_then(|lb| lb.get("ingress"))
			.and_then(|ing| ing.as_array())
			.and_then(|ingress| ingress.first())
			.and_then(|i| i.get("ip").or_else(|| i.get("hostname")))
			.and_then(|v| v.as_str())
			.unwrap_or("<none>");

		// Ports
		let ports = format_k8s_ports(spec.get("ports").and_then(|v| v.as_array()));

		let display = if namespace == "default" {
			name.to_string()
		} else {
			format!("{namespace}/{name}")
		};

		let _ = writeln!(out, "{display}\t{svc_type}\t{cluster_ip}\t{external_ip}\t{ports}");
		count += 1;
	}
	out.push('\n');
	let _ = writeln!(out, "{count} service(s)");
	out
}

fn format_k8s_ports(ports: Option<&Vec<Value>>) -> String {
	let Some(ports) = ports else {
		return "<none>".to_string();
	};
	if ports.is_empty() {
		return "<none>".to_string();
	}
	let parts: Vec<String> = ports
		.iter()
		.map(|p| {
			let port = p
				.get("port")
				.and_then(serde_json::Value::as_i64)
				.map_or_else(|| "?".to_string(), |v| v.to_string());
			let proto = p.get("protocol").and_then(|v| v.as_str()).unwrap_or("TCP");
			let node_port = p.get("nodePort").and_then(serde_json::Value::as_i64);
			let target_port = p.get("targetPort");
			let target = target_port
				.and_then(serde_json::Value::as_i64)
				.map(|v| v.to_string())
				.or_else(|| {
					target_port
						.and_then(|v| v.as_str())
						.map(std::string::ToString::to_string)
				});
			match (target, node_port) {
				(Some(t), Some(np)) => format!("{port}/{t}:{np}->{port}/{proto}"),
				(Some(t), None) => format!("{port}/{t}:{port}/{proto}"),
				(None, Some(np)) => format!("{np}:{port}->{port}/{proto}"),
				(None, None) => format!("{port}/{proto}"),
			}
		})
		.collect();
	parts.join(",")
}

fn filter_helm(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> String {
	if exit_code != 0 {
		return input.to_string();
	}
	let cleaned = strip_helm_noise(input);
	match ctx.subcommand {
		Some("list" | "ls" | "status") => compact_table(&cleaned, 20),
		Some("install" | "upgrade" | "lint") => compact_build_or_progress(&cleaned),
		Some("template") => input.to_string(),
		_ => head_tail_dedup(&cleaned),
	}
}

fn strip_helm_noise(input: &str) -> String {
	let mut out = String::new();
	for line in input.lines() {
		let trimmed = line.trim_start();
		if is_glog_prefix(trimmed) {
			continue;
		}
		if trimmed.starts_with("WARNING: Kubernetes configuration file is") {
			continue;
		}
		out.push_str(line);
		out.push('\n');
	}
	out
}

fn is_glog_prefix(line: &str) -> bool {
	let bytes = line.as_bytes();
	if bytes.len() < 6
		|| bytes[0] != b'W'
		|| bytes[5] != b' '
		|| !bytes[1..5].iter().all(u8::is_ascii_digit)
	{
		return false;
	}
	// Validate month (01-12) and day (01-31) to avoid stripping legitimate
	// output that happens to start with W + 4 digits + space.
	let month = (bytes[1] - b'0') * 10 + (bytes[2] - b'0');
	let day = (bytes[3] - b'0') * 10 + (bytes[4] - b'0');
	if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
		return false;
	}
	// Require a time stamp (hh:mm...) after the space to distinguish real
	// glog lines from space-separated table output where a release name
	// happens to match W + MMDD + space.
	if bytes.len() < 11 {
		return false;
	}
	if !bytes[6].is_ascii_digit() || !bytes[7].is_ascii_digit() {
		return false;
	}
	if bytes[8] != b':' {
		return false;
	}
	if !bytes[9].is_ascii_digit() || !bytes[10].is_ascii_digit() {
		return false;
	}
	true
}

/// Returns `true` when `tok` is a known docker-compose option that consumes
/// the next token as its value (i.e. is space-separated, not `--flag=value`).
fn compose_option_consumes_next(tok: &str) -> bool {
	matches!(
		tok,
		"--ansi"
			| "--env-file"
			| "--file"
			| "-f" | "--parallel"
			| "--profile"
			| "--progress"
			| "--project-directory"
			| "--project-name"
			| "-p" | "--workdir"
			| "-w"
	)
}

fn is_log_command(ctx: &MinimizerCtx<'_>) -> bool {
	if ctx.subcommand == Some("logs") {
		return true;
	}
	// `docker compose logs <service>` — the action is `logs` but subcommand
	// resolves to `compose`.  Find the first non-option token after `compose`
	// (the action) and check only that.  Scanning further tokens would
	// misclassify service names or command args: for example,
	// `docker compose exec logs cat file` has action `exec` and service name
	// `logs`, and must NOT be routed through log dedup/truncation.
	if ctx.subcommand == Some("compose") {
		let mut tokens = ctx.command.split_whitespace();
		while let Some(tok) = tokens.next() {
			if tok == "compose" {
				loop {
					match tokens.next() {
						None => return false,
						Some(tok)
							if tok.starts_with('-')
								&& !tok.contains('=')
								&& compose_option_consumes_next(tok) =>
						{
							tokens.next(); // skip value
						},
						Some(tok) if tok.starts_with('-') => {}, // skip boolean flag
						Some(tok) => return tok == "logs",
					}
				}
			}
		}
	}
	false
}

fn is_table_command(ctx: &MinimizerCtx<'_>) -> bool {
	// Match `docker ps`, `docker images` (subcommand is argv[1])
	// or `docker compose ps`, `docker compose images` (subcommand is "compose",
	// action is argv[2]). Machine-readable listing modes (`-q`/`--quiet`, or
	// `--format` without Docker's `table` directive) must stay opaque: callers
	// commonly pipe these IDs/templates into other commands, and `compact_table`
	// would treat the first ID as a header and drop middle rows.
	if !is_docker_listing_command(ctx) {
		return false;
	}
	docker_listing_requests_table(ctx.command)
}
fn is_docker_listing_command(ctx: &MinimizerCtx<'_>) -> bool {
	matches!(ctx.subcommand, Some("ps" | "images"))
		|| ctx.subcommand == Some("compose") && is_compose_listing_action(ctx.command)
}

fn is_compose_listing_action(command: &str) -> bool {
	// Advance past the `compose` token, then find the first non-option token
	// (the action).  Only that token decides whether this is a listing command.
	// Scanning further tokens would misclassify service names: for example,
	// `docker compose up ps` has action `up` and service name `ps`, and must
	// NOT be routed through compact_table.
	let mut tokens = command
		.split_whitespace()
		.skip_while(|token| *token != "compose");
	if tokens.next() != Some("compose") {
		return false;
	}
	loop {
		match tokens.next() {
			None => return false,
			Some(tok)
				if tok.starts_with('-') && !tok.contains('=') && compose_option_consumes_next(tok) =>
			{
				tokens.next(); // skip value
			},
			Some(tok) if tok.starts_with('-') => {}, // skip boolean flag
			Some(tok) => return matches!(tok, "ps" | "images"),
		}
	}
}

fn is_docker_lifecycle_command(ctx: &MinimizerCtx<'_>) -> bool {
	matches!(ctx.subcommand, Some("start" | "stop" | "restart" | "rm"))
		|| ctx.subcommand == Some("compose") && is_compose_lifecycle_action(ctx.command)
}

fn is_compose_lifecycle_action(command: &str) -> bool {
	let mut tokens = command
		.split_whitespace()
		.skip_while(|token| *token != "compose");
	if tokens.next() != Some("compose") {
		return false;
	}
	loop {
		match tokens.next() {
			None => return false,
			Some(tok)
				if tok.starts_with('-') && !tok.contains('=') && compose_option_consumes_next(tok) =>
			{
				tokens.next(); // skip value
			},
			Some(tok) if tok.starts_with('-') => {}, // skip boolean flag
			Some(tok) => return matches!(tok, "start" | "stop" | "restart" | "rm"),
		}
	}
}

/// Returns `true` when the command is an attached `docker compose up` or
/// legacy `docker-compose up` that streams container log output.
///
/// Two forms are handled:
///   • `docker-compose up` — detect.rs normalises the binary to "docker" and
///     sets `subcommand="up"` directly; the original command still contains
///     "compose" so we can tell it apart from plain `docker build`.
///   • `docker compose up` — `subcommand="compose"`, action resolved by
///     scanning past compose global options (same logic as the listing /
///     lifecycle helpers).
fn is_compose_up_command(ctx: &MinimizerCtx<'_>) -> bool {
	// Legacy docker-compose: subcommand is already the action.
	if ctx.subcommand == Some("up") && ctx.command.contains("compose") {
		return true;
	}
	// Compose v2: subcommand is "compose", scan for first non-option action.
	if ctx.subcommand == Some("compose") {
		return is_compose_up_action(ctx.command);
	}
	false
}

fn is_compose_up_action(command: &str) -> bool {
	let mut tokens = command
		.split_whitespace()
		.skip_while(|token| *token != "compose");
	if tokens.next() != Some("compose") {
		return false;
	}
	loop {
		match tokens.next() {
			None => return false,
			Some(tok)
				if tok.starts_with('-') && !tok.contains('=') && compose_option_consumes_next(tok) =>
			{
				tokens.next(); // skip value
			},
			Some(tok) if tok.starts_with('-') => {}, // skip boolean flag
			Some(tok) => return tok == "up",
		}
	}
}

fn docker_listing_requests_table(command: &str) -> bool {
	let mut tokens = command.split_whitespace();
	while let Some(token) = tokens.next() {
		if matches!(token, "-q" | "--quiet") {
			return false;
		}
		if token == "--format" {
			return tokens.next().is_some_and(docker_format_requests_table);
		}
		if let Some(format) = token.strip_prefix("--format=") {
			return docker_format_requests_table(format);
		}
	}
	true
}

fn docker_format_requests_table(format: &str) -> bool {
	let format = format.trim_matches(|c| matches!(c, '"' | '\''));
	format == "table" || format.starts_with("table ")
}

fn filter_logs(input: &str) -> String {
	let without_empty_runs = drop_repeated_blank_lines(input);
	crate::minimizer::filters::system::compact_log_lines(
		&without_empty_runs,
		120,
		80,
		crate::minimizer::filters::system::normalize_log_line,
	)
}

fn filter_docker_logs(input: &str) -> String {
	let without_empty_runs = drop_repeated_blank_lines(input);
	crate::minimizer::filters::system::compact_log_lines(&without_empty_runs, 120, 80, log_dedup_key)
}

fn log_dedup_key(line: &str) -> String {
	if let Some((service, message)) = line.split_once('|') {
		let service = service.trim();
		if is_compose_log_service(service) {
			let message = message.trim_start();
			let normalized = crate::minimizer::filters::system::normalize_log_line(message);
			return format!("{service}|{normalized}");
		}
	}
	crate::minimizer::filters::system::normalize_log_line(line)
}

fn is_compose_log_service(value: &str) -> bool {
	!value.is_empty()
		&& !matches!(value, "debug" | "error" | "fatal" | "info" | "trace" | "warn" | "warning")
		&& value.bytes().any(|byte| byte.is_ascii_lowercase())
		&& value.bytes().all(|byte| {
			byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_' | b'.')
		})
}

fn compact_table(input: &str, visible_rows: usize) -> String {
	let lines: Vec<&str> = input
		.lines()
		.filter(|line| !line.trim().is_empty())
		.collect();
	if lines.len() <= visible_rows + 1 {
		return input.to_string();
	}

	let mut out = String::new();
	if let Some(header) = lines.first() {
		out.push_str(header.trim_end());
		out.push('\n');
	}
	out.push_str(&(lines.len() - 1).to_string());
	out.push_str(" rows\n");
	for line in lines.iter().skip(1).take(visible_rows) {
		out.push_str(line.trim_end());
		out.push('\n');
	}
	out.push_str("[…");
	out.push_str(&(lines.len() - 1 - visible_rows).to_string());
	out.push_str(" rows elided…]\n");
	out
}

fn compact_build_or_progress(input: &str) -> String {
	let mut out = String::new();
	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() || is_progress_line(trimmed) {
			continue;
		}
		out.push_str(line.trim_end());
		out.push('\n');
	}
	head_tail_dedup(&out)
}

fn is_progress_line(line: &str) -> bool {
	line.starts_with("=> ")
		|| line.starts_with('#') && line.contains("DONE")
		|| line.starts_with('#') && line.contains("CACHED")
		|| line.starts_with('#') && line.contains("transferring ")
		|| line.starts_with('#') && line.contains("extracting ")
		|| line.contains("Pulling fs layer")
		|| line.contains("Pull complete")
		|| line.contains("Download complete")
		|| line.contains("Downloading")
		|| line.contains("Extracting")
		|| line.contains("Waiting")
		|| line.contains("Verifying Checksum")
		|| line.starts_with("Attaching to ")
		|| line.starts_with("Gracefully stopping")
		|| is_compose_container_status_line(line)
}

fn is_compose_container_status_line(line: &str) -> bool {
	let line = line.trim_start();
	line.starts_with("Container ")
		&& ["Creating", "Created", "Starting", "Started", "Waiting", "Healthy", "Running"]
			.iter()
			.any(|status| line.contains(status))
}

fn drop_repeated_blank_lines(input: &str) -> String {
	let mut out = String::new();
	let mut saw_blank = false;
	for line in input.lines() {
		if line.trim().is_empty() {
			if !saw_blank {
				out.push('\n');
			}
			saw_blank = true;
			continue;
		}
		saw_blank = false;
		out.push_str(line);
		out.push('\n');
	}
	out
}

fn head_tail_dedup(input: &str) -> String {
	primitives::head_tail_lines(&primitives::dedup_consecutive_lines(input), 120, 80)
}
