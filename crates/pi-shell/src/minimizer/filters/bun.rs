//! Bun package-manager, test-runner, and tool output filters.

use super::{cpp, generic, js_tools, lint, node_tests, pkg};
use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

const BUN_PACKAGE_SUBCOMMANDS: &[&str] = &[
	"install", "i", "add", "update", "up", "upgrade", "remove", "rm", "outdated", "pm", "audit",
	"run", "exec", "check",
];
const BUN_TEST_SUBCOMMANDS: &[&str] = &["test"];
const BUN_BUILD_SUBCOMMANDS: &[&str] = &["build"];
const BUN_TOOL_SUBCOMMANDS: &[&str] =
	&["tsc", "eslint", "biome", "next", "prettier", "prisma", "jest", "vitest", "playwright"];
const BUN_CPP_TOOL_SUBCOMMANDS: &[&str] = &["cmake", "ctest", "ninja", "gtest", "gtest-parallel"];

#[must_use]
pub fn supports(program: &str, subcommand: Option<&str>) -> bool {
	match program {
		"bun" => subcommand.is_some_and(|subcommand| {
			BUN_PACKAGE_SUBCOMMANDS.contains(&subcommand)
				|| BUN_TEST_SUBCOMMANDS.contains(&subcommand)
				|| BUN_BUILD_SUBCOMMANDS.contains(&subcommand)
				|| BUN_TOOL_SUBCOMMANDS.contains(&subcommand)
				|| BUN_CPP_TOOL_SUBCOMMANDS.contains(&subcommand)
		}),
		"bunx" => subcommand.is_some_and(|subcommand| {
			BUN_TOOL_SUBCOMMANDS.contains(&subcommand)
				|| BUN_CPP_TOOL_SUBCOMMANDS.contains(&subcommand)
		}),
		_ => false,
	}
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let subcommand = ctx.subcommand;
	if matches!((ctx.program, subcommand), ("bun", Some(subcommand)) if is_non_exec_package_subcommand(subcommand))
	{
		return pkg::filter(ctx, input, exit_code);
	}
	if is_check_invocation(ctx.program, subcommand, ctx.command) {
		return filter_bun_check(ctx, input, exit_code);
	}
	if is_test_invocation(ctx.program, subcommand, ctx.command) {
		return node_tests::filter(ctx, input, exit_code);
	}
	if is_lint_invocation(ctx.program, subcommand, ctx.command) {
		return lint::filter(ctx, input, exit_code);
	}
	if is_cpp_invocation(ctx.program, subcommand, ctx.command) {
		return cpp::filter(ctx, input, exit_code);
	}
	if is_js_tool_invocation(ctx.program, subcommand, ctx.command) {
		return js_tools::filter(ctx, input, exit_code);
	}
	match (ctx.program, subcommand) {
		("bun", Some("check")) => filter_bun_check(ctx, input, exit_code),
		("bun", Some(subcommand)) if BUN_PACKAGE_SUBCOMMANDS.contains(&subcommand) => {
			pkg::filter(ctx, input, exit_code)
		},
		("bun", Some("build")) => filter_bun_build(input, exit_code),
		_ => generic::filter(ctx, input, exit_code),
	}
}

fn is_non_exec_package_subcommand(subcommand: &str) -> bool {
	BUN_PACKAGE_SUBCOMMANDS.contains(&subcommand) && !matches!(subcommand, "run" | "exec" | "check")
}

fn is_test_invocation(program: &str, subcommand: Option<&str>, command: &str) -> bool {
	matches!(
		(program, subcommand),
		("bun", Some("test")) | ("bunx", Some("jest" | "vitest" | "playwright"))
	) || is_exec_package_subcommand(program, subcommand)
		&& command_invoked_word(command).is_some_and(|token| {
			["jest", "vitest", "playwright"].contains(&token) || is_test_script_token(token)
		})
}

fn command_invoked_word(command: &str) -> Option<&str> {
	let mut after_marker = false;
	let mut skip_option_value = false;
	for raw in command.split(|ch: char| ch.is_whitespace() || matches!(ch, ';' | '|' | '&')) {
		let token = trim_command_token(raw);
		if token.is_empty() {
			continue;
		}
		if !after_marker {
			if matches!(token, "run" | "exec") {
				after_marker = true;
			}
			continue;
		}
		if skip_option_value {
			skip_option_value = false;
			continue;
		}
		if token.starts_with('-') {
			if bun_wrapper_option_takes_value(token) && !token.contains('=') {
				skip_option_value = true;
			}
			continue;
		}
		return Some(token);
	}
	None
}

fn trim_command_token(token: &str) -> &str {
	token.trim_matches(|ch| matches!(ch, '\'' | '"' | '`'))
}

fn bun_wrapper_option_takes_value(token: &str) -> bool {
	matches!(token, "--filter" | "--cwd" | "--env-file" | "--preload" | "-F" | "-C" | "-r")
}

fn is_test_script_token(token: &str) -> bool {
	let token = trim_command_token(token);
	matches!(token, "test" | "t" | "e2e" | "spec") || token.starts_with("test:")
}

fn is_exec_package_subcommand(program: &str, subcommand: Option<&str>) -> bool {
	matches!((program, subcommand), ("bun", Some("run" | "exec")))
}

fn is_check_invocation(program: &str, subcommand: Option<&str>, command: &str) -> bool {
	is_exec_package_subcommand(program, subcommand)
		&& command_invoked_word(command).is_some_and(is_check_script_token)
}
fn is_check_script_token(token: &str) -> bool {
	let token = trim_command_token(token);
	matches!(token, "check") || token.starts_with("check:")
}

fn is_lint_script_token(token: &str) -> bool {
	let token = trim_command_token(token);
	matches!(token, "lint" | "typecheck" | "type-check")
		|| token.starts_with("lint:")
		|| token.starts_with("typecheck:")
		|| token.starts_with("type-check:")
}

fn is_lint_invocation(program: &str, subcommand: Option<&str>, command: &str) -> bool {
	matches!((program, subcommand), ("bun" | "bunx", Some("tsc" | "eslint" | "biome")))
		|| is_exec_package_subcommand(program, subcommand)
			&& command_invoked_word(command).is_some_and(|token| {
				["tsc", "eslint", "biome"].contains(&token) || is_lint_script_token(token)
			})
}

fn is_js_tool_invocation(program: &str, subcommand: Option<&str>, command: &str) -> bool {
	matches!((program, subcommand), ("bun" | "bunx", Some("next" | "prettier" | "prisma")))
		|| is_exec_package_subcommand(program, subcommand)
			&& command_invoked_word(command)
				.is_some_and(|token| ["next", "prettier", "prisma"].contains(&token))
}

fn is_cpp_invocation(program: &str, subcommand: Option<&str>, command: &str) -> bool {
	matches!((program, subcommand), ("bunx", Some(subcommand)) if BUN_CPP_TOOL_SUBCOMMANDS.contains(&subcommand))
		|| is_exec_package_subcommand(program, subcommand)
			&& command_invoked_word(command).is_some_and(|token| {
				BUN_CPP_TOOL_SUBCOMMANDS.contains(&token) || cpp::supports_invocation(token)
			})
}

fn filter_bun_check(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let text = compact_bun_check_output(ctx, &cleaned, exit_code)
		.unwrap_or_else(|| lint::condense_lint_output(ctx.program, &cleaned, exit_code));
	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn compact_bun_check_output(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> Option<String> {
	let mut root_checked = false;
	let mut packages: Vec<&str> = Vec::new();
	let mut diagnostics: Vec<&str> = Vec::new();
	let mut nonzero_exits: Vec<&str> = Vec::new();
	let mut timeout: Option<&str> = None;

	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() {
			continue;
		}
		let lower = trimmed.to_ascii_lowercase();
		if lower.contains("timeout") || lower.contains("timed out") {
			timeout = Some(trimmed);
			continue;
		}
		if trimmed.starts_with("$ ") || lower.contains(" check: $ ") {
			continue;
		}
		if let Some(package) = parse_checked_package(trimmed) {
			if !packages.contains(&package) {
				packages.push(package);
			}
			continue;
		}
		if lower.starts_with("checked ") && lower.contains("no fixes applied") {
			root_checked = true;
			continue;
		}
		if let Some(code) = parse_exited_code(trimmed) {
			if code != "0" {
				nonzero_exits.push(trimmed);
			}
			continue;
		}
		if is_bun_check_noise(trimmed, &lower) {
			continue;
		}
		if exit_code != 0 && is_important(trimmed) {
			diagnostics.push(trimmed);
		}
	}

	if !root_checked && packages.is_empty() && diagnostics.is_empty() && nonzero_exits.is_empty() {
		return None;
	}

	let mut out = String::new();
	out.push_str(command_summary(ctx.command));
	out.push_str(": ");
	if !nonzero_exits.is_empty() || !diagnostics.is_empty() {
		out.push_str("failed\n");
	} else if timeout.is_some() {
		out.push_str("visible checks passed; wrapper timed out\n");
	} else if exit_code == 0 {
		out.push_str("passed\n");
	} else {
		out.push_str("incomplete\n");
	}
	if root_checked {
		out.push_str("root biome: ok\n");
	}
	if !packages.is_empty() {
		out.push_str("packages checked: ");
		out.push_str(&packages.join(", "));
		out.push('\n');
	}
	if let Some(timeout) = timeout {
		out.push_str("timeout: ");
		out.push_str(trim_notice_brackets(timeout));
		out.push('\n');
	}
	for line in nonzero_exits.iter().chain(diagnostics.iter()).take(40) {
		out.push_str(line);
		out.push('\n');
	}
	let omitted = nonzero_exits.len() + diagnostics.len();
	if omitted > 40 {
		out.push_str("[…");
		out.push_str(&(omitted - 40).to_string());
		out.push_str(" diagnostic lines elided…]\n");
	}
	Some(out)
}

fn command_summary(command: &str) -> &str {
	let mut parts = command.split_whitespace();
	match (parts.next(), parts.next(), parts.next()) {
		(Some("bun"), Some("run"), Some(script)) => {
			script.trim_matches(|ch| matches!(ch, '\'' | '"' | '`'))
		},
		_ => "bun check",
	}
}

fn parse_checked_package(line: &str) -> Option<&str> {
	let (package, rest) = line.split_once(" check: Checked ")?;
	if rest.contains("No fixes applied") {
		Some(package)
	} else {
		None
	}
}

fn parse_exited_code(line: &str) -> Option<&str> {
	let (_, code) = line.rsplit_once("Exited with code ")?;
	Some(code.trim())
}

fn is_bun_check_noise(line: &str, lower: &str) -> bool {
	line.starts_with("$ ")
		|| lower.contains(" check: $ ")
		|| lower.starts_with("checked ")
		|| lower.ends_with("no fixes applied.")
}

fn trim_notice_brackets(line: &str) -> &str {
	line.trim_matches(|ch| matches!(ch, '[' | ']' | '⟦' | '⟧'))
}

fn filter_bun_build(input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let mut out = String::new();
	for line in cleaned.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() || is_bun_build_noise(trimmed, exit_code) {
			continue;
		}
		out.push_str(line.trim_end());
		out.push('\n');
	}
	let text = if out.trim().is_empty() {
		primitives::head_tail_lines(&cleaned, 120, 80)
	} else {
		primitives::head_tail_lines(&primitives::dedup_consecutive_lines(&out), 120, 80)
	};
	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn is_bun_build_noise(line: &str, exit_code: i32) -> bool {
	if exit_code != 0 && is_important(line) {
		return false;
	}
	let lower = line.to_ascii_lowercase();
	lower.starts_with("bun build ")
		|| lower.starts_with("bundled ") && lower.contains(" in ")
		|| lower.starts_with("transpiled ")
		|| lower.starts_with("resolving ")
		|| lower.starts_with("installing ")
		|| lower.starts_with("saved lockfile")
}

fn is_important(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.contains("error")
		|| lower.contains("failed")
		|| lower.contains("warning")
		|| lower.contains("panic")
}
