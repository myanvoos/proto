use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use napi::bindgen_prelude::*;

pub struct CompiledGlob {
	fast_path: GlobFastPath,
	glob_set:  GlobSet,
}

enum GlobFastPath {
	All,

	RootOnly,

	Extension(Vec<String>),

	RootExtension(Vec<String>),

	Basename(String),

	RootBasename(String),

	GlobSet,
}

impl CompiledGlob {
	pub fn is_match(&self, path: &str) -> bool {
		match &self.fast_path {
			GlobFastPath::All => true,
			GlobFastPath::RootOnly => !path.contains('/'),
			GlobFastPath::Extension(exts) => {
				path_extension(path).is_some_and(|ext| exts.iter().any(|candidate| ext == candidate))
			},
			GlobFastPath::RootExtension(exts) => {
				!path.contains('/')
					&& path_extension(path)
						.is_some_and(|ext| exts.iter().any(|candidate| ext == candidate))
			},
			GlobFastPath::Basename(name) => path.rsplit('/').next() == Some(name.as_str()),
			GlobFastPath::RootBasename(name) => path == name.as_str(),
			GlobFastPath::GlobSet => self.glob_set.is_match(path),
		}
	}
}

pub fn build_glob_pattern(glob: &str, recursive: bool) -> String {
	let normalized = glob.replace('\\', "/");
	let pattern = if !recursive
		|| normalized.contains('/')
		|| normalized.starts_with("**")
		|| is_exact_brace_union(&normalized)
	{
		normalized
	} else {
		format!("**/{normalized}")
	};
	fix_unclosed_braces(pattern)
}

pub fn walk_depth_bound(pattern: &str) -> usize {
	if pattern.contains("**") || pattern.contains('{') {
		return usize::MAX;
	}
	pattern
		.split('/')
		.filter(|seg| !seg.is_empty())
		.count()
		.max(1)
}

pub fn compile_glob(glob: &str, recursive: bool) -> Result<CompiledGlob> {
	let mut builder = GlobSetBuilder::new();
	let pattern = build_glob_pattern(glob, recursive);
	let parsed = GlobBuilder::new(&pattern)
		.literal_separator(true)
		.build()
		.map_err(|err| Error::from_reason(format!("Invalid glob pattern: {err}")))?;
	builder.add(parsed);
	let glob_set = builder
		.build()
		.map_err(|err| Error::from_reason(format!("Failed to build glob matcher: {err}")))?;
	Ok(CompiledGlob { fast_path: classify_fast_path(&pattern), glob_set })
}

pub fn try_compile_glob(glob: Option<&str>, recursive: bool) -> Result<Option<CompiledGlob>> {
	let Some(glob) = glob.map(str::trim).filter(|v| !v.is_empty()) else {
		return Ok(None);
	};
	compile_glob(glob, recursive).map(Some)
}

fn classify_fast_path(pattern: &str) -> GlobFastPath {
	if matches!(pattern, "**" | "**/*") {
		return GlobFastPath::All;
	}
	if pattern == "*" {
		return GlobFastPath::RootOnly;
	}
	if let Some(ext) = pattern.strip_prefix("**/*.") {
		if is_literal_component(ext) {
			return GlobFastPath::Extension(vec![ext.to_string()]);
		}
	} else if let Some(ext) = pattern.strip_prefix("*.")
		&& is_literal_component(ext)
	{
		return GlobFastPath::RootExtension(vec![ext.to_string()]);
	}
	if let Some(inner) = pattern
		.strip_prefix("**/*.{")
		.and_then(|value| value.strip_suffix('}'))
	{
		if let Some(extensions) = literal_csv(inner) {
			return GlobFastPath::Extension(extensions);
		}
	} else if let Some(inner) = pattern
		.strip_prefix("*.{")
		.and_then(|value| value.strip_suffix('}'))
		&& let Some(extensions) = literal_csv(inner)
	{
		return GlobFastPath::RootExtension(extensions);
	}
	if let Some(name) = pattern.strip_prefix("**/") {
		if is_literal_path(name) {
			return GlobFastPath::Basename(name.to_string());
		}
	} else if is_literal_path(pattern) {
		return GlobFastPath::RootBasename(pattern.to_string());
	}
	GlobFastPath::GlobSet
}

fn literal_csv(inner: &str) -> Option<Vec<String>> {
	let extensions: Vec<String> = inner
		.split(',')
		.filter(|value| !value.is_empty() && is_literal_component(value))
		.map(ToOwned::to_owned)
		.collect();
	if extensions.is_empty() || extensions.len() != inner.split(',').count() {
		None
	} else {
		Some(extensions)
	}
}

fn path_extension(path: &str) -> Option<&str> {
	let base = path.rsplit('/').next().unwrap_or(path);
	let (_, ext) = base.rsplit_once('.')?;
	if ext.is_empty() { None } else { Some(ext) }
}

fn is_literal_component(value: &str) -> bool {
	!value.is_empty()
		&& !value
			.chars()
			.any(|ch| matches!(ch, '*' | '?' | '[' | ']' | '{' | '}' | '/' | '\\'))
}

fn is_literal_path(value: &str) -> bool {
	!value.is_empty()
		&& !value
			.chars()
			.any(|ch| matches!(ch, '*' | '?' | '[' | ']' | '{' | '}' | '\\' | '/'))
}

fn fix_unclosed_braces(pattern: String) -> String {
	let opens = pattern.chars().filter(|&c| c == '{').count();
	let closes = pattern.chars().filter(|&c| c == '}').count();
	if opens > closes {
		let mut fixed = pattern;
		for _ in 0..(opens - closes) {
			fixed.push('}');
		}
		fixed
	} else {
		pattern
	}
}

fn is_exact_brace_union(pattern: &str) -> bool {
	if !(pattern.starts_with('{') && pattern.ends_with('}')) {
		return false;
	}
	let inner = &pattern[1..pattern.len() - 1];
	!inner.is_empty()
		&& !inner
			.chars()
			.any(|ch| matches!(ch, '*' | '?' | '[' | ']' | '{' | '}'))
}
