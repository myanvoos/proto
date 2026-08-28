//! JVM build-tool output filters (Apache Maven + Gradle).
//!
//! Maven side: Surefire/Failsafe block collapse, compile error/warning dedup,
//! package/install pipeline with quiet-mode toggle and phase detection. Ported
//! from rtk's `src/cmds/jvm/mvn_cmd.rs` — the execution-side concerns
//! (wrapper resolution, tee, exit propagation) do not port; this module filters
//! one already-captured buffer.
//!
//! Gradle side: strip-ansi then task-dispatched filtering. `detect_task`
//! re-tokenises the raw command to route into per-task filters —
//! `Build` / `Test` / `ConnectedTest` / `Lint` / `Dependencies` /
//! `SpringBootRun` — with an `Other` fallback for unrecognised tasks. Each
//! collapses the matching noise
//! (progress redraws, up-to-date task spam, deprecation chatter) while keeping
//! failures, reports, and resolved dependency trees.
//!
//! Replaces the deleted `defs/{maven,gradle,mvn-build}.toml` pipeline filters
//! with a Rust module capable of state-machine parsing (block collapse,
//! continuation tracking, mode toggle) that the TOML DSL cannot express.

use std::{collections::HashSet, fmt::Write as _, sync::LazyLock};

use regex::Regex;

use crate::minimizer::{
	MinimizerCtx, MinimizerOutput,
	primitives::{self, CapClass},
};

/// Cap on emitted failing test-class blocks and `[ERROR] Failures:` summary
/// entries. rtk bound this to `CAP_WARNINGS`; the minimizer's equivalent is
/// [`CapClass::Warnings`] (120).
const fn max_mvn_failing_classes() -> usize {
	CapClass::Warnings.lines()
}

// ── Shared line predicates ──────────────────────────────────────────────────
//
// Pure prefix matches are expressed as `str::starts_with` predicates rather
// than anchored regexes (clippy::trivial_regex, and faster).

/// `[INFO] Running com.example.app.FooTest`
fn is_running(line: &str) -> bool {
	line.starts_with("[INFO] Running ")
}

/// Reactor summary header opening the per-module pass/fail block.
fn is_reactor_summary(line: &str) -> bool {
	line.starts_with("[INFO] Reactor Summary for ")
}

// ── Shared regex patterns ────────────────────────────────────────────────────

/// Surefire/Failsafe per-class close line. Captures `Failures` and `Errors`.
/// Tolerates the optional `<<< FAILURE!` / `<<< ERROR!` marker (3.5.5 emits
/// `<<< FAILURE!` even for errors-only classes; `ERROR!` accepted defensively
/// for other Surefire versions; failure detection is via the captured counts,
/// not the marker). Separator is `-` (Surefire 2.x) or `--` (Surefire 3.x).
/// Prefix INFO/ERROR/WARNING (3.x emits WARNING for classes with only skipped
/// tests).
static CLOSE: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(
		r"^\[(?:INFO|ERROR|WARNING)\] Tests run: \d+, Failures: (\d+), Errors: (\d+), Skipped: \d+, Time elapsed: [^ ]+ s(?:\s+<<<\s*(?:FAILURE|ERROR)!)?\s+--?\s+in (.+)$",
	)
	.unwrap()
});

/// Final BUILD footer.
static BUILD_FOOT: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^\[(?:INFO|ERROR)\] BUILD (?:SUCCESS|FAILURE)$").unwrap());

/// `[INFO] Results:` separator before the aggregate.
static RESULTS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\[INFO\] Results:\s*$").unwrap());

/// Aggregate counts line (no `Time elapsed`, no ` - in `).
static AGG: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"^\[(?:INFO|ERROR)\] Tests run: \d+, Failures: \d+, Errors: \d+, Skipped: \d+\s*$")
		.unwrap()
});

/// Plugin banner line: `[INFO] --- plugin:goal (id) @ module ---`.
static PLUGIN_BANNER: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^\[INFO\] --- .* @ .* ---$").unwrap());

/// Module banner with project name in brackets.
static MODULE_BANNER: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^\[INFO\] -+< .+ >-+$").unwrap());

/// Compile-error coordinate substring to strip when deduping warnings/errors.
static FILE_COORD: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"/[^:]+\.java:\[\d+,\d+\]").unwrap());

// ── Dispatch ─────────────────────────────────────────────────────────────────

/// True for every Maven/Gradle program token, regardless of subcommand.
///
/// The active phase is decided inside [`filter`] by re-tokenizing the raw
/// command, never by `ctx.subcommand` (which is the FIRST non-flag arg and so
/// mis-reports the phase for `mvn clean install` — it would say `clean`).
#[must_use]
pub fn supports(program: &str, _subcommand: Option<&str>) -> bool {
	is_mvn_family(program) || is_gradle_family(program)
}

fn is_mvn_family(program: &str) -> bool {
	// Defensive `.cmd` arm in case `normalize_program` is bypassed; the
	// normalizer already maps `mvnw.cmd` -> `mvnw`.
	matches!(program, "mvn" | "mvnw" | "mvnw.cmd")
}

fn is_gradle_family(program: &str) -> bool {
	matches!(program, "gradle" | "gradlew" | "gradlew.bat")
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, _exit_code: i32) -> MinimizerOutput {
	if is_gradle_family(ctx.program) {
		return filter_gradle(ctx, input);
	}

	// Maven family.
	//
	// Verbose flags bypass filtering entirely — the user asked for full output.
	if has_verbose_flag(ctx.command) {
		return MinimizerOutput::passthrough(input);
	}

	let phase = detect_phase(ctx.command);

	// Quiet mode is orthogonal to phase: `mvn -q` suppresses all `[INFO]` lines
	// so the footer guard / `Running` markers the standard filters key off can't
	// fire. Route any non-passthrough phase to `filter_quiet`.
	let text = if phase == MvnPhase::SpringBootRun {
		// `mvn spring-boot:run` — application runtime output, not a build. The
		// banner/INFO strip + keep-list lives in `filter_spring_boot`, shared with
		// the gradle `bootRun` task.
		filter_spring_boot(&primitives::strip_ansi(input))
	} else if is_quiet(ctx.command) && phase != MvnPhase::Passthrough {
		filter_quiet(input)
	} else {
		match phase {
			MvnPhase::Test => filter_surefire(input),
			MvnPhase::Compile => filter_compile(input),
			MvnPhase::Package => filter_package(input),
			MvnPhase::Passthrough => filter_passthrough(input),
			// Unreachable: SpringBootRun handled above. Kept exhaustive.
			MvnPhase::SpringBootRun => filter_passthrough(input),
		}
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

// ── Gradle dispatch ──────────────────────────────────────────────────────────

/// Gradle/`gradlew` entry. Strips ANSI/`\r` progress first (gradle captures
/// carry both), then routes by task. Verbose flags
/// (`--stacktrace`/`--info`/`--debug`/`--full-stacktrace`) bypass filtering —
/// the user explicitly asked for full detail (adopts rtk's
/// `gradlew_cmd.rs::run` user-asked-for-detail rule).
fn filter_gradle(ctx: &MinimizerCtx<'_>, input: &str) -> MinimizerOutput {
	if has_gradle_verbose_flag(ctx.command) {
		return MinimizerOutput::passthrough(input);
	}

	let stripped = primitives::strip_ansi(input);
	let text = match detect_task(ctx.command) {
		GradleTask::Build => filter_gradle_build(&stripped),
		GradleTask::Test => filter_gradle_test(&stripped),
		GradleTask::ConnectedTest => filter_gradle_connected(&stripped),
		GradleTask::Lint => filter_gradle_lint(&stripped),
		GradleTask::Dependencies => filter_gradle_dependencies(&stripped),
		GradleTask::SpringBootRun => filter_spring_boot(&stripped),
		GradleTask::Other => filter_gradle_other(&stripped),
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

/// `--stacktrace`/`--info`/`--debug`/`--full-stacktrace` anywhere → full
/// passthrough (rtk `gradlew_cmd.rs::run`).
fn has_gradle_verbose_flag(command: &str) -> bool {
	arg_tokens(command)
		.any(|a| matches!(a, "--stacktrace" | "--info" | "--debug" | "--full-stacktrace"))
}

// ── Command-token scans (re-tokenize ctx.command) ────────────────────────────

/// Tokens of the raw command with the leading program word dropped, mirroring
/// rtk's `args` slice (which never includes the program). Splitting on
/// whitespace is sufficient for flag/goal detection; quoting subtleties do not
/// affect phase/quiet/verbose decisions.
fn arg_tokens(command: &str) -> impl Iterator<Item = &str> {
	command.split_whitespace().skip(1)
}

/// `-X`/`--debug`/`-e`/`--errors` anywhere → full passthrough.
fn has_verbose_flag(command: &str) -> bool {
	arg_tokens(command).any(|a| matches!(a, "-X" | "--debug" | "-e" | "--errors"))
}

/// `mvn -q` / `mvn --quiet` suppresses all `[INFO]` lines.
fn is_quiet(command: &str) -> bool {
	arg_tokens(command).any(|a| a == "-q" || a == "--quiet")
}

// ── Phase detection ─────────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum MvnPhase {
	Test,          // test, integration-test (Failsafe = Surefire shape)
	Compile,       // compile, test-compile
	Package,       // package, install, verify, deploy
	SpringBootRun, // spring-boot:run (application runtime, not a build)
	Passthrough,   // clean, site, plugin goals, version/help, empty
}

/// Whether `a` is a Maven lifecycle phase or plugin goal we map to a
/// `MvnPhase`.
fn is_recognized_mvn_goal(a: &str) -> bool {
	matches!(
		a,
		"test"
			| "integration-test"
			| "compile"
			| "test-compile"
			| "package"
			| "install"
			| "verify"
			| "deploy"
			| "clean"
			| "site"
			| "site-deploy"
			| "spring-boot:run"
	) || a.ends_with(":spring-boot-maven-plugin:run")
}

/// Returns non-flag tokens from the command, skipping the value token that
/// follows each known value-taking option.  This prevents option values (e.g.
/// the module name after `-pl`, the project dir after `-p`) from being
/// mistaken for build goals/tasks.
fn jvm_positional_tokens<'a>(command: &'a str, value_flags: &[&str]) -> Vec<&'a str> {
	let mut out = Vec::new();
	let mut tokens = command.split_whitespace().skip(1);
	while let Some(tok) = tokens.next() {
		if tok.starts_with('-') {
			let bare = tok.trim_start_matches('-');
			if value_flags
				.iter()
				.any(|f| f.trim_start_matches('-') == bare)
			{
				tokens.next(); // consume the value that follows this option
			}
		} else {
			out.push(tok);
		}
	}
	out
}

/// Scan args left-to-right, skip flags + `-D…` system props, pick the LAST
/// RECOGNIZED lifecycle goal, ignoring unrecognized positional tokens (e.g. the
/// module name after `-pl`).
///
/// If empty, plugin-form (`:`), or `clean`/`site` → Passthrough. Re-tokenizes
/// the raw command because `ctx.subcommand` is the FIRST non-flag arg and so
/// reports the wrong goal for `mvn clean install`.
#[must_use]
pub fn detect_phase(command: &str) -> MvnPhase {
	// Use the last RECOGNIZED lifecycle goal so that option-value tokens
	// (e.g. the module name after -pl) are ignored.
	let last = jvm_positional_tokens(command, &[
		"-pl",
		"--projects",
		"-P",
		"--activate-profiles",
		"-f",
		"--file",
		"-s",
		"--settings",
		"-gs",
		"--global-settings",
		"-t",
		"--toolchains",
		"-gt",
		"--global-toolchains",
		"-T",
		"--threads",
	])
	.into_iter()
	.rfind(|a| is_recognized_mvn_goal(a))
	.unwrap_or("");

	// `spring-boot:run` is checked BEFORE the generic `:`-plugin-goal guard
	// below: it is application runtime output, not a plugin build step, and
	// routes to the dedicated banner/keep-list filter. Match the bare goal and
	// the fully-qualified `org.springframework.boot:spring-boot-maven-plugin:run`
	// form.
	if last == "spring-boot:run" || last.ends_with(":spring-boot-maven-plugin:run") {
		return MvnPhase::SpringBootRun;
	}

	if last.is_empty() || last.contains(':') {
		return MvnPhase::Passthrough;
	}
	match last {
		"clean" | "site" | "site-deploy" => MvnPhase::Passthrough,
		"test" | "integration-test" => MvnPhase::Test,
		"compile" | "test-compile" => MvnPhase::Compile,
		"package" | "install" | "verify" | "deploy" => MvnPhase::Package,
		_ => MvnPhase::Passthrough,
	}
}

// ── Stack-frame deny-list ────────────────────────────────────────────────────

const FRAMEWORK_FRAME_PREFIXES: &[&str] = &[
	"at org.junit.",
	"at junit.",
	"at org.apache.maven.surefire.",
	"at sun.reflect.",
	"at jdk.internal.reflect.",
	"at jdk.proxy",
	"at java.base/",
	"at java.lang.reflect.",
	"at java.util.",
];

fn is_framework_frame(trimmed: &str) -> bool {
	FRAMEWORK_FRAME_PREFIXES
		.iter()
		.any(|p| trimmed.starts_with(p))
}

/// Boilerplate `[ERROR]` lines Maven emits after `Failed to execute goal` —
/// pure noise pointing at log files and help URLs, no signal for the user/LLM.
/// Deliberately excludes `[ERROR] After correcting the problems` and
/// `[ERROR]   mvn <args> -rf :…` (the resume hint is actionable signal for a
/// multi-module build) and `[ERROR] Failed to execute goal` (signal).
const BOILER_PREFIXES: &[&str] = &[
	"[ERROR] See ",
	"[ERROR] -> [Help",
	"[ERROR] To see the full stack trace",
	"[ERROR] Re-run Maven",
	"[ERROR] For more information",
	"[ERROR] [Help",
];

/// Post-failure help boilerplate, plus the bare `[ERROR]` divider lines Maven
/// emits between boilerplate blocks (same drop rules as `filter_quiet`).
fn is_boilerplate(line: &str) -> bool {
	BOILER_PREFIXES.iter().any(|p| line.starts_with(p)) || line.trim_end() == "[ERROR]"
}

/// `[ERROR] FQN.method -- Time elapsed: 0.030 s <<< FAILURE!` (or `<<<
/// ERROR!`). Distinguished from CLOSE by call position: only consulted when
/// `in_block == false` (CLOSE only occurs while a block is open).
fn is_per_test_subline(line: &str) -> bool {
	line.starts_with("[ERROR] ") && (line.contains("<<< FAILURE!") || line.contains("<<< ERROR!"))
}

// ── English-footer guard ────────────────────────────────────────────────────

fn has_english_footer(stripped: &str) -> bool {
	stripped.lines().any(|l| {
		let t = l.trim();
		t.ends_with(" BUILD SUCCESS") || t.ends_with(" BUILD FAILURE")
	})
}

// ── Outside-block keep list (shared by surefire + package) ──────────────────

/// Multi-module reactor summary keeper. Reads `in_reactor_summary` and toggles
/// it on `[INFO] Reactor Summary for …` (enter) and `BUILD SUCCESS`/`BUILD
/// FAILURE` (exit). Returns `true` for every line while the flag is set so the
/// per-module status rows survive. Returns `false` otherwise — the caller's
/// outside-block keep-list still applies.
///
/// Designed to be called **before** `keep_outside_block` so the `BUILD_FOOT`
/// clears-flag side effect always runs regardless of `||` short-circuit.
fn reactor_summary_keep(line: &str, in_reactor_summary: &mut bool) -> bool {
	if is_reactor_summary(line) {
		*in_reactor_summary = true;
		return true;
	}
	if BUILD_FOOT.is_match(line) {
		*in_reactor_summary = false;
		return false;
	}
	*in_reactor_summary
}

fn keep_outside_block(line: &str) -> bool {
	// Help boilerplate must be rejected before the `[ERROR]` catch-all below.
	if is_boilerplate(line) {
		return false;
	}
	RESULTS.is_match(line)
		|| AGG.is_match(line)
		|| BUILD_FOOT.is_match(line)
		|| MODULE_BANNER.is_match(line)
		|| line.starts_with("[INFO] Total time:")
		|| line.starts_with("[INFO] Finished at:")
		|| line.starts_with("[INFO] Building ")
		|| line.starts_with("[INFO] Scanning ")
		|| line.starts_with("[INFO] Installing ")
		|| line.starts_with("[ERROR] Failures:")
		|| line.starts_with("[ERROR] Errors:")
		|| (line.starts_with("[ERROR]") && !line.starts_with("[ERROR] Tests run:"))
		|| line.starts_with("[INFO] Building war:")
		|| line.starts_with("[INFO] Building jar:")
		|| line.starts_with("[INFO] Building ear:")
}

// ── Surefire block filter ───────────────────────────────────────────────────

/// Shared state machine driving the inner Surefire block + failure-trail
/// behaviour for `filter_surefire` and `filter_package`. Each filter wraps it
/// with its own outside-block keep logic, applied on the
/// [`SurefireStep::Passthrough`] arm.
struct SurefireBlock<'a> {
	block_lines:   Vec<&'a str>,
	block_running: Option<&'a str>,
	in_block:      bool,
	failure_trail: bool,
	/// When set together with `failure_trail`, consumes the trail without
	/// writing it to `out`. Used when the caller capped a failing block.
	drop_trail:    bool,
	/// Set when a trail ends at a blank line; holds the `drop_trail` value so
	/// the next per-test subline of the same class re-enters the trail with the
	/// same keep/drop decision.
	trail_rearm:   Option<bool>,
}

enum SurefireStep<'a> {
	/// Inner machine consumed the line; outer loop should `continue;`.
	Consumed,
	/// A CLOSE line with `Failures > 0` or `Errors > 0` was reached.
	FailingClose { running: Option<&'a str>, lines: Vec<&'a str>, close: &'a str },
	/// Inner machine did not handle the line; outer loop applies its own
	/// outside-block keep logic.
	Passthrough,
}

impl<'a> SurefireBlock<'a> {
	const fn new() -> Self {
		Self {
			block_lines:   Vec::new(),
			block_running: None,
			in_block:      false,
			failure_trail: false,
			drop_trail:    false,
			trail_rearm:   None,
		}
	}

	fn step(&mut self, line: &'a str, out: &mut String) -> SurefireStep<'a> {
		if PLUGIN_BANNER.is_match(line) {
			return SurefireStep::Consumed;
		}

		if is_running(line) {
			if self.in_block {
				self.flush_open_block_as_keep(out);
			}
			self.block_lines.clear();
			self.block_running = Some(line);
			self.in_block = true;
			self.failure_trail = false;
			// Load-bearing: a capped multi-failure class followed by a kept
			// class must not re-arm into the new class's trail decision.
			self.trail_rearm = None;
			return SurefireStep::Consumed;
		}

		if self.in_block {
			if let Some(caps) = CLOSE.captures(line) {
				let fail = caps.get(1).is_some_and(|m| m.as_str() != "0");
				let err = caps.get(2).is_some_and(|m| m.as_str() != "0");
				if fail || err {
					let lines = std::mem::take(&mut self.block_lines);
					let running = self.block_running.take();
					self.in_block = false;
					return SurefireStep::FailingClose { running, lines, close: line };
				}
				self.block_lines.clear();
				self.block_running = None;
				self.in_block = false;
				return SurefireStep::Consumed;
			}
			self.block_lines.push(line);
			return SurefireStep::Consumed;
		}

		if self.failure_trail {
			if line.is_empty() {
				if !self.drop_trail {
					out.push('\n');
				}
				// Arm re-entry: a following per-test subline belongs to the
				// same class and must inherit this trail's keep/drop decision.
				self.trail_rearm = Some(self.drop_trail);
				self.failure_trail = false;
				self.drop_trail = false;
				return SurefireStep::Consumed;
			}
			let t = line.trim_start();
			if t.starts_with("at ") && is_framework_frame(t) {
				return SurefireStep::Consumed;
			}
			if self.drop_trail {
				return SurefireStep::Consumed;
			}
			out.push_str(line);
			out.push('\n');
			return SurefireStep::Consumed;
		}

		if let Some(dropped) = self.trail_rearm {
			if line.is_empty() {
				// Tolerate extra blanks between per-test blocks: stay armed,
				// let the blank fall through (outer keep-lists drop it).
				return SurefireStep::Passthrough;
			}
			self.trail_rearm = None; // disarm unconditionally on non-blank (load-bearing)
			if is_per_test_subline(line) {
				self.failure_trail = true;
				self.drop_trail = dropped;
				if !dropped {
					out.push_str(line);
					out.push('\n');
				}
				return SurefireStep::Consumed;
			}
			// Non-subline: trail is over; already disarmed — fall through.
		}

		SurefireStep::Passthrough
	}

	/// Mark a `FailingClose` as dropped (cap exceeded). Sets `failure_trail` so
	/// the post-close trail is consumed and silently dropped until the next
	/// blank line.
	const fn drop_failing(&mut self) {
		self.failure_trail = true;
		self.drop_trail = true;
		self.trail_rearm = None;
	}

	/// Commit a `FailingClose` to `out`: writes `running`, then `lines` (with
	/// framework frames stripped), then `close`. Enables `failure_trail` so the
	/// post-close exception/user-frame trail is preserved.
	fn commit_failing(
		&mut self,
		out: &mut String,
		running: Option<&str>,
		lines: &[&str],
		close: &str,
	) {
		if let Some(r) = running {
			out.push_str(r);
			out.push('\n');
		}
		for l in lines {
			let t = l.trim_start();
			if t.starts_with("at ") && is_framework_frame(t) {
				continue;
			}
			out.push_str(l);
			out.push('\n');
		}
		out.push_str(close);
		out.push('\n');
		self.failure_trail = true;
		self.trail_rearm = None;
	}

	/// End-of-stream flush: if a block opened and never closed (truncated
	/// output), surface what we have rather than dropping it silently.
	fn finish(&mut self, out: &mut String) {
		if self.in_block {
			self.flush_open_block_as_keep(out);
		}
	}

	fn flush_open_block_as_keep(&mut self, out: &mut String) {
		if let Some(r) = self.block_running.take() {
			out.push_str(r);
			out.push('\n');
		}
		for l in self.block_lines.drain(..) {
			out.push_str(l);
			out.push('\n');
		}
		self.in_block = false;
	}
}

/// `[ERROR] Failures:` summary block cap. Maven emits a summary at the end of a
/// failing test run; on builds with hundreds of failures this can be large. Cap
/// entries at [`max_mvn_failing_classes`] and emit `\n[…N failures elided…]\n`
/// immediately before the `Tests run:` aggregate when entries were dropped.
struct FailuresSummaryCap {
	cap:        usize,
	in_summary: bool,
	emitted:    usize,
	dropped:    usize,
}

impl FailuresSummaryCap {
	const fn new(cap: usize) -> Self {
		Self { cap, in_summary: false, emitted: 0, dropped: 0 }
	}

	/// If `line` is an `[ERROR]   ` entry inside the failures summary, write it
	/// (or count it as dropped) and return `true` so the caller skips its own
	/// keep-list. Returns `false` otherwise.
	fn handle_entry(&mut self, line: &str, out: &mut String) -> bool {
		if !self.in_summary || !line.starts_with("[ERROR]   ") {
			return false;
		}
		// Per core cap policy, `0` means summary-only: no entries, tail still counts.
		if self.emitted < self.cap {
			out.push_str(line);
			out.push('\n');
			self.emitted += 1;
		} else {
			self.dropped += 1;
		}
		true
	}

	/// Detect the `[ERROR] Failures:` header so subsequent `[ERROR]   ` lines
	/// get capped. Caller writes the header to `out`.
	fn handle_header(&mut self, line: &str) {
		if line.starts_with("[ERROR] Failures:") {
			self.in_summary = true;
			self.emitted = 0;
			self.dropped = 0;
		}
	}

	/// Pre-emit the `[…N failures elided…]` tail when the aggregate
	/// `[ERROR] Tests run:` line is about to be written, then close the summary.
	fn handle_aggregate(&mut self, line: &str, out: &mut String) {
		if !self.in_summary || !AGG.is_match(line) {
			return;
		}
		if self.dropped > 0 {
			let _ = write!(out, "\n[…{} failures elided…]\n", self.dropped);
		}
		self.in_summary = false;
		self.emitted = 0;
		self.dropped = 0;
	}

	/// End-of-stream tail emission for cases where the AGG line never arrives.
	fn finish(&self, out: &mut String) {
		if self.in_summary && self.dropped > 0 {
			let _ = write!(out, "\n[…{} failures elided…]\n", self.dropped);
		}
	}
}

/// Buffered single-pass filter for `mvn test` / `mvn integration-test`.
///
/// English-footer guard: if no `BUILD SUCCESS`/`BUILD FAILURE` line is present,
/// return the ANSI-stripped raw input (non-English locale or truncated output).
#[must_use]
pub fn filter_surefire(raw: &str) -> String {
	filter_surefire_with_cap(raw, max_mvn_failing_classes())
}

fn filter_surefire_with_cap(raw: &str, cap: usize) -> String {
	let stripped = primitives::strip_ansi(raw);
	if !has_english_footer(&stripped) {
		return stripped;
	}

	let mut out = String::new();
	let mut block = SurefireBlock::new();
	let mut keep_continuation = false;
	let mut in_reactor_summary = false;
	let mut emitted_failing: usize = 0;
	let mut dropped_failing: usize = 0;
	let mut summary = FailuresSummaryCap::new(cap);

	for line in stripped.lines() {
		match block.step(line, &mut out) {
			SurefireStep::Consumed => continue,
			SurefireStep::FailingClose { running, lines, close } => {
				if emitted_failing < cap {
					block.commit_failing(&mut out, running, &lines, close);
					emitted_failing += 1;
				} else {
					block.drop_failing();
					dropped_failing += 1;
				}
				keep_continuation = false;
				continue;
			},
			SurefireStep::Passthrough => {},
		}

		if keep_continuation && (line.starts_with(' ') || line.starts_with('\t')) {
			out.push_str(line);
			out.push('\n');
			continue;
		}

		// Failures-summary cap: gate `[ERROR]   ` entries, emit `+N more` tail
		// before AGG. The helper consumes only summary entries.
		if summary.handle_entry(line, &mut out) {
			continue;
		}

		// Order matters: call reactor_summary_keep first so its BUILD_FOOT
		// clears-flag side effect always runs regardless of `||` short-circuit.
		let reactor_keep = reactor_summary_keep(line, &mut in_reactor_summary);
		if reactor_keep || keep_outside_block(line) {
			summary.handle_aggregate(line, &mut out);
			summary.handle_header(line);
			out.push_str(line);
			out.push('\n');
			keep_continuation = line.starts_with("[ERROR]")
				&& !line.starts_with("[ERROR] Tests run:")
				&& !line.starts_with("[ERROR] Failures:")
				&& !line.starts_with("[ERROR] Errors:");
			continue;
		}
		// Dropped line: reset so a stale flag can't keep an indented line that
		// follows a dropped `[ERROR]` line.
		keep_continuation = false;
	}

	block.finish(&mut out);
	summary.finish(&mut out);
	if dropped_failing > 0 {
		let _ = write!(out, "\n[…{dropped_failing} failing test classes elided…]\n");
	}
	out
}

// ── Compile filter ──────────────────────────────────────────────────────────

/// Buffered single-pass filter for `mvn compile` / `test-compile`.
///
/// Keeps module banners, `[INFO] Building …`, `[INFO] BUILD …`, totals, finish
/// time, scanning line, and `[ERROR]` blocks with indented continuation
/// (`symbol:` / `location:` / caret). Deduplicates `[WARNING]` lines by
/// normalised message (strip file coordinates).
pub fn filter_compile(raw: &str) -> String {
	let stripped = primitives::strip_ansi(raw);
	if !has_english_footer(&stripped) {
		return stripped;
	}

	let mut out = String::new();
	let mut keep_continuation = false;
	let mut seen_warnings: HashSet<String> = HashSet::new();

	for line in stripped.lines() {
		if MODULE_BANNER.is_match(line) {
			out.push_str(line);
			out.push('\n');
			keep_continuation = false;
			continue;
		}
		if BUILD_FOOT.is_match(line)
			|| line.starts_with("[INFO] Building ")
			|| line.starts_with("[INFO] Total time:")
			|| line.starts_with("[INFO] Finished at:")
			|| line.starts_with("[INFO] Scanning ")
		{
			out.push_str(line);
			out.push('\n');
			keep_continuation = false;
			continue;
		}
		// Help boilerplate: drop before the `[ERROR]` catch-all.
		if is_boilerplate(line) {
			keep_continuation = false;
			continue;
		}
		if line.starts_with("[ERROR]") {
			out.push_str(line);
			out.push('\n');
			keep_continuation = true;
			continue;
		}
		if keep_continuation && (line.starts_with(' ') || line.starts_with('\t')) {
			out.push_str(line);
			out.push('\n');
			continue;
		}
		if line.starts_with("[WARNING]") {
			let payload = line.strip_prefix("[WARNING] ").unwrap_or(line);
			let norm = FILE_COORD.replace_all(payload, "").to_string();
			if seen_warnings.insert(norm) {
				out.push_str(line);
				out.push('\n');
			}
			keep_continuation = false;
			continue;
		}
		// Drop everything else.
		keep_continuation = false;
	}

	out
}

// ── Package filter ──────────────────────────────────────────────────────────

/// Buffered single-pass filter for `mvn package`/`install`/`verify`/`deploy`.
///
/// Mode toggle: starts in compile mode, switches to Surefire when a
/// `[INFO] Running …` line is seen (via [`SurefireBlock`]). Outside any
/// Surefire block, applies the unified keep-list (compile keepers +
/// install/artifact lines).
#[must_use]
pub fn filter_package(raw: &str) -> String {
	filter_package_with_cap(raw, max_mvn_failing_classes())
}

fn filter_package_with_cap(raw: &str, cap: usize) -> String {
	let stripped = primitives::strip_ansi(raw);
	if !has_english_footer(&stripped) {
		return stripped;
	}

	let mut out = String::new();
	let mut block = SurefireBlock::new();
	let mut keep_continuation = false;
	let mut in_reactor_summary = false;
	let mut seen_warnings: HashSet<String> = HashSet::new();
	let mut emitted_failing: usize = 0;
	let mut dropped_failing: usize = 0;
	let mut summary = FailuresSummaryCap::new(cap);

	for line in stripped.lines() {
		match block.step(line, &mut out) {
			SurefireStep::Consumed => continue,
			SurefireStep::FailingClose { running, lines, close } => {
				if emitted_failing < cap {
					block.commit_failing(&mut out, running, &lines, close);
					emitted_failing += 1;
				} else {
					block.drop_failing();
					dropped_failing += 1;
				}
				keep_continuation = false;
				continue;
			},
			SurefireStep::Passthrough => {},
		}

		if summary.handle_entry(line, &mut out) {
			continue;
		}

		// Order matters: call reactor_summary_keep first so its BUILD_FOOT
		// clears-flag side effect always runs regardless of `||` short-circuit.
		let reactor_keep = reactor_summary_keep(line, &mut in_reactor_summary);
		// Outside any Surefire block: compile-keep AND surefire-outside-keep merge.
		if reactor_keep || MODULE_BANNER.is_match(line) || keep_outside_block(line) {
			summary.handle_aggregate(line, &mut out);
			summary.handle_header(line);
			out.push_str(line);
			out.push('\n');
			keep_continuation = line.starts_with("[ERROR]")
				&& !line.starts_with("[ERROR] Tests run:")
				&& !line.starts_with("[ERROR] Failures:")
				&& !line.starts_with("[ERROR] Errors:");
			continue;
		}
		if keep_continuation && (line.starts_with(' ') || line.starts_with('\t')) {
			out.push_str(line);
			out.push('\n');
			continue;
		}
		if line.starts_with("[WARNING]") {
			let payload = line.strip_prefix("[WARNING] ").unwrap_or(line);
			let norm = FILE_COORD.replace_all(payload, "").to_string();
			if seen_warnings.insert(norm) {
				out.push_str(line);
				out.push('\n');
			}
			keep_continuation = false;
			continue;
		}
		keep_continuation = false;
	}

	block.finish(&mut out);
	summary.finish(&mut out);
	if dropped_failing > 0 {
		let _ = write!(out, "\n[…{dropped_failing} failing test classes elided…]\n");
	}
	out
}

// ── Quiet-mode filter ───────────────────────────────────────────────────────

/// Filter for `mvn -q` invocations.
///
/// Under `-q`, Maven 3.x suppresses all `[INFO]` lines, so the standard
/// filters (which key off the English `BUILD SUCCESS` footer and `[INFO]
/// Running` markers) can't fire. This filter handles the residual `-q` shape:
/// green run → empty; failure run keeps the close-line, per-test subline,
/// exception class, user-code frames, failure summary, and the `Failed to
/// execute goal` terminator; drops framework frames and help boilerplate.
pub fn filter_quiet(raw: &str) -> String {
	let stripped = primitives::strip_ansi(raw);
	if stripped.trim().is_empty() {
		return String::new();
	}

	let mut out = String::new();
	let mut failure_trail = false;

	for line in stripped.lines() {
		// Surefire close-line for a failed class — keep + enter failure trail.
		if CLOSE.is_match(line) {
			out.push_str(line);
			out.push('\n');
			failure_trail = line.contains("<<< FAILURE!") || line.contains("<<< ERROR!");
			continue;
		}

		// Per-test failure subline.
		if is_per_test_subline(line) {
			out.push_str(line);
			out.push('\n');
			failure_trail = true;
			continue;
		}

		// Failure-trail body: exception class, user-code frames; drop framework frames.
		if failure_trail {
			if line.trim().is_empty() {
				out.push('\n');
				failure_trail = false;
				continue;
			}
			let t = line.trim_start();
			if t.starts_with("at ") && is_framework_frame(t) {
				continue;
			}
			out.push_str(line);
			out.push('\n');
			continue;
		}

		// Failure summary keepers.
		if line.starts_with("[ERROR] Tests run:")
			|| line.starts_with("[ERROR] Failures:")
			|| line.starts_with("[ERROR] Errors:")
			|| line.starts_with("[ERROR]   ")
			|| line.starts_with("[ERROR] Failed to execute goal")
		{
			out.push_str(line);
			out.push('\n');
			continue;
		}

		// Drop post-failure help boilerplate and bare `[ERROR]` dividers.
		if is_boilerplate(line) {
			continue;
		}

		// Safety net: keep anything else (unexpected output under `-q` is rare).
		out.push_str(line);
		out.push('\n');
	}

	out
}

// ── Passthrough phase (stateless maven.toml-equivalent strip + cap) ──────────

/// Passthrough phase (`clean`, `site`, plugin goals, `--version`, `--help`).
///
/// rtk ran these as raw passthrough, but the deleted `maven.toml` overlay used
/// to strip download/progress/banner noise on top. To preserve the minimizer's
/// current advantage we replicate that stateless strip here plus a [`CapClass`]
/// cap. (Verbose `-X`/`--debug`/`-e`/`--errors` already short-circuited to a
/// true passthrough before reaching this function.)
fn filter_passthrough(raw: &str) -> String {
	let stripped = primitives::strip_ansi(raw);
	let filtered = primitives::strip_lines(&stripped, &[is_passthrough_noise]);
	primitives::head_tail_cap(&filtered, CapClass::List)
}

/// maven.toml's `strip_lines_matching` set, expressed as a predicate:
/// `Downloading`/`Downloaded`/`Progress`, the `[INFO] -+` / `[INFO] --- ` /
/// `[INFO] Building ` / `[INFO] Scanning for projects` banner noise, and bare
/// `[INFO]` lines.
fn is_passthrough_noise(line: &str) -> bool {
	line.starts_with("[INFO] Downloading ")
		|| line.starts_with("[INFO] Downloaded ")
		|| line.starts_with("[INFO] --- ")
		|| line.starts_with("[INFO] Building ")
		|| line.starts_with("[INFO] Scanning for projects")
		|| line.starts_with("Progress ")
		|| line.trim_end() == "[INFO]"
		|| is_info_dash_banner(line)
}

/// `^\[INFO\] -+` — the all-dashes separator / module-banner shells.
fn is_info_dash_banner(line: &str) -> bool {
	let Some(rest) = line.strip_prefix("[INFO] ") else {
		return false;
	};
	rest.starts_with('-')
		&& rest
			.chars()
			.all(|c| c == '-' || c == '<' || c == '>' || c == ' ')
		|| (rest.starts_with('-') && rest.chars().take_while(|&c| c != ' ').all(|c| c == '-'))
}

// ═══════════════════════════════════════════════════════════════════════════
// GRADLE SIDE
//
// Ported from rtk `src/cmds/jvm/gradlew_cmd.rs`. The execution-side `run()`
// dispatcher and `StreamFilter` wrappers drop away: the minimizer filters one
// already-captured buffer, so each rtk per-line `StreamFilter` predicate is
// applied directly over the buffer's lines. Gradle captures carry ANSI colour
// and `\r` progress redraws, so every entry point strips ANSI first.
// ═══════════════════════════════════════════════════════════════════════════

// ── Gradle shared patterns ───────────────────────────────────────────────────

/// `^> Task :` — gradle task-progress lines. Pure literal-anchored, so a
/// `starts_with` (not a regex) keeps `clippy::trivial_regex` happy and is
/// faster.
fn is_gradle_task_line(line: &str) -> bool {
	line.starts_with("> Task :")
}

/// `^\* Try:|^> Run with --|^> Get more help at` (rtk `TRY_SECTION`). The
/// post-failure help block — pure noise pointing at flags and help URLs.
fn is_gradle_try_section(line: &str) -> bool {
	line.starts_with("* Try:")
		|| line.starts_with("> Run with --")
		|| line.starts_with("> Get more help at")
}

/// `^BUILD (SUCCESSFUL|FAILED)` (rtk `BUILD_STATUS`).
fn is_gradle_build_status(line: &str) -> bool {
	line.starts_with("BUILD SUCCESSFUL") || line.starts_with("BUILD FAILED")
}

/// `^\d+ actionable tasks?` (rtk `ACTIONABLE`).
static GRADLE_ACTIONABLE: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^\d+ actionable tasks?").unwrap());

// ── Task detection ───────────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum GradleTask {
	Build,
	Test,
	ConnectedTest,
	Lint,
	Dependencies,
	SpringBootRun,
	Other,
}

/// Pick the filter for a gradle invocation by re-tokenizing `ctx.command`.
///
/// Ported from rtk `gradlew_cmd.rs::detect_task` (~31-64). Uses the FIRST
/// recognized task token, lowercased — tasks appear before option-value tokens
/// such as `--tests FooSpec`, so `.find()` on recognized tasks avoids matching
/// option-values. Adapted to take the raw command string instead of rtk's
/// `&[String]` args slice (the minimizer never holds a parsed args vector); the
/// leading program word is dropped by [`arg_tokens`], matching rtk's args slice
/// which never includes the program.
///
/// `bootRun` is checked first so it routes to the dedicated Spring Boot runtime
/// filter (rtk handled `spring-boot:run`/`bootRun` via a separate command).
pub fn detect_task(command: &str) -> GradleTask {
	// Use the FIRST recognized task token to ignore option-value tokens that
	// follow --tests, --rerun, etc. (e.g. "gradle test --tests FooSpec" → Test).
	// When find returns None we need to distinguish two cases:
	//   • no non-flag non-clean tokens at all  → only `clean` was given → Build
	//   • non-flag non-clean tokens existed but none recognized → unrecognized task
	// → Other
	let mut non_clean_tokens = jvm_positional_tokens(command, &[
		"-p",
		"--project-dir",
		"-P",
		"--project-prop",
		"-g",
		"--gradle-user-home",
		"--settings-file",
		"-b",
		"--build-file",
		"--init-script",
		"-I",
		"--max-workers",
		"-c",
		"--configuration-file",
		"--project-cache-dir",
	])
	.into_iter()
	.map(str::to_lowercase)
	.filter(|a| a != "clean")
	.peekable();
	let had_tokens = non_clean_tokens.peek().is_some();
	let task = non_clean_tokens
		.find(|a| {
			a.contains("bootrun")
				|| a.contains("connected")
				|| a.contains("test")
				|| a.contains("assemble")
				|| a.contains("build")
				|| a.contains("bundle")
				|| a.contains("install")
				|| a.contains("lint")
				|| a.contains("ktlint")
				|| a.contains("detekt")
				|| a == "check"
				|| a.contains("dependencies")
		})
		.unwrap_or_default();

	if task.contains("bootrun") {
		GradleTask::SpringBootRun
	} else if task.contains("connected") {
		GradleTask::ConnectedTest
	} else if task.contains("test") {
		GradleTask::Test
	} else if task.contains("assemble")
		|| task.contains("build")
		|| task.contains("bundle")
		|| task.contains("install")
	{
		GradleTask::Build
	} else if task.contains("lint") || task.contains("ktlint") || task.contains("detekt") {
		GradleTask::Lint
	} else if task == "check" {
		GradleTask::Test
	} else if task.contains("dependencies") {
		GradleTask::Dependencies
	} else if had_tokens {
		// Non-flag non-clean tokens existed but none were recognized → unrecognized
		// task (e.g. `gradlew signingReport`). Rtk parity: fall through to Other.
		GradleTask::Other
	} else {
		// No non-flag non-clean tokens at all — only `clean` was passed (filtered
		// out above) → treat as Build to filter task noise (rtk parity).
		GradleTask::Build
	}
}

// ── Build filter (rtk gradlew_cmd.rs::filter_build_line ~179-216) ────────────

/// Daemon/lifecycle chatter prefixes (rtk `DAEMON_LINE` alternation, expressed
/// as literal prefixes).
const GRADLE_DAEMON_PREFIXES: &[&str] = &[
	"Starting a Gradle Daemon",
	"Daemon will be stopped",
	"Reusing configuration cache",
	"Calculating task graph",
	"> Configure project",
	"Deprecated Gradle features",
	"You can use",
	"For more on this",
	"Configuration cache entry",
];

/// `^\s*\d+%|^Downloading|^Configuring|^Resolving|^\[Incubating\]|^Wrote HTML
/// report|^class \S+ could not|^\[android-` (rtk `PROGRESS`). The
/// percentage-progress and `class … could not` shapes need a regex; kept
/// verbatim from rtk.
static GRADLE_PROGRESS: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(
		r"^\s*\d+%|^Downloading|^Configuring|^Resolving|^\[Incubating\]|^Wrote HTML report|^class \S+ could not|^\[android-",
	)
	.unwrap()
});

/// `(?i)(^FAILURE:|^\* What went wrong:|^\* Where:|> Could not|e:
/// |error:|^Execution failed|Lint found \d+ error)` (rtk `ERROR_LINE`).
static GRADLE_ERROR_LINE: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(
		r"(?i)(^FAILURE:|^\* What went wrong:|^\* Where:|> Could not|e: |error:|^Execution failed|Lint found \d+ error)",
	)
	.unwrap()
});

/// `^(w: |warning:|Warning:|WARNING:)` (rtk `WARN_LINE`): kotlinc `w: `,
/// javac/gradle `warning:`/`Warning:`.
static GRADLE_WARN_LINE: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^(w: |warning:|Warning:|WARNING:)").unwrap());

/// `gradle\.com/s/|Publishing build scan` (rtk `BUILD_SCAN`).
fn is_gradle_build_scan(line: &str) -> bool {
	line.contains("gradle.com/s/") || line.contains("Publishing build scan")
}

/// Per-line keep predicate for Build mode (rtk `filter_build_line`).
///
/// Strips daemon/progress/`> Task :`/try-section lines (INCLUDING
/// `> Task :x FAILED` — the `FAILURE:`/`What went wrong` block below carries
/// the signal, a deliberate donor decision), keeps build status / actionable /
/// errors / warnings / build-scan URLs, and preserves blank lines that separate
/// error sections.
fn keep_gradle_build_line(line: &str) -> bool {
	// Always strip these.
	if is_gradle_task_line(line)
		|| GRADLE_DAEMON_PREFIXES.iter().any(|p| line.starts_with(p))
		|| GRADLE_PROGRESS.is_match(line)
		|| is_gradle_try_section(line)
	{
		return false;
	}

	// Always keep these.
	//
	// Beyond rtk's `filter_build_line` keepers, the test-summary and
	// `Test result:` lines are also kept: the deleted `defs/gradle.toml` (a
	// strip-only filter) and snip's `gradlew-bat.yaml` both surfaced them, and a
	// `> Task :test`-only Build invocation otherwise drops its sole failure
	// signal. Task-progress `> Task :x FAILED` lines are still dropped — the
	// strip guard above runs first, so this broader keep side cannot resurrect
	// them (a deliberate donor decision: the `FAILURE:` block carries the
	// signal).
	is_gradle_build_status(line)
		|| GRADLE_ACTIONABLE.is_match(line)
		|| GRADLE_ERROR_LINE.is_match(line)
		|| GRADLE_WARN_LINE.is_match(line)
		|| is_gradle_build_scan(line)
		|| GRADLE_TEST_SUMMARY.is_match(line)
		|| line.contains("Test result")
		|| line.trim().is_empty()
}

fn filter_gradle_build(input: &str) -> String {
	let mut out: Vec<&str> = Vec::new();
	for line in input.lines() {
		if keep_gradle_build_line(line) {
			out.push(line);
		}
	}
	join_lines(&out)
}

// ── Test filter (rtk gradlew_cmd.rs::filter_test ~230-302) ───────────────────

/// `FAILED$| FAILED ` (rtk `FAILED_LINE`).
static GRADLE_FAILED_LINE: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"FAILED$| FAILED ").unwrap());

/// ` PASSED$| SKIPPED$` (rtk `PASSED_SKIPPED`).
static GRADLE_PASSED_SKIPPED: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r" PASSED$| SKIPPED$").unwrap());

/// `\d+ tests? completed|\d+ tests? failed|There were failing tests|See the
/// report at` (rtk `SUMMARY_LINE`). The "See the report at" arm keeps the
/// actionable HTML-report pointer.
static GRADLE_TEST_SUMMARY: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"\d+ tests? completed|\d+ tests? failed|There were failing tests|See the report at")
		.unwrap()
});

/// True if an `at …` stack frame belongs to a test framework (`JUnit`, Gradle
/// runner, reflection) rather than user code. Ported from rtk
/// `gradlew_cmd.rs::is_framework_frame` — DISTINCT from the Maven-side
/// [`is_framework_frame`] (gradle includes `org.gradle.`, excludes
/// `org.apache.maven.surefire.`/`java.base/`/`java.util.`).
fn is_gradle_framework_frame(trimmed: &str) -> bool {
	trimmed.starts_with("at org.junit.")
		|| trimmed.starts_with("at junit.")
		|| trimmed.starts_with("at java.lang.reflect.")
		|| trimmed.starts_with("at sun.reflect.")
		|| trimmed.starts_with("at org.gradle.")
}

/// Test-mode filter (rtk `filter_test`).
///
/// Keeps failing test lines, the exception class+message, and the FIRST
/// user-code frame only (a deliberate aggressive choice vs the Maven side's
/// all-frames trail — donor behaviour kept). Strips `PASSED`/`SKIPPED` per-test
/// lines, `> Task :`, and the try-section. Empty output emits the rtk hint
/// message rather than an empty buffer the generic OK path can't enrich.
fn filter_gradle_test(input: &str) -> String {
	if input.is_empty() {
		return String::new();
	}

	let mut result_lines: Vec<&str> = Vec::new();
	let mut in_failure_block = false;

	for line in input.lines() {
		// Always-noise lines.
		if is_gradle_task_line(line) || is_gradle_try_section(line) {
			continue;
		}

		// Build summary lines always kept.
		if is_gradle_build_status(line)
			|| GRADLE_ACTIONABLE.is_match(line)
			|| GRADLE_TEST_SUMMARY.is_match(line)
		{
			result_lines.push(line);
			continue;
		}

		// PASSED/SKIPPED per-test lines — strip.
		if GRADLE_PASSED_SKIPPED.is_match(line) {
			in_failure_block = false;
			continue;
		}

		// FAILED per-test lines — keep + enter failure block for the stack trace.
		if GRADLE_FAILED_LINE.is_match(line) {
			in_failure_block = true;
			result_lines.push(line);
			continue;
		}

		// Stack-trace lines following a failure.
		if in_failure_block {
			let trimmed = line.trim();
			if trimmed.starts_with("at ") {
				// Stack frame: skip framework frames, keep first user-code frame then close.
				if !is_gradle_framework_frame(trimmed) {
					result_lines.push(line);
					in_failure_block = false;
				}
			} else if !trimmed.is_empty() {
				// Exception class, message line, or assertion detail — keep it.
				// (Covers java.*, kotlin.*, org.opentest4j.*, and message lines.)
				result_lines.push(line);
			}
			// blank lines in failure block: skip (implicit fall-through)
		}
	}

	let filtered = join_lines(&result_lines);

	// Guarantee non-empty, signal-rich output.
	if filtered.trim().is_empty() {
		if input.contains("BUILD SUCCESSFUL") {
			return "ok ✓ (no test output — add testLogging to build.gradle for details)".to_string();
		}
		return input.trim().to_string();
	}

	filtered
}

// ── Connected / instrumented test filter (rtk ~306-350) ──────────────────────

/// `^INSTRUMENTATION_STATUS[_CODE]*:` (rtk `INSTRUMENTATION_STATUS` — the
/// character-class form matches `INSTRUMENTATION_STATUS:` and
/// `INSTRUMENTATION_STATUS_CODE:`).
static GRADLE_INSTRUMENTATION_STATUS: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^INSTRUMENTATION_STATUS[_CODE]*:").unwrap());

/// `^Starting \d+ tests? on ` (rtk `STARTING_TESTS`).
static GRADLE_STARTING_TESTS: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^Starting \d+ tests? on ").unwrap());

/// `ConnectedTest` filter (rtk `filter_connected`). Strips Android
/// instrumentation noise, then delegates the surviving PASSED/FAILED-shaped
/// output to [`filter_gradle_test`].
fn filter_gradle_connected(input: &str) -> String {
	if input.is_empty() {
		return String::new();
	}

	// Special case: no device.
	if input.contains("No connected devices!") {
		return "connectedAndroidTest failed: No connected devices! Start an emulator or connect a \
		        device."
			.to_string();
	}

	let mut result_lines: Vec<&str> = Vec::new();
	for line in input.lines() {
		if GRADLE_INSTRUMENTATION_STATUS.is_match(line)
			|| line.starts_with("INSTRUMENTATION_RESULT:")
			|| line.starts_with("INSTRUMENTATION_CODE:")
			|| GRADLE_STARTING_TESTS.is_match(line)
			|| line.starts_with("Installing APK")
			|| is_gradle_task_line(line)
			|| is_gradle_try_section(line)
		{
			continue;
		}
		result_lines.push(line);
	}

	// After stripping instrumentation noise, connected output uses the same
	// PASSED/FAILED format as unit tests — delegate.
	let joined = join_lines(&result_lines);
	let filtered = filter_gradle_test(&joined);

	if filtered.trim().is_empty() {
		return "ok ✓ (connected tests passed)".to_string();
	}
	filtered
}

// ── Lint filter (rtk ~354-432) ───────────────────────────────────────────────

/// `[^:]+:\d+:.*[Ee]rror:.*\[` (rtk `ANDROID_LINT_ERROR`).
static GRADLE_ANDROID_LINT_ERROR: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"[^:]+:\d+:.*[Ee]rror:.*\[").unwrap());

/// `[^:]+:\d+:.*[Ww]arning:.*\[` (rtk `ANDROID_LINT_WARNING`).
static GRADLE_ANDROID_LINT_WARNING: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"[^:]+:\d+:.*[Ww]arning:.*\[").unwrap());

/// `[^:]+:\d+:\d+:.*[Ll]int` (rtk `KTLINT_VIOLATION`).
static GRADLE_KTLINT_VIOLATION: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"[^:]+:\d+:\d+:.*[Ll]int").unwrap());

/// `[^:]+:\d+:\d+:.*error` (rtk `DETEKT_VIOLATION`).
static GRADLE_DETEKT_VIOLATION: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"[^:]+:\d+:\d+:.*error").unwrap());

/// `\d+ (issues?|errors?|warnings?)` (rtk lint `SUMMARY_LINE`).
static GRADLE_LINT_SUMMARY: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"\d+ (issues?|errors?|warnings?)").unwrap());

/// `Wrote (HTML|XML|text) report|file://|/build/reports/lint` (rtk
/// `REPORT_LINE`): long report-path lines to strip.
static GRADLE_LINT_REPORT: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"Wrote (HTML|XML|text) report|file://|/build/reports/lint").unwrap()
});

/// Lint-mode filter (rtk `filter_lint`). Keeps Android-lint / ktlint / detekt
/// violations and summaries, strips report-path lines and `> Task :`/try
/// noise. Android-lint violations carry a multi-line code-snippet + caret +
/// explanation block, separated from the next violation by a blank line; up to
/// 3 non-empty context lines are kept (cross-line state) so the LLM sees the
/// offending code without opening the file.
fn filter_gradle_lint(input: &str) -> String {
	if input.is_empty() {
		return String::new();
	}

	const MAX_CONTEXT_LINES: usize = 3;

	let mut result_lines: Vec<&str> = Vec::new();
	let mut context_remaining: usize = 0;

	for line in input.lines() {
		if is_gradle_task_line(line)
			|| is_gradle_try_section(line)
			|| GRADLE_LINT_REPORT.is_match(line)
		{
			context_remaining = 0;
			continue;
		}

		let is_android_lint =
			GRADLE_ANDROID_LINT_ERROR.is_match(line) || GRADLE_ANDROID_LINT_WARNING.is_match(line);

		if is_gradle_build_status(line)
			|| GRADLE_ACTIONABLE.is_match(line)
			|| GRADLE_LINT_SUMMARY.is_match(line)
			|| is_android_lint
			|| GRADLE_KTLINT_VIOLATION.is_match(line)
			|| GRADLE_DETEKT_VIOLATION.is_match(line)
		{
			result_lines.push(line);
			// Only Android-lint violations carry multi-line context; ktlint/detekt
			// /summary lines are single-line.
			context_remaining = if is_android_lint {
				MAX_CONTEXT_LINES
			} else {
				0
			};
			continue;
		}

		if context_remaining > 0 {
			if line.trim().is_empty() {
				// Blank line terminates the context block.
				context_remaining = 0;
			} else {
				result_lines.push(line);
				context_remaining -= 1;
			}
		}
	}

	let filtered = join_lines(&result_lines);

	if filtered.trim().is_empty() {
		if input.contains("BUILD SUCCESSFUL") {
			return "ok ✓ lint passed".to_string();
		}
		return input.trim().to_string();
	}

	filtered
}

// ── Dependencies filter (rtk ~436-526) ───────────────────────────────────────

/// Cap on top-level dependencies emitted per configuration. rtk bound this to
/// `CAP_LIST` (20); the minimizer's equivalent is [`CapClass::List`] (80).
const fn max_gradle_deps() -> usize {
	CapClass::List.lines()
}

/// Dependencies-mode filter (rtk `filter_dependencies`). Aggregates the gradle
/// dependency tree into a per-configuration table of TOP-LEVEL deps only
/// (transitive `|    +---` / `     \---` rows are dropped), capped at
/// [`max_gradle_deps`].
fn filter_gradle_dependencies(input: &str) -> String {
	if input.is_empty() {
		return String::new();
	}

	let mut configs: Vec<(String, Vec<String>)> = Vec::new();
	let mut current_config = String::new();
	let mut current_deps: Vec<String> = Vec::new();
	let mut total_deps = 0usize;

	for line in input.lines() {
		let trimmed = line.trim();

		// Skip noise.
		if trimmed.is_empty()
			|| is_gradle_task_line(trimmed)
			|| is_gradle_try_section(trimmed)
			|| is_gradle_build_status(trimmed)
			|| GRADLE_ACTIONABLE.is_match(trimmed)
			|| trimmed.starts_with("Downloading")
			|| trimmed.starts_with("Download ")
			|| trimmed.starts_with("Starting a Gradle")
			|| trimmed == "No dependencies"
			|| trimmed == "(n)"
		{
			continue;
		}

		// Configuration header: "compileClasspath - Compile classpath …". Not
		// indented, not a tree line, contains " - ".
		if !trimmed.starts_with('+')
			&& !trimmed.starts_with('|')
			&& !trimmed.starts_with('\\')
			&& !trimmed.starts_with(' ')
			&& trimmed.contains(" - ")
		{
			if !current_config.is_empty() && !current_deps.is_empty() {
				configs.push((current_config.clone(), current_deps.clone()));
			}
			current_config = trimmed.split(" - ").next().unwrap_or(trimmed).to_string();
			current_deps = Vec::new();
			continue;
		}

		// Top-level dependencies only (first level of the tree). Check the
		// UNTRIMMED line — top-level deps start at column 0; transitive deps are
		// indented (`|    +---` or `     \---`).
		if (line.starts_with("+---") || line.starts_with("\\---")) && !current_config.is_empty() {
			let dep = trimmed
				.trim_start_matches("+--- ")
				.trim_start_matches("\\--- ")
				.to_string();
			current_deps.push(dep);
			total_deps += 1;
		}
	}

	// Flush last config.
	if !current_config.is_empty() && !current_deps.is_empty() {
		configs.push((current_config, current_deps));
	}

	if configs.is_empty() {
		if input.contains("BUILD SUCCESSFUL") {
			return "ok ✓ no dependencies".to_string();
		}
		return input.trim().to_string();
	}

	let mut result =
		format!("{} top-level dependencies across {} configurations\n", total_deps, configs.len());

	let cap = max_gradle_deps();
	for (config, deps) in &configs {
		let _ = write!(result, "\n{} ({}):\n", config, deps.len());
		for dep in deps.iter().take(cap) {
			let _ = writeln!(result, "  {dep}");
		}
		if deps.len() > cap {
			let _ = writeln!(result, "  […{} dependencies elided…]", deps.len() - cap);
		}
	}

	result.trim_end().to_string()
}

// ── Other-task filter (light Build-style strip) ──────────────────────────────

/// Filter for gradle tasks that match no specialised category (rtk ran these as
/// raw passthrough). A light Build-style daemon/progress/`> Task :` strip is
/// strictly better than rtk's raw passthrough while keeping every non-noise
/// line — we cannot know which lines carry signal for an unknown task, so the
/// keep side is intentionally permissive: only daemon/progress/task-progress
/// noise is dropped. Verbose flags already short-circuited to passthrough.
fn filter_gradle_other(input: &str) -> String {
	let mut out: Vec<&str> = Vec::new();
	for line in input.lines() {
		if is_gradle_task_line(line)
			|| GRADLE_DAEMON_PREFIXES.iter().any(|p| line.starts_with(p))
			|| GRADLE_PROGRESS.is_match(line)
		{
			continue;
		}
		out.push(line);
	}
	join_lines(&out)
}

// ── Carried-over deleted-def: gradle.toml UP-TO-DATE strip
// ────────────────────
//
// The deleted `defs/gradle.toml` stripped `> Task :…UP-TO-DATE`/`NO-SOURCE`
// /`FROM-CACHE` and daemon chatter. `keep_gradle_build_line` already drops all
// `> Task :` lines (a superset of UP-TO-DATE/NO-SOURCE/FROM-CACHE), the
// Configure/daemon lines, and download progress — so the carried-over behaviour
// is covered by Build mode. The inline tests below pin it.

// ── Shared helpers ───────────────────────────────────────────────────────────

/// Join kept lines with `\n` and a trailing newline when non-empty, mirroring
/// the per-line `format!("{line}\n")` emission of rtk's `StreamFilter`s so the
/// output shape (and token counts) match the donor.
fn join_lines(lines: &[&str]) -> String {
	if lines.is_empty() {
		return String::new();
	}
	let mut out = lines.join("\n");
	out.push('\n');
	out
}

// ═══════════════════════════════════════════════════════════════════════════
// SPRING BOOT RUN MODE (shared by `mvn spring-boot:run` and gradle `bootRun`)
// ═══════════════════════════════════════════════════════════════════════════

/// `bootRun`/`spring-boot:run` application runtime filter.
///
/// Rederived (no injected flags) from rtk `src/filters/spring-boot.toml` and
/// `defs/spring-boot.toml`: a keep-list filter that drops the multi-line Spring
/// banner and INFO/DEBUG/TRACE startup chatter (which never match a keeper) and
/// keeps the actionable runtime signals — `Started … in`, `Tomcat started on
/// port`, ERROR/WARN, Exception, `Caused by:`, `Application run failed`, plus
/// surrounding Maven `[ERROR]`/`BUILD` lines and `Tests run:`. bootRun output
/// is unbounded, so a [`CapClass`] head/tail cap bounds the kept set. Input is
/// expected ANSI-stripped by the caller.
fn filter_spring_boot(input: &str) -> String {
	let mut out: Vec<&str> = Vec::new();
	for line in input.lines() {
		if spring_boot_keep(line) {
			out.push(line);
		}
	}
	let kept = join_lines(&out);
	primitives::head_tail_cap(&kept, CapClass::List)
}

/// rtk spring-boot.toml `keep_lines_matching`, plus the defs/spring-boot.toml
/// `[ERROR] …`/`[WARN] …` Maven-line shapes, as a predicate. A line survives if
/// it carries a startup-success or failure signal; everything else (banner,
/// INFO/DEBUG/TRACE bean chatter) is dropped.
fn spring_boot_keep(line: &str) -> bool {
	SPRING_STARTED.is_match(line)
		|| line.contains("Tomcat started on port")
		|| line.contains("listening on port")
		|| line.contains("ERROR")
		|| line.contains("WARN")
		|| line.contains("Exception")
		|| line.contains("Caused by:")
		|| line.contains("Application run failed")
		|| line.contains("Tests run:")
		|| line.contains("FAILURE")
		|| SPRING_BUILD.is_match(line)
}

/// `Started\s.*\sin\s` (rtk keep-list) — the `Started <App> in <n>s` line.
static SPRING_STARTED: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"Started\s.*\sin\s").unwrap());

/// `BUILD\s` (rtk keep-list) — `BUILD SUCCESS`/`BUILD FAILURE`/`BUILD FAILED`
/// across both mvn and gradle footer shapes.
static SPRING_BUILD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"BUILD\s").unwrap());
