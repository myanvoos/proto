use std::{
	collections::{BTreeMap, HashSet},
	path::{Path, PathBuf},
	sync::LazyLock,
};

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::{
	iofs::{self, FileType, GlobMatch},
	task,
};

const AGENTS_MD_FILENAME: &str = "AGENTS.md";
const AGENTS_MD_MIN_DEPTH: usize = 1;
const AGENTS_MD_MAX_DEPTH: usize = 4;
const AGENTS_MD_LIMIT: usize = 200;
const MAX_ENTRIES: usize = 100_000;

const EXCLUDED_DIRS: &[&str] = &[
	"node_modules",
	".git",
	".next",
	"dist",
	"build",
	"target",
	".venv",
	".cache",
	".turbo",
	".parcel-cache",
	"coverage",
];

static EXCLUDED_DIR_SET: LazyLock<HashSet<&'static str>> =
	LazyLock::new(|| EXCLUDED_DIRS.iter().copied().collect());

#[napi(object)]
pub struct ListWorkspaceOptions<'env> {
	pub path: String,

	pub max_depth: u32,

	pub hidden: Option<bool>,

	pub gitignore: Option<bool>,

	pub collect_agents_md: Option<bool>,

	pub report_directory_errors: Option<bool>,

	pub prune_excluded_dirs: Option<bool>,

	pub timeout_ms: Option<u32>,

	pub signal: Option<Unknown<'env>>,
}

#[napi(object)]
pub struct ListWorkspaceResult {
	pub entries: Vec<GlobMatch>,

	pub agents_md_files: Vec<String>,

	pub truncated: bool,

	pub directory_errors: Option<Vec<WorkspaceDirectoryError>>,
}

#[napi(object)]
pub struct WorkspaceDirectoryError {
	pub path:  String,
	pub error: String,
}

struct WorkspaceConfig {
	root:                    PathBuf,
	max_depth:               usize,
	walk_max_depth:          usize,
	include_hidden:          bool,
	use_gitignore:           bool,
	collect_agents_md:       bool,
	report_directory_errors: bool,
	prune_excluded_dirs:     bool,
}

fn build_workspace_walk_request(config: &WorkspaceConfig) -> pi_walker::WalkRequest {
	pi_walker::WalkRequest::new(config.root.clone())
		.hidden(config.include_hidden)
		.gitignore(config.use_gitignore)
		.skip_git(config.prune_excluded_dirs)
		.skip_node_modules(config.prune_excluded_dirs)
		.follow_links(pi_walker::FollowLinks::Never)
		.detail(pi_walker::WalkDetail::Full)
		.detail_max_depth(config.max_depth)
		.unignored_file_name(config.collect_agents_md.then_some(AGENTS_MD_FILENAME))
		.order(pi_walker::WalkOrder::Path)
		.emit_root(false)
		.depth(1, config.walk_max_depth)
		.directory_errors(if config.report_directory_errors {
			pi_walker::DirectoryErrorMode::Visit
		} else {
			pi_walker::DirectoryErrorMode::SkipSkippable
		})
		.cache(false)
}

fn is_file_or_file_symlink(path: &Path, file_type: FileType) -> bool {
	match file_type {
		FileType::File => true,
		FileType::Symlink => std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file()),
		FileType::Dir => false,
	}
}

struct WorkspaceEntries {
	entries:             Vec<GlobMatch>,
	bounded_entries:     Option<BTreeMap<String, GlobMatch>>,
	agents_md_files:     Vec<String>,
	entries_truncated:   bool,
	agents_md_truncated: bool,
}

impl WorkspaceEntries {
	const fn new() -> Self {
		Self {
			entries:             Vec::new(),
			bounded_entries:     None,
			agents_md_files:     Vec::new(),
			entries_truncated:   false,
			agents_md_truncated: false,
		}
	}

	fn add_entry(&mut self, entry: GlobMatch) {
		if let Some(entries) = &mut self.bounded_entries {
			insert_bounded_entry(entries, entry);
			self.entries_truncated = entries.len() > MAX_ENTRIES;
			return;
		}

		self.entries.push(entry);
		if self.entries.len() <= MAX_ENTRIES {
			return;
		}

		let entries = std::mem::take(&mut self.entries);
		let mut bounded_entries = BTreeMap::new();
		for entry in entries {
			insert_bounded_entry(&mut bounded_entries, entry);
		}
		self.entries_truncated = bounded_entries.len() > MAX_ENTRIES;
		self.bounded_entries = Some(bounded_entries);
	}

	fn add_agents_md_file(&mut self, path: String) {
		self.agents_md_files.push(path);
		if self.agents_md_files.len() <= AGENTS_MD_LIMIT {
			return;
		}

		sort_dedup_paths(&mut self.agents_md_files);
		if self.agents_md_files.len() > AGENTS_MD_LIMIT {
			self.agents_md_truncated = true;
			self.agents_md_files.truncate(AGENTS_MD_LIMIT);
		}
	}

	fn finish(self) -> (Vec<GlobMatch>, Vec<String>, bool) {
		let bounded = self.bounded_entries.is_some();
		let mut entries = match self.bounded_entries {
			Some(entries) => entries.into_values().collect(),
			None => self.entries,
		};
		if !bounded {
			sort_dedup_entries(&mut entries);
		}
		let mut entries_truncated = self.entries_truncated;
		if entries.len() > MAX_ENTRIES {
			entries_truncated = true;
			entries.truncate(MAX_ENTRIES);
		}

		let mut agents_md_files = self.agents_md_files;
		sort_dedup_paths(&mut agents_md_files);
		let mut agents_md_truncated = self.agents_md_truncated;
		if agents_md_files.len() > AGENTS_MD_LIMIT {
			agents_md_truncated = true;
			agents_md_files.truncate(AGENTS_MD_LIMIT);
		}

		(entries, agents_md_files, entries_truncated || agents_md_truncated)
	}
}

fn insert_bounded_entry(entries: &mut BTreeMap<String, GlobMatch>, entry: GlobMatch) {
	let path = entry.path.clone();
	if entries.contains_key(&path) {
		return;
	}
	if entries.len() < MAX_ENTRIES + 1 {
		entries.insert(path, entry);
		return;
	}
	let should_insert = entries
		.last_key_value()
		.is_none_or(|(largest, _)| path.as_str() < largest.as_str());
	if should_insert {
		entries.pop_last();
		entries.insert(path, entry);
	}
}

fn is_excluded_workspace_entry(relative: &str, file_type: FileType, prune_dirs: bool) -> bool {
	let mut components = relative
		.split('/')
		.filter(|component| !component.is_empty())
		.peekable();
	while let Some(component) = components.next() {
		if component == ".DS_Store" {
			return true;
		}
		let is_final_component = components.peek().is_none();
		if prune_dirs
			&& EXCLUDED_DIR_SET.contains(component)
			&& (!is_final_component || file_type == FileType::Dir)
		{
			return true;
		}
	}
	false
}

fn sort_dedup_entries(entries: &mut Vec<GlobMatch>) {
	entries.sort_unstable_by(|a, b| a.path.cmp(&b.path));
	entries.dedup_by(|a, b| a.path == b.path);
}

fn sort_dedup_paths(paths: &mut Vec<String>) {
	paths.sort_unstable();
	paths.dedup();
}

fn run_list_workspace(
	config: WorkspaceConfig,
	ct: task::CancelToken,
) -> Result<ListWorkspaceResult> {
	let mut entries = WorkspaceEntries::new();
	let mut directory_errors = Vec::new();
	if config.report_directory_errors {
		std::fs::read_dir(&config.root).map_err(|error| {
			Error::from_reason(format!(
				"Native directory scan failed for {}: {error}",
				config.root.display()
			))
		})?;
	}

	build_workspace_walk_request(&config)
		.for_each_entry_with_heartbeat(
			|| ct.heartbeat(),
			|entry| {
				let file_type = iofs::from_walker_file_type(entry.file_type);
				if is_excluded_workspace_entry(
					entry.relative_path,
					file_type,
					config.prune_excluded_dirs,
				) {
					return Ok(if file_type == FileType::Dir {
						pi_walker::WalkDecision::SkipDescend
					} else {
						pi_walker::WalkDecision::Skip
					});
				}

				let entry_depth = entry.depth;
				if config.collect_agents_md {
					if file_type == FileType::Dir && entry_depth == config.walk_max_depth {
						let candidate = entry.absolute_path.join(AGENTS_MD_FILENAME);
						if (AGENTS_MD_MIN_DEPTH..=AGENTS_MD_MAX_DEPTH).contains(&entry_depth)
							&& std::fs::metadata(&candidate).is_ok_and(|metadata| metadata.is_file())
						{
							entries.add_agents_md_file(
								pi_walker::normalize_relative_path(&config.root, &candidate).into_owned(),
							);
						}
					} else if entry.relative_path.rsplit('/').next() == Some(AGENTS_MD_FILENAME)
						&& (AGENTS_MD_MIN_DEPTH..=AGENTS_MD_MAX_DEPTH).contains(&(entry_depth - 1))
						&& is_file_or_file_symlink(entry.absolute_path.as_ref(), file_type)
					{
						entries.add_agents_md_file(entry.relative_path.to_owned());
					}
				}

				if entry_depth <= config.max_depth {
					entries.add_entry(GlobMatch {
						path: entry.relative_path.to_string(),
						file_type,
						mtime: entry.mtime,
						size: entry.size,
					});
				}

				Ok(pi_walker::WalkDecision::Include)
			},
			|error| {
				if config.report_directory_errors {
					if error.path == config.root {
						return Err(Error::from_reason(format!(
							"Native directory scan failed: {}",
							error.error
						)));
					}
					directory_errors.push(WorkspaceDirectoryError {
						path:  pi_walker::normalize_relative_path(&config.root, error.path).into_owned(),
						error: error.error.to_string(),
					});
				}
				Ok(pi_walker::WalkDecision::Include)
			},
		)
		.map_err(iofs::map_walker_error)?;

	let (entries, agents_md_files, truncated) = entries.finish();
	Ok(ListWorkspaceResult {
		entries,
		agents_md_files,
		truncated,
		directory_errors: (!directory_errors.is_empty()).then_some(directory_errors),
	})
}

#[napi(catch_unwind, js_name = "listWorkspace")]
pub fn list_workspace(options: ListWorkspaceOptions<'_>) -> task::Promise<ListWorkspaceResult> {
	let ListWorkspaceOptions {
		path,
		max_depth,
		hidden,
		gitignore,
		collect_agents_md,
		report_directory_errors,
		prune_excluded_dirs,
		timeout_ms,
		signal,
	} = options;

	let ct = task::CancelToken::new(timeout_ms, signal);
	task::blocking("listWorkspace", ct, move |ct| {
		let max_depth = max_depth as usize;
		let collect_agents_md = collect_agents_md.unwrap_or(false);
		let walk_max_depth = if collect_agents_md {
			max_depth.max(AGENTS_MD_MAX_DEPTH)
		} else {
			max_depth
		};
		run_list_workspace(
			WorkspaceConfig {
				root: pi_walker::resolve_search_path(&path).map_err(crate::iofs::map_walker_error)?,
				max_depth,
				walk_max_depth,
				include_hidden: hidden.unwrap_or(false),
				use_gitignore: gitignore.unwrap_or(true),
				collect_agents_md,
				report_directory_errors: report_directory_errors.unwrap_or(false),
				prune_excluded_dirs: prune_excluded_dirs.unwrap_or(true),
			},
			ct,
		)
	})
}

#[cfg(test)]
mod workspace_regressions {
	use super::*;
	fn config(root: &Path, depth: usize) -> WorkspaceConfig {
		WorkspaceConfig {
			root:                    root.to_path_buf(),
			max_depth:               depth,
			walk_max_depth:          depth,
			include_hidden:          true,
			use_gitignore:           false,
			collect_agents_md:       false,
			report_directory_errors: true,
			prune_excluded_dirs:     false,
		}
	}
	#[test]
	fn explicit_directory_lists_dependency_and_build_dirs() {
		let root = tempfile::tempdir().unwrap();
		std::fs::create_dir(root.path().join("node_modules")).unwrap();
		std::fs::create_dir(root.path().join("target")).unwrap();
		let result =
			run_list_workspace(config(root.path(), 1), task::CancelToken::default()).unwrap();
		let paths: Vec<_> = result
			.entries
			.iter()
			.map(|entry| entry.path.as_str())
			.collect();
		assert_eq!(paths, ["node_modules", "target"]);
	}
	#[cfg(unix)]
	#[test]
	fn unreadable_child_is_marked_and_unreadable_depth_zero_root_rejects() {
		use std::os::unix::fs::PermissionsExt;
		if unsafe { libc::geteuid() } == 0 {
			return;
		}
		let root = tempfile::tempdir().unwrap();
		let child = root.path().join("locked");
		std::fs::create_dir(&child).unwrap();
		std::fs::set_permissions(&child, std::fs::Permissions::from_mode(0)).unwrap();
		let result = run_list_workspace(config(root.path(), 2), task::CancelToken::default());
		let root_result = run_list_workspace(config(&child, 0), task::CancelToken::default());
		std::fs::set_permissions(&child, std::fs::Permissions::from_mode(0o700)).unwrap();
		let errors = result.unwrap().directory_errors.unwrap();
		assert_eq!(errors[0].path, "locked");
		assert!(root_result.is_err());
	}
}
