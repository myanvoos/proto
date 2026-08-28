use std::borrow::Cow;

use regex::{Regex, RegexSet};
use serde::Deserialize;

use crate::minimizer::primitives;

#[derive(Debug, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct PipelineDef {
	#[serde(default)]
	pub description: Option<String>,

	pub match_command: String,

	#[serde(default)]
	pub match_subcommand:     Option<String>,
	#[serde(default)]
	pub strip_ansi:           bool,
	#[serde(default)]
	pub replace:              Vec<ReplaceDef>,
	#[serde(default)]
	pub match_output:         Vec<MatchOutputDef>,
	#[serde(default)]
	pub strip_lines_matching: Vec<String>,
	#[serde(default)]
	pub keep_lines_matching:  Vec<String>,

	#[serde(default)]
	pub replace_after:     Vec<ReplaceDef>,
	pub truncate_lines_at: Option<usize>,
	pub head_lines:        Option<usize>,
	pub tail_lines:        Option<usize>,
	pub max_lines:         Option<usize>,
	pub on_empty:          Option<String>,

	#[serde(default)]
	pub preserve_if_empty: bool,

	#[serde(default)]
	pub only_on_exit: Vec<i32>,

	#[serde(default)]
	pub except_on_exit: Vec<i32>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplaceDef {
	pub pattern:     String,
	pub replacement: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MatchOutputDef {
	pub pattern: String,
	pub message: String,
	#[serde(default)]
	pub unless:  Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PipelineTest {
	pub name:     String,
	pub input:    String,
	pub expected: String,
	#[serde(default)]
	pub exit:     Option<i32>,
}

#[derive(Debug, Deserialize, Default)]
pub struct PipelineFile {
	pub schema_version: Option<u32>,
	#[serde(default)]
	pub filters:        std::collections::BTreeMap<String, PipelineDef>,
	#[serde(default)]
	pub tests:          std::collections::BTreeMap<String, Vec<PipelineTest>>,
}

pub const SUPPORTED_SCHEMA_VERSION: u32 = 1;

#[derive(Debug)]
pub struct CompiledReplace {
	pattern:     Regex,
	replacement: String,
}

#[derive(Debug)]
pub struct CompiledMatchOutput {
	pattern: Regex,
	message: String,
	unless:  Option<Regex>,
}

#[derive(Debug)]
pub struct CompiledPipeline {
	pub name:              String,
	pub description:       Option<String>,
	pub match_command:     Regex,
	pub match_subcommand:  Option<Regex>,
	pub strip_ansi:        bool,
	pub replace:           Vec<CompiledReplace>,
	pub match_output:      Vec<CompiledMatchOutput>,
	pub strip_lines:       Option<RegexSet>,
	pub keep_lines:        Option<RegexSet>,
	pub replace_after:     Vec<CompiledReplace>,
	pub truncate_lines_at: Option<usize>,
	pub head_lines:        Option<usize>,
	pub tail_lines:        Option<usize>,
	pub max_lines:         Option<usize>,
	pub on_empty:          Option<String>,
	pub preserve_if_empty: bool,
	pub only_on_exit:      Vec<i32>,
	pub except_on_exit:    Vec<i32>,
}

fn compile_replaces(rules: Vec<ReplaceDef>, label: &str) -> Result<Vec<CompiledReplace>, String> {
	rules
		.into_iter()
		.map(|rule| {
			let pattern = Regex::new(&rule.pattern)
				.map_err(|e| format!("invalid {label} pattern '{}': {e}", rule.pattern))?;
			Ok(CompiledReplace { pattern, replacement: rule.replacement })
		})
		.collect()
}

pub fn compile(name: String, def: PipelineDef) -> Result<CompiledPipeline, String> {
	let match_command =
		Regex::new(&def.match_command).map_err(|e| format!("invalid match_command: {e}"))?;
	let match_subcommand = def
		.match_subcommand
		.as_deref()
		.map(|p| Regex::new(p).map_err(|e| format!("invalid match_subcommand: {e}")))
		.transpose()?;

	let replace = compile_replaces(def.replace, "replace")?;
	let replace_after = compile_replaces(def.replace_after, "replace_after")?;

	let match_output = def
		.match_output
		.into_iter()
		.map(|rule| {
			let pattern = Regex::new(&rule.pattern)
				.map_err(|e| format!("invalid match_output pattern '{}': {e}", rule.pattern))?;
			let unless = rule
				.unless
				.as_deref()
				.map(|u| Regex::new(u).map_err(|e| format!("invalid match_output unless: {e}")))
				.transpose()?;
			Ok(CompiledMatchOutput { pattern, message: rule.message, unless })
		})
		.collect::<Result<Vec<_>, String>>()?;

	let strip_lines = if def.strip_lines_matching.is_empty() {
		None
	} else {
		Some(
			RegexSet::new(&def.strip_lines_matching)
				.map_err(|e| format!("invalid strip_lines_matching: {e}"))?,
		)
	};
	let keep_lines = if def.keep_lines_matching.is_empty() {
		None
	} else {
		Some(
			RegexSet::new(&def.keep_lines_matching)
				.map_err(|e| format!("invalid keep_lines_matching: {e}"))?,
		)
	};

	Ok(CompiledPipeline {
		name,
		description: def.description,
		match_command,
		match_subcommand,
		strip_ansi: def.strip_ansi,
		replace,
		match_output,
		strip_lines,
		keep_lines,
		replace_after,
		truncate_lines_at: def.truncate_lines_at,
		head_lines: def.head_lines,
		tail_lines: def.tail_lines,
		max_lines: def.max_lines,
		on_empty: def.on_empty,
		preserve_if_empty: def.preserve_if_empty,
		only_on_exit: def.only_on_exit,
		except_on_exit: def.except_on_exit,
	})
}

impl CompiledPipeline {
	#[must_use]
	pub fn matches(&self, program: &str, subcommand: Option<&str>) -> bool {
		if !self.match_command.is_match(program) {
			return false;
		}
		if let Some(sub_rx) = self.match_subcommand.as_ref() {
			let sub = subcommand.unwrap_or("");
			if !sub_rx.is_match(sub) {
				return false;
			}
		}
		true
	}

	#[must_use]
	pub fn skipped_by_exit(&self, exit_code: i32) -> bool {
		if !self.only_on_exit.is_empty() && !self.only_on_exit.contains(&exit_code) {
			return true;
		}
		if self.except_on_exit.contains(&exit_code) {
			return true;
		}
		false
	}

	#[must_use]
	pub fn apply<'a>(&self, input: &'a str) -> Cow<'a, str> {
		let stage1: Cow<'_, str> = if self.strip_ansi {
			Cow::Owned(primitives::strip_ansi(input))
		} else {
			Cow::Borrowed(input)
		};

		let stage2 = apply_replaces(stage1, &self.replace);

		if !self.match_output.is_empty() {
			for rule in &self.match_output {
				if !rule.pattern.is_match(&stage2) {
					continue;
				}
				if let Some(anti) = rule.unless.as_ref()
					&& anti.is_match(&stage2)
				{
					continue;
				}
				return Cow::Owned(rule.message.clone());
			}
		}

		let stage4: Cow<'_, str> = if self.strip_lines.is_some() || self.keep_lines.is_some() {
			Cow::Owned(primitives::filter_lines_regex(
				&stage2,
				self.strip_lines.as_ref(),
				self.keep_lines.as_ref(),
			))
		} else {
			stage2
		};

		let stage5 = apply_replaces(stage4, &self.replace_after);

		let stage6: Cow<'_, str> = if let Some(n) = self.truncate_lines_at {
			let mut out = String::with_capacity(stage5.len());
			for line in stage5.lines() {
				out.push_str(&primitives::truncate_line(line, n));
				out.push('\n');
			}
			Cow::Owned(out)
		} else {
			stage5
		};

		let stage7: Cow<'_, str> = match (self.head_lines, self.tail_lines) {
			(Some(h), Some(t)) => Cow::Owned(primitives::head_tail_lines(&stage6, h, t)),
			(Some(h), None) => Cow::Owned(primitives::head_lines_only(&stage6, h)),
			(None, Some(t)) => Cow::Owned(primitives::tail_lines_only(&stage6, t)),
			(None, None) => stage6,
		};

		let stage8: Cow<'_, str> = if let Some(m) = self.max_lines {
			Cow::Owned(primitives::max_lines(&stage7, m))
		} else {
			stage7
		};

		if self.preserve_if_empty && stage8.trim().is_empty() {
			return Cow::Borrowed(input);
		}

		if let Some(msg) = self.on_empty.as_deref()
			&& stage8.trim().is_empty()
		{
			return Cow::Owned(msg.to_string());
		}

		stage8
	}
}

fn apply_replaces<'a>(input: Cow<'a, str>, rules: &[CompiledReplace]) -> Cow<'a, str> {
	if rules.is_empty() {
		return input;
	}
	let mut out = String::with_capacity(input.len());
	for line in input.lines() {
		let mut current = Cow::Borrowed(line);
		for rule in rules {
			let replaced = rule
				.pattern
				.replace_all(&current, rule.replacement.as_str());
			if let Cow::Owned(s) = replaced {
				current = Cow::Owned(s);
			}
		}
		out.push_str(&current);
		out.push('\n');
	}
	Cow::Owned(out)
}

pub type ParsedPipelineFile = (Vec<CompiledPipeline>, Vec<(String, Vec<PipelineTest>)>);

#[derive(Debug, Default)]
pub struct PipelineRegistry {
	pub pipelines: Vec<CompiledPipeline>,
	pub tests:     Vec<(String, Vec<PipelineTest>)>,
}

impl PipelineRegistry {
	#[must_use]
	pub fn find(&self, program: &str, subcommand: Option<&str>) -> Option<&CompiledPipeline> {
		self
			.pipelines
			.iter()
			.find(|p| p.matches(program, subcommand))
	}
}

pub fn parse_file(contents: &str, source_label: &str) -> Result<ParsedPipelineFile, String> {
	let file: PipelineFile =
		toml::from_str(contents).map_err(|e| format!("[{source_label}] TOML parse error: {e}"))?;

	if let Some(v) = file.schema_version
		&& v != SUPPORTED_SCHEMA_VERSION
	{
		return Err(format!(
			"[{source_label}] unsupported schema_version {v} (expected {SUPPORTED_SCHEMA_VERSION})"
		));
	}

	let mut compiled = Vec::with_capacity(file.filters.len());
	let mut errors = Vec::new();
	for (name, def) in file.filters {
		match compile(name.clone(), def) {
			Ok(pipeline) => compiled.push(pipeline),
			Err(e) => errors.push(format!("[{source_label}] filter '{name}': {e}")),
		}
	}
	if !errors.is_empty() {
		return Err(errors.join("\n"));
	}

	let tests = file.tests.into_iter().collect();
	Ok((compiled, tests))
}

#[derive(Debug, Clone)]
pub struct TestOutcome {
	pub filter_name: String,
	pub test_name:   String,
	pub passed:      bool,
	pub actual:      String,
	pub expected:    String,
}

#[must_use]
pub fn run_tests(registry: &PipelineRegistry) -> Vec<TestOutcome> {
	let mut out = Vec::new();
	for (filter_name, tests) in &registry.tests {
		let Some(pipeline) = registry.pipelines.iter().find(|p| &p.name == filter_name) else {
			for test in tests {
				out.push(TestOutcome {
					filter_name: filter_name.clone(),
					test_name:   test.name.clone(),
					passed:      false,
					actual:      format!("pipeline '{filter_name}' not found"),
					expected:    test.expected.clone(),
				});
			}
			continue;
		};
		for test in tests {
			if let Some(exit) = test.exit
				&& pipeline.skipped_by_exit(exit)
			{
				let passed = test.input == test.expected;
				out.push(TestOutcome {
					filter_name: filter_name.clone(),
					test_name: test.name.clone(),
					passed,
					actual: test.input.clone(),
					expected: test.expected.clone(),
				});
				continue;
			}
			let actual = pipeline.apply(&test.input).to_string();
			let passed = actual == test.expected;
			out.push(TestOutcome {
				filter_name: filter_name.clone(),
				test_name: test.name.clone(),
				passed,
				actual,
				expected: test.expected.clone(),
			});
		}
	}
	out
}
