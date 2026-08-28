//! Python test, type-check, and lint output filters.
//!
//! Ported from rtk-ai/rtk@878af7de99e0ba71da2e8fd996f6b52a1836e06c
//! Path: `src/cmds/python/pytest_cmd.rs`
//! License: MIT (compatible with workspace MIT). See `NOTICE` at
//! the `pi-shell` crate root.
//!
//! The pytest state machine (`filter_pytest`, `pytest_success`,
//! `is_pytest_*`, `looks_like_pytest_summary_part`) adapts the
//! `build_pytest_summary` algorithm from RTK at the pinned SHA above:
//! preserve failures, errors, and the final summary line; strip header
//! framing, progress dots, and verbose PASSED rows. Unknown-state lines
//! fall through unchanged (RTK's defensive default), so xdist `[gwN]`
//! prefixes and custom reporters never cause data loss.

use super::lint;
use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

/// Cap on rendered verbose failure blocks (the `___ test ___` traceback
/// sections). Mirrors RTK's `MAX_PYTEST_FAILURES` (== `CAP_WARNINGS` == 10),
/// re-derived for the minimizer's streaming, line-based renderer: once this
/// many traceback blocks have been emitted, further blocks are suppressed and
/// a single `[…N failures elided…]` overflow marker stands in for the
/// remainder. The compact `FAILED …` short-summary one-liners are NOT capped
/// here — they name every failed test cheaply and stay intact.
///
/// The `=== ERRORS ===` section (collection / fixture-setup errors) is capped
/// by a SEPARATE counter (see `filter_pytest`): pytest renders ERRORS *before*
/// FAILURES, and those banners (`___ ERROR collecting … ___`) contain the
/// substring `test` via their path, so a single shared counter would let a
/// burst of low-value collection banners exhaust the budget and evict the
/// real assertion tracebacks that follow. Two counters keep each section's
/// overflow independent.
const MAX_PYTEST_FAILURES: usize = 10;

#[must_use]
pub fn supports(program: &str, subcommand: Option<&str>) -> bool {
	matches!(program, "pytest" | "ruff" | "mypy")
		|| matches!(
			(program, subcommand),
			("python" | "python3" | "py", Some("pytest" | "ruff" | "mypy"))
		)
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	// Kill-switch parity (M2): when `legacy_filters_active`, fall back to
	// the pre-PR passthrough so callers can rollback an RTK-port regression
	// without recompile.
	if ctx.config.legacy_filters_active() {
		return MinimizerOutput::passthrough(input);
	}
	let tool = python_tool(ctx.program, ctx.subcommand);
	let cleaned = primitives::strip_ansi(input);
	let text = match tool {
		Some("pytest") => filter_pytest(&cleaned, exit_code),
		Some("ruff") if is_ruff_format(ctx) => filter_ruff_format(&cleaned),
		Some("ruff") => lint::condense_lint_output("ruff", &cleaned, exit_code),
		Some("mypy") => lint::condense_lint_output("mypy", &cleaned, exit_code),
		_ => cleaned,
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn python_tool<'a>(program: &'a str, subcommand: Option<&'a str>) -> Option<&'a str> {
	match program {
		"pytest" | "ruff" | "mypy" => Some(program),
		"python" | "python3" | "py" => match subcommand {
			Some("pytest" | "ruff" | "mypy") => subcommand,
			_ => None,
		},
		_ => None,
	}
}

fn filter_pytest(input: &str, exit_code: i32) -> String {
	if exit_code == 0 {
		return pytest_success(input);
	}

	let mut out = String::new();
	let mut in_failure = false;
	// Verbose traceback blocks seen so far, counted SEPARATELY per pytest
	// section. `=== ERRORS ===` (collection / fixture-setup) banners render
	// before `=== FAILURES ===`, so a shared counter would let collection
	// noise exhaust the budget and evict real assertion tracebacks; two
	// counters give each section an independent cap + overflow marker.
	let mut failure_blocks = 0usize;
	let mut error_blocks = 0usize;
	let mut suppressing = false;

	for line in input.lines() {
		let trimmed = line.trim();
		if is_pytest_summary_header(trimmed) {
			in_failure = false;
			suppressing = false;
			push_line(&mut out, line);
			continue;
		}
		if is_pytest_summary_line(trimmed) {
			in_failure = false;
			suppressing = false;
			push_pytest_summary_line(&mut out, trimmed);
			continue;
		}
		// XFAIL/XPASS short-summary report lines (emitted under `-r` flags)
		// must survive verbatim: XPASS in particular signals a behavior change
		// (something expected-to-fail now passes). Handled before the
		// in_failure block so the verbose-pass-noise filter can't eat them.
		if trimmed.starts_with("XFAIL ") || trimmed.starts_with("XPASS ") {
			in_failure = false;
			suppressing = false;
			push_line(&mut out, line);
			continue;
		}

		// `=== ERRORS ===` banners (`___ ERROR collecting … ___`,
		// `___ ERROR at setup of … ___`) are checked FIRST and counted under
		// their own cap. They precede the FAILURES section, so counting them
		// here keeps the failure budget reserved for real assertion blocks.
		let is_error_banner = is_pytest_error_banner(trimmed);
		if is_error_banner || is_pytest_failure_header(trimmed) {
			in_failure = true;
			// The overflow count for each kind is rendered once after the loop.
			if is_error_banner {
				error_blocks += 1;
				suppressing = error_blocks > MAX_PYTEST_FAILURES;
			} else {
				failure_blocks += 1;
				suppressing = failure_blocks > MAX_PYTEST_FAILURES;
			}
			if !suppressing {
				push_line(&mut out, line);
			}
			continue;
		}

		if starts_pytest_failure(trimmed) {
			in_failure = true;
			// While a capped traceback block is being suppressed, its `E   ` /
			// `ERROR at ` continuation lines belong to that block and are
			// dropped too. (`FAILED ` short-summary lines only appear after the
			// summary header has cleared `suppressing`, so they stay.)
			if !suppressing {
				push_line(&mut out, line);
			}
			continue;
		}

		if in_failure {
			if is_pytest_section_delimiter(trimmed) && !starts_pytest_failure(trimmed) {
				in_failure = false;
				continue;
			}
			if !suppressing && !is_pytest_pass_noise(trimmed) {
				push_line(&mut out, line);
			}
			continue;
		}

		if trimmed.starts_with("FAILED ") || trimmed.starts_with("ERROR ") {
			push_line(&mut out, line);
		}
	}

	// Errors render before failures in pytest; mirror that order for the
	// overflow markers so the compact output reads top-to-bottom.
	let error_overflow = error_blocks.saturating_sub(MAX_PYTEST_FAILURES);
	if error_overflow > 0 {
		out.push_str("[…");
		out.push_str(&error_overflow.to_string());
		out.push_str(" errors elided…]\n");
	}
	let overflow = failure_blocks.saturating_sub(MAX_PYTEST_FAILURES);
	if overflow > 0 {
		out.push_str("[…");
		out.push_str(&overflow.to_string());
		out.push_str(" failures elided…]\n");
	}

	if has_content(&out) {
		out
	} else {
		primitives::head_tail_lines(input, 80, 80)
	}
}

fn pytest_success(input: &str) -> String {
	let mut out = String::new();
	let mut summary = String::new();

	for line in input.lines() {
		let trimmed = line.trim();
		if is_pytest_summary_header(trimmed) {
			push_line(&mut summary, line);
			push_line(&mut out, line);
			continue;
		}
		if is_pytest_summary_line(trimmed) {
			push_pytest_summary_line(&mut summary, trimmed);
			push_pytest_summary_line(&mut out, trimmed);
			continue;
		}
		if is_pytest_pass_noise(trimmed) {
			continue;
		}
		push_line(&mut out, line);
	}

	if has_content(&out) {
		out
	} else if has_content(&summary) {
		summary
	} else {
		primitives::head_tail_lines(input, 0, 20)
	}
}

fn starts_pytest_failure(trimmed: &str) -> bool {
	is_pytest_failure_header(trimmed)
		|| trimmed.starts_with("E   ")
		|| trimmed.starts_with("ERROR at ")
		|| trimmed.starts_with("FAILED ")
}

/// A `___ test ___`-style banner that opens one verbose traceback block in the
/// `=== FAILURES ===` section. These are the units capped by
/// `MAX_PYTEST_FAILURES`; the `E   `/`FAILED `/`ERROR at ` forms are
/// continuation or short-summary lines, not block boundaries.
fn is_pytest_failure_header(trimmed: &str) -> bool {
	trimmed.starts_with('_') && trimmed.ends_with('_') && trimmed.contains("test")
}

/// A `___ ERROR … ___` banner that opens an `=== ERRORS ===`-section block:
/// `___ ERROR collecting <path> ___` (import/collection failure) and
/// `___ ERROR at setup of <test> ___` / `___ ERROR at teardown of <test> ___`
/// (fixture errors). These render BEFORE the FAILURES section and their inner
/// text contains the substring `test` via the path/test name, so without this
/// distinction they would count against `MAX_PYTEST_FAILURES` and crowd out
/// the real assertion tracebacks. They are capped by their own counter
/// instead.
fn is_pytest_error_banner(trimmed: &str) -> bool {
	if !(trimmed.starts_with('_') && trimmed.ends_with('_')) {
		return false;
	}
	trimmed.trim_matches('_').trim().starts_with("ERROR ")
}

fn is_pytest_summary_header(trimmed: &str) -> bool {
	trimmed.contains("short test summary info") || trimmed.contains("warnings summary")
}

fn is_pytest_summary_line(trimmed: &str) -> bool {
	let has_status = trimmed.contains("passed")
		|| trimmed.contains("failed")
		|| trimmed.contains("error")
		|| trimmed.contains("skipped")
		|| trimmed.contains("warnings")
		|| trimmed.contains("no tests ran");

	if trimmed.starts_with('=') {
		return has_status;
	}

	has_status
		&& trimmed.contains(" in ")
		&& trimmed
			.split(',')
			.all(|part| looks_like_pytest_summary_part(part.trim()))
}

fn looks_like_pytest_summary_part(part: &str) -> bool {
	if part == "no tests ran" {
		return true;
	}

	if let Some((count, rest)) = part.split_once(' ') {
		return count.parse::<u64>().is_ok()
			&& (rest.starts_with("passed")
				|| rest.starts_with("failed")
				|| rest.starts_with("errors")
				|| rest.starts_with("error")
				|| rest.starts_with("skipped")
				|| rest.starts_with("warnings")
				|| rest.starts_with("warning")
				|| rest.starts_with("xfailed")
				|| rest.starts_with("xpassed"));
	}

	false
}

fn compact_pytest_summary_line(trimmed: &str) -> &str {
	if trimmed.starts_with('=') {
		trimmed.trim_matches('=').trim()
	} else {
		trimmed
	}
}

fn is_pytest_section_delimiter(trimmed: &str) -> bool {
	trimmed.len() >= 6
		&& trimmed
			.chars()
			.all(|ch| ch == '_' || ch == '=' || ch == '-')
}

fn is_pytest_pass_noise(trimmed: &str) -> bool {
	trimmed.is_empty()
		|| trimmed.contains("test session starts")
		|| trimmed.starts_with("collecting ")
		|| trimmed.starts_with("collected ")
		|| trimmed.starts_with("rootdir:")
		|| trimmed.starts_with("configfile:")
		|| trimmed.starts_with("plugins:")
		|| trimmed.starts_with("platform ")
		|| trimmed.starts_with("cachedir:")
		|| is_pytest_verbose_pass_line(trimmed)
		|| is_pytest_progress_line(trimmed)
		|| trimmed
			.chars()
			.all(|ch| matches!(ch, '.' | 's' | 'S' | 'x' | 'X' | 'f' | 'F' | 'E'))
}

fn is_pytest_verbose_pass_line(trimmed: &str) -> bool {
	if !trimmed.contains("::") {
		return false;
	}
	// `XFAIL …`/`XPASS …` short-summary report lines lead with the status
	// token (e.g. `XFAIL test.py::case - reason`) and must NOT be treated as
	// pass-noise — XPASS signals a behavior change. Verbose per-test rows carry
	// the status token in a trailing column (`test.py::case XFAIL [100%]`), so
	// keying on the leading token cleanly separates the two.
	if trimmed.starts_with("XFAIL ") || trimmed.starts_with("XPASS ") {
		return false;
	}
	let mut parts = trimmed.split_whitespace();
	parts.any(|part| matches!(part, "PASSED" | "SKIPPED" | "XPASS" | "XFAIL"))
}

fn is_pytest_progress_line(trimmed: &str) -> bool {
	let Some((path, statuses)) = trimmed.split_once(char::is_whitespace) else {
		return false;
	};
	std::path::Path::new(path)
		.extension()
		.is_some_and(|ext| ext.eq_ignore_ascii_case("py"))
		&& statuses
			.trim()
			.chars()
			.all(|ch| matches!(ch, '.' | 's' | 'S' | 'x' | 'X' | 'f' | 'F' | 'E'))
}

fn is_ruff_format(ctx: &MinimizerCtx<'_>) -> bool {
	ctx.subcommand == Some("format") || ctx.command.split_whitespace().any(|part| part == "format")
}

fn filter_ruff_format(input: &str) -> String {
	let mut out = String::new();

	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() {
			continue;
		}
		if is_ruff_format_line(trimmed) {
			push_line(&mut out, line);
		}
	}

	if has_content(&out) {
		out
	} else {
		primitives::head_tail_lines(input, 80, 80)
	}
}

fn is_ruff_format_line(trimmed: &str) -> bool {
	trimmed.starts_with("Would reformat:")
		|| trimmed.starts_with("Would format:")
		|| trimmed.starts_with("Reformatted:")
		|| trimmed.contains(" file would be reformatted")
		|| trimmed.contains(" files would be reformatted")
		|| trimmed.contains(" file reformatted")
		|| trimmed.contains(" files reformatted")
		|| trimmed.contains(" file left unchanged")
		|| trimmed.contains(" files left unchanged")
		|| trimmed.contains(" file already formatted")
		|| trimmed.contains(" files already formatted")
}

fn push_line(out: &mut String, line: &str) {
	out.push_str(line);
	out.push('\n');
}

fn push_pytest_summary_line(out: &mut String, trimmed: &str) {
	out.push_str("pytest: ");
	out.push_str(compact_pytest_summary_line(trimmed));
	out.push('\n');
}

fn has_content(text: &str) -> bool {
	text.lines().any(|line| !line.trim().is_empty())
}
