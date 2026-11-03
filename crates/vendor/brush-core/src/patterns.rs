use std::{collections::VecDeque, path::Path};

use crate::{error, regex, sys, trace_categories};

#[derive(Clone, Debug)]
pub(crate) enum PatternPiece {
	Pattern(String),

	Literal(String),
}

impl PatternPiece {
	pub fn as_str(&self) -> &str {
		match self {
			Self::Pattern(s) => s,
			Self::Literal(s) => s,
		}
	}
}

type PatternWord = Vec<PatternPiece>;

fn component_string(components: &[PatternWord], index: usize) -> Option<String> {
	components
		.get(index)
		.map(|component| component.iter().map(|piece| piece.as_str()).collect())
}

#[derive(Clone, Debug, Default)]
pub(crate) struct FilenameExpansionOptions {
	pub require_dot_in_pattern_to_match_dot_files: bool,
	pub globstar: bool,
	pub cancel: Option<tokio_util::sync::CancellationToken>,
}

#[derive(Clone, Copy, Debug)]
enum GlobstarMode {
	/// `**` ends the pattern: every entry below the base, plus the base itself,
	/// spelled `base/` unless an earlier component is a glob.
	Entries { globbed_base: bool },
	/// `**/`, at the end or followed by more slashes (`**//x`): every directory
	/// below the base (a symlink to a directory counts), plus the base itself.
	Dirs,
	/// More components follow: the base and every real directory below it.
	/// With `link_bases`, also every symlink to a directory found below it,
	/// which is not walked.
	Bases { link_bases: bool },
	/// Directly followed by another `**`: bash collapses the run into its last
	/// `**`, so this one matches nothing of its own.
	Collapsed,
}

/// True for a component spelled exactly `**` by unquoted pattern text.
fn is_globstar_component(component: &PatternWord) -> bool {
	component
		.iter()
		.all(|piece| matches!(piece, PatternPiece::Pattern(_)))
		&& component
			.iter()
			.map(|piece| piece.as_str())
			.collect::<String>()
			== "**"
}

/// True for the empty component between two slashes (or after a final one).
fn is_empty_component(component: &PatternWord) -> bool {
	component.iter().all(|piece| piece.as_str().is_empty())
}

/// Stops expansion with [`error::ErrorKind::Interrupted`] once the run is
/// cancelled.
fn ensure_not_cancelled(
	cancel: Option<&tokio_util::sync::CancellationToken>,
) -> Result<(), error::Error> {
	if cancel.is_some_and(tokio_util::sync::CancellationToken::is_cancelled) {
		return Err(error::ErrorKind::Interrupted.into());
	}
	Ok(())
}

/// The path to ask the filesystem about: matches keep the pattern's spelling
/// (`./`, `../`), but a virtual provider is only asked about lexically
/// normalized paths.

#[derive(Debug, Default)]
pub(crate) enum PatternExpansionResult {
	#[default]
	NoGlob,

	Expanded(Vec<String>),
}

impl PatternExpansionResult {
	pub fn into_paths(self) -> Vec<String> {
		match self {
			Self::NoGlob => vec![],
			Self::Expanded(paths) => paths,
		}
	}

	pub const fn is_unmatched_glob(&self) -> bool {
		matches!(self, Self::Expanded(paths) if paths.is_empty())
	}
}

#[derive(Clone, Debug)]
pub struct Pattern {
	pieces:                   PatternWord,
	enable_extended_globbing: bool,
	multiline:                bool,
	case_insensitive:         bool,
}

impl Default for Pattern {
	fn default() -> Self {
		Self {
			pieces:                   vec![],
			enable_extended_globbing: false,
			multiline:                true,
			case_insensitive:         false,
		}
	}
}

impl From<PatternWord> for Pattern {
	fn from(pieces: PatternWord) -> Self {
		Self { pieces, ..Default::default() }
	}
}

impl From<&PatternWord> for Pattern {
	fn from(value: &PatternWord) -> Self {
		Self { pieces: value.clone(), ..Default::default() }
	}
}

impl From<&str> for Pattern {
	fn from(value: &str) -> Self {
		Self { pieces: vec![PatternPiece::Pattern(value.to_owned())], ..Default::default() }
	}
}

impl From<String> for Pattern {
	fn from(value: String) -> Self {
		Self { pieces: vec![PatternPiece::Pattern(value)], ..Default::default() }
	}
}

impl Pattern {
	#[must_use]
	pub const fn set_extended_globbing(mut self, value: bool) -> Self {
		self.enable_extended_globbing = value;
		self
	}

	#[must_use]
	pub const fn set_multiline(mut self, value: bool) -> Self {
		self.multiline = value;
		self
	}

	#[must_use]
	pub const fn set_case_insensitive(mut self, value: bool) -> Self {
		self.case_insensitive = value;
		self
	}

	pub fn is_empty(&self) -> bool {
		self.pieces.iter().all(|p| p.as_str().is_empty())
	}

	pub(crate) const fn accept_all_expand_filter(_path: &Path) -> bool {
		true
	}

	#[expect(clippy::too_many_lines)]
	pub(crate) fn expand(
		&self,
		working_dir: &Path,
		path_filter: Option<&dyn Fn(&Path) -> bool>,
		options: &FilenameExpansionOptions,
	) -> Result<PatternExpansionResult, error::Error> {
		// If the pattern has no pieces at all, short-circuit; there's nothing to
		// expand. Note: we intentionally do NOT short-circuit when pieces are present
		// but empty (e.g. from a quoted empty string ""); those fall through to the
		// literal branch below which correctly returns Expanded([""]) instead of
		// NoGlob, preserving the argument even when nullglob is enabled.
		if self.pieces.is_empty() {
			return Ok(PatternExpansionResult::NoGlob);

		// Similarly, if we're *confident* the pattern doesn't require expansion,
		// then we know there's a single expansion (before filtering).
		} else if !self.pieces.iter().any(|piece| {
			matches!(piece, PatternPiece::Pattern(_))
				&& requires_expansion(piece.as_str(), self.enable_extended_globbing)
		}) {
			let concatenated: String = self.pieces.iter().map(|piece| piece.as_str()).collect();

			return Ok(PatternExpansionResult::Expanded(vec![concatenated]));
		}

		tracing::debug!(target: trace_categories::PATTERN, "expanding pattern: {self:?}");

		let mut components: Vec<PatternWord> = vec![];
		for piece in &self.pieces {
			let mut split_result: VecDeque<_> = sys::fs::split_path_for_pattern(piece.as_str())
				.map(|s| match piece {
					PatternPiece::Pattern(_) => PatternPiece::Pattern(s.to_owned()),
					PatternPiece::Literal(_) => PatternPiece::Literal(s.to_owned()),
				})
				.collect();

			if let Some(first_piece) = split_result.pop_front() {
				if let Some(last_component) = components.last_mut() {
					last_component.push(first_piece);
				} else {
					components.push(vec![first_piece]);
				}
			}

			while let Some(piece) = split_result.pop_front() {
				components.push(vec![piece]);
			}
		}

		// Check if the path appears to be absolute by inspecting the first components.
		// On Unix, a leading `/` produces an empty first component. On Windows, a
		// drive-letter prefix like `c:` is also recognized, and a forward-slash
		// MSYS/WSL drive alias (`/d/...`, `/mnt/d/...`) must be translated before
		// `read_dir()` sees the root.
		let starts_with_forward_slash = self
			.pieces
			.iter()
			.find_map(|piece| piece.as_str().as_bytes().first().copied())
			.is_some_and(|byte| byte == b'/');
		let first_component = component_string(&components, 0);
		let second_component = component_string(&components, 1);
		let third_component = component_string(&components, 2);
		let alias_root = first_component.as_deref().and_then(|first| {
			sys::fs::pattern_drive_alias_root(
				starts_with_forward_slash,
				first,
				second_component.as_deref(),
				third_component.as_deref(),
			)
		});
		let (absolute_root, components_to_remove) = if let Some((root, consumed)) = alias_root {
			(Some(root), consumed)
		} else {
			(
				first_component
					.as_deref()
					.and_then(sys::fs::pattern_path_root),
				1,
			)
		};

		let prefix_to_remove;
		let mut paths_so_far = if let Some(root) = absolute_root {
			prefix_to_remove = None;
			// Skip the component(s) consumed to determine the root.
			drop(components.drain(0..components_to_remove));
			vec![root]
		} else {
			// Build a prefix to remove after glob expansion so results are
			// returned relative to the working directory. The prefix is
			// normalized to use `/` separators because `push_path_for_pattern`
			// also uses `/` on Windows (to avoid `PathBuf::push` drive-letter
			// semantics) — if we left `\` here, the strip_prefix below would
			// miss on Windows and leave results as absolute paths.
			let working_dir_str = working_dir.to_string_lossy();
			let mut working_dir_str =
				sys::fs::normalize_path_separators(&working_dir_str).into_owned();
			if !working_dir_str.ends_with('/') {
				working_dir_str.push('/');
			}

			prefix_to_remove = Some(working_dir_str);
			vec![working_dir.to_path_buf()]
		};

		// Under `globstar`, bash reads a run of slashes after `**` as one
		// (`**//` is `**/`), and `**//**` as `**/**`. A single slash between
		// `**` and a pattern component still counts: `**//x` takes `**/` as
		// its directory part (see `GlobstarMode::Dirs`).
		if options.globstar {
			let mut kept: Vec<PatternWord> = Vec::with_capacity(components.len());
			for component in components {
				let after_globstar_slash = kept.len() >= 2
					&& kept.last().is_some_and(is_empty_component)
					&& is_globstar_component(&kept[kept.len() - 2]);
				if after_globstar_slash && is_empty_component(&component) {
					continue;
				}
				if after_globstar_slash && is_globstar_component(&component) {
					kept.pop();
				}
				kept.push(component);
			}
			components = kept;
		}

		// Under `globstar`, what each `**` component matches depends on what
		// comes before and after it (see `GlobstarMode`); decide it before the
		// loop consumes the components.
		let last_index = components.len().saturating_sub(1);
		let is_globbed = |component: &PatternWord| {
			component.iter().any(|piece| {
				matches!(piece, PatternPiece::Pattern(_))
					&& requires_expansion(piece.as_str(), self.enable_extended_globbing)
			})
		};
		// One slot per component, so the mode a `**` component gets cannot drift
		// from the component the loop below is at.
		let globstar_modes: Vec<Option<GlobstarMode>> = if options.globstar {
			components
				.iter()
				.enumerate()
				.map(|(index, component)| {
					if !is_globstar_component(component) {
						return None;
					}
					Some(if components.get(index + 1).is_some_and(is_globstar_component) {
						GlobstarMode::Collapsed
					} else if index == last_index {
						// Bash spells the zero-depth match as the directory before
						// `**` was spelled, with its slash only when no earlier
						// component is a glob: `a1/**` gives `a1/`, `*/**` gives
						// `a1`, `**/sub/**` gives `d1/sub`.
						let globbed_base = components[..index].iter().any(is_globbed);
						GlobstarMode::Entries { globbed_base }
					} else if is_empty_component(&components[index + 1]) {
						// `**/` ends the pattern, or a slash follows it (`**//x`,
						// one empty component after the collapse above). Bash takes
						// `**/` as the directory part either way, so the bases are
						// the directories `**/` lists.
						GlobstarMode::Dirs
					} else {
						// Bash takes symlinks to directories as bases (one hop, not
						// walked) unless everything before `**` is `**`: `a1/**/x`,
						// `./**/x` and `/**/x` reach `a1/lup/x`, `**/x` does not.
						let link_bases = prefix_to_remove.is_none()
							|| components[..index]
								.iter()
								.any(|c| !is_globstar_component(c));
						GlobstarMode::Bases { link_bases }
					})
				})
				.collect()
		} else {
			Vec::new()
		};
		let relative_root = prefix_to_remove
			.is_some()
			.then(|| working_dir.to_path_buf());
		let globstar_walked = globstar_modes.iter().any(Option::is_some);

		// Literal components after the last glob are appended to every match
		// without being listed, so nothing has proven they exist yet: `*/x`
		// would keep `file/x`, and `*/` would keep `file/`. Bash keeps only
		// paths that exist, and a trailing `/` keeps only directories.
		let mut globbed = false;
		let mut unverified_suffix = false;
		let mut trailing_slash = false;
		for (index, component) in components.into_iter().enumerate() {
			if !component.iter().any(|piece| {
				matches!(piece, PatternPiece::Pattern(_))
					&& requires_expansion(piece.as_str(), self.enable_extended_globbing)
			}) {
				let flattened = component
					.iter()
					.map(|piece| piece.as_str())
					.collect::<String>();
				for p in &mut paths_so_far {
					sys::fs::push_path_for_pattern(p, &flattened);
				}
				unverified_suffix = globbed;
				trailing_slash = flattened.is_empty();
				continue;
			}
			globbed = true;
			unverified_suffix = false;

			if let Some(mode) = globstar_modes.get(index).copied().flatten() {
				if matches!(mode, GlobstarMode::Collapsed) {
					continue;
				}
				paths_so_far = Self::expand_globstar(
					std::mem::take(&mut paths_so_far),
					mode,
					relative_root.as_deref(),
					!options.require_dot_in_pattern_to_match_dot_files,
					options.cancel.as_ref(),
				)?;
				continue;
			}
			let current_paths = std::mem::take(&mut paths_so_far);
			for current_path in current_paths {
				// After a `**` walk this lists every directory it found again.
				ensure_not_cancelled(options.cancel.as_ref())?;
				let subpattern = Self::from(&component)
					.set_extended_globbing(self.enable_extended_globbing)
					.set_case_insensitive(self.case_insensitive);

				let subpattern_starts_with_dot = subpattern
					.pieces
					.first()
					.is_some_and(|piece| piece.as_str().starts_with('.'));

				let allow_dot_files =
					!options.require_dot_in_pattern_to_match_dot_files || subpattern_starts_with_dot;

				let regex = subpattern.to_regex(true, true)?;

				// Matches keep the pattern's spelling (`./`, `../`), but a virtual
				// provider is only asked to list a lexically normalized path.
				let listing = std::fs::read_dir(&current_path);
				let mut matching_paths_in_dir: Vec<_> = Vec::new();
				if let Ok(entries) = listing {
					for entry in entries.filter_map(Result::ok) {
						// One directory can hold millions of entries, and nothing
						// here yields on the native route.
						ensure_not_cancelled(options.cancel.as_ref())?;
						let file_name = entry.file_name();
						let name = file_name.to_string_lossy();
						if !allow_dot_files && name.starts_with('.') {
							continue;
						}
						// Raw names match as on any filesystem; a pattern
						// spelled as an absolute URL may also name the
						// encoded segment (`my%20*`).
						let matches = regex.is_match(name.as_ref()).unwrap_or(false);
						if matches {
							matching_paths_in_dir.push(current_path.join(&file_name));
						}
					}
				}

				matching_paths_in_dir.sort();

				paths_so_far.append(&mut matching_paths_in_dir);
			}
		}

		if unverified_suffix {
			let mut existing = Vec::with_capacity(paths_so_far.len());
			for path in paths_so_far {
				// After a `**` walk this probes a path under every directory.
				ensure_not_cancelled(options.cancel.as_ref())?;
				let probe = &path;
				// `*/` follows symlinks like bash (a link to a directory
				// matches); a named suffix only has to exist, dangling or not.
				let exists = if trailing_slash {
					probe.is_dir()
				} else {
					std::fs::symlink_metadata(probe).is_ok()
				};
				if exists {
					existing.push(path);
				}
			}
			paths_so_far = existing;
		}

		let results: Vec<_> = paths_so_far
			.into_iter()
			.filter_map(|path| {
				if path_filter.is_some_and(|filter| !filter(&path)) {
					return None;
				}
				// Normalize separators *before* stripping the working-dir
				// prefix so that `prefix_to_remove` (already normalized to
				// use `/`) matches paths that may contain a mix of `\` and
				// `/` on Windows.
				let path_str = path.to_string_lossy();
				let normalized = sys::fs::normalize_path_separators(&path_str);
				let mut path_ref: &str = normalized.as_ref();

				if let Some(prefix_to_remove) = &prefix_to_remove
					&& let Some(stripped) = path_ref.strip_prefix(prefix_to_remove.as_str())
				{
					path_ref = stripped;
				}

				Some(path_ref.to_string())
			})
			.collect();

		// Bash sorts the whole result. Without `**` each component's listing is
		// already sorted per base; a walk mixes depths (`**/*.rs` lists the base
		// before its subdirectories), so sort it all.
		let results = if globstar_walked {
			let mut results = results;
			results.sort();
			results
		} else {
			results
		};

		tracing::debug!(target: trace_categories::PATTERN, "  => results: {results:?}");

		Ok(PatternExpansionResult::Expanded(results))
	}

	fn expand_globstar(
		bases: Vec<std::path::PathBuf>,
		mode: GlobstarMode,
		relative_root: Option<&Path>,
		allow_dot_files: bool,
		cancel: Option<&tokio_util::sync::CancellationToken>,
	) -> Result<Vec<std::path::PathBuf>, error::Error> {
		let mut matches = Vec::new();

		for base in bases {
			// Each base costs a synchronous probe on the native route, and a
			// base that is not a directory never reaches the walk's check below.
			ensure_not_cancelled(cancel)?;
			if !base.is_dir() {
				continue;
			}
			// Byte comparison: `./**/` must still list `./`, though `cwd/.` and
			// `cwd` are equal as `Path`s.
			let is_root = relative_root.is_some_and(|root| root.as_os_str() == base.as_os_str());
			match mode {
				GlobstarMode::Entries { globbed_base: true } if !is_root => matches.push(base.clone()),
				GlobstarMode::Entries { globbed_base: false } if !is_root => {
					let mut itself = base.clone();
					sys::fs::push_path_for_pattern(&mut itself, "");
					matches.push(itself);
				},
				GlobstarMode::Dirs if !is_root => matches.push(base.clone()),
				GlobstarMode::Bases { .. } => matches.push(base.clone()),
				GlobstarMode::Entries { .. } | GlobstarMode::Dirs | GlobstarMode::Collapsed => {},
			}

			let mut pending = vec![base];
			while let Some(dir) = pending.pop() {
				ensure_not_cancelled(cancel)?;
				let Ok(listing) = std::fs::read_dir(&dir) else {
					continue;
				};
				for entry in listing.filter_map(Result::ok) {
					// A single directory can hold millions of entries, and on the
					// native route nothing below yields, so a timeout arriving
					// during this loop is only seen if it is read here.
					ensure_not_cancelled(cancel)?;
					let file_name = entry.file_name();
					if !allow_dot_files && file_name.to_string_lossy().starts_with('.') {
						continue;
					}
					let path = dir.join(&file_name);
					// The entry's own type: a symlink to a directory is not walked.
					let file_type = entry.file_type().ok();
					let real_dir = file_type.is_some_and(|file_type| file_type.is_dir());
					let may_link_dir = file_type.is_none_or(|file_type| file_type.is_symlink());
					let matched = match mode {
						GlobstarMode::Entries { .. } => true,
						GlobstarMode::Dirs | GlobstarMode::Bases { link_bases: true } => {
							real_dir || (may_link_dir && path.is_dir())
						},
						GlobstarMode::Bases { link_bases: false } | GlobstarMode::Collapsed => real_dir,
					};
					if real_dir {
						pending.push(path.clone());
					}
					if matched {
						matches.push(path);
					}
				}
			}
		}

		// One sorted list across all bases, as bash prints it. Nested bases
		// (`**/b*/**` with `a/b1` and `a/b1/b2`) reach the same path once per
		// base, and bash keeps each of those words.
		matches.sort();
		Ok(matches)
	}

	pub(crate) fn to_regex_str(
		&self,
		strict_prefix_match: bool,
		strict_suffix_match: bool,
	) -> Result<String, error::Error> {
		let mut regex_str = String::new();

		if strict_prefix_match {
			regex_str.push('^');
		}

		let mut current_pattern = String::new();
		for piece in &self.pieces {
			match piece {
				PatternPiece::Pattern(s) => {
					current_pattern.push_str(s);
				},
				PatternPiece::Literal(s) => {
					for c in s.chars() {
						if crate::regex::regex_char_is_special(c) {
							current_pattern.push('\\');
						}
						current_pattern.push(c);
					}
				},
			}
		}

		let regex_piece =
			pattern_to_regex_str(current_pattern.as_str(), self.enable_extended_globbing)?;
		regex_str.push_str(regex_piece.as_str());

		if strict_suffix_match {
			regex_str.push('$');
		}

		Ok(regex_str)
	}

	pub(crate) fn to_regex(
		&self,
		strict_prefix_match: bool,
		strict_suffix_match: bool,
	) -> Result<fancy_regex::Regex, error::Error> {
		let regex_str = self.to_regex_str(strict_prefix_match, strict_suffix_match)?;

		tracing::debug!(target: trace_categories::PATTERN, "pattern: '{self:?}' => regex: '{regex_str}'");

		let re = regex::compile_regex(regex_str, self.case_insensitive, self.multiline)?;
		Ok(re)
	}

	pub fn exactly_matches(&self, value: &str) -> Result<bool, error::Error> {
		let re = self.to_regex(true, true)?;
		Ok(re.is_match(value)?)
	}
}

fn requires_expansion(s: &str, enable_extended_globbing: bool) -> bool {
	brush_parser::pattern::pattern_has_glob_metacharacters(s, enable_extended_globbing)
}

fn pattern_to_regex_str(
	pattern: &str,
	enable_extended_globbing: bool,
) -> Result<String, error::Error> {
	Ok(brush_parser::pattern::pattern_to_regex_str(pattern, enable_extended_globbing)?)
}

pub(crate) fn remove_largest_matching_prefix<'a>(
	s: &'a str,
	pattern: Option<&Pattern>,
) -> Result<&'a str, error::Error> {
	if let Some(pattern) = pattern {
		let re = pattern.to_regex(true, true)?;
		let indices = s.char_indices().rev();
		let mut last_idx = s.len();

		#[allow(clippy::string_slice, reason = "because we get the indices from char_indices()")]
		for (idx, _) in indices {
			let prefix = &s[0..last_idx];
			if re.is_match(prefix)? {
				return Ok(&s[last_idx..]);
			}

			last_idx = idx;
		}
	}
	Ok(s)
}

pub(crate) fn remove_smallest_matching_prefix<'a>(
	s: &'a str,
	pattern: Option<&Pattern>,
) -> Result<&'a str, error::Error> {
	if let Some(pattern) = pattern {
		let re = pattern.to_regex(true, true)?;
		let mut indices = s.char_indices();

		#[allow(clippy::string_slice, reason = "because we get the indices from char_indices()")]
		while indices.next().is_some() {
			let next_index = indices.offset();
			let prefix = &s[0..next_index];
			if re.is_match(prefix)? {
				return Ok(&s[next_index..]);
			}
		}
	}
	Ok(s)
}

pub(crate) fn remove_largest_matching_suffix<'a>(
	s: &'a str,
	pattern: Option<&Pattern>,
) -> Result<&'a str, error::Error> {
	if let Some(pattern) = pattern {
		let re = pattern.to_regex(true, true)?;
		#[allow(clippy::string_slice, reason = "because we get the indices from char_indices()")]
		for (idx, _) in s.char_indices() {
			let suffix = &s[idx..];
			if re.is_match(suffix)? {
				return Ok(&s[..idx]);
			}
		}
	}
	Ok(s)
}

pub(crate) fn remove_smallest_matching_suffix<'a>(
	s: &'a str,
	pattern: Option<&Pattern>,
) -> Result<&'a str, error::Error> {
	if let Some(pattern) = pattern {
		let re = pattern.to_regex(true, true)?;
		#[allow(clippy::string_slice, reason = "because we get the indices from char_indices()")]
		for (idx, _) in s.char_indices().rev() {
			let suffix = &s[idx..];
			if re.is_match(suffix)? {
				return Ok(&s[..idx]);
			}
		}
	}
	Ok(s)
}
