use std::{
	collections::HashSet,
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

	pub timeout_ms: Option<u32>,

	pub signal: Option<Unknown<'env>>,
}

#[napi(object)]
pub struct ListWorkspaceResult {
	pub entries: Vec<GlobMatch>,

	pub agents_md_files: Vec<String>,

	pub truncated: bool,
}

struct WorkspaceConfig {
	root:              PathBuf,
	max_depth:         usize,
	walk_max_depth:    usize,
	include_hidden:    bool,
	use_gitignore:     bool,
	collect_agents_md: bool,
}

fn build_workspace_walk_request(config: &WorkspaceConfig) -> pi_walker::WalkRequest {
	pi_walker::WalkRequest::new(config.root.clone())
		.hidden(config.include_hidden)
		.gitignore(config.use_gitignore)
		.skip_git(true)
		.skip_node_modules(true)
		.follow_links(pi_walker::FollowLinks::Never)
		.detail(pi_walker::WalkDetail::Full)
		.order(pi_walker::WalkOrder::Path)
		.emit_root(false)
		.depth(1, config.walk_max_depth)
		.directory_errors(pi_walker::DirectoryErrorMode::SkipSkippable)
		.cache(false)
}

fn glob_match_from_path(root: &Path, path: &Path) -> Option<GlobMatch> {
	let relative = pi_walker::normalize_relative_path(root, path);
	if relative.is_empty() {
		return None;
	}
	let (file_type, mtime, size) = pi_walker::classify_file_type(path)?;
	Some(GlobMatch {
		path: relative.into_owned(),
		file_type: crate::iofs::from_walker_file_type(file_type),
		mtime,
		size: size.map(|value| value as f64),
	})
}

fn is_file_or_file_symlink(path: &Path, file_type: FileType) -> bool {
	match file_type {
		FileType::File => true,
		FileType::Symlink => std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file()),
		FileType::Dir => false,
	}
}

fn is_excluded_workspace_entry(relative: &str, file_type: FileType) -> bool {
	let mut components = relative
		.split('/')
		.filter(|component| !component.is_empty())
		.peekable();
	while let Some(component) = components.next() {
		if component == ".DS_Store" {
			return true;
		}
		let is_final_component = components.peek().is_none();
		if EXCLUDED_DIR_SET.contains(component) && (!is_final_component || file_type == FileType::Dir)
		{
			return true;
		}
	}
	false
}

fn collect_agents_md_in_directory(
	config: &WorkspaceConfig,
	directory: &Path,
	directory_depth: usize,
	entries: &mut Vec<GlobMatch>,
	agents_md_files: &mut Vec<String>,
) {
	if !config.collect_agents_md {
		return;
	}
	let candidate = directory.join(AGENTS_MD_FILENAME);
	let Some(entry) = glob_match_from_path(&config.root, &candidate) else {
		return;
	};
	if !is_file_or_file_symlink(&candidate, entry.file_type) {
		return;
	}
	let tree_depth = directory_depth + 1;
	if tree_depth <= config.max_depth {
		entries.push(entry.clone());
	}

	if (AGENTS_MD_MIN_DEPTH..=AGENTS_MD_MAX_DEPTH).contains(&directory_depth) {
		agents_md_files.push(entry.path);
	}
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
	let mut entries = Vec::new();
	let mut agents_md_files = Vec::new();
	collect_agents_md_in_directory(&config, &config.root, 0, &mut entries, &mut agents_md_files);

	let outcome = build_workspace_walk_request(&config)
		.collect_with_heartbeat(|| ct.heartbeat())
		.map_err(iofs::map_walker_error)?;

	for entry in outcome.entries {
		let file_type = iofs::from_walker_file_type(entry.file_type);
		if is_excluded_workspace_entry(&entry.path, file_type) {
			continue;
		}

		let entry_depth = entry.depth();
		if file_type == FileType::Dir {
			let directory = entry.absolute_path(&config.root);
			collect_agents_md_in_directory(
				&config,
				&directory,
				entry_depth,
				&mut entries,
				&mut agents_md_files,
			);
		}

		if entry_depth <= config.max_depth {
			entries.push(entry.into());
		}
	}

	sort_dedup_entries(&mut entries);
	sort_dedup_paths(&mut agents_md_files);

	let entries_truncated = entries.len() > MAX_ENTRIES;
	if entries_truncated {
		entries.truncate(MAX_ENTRIES);
	}
	let agents_md_truncated = agents_md_files.len() > AGENTS_MD_LIMIT;
	if agents_md_truncated {
		agents_md_files.truncate(AGENTS_MD_LIMIT);
	}

	Ok(ListWorkspaceResult {
		entries,
		agents_md_files,
		truncated: entries_truncated || agents_md_truncated,
	})
}

#[napi(js_name = "listWorkspace")]
pub fn list_workspace(options: ListWorkspaceOptions<'_>) -> task::Promise<ListWorkspaceResult> {
	let ListWorkspaceOptions {
		path,
		max_depth,
		hidden,
		gitignore,
		collect_agents_md,
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
			},
			ct,
		)
	})
}
