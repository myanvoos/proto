use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

#[must_use]
pub fn filter(_ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let text = if exit_code == 0 {
		drop_passed_lines(&cleaned)
	} else {
		failures_only(&cleaned)
	};
	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn drop_passed_lines(input: &str) -> String {
	let mut out = String::new();
	let mut summary = String::new();

	for line in input.lines() {
		let trimmed = line.trim_start();
		if is_summary_line(trimmed) {
			push_line(&mut summary, line);
			push_line(&mut out, line);
			continue;
		}

		if is_noise_line(trimmed) {
			continue;
		}
		if is_pass_noise(trimmed) {
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

fn failures_only(input: &str) -> String {
	let mut out = String::new();
	let mut keeping_block = false;
	let mut kept_failure = false;
	let mut trailing_context = 0usize;

	for line in input.lines() {
		let trimmed = line.trim_start();

		if is_noise_line(trimmed) {
			continue;
		}

		if is_summary_line(trimmed) {
			keeping_block = false;
			trailing_context = 0;
			push_line(&mut out, line);
			continue;
		}

		if starts_failure_block(trimmed) {
			keeping_block = true;
			kept_failure = true;
			trailing_context = 10;
			push_line(&mut out, line);
			continue;
		}

		if keeping_block {
			if is_pass_noise(trimmed) {
				keeping_block = false;
				trailing_context = 0;
				continue;
			}
			push_line(&mut out, line);
			if trimmed.is_empty() {
				continue;
			}
			if is_error_context_line(trimmed) {
				trailing_context = 10;
			} else if trailing_context > 0 {
				trailing_context -= 1;
			} else {
				keeping_block = false;
			}
		}
	}

	if kept_failure && has_content(&out) {
		out
	} else {
		primitives::head_tail_lines(input, 80, 80)
	}
}

fn push_line(out: &mut String, line: &str) {
	out.push_str(line);
	out.push('\n');
}

fn has_content(text: &str) -> bool {
	text.lines().any(|line| !line.trim().is_empty())
}

fn is_summary_line(trimmed: &str) -> bool {
	trimmed.starts_with("Test Suites:")
		|| trimmed.starts_with("Tests:")
		|| trimmed.starts_with("Snapshots:")
		|| trimmed.starts_with("Time:")
		|| trimmed.starts_with("Test Files")
		|| trimmed.starts_with("Duration")
		|| trimmed.starts_with("Start at")
		|| trimmed.starts_with("% ")
		|| trimmed.starts_with("Failed Tests")
		|| trimmed.starts_with("Playwright Test Report")
		|| (trimmed.starts_with("Ran ") && trimmed.contains("tests across"))
		|| starts_count_summary(trimmed)
}

fn starts_count_summary(trimmed: &str) -> bool {
	let mut parts = trimmed.split_whitespace();
	let Some(count) = parts.next() else {
		return false;
	};
	if !count.chars().all(|ch| ch.is_ascii_digit()) {
		return false;
	}
	matches!(parts.next(), Some("failed" | "passed" | "skipped" | "flaky" | "pass" | "fail"))
}

fn is_noise_line(trimmed: &str) -> bool {
	trimmed.starts_with("console.") || trimmed.starts_with("Ran all test suites")
}

fn is_pass_noise(trimmed: &str) -> bool {
	trimmed.starts_with("(pass)")
		|| trimmed.starts_with("PASS ")
		|| trimmed.starts_with("✓")
		|| trimmed.starts_with("✔")
		|| trimmed.starts_with("√")
		|| trimmed.starts_with("○")
		|| trimmed.starts_with(" RUN ")
		|| trimmed.starts_with("DEV ")
		|| trimmed.starts_with("bun test ")
		|| trimmed.ends_with(".test.ts:")
		|| trimmed.ends_with(".test.js:")
		|| trimmed.ends_with(".test.tsx:")
		|| trimmed.ends_with(".test.jsx:")
		|| trimmed.ends_with(".spec.ts:")
		|| trimmed.ends_with(".spec.js:")
}

fn starts_failure_block(trimmed: &str) -> bool {
	trimmed.starts_with("(fail)")
		|| trimmed.starts_with("FAIL ")
		|| trimmed.starts_with("FAILURES")
		|| trimmed.starts_with("Failed Tests")
		|| trimmed.starts_with("● ")
		|| trimmed.starts_with("✕")
		|| trimmed.starts_with("×")
		|| trimmed.starts_with("✗")
		|| trimmed.starts_with("❯")
		|| trimmed.starts_with("Error:")
		|| trimmed.starts_with("error:")
		|| is_code_frame_line(trimmed)
		|| trimmed.starts_with("AssertionError")
		|| trimmed.starts_with("TimeoutError")
		|| is_playwright_numbered_failure(trimmed)
}

fn is_error_context_line(trimmed: &str) -> bool {
	trimmed.is_empty()
		|| trimmed.starts_with("at ")
		|| trimmed.starts_with("→")
		|| trimmed.starts_with('>')
		|| trimmed.starts_with('|')
		|| trimmed.starts_with("Expected")
		|| trimmed.starts_with("Received")
		|| trimmed.starts_with("Error:")
		|| trimmed.starts_with("error:")
		|| trimmed.starts_with("AssertionError")
		|| trimmed.starts_with("TimeoutError")
		|| trimmed.contains(" › ")
		|| trimmed.contains(".spec.")
		|| trimmed.contains(".test.")
}

fn is_code_frame_line(trimmed: &str) -> bool {
	let rest = trimmed.strip_prefix("> ").unwrap_or(trimmed);
	let after_digits = rest.trim_start_matches(|ch: char| ch.is_ascii_digit());
	after_digits.len() < rest.len() && after_digits.starts_with(" |")
}

fn is_playwright_numbered_failure(trimmed: &str) -> bool {
	let mut chars = trimmed.chars();
	let mut saw_digit = false;
	while let Some(ch) = chars.next() {
		if ch.is_ascii_digit() {
			saw_digit = true;
			continue;
		}
		return saw_digit && ch == ')' && chars.next().is_some_and(char::is_whitespace);
	}
	false
}
