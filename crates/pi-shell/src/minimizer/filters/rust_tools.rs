use std::fmt::Write;

use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

#[must_use]
pub fn supports(program: &str, _subcommand: Option<&str>) -> bool {
	matches!(program, "rustfmt")
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	if ctx.config.legacy_filters_active() {
		return MinimizerOutput::passthrough(input);
	}

	let cleaned = primitives::strip_ansi(input);
	let text = match ctx.program {
		"rustfmt" => condense_rustfmt(&cleaned, exit_code),
		_ => cleaned,
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn condense_rustfmt(input: &str, exit_code: i32) -> String {
	if input.trim().is_empty() {
		return input.to_string();
	}

	let files: Vec<&str> = collect_diff_files(input);
	if files.is_empty() {
		if exit_code != 0 {
			return primitives::head_tail_lines(input, 80, 40);
		}
		return input.to_string();
	}

	let mut out = String::new();
	let unique: Vec<&&str> = {
		let mut seen = std::collections::BTreeSet::new();
		files.iter().filter(|f| seen.insert(**f)).collect()
	};
	let total = unique.len();
	if total == 1 {
		out.push_str("1 file needs formatting:\n");
	} else {
		let _ = writeln!(out, "{total} files need formatting:");
	}
	for file in unique.iter().take(3) {
		out.push_str("  ");
		out.push_str(file);
		out.push('\n');
	}
	if total > 3 {
		let _ = writeln!(out, "  […{} files elided…]", total - 3);
	}
	out
}

fn collect_diff_files(input: &str) -> Vec<&str> {
	let mut files = Vec::new();
	for line in input.lines() {
		if let Some(rest) = line.strip_prefix("Diff in ") {
			let rest = rest.strip_suffix(':').unwrap_or(rest);
			let path = match rest.split_once(" at line ") {
				Some((path, _)) => path,
				None => rest
					.rsplit_once(':')
					.filter(|(_, line)| line.parse::<u32>().is_ok())
					.map_or(rest, |(path, _)| path),
			};
			files.push(path);
		}
	}
	files
}
