//! Output tracking follows executed, expanded redirects, not source-code
//! guesses.
#![cfg(unix)]

use std::{
	path::PathBuf,
	sync::atomic::{AtomicUsize, Ordering},
};

use pi_shell::{FsObservationKind, Shell, ShellRunOptions, ShellRunResult, cancel::CancelToken};

struct Fixture {
	dir:   PathBuf,
	shell: Shell,
}

impl Fixture {
	fn new() -> Self {
		static NEXT: AtomicUsize = AtomicUsize::new(0);
		let dir = std::env::temp_dir().join(format!(
			"pi-redirect-{}-{}",
			std::process::id(),
			NEXT.fetch_add(1, Ordering::Relaxed)
		));
		std::fs::create_dir_all(&dir).unwrap();
		Self { dir, shell: Shell::new(None) }
	}

	async fn run(&self, command: &str) -> (ShellRunResult, String) {
		let (tx, rx) = flume::unbounded();
		let result = self
			.shell
			.run(
				ShellRunOptions {
					command: command.into(),
					cwd: Some(self.dir.to_string_lossy().into_owned()),
					..ShellRunOptions::default()
				},
				Some(tx),
				CancelToken::default(),
			)
			.await
			.unwrap();
		(result, rx.into_iter().collect())
	}
}

impl Drop for Fixture {
	fn drop(&mut self) {
		std::fs::remove_dir_all(&self.dir).unwrap();
	}
}

#[tokio::test]
async fn expanded_cat_pipeline_and_append_coalesce_before_and_after() {
	let f = Fixture::new();
	std::fs::write(f.dir.join("quoted output.txt"), "original\n").unwrap();
	let (result, output) = f
		.run(
			"dest='quoted output.txt'; printf 'first\\n' | cat > \"$dest\"; printf 'second\\n' >> \
			 \"$dest\"; cat \"$dest\"",
		)
		.await;
	assert_eq!(result.exit_code, Some(0), "{output}");
	let writes: Vec<_> = result
		.fs_observations
		.iter()
		.filter(|o| o.kind == FsObservationKind::Write)
		.collect();
	assert_eq!(writes.len(), 1);
	let mutation = writes[0].mutation.as_ref().unwrap();
	assert!(mutation.existed && mutation.exists);
	assert_eq!(mutation.before.as_deref(), Some("original\n"));
	assert_eq!(mutation.after.as_deref(), Some("first\nsecond\n"));
	assert_eq!(output, "first\nsecond\n");
}

#[tokio::test]
async fn stale_redirection_refuses_before_truncation_and_reread_rearms() {
	let f = Fixture::new();
	let path = f.dir.join("file");
	std::fs::write(&path, "read me").unwrap();
	assert_eq!(f.run("cat file").await.0.exit_code, Some(0));
	std::fs::write(&path, "external update is longer").unwrap();
	let (result, output) = f.run("printf lost > file").await;
	assert_ne!(result.exit_code, Some(0));
	assert!(output.contains("StaleWriteError"), "{output}");
	assert!(result.fs_observations.is_empty());
	assert_eq!(std::fs::read_to_string(&path).unwrap(), "external update is longer");
	assert_eq!(f.run("cat file; printf fresh > file").await.0.exit_code, Some(0));
	let (result, _) = f.run("printf own >> file").await;
	assert_eq!(result.exit_code, Some(0));
	assert_eq!(std::fs::read_to_string(&path).unwrap(), "freshown");
	std::fs::write(&path, "external again longer").unwrap();
	assert_ne!(f.run("printf lost >> file").await.0.exit_code, Some(0));
	f.run("cat file").await;
	std::fs::remove_file(&path).unwrap();
	assert_ne!(f.run("printf lost > file").await.0.exit_code, Some(0));
	assert!(!path.exists(), "stale output must not recreate an externally deleted file");
}

#[tokio::test]
async fn skipped_branches_failed_opens_and_empty_writes_are_distinct() {
	let f = Fixture::new();
	let (result, _) = f
		.run("false && printf no > skipped; : > empty; false > failed")
		.await;
	assert_ne!(result.exit_code, Some(0));
	assert!(!f.dir.join("skipped").exists());
	assert_eq!(result.fs_observations.len(), 2);
	for observation in result.fs_observations {
		let mutation = observation.mutation.unwrap();
		assert!(!mutation.existed && mutation.exists);
		assert_eq!(mutation.before, None);
		assert_eq!(mutation.after.as_deref(), Some(""));
	}
	std::fs::write(f.dir.join("kept"), "keep").unwrap();
	let (result, _) = f.run("set -C; printf lost > kept").await;
	assert_ne!(result.exit_code, Some(0));
	assert!(result.fs_observations.is_empty());
	assert_eq!(std::fs::read_to_string(f.dir.join("kept")).unwrap(), "keep");
	let (result, _) = f.run("printf lost &> kept").await;
	assert_ne!(result.exit_code, Some(0));
	assert!(result.fs_observations.is_empty());
	assert_eq!(std::fs::read_to_string(f.dir.join("kept")).unwrap(), "keep");
	assert_eq!(f.run("printf forced >| kept").await.0.exit_code, Some(0));
	let (result, _) = f.run("printf lost > absent/child").await;
	assert_ne!(result.exit_code, Some(0));
	assert!(result.fs_observations.is_empty());
}

#[tokio::test]
async fn symlink_aliases_share_guard_and_keep_shell_semantics() {
	let f = Fixture::new();
	std::fs::write(f.dir.join("target"), "old").unwrap();
	std::os::unix::fs::symlink("target", f.dir.join("alias")).unwrap();
	f.run("cat alias").await;
	std::fs::write(f.dir.join("target"), "external").unwrap();
	assert_ne!(f.run("printf lost > target").await.0.exit_code, Some(0));
	let (result, _) = f.run("cat target; printf fresh > alias").await;
	assert_eq!(result.exit_code, Some(0));
	assert_eq!(std::fs::read_to_string(f.dir.join("target")).unwrap(), "fresh");
	assert!(
		std::fs::symlink_metadata(f.dir.join("alias"))
			.unwrap()
			.is_symlink()
	);
	let write = result
		.fs_observations
		.iter()
		.find(|o| o.mutation.is_some())
		.unwrap();
	assert_eq!(write.path, f.dir.join("alias").to_string_lossy());
	let mutation = write.mutation.as_ref().unwrap();
	assert_eq!(mutation.before.as_deref(), Some("external"));
	assert_eq!(mutation.after.as_deref(), Some("fresh"));
	let (result, _) = f.run("cat alias; printf direct > target").await;
	let write = result
		.fs_observations
		.iter()
		.find(|o| o.mutation.is_some())
		.unwrap();
	assert_eq!(write.path, f.dir.join("target").to_string_lossy());
	assert_eq!(f.run("printf own >> alias").await.0.exit_code, Some(0));
	std::fs::write(f.dir.join("other"), "other target").unwrap();
	std::fs::remove_file(f.dir.join("alias")).unwrap();
	std::os::unix::fs::symlink("other", f.dir.join("alias")).unwrap();
	assert_ne!(f.run("printf lost > alias").await.0.exit_code, Some(0));
	assert_eq!(std::fs::read_to_string(f.dir.join("other")).unwrap(), "other target");
	assert_eq!(f.run("cat alias; printf rearmed > alias").await.0.exit_code, Some(0));
}

#[tokio::test]
async fn combined_streams_and_read_write_redirects_capture_outputs() {
	let f = Fixture::new();
	let (result, _) = f
		.run(
			"{ printf out; printf err >&2; } &> both; printf more &>> both; printf rw 1<> \
			 bidirectional",
		)
		.await;
	assert_eq!(result.exit_code, Some(0));
	let mutation = result
		.fs_observations
		.iter()
		.find(|o| o.path.ends_with("/both"))
		.unwrap()
		.mutation
		.as_ref()
		.unwrap();
	assert_eq!(mutation.after.as_deref(), Some("outerrmore"));
	assert_eq!(std::fs::read_to_string(f.dir.join("bidirectional")).unwrap(), "rw");
}

#[tokio::test]
async fn snapshots_exclude_special_binary_and_oversized_files() {
	let f = Fixture::new();
	let (result, _) = f.run("printf ignored > /dev/null").await;
	assert_eq!(result.exit_code, Some(0));
	assert!(result.fs_observations.is_empty());
	let fifo = f.dir.join("fifo");
	let name = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
	assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
	let reader = std::thread::spawn(move || std::fs::read(fifo).unwrap());
	let (result, _) = f.run("printf pipe > fifo").await;
	assert_eq!(result.exit_code, Some(0));
	assert!(result.fs_observations.is_empty());
	assert_eq!(reader.join().unwrap(), b"pipe");
	std::fs::write(f.dir.join("binary"), [0xff]).unwrap();
	std::fs::write(f.dir.join("large"), vec![b'x'; 1024 * 1024 + 1]).unwrap();
	let (result, _) = f.run("printf x >> binary; printf y >> large").await;
	assert_eq!(result.exit_code, Some(0));
	assert_eq!(result.fs_observations.len(), 2);
	for observation in result.fs_observations {
		assert!(observation.mtime_ns.is_some());
		let mutation = observation.mutation.unwrap();
		assert!(mutation.existed && mutation.exists);
		assert_eq!(mutation.before, None);
		assert_eq!(mutation.after, None);
	}
}

#[tokio::test]
async fn tee_and_sponge_share_redirect_snapshots_and_stale_guards() {
	let f = Fixture::new();
	let (result, output) = f.run("printf first | tee file").await;
	assert_eq!(result.exit_code, Some(0), "{output}");
	let mutation = result.fs_observations[0].mutation.as_ref().unwrap();
	assert!(!mutation.existed && mutation.exists);
	assert_eq!(mutation.after.as_deref(), Some("first"));
	let (result, _) = f.run("printf second | tee -a file").await;
	let mutation = result.fs_observations[0].mutation.as_ref().unwrap();
	assert_eq!(mutation.before.as_deref(), Some("first"));
	assert_eq!(mutation.after.as_deref(), Some("firstsecond"));
	std::fs::write(f.dir.join("file"), "outside update").unwrap();
	for command in
		["printf lost | tee file", "printf lost | tee -a file", "printf lost | sponge file"]
	{
		let (result, output) = f.run(command).await;
		assert_ne!(result.exit_code, Some(0), "{command}: {output}");
		assert!(output.contains("StaleWriteError"), "{command}: {output}");
		assert_eq!(std::fs::read_to_string(f.dir.join("file")).unwrap(), "outside update");
		assert!(result.fs_observations.is_empty());
	}
	let (result, _) = f.run("cat file; printf soaked | sponge file").await;
	assert_eq!(result.exit_code, Some(0));
	let mutation = result.fs_observations[0].mutation.as_ref().unwrap();
	assert_eq!(mutation.before.as_deref(), Some("outside update"));
	assert_eq!(mutation.after.as_deref(), Some("soaked"));
	let (result, _) = f.run("printf more | sponge -a file").await;
	assert_eq!(result.exit_code, Some(0));
	assert_eq!(
		result.fs_observations[0]
			.mutation
			.as_ref()
			.unwrap()
			.after
			.as_deref(),
		Some("soakedmore")
	);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn cross_filesystem_move_copy_tracks_destination_contents() {
	use std::os::unix::fs::MetadataExt;
	let f = Fixture::new();
	let Ok(shared) = std::fs::metadata("/dev/shm") else {
		return;
	};
	if shared.dev() == std::fs::metadata(&f.dir).unwrap().dev() {
		return;
	}
	let dir = PathBuf::from("/dev/shm").join(f.dir.file_name().unwrap());
	std::fs::create_dir(&dir).unwrap();
	let destination = Fixture { dir, shell: Shell::new(None) };
	std::fs::write(f.dir.join("input"), "move me").unwrap();
	let target = destination.dir.join("output");
	let (result, output) = f.run(&format!("mv input '{}'", target.display())).await;
	assert_eq!(result.exit_code, Some(0), "{output}");
	let write = result
		.fs_observations
		.iter()
		.find(|o| o.path == target.to_string_lossy())
		.unwrap();
	let mutation = write.mutation.as_ref().unwrap();
	assert!(!mutation.existed && mutation.exists);
	assert_eq!(mutation.after.as_deref(), Some("move me"));
	assert!(!f.dir.join("input").exists());
}

#[tokio::test]
async fn content_owning_builtins_capture_create_and_update() {
	let f = Fixture::new();
	std::fs::write(f.dir.join("input"), "b\na\na\n").unwrap();
	for (command, name, expected) in [
		("sort -o sorted input", "sorted", "a\na\nb\n"),
		("uniq input unique", "unique", "b\na\n"),
		("touch touched", "touched", ""),
		("printf abcdef > truncated; truncate -s 3 truncated", "truncated", "abc"),
		("printf old > edited; sed -i s/old/new/ edited", "edited", "new"),
		("printf '{\"x\":1}' > data; jq --in-place '.x = 2' data", "data", "{\n  \"x\": 2\n}\n"),
	] {
		let (result, output) = f.run(command).await;
		assert_eq!(result.exit_code, Some(0), "{command}: {output}");
		let observation = result
			.fs_observations
			.iter()
			.find(|o| o.path == f.dir.join(name).to_string_lossy())
			.unwrap();
		let mutation = observation.mutation.as_ref().unwrap();
		assert_eq!(mutation.after.as_deref(), Some(expected), "{command}");
	}
}
