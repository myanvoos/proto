//! Package manager output filters.

use std::{collections::HashSet, fmt::Write as _};

use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};
const PACKAGE_TREE_HEAD_LINES: usize = 80;

#[must_use]
pub fn supports(subcommand: Option<&str>) -> bool {
	matches!(
		subcommand,
		Some(
			"install"
				| "i" | "ci"
				| "add" | "update"
				| "up" | "upgrade"
				| "remove"
				| "rm" | "uninstall"
				| "list" | "ls"
				| "tree" | "pip"
				| "outdated"
				| "sync" | "lock"
				| "run" | "exec"
				| "audit"
				| "check"
				| "show" | "info"
				| "view" | "fund"
				| "explain"
				| "test" | "t"
				| "start"
				| "stop" | "restart"
				| "config"
				| "cache"
				| "prune"
				| "dedupe"
				| "publish"
				| "pack" | "link"
				| "why" | "export"
		)
	)
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	if exit_code == 0
		&& (command_contains_any(ctx.command, &["--json"])
			|| primitives::command_has_any_token(ctx.command, &["--format=json"])
			|| primitives::command_has_ordered_tokens(ctx.command, "--format", "json")
			|| ctx.program == "uv"
				&& matches!(ctx.subcommand, Some("pip"))
				&& command_contains_any(ctx.command, &["freeze"]))
	{
		return MinimizerOutput::passthrough(input);
	}

	let cleaned = primitives::strip_ansi(input);

	// Success no-op short-circuits, moved here from defs/poetry-install.toml and
	// defs/uv-sync.toml so they fire regardless of overlay ordering. Each is
	// scoped per (program, subcommand) so unrelated package managers are
	// untouched. A non-empty message means ensure_success_visible leaves it as-is
	// (no bare 'OK' rewrite).
	if exit_code == 0
		&& let Some(message) = success_up_to_date_short_circuit(ctx, &cleaned)
	{
		return MinimizerOutput::transformed(message.to_string(), input.len());
	}

	let text = if exit_code == 0 && is_package_lock_command(ctx) {
		compact_package_lock_output(ctx, &cleaned)
	} else {
		let stripped = strip_package_noise(ctx, &cleaned, exit_code);
		let deduped = primitives::dedup_consecutive_lines(&stripped);
		if contains_audit_or_security_summary(&deduped) {
			deduped
		} else if exit_code == 0
			&& (is_package_tree_command(ctx) || is_package_export_command(ctx))
			&& !command_contains_any(ctx.command, &["--json"])
			&& !primitives::command_has_any_token(ctx.command, &["--format=json"])
			&& !primitives::command_has_ordered_tokens(ctx.command, "--format", "json")
		{
			compact_package_tree_output(&deduped)
		} else {
			let cap = if exit_code == 0 {
				primitives::CapClass::Inventory
			} else {
				primitives::CapClass::Errors
			};
			primitives::head_tail_cap(&deduped, cap)
		}
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

/// Per-(program, subcommand) success no-op detection. Returns the one-line
/// summary to emit when the raw output says nothing changed, replacing the
/// `match_output` overlays that previously lived in defs/poetry-install.toml
/// and defs/uv-sync.toml. Callers must gate on `exit_code` == 0.
fn success_up_to_date_short_circuit(ctx: &MinimizerCtx<'_>, cleaned: &str) -> Option<&'static str> {
	// poetry install/lock/update no-op: 'No dependencies to install or update'
	// (poetry 1.x) or 'No changes.' (poetry 2.x). Scoped to program=poetry.
	if ctx.program == "poetry"
		&& matches!(ctx.subcommand, Some("install" | "lock" | "update"))
		&& cleaned.lines().any(|line| {
			let lower = line.trim().to_ascii_lowercase();
			lower.starts_with("no dependencies to install or update") || lower == "no changes."
		}) {
		return Some("ok (up to date)");
	}
	// uv sync/add/remove no-op: 'Audited N packages in Xms' with no installs.
	// Scoped to those subcommands so npm/brew/composer 'Audited' is unaffected.
	// Only collapse when the run is a CLEAN no-op: uv co-prints actionable
	// diagnostics (e.g. 'warning: VIRTUAL_ENV=… does not match the project
	// environment path …') alongside the Audited line on exit 0, and eagerly
	// collapsing to 'ok (up to date)' would destroy them. On HEAD the global
	// is_noise_line stripped the Audited line but the surviving warning kept the
	// output non-empty, so it was reported; preserve that by short-circuiting only
	// when no warning/error line co-occurs. (poetry's branch above deliberately
	// collapses warnings too — its deleted overlay did the same, so it stays.)
	if ctx.program == "uv"
		&& matches!(ctx.subcommand, Some("sync" | "add" | "remove"))
		&& !uv_has_actionable_diagnostic(cleaned)
		&& cleaned.lines().any(|line| {
			let lower = line.trim().to_ascii_lowercase();
			lower.starts_with("audited ") && lower.contains("package")
		}) {
		return Some("ok (up to date)");
	}
	None
}

/// True when any line carries an actionable diagnostic ('warning'/'error'/
/// 'failed') that must survive a uv no-op short-circuit. Kept deliberately
/// narrow: the no-op summary lines themselves ('Resolved …', 'Audited …') carry
/// none of these tokens, so a clean no-op still collapses to 'ok (up to date)'.
/// Do NOT reuse `is_error_or_summary` here — it also matches 'audited'/'found'/
/// 'success'/'complete', which would suppress the short-circuit on every no-op.
fn uv_has_actionable_diagnostic(cleaned: &str) -> bool {
	cleaned.lines().any(|line| {
		let lower = line.to_ascii_lowercase();
		lower.contains("warning") || lower.contains("error") || lower.contains("failed")
	})
}

fn strip_package_noise(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> String {
	let mut out = String::new();
	let mut previous_blank = false;
	// snip keeps exactly one JS install-summary line ('added N packages…',
	// 'up to date', pnpm 'Done in Xs'/'Packages: +N', yarn 'Done in Xs'): the
	// count confirms lockfile/node_modules state. Keep the first such line and
	// treat later duplicates as noise. This check precedes is_noise_line so the
	// 'audited N packages' strip cannot eat the combined 'added…audited' summary.
	let mut kept_install_summary = false;
	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() {
			if !previous_blank {
				out.push('\n');
			}
			previous_blank = true;
			continue;
		}
		previous_blank = false;

		if is_js_program(ctx.program) && is_js_install_summary(&trimmed.to_ascii_lowercase()) {
			if kept_install_summary {
				continue;
			}
			kept_install_summary = true;
			out.push_str(line.trim_end());
			out.push('\n');
			continue;
		}

		if is_noise_line(ctx, trimmed, exit_code) {
			continue;
		}
		out.push_str(line.trim_end());
		out.push('\n');
	}
	out
}

fn is_package_tree_command(ctx: &MinimizerCtx<'_>) -> bool {
	match ctx.program {
		"npm" | "pnpm" | "yarn" => {
			matches!(ctx.subcommand, Some("list" | "ls" | "tree" | "why" | "explain"))
		},
		"bun" => {
			matches!(ctx.subcommand, Some("list" | "ls" | "tree" | "why" | "explain"))
				|| matches!(ctx.subcommand, Some("pm"))
					&& command_contains_any(ctx.command, &["list", "ls", "tree", "why"])
		},
		"uv" => {
			matches!(ctx.subcommand, Some("list" | "ls" | "tree"))
				|| matches!(ctx.subcommand, Some("pip"))
					&& command_contains_any(ctx.command, &["list", "ls", "tree"])
		},
		// Default tabular `pip list` / `pip list --outdated` are inventory dumps
		// like `uv pip list`; give them the same tree/list compaction. `--json`
		// already passes through earlier in filter(), so only text output lands.
		// `pip3` is not normalized to `pip`, so claim both spellings.
		"pip" | "pip3" => matches!(ctx.subcommand, Some("list")),
		"poetry" => {
			matches!(ctx.subcommand, Some("tree"))
				|| matches!(ctx.subcommand, Some("show"))
					&& command_contains_any(ctx.command, &["--tree"])
		},
		_ => false,
	}
}

fn is_package_export_command(ctx: &MinimizerCtx<'_>) -> bool {
	match ctx.program {
		"uv" | "poetry" => ctx.subcommand == Some("export"),
		_ => false,
	}
}

fn is_package_lock_command(ctx: &MinimizerCtx<'_>) -> bool {
	matches!((ctx.program, ctx.subcommand), ("uv" | "poetry", Some("lock")))
}

fn command_contains_any(command: &str, words: &[&str]) -> bool {
	command.split_whitespace().any(|part| words.contains(&part))
}

fn compact_package_tree_output(input: &str) -> String {
	if let Some(summary) = compact_package_tree_json_output(input) {
		return summary;
	}
	if let Some(summary) = compact_package_tree_ndjson_output(input) {
		return summary;
	}
	let lines: Vec<&str> = input
		.lines()
		.map(str::trim_end)
		.filter(|line| !line.trim().is_empty())
		.collect();
	if lines.len() <= PACKAGE_TREE_HEAD_LINES {
		return input.to_string();
	}

	let mut out = format!("package tree/list: {} entries\n", lines.len());
	for line in lines.iter().take(PACKAGE_TREE_HEAD_LINES) {
		out.push_str(line);
		out.push('\n');
	}
	let _ = writeln!(out, "[…{} package entries elided…]", lines.len() - PACKAGE_TREE_HEAD_LINES);
	out
}

fn compact_package_tree_json_output(input: &str) -> Option<String> {
	let value: serde_json::Value = serde_json::from_str(input).ok()?;
	let mut rows = Vec::new();
	let mut seen = HashSet::new();
	collect_package_tree_json_rows(&value, &mut rows, &mut seen);
	summarize_package_rows(rows)
}

fn compact_package_tree_ndjson_output(input: &str) -> Option<String> {
	let mut rows = Vec::new();
	let mut seen = HashSet::new();
	for line in input.lines().map(str::trim).filter(|line| !line.is_empty()) {
		let value: serde_json::Value = serde_json::from_str(line).ok()?;
		collect_package_tree_json_rows(&value, &mut rows, &mut seen);
		if let Some(data) = value.get("data").and_then(serde_json::Value::as_str) {
			for row in data
				.lines()
				.map(str::trim_end)
				.filter(|row| !row.trim().is_empty())
			{
				push_unique_row(&mut rows, &mut seen, row.to_string());
			}
		}
	}
	summarize_package_rows(rows)
}

fn summarize_package_rows(rows: Vec<String>) -> Option<String> {
	if rows.is_empty() {
		return None;
	}
	let mut out = format!("package tree/list: {} entries\n", rows.len());
	for row in rows.iter().take(PACKAGE_TREE_HEAD_LINES) {
		out.push_str(row);
		out.push('\n');
	}
	if rows.len() > PACKAGE_TREE_HEAD_LINES {
		let _ = writeln!(out, "[…{} package entries elided…]", rows.len() - PACKAGE_TREE_HEAD_LINES);
	}
	Some(out)
}

fn collect_package_tree_json_rows(
	value: &serde_json::Value,
	rows: &mut Vec<String>,
	seen: &mut HashSet<String>,
) {
	match value {
		serde_json::Value::Object(map) => {
			if let Some(name) = map.get("name").and_then(serde_json::Value::as_str) {
				let version = map
					.get("version")
					.and_then(serde_json::Value::as_str)
					.unwrap_or("");
				push_unique_row(
					rows,
					seen,
					if version.is_empty() {
						name.to_string()
					} else {
						format!("{name} {version}")
					},
				);
			}
			if let Some(dependencies) = map
				.get("dependencies")
				.and_then(serde_json::Value::as_object)
			{
				for (name, child) in dependencies {
					push_json_dependency_row(rows, seen, name, child);
				}
			}
			for value in map.values() {
				if value.is_array() || value.is_object() {
					collect_package_tree_json_rows(value, rows, seen);
				}
			}
		},
		serde_json::Value::Array(items) => {
			for item in items {
				collect_package_tree_json_rows(item, rows, seen);
			}
		},
		_ => {},
	}
}

fn push_json_dependency_row(
	rows: &mut Vec<String>,
	seen: &mut HashSet<String>,
	name: &str,
	child: &serde_json::Value,
) {
	let version = child
		.get("version")
		.and_then(serde_json::Value::as_str)
		.unwrap_or("");
	push_unique_row(
		rows,
		seen,
		if version.is_empty() {
			name.to_string()
		} else {
			format!("{name} {version}")
		},
	);
}

fn push_unique_row(rows: &mut Vec<String>, seen: &mut HashSet<String>, row: String) {
	if seen.insert(row.clone()) {
		rows.push(row);
	}
}

fn is_noise_line(ctx: &MinimizerCtx<'_>, line: &str, exit_code: i32) -> bool {
	let lower = line.to_ascii_lowercase();

	// Strip: "found 0 vulnerabilities" (non-actionable success noise)
	if lower.contains("found 0 vulnerabilities") {
		return true;
	}
	// Strip: npm funding nags ("N packages are looking for funding" / "run `npm
	// fund` for details"). snip drops both; removing 'funding' from
	// is_audit_or_security_summary keeps real audit findings protected.
	if lower.contains("looking for funding") || lower.contains("npm fund") {
		return true;
	}
	// Strip: "audited X packages" timing summaries (non-actionable). This global
	// rule still governs npm/brew/composer. uv sync/add/remove never reach here
	// for an 'Audited' no-op — success_up_to_date_short_circuit() in filter()
	// consumes that line into 'ok (up to date)' on the raw output first.
	if lower.contains("audited") && lower.contains("package") {
		return true;
	}
	// Keep: vulnerability mentions (actionable — real findings)
	if lower.contains("vulnerab") {
		return false;
	}
	if exit_code != 0 && is_error_or_summary(line) {
		return false;
	}

	if is_package_lock_command(ctx) && is_lock_summary_line(&lower) {
		return false;
	}
	is_generic_progress(line, &lower)
		|| is_js_package_noise(ctx.program, line, &lower)
		|| is_python_package_noise(ctx, line, &lower)
		|| is_ruby_php_brew_noise(ctx.program, line, &lower)
}

fn compact_package_lock_output(ctx: &MinimizerCtx<'_>, input: &str) -> String {
	let mut out = String::new();
	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() {
			continue;
		}
		let lower = trimmed.to_ascii_lowercase();
		if is_lock_summary_line(&lower) {
			out.push_str(trimmed);
			out.push('\n');
			continue;
		}
		if is_generic_progress(trimmed, &lower)
			|| is_python_package_noise(ctx, trimmed, &lower)
			|| is_js_package_noise(ctx.program, trimmed, &lower)
		{
			continue;
		}
		out.push_str(trimmed);
		out.push('\n');
	}
	if out.trim().is_empty() {
		primitives::head_tail_cap(input, primitives::CapClass::Inventory)
	} else {
		primitives::head_tail_cap(&out, primitives::CapClass::Inventory)
	}
}

fn is_lock_summary_line(lower: &str) -> bool {
	lower.starts_with("writing lock file")
		|| lower.starts_with("updated lockfile")
		|| lower.starts_with("resolved ")
		|| lower.starts_with("installing dependencies from lock file")
		|| lower == "no changes."
		|| lower.starts_with("no dependencies to install or update")
}

fn is_generic_progress(line: &str, lower: &str) -> bool {
	line.starts_with("Progress:")
		|| line.starts_with("Resolving:")
		|| line.starts_with("Downloading:")
		|| line.starts_with("Downloaded")
		|| lower.starts_with("resolving dependencies")
		|| lower.starts_with("installing dependencies")
		|| lower.starts_with("fetching packages")
		|| lower.contains("spinner")
		|| line
			.chars()
			.all(|ch| matches!(ch, '⠁' | '⠂' | '⠄' | '⡀' | '⢀' | '⠠' | '⠐' | '⠈' | ' '))
}

fn is_js_program(program: &str) -> bool {
	matches!(program, "npm" | "pnpm" | "yarn" | "bun")
}

/// JS package-manager success-summary lines worth keeping exactly once. snip
/// retains these so the count confirms `lockfile/node_modules` state. Callers
/// must gate on `is_js_program` first.
fn is_js_install_summary(lower: &str) -> bool {
	lower.starts_with("added ") && lower.contains("package")
		|| lower.starts_with("removed ") && lower.contains("package")
		|| lower.starts_with("changed ") && lower.contains("package")
		|| lower.starts_with("up to date")
		|| lower.contains("already up-to-date")
		|| lower.starts_with("done in ")
		|| lower.starts_with("packages:")
		|| lower.starts_with("dependencies:")
}

/// Classic yarn step markers: `[N/4] Resolving|Fetching|Linking|Building …`.
fn is_yarn_step_marker(line: &str) -> bool {
	let Some(rest) = line.strip_prefix('[') else {
		return false;
	};
	let Some((counter, tail)) = rest.split_once(']') else {
		return false;
	};
	let Some((num, denom)) = counter.split_once('/') else {
		return false;
	};
	if num.is_empty()
		|| denom.is_empty()
		|| !num.bytes().all(|b| b.is_ascii_digit())
		|| !denom.bytes().all(|b| b.is_ascii_digit())
	{
		return false;
	}
	let step = tail.trim_start();
	step.starts_with("Resolving")
		|| step.starts_with("Fetching")
		|| step.starts_with("Linking")
		|| step.starts_with("Building")
}

fn is_js_package_noise(program: &str, line: &str, lower: &str) -> bool {
	if !is_js_program(program) {
		return false;
	}
	line.starts_with('>') && line.contains('@')
		|| lower.starts_with("npm notice")
		|| lower.starts_with("npm http fetch")
		|| lower.starts_with("pnpm: progress")
		// pnpm progress bars are runs of plus signs; anchor on 3+ so a bare '+'
		// diff line (a real change) still passes through.
		|| line.starts_with("+++")
		// yarn classic step markers and berry's structural YN0000 info lines
		// (box-drawing, section headers). Actionable codes (YN0002 peer warnings,
		// YN0060 incompatibilities) carry other YNxxxx codes and are kept.
		|| is_yarn_step_marker(line)
		|| lower.contains("yn0000")
		|| lower.starts_with("packages:")
		|| lower.starts_with("resolved ")
		|| lower.starts_with("reused ")
		|| lower.starts_with("added ") && lower.contains("packages")
		|| lower.starts_with("done in ")
		|| lower.contains("already up-to-date")
		|| lower.contains("up to date")
}

fn is_python_package_noise(ctx: &MinimizerCtx<'_>, _line: &str, lower: &str) -> bool {
	let program = ctx.program;
	if !matches!(program, "pip" | "pip3" | "uv" | "poetry") {
		return false;
	}
	lower.starts_with("collecting ")
		|| lower.starts_with("using cached ")
		|| lower.starts_with("downloading ")
		|| lower.starts_with("preparing metadata")
		|| lower.starts_with("installing build dependencies")
		|| lower.starts_with("resolving dependencies")
		|| lower.starts_with("writing lock file")
		|| lower.starts_with("package operations:")
		// pip prints an upgrade nag as '[notice] A new release of pip is
		// available' plus a '[notice] To update, run: …' follow-up — non-actionable
		// for the wrapped command. Scoped to pip/uv/poetry by the gate above.
		|| lower.starts_with("[notice]")
		|| program == "uv" && is_uv_progress_noise(lower, uv_keeps_install_summary(ctx))
		|| program == "poetry" && is_poetry_bullet_progress(lower)
}

/// poetry prefixes per-package progress with a `- ` or `• ` bullet, e.g.
/// `  - Downloading requests-2.31.0…` / `  • Installing certifi (2023.11.17)`,
/// plus virtualenv-setup chatter. These are the `strip_lines` that previously
/// lived in defs/poetry-install.toml; the bullet prefix means the bare
/// `downloading `/`installing ` checks above never reached them. `lower` is the
/// already-trimmed, lowercased line.
fn is_poetry_bullet_progress(lower: &str) -> bool {
	let bullet = lower
		.strip_prefix("- ")
		.or_else(|| lower.strip_prefix("• "));
	if let Some(rest) = bullet
		&& (rest.starts_with("downloading ") || rest.starts_with("installing ") && rest.contains('('))
	{
		return true;
	}
	lower.starts_with("creating virtualenv") || lower.starts_with("using virtualenv")
}

/// uv sync/add/remove keep the one-line 'Installed/Uninstalled N packages in
/// Xms' summary alongside the +/- delta rows (the count is the install signal).
/// uv lock/tree and every other subcommand still strip those rows as progress.
fn uv_keeps_install_summary(ctx: &MinimizerCtx<'_>) -> bool {
	ctx.program == "uv" && matches!(ctx.subcommand, Some("sync" | "add" | "remove"))
}

fn is_uv_progress_noise(lower: &str, keep_install_summary: bool) -> bool {
	if keep_install_summary && (lower.starts_with("installed ") || lower.starts_with("uninstalled "))
	{
		return false;
	}
	lower.starts_with("resolved ")
		|| lower.starts_with("prepared ")
		|| lower.starts_with("installed ")
		|| lower.starts_with("uninstalled ")
		|| lower.starts_with("updated ")
		|| lower.starts_with("built ")
		|| lower.starts_with("downloaded ")
}

fn is_ruby_php_brew_noise(program: &str, _line: &str, lower: &str) -> bool {
	if !matches!(program, "bundle" | "brew" | "composer") {
		return false;
	}
	if program == "bundle" {
		// Keep 'Bundle complete! … N gems now installed' / 'Bundle updated!' — the
		// one-line gem-count signal (replaces the defs/bundle-install.toml
		// short-circuit). Strip the 'Use `bundle info [gemname]`…' follow-up hint.
		// Using/Fetching/Installing rows are still per-gem progress noise.
		if lower.starts_with("bundle complete") || lower.starts_with("bundle updated") {
			return false;
		}
		if lower.starts_with("use `bundle info") {
			return true;
		}
	}
	lower.starts_with("fetching ")
		|| lower.starts_with("installing ") && !lower.contains("error")
		|| lower.starts_with("using ")
		// brew/composer never emit 'Bundle complete'; this strip is preserved for
		// them but bundle now keeps the line (handled above).
		|| lower.starts_with("bundle complete")
		|| lower.starts_with("==> downloading")
		|| lower.starts_with("==> pouring")
		|| lower.starts_with("loading composer repositories")
		|| lower.starts_with("generating autoload files")
}

fn contains_audit_or_security_summary(input: &str) -> bool {
	input.lines().any(is_audit_or_security_summary)
}

fn is_audit_or_security_summary(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	// 'funding' deliberately excluded: funding nags are stripped as noise and
	// must NOT bypass head_tail_cap. Real audit findings ('audit'/'vulnerab'/
	// 'security') still trip the bypass.
	lower.contains("audit")
		|| lower.contains("audited")
		|| lower.contains("vulnerab")
		|| lower.contains("security")
}

fn is_error_or_summary(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.contains("error")
		|| lower.contains("failed")
		|| lower.contains("warning")
		|| lower.contains("vulnerab")
		|| lower.contains("audited")
		|| lower.contains("found ")
		|| lower.contains("success")
		|| lower.contains("complete")
}
