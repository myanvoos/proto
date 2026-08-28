//! Binary-inspection tool filters (Tier 3b): `xxd`, `strings`, `od`.
//!
//! These tools all share the same failure mode in the minimizer's
//! `unknown` bucket: very long head-or-tail-or-elide outputs (5000+
//! lines) on multi-megabyte binaries dwarf the 64 KB capture budget and
//! waste the agent's context window on repetitive hex/string dumps. We
//! preserve the first 50 lines and last 20 lines and elide the middle
//! with a count marker — diagnostic anchors (magic bytes at the head,
//! footer/trailer bytes at the tail) survive intact while the bulk
//! middle is dropped.

use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

const HEAD_LINES: usize = 50;
const TAIL_LINES: usize = 20;

#[must_use]
pub fn supports(program: &str, _subcommand: Option<&str>) -> bool {
	matches!(program, "xxd" | "strings" | "od")
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	// Kill-switch parity (M2): legacy_filters_active=true skips this
	// filter so callers can rollback without recompile.
	if ctx.config.legacy_filters_active() {
		return MinimizerOutput::passthrough(input);
	}

	let cleaned = primitives::strip_ansi(input);
	let total_lines = cleaned.lines().count();
	if total_lines <= HEAD_LINES + TAIL_LINES {
		// Short dump — passthrough. Even errored runs are tiny enough
		// here that the head/tail cap would not help.
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
