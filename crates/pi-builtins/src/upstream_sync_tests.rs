use std::io::{Read, Seek, Write};

use brush_core::{
	ProfileLoadBehavior, RcLoadBehavior, Shell, SourceInfo,
	openfiles::{OpenFile, OpenFiles},
};

use crate::{BuiltinSet, default_builtins, utility_builtins};

async fn run(script: &str, input: &str, cwd: &std::path::Path) -> (u8, String, String) {
	let mut shell = Shell::builder()
		.profile(ProfileLoadBehavior::Skip)
		.rc(RcLoadBehavior::Skip)
		.builtins(default_builtins(BuiltinSet::BashMode))
		.build()
		.await
		.expect("shell");
	for (name, builtin) in utility_builtins()
		.into_iter()
		.chain(crate::process_builtins())
	{
		shell.register_builtin(name, builtin);
	}
	shell.set_working_dir(cwd).expect("cwd");
	let mut stdin = tempfile::tempfile().expect("stdin");
	stdin.write_all(input.as_bytes()).expect("input");
	stdin.rewind().expect("rewind");
	let mut stdout = tempfile::tempfile().expect("stdout");
	let mut stderr = tempfile::tempfile().expect("stderr");
	let mut params = shell.default_exec_params();
	params.set_fd(OpenFiles::STDIN_FD, OpenFile::from(stdin));
	params.set_fd(OpenFiles::STDOUT_FD, OpenFile::from(stdout.try_clone().expect("stdout clone")));
	params.set_fd(OpenFiles::STDERR_FD, OpenFile::from(stderr.try_clone().expect("stderr clone")));
	let result = shell
		.run_string(script, &SourceInfo::from("builtin-regression"), &params)
		.await
		.expect("script");
	stdout.rewind().expect("rewind");
	stderr.rewind().expect("rewind");
	let mut out = String::new();
	let mut err = String::new();
	stdout.read_to_string(&mut out).expect("read stdout");
	stderr.read_to_string(&mut err).expect("read stderr");
	(u8::from(result.exit_code), out, err)
}

#[tokio::test]
async fn read_counts_unicode_characters_and_preserves_shared_file_offset() {
	let dir = tempfile::tempdir().unwrap();
	let (code, out, err) = run(
		"read -r -n 2 a; read -r -N 1 b; read -r rest; printf '%s|%s|%s' \"$a\" \"$b\" \"$rest\"",
		"é世xy\n",
		dir.path(),
	)
	.await;
	assert_eq!((code, out, err), (0, "é世|x|y".into(), "".into()));
}

#[tokio::test]
async fn mapfile_callback_can_consume_the_next_input_line() {
	let dir = tempfile::tempdir().unwrap();
	let (code, out, err) = run(
		"mapfile -t -c 1 -C 'read -r skipped; :' rows; printf '%s,' \"${rows[@]}\"",
		"one\nskip\ntwo\nskip\n",
		dir.path(),
	)
	.await;
	assert_eq!((code, out, err), (0, "one,two,".into(), "".into()));
}

#[tokio::test]
async fn sort_reads_repeated_stdin_only_once_and_accepts_equal_separator() {
	let dir = tempfile::tempdir().unwrap();
	let (code, out, err) = run("sort -t= -k2,2 - -", "z=1\na=2\n", dir.path()).await;
	assert_eq!((code, out, err), (0, "z=1\na=2\n".into(), "".into()));
}

#[tokio::test]
async fn sort_merges_stdin_before_replacing_its_output_file() {
	let dir = tempfile::tempdir().unwrap();
	std::fs::write(dir.path().join("sorted"), "b\nd\n").unwrap();
	let (code, out, err) = run("sort -m -o sorted - sorted; cat sorted", "a\nc\n", dir.path()).await;
	assert_eq!((code, out, err), (0, "a\nb\nc\nd\n".into(), "".into()));
}

#[tokio::test]
async fn sort_rejects_invalid_parallel_counts_instead_of_ignoring_them() {
	let dir = tempfile::tempdir().unwrap();
	let (code, out, err) = run("sort --parallel=0", "b\na\n", dir.path()).await;
	assert_eq!(code, 2);
	assert_eq!(out, "");
	assert!(err.contains("nonzero"), "{err}");
}

#[tokio::test]
async fn sort_small_chunks_preserve_large_records_and_numeric_keys() {
	let dir = tempfile::tempdir().unwrap();
	let input: String = (0..2000)
		.rev()
		.map(|n| format!("prefix {n:05} {}\n", "x".repeat(n % 63)))
		.collect();
	let expected: String = (0..2000)
		.map(|n| format!("prefix {n:05} {}\n", "x".repeat(n % 63)))
		.collect();
	let (code, out, err) = run("sort -S 16K --parallel=1 -k2,2n", &input, dir.path()).await;
	assert_eq!(code, 0, "{err}");
	assert_eq!(out, expected);
}

#[tokio::test]
async fn jq_discards_one_json_bom_but_preserves_raw_input() {
	let dir = tempfile::tempdir().unwrap();
	let (code, out, err) = run("jq -c .", "\u{feff}{\"ok\":true}", dir.path()).await;
	assert_eq!((code, out, err), (0, "{\"ok\":true}\n".into(), "".into()));
	let (code, out, err) = run("jq -Rr .", "\u{feff}text\n", dir.path()).await;
	assert_eq!((code, out, err), (0, "\u{feff}text\n".into(), "".into()));
}

#[tokio::test]
async fn rg_omits_zero_match_files_unless_requested() {
	let dir = tempfile::tempdir().unwrap();
	std::fs::write(dir.path().join("input"), "absent\n").unwrap();
	let (code, out, err) = run("rg --count needle input", "", dir.path()).await;
	assert_eq!((code, out, err), (1, "".into(), "".into()));
	let (code, out, err) = run("rg --count --include-zero needle input", "", dir.path()).await;
	assert_eq!((code, out, err), (1, "0\n".into(), "".into()));
}

#[tokio::test]
async fn numbered_lines_support_basic_regex_and_page_sections() {
	let dir = tempfile::tempdir().unwrap();
	let (code, out, err) = run("nl -b 'p^a' -w1 -s: -v3", "a\nb\na2\n", dir.path()).await;
	assert_eq!((code, out, err), (0, "3:a\n  b\n4:a2\n".into(), "".into()));
}

#[tokio::test]
async fn sed_and_jq_read_regular_inputs_instead_of_requiring_mmaps() {
	let dir = tempfile::tempdir().unwrap();
	std::fs::write(dir.path().join("input"), "α\nβ\n").unwrap();
	let (code, out, err) = run("sed -n 'N;p' input", "", dir.path()).await;
	assert_eq!((code, out, err), (0, "α\nβ\n".into(), "".into()));
}

#[tokio::test]
async fn tac_reverses_records_spanning_backward_read_blocks() {
	let dir = tempfile::tempdir().unwrap();
	let records = ["a".repeat(70000), "b".repeat(150000), "c".repeat(9000)];
	std::fs::write(dir.path().join("input"), records.join("\n") + "\n").unwrap();
	let (code, out, err) = run("tac input", "", dir.path()).await;
	assert_eq!(code, 0, "{err}");
	assert_eq!(out, records.into_iter().rev().collect::<Vec<_>>().join("\n") + "\n");
}

#[tokio::test]
async fn mkdir_modes_do_not_change_another_shells_creation_mask() {
	let dir = tempfile::tempdir().unwrap();
	let (code, out, err) =
		run("umask 077; mkdir -p -m 755 a/b; stat -c %a a/b", "", dir.path()).await;
	assert_eq!((code, out, err), (0, "755\n".into(), "".into()));
}

#[tokio::test]
async fn rm_force_ignores_entries_already_gone() {
	let dir = tempfile::tempdir().unwrap();
	let (code, out, err) =
		run("rm -rf vanished; mkdir -p a/b; rm -rf a; test ! -e a", "", dir.path()).await;
	assert_eq!((code, out, err), (0, "".into(), "".into()));
}

#[tokio::test]
async fn xargs_splits_batches_to_fit_strings_and_argv_pointers() {
	let dir = tempfile::tempdir().unwrap();
	let arg_max = unsafe { libc::sysconf(libc::_SC_ARG_MAX) } as usize;
	let count = arg_max / 256;
	let input = format!("{}\n", "x".repeat(255)).repeat(count);
	let (code, out, err) =
		run("xargs /bin/sh -c 'printf \"%s\\n\" \"$#\"' sh", &input, dir.path()).await;
	assert_eq!(code, 0, "{err}");
	let batches: Vec<usize> = out.lines().map(|line| line.parse().unwrap()).collect();
	assert!(batches.len() > 1, "a batch containing every argument would exceed ARG_MAX");
	assert_eq!(batches.iter().sum::<usize>(), count);
}

#[tokio::test]
async fn listing_size_ties_keep_names_ordered_inside_directory_groups() {
	let dir = tempfile::tempdir().unwrap();
	std::fs::create_dir(dir.path().join("z-dir")).unwrap();
	std::fs::create_dir(dir.path().join("a-dir")).unwrap();
	std::fs::write(dir.path().join("z-file"), "same").unwrap();
	std::fs::write(dir.path().join("a-file"), "same").unwrap();
	let (code, out, err) = run("ls -1S --group-directories-first", "", dir.path()).await;
	assert_eq!((code, out, err), (0, "a-dir\nz-dir\na-file\nz-file\n".into(), "".into()));
}

#[tokio::test]
async fn ps_reports_invalid_unicode_cluster_options_without_panicking() {
	let dir = tempfile::tempdir().unwrap();
	let (code, out, err) = run("ps -é", "", dir.path()).await;
	assert_ne!(code, 0);
	assert_eq!(out, "");
	assert!(err.contains('é'), "{err}");
}

#[tokio::test]
async fn added_native_utilities_transform_input_and_resolve_shell_paths() {
	let dir = tempfile::tempdir().unwrap();
	let (code, out, err) = run("fold -b -w3", "abcdef\n", dir.path()).await;
	assert_eq!((code, out, err), (0, "abc\ndef\n".into(), "".into()));
	let (code, out, err) = run("od -An -tx1", "A\0B", dir.path()).await;
	assert_eq!(code, 0, "{err}");
	assert_eq!(out.split_whitespace().collect::<Vec<_>>(), ["41", "00", "42"]);
	let (code, out, err) = run("id -u", "", dir.path()).await;
	assert_eq!(code, 0, "{err}");
	assert_eq!(out.trim().parse::<u32>().unwrap(), unsafe { libc::geteuid() });
	std::fs::create_dir_all(dir.path().join("a/b/c")).unwrap();
	let (code, out, err) = run("rmdir -p a/b/c", "", dir.path()).await;
	assert_eq!((code, out, err), (0, "".into(), "".into()));
	assert!(!dir.path().join("a").exists());
}

#[tokio::test]
async fn uptime_since_reads_native_boot_time_in_the_shell_timezone() {
	let dir = tempfile::tempdir().unwrap();
	let (code, out, err) = run("TZ=UTC uptime -s", "", dir.path()).await;
	assert_eq!(code, 0, "{err}");
	let boot = chrono::NaiveDateTime::parse_from_str(out.trim(), "%Y-%m-%d %H:%M:%S")
		.unwrap()
		.and_utc();
	assert!(boot.timestamp() > 0 && boot <= chrono::Utc::now(), "{out}");
}

#[tokio::test]
async fn mapfile_waits_for_paused_input_without_blocking_its_timeout() {
	let dir = tempfile::tempdir().unwrap();
	let result = tokio::time::timeout(
		std::time::Duration::from_secs(2),
		run("(printf x; sleep 0.1) | timeout 0.02 mapfile -t rows", "", dir.path()),
	)
	.await
	.expect("mapfile ignored timeout");
	assert_eq!(result, (124, "".into(), "".into()));
}

#[tokio::test]
async fn mapfile_yields_while_reading_an_endless_line() {
	let dir = tempfile::tempdir().unwrap();
	let result = tokio::time::timeout(
		std::time::Duration::from_secs(2),
		run("timeout 0.02 mapfile -t rows < /dev/zero", "", dir.path()),
	)
	.await
	.expect("mapfile ignored timeout");
	assert_eq!(result, (124, "".into(), "".into()));
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelled_checksum_stdin_never_reports_a_prefix_as_a_complete_checksum() {
	let dir = tempfile::tempdir().unwrap();
	let result = tokio::time::timeout(
		std::time::Duration::from_secs(2),
		run("timeout 0.02 md5sum - < /dev/zero", "", dir.path()),
	)
	.await
	.expect("checksum ignored timeout");
	assert_eq!(result, (124, "".into(), "".into()));
}

#[tokio::test]
async fn tail_keeps_the_first_reverse_read_block_at_an_exact_block_multiple() {
	let dir = tempfile::tempdir().unwrap();
	let content: String = (0..16384).map(|n| format!("L{n:06}\n")).collect();
	std::fs::write(dir.path().join("log"), &content).unwrap();
	let (code, out, err) = run("tail -n 16384 log", "", dir.path()).await;
	assert_eq!(code, 0, "{err}");
	assert_eq!(out, content);
}

#[tokio::test]
async fn tail_follow_returns_after_its_pipe_reader_exits() {
	let dir = tempfile::tempdir().unwrap();
	std::fs::write(dir.path().join("log"), "first\n").unwrap();
	let result = tokio::time::timeout(
		std::time::Duration::from_secs(3),
		run("tail -f log | head -n 1", "", dir.path()),
	)
	.await
	.expect("tail kept following after head exited");
	assert_eq!(result, (0, "first\n".into(), "".into()));
}

#[tokio::test]
async fn a_tagged_checksum_line_without_an_algorithm_is_rejected_not_a_panic() {
	let dir = tempfile::tempdir().unwrap();
	std::fs::write(dir.path().join("checksums"), "(file) = 00000000\n").unwrap();
	let (code, out, err) = run("cksum --check checksums", "", dir.path()).await;
	assert_ne!(code, 0);
	assert_eq!(out, "");
	assert!(!err.contains("internal error"), "{err}");
}
