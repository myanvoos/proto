//! Ruby test and lint output filters.

use super::lint;
use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

#[must_use]
pub fn supports(program: &str, subcommand: Option<&str>) -> bool {
	match program {
		"rspec" | "rubocop" => true,
		"rake" | "rails" => !is_def_scoped_subcommand(subcommand),
		_ => false,
	}
}

/// Subcommands that have dedicated TOML defs and must run standalone instead
/// of being claimed by the generic ruby filter (which would overlay them).
fn is_def_scoped_subcommand(subcommand: Option<&str>) -> bool {
	matches!(subcommand, Some("db:migrate" | "db:rollback" | "routes"))
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let text = match ruby_tool(ctx.program, ctx.subcommand) {
		Some("rspec") => filter_rspec(&cleaned, exit_code),
		Some("minitest") => filter_minitest(&cleaned, exit_code),
		Some("rubocop") => filter_rubocop(&cleaned, exit_code),
		Some("rake") => filter_rake(&cleaned, exit_code),
		_ => cleaned,
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn ruby_tool<'a>(program: &'a str, subcommand: Option<&'a str>) -> Option<&'a str> {
	match (program, subcommand) {
		("rspec", _) => Some("rspec"),
		("rubocop", _) => Some("rubocop"),
		("rake" | "rails", Some(sub)) if is_minitest_subcommand(sub) => Some("minitest"),
		("rake" | "rails", Some(sub)) if is_def_scoped_subcommand(Some(sub)) => None,
		("rake" | "rails", _) => Some("rake"),
		_ => None,
	}
}

/// A rake/rails subcommand that runs minitest: the bare `test` task, a scoped
/// `test:<scope>` task (`test:models`, `test:system`, `test:all`), or a
/// namespaced `<ns>:test` task (`app:test`).
fn is_minitest_subcommand(sub: &str) -> bool {
	sub == "test" || sub.starts_with("test:") || sub.ends_with(":test")
}

fn filter_rspec(input: &str, exit_code: i32) -> String {
	if let Some(text) = compact_rspec_json(input) {
		return text;
	}

	// Strip rtk noise (Spring preloader, SimpleCov coverage block, DEPRECATION
	// warnings, `Finished in …` timing, Capybara screenshot detail) before both
	// the success and failure text paths. Ported from
	// rtk/src/cmds/ruby/rspec_cmd.rs::strip_noise, re-derived against the
	// minimizer's DEFAULT (non-JSON) output.
	let stripped = strip_rspec_noise(input);

	if exit_code == 0 {
		// snip behavior: on success collapse the doc-format tree to the
		// `N examples, 0 failures` summary (plus any pending lines), discarding
		// the per-example descriptions.
		return rspec_success_summary(&stripped);
	}

	let mut out = String::new();
	// Each rendered failure block is buffered separately so the total can be
	// capped at MAX_RENDERED_FAILURES with a `[…N failures elided…]` marker. The
	// buffered blocks are rendered into `out` the moment the `Failures:` section
	// ends — at the summary line or the `Failed examples:` boundary — so real
	// rspec ordering (`Failures:` details, then summary, then `Failed examples:`)
	// keeps each detail block under its own `Failures:` header instead of being
	// appended after the `Failed examples:` list.
	let mut blocks: Vec<String> = Vec::new();
	let mut current = String::new();
	let mut rendered_blocks = false;
	let mut in_failure = false;
	let mut in_failed_examples = false;

	for line in stripped.lines() {
		let trimmed = line.trim();
		if trimmed == "Failures:" {
			in_failure = true;
			in_failed_examples = false;
			push_line(&mut out, line);
			continue;
		}
		if trimmed == "Failed examples:" {
			flush_rspec_block(&mut blocks, &mut current);
			render_rspec_blocks(&mut out, &mut blocks, &mut rendered_blocks);
			in_failure = false;
			in_failed_examples = true;
			push_line(&mut out, line);
			continue;
		}
		if is_rspec_summary_line(trimmed) {
			flush_rspec_block(&mut blocks, &mut current);
			render_rspec_blocks(&mut out, &mut blocks, &mut rendered_blocks);
			in_failure = false;
			in_failed_examples = false;
			push_line(&mut out, line);
			continue;
		}
		if in_failure {
			if is_gem_backtrace(trimmed) || is_rspec_noise(trimmed) {
				continue;
			}
			if is_numbered_failure(trimmed) {
				flush_rspec_block(&mut blocks, &mut current);
			}
			current.push_str(line);
			current.push('\n');
			continue;
		}
		if in_failed_examples && !trimmed.is_empty() {
			push_line(&mut out, line);
		}
	}
	// Any failure blocks not yet rendered (no summary / `Failed examples:`
	// boundary was seen) are flushed at the end.
	flush_rspec_block(&mut blocks, &mut current);
	render_rspec_blocks(&mut out, &mut blocks, &mut rendered_blocks);

	if has_content(&out) {
		out
	} else {
		primitives::head_tail_lines(input, 80, 80)
	}
}

/// Render the buffered `Failures:` detail blocks into `out`, capped at
/// `MAX_RENDERED_FAILURES` with a `[…N failures elided…]` marker. Runs at most
/// once — guarded by `rendered` — so the section is emitted exactly where the
/// `Failures:` block ends (the summary line or `Failed examples:` boundary),
/// preserving real rspec section ordering.
fn render_rspec_blocks(out: &mut String, blocks: &mut Vec<String>, rendered: &mut bool) {
	if *rendered {
		blocks.clear();
		return;
	}
	let total = blocks.len();
	if total == 0 {
		return;
	}
	*rendered = true;
	for block in blocks.iter().take(MAX_RENDERED_FAILURES) {
		out.push_str(block);
	}
	if total > MAX_RENDERED_FAILURES {
		push_line(out, &format!("[…{} failures elided…]", total - MAX_RENDERED_FAILURES));
	}
	blocks.clear();
}

/// Cap on rendered failure blocks in non-JSON rspec output. rtk uses the same
/// limit (`MAX_RSPEC_FAILURES = 5`) — failure blocks carry full context, so a
/// handful is enough before collapsing to a `[…N failures elided…]` marker.
const MAX_RENDERED_FAILURES: usize = 5;

fn flush_rspec_block(blocks: &mut Vec<String>, current: &mut String) {
	if has_content(current) {
		blocks.push(std::mem::take(current));
	} else {
		current.clear();
	}
}

/// A numbered failure header like `1) User validates name`.
fn is_numbered_failure(trimmed: &str) -> bool {
	let Some(pos) = trimmed.find(')') else {
		return false;
	};
	let prefix = &trimmed[..pos];
	!prefix.is_empty() && prefix.chars().all(|ch| ch.is_ascii_digit())
}

/// Drop rtk-style rspec noise before the text paths. Mirrors
/// `rtk/src/cmds/ruby/rspec_cmd.rs::strip_noise`: Spring preloader, `SimpleCov`
/// coverage block (until the next blank line), `DEPRECATION WARNING:` lines,
/// the `Finished in …` timing line, and Capybara screenshot detail (kept as a
/// compact `[screenshot: path]`).
fn strip_rspec_noise(input: &str) -> String {
	let mut out = String::new();
	let mut in_simplecov = false;
	// The SimpleCov / coverage block only ever appears in the TRAILING region
	// (after the run completes), never inside a numbered `Failures:` block. The
	// donor's patterns (`simplecov`, `coverage/`, `.simplecov`) are unscoped
	// substring/prefix tests, so a failure whose description or assertion path
	// mentions SimpleCov coverage (e.g. `1) SimpleCov configuration loads`, or an
	// assertion about a `coverage/index.html` artifact) would falsely enter the
	// strip and swallow the entire failure block up to the next blank line. Gate
	// the strip to OUTSIDE the `Failures:` section so failure diagnostics survive.
	let mut in_failures = false;

	for line in input.lines() {
		let trimmed = line.trim();
		let lower = trimmed.to_ascii_lowercase();

		if trimmed == "Failures:" {
			in_failures = true;
		} else if trimmed == "Failed examples:"
			|| is_rspec_summary_line(trimmed)
			|| trimmed.starts_with("Finished in ")
		{
			// rspec always prints the `Finished in …` timing line AFTER the failure
			// details and BEFORE the trailing coverage block, so it reliably closes
			// the `Failures:` region even when the summary line trails the coverage
			// block (SimpleCov prints between timing and summary).
			in_failures = false;
		}

		if lower.contains("running via spring preloader") {
			continue;
		}
		if trimmed.starts_with("DEPRECATION WARNING:") {
			continue;
		}
		if trimmed.starts_with("Finished in ") {
			continue;
		}
		// Only strip the SimpleCov/coverage block when NOT inside a `Failures:`
		// section. The `coverage report` banner is anchored to its actual shape
		// (`Coverage report generated …`) rather than a bare `coverage/` prefix, so
		// a failure-detail line asserting on a `coverage/`-prefixed artifact path is
		// not mistaken for the banner.
		if !in_failures
			&& (is_coverage_banner(&lower)
				|| lower.contains("simplecov")
				|| lower.contains(".simplecov"))
		{
			in_simplecov = true;
			continue;
		}
		if in_simplecov {
			if trimmed.is_empty() {
				in_simplecov = false;
			}
			continue;
		}
		if let Some(rest) = trimmed.strip_prefix("saved screenshot to ") {
			push_line(&mut out, &format!("[screenshot: {}]", rest.trim()));
			continue;
		}

		push_line(&mut out, line);
	}

	out
}

/// The `SimpleCov` coverage-report banner that opens the trailing coverage
/// block, e.g. `Coverage report generated for RSpec to /app/coverage`. Anchored
/// to the banner shape so a failure-detail line merely mentioning a `coverage/`
/// path is not misread as the banner.
fn is_coverage_banner(lower: &str) -> bool {
	lower.starts_with("coverage report")
}

/// On a passing rspec run, keep only the `N examples, …` summary line plus any
/// pending lines; discard the doc-format example tree (snip behavior).
fn rspec_success_summary(input: &str) -> String {
	let mut out = String::new();
	for line in input.lines() {
		let trimmed = line.trim();
		if is_rspec_summary_line(trimmed) || trimmed.starts_with("Pending") {
			push_line(&mut out, line);
		}
	}
	if has_content(&out) {
		out
	} else {
		ruby_test_success(input)
	}
}

fn compact_rspec_json(input: &str) -> Option<String> {
	let value: serde_json::Value = serde_json::from_str(input).ok()?;
	let map = value.as_object()?;
	let mut out = String::new();

	if let Some(summary_line) = first_json_string(map, &["summary_line"]) {
		push_line(&mut out, summary_line);
	} else if let Some(summary) = map.get("summary").and_then(|value| value.as_object()) {
		push_line(&mut out, &rspec_summary_from_json(summary));
	}

	if let Some(examples) = map.get("examples").and_then(|value| value.as_array()) {
		for example in examples {
			let Some(example_map) = example.as_object() else {
				continue;
			};
			let status = first_json_string(example_map, &["status"]);
			if status == Some("failed") {
				push_rspec_json_example(&mut out, "FAILED", example_map);
			} else if status == Some("pending") {
				push_rspec_json_example(&mut out, "PENDING", example_map);
			}
		}
	}

	if let Some(errors) = map
		.get("errors_outside_of_examples")
		.and_then(|value| value.as_array())
	{
		for error in errors {
			if let Some(error_map) = error.as_object() {
				push_rspec_json_error(&mut out, error_map);
			}
		}
	}

	if has_content(&out) { Some(out) } else { None }
}

fn rspec_summary_from_json(map: &serde_json::Map<String, serde_json::Value>) -> String {
	let examples = first_json_u64(map, &["example_count"]);
	let failures = first_json_u64(map, &["failure_count"]);
	let pending = first_json_u64(map, &["pending_count"]);
	let errors = first_json_u64(map, &["errors_outside_of_examples_count"]);

	let mut parts = Vec::new();
	if let Some(examples) = examples {
		parts.push(format!("{examples} examples"));
	}
	if let Some(failures) = failures {
		parts.push(format!("{failures} failures"));
	}
	if let Some(pending) = pending {
		parts.push(format!("{pending} pending"));
	}
	if let Some(errors) = errors {
		parts.push(format!("{errors} errors outside examples"));
	}

	if parts.is_empty() {
		"RSpec JSON summary".to_string()
	} else {
		parts.join(", ")
	}
}

fn push_rspec_json_example(
	out: &mut String,
	label: &str,
	map: &serde_json::Map<String, serde_json::Value>,
) {
	let description = first_json_string(map, &["full_description", "description", "id"])
		.unwrap_or("<unknown example>");
	push_line(out, &format!("{label}: {description}"));
	push_json_location(out, map);

	if let Some(exception) = map.get("exception").and_then(|value| value.as_object()) {
		push_json_exception(out, exception);
	}
	if let Some(message) = first_json_string(map, &["pending_message", "message"]) {
		push_line(out, message);
	}
}

fn push_rspec_json_error(out: &mut String, map: &serde_json::Map<String, serde_json::Value>) {
	push_line(out, "ERROR outside examples");
	push_json_exception(out, map);
}

fn push_json_location(out: &mut String, map: &serde_json::Map<String, serde_json::Value>) {
	if let Some(path) = first_json_string(map, &["file_path", "file", "path"]) {
		let mut location = path.to_string();
		if let Some(line) = first_json_u64(map, &["line_number", "line"]) {
			location.push(':');
			location.push_str(&line.to_string());
		}
		push_line(out, &location);
	}
}

fn push_json_exception(out: &mut String, map: &serde_json::Map<String, serde_json::Value>) {
	if let Some(class_name) = first_json_string(map, &["class", "class_name", "type"]) {
		push_line(out, class_name);
	}
	if let Some(message) = first_json_string(map, &["message", "description"]) {
		push_line(out, message);
	}
	if let Some(backtrace) = map.get("backtrace").and_then(|value| value.as_array()) {
		for frame in backtrace {
			if let Some(frame) = frame.as_str()
				&& !is_gem_backtrace(frame)
			{
				push_line(out, frame);
				break;
			}
		}
	}
}

fn first_json_string<'a>(
	map: &'a serde_json::Map<String, serde_json::Value>,
	keys: &[&str],
) -> Option<&'a str> {
	keys
		.iter()
		.find_map(|key| map.get(*key).and_then(|value| value.as_str()))
}

fn first_json_u64(map: &serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> Option<u64> {
	keys
		.iter()
		.find_map(|key| map.get(*key).and_then(serde_json::Value::as_u64))
}

fn filter_minitest(input: &str, exit_code: i32) -> String {
	if exit_code == 0 {
		return ruby_test_success(input);
	}

	let mut out = String::new();
	let mut in_failure = false;

	for line in input.lines() {
		let trimmed = line.trim();
		if starts_minitest_failure(trimmed) {
			in_failure = true;
			push_line(&mut out, line);
			continue;
		}
		if is_minitest_summary_line(trimmed) {
			in_failure = false;
			push_line(&mut out, line);
			continue;
		}
		if in_failure {
			if trimmed.starts_with("Finished in ") {
				in_failure = false;
				continue;
			}
			if !trimmed.is_empty() {
				push_line(&mut out, line);
			}
		}
	}

	if has_content(&out) {
		out
	} else {
		primitives::head_tail_lines(input, 80, 80)
	}
}

/// `RuboCop` output: keep lint's grouped offense rendering as primary, but
/// compact the `-a`/`-A` autocorrect run-summary line
/// (`N files inspected, M offenses detected, K offenses autocorrected`) — which
/// the grouped output otherwise keeps verbatim and buried — to a single `ok`
/// line. Ported from `rtk/src/cmds/ruby/rubocop_cmd.rs` autocorrect handling,
/// re-derived against the minimizer's DEFAULT text output.
fn filter_rubocop(input: &str, exit_code: i32) -> String {
	let condensed = lint::condense_lint_output("rubocop", input, exit_code);

	let mut out = String::new();
	let mut replaced = false;
	for line in condensed.lines() {
		let trimmed = line.trim();
		if !replaced
			&& trimmed.contains("inspected")
			&& trimmed.contains("autocorrected")
			&& let Some(compact) = compact_rubocop_autocorrect(trimmed)
		{
			push_line(&mut out, &compact);
			replaced = true;
			continue;
		}
		push_line(&mut out, line);
	}

	if replaced { out } else { condensed }
}

/// Build `ok rubocop -A (N files, K autocorrected)` from an autocorrect summary
/// line. Returns `None` when the counts cannot be parsed (keep the line as-is).
fn compact_rubocop_autocorrect(line: &str) -> Option<String> {
	let files = leading_number(line)?;
	let corrected = line
		.split(',')
		.rev()
		.find(|part| part.contains("autocorrected"))
		.and_then(leading_number)?;
	Some(format!("ok rubocop -A ({files} files, {corrected} autocorrected)"))
}

/// First whitespace-delimited token of `s` parsed as a count.
fn leading_number(s: &str) -> Option<usize> {
	s.split_whitespace().next()?.parse().ok()
}

/// Generic rake/rails task condenser for NON-test tasks. Keeps result/status
/// lines (mirrors snip's rake keep-lines pattern) plus the HEAD of a
/// `rake aborted!` traceback (the first few frames, which carry the real
/// cause). `rake test` / `rails test` never reach here — they route to
/// `filter_minitest`.
fn filter_rake(input: &str, exit_code: i32) -> String {
	// On a FAILING non-test task that prints no `rake aborted!` header, the
	// keep-lines pass below would retain only individually keyword-matching lines
	// and silently drop the keyword-less diagnostic body (offending records,
	// `Expected positive integer, got -3`-style value detail) — exactly the
	// failure-detail the task warns must survive. The head/tail safety net only
	// fires when `out` is empty, which a single keyword line defeats. So when the
	// task failed and produced no `rake aborted!` traceback, preserve the full
	// diagnostic via head/tail rather than the lossy keep-lines pass.
	if exit_code != 0 && !input.lines().any(|line| line.trim() == "rake aborted!") {
		return primitives::head_tail_lines(input, 80, 80);
	}

	let mut out = String::new();
	let mut aborted_frames = 0usize;
	let mut in_aborted = false;

	for line in input.lines() {
		let trimmed = line.trim();

		if trimmed == "rake aborted!" {
			in_aborted = true;
			aborted_frames = 0;
			push_line(&mut out, line);
			continue;
		}
		if in_aborted {
			// Keep the head of the traceback — the first few frames pinpoint the
			// cause — then drop the long tail.
			if aborted_frames < MAX_ABORTED_FRAMES {
				push_line(&mut out, line);
				aborted_frames += 1;
				continue;
			}
			// A blank line ends the traceback block; resume normal keep-lines.
			if trimmed.is_empty() {
				in_aborted = false;
			}
			continue;
		}

		if is_rake_keep_line(trimmed) {
			push_line(&mut out, line);
		}
	}

	if has_content(&out) {
		out
	} else {
		primitives::head_tail_lines(input, 80, 80)
	}
}

/// Number of `rake aborted!` traceback frames kept (HEAD): enough to localize
/// the failure without dumping the full Rake/Ruby internal stack.
const MAX_ABORTED_FRAMES: usize = 5;

/// snip rake.yaml keep-lines pattern, re-derived: task result / status / error
/// keywords worth surfacing from a non-test rake task.
fn is_rake_keep_line(trimmed: &str) -> bool {
	if trimmed.is_empty() {
		return false;
	}
	// rake aborted! always surfaces
	if trimmed.contains("rake aborted") {
		return true;
	}
	// warning: lines from asset compilation, migrations, etc. are signal
	if trimmed.to_ascii_lowercase().starts_with("warning:") {
		return true;
	}
	let lower = trimmed.to_ascii_lowercase();
	let words: Vec<&str> = lower.split_whitespace().collect();
	words.iter().any(|w| {
		matches!(
			*w,
			"passed"
				| "failed"
				| "error"
				| "fail" | "ok"
				| "finished"
				| "assertion"
				| "test" | "failure"
		)
	})
}

fn ruby_test_success(input: &str) -> String {
	let mut out = String::new();
	let mut summary = String::new();

	for line in input.lines() {
		let trimmed = line.trim();
		if is_rspec_summary_line(trimmed) || is_minitest_summary_line(trimmed) {
			push_line(&mut summary, line);
			push_line(&mut out, line);
			continue;
		}
		if is_ruby_pass_noise(trimmed) {
			continue;
		}
		push_line(&mut out, line);
	}

	if has_content(&out) { out } else { summary }
}

fn starts_minitest_failure(trimmed: &str) -> bool {
	let mut parts = trimmed.split_whitespace();
	let Some(number) = parts.next() else {
		return false;
	};
	let Some(kind) = parts.next() else {
		return false;
	};
	number.ends_with(')') && matches!(kind, "Failure:" | "Error:")
}

fn is_rspec_summary_line(trimmed: &str) -> bool {
	trimmed.contains(" examples, ") && (trimmed.contains(" failure") || trimmed.contains(" pending"))
}

fn is_minitest_summary_line(trimmed: &str) -> bool {
	// Minitest prints `N runs, …`; minitest-reporters prints `N tests, …`.
	// Accept either head form.
	(trimmed.contains(" runs, ") || trimmed.contains(" tests, "))
		&& trimmed.contains(" assertions, ")
		&& trimmed.contains(" failures, ")
		&& trimmed.contains(" errors")
}

fn is_ruby_pass_noise(trimmed: &str) -> bool {
	trimmed.is_empty()
		|| trimmed == "."
		|| trimmed
			.chars()
			.all(|ch| matches!(ch, '.' | 'S' | 'F' | 'E'))
		|| trimmed.starts_with("Run options:")
		|| trimmed.starts_with("Running:")
		|| trimmed.starts_with("Randomized with seed")
		|| trimmed.starts_with("Finished in ")
		// minitest-reporters banner / progress lines.
		|| trimmed.starts_with("Started with run options")
		|| trimmed.starts_with("Progress:")
}

fn is_rspec_noise(trimmed: &str) -> bool {
	trimmed.starts_with("# ") && is_gem_backtrace(trimmed)
}

fn is_gem_backtrace(trimmed: &str) -> bool {
	trimmed.contains("/gems/")
		|| trimmed.contains("lib/rspec")
		|| trimmed.contains("lib/ruby/")
		|| trimmed.contains("vendor/bundle")
}

fn push_line(out: &mut String, line: &str) {
	out.push_str(line);
	out.push('\n');
}

fn has_content(text: &str) -> bool {
	text.lines().any(|line| !line.trim().is_empty())
}
