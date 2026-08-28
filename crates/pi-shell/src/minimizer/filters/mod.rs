use crate::minimizer::{MinimizerCtx, MinimizerOutput};

pub mod cloud;
pub mod cpp;

pub mod binary_tools;
pub mod bun;

pub mod cargo;
pub mod docker;

pub mod dotnet;

pub mod generic;
pub mod gh;
pub mod glab;

pub mod go;
pub mod gt;

pub mod git;

pub mod js_tools;

pub mod jvm;

pub mod lint;
pub mod listing;
pub mod node_tests;
pub mod pkg;

pub mod python;
pub mod ruby;
pub mod rust_tools;
pub mod system;

#[must_use]
pub fn supports(program: &str, subcommand: Option<&str>) -> bool {
	match program {
		"git" | "yadm" => git::supports(subcommand),
		"gt" => gt::supports(program, subcommand),
		"bun" | "bunx" => bun::supports(program, subcommand),
		"cargo" => cargo::supports(subcommand),
		"go" | "golangci-lint" => go::supports(program, subcommand),
		"cmake" | "ctest" | "ninja" | "gtest" | "gtest-parallel" => {
			cpp::supports(program, subcommand)
		},
		program if cpp::is_gtest_binary_name(program) => cpp::supports(program, subcommand),
		"dotnet" => dotnet::supports(program, subcommand),

		"mvn" | "mvnw" | "mvnw.cmd" | "gradle" | "gradlew" | "gradlew.bat" => {
			jvm::supports(program, subcommand)
		},
		"ls" | "tree" | "find" | "grep" | "rg" | "wc" | "cat" | "read" | "stat" | "du" | "df"
		| "jq" | "json" => true,
		"aws" | "curl" | "wget" | "psql" => cloud::supports(program, subcommand),
		"docker" | "kubectl" | "helm" => docker::supports(subcommand),
		"gh" => gh::supports(subcommand),
		"glab" => glab::supports(subcommand),
		"pytest" | "ruff" | "mypy" | "python" | "python3" | "py" => {
			python::supports(program, subcommand)
		},
		"rspec" | "rake" | "rails" | "rubocop" => ruby::supports(program, subcommand),
		"rustfmt" => rust_tools::supports(program, subcommand),
		"xxd" | "strings" | "od" => binary_tools::supports(program, subcommand),
		"tsc" | "eslint" | "biome" | "shellcheck" | "markdownlint" | "hadolint" | "yamllint"
		| "oxlint" | "pyright" | "basedpyright" => {
			lint::supports(subcommand) || lint::supports_program(program, subcommand)
		},
		"jest" | "vitest" | "playwright" => true,
		"next" | "prettier" | "prisma" => js_tools::supports(program, subcommand),
		"npx" => {
			matches!(subcommand, Some("tsc" | "eslint" | "biome" | "jest" | "vitest" | "playwright"))
				|| js_tools::supports(program, subcommand)
		},
		"pnpm" if matches!(subcommand, Some("dlx")) => true,
		"uv" if matches!(subcommand, Some("run")) => true,
		"npm" | "pnpm" | "yarn" | "pip" | "pip3" | "bundle" | "brew" | "composer" | "poetry" => {
			pkg::supports(subcommand)
		},
		"uv" => {
			matches!(subcommand, Some("pytest" | "ruff" | "mypy" | "-m")) || pkg::supports(subcommand)
		},
		"env" | "log" | "deps" | "summary" | "err" | "test" | "diff" | "format" | "pipe" | "ps"
		| "ping" | "ssh" | "sops" => system::supports(program),
		_ => false,
	}
}

fn is_test_script_token(token: &str) -> bool {
	let token = token.trim_matches(|ch| matches!(ch, '\'' | '"' | '`'));
	matches!(token, "test" | "t" | "e2e" | "spec") || token.starts_with("test:")
}

fn run_invoked_word(command: &str) -> Option<&str> {
	let mut tokens = command
		.split(|ch: char| ch.is_whitespace() || matches!(ch, ';' | '|' | '&'))
		.filter(|tok| !tok.is_empty());
	tokens
		.by_ref()
		.find(|tok| matches!(*tok, "run" | "-m" | "--module"))?;
	tokens.find(|tok| !tok.starts_with('-'))
}

fn is_pkg_test_invocation(ctx: &MinimizerCtx<'_>) -> bool {
	matches!(ctx.subcommand, Some("test" | "t"))
		|| (matches!(ctx.subcommand, Some("run"))
			&& run_invoked_word(ctx.command).is_some_and(is_test_script_token))
}

fn is_pkg_lint_invocation(ctx: &MinimizerCtx<'_>) -> bool {
	matches!(ctx.subcommand, Some("run"))
		&& run_invoked_word(ctx.command).is_some_and(|word| {
			is_lint_script_token(word) || matches!(word, "tsc" | "eslint" | "biome")
		})
}

fn is_lint_script_token(token: &str) -> bool {
	let token = token.trim_matches(|ch| matches!(ch, '\'' | '"' | '`'));
	matches!(token, "lint" | "typecheck" | "type-check")
		|| token.starts_with("lint:")
		|| token.starts_with("typecheck:")
		|| token.starts_with("type-check:")
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let _ = ctx.command;
	let _ = ctx.config.per_command(ctx.program);
	match ctx.program {
		"git" | "yadm" => git::filter(ctx, input, exit_code),
		"gt" => gt::filter(ctx, input, exit_code),
		"bun" | "bunx" => bun::filter(ctx, input, exit_code),
		"cargo" => cargo::filter(ctx, input, exit_code),
		"go" | "golangci-lint" => go::filter(ctx, input, exit_code),
		"dotnet" => dotnet::filter(ctx, input, exit_code),
		"mvn" | "mvnw" | "mvnw.cmd" | "gradle" | "gradlew" | "gradlew.bat" => {
			jvm::filter(ctx, input, exit_code)
		},
		"cmake" | "ctest" | "ninja" | "gtest" | "gtest-parallel" => {
			cpp::filter(ctx, input, exit_code)
		},
		program if cpp::is_gtest_binary_name(program) => cpp::filter(ctx, input, exit_code),
		"ls" | "tree" | "find" | "grep" | "rg" | "wc" | "cat" | "read" | "stat" | "du" | "df"
		| "jq" | "json" => listing::filter(ctx, input, exit_code),
		"aws" | "curl" | "wget" | "psql" => cloud::filter(ctx, input, exit_code),
		"docker" | "kubectl" | "helm" => docker::filter(ctx, input, exit_code),
		"gh" => gh::filter(ctx, input, exit_code),
		"glab" => glab::filter(ctx, input, exit_code),
		"pytest" | "ruff" | "mypy" | "python" | "python3" | "py" => {
			python::filter(ctx, input, exit_code)
		},
		"rspec" | "rake" | "rails" | "rubocop" => ruby::filter(ctx, input, exit_code),
		"rustfmt" => rust_tools::filter(ctx, input, exit_code),
		"xxd" | "strings" | "od" => binary_tools::filter(ctx, input, exit_code),
		"tsc" | "eslint" | "biome" | "shellcheck" | "markdownlint" | "hadolint" | "yamllint"
		| "oxlint" | "pyright" | "basedpyright" => lint::filter(ctx, input, exit_code),
		"jest" | "vitest" | "playwright" => node_tests::filter(ctx, input, exit_code),
		"next" | "prettier" | "prisma" => js_tools::filter(ctx, input, exit_code),
		"npx" => filter_js_wrapper(ctx, input, exit_code),
		"pnpm" if matches!(ctx.subcommand, Some("dlx")) => filter_js_wrapper(ctx, input, exit_code),
		"uv" if matches!(ctx.subcommand, Some("run" | "pytest" | "ruff" | "mypy" | "-m")) => {
			filter_uv_wrapper(ctx, input, exit_code)
		},
		"bundle" if matches!(ctx.subcommand, Some("exec")) => {
			filter_bundle_wrapper(ctx, input, exit_code)
		},
		"npm" | "pnpm" | "yarn" => {
			if is_pkg_test_invocation(ctx) {
				node_tests::filter(ctx, input, exit_code)
			} else if is_pkg_lint_invocation(ctx) {
				lint::filter(ctx, input, exit_code)
			} else {
				pkg::filter(ctx, input, exit_code)
			}
		},
		"pip" | "pip3" | "bundle" | "brew" | "composer" | "uv" | "poetry" => {
			pkg::filter(ctx, input, exit_code)
		},
		"env" | "log" | "deps" | "summary" | "err" | "test" | "diff" | "format" | "pipe" | "ps"
		| "ping" | "ssh" | "sops" => system::filter(ctx, input, exit_code),
		_ => generic::filter(ctx, input, exit_code),
	}
}

fn filter_js_wrapper(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	if let Some(tool) = wrapper_invoked_tool(ctx, &["tsc", "eslint", "biome"]) {
		let routed = MinimizerCtx {
			program:    tool,
			subcommand: Some(tool),
			command:    ctx.command,
			config:     ctx.config,
		};
		lint::filter(&routed, input, exit_code)
	} else if let Some(tool) = wrapper_invoked_tool(ctx, &["jest", "vitest", "playwright"]) {
		let routed = MinimizerCtx {
			program:    tool,
			subcommand: Some(tool),
			command:    ctx.command,
			config:     ctx.config,
		};
		node_tests::filter(&routed, input, exit_code)
	} else if js_tools::supports(ctx.program, ctx.subcommand) {
		js_tools::filter(ctx, input, exit_code)
	} else {
		MinimizerOutput::passthrough(input)
	}
}

fn filter_uv_wrapper(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	if let Some(tool) = normalize_uv_form(ctx.subcommand, ctx.command) {
		let routed = MinimizerCtx {
			program:    tool,
			subcommand: Some(tool),
			command:    ctx.command,
			config:     ctx.config,
		};
		return match tool {
			"pytest" | "ruff" | "mypy" => python::filter(&routed, input, exit_code),
			_ => MinimizerOutput::passthrough(input),
		};
	}
	match uv_wrapper_tool(ctx) {
		Some("pytest") => {
			let routed = MinimizerCtx {
				program:    "pytest",
				subcommand: Some("pytest"),
				command:    ctx.command,
				config:     ctx.config,
			};
			python::filter(&routed, input, exit_code)
		},
		Some("ruff") => {
			let subcommand = if ctx.command.split_whitespace().any(|part| part == "format") {
				Some("format")
			} else {
				Some("ruff")
			};
			let routed =
				MinimizerCtx { program: "ruff", subcommand, command: ctx.command, config: ctx.config };
			python::filter(&routed, input, exit_code)
		},
		Some("mypy") => {
			let routed = MinimizerCtx {
				program:    "mypy",
				subcommand: Some("mypy"),
				command:    ctx.command,
				config:     ctx.config,
			};
			python::filter(&routed, input, exit_code)
		},
		Some(tool @ ("tsc" | "eslint" | "biome" | "pyright" | "basedpyright" | "oxlint")) => {
			let routed = MinimizerCtx {
				program:    tool,
				subcommand: Some(tool),
				command:    ctx.command,
				config:     ctx.config,
			};
			lint::filter(&routed, input, exit_code)
		},
		Some("jest" | "vitest" | "playwright") => node_tests::filter(ctx, input, exit_code),
		_ => MinimizerOutput::passthrough(input),
	}
}

fn filter_bundle_wrapper(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let Some(inner_command) = bundle_wrapped_command(ctx.command) else {
		return pkg::filter(ctx, input, exit_code);
	};
	crate::minimizer::apply(&inner_command, input, exit_code, ctx.config)
}

fn bundle_wrapped_command(command: &str) -> Option<String> {
	let tokens: Vec<&str> = command
		.split(|ch: char| ch.is_whitespace() || matches!(ch, ';' | '|' | '&'))
		.filter(|tok| !tok.is_empty())
		.collect();
	let bundle_pos = tokens.iter().position(|t| {
		t.rsplit('/')
			.next()
			.is_some_and(|name| name.eq_ignore_ascii_case("bundle"))
	})?;
	let mut iter = tokens.iter().skip(bundle_pos + 1).copied();
	let word = next_command_word(&mut iter)?;
	if word != "exec" {
		return None;
	}
	let tool = next_command_word(&mut iter)?;
	let mut inner = String::from(tool);
	for tok in iter {
		inner.push(' ');
		inner.push_str(tok);
	}
	Some(inner)
}

fn normalize_uv_form(subcommand: Option<&str>, command: &str) -> Option<&'static str> {
	const ALLOWLIST: &[&str] = &["pytest", "ruff", "mypy"];
	let sub = subcommand?;
	if let Some(&tool) = ALLOWLIST.iter().find(|&&tool| tool == sub) {
		return Some(tool);
	}
	if sub == "-m" {
		let mut tokens = command.split_whitespace().skip_while(|t| t != &"-m");
		tokens.next();
		let next = tokens.next().filter(|tok| !tok.starts_with('-'))?;
		ALLOWLIST.iter().find(|&&tool| tool == next).copied()
	} else {
		None
	}
}

fn uv_wrapper_tool<'a>(ctx: &'a MinimizerCtx<'_>) -> Option<&'a str> {
	wrapper_invoked_tool(ctx, &[
		"pytest",
		"ruff",
		"mypy",
		"tsc",
		"eslint",
		"biome",
		"pyright",
		"basedpyright",
		"oxlint",
		"jest",
		"vitest",
		"playwright",
	])
}

const WRAPPER_VALUE_OPTIONS: &[&str] = &[
	"--extra",
	"--with",
	"--with-requirements",
	"--with-editable",
	"--python",
	"-p",
	"--from",
	"--directory",
	"--project",
	"--index",
	"--default-index",
	"--index-url",
	"--extra-index-url",
	"--find-links",
	"-f",
	"--cache-dir",
	"--config-file",
	"--refresh-package",
	"--resolution",
	"--prerelease",
	"--exclude-newer",
	"--link-mode",
	"--color",
	"--python-preference",
	"--package",
	"-c",
	"--call",
	"--workspace",
	"-w",
	"--node-arg",
	"--gemfile",
	"--path",
	"--jobs",
	"--retry",
];

fn next_command_word<'a>(tokens: &mut impl Iterator<Item = &'a str>) -> Option<&'a str> {
	while let Some(tok) = tokens.next() {
		if !tok.starts_with('-') {
			return Some(tok);
		}
		if !tok.contains('=') && WRAPPER_VALUE_OPTIONS.contains(&tok) {
			tokens.next();
		}
	}
	None
}

fn wrapper_command_word(command: &str) -> Option<&str> {
	let mut tokens = command
		.split(|ch: char| ch.is_whitespace() || matches!(ch, ';' | '|' | '&'))
		.filter(|tok| !tok.is_empty());
	tokens.next()?;
	let mut word = next_command_word(&mut tokens)?;
	if matches!(word, "run" | "dlx" | "exec") {
		word = next_command_word(&mut tokens)?;
	}
	if matches!(word, "python" | "python3" | "py") {
		while let Some(tok) = tokens.next() {
			if tok == "--" {
				return Some(word);
			}
			if matches!(tok, "-c" | "--command") {
				return Some(word);
			}
			if matches!(tok, "-m" | "--module") {
				return tokens
					.find(|candidate| !candidate.starts_with('-'))
					.or(Some(word));
			}
			if tok.starts_with('-') {
				continue;
			}
			return Some(tok);
		}
	}
	Some(word)
}

fn wrapper_invoked_tool<'a>(ctx: &'a MinimizerCtx<'_>, tools: &[&'a str]) -> Option<&'a str> {
	let word = wrapper_command_word(ctx.command)?;
	match tools.iter().copied().find(|&tool| tool == word) {
		Some(tool) => Some(tool),
		None => ctx
			.subcommand
			.and_then(|subcommand| tools.iter().copied().find(|tool| *tool == subcommand)),
	}
}
