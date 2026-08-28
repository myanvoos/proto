//! GitHub CLI output filters.

use std::fmt::Write as _;

use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

#[must_use]
pub fn supports(subcommand: Option<&str>) -> bool {
	matches!(
		subcommand,
		Some(
			"pr"
				| "issue"
				| "run" | "workflow"
				| "repo" | "api"
				| "search"
				| "release"
				| "codespace"
				| "gist"
		)
	)
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	if preserves_raw_mode(ctx) {
		return MinimizerOutput::passthrough(input);
	}

	let cleaned = primitives::strip_ansi(input);
	let text = match ctx.subcommand {
		Some("pr") if primitives::command_has_ordered_tokens(ctx.command, "pr", "checks") => {
			match filter_pr_checks(&cleaned) {
				Some(summary) => summary,
				None => filter_pr_issue(&cleaned, exit_code),
			}
		},
		Some("pr" | "issue") => filter_pr_issue(&cleaned, exit_code),
		Some("run" | "workflow") => filter_run(&cleaned, exit_code),
		_ => primitives::head_tail_dedup(&cleaned),
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn preserves_raw_mode(ctx: &MinimizerCtx<'_>) -> bool {
	match ctx.subcommand {
		Some("api") => true,
		Some("run") => {
			primitives::command_has_ordered_tokens(ctx.command, "run", "view")
				&& primitives::command_has_any_token(ctx.command, &["--log", "--log-failed", "--json"])
		},
		Some("pr") if primitives::command_has_ordered_tokens(ctx.command, "pr", "checks") => {
			// `--watch` re-renders the whole check table each `--interval`/-i
			// (default 10s) until checks finish; the captured buffer is then
			// dozens of concatenated frames. `filter_pr_checks` counts one glyph
			// per row per frame, so it would report counts x frames and let
			// duplicate failed rows exhaust FAILED_ROW_CAP, hiding distinct later
			// failures. A watch is an explicit live view -- pass it through raw
			// instead of summarizing a multi-frame buffer. (--json/-w break the
			// table shape outright.)
			primitives::command_has_any_token(ctx.command, &[
				"--json",
				"--web",
				"-w",
				"--jq",
				"--template",
				"--watch",
				"--interval",
				"-i",
			])
		},
		Some("pr") if primitives::command_has_ordered_tokens(ctx.command, "pr", "diff") => true,
		Some("pr") if primitives::command_has_ordered_tokens(ctx.command, "pr", "status") => {
			primitives::command_has_any_token(ctx.command, &["--web", "--jq", "--template"])
		},
		Some(subcommand @ ("pr" | "issue")) => {
			primitives::command_has_ordered_tokens(ctx.command, subcommand, "view")
				&& primitives::command_has_any_token(ctx.command, &["--json", "--jq", "--comments"])
		},
		_ => false,
	}
}

fn filter_pr_issue(input: &str, exit_code: i32) -> String {
	if exit_code != 0 {
		return primitives::head_tail_dedup(input);
	}
	let markdown_filtered = filter_markdown_noise(input);
	primitives::head_tail_dedup(&markdown_filtered)
}

/// Summarize the DEFAULT (non-JSON) `gh pr checks` table.
///
/// Default human output is a tab-separated table:
/// `<symbol>\t<name>\t<duration>\t<url>` where the leading status glyph is
/// `✓`/`X`/`*`/`-` (pass/fail/pending/skipping). We re-derive against this real
/// layout — NOT rtk's `[ok]`/`[x]` strings, which only appear on the injected
/// `-F json` path. Failed rows stay verbatim (they carry the actionable URL);
/// passed/pending/skipping collapse to counts. Returns `None` when no
/// recognizable check rows are found so the caller can fall back to the generic
/// path.
fn filter_pr_checks(input: &str) -> Option<String> {
	let mut passed = 0usize;
	let mut pending = 0usize;
	let mut skipping = 0usize;
	let mut failed_rows = Vec::new();
	let mut saw_row = false;

	for line in input.lines() {
		let trimmed = line.trim_start();
		// A real check row is `<symbol>\t<name>\t<duration>\t<url>`: a status glyph
		// followed by at least one TAB-delimited field. Requiring the tab shape
		// keyed off the row's first glyph — NOT the leading char alone — rejects
		// separators (`---`), blank-glyph lines, and bulleted annotation detail
		// (`- ...`, `* ...`) that gh/CI tools emit, any of which would otherwise be
		// miscounted as a phantom skipping/pending check and inflate the summary.
		if !trimmed.contains('\t') {
			continue;
		}
		let Some(symbol) = trimmed.chars().next() else {
			continue;
		};
		match symbol {
			'✓' => {
				saw_row = true;
				passed += 1;
			},
			'X' | '✗' | '×' => {
				saw_row = true;
				failed_rows.push(line.trim_end().to_string());
			},
			'*' => {
				saw_row = true;
				pending += 1;
			},
			'-' => {
				saw_row = true;
				skipping += 1;
			},
			_ => {},
		}
	}

	if !saw_row {
		return None;
	}

	let mut out = String::new();
	let failed = failed_rows.len();
	let _ = write!(out, "checks: {passed} passed, {failed} failed");
	if pending > 0 {
		let _ = write!(out, ", {pending} pending");
	}
	if skipping > 0 {
		let _ = write!(out, ", {skipping} skipping");
	}
	out.push('\n');
	// Cap the verbatim failed rows: a PR with hundreds of failing checks would
	// otherwise emit one line each, uncapped (this path bypasses head_tail_dedup
	// that every sibling arm ends in). Keep the first FAILED_ROW_CAP failures —
	// they carry the actionable URLs — and append an omission marker.
	const FAILED_ROW_CAP: usize = 40;
	out.push_str(&primitives::head_lines_only(&failed_rows.join("\n"), FAILED_ROW_CAP));
	Some(out)
}

fn filter_run(input: &str, exit_code: i32) -> String {
	let deduped = primitives::dedup_consecutive_lines(input);
	if exit_code != 0 || contains_failure_signal(input) {
		return primitives::head_tail_lines(&deduped, 160, 120);
	}
	primitives::head_tail_lines(&deduped, 120, 80)
}

fn filter_markdown_noise(input: &str) -> String {
	let mut out = String::new();
	let mut in_html_comment = false;
	let mut previous_blank = false;
	let mut comment_lines = 0usize;

	for line in input.lines() {
		let trimmed = line.trim();
		if in_html_comment {
			if trimmed.contains("-->") {
				in_html_comment = false;
				comment_lines = 0;
			} else {
				comment_lines += 1;
				if comment_lines > 50 {
					in_html_comment = false;
					comment_lines = 0;
				}
			}
			continue;
		}
		if trimmed.starts_with("<!--") {
			if !trimmed.contains("-->") {
				in_html_comment = true;
				comment_lines = 0;
			}
			continue;
		}
		if primitives::is_markdown_badge_or_image(trimmed) || primitives::is_horizontal_rule(trimmed)
		{
			continue;
		}
		if trimmed.is_empty() {
			if !previous_blank {
				out.push('\n');
			}
			previous_blank = true;
			continue;
		}
		previous_blank = false;
		out.push_str(line.trim_end());
		out.push('\n');
	}
	out
}

fn contains_failure_signal(input: &str) -> bool {
	input.lines().any(|line| {
		let lower = line.to_ascii_lowercase();
		lower.contains("error")
			|| lower.contains("failed")
			|| lower.contains("failure")
			|| lower.contains("cancelled")
	})
}
