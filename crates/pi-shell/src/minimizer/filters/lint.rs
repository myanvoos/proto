//! Type-checker and linter output filters.

use std::collections::BTreeMap;

use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

#[must_use]
pub fn supports(subcommand: Option<&str>) -> bool {
	supports_program("", subcommand)
}

#[must_use]
pub fn supports_program(program: &str, subcommand: Option<&str>) -> bool {
	// Program-claim the JS type-checker/linters too: without this, a path-arg
	// invocation (`tsc --project x`, `eslint src/`, `biome ci app/`,
	// `oxlint src/`) resolves its subcommand to the path token, which is not in
	// the subcommand allowlist below, so the invocation would route UNFILTERED.
	// detect.rs yields these exact program tokens (see its
	// `detects_direct_lint_tools` test). Claiming the program makes the engine
	// pick the Rust path first; the residual defs/biome.toml & defs/oxlint.toml
	// remain as fallback for any unclaimed subcommand only.
	matches!(
		program,
		"ruff"
			| "mypy"
			| "rubocop"
			| "pyright"
			| "basedpyright"
			| "tsc"
			| "eslint"
			| "biome"
			| "oxlint"
	) || matches!(subcommand, None | Some("check" | "lint" | "run" | "format" | "fmt" | "typecheck"))
}

/// JS type-checker/linter programs whose human (non-JSON) output carries
/// code-frame body lines, underline rows, and tool-specific success/progress
/// chatter. The frame/noise strips below are gated to these programs so the
/// shared ruff/mypy/rubocop/pyright paths keep their existing behavior.
fn is_js_lint_program(program: &str) -> bool {
	matches!(program, "tsc" | "eslint" | "biome" | "oxlint")
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	if preserves_machine_readable_output(ctx) {
		return MinimizerOutput::passthrough(input);
	}

	let text = condense_lint_output(ctx.program, input, exit_code);
	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

#[must_use]
pub fn condense_lint_output(program: &str, input: &str, exit_code: i32) -> String {
	let cleaned = primitives::strip_ansi(input);
	let stripped = strip_lint_noise(program, &cleaned, exit_code);
	if program == "eslint" {
		// eslint's default "stylish" output puts the file path on its own
		// non-indented header line and the diagnostics on the following indented
		// `L:C  severity  message  rule-id` rows. group_diagnostics expects the
		// file on the SAME line as the location, so reshape stylish into
		// per-diagnostic `file:line:col: …` lines first, then derive a Top-rules
		// summary from the trailing rule-id column (rtk's idea, re-derived from
		// DEFAULT text output, not JSON).
		if let Some(rendered) = render_eslint_stylish(&stripped) {
			return primitives::head_tail_lines(&rendered, 180, 100);
		}
	}
	let grouped = group_diagnostics(&stripped);
	primitives::head_tail_lines(&grouped, 180, 100)
}

fn strip_lint_noise(program: &str, input: &str, exit_code: i32) -> String {
	let mut out = String::new();
	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() || is_lint_noise(program, trimmed, exit_code) {
			continue;
		}
		out.push_str(line.trim_end());
		out.push('\n');
	}
	out
}

fn preserves_machine_readable_output(ctx: &MinimizerCtx<'_>) -> bool {
	// pyright/basedpyright --outputjson
	if matches!(ctx.program, "pyright" | "basedpyright")
		&& ctx
			.command
			.split_whitespace()
			.any(|part| part == "--outputjson" || part.starts_with("--outputjson="))
	{
		return true;
	}
	// eslint with an explicit non-default formatter (-f / --format with value !=
	// stylish)
	if ctx.program == "eslint" {
		let tokens: Vec<&str> = ctx.command.split_whitespace().collect();
		for (i, t) in tokens.iter().enumerate() {
			if (*t == "-f" || *t == "--format") && tokens.get(i + 1).is_some_and(|v| *v != "stylish") {
				return true;
			}
			if let Some(val) = t.strip_prefix("--format=")
				&& val != "stylish"
			{
				return true;
			}
		}
	}
	false
}

fn is_lint_noise(program: &str, line: &str, exit_code: i32) -> bool {
	// eslint's `N error(s) … potentially fixable with the --fix option.` hint is
	// actionable chatter, not a diagnostic; drop it while keeping the
	// `✖ N problems (…)` summary line. Checked ahead of the diagnostic-signal
	// guard below because the hint itself contains the word "error".
	// (snip strips on `potentially fixable`.)
	if program == "eslint" && line.contains("potentially fixable") {
		return true;
	}
	// Code-frame / underline / box-drawing / progress chatter is stripped even at
	// exit!=0: these rows carry no diagnostic of their own, and oxlint's
	// `Found N warning…` / biome's `Fixed N file…` summaries match the
	// diagnostic-signal guard below only incidentally (the word "warning"). The
	// `× message` diagnostic rows are never matched here, so they survive.
	if is_js_lint_program(program) && is_js_frame_noise(program, line) {
		return true;
	}
	// pyright/basedpyright emit a version banner plus source-discovery progress
	// before the diagnostics. None of these rows carry a diagnostic, so strip them
	// even at exit!=0. Scoped to pyright/basedpyright so the other linters'
	// equivalent-looking lines (e.g. an oxlint `Found N warnings` summary) are not
	// caught here. (Ported from rtk/src/filters/basedpyright.toml strip patterns.)
	if matches!(program, "pyright" | "basedpyright") && is_pyright_banner_noise(line) {
		return true;
	}
	if exit_code != 0 && contains_diagnostic_signal(line) {
		return false;
	}
	let lower = line.to_ascii_lowercase();
	lower.starts_with("checked ")
		|| lower.starts_with("found 0")
		|| lower.starts_with("success:")
		|| lower.starts_with("all matched files")
		|| lower.starts_with("done in ")
		|| matches!(program, "eslint" | "biome") && lower.starts_with("warning: react version")
		|| matches!(program, "ruff") && lower.starts_with("all checks passed")
		|| matches!(program, "mypy") && lower.starts_with("success: no issues found")
		|| matches!(program, "pyright" | "basedpyright") && lower.starts_with("0 errors, 0 warnings")
		|| matches!(program, "rubocop")
			&& (lower.starts_with("inspecting ")
				|| lower == "offenses:"
				|| lower.ends_with(" files inspected, no offenses detected"))
}

/// pyright/basedpyright banner/progress noise: the version banner and the
/// source-file-discovery progress lines that precede the diagnostics. `line`
/// arrives already trimmed (see `strip_lint_noise`). Re-derived from
/// rtk/src/filters/basedpyright.toml's `strip_lines_matching` patterns:
///   `^Searching for source files`, `^Found \d+ source file`,
///   `^Pyright \d+\.\d+`, `^basedpyright \d+\.\d+`.
/// The blank-line pattern (`^\s*$`) is already handled by `strip_lint_noise`.
fn is_pyright_banner_noise(line: &str) -> bool {
	if line.starts_with("Searching for source files") {
		return true;
	}
	// `Pyright 1.1.0` / `basedpyright 1.22.0`: program token then a `MAJOR.MINOR`
	// version. Matched by a literal prefix plus a dotted-digit check on the rest so
	// a stray diagnostic message beginning with the word is not swept up.
	if let Some(rest) = line
		.strip_prefix("Pyright ")
		.or_else(|| line.strip_prefix("basedpyright "))
		&& starts_with_dotted_version(rest)
	{
		return true;
	}
	// `Found 42 source files`: literal prefix, then a count, then `source file`.
	if let Some(rest) = line.strip_prefix("Found ") {
		let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
		if !digits.is_empty() {
			let after = rest[digits.len()..].trim_start();
			if after.starts_with("source file") {
				return true;
			}
		}
	}
	false
}

/// True when `s` begins with `MAJOR.MINOR` (e.g. `1.22.0`, `1.1`): one or more
/// digits, a `.`, then one or more digits.
fn starts_with_dotted_version(s: &str) -> bool {
	let mut chars = s.chars().peekable();
	let mut saw_major = false;
	while let Some(&c) = chars.peek() {
		if c.is_ascii_digit() {
			saw_major = true;
			chars.next();
		} else {
			break;
		}
	}
	if !saw_major || chars.next() != Some('.') {
		return false;
	}
	matches!(chars.next(), Some(c) if c.is_ascii_digit())
}

/// Reshape eslint "stylish" output and render it through the shared grouped
/// renderer plus an eslint-specific Top-rules summary.
///
/// Returns `None` when no stylish diagnostic rows were recognized, so the
/// caller falls back to the generic grouped renderer (e.g. when eslint emitted
/// an already-flat or non-stylish shape). The reshape attributes each indented
/// `L:C  severity  message  rule-id` row to the most recent non-indented file
/// header, synthesizing a `file:line:col: severity message` line that
/// `group_diagnostics` can parse. Ungrouped lines (notably the
/// `✖ N problems (…)` summary) flow through `group_diagnostics` untouched.
fn render_eslint_stylish(stripped: &str) -> Option<String> {
	let mut current_header: Option<&str> = None;
	let mut synthesized = String::new();
	let mut passthrough = String::new();
	let mut rule_counts: BTreeMap<String, usize> = BTreeMap::new();
	let mut matched_any = false;

	for raw in stripped.lines() {
		if raw.trim().is_empty() {
			continue;
		}
		let indented = raw.starts_with(' ') || raw.starts_with('\t');
		if !indented {
			let trimmed = raw.trim_end();
			if looks_like_eslint_header(trimmed) {
				current_header = Some(trimmed);
			} else {
				// Summary lines (`✖ 3 problems (…)`) and any other non-indented,
				// non-path text are preserved verbatim for the renderer.
				passthrough.push_str(trimmed);
				passthrough.push('\n');
			}
			continue;
		}
		if let Some((loc, severity, message, rule)) = parse_eslint_row(raw.trim()) {
			matched_any = true;
			let header = current_header.unwrap_or("<unknown>");
			synthesized.push_str(header);
			synthesized.push(':');
			synthesized.push_str(loc);
			synthesized.push_str(": ");
			synthesized.push_str(severity);
			synthesized.push(' ');
			synthesized.push_str(message);
			synthesized.push('\n');
			if let Some(rule) = rule {
				*rule_counts.entry(rule.to_string()).or_default() += 1;
			}
		} else {
			passthrough.push_str(raw.trim_end());
			passthrough.push('\n');
		}
	}

	if !matched_any {
		return None;
	}

	let mut combined = synthesized;
	combined.push_str(&passthrough);
	let grouped = group_diagnostics(&combined);

	let rule_summary = format_code_summary(&rule_counts);
	if rule_summary.is_empty() {
		return Some(grouped);
	}
	let mut out = String::with_capacity(grouped.len() + rule_summary.len() + 12);
	// group_diagnostics prints `N diagnostics in M files` as the first line;
	// keep that header, then splice the eslint Top-rules summary right after it.
	let mut lines = grouped.splitn(2, '\n');
	if let Some(first) = lines.next() {
		out.push_str(first);
		out.push('\n');
		out.push_str("Top rules: ");
		out.push_str(&rule_summary);
		out.push('\n');
		if let Some(rest) = lines.next() {
			out.push_str(rest);
		}
	} else {
		out.push_str(&grouped);
	}
	Some(out)
}

/// A non-indented eslint stylish header is the file path preceding its
/// diagnostic rows. Reject summary/keyword lines so they are not mistaken for
/// file headers.
fn looks_like_eslint_header(line: &str) -> bool {
	if line.is_empty() || !looks_like_path(line) {
		return false;
	}
	let lower = line.to_ascii_lowercase();
	// Drop summary noise that also "looks like a path" (contains a dot) such as
	// `✖ 3 problems (2 errors, 1 warning)`.
	!line.starts_with('✖')
		&& !line.starts_with('×')
		&& !lower.contains("problem")
		&& !lower.contains(" error")
		&& !lower.contains(" warning")
}

/// Parse an eslint stylish diagnostic row (already trimmed of indentation):
/// `1:10  error    Unexpected var, use let or const instead  no-var`.
///
/// Returns `(location, severity, message, rule_id)`. The rule-id is the final
/// whitespace-separated token when it is a plain rule slug (`no-var`,
/// `@typescript-eslint/no-unused-vars`); rows without a trailing rule (e.g.
/// `Parsing error: Unexpected token`) yield `rule_id == None` and fold the
/// trailing text into the message.
fn parse_eslint_row(row: &str) -> Option<(&str, &str, &str, Option<&str>)> {
	let (loc, after_loc) = row.split_once(char::is_whitespace)?;
	if !is_line_col(loc) {
		return None;
	}
	let after_loc = after_loc.trim_start();
	let (severity, after_sev) = after_loc.split_once(char::is_whitespace)?;
	if !matches!(severity, "error" | "warning") {
		return None;
	}
	let body = after_sev.trim_start();
	if body.is_empty() {
		return None;
	}
	// eslint stylish separates the message from the trailing rule-id with a run of
	// >=2 spaces (`message␣␣rule-id`). Recognize the rule-id by that STRUCTURAL
	// position — the token after the last >=2-space gap — not by requiring a
	// hyphen, so hyphenless core rules (`semi`, `eqeqeq`, `camelcase`, `curly`,
	// `radix`, `complexity`) are counted and not glued onto the message text.
	// Rows with no >=2-space gap (`Parsing error: Unexpected token`) yield no
	// rule-id and keep their whole body as the message.
	if let Some((message, candidate)) = split_message_and_rule(body)
		&& is_eslint_rule_id(candidate)
	{
		return Some((loc, severity, message.trim_end(), Some(candidate)));
	}
	Some((loc, severity, body, None))
}

/// Split an eslint stylish body into `(message, rule-candidate)` at the LAST
/// run of two-or-more spaces. The rule-id column is right-aligned/space-padded
/// by eslint, so the final >=2-space gap precedes the rule slug. Returns `None`
/// when the body contains no such gap (the row carries no rule-id column).
fn split_message_and_rule(body: &str) -> Option<(&str, &str)> {
	let bytes = body.as_bytes();
	let mut idx = bytes.len();
	// Walk back to the last `"  "` (>=2 spaces) boundary; the tail after it is the
	// rule-candidate, which itself contains no internal space.
	while idx >= 2 {
		if bytes[idx - 1] == b' ' && bytes[idx - 2] == b' ' {
			let candidate = body[idx..].trim_start();
			if candidate.is_empty() || candidate.contains(' ') {
				return None;
			}
			return Some((&body[..idx - 2], candidate));
		}
		idx -= 1;
	}
	None
}

/// `line:col` location token: digits, a colon, digits.
fn is_line_col(token: &str) -> bool {
	let Some((line, col)) = token.split_once(':') else {
		return false;
	};
	!line.is_empty()
		&& !col.is_empty()
		&& line.chars().all(|ch| ch.is_ascii_digit())
		&& col.chars().all(|ch| ch.is_ascii_digit())
}

/// An eslint rule slug: lowercase letters/digits, hyphens, optional `@scope/`
/// prefix and `/` separators (`no-var`, `@typescript-eslint/no-unused-vars`,
/// and hyphenless core rules `semi`, `eqeqeq`, `camelcase`, `curly`, `radix`,
/// `complexity`). NO hyphen is required — recognition relies on the structural
/// >=2-space column split in `parse_eslint_row` plus this character-class. A
/// > leading lowercase letter excludes prose tokens that survived the split
/// > (uppercase-initial words, punctuation, trailing periods).
fn is_eslint_rule_id(token: &str) -> bool {
	let mut chars = token.chars();
	matches!(chars.next(), Some(ch) if ch.is_ascii_lowercase())
		&& chars
			.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '-' | '/' | '@'))
}

/// Code-frame / underline / tool-chatter noise specific to the JS lint family.
///
/// `line` arrives already trimmed (see `strip_lint_noise`), so leading-column
/// whitespace is gone; patterns are matched against the trimmed form. These
/// strips are deliberately gated to `tsc`/`eslint`/`biome`/`oxlint` so the
/// shared ruff/mypy/rubocop/pyright paths are unaffected.
fn is_js_frame_noise(program: &str, trimmed: &str) -> bool {
	// tsc pretty + biome/oxlint share the same caret/tilde underline rows and
	// gutter-numbered code-frame bodies; handle them for every JS lint program.
	//
	// Underline rows: only `~` (tsc) or `^` (biome/oxlint carets), optionally
	// with interior spaces, e.g. `~~~`, `^^^`, `~ ~`.
	if !trimmed.is_empty()
		&& trimmed
			.chars()
			.all(|ch| ch == '~' || ch == '^' || ch == ' ')
		&& trimmed.chars().any(|ch| ch == '~' || ch == '^')
	{
		return true;
	}
	// Code-frame body line: a leading line-number gutter followed by source.
	// biome/oxlint emit `3 │ interface Props {`; tsc pretty emits `3 foo = 1;`.
	//
	// The biome/oxlint `│`-bar gutter is unambiguous (no real summary line carries
	// a leading number then a box-drawing bar), so strip it unconditionally. The
	// tsc-pretty BARE form (`N source`, no bar) collides with genuine summary /
	// content lines that legitimately begin with a number — `7 errors and 2
	// warnings found`, `5 warnings`, `2 problems (2 errors)`, `3 files checked` —
	// so only strip the bare form when the line carries NO diagnostic signal. This
	// guards the exact information the exit!=0 diagnostic-signal gate was written
	// to protect (is_js_frame_noise runs ahead of that gate in is_lint_noise).
	if is_gutter_bar_line(trimmed) {
		return true;
	}
	if is_bare_gutter_numbered_line(trimmed) && !contains_diagnostic_signal(trimmed) {
		return true;
	}
	match program {
		"biome" => {
			// `│ ...` continuation rows (no leading number) and the post-fix
			// success summary. `Checked N files` is already covered by the
			// lowercase `checked ` rule in is_lint_noise.
			trimmed.starts_with('│') || trimmed.to_ascii_lowercase().starts_with("fixed ")
		},
		"oxlint" => {
			// Box-drawing closers and progress/summary chatter that carries no
			// diagnostic. `× rule: message` and `╭─[file:line]` are KEPT.
			trimmed.starts_with('╰')
				|| trimmed.starts_with("Finished in")
				|| trimmed.starts_with("Found ") && trimmed.contains("warning")
		},
		_ => false,
	}
}

/// True when `trimmed` is a biome/oxlint `│`-bar code-frame gutter row: a run
/// of ASCII digits, optional spaces, then the box-drawing bar `│` (`3 │
/// interface`, `12 │ items.forEach(...)`). The bar makes this form unambiguous,
/// so it is stripped unconditionally — no genuine summary line matches it.
fn is_gutter_bar_line(trimmed: &str) -> bool {
	let mut rest = trimmed;
	let digits = rest
		.find(|ch: char| !ch.is_ascii_digit())
		.unwrap_or(rest.len());
	if digits == 0 {
		return false;
	}
	rest = rest[digits..].trim_start_matches(' ');
	rest.starts_with('│')
}

/// True when `trimmed` begins with a tsc-pretty BARE line-number gutter: a run
/// of ASCII digits immediately followed by an ASCII space/tab then source
/// (`3 foo = 1;`, `10   const x: number = "hello";`). This form overlaps with
/// real summary lines that start with a number, so callers MUST additionally
/// exclude lines carrying a diagnostic signal before stripping.
fn is_bare_gutter_numbered_line(trimmed: &str) -> bool {
	let mut chars = trimmed.char_indices();
	let mut saw_digit = false;
	for (idx, ch) in chars.by_ref() {
		if ch.is_ascii_digit() {
			saw_digit = true;
			continue;
		}
		return saw_digit && idx > 0 && (ch == ' ' || ch == '\t');
	}
	false
}

#[must_use]
pub fn group_diagnostics(input: &str) -> String {
	let mut grouped: BTreeMap<String, Vec<String>> = BTreeMap::new();
	let mut ungrouped = Vec::new();
	let mut code_counts: BTreeMap<String, usize> = BTreeMap::new();

	for line in input.lines() {
		if let Some((file, rest)) = split_diagnostic(line) {
			if let Some(code) = extract_code(rest) {
				*code_counts.entry(code).or_default() += 1;
			}
			grouped
				.entry(file.to_string())
				.or_default()
				.push(rest.to_string());
		} else {
			ungrouped.push(line.to_string());
		}
	}

	if grouped.is_empty() {
		return primitives::dedup_consecutive_lines(input);
	}

	let mut files: Vec<_> = grouped.into_iter().collect();
	files.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then_with(|| a.0.cmp(&b.0)));

	let mut out = String::new();
	let diag_count: usize = files.iter().map(|(_, entries)| entries.len()).sum();
	out.push_str(&diag_count.to_string());
	out.push_str(" diagnostics in ");
	out.push_str(&files.len().to_string());
	out.push_str(" files\n");

	let code_summary = format_code_summary(&code_counts);
	if !code_summary.is_empty() {
		out.push_str("Top codes: ");
		out.push_str(&code_summary);
		out.push('\n');
	}

	for (file, entries) in files {
		out.push_str(&file);
		out.push_str(" (");
		out.push_str(&entries.len().to_string());
		out.push_str(" diagnostics)\n");
		for entry in entries.iter().take(12) {
			out.push_str("  ");
			out.push_str(&truncate_line(entry, 180));
			out.push('\n');
		}
		if entries.len() > 12 {
			out.push_str("  […");
			out.push_str(&(entries.len() - 12).to_string());
			out.push_str(" diagnostics elided…]\n");
		}
	}

	for line in ungrouped.iter().take(40) {
		out.push_str(line);
		out.push('\n');
	}
	if ungrouped.len() > 40 {
		out.push_str("[…");
		out.push_str(&(ungrouped.len() - 40).to_string());
		out.push_str(" ungrouped lines elided…]\n");
	}
	out
}

fn split_diagnostic(line: &str) -> Option<(&str, &str)> {
	if let Some((file, rest)) = split_tsc_diagnostic(line) {
		return Some((file, rest));
	}
	let (file, rest) = line.split_once(':')?;
	if !looks_like_path(file) || !starts_with_line_number(rest) {
		return None;
	}
	Some((file, rest))
}

fn split_tsc_diagnostic(line: &str) -> Option<(&str, &str)> {
	let paren = line.find('(')?;
	let close = line[paren..].find(')')? + paren;
	let file = &line[..paren];
	let loc = &line[paren + 1..close];
	if !looks_like_path(file)
		|| !loc
			.split(',')
			.all(|part| part.chars().all(|ch| ch.is_ascii_digit()))
	{
		return None;
	}
	let rest = line.get(close + 1..)?.trim_start_matches(':').trim_start();
	Some((file, rest))
}

fn looks_like_path(value: &str) -> bool {
	!value.is_empty()
		&& !value.starts_with(' ')
		&& (value.contains('/') || value.contains('.') || value.ends_with(')'))
}

fn starts_with_line_number(rest: &str) -> bool {
	let rest = rest.trim_start();
	let mut chars = rest.chars();
	let Some(first) = chars.next() else {
		return false;
	};
	first.is_ascii_digit()
}

fn extract_code(text: &str) -> Option<String> {
	for token in text.split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '-') {
		if token.len() >= 3
			&& token.chars().any(|ch| ch.is_ascii_digit())
			&& token.chars().any(|ch| ch.is_ascii_alphabetic())
		{
			return Some(token.to_string());
		}
	}
	None
}

fn format_code_summary(counts: &BTreeMap<String, usize>) -> String {
	let mut counts: Vec<_> = counts.iter().collect();
	counts.sort_by(|a, b| b.1.cmp(a.1).then_with(|| a.0.cmp(b.0)));
	counts
		.iter()
		.take(5)
		.map(|(code, count)| format!("{code} ({count}x)"))
		.collect::<Vec<_>>()
		.join(", ")
}

fn truncate_line(line: &str, max_chars: usize) -> String {
	if line.chars().count() <= max_chars {
		return line.to_string();
	}
	let mut out: String = line.chars().take(max_chars.saturating_sub(1)).collect();
	out.push('…');
	out
}

fn contains_diagnostic_signal(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.contains("error")
		|| lower.contains("warning")
		|| lower.contains("failed")
		|| lower.contains("panic")
		|| lower.contains("exception")
}
