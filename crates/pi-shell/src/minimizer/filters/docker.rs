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

	if is_docker_lifecycle_command(ctx) {
		return head_tail_dedup(input);
	}

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
			if is_explicit_kubectl_json_yaml(ctx.command) {
				return input.to_string();
			}
			if let Some(compacted) = try_compact_kubectl_json(input) {
				return compacted;
			}

			if is_structured_kubectl_output(input) {
				return primitives::head_tail_lines(input, 80, 40);
			}

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

fn is_structured_kubectl_output(input: &str) -> bool {
	let t = input.trim_start();

	t.starts_with('{') || t.starts_with("apiVersion:") || t.starts_with("kind:")
}

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

fn try_compact_kubectl_json(input: &str) -> Option<String> {
	let trimmed = input.trim();
	if !trimmed.starts_with('{') {
		return None;
	}
	let root: Value = serde_json::from_str(trimmed).ok()?;

	if root.get("kind")?.as_str()? != "List" {
		return None;
	}
	let items = root.get("items")?.as_array()?;
	if items.is_empty() {
		return None;
	}

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

		let (ready, total, restarts) = compute_pod_container_stats(status);

		let start_time = status
			.get("startTime")
			.and_then(|v| v.as_str())
			.unwrap_or("");

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

		let external_ip = item
			.get("status")
			.and_then(|s| s.get("loadBalancer"))
			.and_then(|lb| lb.get("ingress"))
			.and_then(|ing| ing.as_array())
			.and_then(|ingress| ingress.first())
			.and_then(|i| i.get("ip").or_else(|| i.get("hostname")))
			.and_then(|v| v.as_str())
			.unwrap_or("<none>");

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

	let month = (bytes[1] - b'0') * 10 + (bytes[2] - b'0');
	let day = (bytes[3] - b'0') * 10 + (bytes[4] - b'0');
	if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
		return false;
	}

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
							tokens.next();
						},
						Some(tok) if tok.starts_with('-') => {},
						Some(tok) => return tok == "logs",
					}
				}
			}
		}
	}
	false
}

fn is_table_command(ctx: &MinimizerCtx<'_>) -> bool {
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
				tokens.next();
			},
			Some(tok) if tok.starts_with('-') => {},
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
				tokens.next();
			},
			Some(tok) if tok.starts_with('-') => {},
			Some(tok) => return matches!(tok, "start" | "stop" | "restart" | "rm"),
		}
	}
}

fn is_compose_up_command(ctx: &MinimizerCtx<'_>) -> bool {
	if ctx.subcommand == Some("up") && ctx.command.contains("compose") {
		return true;
	}

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
				tokens.next();
			},
			Some(tok) if tok.starts_with('-') => {},
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
