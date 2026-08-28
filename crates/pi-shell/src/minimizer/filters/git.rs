//! Git output filters.

use std::fmt::Write as _;

use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

#[must_use]
pub fn supports(subcommand: Option<&str>) -> bool {
	matches!(
		subcommand,
		Some(
			"status"
				| "diff" | "show"
				| "log" | "add"
				| "commit"
				| "push" | "pull"
				| "branch"
				| "fetch"
				| "stash"
				| "worktree"
				| "merge"
				| "rebase"
				| "checkout"
				| "switch"
				| "restore"
				| "clean"
				| "reset"
				| "tag",
		),
	)
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	if is_show_path_content(ctx.command) || is_stash_patch(ctx.command) {
		return MinimizerOutput::passthrough(input);
	}

	let cleaned = primitives::strip_ansi(input);
	let text = match ctx.subcommand {
		Some("status") if is_status_machine_format(ctx.command) => cleaned,
		Some("status") => condense_status(&cleaned),
		Some("diff") if has_token(ctx.command, "--summary") => cleaned,
		Some("diff") if is_stat_format(ctx.command) => condense_diff_stat(&cleaned),
		Some("diff") => {
			if exit_code == 0 {
				if let Some(mode) = diff_listing_mode(ctx.command) {
					compact_diff_listing(&cleaned, mode)
				} else {
					compact_diff_output(&cleaned)
				}
			} else {
				compact_diff_output(&cleaned)
			}
		},
		Some("show") if is_show_custom_format(ctx.command) => cleaned,
		Some("show") => condense_show(&cleaned),
		Some("log") if is_log_custom_format(ctx.command) => cleaned,
		Some("log") => condense_log(&cleaned, 32, 16),
		// Non-listing branch formats produce single values or one-liner
		// confirmations (e.g. `--show-current` → `main`, `--delete` →
		// `Deleted branch feature (was abc123).`).  `condense_branch`
		// would rewrite those as `local: main\n` / `local: Deleted
		// branch…`, changing the meaning of the requested output, so
		// skip it and passthrough the cleaned buffer.
		Some("branch") if is_branch_non_listing(ctx.command) => cleaned,
		Some("branch") => condense_branch(&cleaned),
		Some("tag") if is_tag_non_listing(ctx.command) => cleaned,
		Some("tag") => primitives::compact_listing(&cleaned, 40),
		Some("stash") => condense_stash(ctx.command, &cleaned, exit_code),
		Some("worktree") => {
			if has_token(ctx.command, "--porcelain")
				|| has_token(ctx.command, "-z")
				|| has_token(ctx.command, "--null")
			{
				cleaned
			} else {
				condense_worktree(&cleaned)
			}
		},
		Some("push") if has_token(ctx.command, "--porcelain") => cleaned,
		Some("push") => condense_push(&cleaned, exit_code),
		Some("pull") => condense_pull(&cleaned, exit_code),
		Some("fetch") if has_token(ctx.command, "--porcelain") => cleaned,
		Some("fetch") => condense_fetch(&cleaned, exit_code),
		Some("commit") => condense_commit(&cleaned, exit_code),
		Some("merge" | "rebase" | "checkout" | "switch" | "restore" | "clean" | "reset" | "add") => {
			condense_noisy_output(&cleaned)
		},
		_ => cleaned,
	};
	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn is_show_path_content(command: &str) -> bool {
	let mut saw_show = false;
	for part in command.split_whitespace() {
		if saw_show && !part.starts_with('-') && part.contains(':') {
			return true;
		}
		if part == "show" {
			saw_show = true;
		}
	}
	false
}

fn is_stash_patch(command: &str) -> bool {
	has_ordered_tokens(command, "stash", "show")
		&& (has_token(command, "-p") || has_token(command, "--patch"))
}

fn has_ordered_tokens(command: &str, first: &str, second: &str) -> bool {
	let mut saw_first = false;
	for part in command.split_whitespace() {
		if saw_first && part == second {
			return true;
		}
		if part == first {
			saw_first = true;
		}
	}
	false
}

fn has_token(command: &str, token: &str) -> bool {
	command.split_whitespace().any(|part| part == token)
}

/// Whether `command` carries `--flag` in either the space-separated
/// (`--flag value`) or the inline (`--flag=value`) form. `has_token` only
/// matches the bare token, so inline `=`-joined flags (e.g. `--format=%H`)
/// would otherwise slip through guards that key off the flag name alone.
fn has_flag(command: &str, flag: &str) -> bool {
	let inline_prefix = format!("{flag}=");
	command
		.split_whitespace()
		.any(|part| part == flag || part.starts_with(&inline_prefix))
}

fn is_status_machine_format(command: &str) -> bool {
	command.split_whitespace().any(|part| {
		matches!(part, "--porcelain" | "--porcelain=v1" | "--porcelain=v2" | "--null")
			|| part == "-z"
			|| part.starts_with('-') && !part.starts_with("--") && part.contains('z')
	})
}

fn is_stat_format(command: &str) -> bool {
	command
		.split_whitespace()
		.any(|part| part == "--stat" || part.starts_with("--stat="))
}

#[derive(Clone, Copy)]
enum DiffListingMode {
	NameOnly,
	NameStatus,
	Numstat,
}

const DIFF_LISTING_LIMIT: usize = 20;

impl DiffListingMode {
	const fn label(self) -> &'static str {
		match self {
			Self::NameOnly => "--name-only",
			Self::NameStatus => "--name-status",
			Self::Numstat => "--numstat",
		}
	}
}

fn diff_listing_mode(command: &str) -> Option<DiffListingMode> {
	if has_token(command, "--name-only") {
		Some(DiffListingMode::NameOnly)
	} else if has_token(command, "--name-status") {
		Some(DiffListingMode::NameStatus)
	} else if has_token(command, "--numstat") {
		Some(DiffListingMode::Numstat)
	} else {
		None
	}
}

fn compact_diff_listing(input: &str, mode: DiffListingMode) -> String {
	let mut entries = Vec::new();
	for line in input.lines() {
		if line.is_empty() {
			continue;
		}
		if !is_diff_listing_line(mode, line) {
			return input.to_string();
		}
		entries.push(line.to_string());
	}

	if entries.len() <= DIFF_LISTING_LIMIT {
		return input.to_string();
	}

	let mut out = String::new();
	let _ = writeln!(out, "git diff {}: {}", mode.label(), format_file_count(entries.len()));
	for entry in entries.iter().take(DIFF_LISTING_LIMIT) {
		out.push_str(entry);
		out.push('\n');
	}
	let _ = writeln!(out, "[…{} files elided…]", entries.len() - DIFF_LISTING_LIMIT);
	out
}

fn is_diff_listing_line(mode: DiffListingMode, line: &str) -> bool {
	match mode {
		DiffListingMode::NameOnly => true,
		DiffListingMode::NameStatus => line.split('\t').count() >= 2,
		DiffListingMode::Numstat => line.split('\t').count() >= 3,
	}
}

#[derive(Default)]
struct StatusSummary {
	branch:     Option<String>,
	stash:      Option<String>,
	divergence: Option<String>,
	clean:      bool,
	staged:     usize,
	unstaged:   usize,
	untracked:  usize,
	conflicts:  usize,
	paths:      Vec<String>,
}

fn condense_status(input: &str) -> String {
	let mut summary = StatusSummary::default();
	let mut in_untracked = false;
	// Long-format `git status` groups entries under section headers. `modified:`
	// and `deleted:` appear in both the staged ("Changes to be committed:") and
	// unstaged ("Changes not staged for commit:") sections, so we must track the
	// active section to count them correctly.
	let mut in_staged = false;
	let mut state: Option<&str> = None;

	for line in input.lines() {
		let line = line.trim_end();
		let trimmed = line.trim();
		if trimmed.is_empty() {
			continue;
		}
		if let Some(branch) = line.strip_prefix("## ") {
			summary.branch = Some(branch.to_string());
			continue;
		}
		if parse_short_status_line(line, &mut summary) {
			continue;
		}
		if let Some(branch) = trimmed.strip_prefix("On branch ") {
			summary.branch = Some(branch.to_string());
			continue;
		}
		if trimmed.starts_with("Your branch is ahead")
			|| trimmed.starts_with("Your branch is behind")
			|| trimmed.starts_with("Your branch and")
			|| trimmed.starts_with("HEAD detached")
		{
			summary.divergence = Some(trimmed.to_string());
			continue;
		}
		if trimmed.starts_with("Your stash currently has ") {
			summary.stash = Some(trimmed.to_string());
			continue;
		}
		if trimmed.starts_with("nothing to commit") || trimmed == "working tree clean" {
			summary.clean = true;
			continue;
		}
		// Only detect in-progress state headers OUTSIDE the "Untracked files:"
		// section. Real `git status` prints these blocks before/after the file
		// listings, never as untracked entries; but several progress phrases
		// ("Last command done", "Next command to do", "No commands remaining")
		// are plausible filenames, so an untracked file so named would otherwise
		// be mis-read as `state: rebasing` and swallowed via the `continue`
		// below, losing the real untracked count. Gating on `!in_untracked`
		// lets such filenames fall through to the untracked path handling.
		if !in_untracked && let Some(detected) = detect_status_state(trimmed) {
			if state.is_none() {
				state = Some(detected);
			}
			continue;
		}
		if trimmed.starts_with("Changes to be committed:") {
			in_staged = true;
			in_untracked = false;
			continue;
		}
		if trimmed.starts_with("Changes not staged for commit:")
			|| trimmed.starts_with("Unmerged paths:")
		{
			in_staged = false;
			in_untracked = false;
			continue;
		}
		if trimmed.starts_with("Untracked files:") {
			in_untracked = true;
			in_staged = false;
			continue;
		}
		if parse_long_status_line(trimmed, in_staged, in_untracked, &mut summary) {
			continue;
		}
		if !trimmed.starts_with('(')
			&& !trimmed.ends_with(':')
			&& !trimmed.starts_with("use ")
			&& !trimmed.starts_with("no changes added")
			&& in_untracked
		{
			summary.untracked += 1;
			push_status_path(&mut summary, "??", trimmed);
		}
	}

	if status_has_no_signal(&summary) && state.is_none() {
		return input.to_string();
	}
	let body = format_status_summary(&summary);
	match state {
		Some(s) => {
			let mut out = String::with_capacity(7 + s.len() + 1 + body.len());
			out.push_str("state: ");
			out.push_str(s);
			out.push('\n');
			out.push_str(&body);
			out
		},
		None => body,
	}
}
fn detect_status_state(line: &str) -> Option<&str> {
	if line.starts_with("You are currently rebasing")
		// Interactive-rebase sub-states all print under the same in-progress
		// rebase header in default long-format `git status`; collapse them to
		// the single `rebasing` label so an interactive-rebase edit/split is not
		// mistaken for a clean tree. "You are currently editing a commit"/"…
		// splitting the commit" are the rebase-edit/-split phase lines, and the
		// "Last command done"/"Next command to do"/"No commands remaining"
		// progress lines accompany them.
		|| line.starts_with("You are currently editing")
		|| line.starts_with("You are currently splitting")
		|| line.starts_with("Last command done")
		|| line.starts_with("Next command to do")
		|| line.starts_with("No commands remaining")
	{
		Some("rebasing")
	} else if line.starts_with("You are currently cherry-picking") {
		Some("cherry-pick")
	} else if line.starts_with("You are currently reverting") {
		Some("revert")
	} else if line.starts_with("You are currently bisecting") {
		Some("bisect")
	} else if line.starts_with("You are in the middle of an am session") {
		Some("am")
	} else if line.starts_with("You are in a sparse checkout") {
		Some("sparse-checkout")
	} else if line.starts_with("All conflicts fixed but you are still merging") {
		// Distinct from `merge-conflict`: the merge is staged and ready to
		// conclude with `git commit`, so surface a separate "ready to commit"
		// label rather than implying unresolved conflicts.
		Some("merge (ready to commit)")
	} else if line == "You have unmerged paths." {
		Some("merge-conflict")
	} else {
		None
	}
}

fn parse_short_status_line(line: &str, summary: &mut StatusSummary) -> bool {
	let Some(status) = line.get(..2) else {
		return false;
	};
	let Some(path) = line.get(3..) else {
		return false;
	};
	if !is_short_status(status) {
		return false;
	}
	if status == "  " {
		return false;
	}
	if status == "!!" {
		return true;
	}
	if status == "??" {
		summary.untracked += 1;
	} else if status.contains('U') {
		summary.conflicts += 1;
	} else {
		let bytes = status.as_bytes();
		if bytes[0] != b' ' {
			summary.staged += 1;
		}
		if bytes[1] != b' ' {
			summary.unstaged += 1;
		}
	}
	push_status_path(summary, status.trim(), path.trim());
	true
}

fn is_short_status(status: &str) -> bool {
	status
		.bytes()
		.all(|byte| matches!(byte, b' ' | b'M' | b'A' | b'D' | b'R' | b'C' | b'U' | b'?' | b'!'))
}

fn parse_long_status_line(
	line: &str,
	in_staged: bool,
	in_untracked: bool,
	summary: &mut StatusSummary,
) -> bool {
	// `modified:`/`deleted:` are staged or unstaged depending on the active
	// section; `new file:`/`renamed:` only appear staged. The unmerged-path
	// forms are always conflicts regardless of section.
	for (prefix, label, staged) in [
		("modified:", "M", in_staged),
		("deleted:", "D", in_staged),
		("new file:", "A", true),
		("renamed:", "R", true),
		("both modified:", "UU", false),
		("both added:", "AA", false),
		("both deleted:", "DD", false),
		("added by us:", "AU", false),
		("added by them:", "UA", false),
		("deleted by us:", "DU", false),
		("deleted by them:", "UD", false),
	] {
		if let Some(path) = line.strip_prefix(prefix) {
			if matches!(label, "UU" | "AA" | "DD" | "AU" | "UA" | "DU" | "UD") {
				summary.conflicts += 1;
			} else if staged {
				summary.staged += 1;
			} else {
				summary.unstaged += 1;
			}
			push_status_path(summary, label, path.trim());
			return true;
		}
	}
	if in_untracked && !line.starts_with('(') && !line.ends_with(':') {
		summary.untracked += 1;
		push_status_path(summary, "??", line);
		return true;
	}
	false
}

fn push_status_path(summary: &mut StatusSummary, label: &str, path: &str) {
	if path.is_empty() {
		return;
	}
	summary
		.paths
		.push(format!("{label} {}", primitives::truncate_line(path, 160)));
}

const fn status_has_no_signal(summary: &StatusSummary) -> bool {
	summary.branch.is_none()
		&& summary.stash.is_none()
		&& summary.divergence.is_none()
		&& !summary.clean
		&& summary.staged == 0
		&& summary.unstaged == 0
		&& summary.untracked == 0
		&& summary.conflicts == 0
}

fn format_status_summary(summary: &StatusSummary) -> String {
	let mut out = String::new();
	if let Some(branch) = &summary.branch {
		out.push_str("branch ");
		out.push_str(branch);
		out.push('\n');
	}
	if let Some(div) = &summary.divergence {
		out.push_str(div);
		out.push('\n');
	}
	if let Some(stash) = &summary.stash {
		out.push_str(stash);
		out.push('\n');
	}
	if summary.clean && summary.paths.is_empty() {
		out.push_str("clean\n");
		return out;
	}
	out.push_str("staged ");
	out.push_str(&summary.staged.to_string());
	out.push_str(", unstaged ");
	out.push_str(&summary.unstaged.to_string());
	out.push_str(", untracked ");
	out.push_str(&summary.untracked.to_string());
	if summary.conflicts > 0 {
		out.push_str(", conflicts ");
		out.push_str(&summary.conflicts.to_string());
	}
	out.push('\n');
	for path in summary.paths.iter().take(40) {
		out.push_str(path);
		out.push('\n');
	}
	if summary.paths.len() > 40 {
		let _ = writeln!(out, "[…{} paths elided…]", summary.paths.len() - 40);
	}
	out
}

fn condense_log(input: &str, head: usize, tail: usize) -> String {
	let entries = parse_log_entries(input);
	if !entries.is_empty() {
		let mut out = String::new();
		if entries.len() <= head + tail {
			for entry in &entries {
				push_log_entry(&mut out, entry);
			}
		} else {
			for entry in entries.iter().take(head) {
				push_log_entry(&mut out, entry);
			}
			let _ = writeln!(out, "[…{} commits elided…]", entries.len() - head - tail);
			for entry in entries.iter().skip(entries.len() - tail) {
				push_log_entry(&mut out, entry);
			}
		}
		return out;
	}

	let mut out = String::new();
	for line in input.lines() {
		if let Some(commit) = line.strip_prefix("commit ") {
			out.push_str("commit ");
			if let Some(short) = commit.get(..12) {
				out.push_str(short);
			} else {
				out.push_str(commit);
			}
			out.push('\n');
		} else if !(line.trim_start().starts_with("Author:")
			|| line.trim_start().starts_with("Date:"))
		{
			out.push_str(line.trim_end());
			out.push('\n');
		}
	}
	primitives::head_tail_lines(&out, head, tail)
}

struct LogEntry {
	hash:    String,
	subject: String,
	body:    Vec<String>,
	/// Body lines dropped past the per-commit body cap, surfaced as an explicit
	/// `[…Nln elided…]` marker instead of being silently lost.
	elided:  usize,
}

/// Soft cap on rendered subject/body line width. Long commit subjects and body
/// lines are truncated through `truncate_line`, which appends a `…[+N]`
/// dropped-char marker so the elision is visible rather than silent.
const LOG_LINE_WIDTH: usize = 160;

fn push_log_entry(out: &mut String, entry: &LogEntry) {
	out.push_str(&entry.hash);
	if !entry.subject.is_empty() {
		out.push(' ');
		out.push_str(&primitives::truncate_line(&entry.subject, LOG_LINE_WIDTH));
	}
	out.push('\n');
	for line in &entry.body {
		out.push_str("  ");
		out.push_str(&primitives::truncate_line(line, LOG_LINE_WIDTH));
		out.push('\n');
	}
	if entry.elided > 0 {
		let _ = writeln!(out, "  […{}ln elided…]", entry.elided);
	}
}

fn parse_log_entries(input: &str) -> Vec<LogEntry> {
	let mut entries = Vec::new();
	let mut current: Option<LogEntry> = None;

	for line in input.lines() {
		if let Some(rest) = line.strip_prefix("commit ") {
			if let Some(entry) = current.take() {
				entries.push(entry);
			}
			let trimmed = rest.trim();
			let (hash, subject) = trimmed
				.split_once(' ')
				.map_or((trimmed, ""), |(hash, subject)| (hash, subject.trim()));
			current = Some(LogEntry {
				hash:    short_hash(hash),
				subject: subject.to_string(),
				body:    Vec::new(),
				elided:  0,
			});
			continue;
		}

		let Some(entry) = current.as_mut() else {
			continue;
		};
		let trimmed = line.trim();
		if skip_log_line(trimmed) {
			continue;
		}
		if entry.subject.is_empty() {
			entry.subject = trimmed.to_string();
		} else if !is_git_trailer(trimmed) {
			// Real (non-trailer) body lines past the 3-line cap are tallied so
			// `push_log_entry` can emit an explicit `[…Nln elided…]` marker
			// rather than dropping them silently.
			if entry.body.len() < 3 {
				entry.body.push(trimmed.to_string());
			} else {
				entry.elided += 1;
			}
		}
	}

	if let Some(entry) = current {
		entries.push(entry);
	}
	entries
}

fn short_hash(hash: &str) -> String {
	hash.chars().take(7).collect()
}

fn skip_log_line(trimmed: &str) -> bool {
	trimmed.is_empty()
		|| trimmed.starts_with("Author:")
		|| trimmed.starts_with("Date:")
		|| trimmed.starts_with("Merge:")
		|| is_log_stat_line(trimmed)
		|| trimmed.contains("files changed")
		|| trimmed.contains("file changed")
}

fn is_log_stat_line(trimmed: &str) -> bool {
	let Some((_path, stat)) = trimmed.split_once(" | ") else {
		return false;
	};
	stat
		.trim_start()
		.bytes()
		.next()
		.is_some_and(|byte| byte.is_ascii_digit())
}

fn is_git_trailer(trimmed: &str) -> bool {
	const TRAILERS: &[&str] = &[
		"Signed-off-by:",
		"Co-authored-by:",
		"Acked-by:",
		"Reviewed-by:",
		"Tested-by:",
		"Reported-by:",
		"Helped-by:",
		"Suggested-by:",
		"Change-Id:",
		"Refs:",
	];
	TRAILERS.iter().any(|prefix| trimmed.starts_with(prefix))
}

fn condense_show(input: &str) -> String {
	let Some(diff_start) = input.find("\ndiff --git ") else {
		return primitives::head_tail_lines(input, 80, 40);
	};
	let prelude = &input[..diff_start];
	let diff = &input[diff_start + 1..];
	let diff_summary = compact_diff_output(diff);
	if diff_summary == diff {
		return primitives::head_tail_lines(input, 80, 40);
	}

	let mut out = String::new();
	push_show_commit_summary(&mut out, prelude);
	if !out.is_empty() {
		out.push('\n');
	}
	out.push_str(&diff_summary);
	out
}

fn push_show_commit_summary(out: &mut String, prelude: &str) {
	let mut body_lines = 0usize;
	for line in prelude.lines() {
		let trimmed = line.trim();
		if let Some(rest) = trimmed.strip_prefix("commit ") {
			out.push_str("commit ");
			out.push_str(&short_hash(rest));
			out.push('\n');
			continue;
		}
		if skip_log_line(trimmed) || is_git_trailer(trimmed) {
			continue;
		}
		if trimmed.starts_with("diff --git") {
			break;
		}
		if body_lines >= 4 {
			continue;
		}
		out.push_str(trimmed);
		out.push('\n');
		body_lines += 1;
	}
}
/// Whether `git branch` was invoked with non-listing flags (mutations, value
/// retrieval, or config) whose output `condense_branch` would corrupt by
/// treating the output as a listing.
fn is_branch_non_listing(command: &str) -> bool {
	let tokens: Vec<&str> = command.split_whitespace().collect();
	// Find the "branch" token and scan flags after it
	let idx = tokens.iter().position(|&t| t == "branch");
	let Some(idx) = idx else { return false };
	tokens[idx + 1..].iter().any(|&tok| {
		if !tok.starts_with('-') {
			return false; // non-flag args after the command (branch names) are fine
		}
		!matches!(
			tok,
			// Listing flags — skip to allow `condense_branch` to handle them
			"--list"
				| "-l" | "--merged"
				| "--no-merged"
				| "--contains"
				| "--no-contains"
				| "--points-at"
				| "--verbose"
				| "-v" | "--all"
				| "-a" | "--remotes"
				| "-r" | "--sort"
				| "--column"
				| "--no-column"
				| "--ignore-case"
				| "--abbrev"
		)
	})
}
/// Whether `git tag` was invoked with non-listing flags (verification,
/// deletion, creation, or custom formatting) whose output `compact_listing`
/// would corrupt by treating it as a plain tag-name listing.
fn is_tag_non_listing(command: &str) -> bool {
	if !has_token(command, "tag") {
		return false;
	}

	let tokens: Vec<&str> = command.split_whitespace().collect();
	let idx = tokens.iter().position(|&t| t == "tag");
	let Some(idx) = idx else { return false };
	tokens[idx + 1..].iter().any(|&tok| {
		if !tok.starts_with('-') {
			return false;
		}
		!matches!(
			tok,
			"--list"
				| "-l" | "--contains"
				| "--no-contains"
				| "--merged"
				| "--no-merged"
				| "--points-at"
				| "--sort"
				| "--column"
				| "--no-column"
				| "--ignore-case"
		)
	})
}

/// Whether `git show` was invoked with custom output format flags that
/// `condense_show` would corrupt (pre-diff content would be truncated/
/// rewritten as commit summary).
fn is_show_custom_format(command: &str) -> bool {
	// `--format`/`--pretty` accept both space-separated (`--format fuller`) and
	// inline (`--format=%H`, `--pretty=fuller`) forms; both rewrite the commit
	// prelude that `condense_show` would otherwise truncate, so treat either
	// form as a custom format. `--diff-filter` likewise takes an inline value.
	has_flag(command, "--format")
		|| has_flag(command, "--pretty")
		|| has_flag(command, "--diff-filter")
		|| has_token(command, "--name-only")
		|| has_token(command, "--name-status")
		|| has_token(command, "--stat")
		|| has_token(command, "--numstat")
		|| has_token(command, "--shortstat")
		|| has_token(command, "--summary")
		|| has_token(command, "--check")
		|| has_token(command, "--dirstat")
}

fn is_log_custom_format(command: &str) -> bool {
	has_flag(command, "--format") || has_flag(command, "--pretty") || has_token(command, "--oneline")
}

fn condense_branch(input: &str) -> String {
	let mut current: Option<String> = None;
	let mut local = Vec::new();
	let mut remote_only = Vec::new();

	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() || trimmed.contains(" -> ") {
			continue;
		}
		let (is_current, name) = trimmed
			.strip_prefix('*')
			.map_or((false, trimmed), |rest| (true, rest.trim()));
		if name.is_empty() {
			continue;
		}
		if is_current {
			current = Some(name.to_string());
		} else if name.starts_with("remotes/") {
			remote_only.push(name.trim_start_matches("remotes/").to_string());
		} else {
			local.push(name.to_string());
		}
	}

	if current.is_none() && local.is_empty() && remote_only.is_empty() {
		return input.to_string();
	}

	let mut out = String::new();
	if let Some(current) = current.as_deref() {
		out.push_str("* ");
		out.push_str(current);
		out.push('\n');
	}
	if !local.is_empty() {
		out.push_str("local:");
		for branch in local.iter().take(24) {
			out.push(' ');
			out.push_str(branch);
		}
		if local.len() > 24 {
			out.push_str(" … +");
			out.push_str(&(local.len() - 24).to_string());
		}
		out.push('\n');
	}
	let remote_only = remote_only
		.into_iter()
		.filter(|branch| !has_local_tracking_branch(branch, current.as_deref(), &local))
		.collect::<Vec<_>>();
	if !remote_only.is_empty() {
		out.push_str("remote-only (");
		out.push_str(&remote_only.len().to_string());
		out.push_str("):");
		for branch in remote_only.iter().take(24) {
			out.push(' ');
			out.push_str(branch);
		}
		if remote_only.len() > 24 {
			out.push_str(" … +");
			out.push_str(&(remote_only.len() - 24).to_string());
		}
		out.push('\n');
	}
	out
}

fn has_local_tracking_branch(remote: &str, current: Option<&str>, local: &[String]) -> bool {
	// Only the conventional `origin/<branch>` mirror is treated as redundant with
	// a local branch of the same name. Same-named branches on other remotes
	// (e.g. `upstream/main` alongside `origin/main`) are distinct refs and must
	// be preserved in the summary.
	let Some(branch) = remote.strip_prefix("origin/") else {
		return false;
	};
	current == Some(branch) || local.iter().any(|local| local == branch)
}

struct DiffFile {
	path:    String,
	added:   usize,
	removed: usize,
	hunks:   Vec<DiffHunk>,
}

struct DiffHunk {
	header: String,
	lines:  Vec<String>,
}

pub(crate) fn compact_diff_output(input: &str) -> String {
	let files = parse_unified_diff(input);
	if files.is_empty() {
		return input.to_string();
	}

	let total_added: usize = files.iter().map(|file| file.added).sum();
	let total_removed: usize = files.iter().map(|file| file.removed).sum();
	if total_added == 0 && total_removed == 0 {
		return input.to_string();
	}

	let mut out = String::new();
	for file in files.iter().take(20) {
		let changed = file.added + file.removed;
		out.push_str(&file.path);
		out.push_str(" | ");
		out.push_str(&changed.to_string());
		out.push(' ');
		out.push_str(&diff_bar(file.added, file.removed));
		out.push('\n');
	}
	if files.len() > 20 {
		let _ = writeln!(out, "[…{} files from stat elided…]", files.len() - 20);
	}
	out.push_str(&format_file_count(files.len()));
	out.push_str(" changed, ");
	out.push_str(&total_added.to_string());
	out.push_str(" insertions(+), ");
	out.push_str(&total_removed.to_string());
	out.push_str(" deletions(-)\n\n--- Changes ---\n");

	for file in files.iter().take(12) {
		out.push('\n');
		out.push_str("File: ");
		out.push_str(&file.path);
		out.push('\n');
		for hunk in file.hunks.iter().take(8) {
			out.push_str("  ");
			out.push_str(&hunk.header);
			out.push('\n');
			for line in hunk.lines.iter().take(6) {
				out.push_str("  ");
				out.push_str(line);
				out.push('\n');
			}
			if hunk.lines.len() > 6 {
				let _ = writeln!(out, "  […{} changed lines elided…]", hunk.lines.len() - 6);
			}
		}
		if file.hunks.len() > 8 {
			let _ = writeln!(out, "  […{} hunks elided…]", file.hunks.len() - 8);
		}
	}
	if files.len() > 12 {
		let _ = writeln!(out, "\n[…{} files from changes elided…]", files.len() - 12);
	}
	out
}

fn parse_unified_diff(input: &str) -> Vec<DiffFile> {
	let mut files = Vec::new();
	let mut current: Option<DiffFile> = None;
	let mut current_hunk: Option<DiffHunk> = None;
	let mut pending_old_path: Option<String> = None;

	for line in input.lines() {
		if let Some(path) = parse_diff_git_path(line) {
			flush_hunk(&mut current, &mut current_hunk);
			if let Some(file) = current.take() {
				files.push(file);
			}
			current = Some(DiffFile { path, added: 0, removed: 0, hunks: Vec::new() });
			pending_old_path = None;
			continue;
		}
		if let Some(path) = line.strip_prefix("--- ") {
			pending_old_path = Some(path.strip_prefix("a/").unwrap_or(path).to_string());
			continue;
		}
		if let Some(path) = line.strip_prefix("+++ ") {
			let path = path.strip_prefix("b/").unwrap_or(path);
			let path = if path == "/dev/null" {
				pending_old_path.as_deref().unwrap_or(path)
			} else {
				path
			};
			flush_hunk(&mut current, &mut current_hunk);
			let update_current_path = current
				.as_ref()
				.is_some_and(|file| file.added == 0 && file.removed == 0 && file.hunks.is_empty());
			if update_current_path {
				if let Some(file) = current.as_mut() {
					file.path = path.to_string();
				}
			} else if let Some(file) = current.take() {
				files.push(file);
				current = Some(DiffFile {
					path:    path.to_string(),
					added:   0,
					removed: 0,
					hunks:   Vec::new(),
				});
			} else {
				current = Some(DiffFile {
					path:    path.to_string(),
					added:   0,
					removed: 0,
					hunks:   Vec::new(),
				});
			}
			pending_old_path = None;
			continue;
		}
		if line.starts_with("@@") {
			flush_hunk(&mut current, &mut current_hunk);
			current_hunk = Some(DiffHunk { header: line.to_string(), lines: Vec::new() });
			continue;
		}
		if line.starts_with("+++") || line.starts_with("---") {
			continue;
		}
		let Some(file) = current.as_mut() else {
			continue;
		};
		if line.starts_with('+') {
			file.added += 1;
			push_diff_line(&mut current_hunk, line);
		} else if line.starts_with('-') {
			file.removed += 1;
			push_diff_line(&mut current_hunk, line);
		}
	}

	flush_hunk(&mut current, &mut current_hunk);
	if let Some(file) = current {
		files.push(file);
	}
	files
		.into_iter()
		.filter(|file| file.added > 0 || file.removed > 0)
		.collect()
}

fn parse_diff_git_path(line: &str) -> Option<String> {
	let rest = line.strip_prefix("diff --git ")?;
	let mut parts = rest.split_whitespace();
	let _old = parts.next()?;
	let new = parts.next()?;
	Some(new.strip_prefix("b/").map_or(new, |path| path).to_string())
}

fn flush_hunk(file: &mut Option<DiffFile>, hunk: &mut Option<DiffHunk>) {
	let Some(hunk) = hunk.take() else {
		return;
	};
	if let Some(file) = file.as_mut() {
		file.hunks.push(hunk);
	}
}

fn push_diff_line(hunk: &mut Option<DiffHunk>, line: &str) {
	let Some(hunk) = hunk.as_mut() else {
		return;
	};
	hunk.lines.push(primitives::truncate_line(line, 160));
}

fn diff_bar(added: usize, removed: usize) -> String {
	let total = added + removed;
	if total == 0 {
		return String::new();
	}
	let width = total.clamp(1, 24);
	let plus = (added * width).div_ceil(total);
	let minus = width.saturating_sub(plus);
	format!("{}{}", "+".repeat(plus), "-".repeat(minus))
}

fn format_file_count(files: usize) -> String {
	if files == 1 {
		"1 file".to_string()
	} else {
		format!("{files} files")
	}
}

fn condense_noisy_output(input: &str) -> String {
	let deduped = primitives::dedup_consecutive_lines(input);
	primitives::head_tail_cap(&deduped, primitives::CapClass::Errors)
}

fn condense_commit(input: &str, exit_code: i32) -> String {
	if exit_code == 0 {
		let mut hash = None;
		let mut stat = None;
		for line in input.lines() {
			let trimmed = line.trim();
			if hash.is_none()
				&& let Some(found) = parse_commit_hash(trimmed)
			{
				hash = Some(found);
				continue;
			}
			// Default `git commit` success prints a "N files changed, …" stat line
			// below the "[branch hash] msg" line; fold it back into the summary so
			// the files/insertions signal survives the condense.
			if stat.is_none() {
				stat = parse_stat_summary(trimmed);
			}
		}
		if let Some(hash) = hash {
			return match stat {
				Some((files, added, deleted)) => {
					format!("ok {hash} ({files} files +{added} -{deleted})\n")
				},
				// `--quiet` (or otherwise stat-less) success keeps the bare hash.
				None => format!("ok {hash}\n"),
			};
		}
		// No commit hash found — likely a `--dry-run` invocation that exits 0
		// but prints a status-style listing instead of a "[branch hash]" line.
		// Preserve/condense the output rather than replacing it with bare "ok".
		return condense_noisy_output(input);
	}

	if input.contains("nothing to commit") {
		return format!("nothing to commit (exit {exit_code})\n");
	}

	condense_noisy_output(input)
}

fn parse_commit_hash(line: &str) -> Option<&str> {
	let rest = line.strip_prefix('[')?;
	let (prefix, _message) = rest.split_once(']')?;
	prefix.split_whitespace().last()
}

fn is_push_progress(line: &str) -> bool {
	let t = line.trim_start();
	t.starts_with("Enumerating objects:")
		|| t.starts_with("Counting objects:")
		|| t.starts_with("Delta compression")
		|| t.starts_with("Compressing objects:")
		|| t.starts_with("Writing objects:")
		|| t.starts_with("Total ")
}

fn is_remote_progress(line: &str) -> bool {
	let Some(rest) = line
		.trim()
		.strip_prefix("remote:")
		.or_else(|| line.trim().strip_prefix("remote: "))
	else {
		return false;
	};
	let rest = rest.trim();
	rest.starts_with("Resolving deltas:")
		|| rest.starts_with("Enumerating objects:")
		|| rest.starts_with("Counting objects:")
		|| rest.starts_with("Compressing objects:")
		|| rest.starts_with("Writing objects:")
		|| rest.starts_with("Total ")
}

fn extract_pushed_ref(line: &str) -> Option<&str> {
	if let Some((_before, after_arrow)) = line.split_once(" -> ") {
		return after_arrow.split_whitespace().next();
	}
	let deleted = line.split_once("[deleted]")?.1.trim();
	deleted.split_whitespace().next()
}

fn is_fetch_ref_update(line: &str) -> bool {
	let Some((_before, after_arrow)) = line.split_once(" -> ") else {
		return false;
	};
	after_arrow
		.split_whitespace()
		.next()
		.is_some_and(|dest| dest != "FETCH_HEAD")
}

fn condense_push(input: &str, exit_code: i32) -> String {
	let cleaned = primitives::strip_ansi(input);
	let stripped = primitives::strip_lines(&cleaned, &[is_push_progress]);

	let mut out = String::new();
	if exit_code == 0 {
		let mut pushed_ref = None;

		for line in stripped.lines() {
			let trimmed = line.trim();
			if trimmed.is_empty() {
				continue;
			}
			if is_remote_progress(trimmed) {
				continue;
			}
			// Keep remote warnings / notes (non-progress remote lines)
			if trimmed.starts_with("remote:") {
				out.push_str(line);
				out.push('\n');
				continue;
			}
			// Keep destination lines
			if trimmed.starts_with("To ") {
				out.push_str(line);
				out.push('\n');
				continue;
			}
			// Keep ref update lines: "* [new ...]", "- [deleted] ...", branch setup,
			// or "hash..hash ref -> ref"
			if trimmed.starts_with("* [new")
				|| trimmed.starts_with("- [deleted]")
				|| trimmed.starts_with("Branch ")
				|| trimmed.contains(" -> ")
			{
				if pushed_ref.is_none() {
					pushed_ref = extract_pushed_ref(trimmed);
				}
				out.push_str(line);
				out.push('\n');
			}
		}

		if out.is_empty() {
			out.push_str("ok (up-to-date)\n");
		} else if let Some(dest) = pushed_ref {
			out.push_str("ok ");
			out.push_str(dest);
			out.push('\n');
		} else {
			out.push_str("ok\n");
		}
	} else {
		// Failure: keep diagnostics, strip only progress noise
		for line in stripped.lines() {
			let trimmed = line.trim();
			if trimmed.is_empty() {
				continue;
			}
			if is_remote_progress(trimmed) {
				continue;
			}
			out.push_str(line);
			out.push('\n');
		}
	}
	out
}
fn condense_pull(input: &str, exit_code: i32) -> String {
	if exit_code == 0 {
		if input.contains("Already up to date.") || input.contains("Already up-to-date.") {
			return "ok (up-to-date)\n".to_string();
		}
		for line in input.lines() {
			let trimmed = line.trim();
			if let Some((files, added, deleted)) = parse_stat_summary(trimmed) {
				return format!("ok {files} files +{added} -{deleted}\n");
			}
		}
		return "ok\n".to_string();
	}
	condense_noisy_output(input)
}

fn condense_diff_stat(input: &str) -> String {
	let mut entries = Vec::new();
	let mut summary = None;
	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() {
			continue;
		}
		if let Some((files, added, deleted)) = parse_stat_summary(trimmed) {
			summary = Some((files, added, deleted));
			continue;
		}
		if trimmed.contains('|') {
			entries.push(primitives::truncate_line(trimmed, 140));
		}
	}

	let Some((files, added, deleted)) = summary else {
		return primitives::head_tail_cap(input, primitives::CapClass::List);
	};

	let mut out = String::new();
	let _ = writeln!(out, "git diff --stat: {files} files +{added} -{deleted}");
	for entry in entries.iter().take(20) {
		out.push_str(entry);
		out.push('\n');
	}
	if entries.len() > 20 {
		let _ = writeln!(out, "[…{} files elided…]", entries.len() - 20);
	}
	out
}

fn parse_stat_summary(line: &str) -> Option<(&str, &str, &str)> {
	// Parse "N file(s) changed, I insertion(s)(+), D deletion(s)(-)"
	// or variants with only insertions or only deletions.
	if !line.contains("file") || !line.contains("changed") {
		return None;
	}
	let mut files = "";
	let mut inserted = "0";
	let mut deleted = "0";

	for segment in line.split(", ") {
		if segment.contains("file") && segment.contains("changed") {
			files = segment.split_whitespace().next().unwrap_or("");
		} else if segment.contains("insertion") {
			inserted = segment.split_whitespace().next().unwrap_or("0");
		} else if segment.contains("deletion") {
			deleted = segment.split_whitespace().next().unwrap_or("0");
		}
	}

	if files.is_empty() {
		return None;
	}
	Some((files, inserted, deleted))
}

fn condense_fetch(input: &str, exit_code: i32) -> String {
	let cleaned = primitives::strip_ansi(input);
	let stripped = primitives::strip_lines(&cleaned, &[is_remote_progress]);

	if exit_code == 0 {
		let mut updates: usize = 0;
		let mut kept = Vec::new();

		for line in stripped.lines() {
			let trimmed = line.trim();
			if trimmed.is_empty() {
				continue;
			}
			if trimmed.starts_with("From ") || trimmed.starts_with("To ") {
				kept.push(trimmed.to_string());
				continue;
			}
			// remote: warnings/errors
			if trimmed.starts_with("remote:") && !is_remote_progress(trimmed) {
				kept.push(trimmed.to_string());
				continue;
			}
			// Branch fetch lines: " * branch       name -> FETCH_HEAD", " * [new branch]
			// name -> origin/name", or "   hash..hash name -> name"
			if trimmed.starts_with('*') || trimmed.starts_with(" *") {
				if is_fetch_ref_update(trimmed) {
					updates += 1;
				}
				kept.push(trimmed.to_string());
				continue;
			}
			if trimmed.contains(" -> ") && (trimmed.starts_with('-') || trimmed.contains("..")) {
				if is_fetch_ref_update(trimmed) {
					updates += 1;
				}
				kept.push(trimmed.to_string());
			}
			// Keep error/warning lines
			if trimmed.starts_with("error:")
				|| trimmed.starts_with("fatal:")
				|| trimmed.starts_with("warning:")
			{
				kept.push(trimmed.to_string());
			}
		}

		let mut out = String::new();
		for line in kept {
			out.push_str(&line);
			out.push('\n');
		}
		if updates == 0 {
			out.push_str("ok fetched (up-to-date)\n");
		} else {
			out.push_str("ok fetched, ");
			out.push_str(&updates.to_string());
			out.push_str(" update");
			if updates != 1 {
				out.push('s');
			}
			out.push('\n');
		}
		return out;
	}

	// Failure: keep diagnostics, dedup like old condense_noisy_output
	// Don't strip progress on failure; keep verbatim for debugging.
	let deduped = primitives::dedup_consecutive_lines(input);
	let mut out = String::new();
	for line in deduped.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() {
			continue;
		}
		out.push_str(trimmed);
		out.push('\n');
	}
	primitives::head_tail_lines(&out, 80, 40)
}

fn condense_stash(command: &str, input: &str, exit_code: i32) -> String {
	if has_token(command, "list") {
		return condense_stash_list(input);
	}
	if input.contains("No local changes to save") {
		return "No local changes to save\n".to_string();
	}
	if exit_code == 0 {
		let sub = stash_subcommand(command);
		// Bare "stash" defaults to push
		let sub = if sub.is_empty() { "push" } else { sub };
		if sub == "push" || sub == "save" {
			return "ok stashed\n".to_string();
		}
		if sub == "apply" || sub == "pop" || sub == "branch" {
			let compacted = condense_status(input);
			return if compacted == input {
				input.to_string()
			} else {
				compacted
			};
		}
		if sub == "create" {
			return input.to_string();
		}
		if sub == "drop" || sub == "clear" {
			return format!("ok stash {sub}\n");
		}
		// Default: compact listing fallback
		return primitives::compact_listing(input, 40);
	}

	condense_noisy_output(input)
}

fn condense_stash_list(input: &str) -> String {
	let mut out = String::new();
	let mut count = 0usize;
	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() {
			continue;
		}
		count += 1;
		// Format: "stash@{N}: WIP on <branch>: <hash> <message>"
		// or    : "stash@{N}: On <branch>: <hash> <message>"
		let (stash_ref, after_stash) = if let Some((stash_ref, rest)) = trimmed.split_once(": ") {
			(stash_ref, rest)
		} else {
			("", trimmed)
		};
		// Strip the "WIP on "/"On " prefix but KEEP <branch> — it's the primary
		// thing users scan a stash list for ("which branch is this stash from?").
		// Re-emit it compactly as `[branch] <message>` instead of dropping it.
		let compact = match after_stash
			.strip_prefix("WIP on ")
			.or_else(|| after_stash.strip_prefix("On "))
		{
			Some(rest) => rest.split_once(": ").map_or_else(
				|| after_stash.to_string(),
				|(branch, msg)| format!("[{}] {}", branch.trim(), msg.trim()),
			),
			None => after_stash.to_string(),
		};
		if !stash_ref.is_empty() {
			out.push_str(stash_ref);
			out.push_str(": ");
		}
		out.push_str(&compact);
		out.push('\n');
	}
	if count == 0 {
		return input.to_string();
	}
	// Remove trailing newline then add exactly one
	out.pop();
	out.push('\n');
	out
}

fn stash_subcommand(command: &str) -> &str {
	for part in command.split_whitespace() {
		match part {
			"push" | "save" | "apply" | "pop" | "drop" | "branch" | "clear" | "create" | "show"
			| "list" => return part,
			_ => {},
		}
	}
	""
}

const WORKTREE_LIMIT: usize = 20;

fn condense_worktree(input: &str) -> String {
	// Home is re-derived from the environment (never shelled out) so a leading
	// `$HOME` in worktree paths can be abbreviated to `~`. Falls back to no
	// abbreviation when `HOME` is unset.
	let home = std::env::var("HOME").unwrap_or_default();
	condense_worktree_with_home(input, &home)
}

/// Condense `git worktree` output, shape-detected from the OUTPUT rather than
/// the args so it covers both `worktree list` and bare confirmations.
///
/// Listing-shaped lines (`<abs-path> <hash> [<branch>]`, plus the `(bare)` and
/// `(detached HEAD)` variants) get a leading `$HOME` abbreviated to `~` and are
/// capped with an elided-count marker. Any non-listing output (`add`'s
/// "Preparing worktree…"/"HEAD is now at …" confirmations, errors) is left to
/// `condense_noisy_output`/passthrough so its meaning is preserved.
fn condense_worktree_with_home(input: &str, home: &str) -> String {
	let mut entries = Vec::new();
	for line in input.lines() {
		if line.trim().is_empty() {
			continue;
		}
		if !is_worktree_listing_line(line) {
			// Not a listing: confirmation / error / progress — hand off untouched.
			return condense_noisy_output(input);
		}
		entries.push(abbreviate_worktree_home(line, home));
	}

	if entries.is_empty() {
		return input.to_string();
	}

	let mut out = String::new();
	for entry in entries.iter().take(WORKTREE_LIMIT) {
		out.push_str(entry);
		out.push('\n');
	}
	if entries.len() > WORKTREE_LIMIT {
		let _ = writeln!(out, "[…{} worktrees elided…]", entries.len() - WORKTREE_LIMIT);
	}
	out
}

/// A `git worktree list` row is `<abs-path>  <hash> [<branch>]`, with the
/// trailing column being `(bare)` for a bare repo or `(detached HEAD)` for a
/// detached worktree. The discriminator: an absolute first token followed by a
/// hex hash or the literal `(bare)`.
fn is_worktree_listing_line(line: &str) -> bool {
	let mut parts = line.split_whitespace();
	let Some(path) = parts.next() else {
		return false;
	};
	if !path.starts_with('/') {
		return false;
	}
	let Some(second) = parts.next() else {
		return false;
	};
	second == "(bare)" || is_short_hex(second)
}

fn is_short_hex(token: &str) -> bool {
	token.len() >= 7 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn abbreviate_worktree_home(line: &str, home: &str) -> String {
	if home.is_empty() {
		return line.to_string();
	}
	// Only abbreviate a leading `$HOME` path prefix; a bare `$HOME` exactly is
	// rendered as `~`. Mid-line occurrences are left untouched.
	if let Some(rest) = line.strip_prefix(home)
		&& (rest.is_empty() || rest.starts_with(['/', ' ', '\t']))
	{
		return format!("~{rest}");
	}
	line.to_string()
}
