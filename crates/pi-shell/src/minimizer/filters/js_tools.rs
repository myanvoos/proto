use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

const SUPPORTED_TOOLS: &[&str] = &["next", "prettier", "prisma"];
const NPX_ROUTABLE_TOOLS: &[&str] = &["tsc", "eslint", "prisma", "prettier", "next"];

#[must_use]
pub fn supports(program: &str, subcommand: Option<&str>) -> bool {
	effective_tool(program, subcommand).is_some()
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let tool = effective_tool(ctx.program, ctx.subcommand)
		.or_else(|| effective_tool_from_command(ctx.program, ctx.subcommand, ctx.command));
	let text = match tool {
		Some("next") => filter_next(&cleaned, exit_code),
		Some("prettier") => filter_prettier(&cleaned, exit_code),
		Some("prisma") => filter_prisma(&cleaned, exit_code),
		_ => primitives::head_tail_lines(&cleaned, 120, 80),
	};
	let text = primitives::dedup_consecutive_lines(&text);

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

#[must_use]
pub fn effective_tool<'a>(program: &'a str, subcommand: Option<&'a str>) -> Option<&'a str> {
	if SUPPORTED_TOOLS.contains(&program) {
		return Some(program);
	}
	if matches!(program, "bun")
		&& let Some(tool) = subcommand.filter(|tool| SUPPORTED_TOOLS.contains(tool))
	{
		return Some(tool);
	}
	if is_npx_like(program, subcommand) {
		let tool = subcommand?;
		if NPX_ROUTABLE_TOOLS.contains(&tool) {
			return Some(tool);
		}
	}
	None
}

fn effective_tool_from_command<'a>(
	program: &str,
	subcommand: Option<&str>,
	command: &'a str,
) -> Option<&'a str> {
	if !matches!((program, subcommand), ("bun", Some("run" | "exec"))) {
		return None;
	}
	command
		.split(|ch: char| ch.is_whitespace() || matches!(ch, ';' | '|' | '&'))
		.find(|token| SUPPORTED_TOOLS.contains(token))
}

fn is_npx_like(program: &str, subcommand: Option<&str>) -> bool {
	matches!(program, "npx" | "bunx") || matches!((program, subcommand), ("pnpm", Some("dlx")))
}

fn filter_next(input: &str, exit_code: i32) -> String {
	let mut out = String::new();
	let mut in_route_table = false;
	let mut kept_any = false;

	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() {
			if in_route_table && kept_any && !out.ends_with("\n\n") {
				out.push('\n');
			}
			continue;
		}

		if is_error_or_warning(trimmed) || is_next_summary(trimmed) {
			push_line(&mut out, trimmed);
			kept_any = true;
			continue;
		}
		if is_next_noise(trimmed) {
			continue;
		}
		if is_next_route_header(trimmed) {
			in_route_table = true;
			push_line(&mut out, trimmed);
			kept_any = true;
			continue;
		}
		if in_route_table && is_next_route_or_legend(trimmed) {
			push_line(&mut out, trimmed);
			kept_any = true;
			continue;
		}
		if exit_code != 0 && !is_spinner_frame(trimmed) {
			push_line(&mut out, trimmed);
			kept_any = true;
		}
	}

	if kept_any {
		out
	} else {
		primitives::head_tail_lines(input, 80, 80)
	}
}

fn is_next_noise(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	line.starts_with('▲')
		|| line.starts_with('-')
		|| line.starts_with('✓') && !lower.contains("error") && !lower.contains("warning")
		|| line.starts_with('○') && line.contains("Static")
		|| line.starts_with('●') && (line.contains("SSG") || line.contains("Dynamic"))
		|| line.starts_with('ƒ') && line.contains("Dynamic")
		|| lower.starts_with("creating an optimized")
		|| lower.starts_with("compiling")
		|| lower.starts_with("collecting page data")
		|| lower.starts_with("generating static pages")
		|| lower.starts_with("finalizing page optimization")
		|| lower.starts_with("collecting build traces")
		|| lower.starts_with("linting and checking")
		|| is_spinner_frame(line)
}

fn is_next_summary(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.contains("compiled successfully")
		|| lower.contains("built in ")
		|| lower.contains("compiled in ")
		|| lower.contains("failed to compile")
		|| lower.starts_with("error:")
		|| lower.starts_with("warning:")
}

fn is_next_route_header(line: &str) -> bool {
	line.starts_with("Route (") || line.starts_with("Page") && line.contains("Size")
}

fn is_next_route_or_legend(line: &str) -> bool {
	let line = trim_tree_prefix(line);
	line.starts_with('○')
		|| line.starts_with('●')
		|| line.starts_with('ƒ')
		|| line.starts_with('λ')
		|| line.starts_with('+')
		|| line.starts_with("First Load JS")
}

fn trim_tree_prefix(line: &str) -> &str {
	line.trim_start_matches(['┌', '├', '└', '─', '│', ' '])
}

fn filter_prettier(input: &str, exit_code: i32) -> String {
	if input.trim().is_empty() {
		return "Prettier: no output\n".to_string();
	}

	let mut files = Vec::new();
	let mut errors = Vec::new();
	let mut saw_check = false;
	let mut saw_write = false;
	let mut all_matched = false;

	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() {
			continue;
		}
		let lower = trimmed.to_ascii_lowercase();
		if lower.contains("checking formatting") {
			saw_check = true;
			continue;
		}
		if lower.contains("all matched files use prettier") {
			all_matched = true;
			continue;
		}
		if lower.contains("code style issues found") {
			continue;
		}
		if lower.contains("[error]") || lower.starts_with("error") {
			errors.push(trimmed.to_string());
			continue;
		}
		if lower.contains("[warn]") {
			let cleaned = trimmed.trim_start_matches("[warn]").trim();
			if looks_like_file(cleaned) {
				files.push(cleaned.to_string());
			}
			continue;
		}
		if looks_like_prettier_write_line(trimmed) {
			saw_write = true;
			if let Some(file) = trimmed.split_whitespace().next() {
				files.push(file.to_string());
			}
			continue;
		}
		if looks_like_file(trimmed) {
			files.push(trimmed.to_string());
		}
	}

	let mut out = String::new();
	if !errors.is_empty() {
		out.push_str("Prettier errors\n");
		for error in errors.iter().take(20) {
			push_line(&mut out, error);
		}
		if errors.len() > 20 {
			out.push_str("[…");
			out.push_str(&(errors.len() - 20).to_string());
			out.push_str(" errors elided…]\n");
		}
		return out;
	}

	if saw_check || exit_code != 0 {
		if files.is_empty() && all_matched && exit_code == 0 {
			return "Prettier: all files formatted\n".to_string();
		}
		if files.is_empty() && exit_code == 0 {
			return "Prettier: no formatting issues\n".to_string();
		}
		out.push_str("Prettier: ");
		out.push_str(&files.len().to_string());
		out.push_str(" file(s) need formatting\n");
		push_file_list(&mut out, &files, 30);
		return out;
	}

	if saw_write || !files.is_empty() {
		out.push_str("Prettier: ");
		out.push_str(&files.len().to_string());
		out.push_str(" file(s) written\n");
		push_file_list(&mut out, &files, 30);
		return out;
	}

	"Prettier: completed\n".to_string()
}

fn looks_like_prettier_write_line(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	line.split_whitespace().next().is_some_and(looks_like_file)
		&& (lower.contains("ms") || lower.contains("unchanged") || lower.contains("written"))
}

fn looks_like_file(line: &str) -> bool {
	let line = line.trim();
	if line.starts_with('-') || line.contains(' ') && !line.contains('/') {
		return false;
	}
	let path = line.split(':').next().map_or(line, |value| value);
	matches!(
		path.rsplit('.').next(),
		Some(
			"js"
				| "jsx" | "ts"
				| "tsx" | "json"
				| "jsonc"
				| "md" | "mdx"
				| "css" | "scss"
				| "sass" | "html"
				| "yaml" | "yml"
				| "graphql"
				| "vue" | "svelte"
		)
	)
}

fn filter_prisma(input: &str, exit_code: i32) -> String {
	let mut out = String::new();
	let mut in_schema_changes = false;

	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() {
			continue;
		}
		if is_prisma_noise(trimmed) {
			continue;
		}
		if is_prisma_schema_change_header(trimmed) {
			in_schema_changes = true;
			push_line(&mut out, trimmed);
			continue;
		}
		if in_schema_changes && is_prisma_change_line(trimmed) {
			push_line(&mut out, trimmed);
			continue;
		}
		if should_keep_prisma_line(trimmed, exit_code) {
			in_schema_changes = false;
			push_line(&mut out, trimmed);
		}
	}

	if out.is_empty() {
		primitives::head_tail_lines(input, 80, 80)
	} else {
		out
	}
}

fn is_prisma_noise(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	line
		.chars()
		.any(|ch| matches!(ch, '█' | '▀' | '▄' | '┌' | '└' | '│' | '┐' | '┘'))
		|| lower.starts_with("prisma schema loaded from")
		|| lower.starts_with("datasource ")
		|| lower.starts_with("generator ")
		|| lower.starts_with("start by importing")
		|| lower.starts_with("import { prismaclient")
		|| lower.starts_with("tips:")
		|| lower.starts_with("run prisma")
		|| lower.starts_with("running generate")
		|| lower.contains("learn more about prisma")
}

fn should_keep_prisma_line(line: &str, exit_code: i32) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.contains("generated prisma client")
		|| lower.contains("generated ") && lower.contains("@prisma/client")
		|| lower.contains("migrations")
		|| lower.contains("migration")
		|| lower.contains("database is now in sync")
		|| lower.contains("database schema is up to date")
		|| lower.contains("your database is now in sync")
		|| lower.contains("no pending migrations")
		|| lower.contains("already in sync")
		|| lower.contains("drift detected")
		|| lower.contains("failed")
		|| lower.contains("error")
		|| lower.contains("warning")
		|| lower.starts_with("applying migration")
		|| lower.starts_with("applied migration")
		|| lower.starts_with("the following migration")
		|| lower.starts_with("all migrations")
		|| lower.starts_with("pending migrations")
		|| lower.starts_with("schema pushed")
		|| exit_code != 0 && !is_spinner_frame(line)
}

fn is_prisma_schema_change_header(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.contains("the following changes") || lower.contains("changes to your database")
}

fn is_prisma_change_line(line: &str) -> bool {
	line.starts_with('+')
		|| line.starts_with('-')
		|| line.starts_with('~')
		|| line.starts_with('*')
		|| line.starts_with("CREATE ")
		|| line.starts_with("ALTER ")
		|| line.starts_with("DROP ")
		|| line.contains("CREATE TABLE")
		|| line.contains("ALTER TABLE")
		|| line.contains("DROP TABLE")
}

fn is_error_or_warning(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.contains("error")
		|| lower.contains("failed")
		|| lower.contains("warning")
		|| lower.contains("warn ")
}

fn is_spinner_frame(line: &str) -> bool {
	line
		.chars()
		.all(|ch| matches!(ch, '⠋' | '⠙' | '⠹' | '⠸' | '⠼' | '⠴' | '⠦' | '⠧' | '⠇' | '⠏' | ' '))
}

fn push_file_list(out: &mut String, files: &[String], limit: usize) {
	for file in files.iter().take(limit) {
		push_line(out, file);
	}
	if files.len() > limit {
		out.push_str("[…");
		out.push_str(&(files.len() - limit).to_string());
		out.push_str(" files elided…]\n");
	}
}

fn push_line(out: &mut String, line: &str) {
	out.push_str(line.trim_end());
	out.push('\n');
}
