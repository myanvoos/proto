use std::{cmp::Ordering, path::Path};

use napi::{
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;

pub use crate::iofs::{FileType, GlobMatch};
use crate::{glob_util, iofs, task};

#[napi(object)]
pub struct GlobOptions<'env> {
	pub pattern: String,

	pub path: String,

	pub file_type: Option<FileType>,

	pub recursive: Option<bool>,

	pub hidden: Option<bool>,

	pub max_results: Option<u32>,

	pub gitignore: Option<bool>,

	pub cache: Option<bool>,

	pub sort_by_mtime: Option<bool>,

	pub include_node_modules: Option<bool>,

	pub signal: Option<Unknown<'env>>,

	pub timeout_ms: Option<u32>,
}

#[napi(object)]
pub struct GlobResult {
	pub matches: Vec<GlobMatch>,

	pub total_matches: u32,
}

struct GlobConfig {
	root:                  std::path::PathBuf,
	pattern:               String,
	recursive:             bool,
	include_hidden:        bool,
	file_type_filter:      Option<FileType>,
	max_results:           usize,
	use_gitignore:         bool,
	mentions_node_modules: bool,
	sort_by_mtime:         bool,
	cache:                 bool,
}

fn match_mtime(entry: &GlobMatch) -> f64 {
	entry.mtime.unwrap_or(0.0)
}

fn compare_matches_by_rank(a: &GlobMatch, b: &GlobMatch) -> Ordering {
	match_mtime(b)
		.total_cmp(&match_mtime(a))
		.then_with(|| a.path.cmp(&b.path))
}

fn resolve_symlink_target_type(root: &Path, relative_path: &str) -> Option<FileType> {
	let target_path = root.join(relative_path);
	let metadata = std::fs::metadata(target_path).ok()?;
	if metadata.is_dir() {
		Some(FileType::Dir)
	} else if metadata.is_file() {
		Some(FileType::File)
	} else {
		None
	}
}

fn apply_file_type_filter(entry: &GlobMatch, config: &GlobConfig) -> Option<FileType> {
	let Some(filter) = config.file_type_filter else {
		return Some(entry.file_type);
	};
	if entry.file_type == filter {
		return Some(entry.file_type);
	}
	if entry.file_type != FileType::Symlink {
		return None;
	}
	match filter {
		FileType::File | FileType::Dir => {
			let resolved = resolve_symlink_target_type(&config.root, &entry.path)?;
			if resolved == filter {
				Some(resolved)
			} else {
				None
			}
		},
		FileType::Symlink => None,
	}
}

fn collect_ranked_matches(
	request: &pi_walker::WalkRequest,
	config: &GlobConfig,
	ct: &task::CancelToken,
) -> Result<Vec<GlobMatch>> {
	let outcome = request
		.collect_ranked_with_heartbeat(
			pi_walker::WalkRank::MtimeDescPathAsc,
			config.max_results,
			|| ct.heartbeat(),
		)
		.map_err(iofs::map_walker_error)?;
	Ok(outcome.entries.into_iter().map(GlobMatch::from).collect())
}

fn collect_native_filtered_matches(
	request: &pi_walker::WalkRequest,
	config: &GlobConfig,
	ct: &task::CancelToken,
) -> Result<Vec<GlobMatch>> {
	let outcome = request
		.collect_with_heartbeat(|| ct.heartbeat())
		.map_err(iofs::map_walker_error)?;
	let mut collected = Vec::new();
	for entry in outcome.entries {
		ct.heartbeat()?;
		let mut matched_entry = GlobMatch::from(entry);
		let Some(effective_file_type) = apply_file_type_filter(&matched_entry, config) else {
			continue;
		};
		matched_entry.file_type = effective_file_type;
		collected.push(matched_entry);
		if !config.sort_by_mtime && collected.len() >= config.max_results {
			break;
		}
	}
	Ok(collected)
}

fn run_glob(
	config: GlobConfig,
	on_match: Option<&ThreadsafeFunction<GlobMatch>>,
	ct: task::CancelToken,
) -> Result<GlobResult> {
	let walk_glob_pattern = glob_util::build_glob_pattern(&config.pattern, config.recursive);

	let walk_depth_limit = glob_util::walk_depth_bound(&walk_glob_pattern);
	let walk_glob = pi_walker::CompiledWalkGlob::new([walk_glob_pattern])
		.map_err(|err| Error::from_reason(format!("Invalid glob pattern: {err}")))?;
	if config.max_results == 0 {
		return Ok(GlobResult { matches: Vec::new(), total_matches: 0 });
	}

	let scan_detail = if config.sort_by_mtime {
		pi_walker::WalkDetail::Full
	} else {
		pi_walker::WalkDetail::Minimal
	};
	let base_request = pi_walker::WalkRequest::new(config.root.clone())
		.hidden(config.include_hidden)
		.gitignore(config.use_gitignore)
		.skip_git(true)
		.skip_node_modules(!config.mentions_node_modules)
		.follow_links(pi_walker::FollowLinks::Never)
		.detail(scan_detail)
		.order(pi_walker::WalkOrder::Path)
		.emit_root(false)
		.depth(1, walk_depth_limit)
		.directory_errors(pi_walker::DirectoryErrorMode::SkipSkippable)
		.cache(config.cache)
		.empty_recheck(pi_walker::EmptyRecheck::Configured)
		.filter(
			pi_walker::WalkFilter::all()
				.glob(walk_glob)
				.node_modules_unless_mentioned(config.mentions_node_modules),
		);

	let mut matches = if config.sort_by_mtime && config.file_type_filter.is_none() {
		collect_ranked_matches(&base_request, &config, &ct)?
	} else {
		let request = if !config.sort_by_mtime && config.file_type_filter.is_none() {
			base_request.limit(config.max_results)
		} else {
			base_request
		};
		collect_native_filtered_matches(&request, &config, &ct)?
	};

	if config.sort_by_mtime {
		matches.sort_by(compare_matches_by_rank);
		matches.truncate(config.max_results);
		if let Some(callback) = on_match {
			for matched_entry in &matches {
				callback.call(Ok(matched_entry.clone()), ThreadsafeFunctionCallMode::NonBlocking);
			}
		}
	}
	if !config.sort_by_mtime
		&& let Some(callback) = on_match
	{
		for matched_entry in &matches {
			callback.call(Ok(matched_entry.clone()), ThreadsafeFunctionCallMode::NonBlocking);
		}
	}
	let total_matches = matches.len().min(u32::MAX as usize) as u32;
	Ok(GlobResult { matches, total_matches })
}

#[napi]
pub fn glob(
	options: GlobOptions<'_>,
	#[napi(ts_arg_type = "((error: Error | null, match: GlobMatch) => void) | undefined | null")]
	on_match: Option<ThreadsafeFunction<GlobMatch>>,
) -> task::Promise<GlobResult> {
	let GlobOptions {
		pattern,
		path,
		file_type,
		recursive,
		hidden,
		max_results,
		gitignore,
		sort_by_mtime,
		cache,
		include_node_modules,
		timeout_ms,
		signal,
	} = options;

	let pattern = pattern.trim();
	let pattern = if pattern.is_empty() { "*" } else { pattern };
	let pattern = pattern.to_string();

	let ct = task::CancelToken::new(timeout_ms, signal);

	task::blocking("glob", ct, move |ct| {
		run_glob(
			GlobConfig {
				root: pi_walker::resolve_search_path(&path).map_err(iofs::map_walker_error)?,
				include_hidden: hidden.unwrap_or(false),
				file_type_filter: file_type,
				recursive: recursive.unwrap_or(true),
				max_results: max_results.map_or(usize::MAX, |value| value as usize),
				use_gitignore: gitignore.unwrap_or(true),
				mentions_node_modules: include_node_modules
					.unwrap_or_else(|| pattern.contains("node_modules")),
				sort_by_mtime: sort_by_mtime.unwrap_or(false),
				cache: cache.unwrap_or(false),
				pattern,
			},
			on_match.as_ref(),
			ct,
		)
	})
}
