use std::{collections::HashSet, fmt::Write as _, sync::LazyLock};

use regex::Regex;

use crate::minimizer::{
	MinimizerCtx, MinimizerOutput,
	primitives::{self, CapClass},
};

const fn max_mvn_failing_classes() -> usize {
	CapClass::Warnings.lines()
}

fn is_running(line: &str) -> bool {
	line.starts_with("[INFO] Running ")
}

fn is_reactor_summary(line: &str) -> bool {
	line.starts_with("[INFO] Reactor Summary for ")
}

static CLOSE: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(
		r"^\[(?:INFO|ERROR|WARNING)\] Tests run: \d+, Failures: (\d+), Errors: (\d+), Skipped: \d+, Time elapsed: [^ ]+ s(?:\s+<<<\s*(?:FAILURE|ERROR)!)?\s+--?\s+in (.+)$",
	)
	.unwrap()
});

static BUILD_FOOT: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^\[(?:INFO|ERROR)\] BUILD (?:SUCCESS|FAILURE)$").unwrap());

static RESULTS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\[INFO\] Results:\s*$").unwrap());

static AGG: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"^\[(?:INFO|ERROR)\] Tests run: \d+, Failures: \d+, Errors: \d+, Skipped: \d+\s*$")
		.unwrap()
});

static PLUGIN_BANNER: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^\[INFO\] --- .* @ .* ---$").unwrap());

static MODULE_BANNER: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^\[INFO\] -+< .+ >-+$").unwrap());

static FILE_COORD: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"/[^:]+\.java:\[\d+,\d+\]").unwrap());

#[must_use]
pub fn supports(program: &str, _subcommand: Option<&str>) -> bool {
	is_mvn_family(program) || is_gradle_family(program)
}

fn is_mvn_family(program: &str) -> bool {
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

	if has_verbose_flag(ctx.command) {
		return MinimizerOutput::passthrough(input);
	}

	let phase = detect_phase(ctx.command);

	let text = if phase == MvnPhase::SpringBootRun {
		filter_spring_boot(&primitives::strip_ansi(input))
	} else if is_quiet(ctx.command) && phase != MvnPhase::Passthrough {
		filter_quiet(input)
	} else {
		match phase {
			MvnPhase::Test => filter_surefire(input),
			MvnPhase::Compile => filter_compile(input),
			MvnPhase::Package => filter_package(input),
			MvnPhase::Passthrough => filter_passthrough(input),

			MvnPhase::SpringBootRun => filter_passthrough(input),
		}
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

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

fn has_gradle_verbose_flag(command: &str) -> bool {
	arg_tokens(command)
		.any(|a| matches!(a, "--stacktrace" | "--info" | "--debug" | "--full-stacktrace"))
}

fn arg_tokens(command: &str) -> impl Iterator<Item = &str> {
	command.split_whitespace().skip(1)
}

fn has_verbose_flag(command: &str) -> bool {
	arg_tokens(command).any(|a| matches!(a, "-X" | "--debug" | "-e" | "--errors"))
}

fn is_quiet(command: &str) -> bool {
	arg_tokens(command).any(|a| a == "-q" || a == "--quiet")
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum MvnPhase {
	Test,
	Compile,
	Package,
	SpringBootRun,
	Passthrough,
}

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
				tokens.next();
			}
		} else {
			out.push(tok);
		}
	}
	out
}

#[must_use]
pub fn detect_phase(command: &str) -> MvnPhase {
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

const BOILER_PREFIXES: &[&str] = &[
	"[ERROR] See ",
	"[ERROR] -> [Help",
	"[ERROR] To see the full stack trace",
	"[ERROR] Re-run Maven",
	"[ERROR] For more information",
	"[ERROR] [Help",
];

fn is_boilerplate(line: &str) -> bool {
	BOILER_PREFIXES.iter().any(|p| line.starts_with(p)) || line.trim_end() == "[ERROR]"
}

fn is_per_test_subline(line: &str) -> bool {
	line.starts_with("[ERROR] ") && (line.contains("<<< FAILURE!") || line.contains("<<< ERROR!"))
}

fn has_english_footer(stripped: &str) -> bool {
	stripped.lines().any(|l| {
		let t = l.trim();
		t.ends_with(" BUILD SUCCESS") || t.ends_with(" BUILD FAILURE")
	})
}

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

struct SurefireBlock<'a> {
	block_lines:   Vec<&'a str>,
	block_running: Option<&'a str>,
	in_block:      bool,
	failure_trail: bool,

	drop_trail: bool,

	trail_rearm: Option<bool>,
}

enum SurefireStep<'a> {
	Consumed,

	FailingClose { running: Option<&'a str>, lines: Vec<&'a str>, close: &'a str },

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
				return SurefireStep::Passthrough;
			}
			self.trail_rearm = None;
			if is_per_test_subline(line) {
				self.failure_trail = true;
				self.drop_trail = dropped;
				if !dropped {
					out.push_str(line);
					out.push('\n');
				}
				return SurefireStep::Consumed;
			}
		}

		SurefireStep::Passthrough
	}

	const fn drop_failing(&mut self) {
		self.failure_trail = true;
		self.drop_trail = true;
		self.trail_rearm = None;
	}

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

	fn handle_entry(&mut self, line: &str, out: &mut String) -> bool {
		if !self.in_summary || !line.starts_with("[ERROR]   ") {
			return false;
		}

		if self.emitted < self.cap {
			out.push_str(line);
			out.push('\n');
			self.emitted += 1;
		} else {
			self.dropped += 1;
		}
		true
	}

	fn handle_header(&mut self, line: &str) {
		if line.starts_with("[ERROR] Failures:") {
			self.in_summary = true;
			self.emitted = 0;
			self.dropped = 0;
		}
	}

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

	fn finish(&self, out: &mut String) {
		if self.in_summary && self.dropped > 0 {
			let _ = write!(out, "\n[…{} failures elided…]\n", self.dropped);
		}
	}
}

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

		if summary.handle_entry(line, &mut out) {
			continue;
		}

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

		keep_continuation = false;
	}

	block.finish(&mut out);
	summary.finish(&mut out);
	if dropped_failing > 0 {
		let _ = write!(out, "\n[…{dropped_failing} failing test classes elided…]\n");
	}
	out
}

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

		keep_continuation = false;
	}

	out
}

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

		let reactor_keep = reactor_summary_keep(line, &mut in_reactor_summary);

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

pub fn filter_quiet(raw: &str) -> String {
	let stripped = primitives::strip_ansi(raw);
	if stripped.trim().is_empty() {
		return String::new();
	}

	let mut out = String::new();
	let mut failure_trail = false;

	for line in stripped.lines() {
		if CLOSE.is_match(line) {
			out.push_str(line);
			out.push('\n');
			failure_trail = line.contains("<<< FAILURE!") || line.contains("<<< ERROR!");
			continue;
		}

		if is_per_test_subline(line) {
			out.push_str(line);
			out.push('\n');
			failure_trail = true;
			continue;
		}

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

		if is_boilerplate(line) {
			continue;
		}

		out.push_str(line);
		out.push('\n');
	}

	out
}

fn filter_passthrough(raw: &str) -> String {
	let stripped = primitives::strip_ansi(raw);
	let filtered = primitives::strip_lines(&stripped, &[is_passthrough_noise]);
	primitives::head_tail_cap(&filtered, CapClass::List)
}

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

fn is_gradle_task_line(line: &str) -> bool {
	line.starts_with("> Task :")
}

fn is_gradle_try_section(line: &str) -> bool {
	line.starts_with("* Try:")
		|| line.starts_with("> Run with --")
		|| line.starts_with("> Get more help at")
}

fn is_gradle_build_status(line: &str) -> bool {
	line.starts_with("BUILD SUCCESSFUL") || line.starts_with("BUILD FAILED")
}

static GRADLE_ACTIONABLE: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^\d+ actionable tasks?").unwrap());

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

pub fn detect_task(command: &str) -> GradleTask {
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
		GradleTask::Other
	} else {
		GradleTask::Build
	}
}

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

static GRADLE_PROGRESS: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(
		r"^\s*\d+%|^Downloading|^Configuring|^Resolving|^\[Incubating\]|^Wrote HTML report|^class \S+ could not|^\[android-",
	)
	.unwrap()
});

static GRADLE_ERROR_LINE: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(
		r"(?i)(^FAILURE:|^\* What went wrong:|^\* Where:|> Could not|e: |error:|^Execution failed|Lint found \d+ error)",
	)
	.unwrap()
});

static GRADLE_WARN_LINE: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^(w: |warning:|Warning:|WARNING:)").unwrap());

fn is_gradle_build_scan(line: &str) -> bool {
	line.contains("gradle.com/s/") || line.contains("Publishing build scan")
}

fn keep_gradle_build_line(line: &str) -> bool {
	if is_gradle_task_line(line)
		|| GRADLE_DAEMON_PREFIXES.iter().any(|p| line.starts_with(p))
		|| GRADLE_PROGRESS.is_match(line)
		|| is_gradle_try_section(line)
	{
		return false;
	}

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

static GRADLE_FAILED_LINE: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"FAILED$| FAILED ").unwrap());

static GRADLE_PASSED_SKIPPED: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r" PASSED$| SKIPPED$").unwrap());

static GRADLE_TEST_SUMMARY: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"\d+ tests? completed|\d+ tests? failed|There were failing tests|See the report at")
		.unwrap()
});

fn is_gradle_framework_frame(trimmed: &str) -> bool {
	trimmed.starts_with("at org.junit.")
		|| trimmed.starts_with("at junit.")
		|| trimmed.starts_with("at java.lang.reflect.")
		|| trimmed.starts_with("at sun.reflect.")
		|| trimmed.starts_with("at org.gradle.")
}

fn filter_gradle_test(input: &str) -> String {
	if input.is_empty() {
		return String::new();
	}

	let mut result_lines: Vec<&str> = Vec::new();
	let mut in_failure_block = false;

	for line in input.lines() {
		if is_gradle_task_line(line) || is_gradle_try_section(line) {
			continue;
		}

		if is_gradle_build_status(line)
			|| GRADLE_ACTIONABLE.is_match(line)
			|| GRADLE_TEST_SUMMARY.is_match(line)
		{
			result_lines.push(line);
			continue;
		}

		if GRADLE_PASSED_SKIPPED.is_match(line) {
			in_failure_block = false;
			continue;
		}

		if GRADLE_FAILED_LINE.is_match(line) {
			in_failure_block = true;
			result_lines.push(line);
			continue;
		}

		if in_failure_block {
			let trimmed = line.trim();
			if trimmed.starts_with("at ") {
				if !is_gradle_framework_frame(trimmed) {
					result_lines.push(line);
					in_failure_block = false;
				}
			} else if !trimmed.is_empty() {
				result_lines.push(line);
			}
		}
	}

	let filtered = join_lines(&result_lines);

	if filtered.trim().is_empty() {
		if input.contains("BUILD SUCCESSFUL") {
			return "ok ✓ (no test output — add testLogging to build.gradle for details)".to_string();
		}
		return input.trim().to_string();
	}

	filtered
}

static GRADLE_INSTRUMENTATION_STATUS: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^INSTRUMENTATION_STATUS[_CODE]*:").unwrap());

static GRADLE_STARTING_TESTS: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^Starting \d+ tests? on ").unwrap());

fn filter_gradle_connected(input: &str) -> String {
	if input.is_empty() {
		return String::new();
	}

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

	let joined = join_lines(&result_lines);
	let filtered = filter_gradle_test(&joined);

	if filtered.trim().is_empty() {
		return "ok ✓ (connected tests passed)".to_string();
	}
	filtered
}

static GRADLE_ANDROID_LINT_ERROR: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"[^:]+:\d+:.*[Ee]rror:.*\[").unwrap());

static GRADLE_ANDROID_LINT_WARNING: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"[^:]+:\d+:.*[Ww]arning:.*\[").unwrap());

static GRADLE_KTLINT_VIOLATION: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"[^:]+:\d+:\d+:.*[Ll]int").unwrap());

static GRADLE_DETEKT_VIOLATION: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"[^:]+:\d+:\d+:.*error").unwrap());

static GRADLE_LINT_SUMMARY: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"\d+ (issues?|errors?|warnings?)").unwrap());

static GRADLE_LINT_REPORT: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"Wrote (HTML|XML|text) report|file://|/build/reports/lint").unwrap()
});

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

			context_remaining = if is_android_lint {
				MAX_CONTEXT_LINES
			} else {
				0
			};
			continue;
		}

		if context_remaining > 0 {
			if line.trim().is_empty() {
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

const fn max_gradle_deps() -> usize {
	CapClass::List.lines()
}

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

		if (line.starts_with("+---") || line.starts_with("\\---")) && !current_config.is_empty() {
			let dep = trimmed
				.trim_start_matches("+--- ")
				.trim_start_matches("\\--- ")
				.to_string();
			current_deps.push(dep);
			total_deps += 1;
		}
	}

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

fn join_lines(lines: &[&str]) -> String {
	if lines.is_empty() {
		return String::new();
	}
	let mut out = lines.join("\n");
	out.push('\n');
	out
}

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

static SPRING_STARTED: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"Started\s.*\sin\s").unwrap());

static SPRING_BUILD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"BUILD\s").unwrap());
