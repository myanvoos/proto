use std::{
	collections::BTreeMap,
	fs::Metadata,
	path::{Path, PathBuf},
	time::SystemTime,
};

use tokio::process::Command;

use crate::{IsoError, IsoResult, command_failed};

#[derive(Debug, Clone, Default)]
pub struct Diff {
	pub files: Vec<FileChange>,
}

impl Diff {
	pub const fn is_empty(&self) -> bool {
		self.files.is_empty()
	}
}

#[derive(Debug, Clone)]
pub struct FileChange {
	pub path: PathBuf,
	pub op:   ChangeKind,
	pub diff: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeKind {
	Added,
	Modified,
	Removed,
}

pub async fn default_diff(lower: &Path, merged: &Path) -> IsoResult<Diff> {
	if is_git_tree(merged).await {
		git_diff(merged).await
	} else {
		walk_diff(lower, merged).await
	}
}

async fn is_git_tree(merged: &Path) -> bool {
	tokio::fs::symlink_metadata(merged.join(".git"))
		.await
		.is_ok()
}

async fn git_diff(merged: &Path) -> IsoResult<Diff> {
	let tracked =
		git_run(merged, &["-c", "core.quotepath=off", "diff", "--no-color", "HEAD"]).await?;

	let untracked_list = git_run(merged, &[
		"-c",
		"core.quotepath=off",
		"ls-files",
		"--others",
		"--exclude-standard",
		"-z",
	])
	.await?;

	let mut files = parse_git_diff(&tracked);

	let mut untracked_paths: Vec<&[u8]> = untracked_list
		.split(|b| *b == 0)
		.filter(|s| !s.is_empty())
		.collect();
	untracked_paths.sort_unstable();

	for path_bytes in untracked_paths {
		let path_str = std::str::from_utf8(path_bytes)
			.map_err(|err| IsoError::other(format!("untracked path is not valid UTF-8: {err}")))?;
		let one = git_run_allow_exit1(merged, &[
			"-c",
			"core.quotepath=off",
			"diff",
			"--no-color",
			"--no-index",
			git_null_path(),
			path_str,
		])
		.await?;
		files.extend(parse_git_diff(&one));
	}

	files.sort_by(|a, b| a.path.cmp(&b.path));
	Ok(Diff { files })
}

const fn git_null_path() -> &'static str {
	"/dev/null"
}

fn git_failure(args: &[&str], output: &std::process::Output) -> IsoError {
	command_failed(
		format_args!("git {}", args.join(" ")),
		output
			.status
			.code()
			.map_or_else(|| "?".into(), |c| c.to_string()),
		&output.stderr,
	)
}

async fn git_run(cwd: &Path, args: &[&str]) -> IsoResult<Vec<u8>> {
	let output = git_spawn(cwd, args).await?;
	if !output.status.success() {
		return Err(git_failure(args, &output));
	}
	Ok(output.stdout)
}

async fn git_run_allow_exit1(cwd: &Path, args: &[&str]) -> IsoResult<Vec<u8>> {
	let output = git_spawn(cwd, args).await?;
	if output.status.success() || output.status.code() == Some(1) {
		return Ok(output.stdout);
	}
	Err(git_failure(args, &output))
}

async fn git_spawn(cwd: &Path, args: &[&str]) -> IsoResult<std::process::Output> {
	let mut cmd = Command::new("git");
	cmd.arg("-C").arg(cwd).args(args);
	cmd.stdin(std::process::Stdio::null());
	cmd.output().await.map_err(|err| {
		if err.kind() == std::io::ErrorKind::NotFound {
			IsoError::unavailable("`git` not on PATH; cannot capture diff for git-tracked tree")
		} else {
			IsoError::other(format!("spawn git: {err}"))
		}
	})
}

fn parse_git_diff(blob: &[u8]) -> Vec<FileChange> {
	let mut out = Vec::<FileChange>::new();
	let mut buf = Vec::new();
	let mut header_path: Option<PathBuf> = None;
	let mut old_path: Option<PathBuf> = None;
	let mut header_kind = ChangeKind::Modified;
	let mut header_binary = false;
	let mut in_change = false;
	let mut in_hunk = false;

	for line in blob.split_inclusive(|byte| *byte == b'\n') {
		let bare = trim_git_line_end(line);
		if let Some(rest) = bare.strip_prefix(b"diff --git ") {
			flush_git_change(
				&mut buf,
				&mut header_path,
				&mut header_kind,
				&mut header_binary,
				&mut out,
			);
			header_path = parse_git_header_path(rest);
			old_path = None;
			in_change = true;
			in_hunk = false;
			buf.extend_from_slice(line);
			continue;
		}
		if !in_change {
			continue;
		}

		if !in_hunk {
			if bare.starts_with(b"new file mode ") {
				header_kind = ChangeKind::Added;
			} else if bare.starts_with(b"deleted file mode ") {
				header_kind = ChangeKind::Removed;
			} else if let Some(field) = bare
				.strip_prefix(b"rename to ")
				.or_else(|| bare.strip_prefix(b"copy to "))
			{
				header_path = parse_git_path_field(field, None);
			} else if let Some(field) = bare.strip_prefix(b"--- ") {
				old_path = parse_git_path_field(field, Some(b'a'));
			} else if let Some(field) = bare.strip_prefix(b"+++ ") {
				header_path = parse_git_path_field(field, Some(b'b')).or_else(|| old_path.clone());
			} else if bare.starts_with(b"Binary files ") || bare.starts_with(b"GIT binary patch") {
				header_binary = true;
			}
			if bare.starts_with(b"@@ ") {
				in_hunk = true;
			}
		}
		buf.extend_from_slice(line);
	}
	flush_git_change(&mut buf, &mut header_path, &mut header_kind, &mut header_binary, &mut out);
	out
}

fn flush_git_change(
	buf: &mut Vec<u8>,
	path: &mut Option<PathBuf>,
	kind: &mut ChangeKind,
	binary: &mut bool,
	out: &mut Vec<FileChange>,
) {
	if let Some(path) = path.take() {
		let diff = if *binary {
			None
		} else {
			Some(String::from_utf8_lossy(buf).into_owned())
		};
		out.push(FileChange { path, op: *kind, diff });
	}
	buf.clear();
	*kind = ChangeKind::Modified;
	*binary = false;
}

fn trim_git_line_end(mut line: &[u8]) -> &[u8] {
	if let Some(without_newline) = line.strip_suffix(b"\n") {
		line = without_newline;
	}
	line.strip_suffix(b"\r").unwrap_or(line)
}

fn parse_git_header_path(header: &[u8]) -> Option<PathBuf> {
	if header.starts_with(b"\"") {
		let (_, consumed) = parse_git_quoted_token(header)?;
		let rest = header.get(consumed..)?.strip_prefix(b" ")?;
		let (new, _) = parse_git_quoted_token(rest)?;
		return strip_git_side_prefix(new, b'b').map(git_bytes_to_path);
	}

	let old = header.strip_prefix(b"a/")?;
	for (index, candidate) in header.windows(3).enumerate() {
		if candidate != b" b/" {
			continue;
		}
		let new = header.get(index + 3..)?;
		if old.get(..index.saturating_sub(2)) == Some(new) {
			return Some(git_bytes_to_path(new.to_vec()));
		}
	}
	None
}

fn parse_git_path_field(field: &[u8], side: Option<u8>) -> Option<PathBuf> {
	let bytes = if field.starts_with(b"\"") {
		parse_git_quoted_token(field)?.0
	} else {
		field.strip_suffix(b"\t").unwrap_or(field).to_vec()
	};
	if bytes == b"/dev/null" {
		return None;
	}
	let bytes = match side {
		Some(side) => strip_git_side_prefix(bytes, side)?,
		None => bytes,
	};
	Some(git_bytes_to_path(bytes))
}

fn strip_git_side_prefix(bytes: Vec<u8>, side: u8) -> Option<Vec<u8>> {
	(bytes.first() == Some(&side) && bytes.get(1) == Some(&b'/')).then(|| bytes[2..].to_vec())
}

fn parse_git_quoted_token(input: &[u8]) -> Option<(Vec<u8>, usize)> {
	if input.first() != Some(&b'"') {
		return None;
	}
	let mut out = Vec::new();
	let mut index = 1;
	while index < input.len() {
		match input[index] {
			b'"' => return Some((out, index + 1)),
			b'\\' => {
				index += 1;
				let escaped = *input.get(index)?;
				if (b'0'..=b'7').contains(&escaped) {
					let mut value = 0_u16;
					let mut digits = 0;
					while digits < 3 {
						let Some(&digit) = input.get(index) else {
							break;
						};
						if !(b'0'..=b'7').contains(&digit) {
							break;
						}
						value = value * 8 + u16::from(digit - b'0');
						index += 1;
						digits += 1;
					}
					out.push(u8::try_from(value).ok()?);
					continue;
				}
				out.push(match escaped {
					b'a' => 0x07,
					b'b' => 0x08,
					b't' => b'\t',
					b'n' => b'\n',
					b'v' => 0x0b,
					b'f' => 0x0c,
					b'r' => b'\r',
					b'\\' => b'\\',
					b'"' => b'"',
					_ => return None,
				});
				index += 1;
			},
			byte => {
				out.push(byte);
				index += 1;
			},
		}
	}
	None
}

#[cfg(unix)]
fn git_bytes_to_path(bytes: Vec<u8>) -> PathBuf {
	use std::os::unix::ffi::OsStringExt as _;
	std::ffi::OsString::from_vec(bytes).into()
}

#[cfg(not(unix))]
fn git_bytes_to_path(bytes: Vec<u8>) -> PathBuf {
	String::from_utf8_lossy(&bytes).into_owned().into()
}

async fn walk_diff(lower: &Path, merged: &Path) -> IsoResult<Diff> {
	let lower = lower.to_path_buf();
	let merged = merged.to_path_buf();
	tokio::task::spawn_blocking(move || walk_diff_blocking(&lower, &merged))
		.await
		.map_err(|err| IsoError::other(format!("walk_diff join: {err}")))?
}

fn walk_diff_blocking(lower: &Path, merged: &Path) -> IsoResult<Diff> {
	let lower_index = index_tree(lower)?;
	let merged_index = index_tree(merged)?;

	let mut files: Vec<FileChange> = Vec::new();

	for (rel, merged_meta) in &merged_index {
		match lower_index.get(rel) {
			None => files.push(plain_change(merged, rel, ChangeKind::Added, None)?),
			Some(lower_meta) => {
				if entries_equal(lower, merged, rel, lower_meta, merged_meta)? {
					continue;
				}
				files.push(plain_change(merged, rel, ChangeKind::Modified, Some(lower))?);
			},
		}
	}
	for rel in lower_index.keys() {
		if !merged_index.contains_key(rel) {
			files.push(plain_change(lower, rel, ChangeKind::Removed, None)?);
		}
	}

	files.sort_by(|a, b| a.path.cmp(&b.path));
	Ok(Diff { files })
}

fn entries_equal(
	lower: &Path,
	merged: &Path,
	rel: &Path,
	lower_meta: &Metadata,
	merged_meta: &Metadata,
) -> IsoResult<bool> {
	let lower_type = lower_meta.file_type();
	let merged_type = merged_meta.file_type();
	if lower_type != merged_type {
		return Ok(false);
	}
	if lower_type.is_symlink() {
		let lower_target = read_link(&lower.join(rel))?;
		let merged_target = read_link(&merged.join(rel))?;
		return Ok(lower_target == merged_target);
	}
	if !lower_type.is_file() {
		return Ok(true);
	}
	if lower_meta.len() != merged_meta.len() {
		return Ok(false);
	}
	if let (Ok(lower_mtime), Ok(merged_mtime)) = (lower_meta.modified(), merged_meta.modified())
		&& !systime_eq(lower_mtime, merged_mtime)
	{
		return Ok(false);
	}
	files_equal(&lower.join(rel), &merged.join(rel))
}

fn files_equal(left_path: &Path, right_path: &Path) -> IsoResult<bool> {
	use std::io::Read as _;

	let mut left = std::fs::File::open(left_path)
		.map_err(|err| IsoError::other(format!("open {}: {err}", left_path.display())))?;
	let mut right = std::fs::File::open(right_path)
		.map_err(|err| IsoError::other(format!("open {}: {err}", right_path.display())))?;
	let mut left_buf = [0_u8; 8 * 1024];
	let mut right_buf = [0_u8; 8 * 1024];
	loop {
		let left_len = left
			.read(&mut left_buf)
			.map_err(|err| IsoError::other(format!("read {}: {err}", left_path.display())))?;
		let right_len = right
			.read(&mut right_buf)
			.map_err(|err| IsoError::other(format!("read {}: {err}", right_path.display())))?;
		if left_len != right_len {
			return Ok(false);
		}
		if left_buf[..left_len] != right_buf[..left_len] {
			return Ok(false);
		}
		if left_len == 0 {
			return Ok(true);
		}
	}
}

fn systime_eq(a: SystemTime, b: SystemTime) -> bool {
	a == b
}

fn index_tree(root: &Path) -> IsoResult<BTreeMap<PathBuf, Metadata>> {
	let mut out = BTreeMap::new();
	if !root.exists() {
		return Ok(out);
	}
	walk(root, root, &mut out)?;
	Ok(out)
}

fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<PathBuf, Metadata>) -> IsoResult<()> {
	let entries = std::fs::read_dir(dir)
		.map_err(|err| IsoError::other(format!("read_dir {}: {err}", dir.display())))?;
	for entry in entries {
		let entry =
			entry.map_err(|err| IsoError::other(format!("dir entry in {}: {err}", dir.display())))?;
		let path = entry.path();
		let file_type = entry
			.file_type()
			.map_err(|err| IsoError::other(format!("file_type {}: {err}", path.display())))?;
		if file_type.is_dir() {
			walk(root, &path, out)?;
			continue;
		}
		let meta = std::fs::symlink_metadata(&path)
			.map_err(|err| IsoError::other(format!("metadata {}: {err}", path.display())))?;
		let rel = path.strip_prefix(root).unwrap_or(&path).to_path_buf();
		out.insert(rel, meta);
	}
	Ok(())
}

fn plain_change(
	side: &Path,
	rel: &Path,
	op: ChangeKind,
	peer_root: Option<&Path>,
) -> IsoResult<FileChange> {
	let Some(primary) = read_plain_entry(&side.join(rel))? else {
		return Ok(FileChange { path: rel.to_path_buf(), op, diff: None });
	};
	let (old_bytes, new_bytes) = match op {
		ChangeKind::Added => (Vec::new(), primary),
		ChangeKind::Removed => (primary, Vec::new()),
		ChangeKind::Modified => {
			let peer = peer_root.expect("modified change requires peer root");
			let Some(peer_bytes) = read_plain_entry(&peer.join(rel))? else {
				return Ok(FileChange { path: rel.to_path_buf(), op, diff: None });
			};
			(peer_bytes, primary)
		},
	};
	if looks_binary(&old_bytes) || looks_binary(&new_bytes) {
		return Ok(FileChange { path: rel.to_path_buf(), op, diff: None });
	}
	let (Ok(old_text), Ok(new_text)) =
		(std::str::from_utf8(&old_bytes), std::str::from_utf8(&new_bytes))
	else {
		return Ok(FileChange { path: rel.to_path_buf(), op, diff: None });
	};
	Ok(FileChange {
		path: rel.to_path_buf(),
		op,
		diff: Some(render_unified(rel, op, old_text, new_text)),
	})
}

fn read_plain_entry(path: &Path) -> IsoResult<Option<Vec<u8>>> {
	let meta = std::fs::symlink_metadata(path)
		.map_err(|err| IsoError::other(format!("metadata {}: {err}", path.display())))?;
	if meta.file_type().is_symlink() {
		return read_link(path).map(|target| Some(plain_path_bytes(&target)));
	}
	if meta.is_file() {
		return read_file(path).map(Some);
	}
	Ok(None)
}

fn read_file(path: &Path) -> IsoResult<Vec<u8>> {
	std::fs::read(path).map_err(|err| IsoError::other(format!("read {}: {err}", path.display())))
}

fn read_link(path: &Path) -> IsoResult<PathBuf> {
	std::fs::read_link(path)
		.map_err(|err| IsoError::other(format!("read_link {}: {err}", path.display())))
}

#[cfg(unix)]
fn plain_path_bytes(path: &Path) -> Vec<u8> {
	use std::os::unix::ffi::OsStrExt as _;
	path.as_os_str().as_bytes().to_vec()
}

#[cfg(not(unix))]
fn plain_path_bytes(path: &Path) -> Vec<u8> {
	path.to_string_lossy().into_owned().into_bytes()
}

fn render_unified(rel: &Path, op: ChangeKind, old: &str, new: &str) -> String {
	let rel_str = rel.to_string_lossy();
	let (from_label, to_label) = match op {
		ChangeKind::Added => (String::from("/dev/null"), format!("b/{rel_str}")),
		ChangeKind::Removed => (format!("a/{rel_str}"), String::from("/dev/null")),
		ChangeKind::Modified => (format!("a/{rel_str}"), format!("b/{rel_str}")),
	};
	use std::fmt::Write as _;
	let mut out = String::new();
	let _ = writeln!(out, "diff --git a/{rel_str} b/{rel_str}");
	match op {
		ChangeKind::Added => {
			let _ = writeln!(out, "new file mode 100644");
		},
		ChangeKind::Removed => {
			let _ = writeln!(out, "deleted file mode 100644");
		},
		ChangeKind::Modified => {},
	}
	let body = similar::TextDiff::from_lines(old, new)
		.unified_diff()
		.context_radius(3)
		.header(&from_label, &to_label)
		.to_string();
	out.push_str(&body);
	if !out.ends_with('\n') {
		out.push('\n');
	}
	out
}

fn looks_binary(bytes: &[u8]) -> bool {
	bytes.iter().take(8192).any(|&b| b == 0)
}

#[cfg(test)]
mod tests {
	use std::{
		fs::{self, File, FileTimes},
		path::{Path, PathBuf},
		sync::atomic::{AtomicU64, Ordering},
		time::{Duration, SystemTime},
	};

	use super::{ChangeKind, index_tree, parse_git_diff, walk_diff_blocking};

	static NEXT_TEMP_DIR: AtomicU64 = AtomicU64::new(0);

	struct TempDir(PathBuf);

	impl TempDir {
		fn new(label: &str) -> Self {
			let sequence = NEXT_TEMP_DIR.fetch_add(1, Ordering::Relaxed);
			let path = std::env::temp_dir()
				.join(format!("pi-iso-diff-{label}-{}-{sequence}", std::process::id()));
			fs::create_dir(&path).expect("create test directory");
			Self(path)
		}

		fn path(&self) -> &Path {
			&self.0
		}
	}

	impl Drop for TempDir {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	#[test]
	fn same_size_edit_with_identical_mtime_is_reported() {
		let temp = TempDir::new("same-metadata");
		let lower = temp.path().join("lower");
		let merged = temp.path().join("merged");
		fs::create_dir_all(&lower).unwrap();
		fs::create_dir_all(&merged).unwrap();

		let lower_file = lower.join("settings.txt");
		let merged_file = merged.join("settings.txt");
		fs::write(&lower_file, b"alpha\n").unwrap();
		fs::copy(&lower_file, &merged_file).unwrap();
		let snapshot_mtime = fs::metadata(&lower_file).unwrap().modified().unwrap();

		fs::write(&merged_file, b"omega\n").unwrap();
		File::options()
			.write(true)
			.open(&merged_file)
			.unwrap()
			.set_times(FileTimes::new().set_modified(snapshot_mtime))
			.unwrap();
		assert_eq!(
			fs::metadata(&lower_file).unwrap().len(),
			fs::metadata(&merged_file).unwrap().len()
		);
		assert_eq!(
			fs::metadata(&lower_file).unwrap().modified().unwrap(),
			fs::metadata(&merged_file).unwrap().modified().unwrap()
		);

		let diff = walk_diff_blocking(&lower, &merged).unwrap();
		assert_eq!(diff.files.len(), 1, "same-metadata content edit was dropped");
		assert_eq!(diff.files[0].path, PathBuf::from("settings.txt"));
		assert_eq!(diff.files[0].op, ChangeKind::Modified);
		assert!(diff.files[0].diff.as_deref().unwrap().contains("+omega"));
	}

	#[test]
	fn same_size_edit_with_different_subsecond_mtime_is_reported() {
		let temp = TempDir::new("subsecond-mtime");
		let lower = temp.path().join("lower");
		let merged = temp.path().join("merged");
		fs::create_dir_all(&lower).unwrap();
		fs::create_dir_all(&merged).unwrap();

		let lower_file = lower.join("flag.txt");
		let merged_file = merged.join("flag.txt");
		fs::write(&lower_file, b"false").unwrap();
		fs::write(&merged_file, b"true!").unwrap();
		let second = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
		File::options()
			.write(true)
			.open(&lower_file)
			.unwrap()
			.set_times(FileTimes::new().set_modified(second + Duration::from_millis(100)))
			.unwrap();
		File::options()
			.write(true)
			.open(&merged_file)
			.unwrap()
			.set_times(FileTimes::new().set_modified(second + Duration::from_millis(200)))
			.unwrap();
		let lower_mtime = fs::metadata(&lower_file).unwrap().modified().unwrap();
		let merged_mtime = fs::metadata(&merged_file).unwrap().modified().unwrap();
		assert_ne!(lower_mtime, merged_mtime);
		assert_eq!(
			lower_mtime
				.duration_since(SystemTime::UNIX_EPOCH)
				.unwrap()
				.as_secs(),
			merged_mtime
				.duration_since(SystemTime::UNIX_EPOCH)
				.unwrap()
				.as_secs()
		);

		let diff = walk_diff_blocking(&lower, &merged).unwrap();
		assert_eq!(diff.files.len(), 1, "subsecond same-size edit was dropped");
		assert_eq!(diff.files[0].path, PathBuf::from("flag.txt"));
		assert_eq!(diff.files[0].op, ChangeKind::Modified);
	}

	#[cfg(unix)]
	#[test]
	fn directory_symlink_target_is_diffed_without_walking_outside_tree() {
		use std::os::unix::fs::symlink;

		let temp = TempDir::new("outside-symlink");
		let lower = temp.path().join("lower");
		let merged = temp.path().join("merged");
		let old_target = temp.path().join("outside-old");
		let new_target = temp.path().join("outside-new");
		for dir in [&lower, &merged, &old_target, &new_target] {
			fs::create_dir_all(dir).unwrap();
		}
		fs::write(old_target.join("old-secret.txt"), "outside old").unwrap();
		fs::write(new_target.join("new-secret.txt"), "outside new").unwrap();
		symlink(&old_target, lower.join("linked")).unwrap();
		symlink(&new_target, merged.join("linked")).unwrap();

		for root in [&lower, &merged] {
			let index = index_tree(root).unwrap();
			assert_eq!(index.keys().cloned().collect::<Vec<_>>(), vec![PathBuf::from("linked")]);
			assert!(index[Path::new("linked")].file_type().is_symlink());
		}
		let diff = walk_diff_blocking(&lower, &merged).unwrap();
		assert_eq!(diff.files.len(), 1, "changed symlink target was dropped");
		let change = &diff.files[0];
		assert_eq!(change.path, PathBuf::from("linked"));
		assert_eq!(change.op, ChangeKind::Modified);
		assert!(
			change
				.diff
				.as_deref()
				.unwrap()
				.contains(&new_target.to_string_lossy().into_owned()),
			"symlink target change was not rendered"
		);
	}

	#[cfg(unix)]
	#[test]
	fn symlink_cycle_is_recorded_without_recursing() {
		use std::os::unix::fs::symlink;

		let temp = TempDir::new("symlink-cycle");
		let lower = temp.path().join("lower");
		let merged = temp.path().join("merged");
		fs::create_dir_all(&lower).unwrap();
		fs::create_dir_all(&merged).unwrap();
		symlink(".", lower.join("cycle")).unwrap();
		symlink(".", merged.join("cycle")).unwrap();

		let diff = walk_diff_blocking(&lower, &merged).expect("symlink cycle must terminate");
		assert!(diff.is_empty());
	}

	#[test]
	fn invalid_utf8_in_one_patch_does_not_erase_other_changes() {
		let mut patch = b"diff --git a/latin.txt b/latin.txt\n--- a/latin.txt\n+++ b/latin.txt\n@@ -1 +1 @@\n-old\n+".to_vec();
		patch.extend_from_slice(&[0xff, b'\n']);
		patch.extend_from_slice(
			b"diff --git a/valid.txt b/valid.txt\n--- a/valid.txt\n+++ b/valid.txt\n@@ -1 +1 @@\n-old\n+new\n",
		);

		let changes = parse_git_diff(&patch);
		assert_eq!(changes.len(), 2);
		let valid = changes
			.iter()
			.find(|change| change.path == Path::new("valid.txt"))
			.expect("valid patch after invalid UTF-8 must survive");
		assert!(valid.diff.as_deref().unwrap().contains("+new"));
	}

	#[test]
	fn git_diff_paths_with_spaces_and_c_escapes_are_decoded() {
		let changes = parse_git_diff(
			b"diff --git a/foo bar b/foo bar\nold mode 100644\nnew mode 100755\n\
			  diff --git \"a/tab\\tname.txt\" \"b/tab\\tname.txt\"\nold mode 100644\nnew mode 100755\n",
		);

		assert_eq!(changes.len(), 2);
		assert_eq!(changes[0].path, PathBuf::from("foo bar"));
		assert_eq!(changes[1].path, PathBuf::from("tab\tname.txt"));
	}
}
