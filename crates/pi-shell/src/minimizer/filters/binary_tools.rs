use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

const HEAD_LINES: usize = 50;
const TAIL_LINES: usize = 20;

#[must_use]
pub fn supports(program: &str, _subcommand: Option<&str>) -> bool {
	matches!(program, "xxd" | "strings" | "od")
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	if ctx.config.legacy_filters_active() {
		return MinimizerOutput::passthrough(input);
	}

	let cleaned = primitives::strip_ansi(input);
	let total_lines = cleaned.lines().count();
	if total_lines <= HEAD_LINES + TAIL_LINES {
		let _ = exit_code;
		return MinimizerOutput::passthrough(input);
	}

	let text = primitives::head_tail_lines(&cleaned, HEAD_LINES, TAIL_LINES);
	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}
