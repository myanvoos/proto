use std::sync::Arc;

use pi_shell::minimizer::{MinimizerConfig, engine, pipeline};

fn config() -> MinimizerConfig {
	MinimizerConfig { enabled: true, ..Default::default() }
}

#[test]
fn cargo_lock_wait_is_preserved_once_even_when_compaction_drops_the_body() {
	let input = format!(
		"    Blocking waiting for file lock on build directory\n{}    Blocking waiting for file \
		 lock on package cache\n    Finished dev profile\n",
		"   Compiling dependency\n".repeat(100)
	);
	let out = engine::apply("cargo build", &input, 0, &config());
	assert!(
		out.text
			.starts_with("Blocking waiting for file lock on build directory\n"),
		"{}",
		out.text
	);
	assert_eq!(out.text.matches("Blocking waiting for file lock").count(), 1);
}

#[test]
fn jq_preserves_the_byte_budget_and_all_failure_output() {
	let input = format!("{}\n", "x".repeat(16_383));
	assert_eq!(input.len(), 16_384);
	assert_eq!(engine::apply("jq .", &input, 0, &config()).text, input);
	let over = format!("{input}x\n");
	assert_ne!(engine::apply("jq .", &over, 0, &config()).text, over);
	let failed = format!("{}jq: error: invalid input\n", "{\"value\":1}\n".repeat(2_000));
	assert_eq!(engine::apply("jq .", &failed, 5, &config()).text, failed);
}

#[test]
fn ssh_preserves_long_remote_lines_and_small_multiline_answers() {
	let line = format!("{}\n", "remote-data".repeat(150));
	assert_eq!(engine::apply("ssh host command", &line, 0, &config()).text, line);
	let lines = "answer\n".repeat(500);
	assert_eq!(engine::apply("ssh host command", &lines, 0, &config()).text, lines);
}

#[test]
fn diff_hunk_lines_that_look_like_file_headers_are_counted_as_changes() {
	let patch = "diff --git a/a.sql b/a.sql\n--- a/a.sql\n+++ b/a.sql\n@@ -1,2 +1,2 @@\n--- old \
	             comment\n-old\n+++ new comment\n+new\n";
	let patch = patch.replace("-old\n", &format!("-old{}\n", "x".repeat(16_384)));
	let out = engine::apply("git diff", &patch, 0, &config()).text;
	assert!(out.contains("a.sql | 4"), "{out}");
	assert!(out.contains("2 insertions(+), 2 deletions(-)"), "{out}");
	assert!(out.contains("--- old comment") && out.contains("+++ new comment"), "{out}");
}

#[test]
fn word_diff_options_preserve_word_patches_but_last_none_allows_summary() {
	let patch = format!(
		"diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-{}\n+{}\n",
		"old".repeat(3_000),
		"new".repeat(3_000)
	);
	assert_eq!(engine::apply("git diff --word-diff", &patch, 0, &config()).text, patch);
	let out = engine::apply("git diff --word-diff --word-diff=none", &patch, 0, &config());
	assert!(out.text.contains("1 insertions(+), 1 deletions(-)"), "{}", out.text);
	assert_ne!(out.text, patch);
}

#[test]
fn gt_resolves_its_own_line_capping_overlay_before_summarizing_a_patch() {
	let patch = format!(
		"diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-{}\n+new\n",
		"old".repeat(500)
	);
	let (pipelines, tests) =
		pipeline::parse_file("[filters.gt]\nmatch_command='^gt$'\nmax_lines=2\n", "test").unwrap();
	let cfg = MinimizerConfig {
		user_pipelines: Some(Arc::new(pipeline::PipelineRegistry { pipelines, tests })),
		..config()
	};
	let out = engine::apply("gt diff", &patch, 0, &cfg);
	assert!(out.text.contains("file | 2"), "{}", out.text);
	assert!(out.text.contains("1 file changed"), "{}", out.text);
	assert_eq!(engine::apply("git diff", &patch, 0, &cfg).text, patch);
}

#[test]
fn psql_messages_quoting_pipes_survive_table_row_caps() {
	let mut input = String::from(" id | name\n----+------\n");
	for i in 0..100 {
		input.push_str(&format!(" {i:>2} | {}\n", "n".repeat(20)));
	}
	input.push_str(
		"(100 rows)\nERROR:  operator does not exist: integer || integer\nLINE 1: select 1 || 2\n",
	);
	let out = engine::apply("psql", &input, 1, &config());
	assert!(
		out.text
			.contains("ERROR:  operator does not exist: integer || integer\n"),
		"{}",
		out.text
	);
	assert!(out.text.contains("LINE 1: select 1 || 2\n"), "{}", out.text);
	assert!(out.text.contains("rows elided"), "{}", out.text);
}
