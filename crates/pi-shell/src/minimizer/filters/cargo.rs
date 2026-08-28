//! Cargo build/test output filters.

use std::{collections::BTreeMap, fmt::Write as _};

use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

#[must_use]
pub fn supports(subcommand: Option<&str>) -> bool {
	matches!(
		subcommand,
		Some(
			"build"
				| "check"
				| "test" | "clippy"
				| "nextest"
				| "fmt" | "doc"
				| "bench"
				| "run" | "metadata"
				| "tree" | "update"
				| "install"
				| "publish"
		)
	)
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let text = match ctx.subcommand {
		Some("metadata") => input.to_string(),
		Some("test" | "bench") => failures_only(&cleaned, exit_code),
		Some("nextest") => filter_nextest(&cleaned),
		Some("clippy") => filter_clippy(&cleaned, exit_code),
		Some("build" | "check" | "doc" | "run") => condense_build(&cleaned),
		Some("fmt") => condense_fmt(&cleaned),
		Some("install") => filter_install(&cleaned, exit_code),
		Some("tree" | "update" | "publish") => compact_general(&cleaned),
		_ => cleaned,
	};
	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn condense_build(input: &str) -> String {
	let stripped = primitives::strip_lines(input, &[is_compiling_noise]);
	let grouped = primitives::group_by_file(&stripped, 20);
	let deduped = primitives::dedup_consecutive_lines(&grouped);
	primitives::head_tail_lines(&deduped, 120, 60)
}

fn is_compiling_noise(line: &str) -> bool {
	let trimmed = line.trim_start();
	trimmed.starts_with("Compiling ")
		|| trimmed.starts_with("Checking ")
		|| trimmed.starts_with("Fresh ")
		|| trimmed.starts_with("Finished ")
		|| trimmed.starts_with("Documenting ")
		|| trimmed.starts_with("Running ")
		|| trimmed.starts_with("Downloading ")
		|| trimmed.starts_with("Downloaded ")
		|| trimmed.starts_with("Locking ")
		|| trimmed.starts_with("Updating ")
		// `Blocking waiting for file lock on ...` is pure progress noise when a
		// concurrent cargo holds the lock (snip strips it in cargo-build/clippy).
		|| trimmed.starts_with("Blocking ")
		|| is_generated_warnings_rollup(trimmed)
}

/// The per-crate rollup line warning: `crate` (lib) generated N warnings.
/// The individual `warning: ...` diagnostic blocks are kept; this redundant
/// tally is dropped.  Clippy/install paths already skip it explicitly, so
/// stripping it here only affects build/check/doc/run condensing.
fn is_generated_warnings_rollup(trimmed: &str) -> bool {
	let Some(rest) = trimmed.strip_prefix("warning: ") else {
		return false;
	};
	rest.contains(" generated ") && (rest.ends_with(" warnings") || rest.ends_with(" warning"))
}

fn failures_only(input: &str, exit_code: i32) -> String {
	if exit_code == 0 {
		return summarize_successful_test_run(input);
	}
	let mut out = String::new();
	let mut keep = false;
	for line in input.lines() {
		let trimmed = line.trim_start();
		if trimmed.starts_with("failures:")
			|| trimmed.starts_with("---- ")
			|| trimmed.starts_with("error:")
			|| trimmed.starts_with("error[")
			|| trimmed.starts_with("thread '")
			|| trimmed.starts_with("test result: FAILED")
			|| trimmed.starts_with("test result: FAILED.")
		{
			keep = true;
		}
		// Passing test lines carry no failure signal — drop them unconditionally,
		// even after the keep flag latches, so a later passing suite in a
		// multi-suite run does not re-emit its `test <name> ... ok` lines.
		if is_passing_test_line(trimmed) {
			continue;
		}
		if keep || trimmed.starts_with("running ") {
			out.push_str(line);
			out.push('\n');
		}
	}
	if out.is_empty() {
		condense_build(input)
	} else {
		out
	}
}

#[derive(Default)]
struct CargoTestTotals {
	suites:   usize,
	passed:   u64,
	failed:   u64,
	ignored:  u64,
	measured: u64,
	filtered: u64,
	warnings: u64,
	duration: Option<String>,
}

fn summarize_successful_test_run(input: &str) -> String {
	let mut totals = CargoTestTotals::default();

	for line in input.lines() {
		let trimmed = line.trim();
		if let Some(summary) = trimmed.strip_prefix("test result: ok.") {
			totals.suites += 1;
			collect_cargo_test_summary(summary, &mut totals);
			continue;
		}
		if let Some(warnings) = parse_generated_warning_count(trimmed) {
			totals.warnings += warnings;
		}
	}

	if totals.suites == 0 {
		return strip_passing_tests(input);
	}

	let mut out = String::from("cargo test:");
	if totals.passed > 0 {
		out.push(' ');
		out.push_str(&totals.passed.to_string());
		out.push_str(" passed");
	} else {
		out.push_str(" ok");
	}

	let mut details = Vec::new();
	details.push(format_suite_count(totals.suites));
	if totals.failed > 0 {
		details.push(format!("{} failed", totals.failed));
	}
	if totals.ignored > 0 {
		details.push(format!("{} ignored", totals.ignored));
	}
	if totals.measured > 0 {
		details.push(format!("{} measured", totals.measured));
	}
	if totals.filtered > 0 {
		details.push(format!("{} filtered", totals.filtered));
	}
	if totals.warnings > 0 {
		details.push(format!("{} warnings", totals.warnings));
	}
	if let Some(duration) = totals.duration {
		details.push(duration);
	}
	if !details.is_empty() {
		out.push_str(" (");
		out.push_str(&details.join(", "));
		out.push(')');
	}
	out.push('\n');
	out
}

fn collect_cargo_test_summary(summary: &str, totals: &mut CargoTestTotals) {
	for part in summary.split(';') {
		let trimmed = part.trim().trim_end_matches('.');
		if let Some(value) = parse_count_prefix(trimmed, "passed") {
			totals.passed += value;
		} else if let Some(value) = parse_count_prefix(trimmed, "failed") {
			totals.failed += value;
		} else if let Some(value) = parse_count_prefix(trimmed, "ignored") {
			totals.ignored += value;
		} else if let Some(value) = parse_count_prefix(trimmed, "measured") {
			totals.measured += value;
		} else if let Some(value) = parse_count_prefix(trimmed, "filtered out") {
			totals.filtered += value;
		} else if let Some(duration) = trimmed.strip_prefix("finished in ") {
			totals.duration = Some(duration.to_string());
		}
	}
}

fn parse_generated_warning_count(line: &str) -> Option<u64> {
	if !line.contains(" generated ") || !line.ends_with(" warnings") {
		return None;
	}
	let before = line.rsplit_once(" warnings")?.0;
	let count_text = before.rsplit_once(' ')?.1;
	count_text.parse().ok()
}

fn parse_count_prefix(text: &str, label: &str) -> Option<u64> {
	let (count, rest) = text.split_once(' ')?;
	if rest != label {
		return None;
	}
	count.parse().ok()
}

fn format_suite_count(suites: usize) -> String {
	if suites == 1 {
		"1 suite".to_string()
	} else {
		format!("{suites} suites")
	}
}

fn strip_passing_tests(input: &str) -> String {
	let mut out = String::new();
	for line in input.lines() {
		let trimmed = line.trim_start();
		if is_passing_test_line(trimmed) {
			continue;
		}
		out.push_str(line);
		out.push('\n');
	}
	out
}

fn is_passing_test_line(trimmed: &str) -> bool {
	trimmed.starts_with("test ") && (trimmed.ends_with(" ... ok") || trimmed.ends_with("... ok"))
}

fn filter_nextest(input: &str) -> String {
	let mut out = String::new();
	let mut in_failure = false;
	let mut summary = None;
	let mut canceled = false;
	let mut past_summary = false;

	for line in input.lines() {
		let trimmed = line.trim();
		// Once the Summary line is seen, nextest re-lists the failing tests as a
		// recap (duplicate `FAIL [...]` rows + trailing noise).  Drop everything
		// after it; the captured Summary line is re-emitted verbatim at the end.
		if past_summary {
			continue;
		}
		if is_compiling_noise(trimmed)
			|| trimmed.starts_with("PASS ")
			|| trimmed.starts_with("────")
			|| trimmed.starts_with("Starting ")
		{
			continue;
		}
		if trimmed.starts_with("Summary [") {
			summary = Some(trimmed.to_string());
			in_failure = false;
			past_summary = true;
			continue;
		}
		if trimmed.starts_with("Cancelling") {
			canceled = true;
			continue;
		}
		if trimmed.starts_with("FAIL ") {
			in_failure = true;
			out.push_str(trimmed);
			out.push('\n');
			continue;
		}
		if in_failure && !trimmed.starts_with("error: test run failed") {
			out.push_str(line);
			out.push('\n');
		}
	}

	if canceled {
		out.push_str("Cancelling due to test failure\n");
	}
	if let Some(line) = summary {
		out.push_str(&line);
		out.push('\n');
	}
	if out.is_empty() {
		compact_general(input)
	} else {
		out
	}
}

fn condense_fmt(input: &str) -> String {
	let deduped = primitives::dedup_consecutive_lines(input);
	let grouped = primitives::group_by_file(&deduped, 20);
	primitives::head_tail_lines(&grouped, 80, 40)
}

fn compact_general(input: &str) -> String {
	let stripped = primitives::strip_lines(input, &[is_general_cargo_noise]);
	let deduped = primitives::dedup_consecutive_lines(&stripped);
	primitives::head_tail_lines(&deduped, 80, 40)
}

fn is_general_cargo_noise(line: &str) -> bool {
	let trimmed = line.trim_start();
	trimmed.starts_with("Downloaded ")
		|| trimmed.starts_with("Downloading ")
		|| trimmed.starts_with("Compiling ")
		|| trimmed.starts_with("Checking ")
		|| trimmed.starts_with("Fresh ")
}
/// Filter `cargo install` output: strip compilation/download noise, keep
/// install/error summaries.
fn filter_install(input: &str, exit_code: i32) -> String {
	let stripped = primitives::strip_lines(input, &[is_compiling_noise]);

	if exit_code != 0 {
		return primitives::head_tail_lines(&stripped, 100, 40);
	}

	let mut summaries = String::new();
	for line in stripped.lines() {
		let trimmed = line.trim_start();
		if is_install_summary(trimmed) || trimmed.starts_with("WARNING:") {
			summaries.push_str(line);
			summaries.push('\n');
		}
	}

	if summaries.is_empty() {
		let deduped = primitives::dedup_consecutive_lines(&stripped);
		primitives::head_tail_lines(&deduped, 60, 20)
	} else {
		primitives::dedup_consecutive_lines(&summaries)
	}
}

fn is_install_summary(line: &str) -> bool {
	line.starts_with("Installed ")
		|| line.starts_with("Replaced ")
		|| line.starts_with("Replacing ")
		|| line.starts_with("Ignored ")
}

#[derive(Debug)]
struct ClippyWarning {
	location:  String,
	message:   String,
	lint_rule: Option<String>,
}

/// Filter `cargo clippy`: group warnings by lint rule; keep errors verbatim.
fn filter_clippy(input: &str, exit_code: i32) -> String {
	let no_noise = primitives::strip_lines(input, &[is_compiling_noise]);

	let has_compile_error = no_noise.lines().any(|l| {
		let t = l.trim_start();
		(t.starts_with("error:")
			&& !t.starts_with("error: could not compile")
			&& !t.starts_with("error: aborting"))
			|| t.starts_with("error[")
	});

	if has_compile_error {
		let grouped = primitives::group_by_file(&no_noise, 20);
		return primitives::head_tail_lines(&grouped, 120, 60);
	}

	let warnings = parse_clippy_warnings(&no_noise);
	if warnings.is_empty() {
		let deduped = primitives::dedup_consecutive_lines(&no_noise);
		return primitives::head_tail_lines(&deduped, 80, 40);
	}

	format_clippy_grouped(&warnings, exit_code)
}

fn parse_clippy_warnings(input: &str) -> Vec<ClippyWarning> {
	let mut warnings = Vec::new();
	let lines: Vec<&str> = input.lines().collect();
	let mut i = 0;

	while i < lines.len() {
		let trimmed = lines[i].trim();
		if !trimmed.starts_with("warning: ") {
			i += 1;
			continue;
		}

		let msg = trimmed.strip_prefix("warning: ").unwrap_or("");
		// Skip summary lines like "warning: `crate` (lib) generated N warning(s)"
		if msg.contains(" generated ") && (msg.ends_with(" warnings") || msg.ends_with(" warning")) {
			i += 1;
			continue;
		}

		let message = msg.to_string();
		let mut location = String::new();
		let mut lint_rule = None;

		i += 1;
		while i < lines.len() {
			let t = lines[i].trim();
			if t.starts_with("--> ") {
				location = t.strip_prefix("--> ").unwrap_or("").to_string();
			}
			if let Some(rule) = extract_lint_rule(t) {
				lint_rule = Some(rule);
			}
			i += 1;
			if i >= lines.len() {
				break;
			}
			let next = lines[i].trim();
			if next.starts_with("warning: ")
				|| next.starts_with("error:")
				|| next.starts_with("error[")
			{
				break;
			}
		}

		if !message.is_empty() {
			warnings.push(ClippyWarning { location, message, lint_rule });
		}
	}

	warnings
}

fn extract_lint_rule(line: &str) -> Option<String> {
	let line = line.trim();
	if !line.starts_with("= note:") {
		return None;
	}
	let after_note = line.strip_prefix("= note:")?.trim();
	// Attribute form: `#[warn(rule)]` / `#[deny(rule)]` / `#[allow(rule)]`.
	if let Some(rest) = after_note
		.strip_prefix("`#[warn(")
		.or_else(|| after_note.strip_prefix("`#[deny("))
		.or_else(|| after_note.strip_prefix("`#[allow("))
	{
		return Some(rest.split(")]`").next()?.to_string());
	}
	// CLI form: `requested on the command line with `-W <rule>`` (also -D).
	// Lints enabled this way carry no `#[warn(...)]` note, so without this
	// branch they fall into the ungrouped bucket instead of grouping by rule.
	let cli = after_note.strip_prefix("requested on the command line with ")?;
	let flag = cli.strip_prefix('`')?.split('`').next()?.trim();
	let rule = flag
		.strip_prefix("-W ")
		.or_else(|| flag.strip_prefix("-D "))
		.or_else(|| flag.strip_prefix("-A "))?
		.trim();
	if rule.is_empty() {
		return None;
	}
	Some(rule.to_string())
}

fn format_clippy_grouped(warnings: &[ClippyWarning], exit_code: i32) -> String {
	let mut groups: BTreeMap<String, Vec<&ClippyWarning>> = BTreeMap::new();
	let mut ungrouped = Vec::new();

	for w in warnings {
		if let Some(ref rule) = w.lint_rule {
			groups.entry(rule.clone()).or_default().push(w);
		} else {
			ungrouped.push(w);
		}
	}

	let mut out = String::new();

	for (rule, warns) in &groups {
		if warns.len() == 1 {
			let loc = if warns[0].location.is_empty() {
				String::new()
			} else {
				format!("{}  ", warns[0].location)
			};
			let _ = writeln!(out, "clippy: {} — {}{}", rule, loc, warns[0].message);
		} else {
			let _ = writeln!(out, "clippy: {} ({} warnings)", rule, warns.len());
			for w in warns {
				let _ = writeln!(out, "  {}  {}", w.location, w.message);
			}
		}
	}

	for w in &ungrouped {
		let _ = writeln!(out, "clippy warning: {}  {}", w.location, w.message);
	}

	if exit_code != 0 {
		out.push_str("(clippy found issues)\n");
	}

	if out.is_empty() {
		"cargo clippy: ok\n".to_string()
	} else {
		out
	}
}
