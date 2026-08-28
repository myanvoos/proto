use std::collections::BTreeMap;

use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

#[must_use]
pub fn supports(subcommand: Option<&str>) -> bool {
	supports_program("", subcommand)
}

#[must_use]
pub fn supports_program(program: &str, subcommand: Option<&str>) -> bool {
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
	if program == "eslint"
		&& let Some(rendered) = render_eslint_stylish(&stripped)
	{
		return primitives::head_tail_lines(&rendered, 180, 100);
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
	if matches!(ctx.program, "pyright" | "basedpyright")
		&& ctx
			.command
			.split_whitespace()
			.any(|part| part == "--outputjson" || part.starts_with("--outputjson="))
	{
		return true;
	}

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
	if program == "eslint" && line.contains("potentially fixable") {
		return true;
	}

	if is_js_lint_program(program) && is_js_frame_noise(program, line) {
		return true;
	}

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

fn is_pyright_banner_noise(line: &str) -> bool {
	if line.starts_with("Searching for source files") {
		return true;
	}

	if let Some(rest) = line
		.strip_prefix("Pyright ")
		.or_else(|| line.strip_prefix("basedpyright "))
		&& starts_with_dotted_version(rest)
	{
		return true;
	}

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

fn looks_like_eslint_header(line: &str) -> bool {
	if line.is_empty() || !looks_like_path(line) {
		return false;
	}
	let lower = line.to_ascii_lowercase();

	!line.starts_with('✖')
		&& !line.starts_with('×')
		&& !lower.contains("problem")
		&& !lower.contains(" error")
		&& !lower.contains(" warning")
}

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

	if let Some((message, candidate)) = split_message_and_rule(body)
		&& is_eslint_rule_id(candidate)
	{
		return Some((loc, severity, message.trim_end(), Some(candidate)));
	}
	Some((loc, severity, body, None))
}

fn split_message_and_rule(body: &str) -> Option<(&str, &str)> {
	let bytes = body.as_bytes();
	let mut idx = bytes.len();

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

fn is_line_col(token: &str) -> bool {
	let Some((line, col)) = token.split_once(':') else {
		return false;
	};
	!line.is_empty()
		&& !col.is_empty()
		&& line.chars().all(|ch| ch.is_ascii_digit())
		&& col.chars().all(|ch| ch.is_ascii_digit())
}

fn is_eslint_rule_id(token: &str) -> bool {
	let mut chars = token.chars();
	matches!(chars.next(), Some(ch) if ch.is_ascii_lowercase())
		&& chars
			.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '-' | '/' | '@'))
}

fn is_js_frame_noise(program: &str, trimmed: &str) -> bool {
	if !trimmed.is_empty()
		&& trimmed
			.chars()
			.all(|ch| ch == '~' || ch == '^' || ch == ' ')
		&& trimmed.chars().any(|ch| ch == '~' || ch == '^')
	{
		return true;
	}

	if is_gutter_bar_line(trimmed) {
		return true;
	}
	if is_bare_gutter_numbered_line(trimmed) && !contains_diagnostic_signal(trimmed) {
		return true;
	}
	match program {
		"biome" => trimmed.starts_with('│') || trimmed.to_ascii_lowercase().starts_with("fixed "),
		"oxlint" => {
			trimmed.starts_with('╰')
				|| trimmed.starts_with("Finished in")
				|| trimmed.starts_with("Found ") && trimmed.contains("warning")
		},
		_ => false,
	}
}

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
