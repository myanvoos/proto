use std::{
	panic::{AssertUnwindSafe, catch_unwind},
	sync::{
		LazyLock,
		atomic::{AtomicU64, Ordering},
	},
};

use crate::minimizer::{
	MinimizerConfig, MinimizerCtx, MinimizerOutput, detect, filters,
	pipeline::{self, CompiledPipeline, PipelineRegistry},
	plan,
};

pub const MIN_MINIMIZE_CHARS: usize = 1_000;
fn is_below_minimize_threshold(captured: &str) -> bool {
	captured.chars().take(MIN_MINIMIZE_CHARS).count() < MIN_MINIMIZE_CHARS
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MinimizerMode {
	None,

	WholeCommand,

	SegmentedChain,
}

#[must_use]
pub fn mode_for(command: &str, config: &MinimizerConfig) -> MinimizerMode {
	match plan::analyze(command) {
		plan::CommandPlan::Single { .. } => {
			let Some(identity) = detect::detect(command) else {
				return MinimizerMode::None;
			};
			if identity_has_filter(&identity, config) {
				MinimizerMode::WholeCommand
			} else {
				MinimizerMode::None
			}
		},
		plan::CommandPlan::Chain { segments } => {
			if config.enabled
				&& !config.legacy_filters_active()
				&& chain_has_eligible_segment(&segments, config)
				&& !chain_mutates_shell_fds(&segments)
			{
				MinimizerMode::SegmentedChain
			} else {
				MinimizerMode::None
			}
		},
		plan::CommandPlan::Compound | plan::CommandPlan::Piped | plan::CommandPlan::Unsupported => {
			MinimizerMode::None
		},
	}
}

#[must_use]
pub fn should_minimize(command: &str, config: &MinimizerConfig) -> bool {
	!matches!(mode_for(command, config), MinimizerMode::None)
}

#[must_use]
pub fn apply(
	command: &str,
	captured: &str,
	exit_code: i32,
	config: &MinimizerConfig,
) -> MinimizerOutput {
	let input_bytes = captured.len();

	if input_bytes > config.max_capture_bytes as usize {
		return MinimizerOutput::passthrough(captured).labeled("too-large");
	}

	match plan::analyze(command) {
		plan::CommandPlan::Single { .. } => {},
		plan::CommandPlan::Chain { segments } => {
			return apply_chain(command, &segments, captured, exit_code, config);
		},
		plan::CommandPlan::Piped => {
			return MinimizerOutput::passthrough(captured).labeled("piped");
		},
		plan::CommandPlan::Compound => {
			return MinimizerOutput::passthrough(captured).labeled("compound");
		},
		plan::CommandPlan::Unsupported => {
			return MinimizerOutput::passthrough(captured).labeled("parse-error");
		},
	}

	let Some(identity) = detect::detect(command) else {
		record_unknown_command(command);
		return MinimizerOutput::passthrough(captured).labeled("unknown");
	};
	apply_identity(&identity, command, captured, exit_code, config)
}

fn apply_chain(
	command: &str,
	segments: &[plan::ChainSegment],
	captured: &str,
	_exit_code: i32,
	_config: &MinimizerConfig,
) -> MinimizerOutput {
	let _ = (command, segments);
	MinimizerOutput::passthrough(captured).labeled("compound")
}

fn identity_has_filter(identity: &detect::CommandIdentity, config: &MinimizerConfig) -> bool {
	if !config.is_program_enabled(&identity.program) {
		return false;
	}

	let subcommand = identity.subcommand.as_deref();
	filters::supports(&identity.program, subcommand)
		|| resolve_pipeline(config, &identity.program, subcommand).is_some()
}

fn chain_has_eligible_segment(segments: &[plan::ChainSegment], config: &MinimizerConfig) -> bool {
	segments.iter().any(|segment| {
		detect::detect(&segment.command)
			.is_some_and(|identity| identity_has_filter(&identity, config))
			|| is_common_chain_utility(&segment.program)
	})
}

fn chain_mutates_shell_fds(segments: &[plan::ChainSegment]) -> bool {
	segments.iter().any(is_shell_fd_mutating_segment)
}

fn is_shell_fd_mutating_segment(segment: &plan::ChainSegment) -> bool {
	if is_shell_state_mutating_program(&segment.program) {
		return true;
	}
	if matches!(segment.program.as_str(), "command" | "builtin")
		&& command_wrapper_invokes_mutator(segment)
	{
		return true;
	}
	false
}

fn is_shell_state_mutating_program(program: &str) -> bool {
	matches!(program, "exec" | "eval" | "source" | "." | "alias" | "unalias")
}

fn command_wrapper_invokes_mutator(segment: &plan::ChainSegment) -> bool {
	for word in segment.command.split_whitespace() {
		if is_shell_state_mutating_program(word) {
			return true;
		}

		if is_ambiguous_assignment_fragment(word) {
			return true;
		}
		if word == "command" || word == "builtin" || word.starts_with('-') || is_env_assignment(word)
		{
			continue;
		}
		return false;
	}
	false
}

fn is_ambiguous_assignment_fragment(word: &str) -> bool {
	is_env_assignment(word) && (word.contains('"') || word.contains('\''))
}

fn is_env_assignment(word: &str) -> bool {
	word.split_once('=').is_some_and(|(key, _)| {
		!key.is_empty() && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
	})
}

fn is_common_chain_utility(program: &str) -> bool {
	matches!(
		program,
		"echo"
			| "printf"
			| "head"
			| "tail"
			| "file"
			| "which"
			| "type"
			| "sed"
			| "awk"
			| "sleep"
			| "seq"
			| "cp" | "mv"
			| "rm" | "mkdir"
			| "rmdir"
			| "touch"
			| "basename"
			| "dirname"
			| "realpath"
			| "readlink"
			| "true"
			| "false"
			| "yes"
			| "tr" | "tee"
			| "sort"
			| "uniq"
			| "cut"
			| "paste"
			| "rev"
			| "split"
			| "comm"
			| "patch"
			| "xargs"
			| "unzip"
			| "zip"
			| "tar"
			| "gzip"
			| "gunzip"
			| "cd" | "pwd"
			| "export"
			| "env"
			| "test"
	)
}

fn apply_identity(
	identity: &detect::CommandIdentity,
	command: &str,
	captured: &str,
	exit_code: i32,
	config: &MinimizerConfig,
) -> MinimizerOutput {
	if !config.is_program_enabled(&identity.program) {
		return MinimizerOutput::passthrough(captured).labeled("disabled");
	}

	let subcommand = identity.subcommand.as_deref();

	if filters::supports(&identity.program, subcommand) {
		if is_below_minimize_threshold(captured) {
			return MinimizerOutput::passthrough(captured).labeled("too-short");
		}
		let ctx = MinimizerCtx { program: &identity.program, subcommand, command, config };
		let Ok(rust_output) =
			catch_unwind(AssertUnwindSafe(|| filters::filter(&ctx, captured, exit_code)))
		else {
			return MinimizerOutput::passthrough(captured)
				.labeled(program_label(&identity.program))
				.with_original(captured);
		};
		let label = program_label(&identity.program);
		let overlaid = apply_pipeline_overlay(
			config,
			&identity.program,
			subcommand,
			exit_code,
			rust_output,
			label,
		);
		return ensure_success_visible(overlaid, exit_code).with_original(captured);
	}

	if let Some(pipeline) = resolve_pipeline(config, &identity.program, subcommand) {
		if pipeline.skipped_by_exit(exit_code) {
			return MinimizerOutput::passthrough(captured).labeled("exit-skip");
		}
		if is_below_minimize_threshold(captured) {
			return MinimizerOutput::passthrough(captured).labeled("too-short");
		}
		let text = catch_unwind(AssertUnwindSafe(|| pipeline.apply(captured).into_owned()))
			.unwrap_or_else(|_| captured.to_string());
		if text == captured {
			return MinimizerOutput::passthrough(captured).labeled("pipeline-noop");
		}
		return ensure_success_visible(
			MinimizerOutput::transformed(text, captured.len()).labeled("pipeline"),
			exit_code,
		)
		.with_original(captured);
	}

	record_unknown_command(command);
	MinimizerOutput::passthrough(captured).labeled("unsupported")
}

fn ensure_success_visible(output: MinimizerOutput, exit_code: i32) -> MinimizerOutput {
	if exit_code == 0 && output.changed && output.text.trim().is_empty() {
		output.with_text("OK\n".to_string())
	} else {
		output
	}
}

fn program_label(program: &str) -> &'static str {
	match program {
		"git" => "git",
		"yadm" => "yadm",
		"gt" => "gt",
		"bun" => "bun",
		"bunx" => "bunx",
		"cargo" => "cargo",
		"go" => "go",
		"cmake" => "cmake",
		"ctest" => "ctest",
		"ninja" => "ninja",
		"gtest" => "gtest",
		"gtest-parallel" => "gtest",
		program if filters::cpp::is_gtest_binary_name(program) => "gtest",
		"golangci-lint" => "golangci-lint",
		"dotnet" => "dotnet",
		"mvn" | "mvnw" | "mvnw.cmd" => "mvn",
		"gradle" | "gradlew" | "gradlew.bat" => "gradle",
		"docker" => "docker",
		"kubectl" => "kubectl",
		"helm" => "helm",
		"gh" => "gh",
		"pytest" => "pytest",
		"ruff" => "ruff",
		"mypy" => "mypy",
		"python" => "python",
		"python3" => "python3",
		"rspec" => "rspec",
		"rake" => "rake",
		"rails" => "rails",
		"rubocop" => "rubocop",
		"rustfmt" => "rustfmt",
		"xxd" => "xxd",
		"strings" => "strings",
		"od" => "od",
		"tsc" => "tsc",
		"eslint" => "eslint",
		"biome" => "biome",
		"jest" => "jest",
		"vitest" => "vitest",
		"playwright" => "playwright",
		"npm" => "npm",
		"pnpm" => "pnpm",
		"yarn" => "yarn",
		"pip" => "pip",
		"pip3" => "pip3",
		"bundle" => "bundle",
		"brew" => "brew",
		"composer" => "composer",
		"uv" => "uv",
		"poetry" => "poetry",
		"aws" => "aws",
		"curl" => "curl",
		"wget" => "wget",
		"psql" => "psql",
		"ls" => "ls",
		"tree" => "tree",
		"find" => "find",
		"grep" => "grep",
		"rg" => "rg",
		"wc" => "wc",
		"cat" => "cat",
		"read" => "read",
		"stat" => "stat",
		"du" => "du",
		"df" => "df",
		"jq" => "jq",
		_ => "builtin",
	}
}

fn apply_pipeline_overlay(
	config: &MinimizerConfig,
	program: &str,
	subcommand: Option<&str>,
	exit_code: i32,
	inner: MinimizerOutput,
	primary_label: &'static str,
) -> MinimizerOutput {
	let Some(pipeline) = resolve_pipeline(config, program, subcommand) else {
		return inner.labeled(primary_label);
	};
	if pipeline.skipped_by_exit(exit_code) {
		return inner.labeled(primary_label);
	}
	let text = catch_unwind(AssertUnwindSafe(|| pipeline.apply(&inner.text).into_owned()))
		.unwrap_or_else(|_| inner.text.clone());
	if text == inner.text {
		return inner.labeled(primary_label);
	}
	let output_bytes = text.len();
	MinimizerOutput {
		text,
		changed: true,
		input_bytes: inner.input_bytes,
		output_bytes,
		filter: "pipeline+builtin",
		original_text: inner.original_text,
	}
}

fn resolve_pipeline<'a>(
	config: &'a MinimizerConfig,
	program: &str,
	subcommand: Option<&str>,
) -> Option<&'a CompiledPipeline> {
	if let Some(user) = config.user_pipelines.as_deref()
		&& let Some(pipeline) = user.find(program, subcommand)
	{
		return Some(pipeline);
	}
	builtin_pipelines().find(program, subcommand)
}

static UNKNOWN_COMMAND_COUNT: AtomicU64 = AtomicU64::new(0);

fn record_unknown_command(_command: &str) {
	UNKNOWN_COMMAND_COUNT.fetch_add(1, Ordering::Relaxed);
}

pub fn unknown_command_count() -> u64 {
	UNKNOWN_COMMAND_COUNT.load(Ordering::Relaxed)
}

const BUILTIN_FILTERS_TOML: &str = include_str!(concat!(env!("OUT_DIR"), "/builtin_filters.toml"));

static BUILTIN_PIPELINES: LazyLock<PipelineRegistry> =
	LazyLock::new(|| match pipeline::parse_file(BUILTIN_FILTERS_TOML, "builtin") {
		Ok((pipelines, tests)) => PipelineRegistry { pipelines, tests },
		Err(err) => {
			eprintln!("[pi-natives minimizer] failed to load built-in filters: {err}");
			PipelineRegistry::default()
		},
	});

fn builtin_pipelines() -> &'static PipelineRegistry {
	&BUILTIN_PIPELINES
}

#[must_use]
pub fn verify_builtin_filters() -> Vec<pipeline::TestOutcome> {
	pipeline::run_tests(builtin_pipelines())
}
