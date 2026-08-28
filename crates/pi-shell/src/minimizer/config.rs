use std::{
	collections::{HashMap, HashSet},
	fs,
	path::{Path, PathBuf},
	sync::Arc,
};

use serde::Deserialize;

use crate::minimizer::pipeline::{self, PipelineRegistry, SUPPORTED_SCHEMA_VERSION};

const DEFAULT_MAX_CAPTURE_BYTES: u32 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum OutlineLevel {
	#[default]
	Default,

	Aggressive,
}

impl OutlineLevel {
	fn parse(raw: &str) -> Option<Self> {
		match raw.trim().to_ascii_lowercase().as_str() {
			"default" | "" => Some(Self::Default),
			"aggressive" => Some(Self::Aggressive),
			_ => None,
		}
	}
}

#[derive(Debug, Clone, Default)]
pub struct MinimizerOptions {
	pub enabled: Option<bool>,

	pub settings_path: Option<String>,

	pub settings_hash: Option<String>,

	pub only: Option<Vec<String>>,

	pub except: Option<Vec<String>>,

	pub max_capture_bytes: Option<u32>,

	pub source_outline_level: Option<String>,

	pub legacy_filters: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct MinimizerConfig {
	pub enabled:           bool,
	pub only:              HashSet<String>,
	pub except:            HashSet<String>,
	pub max_capture_bytes: u32,
	pub per_command:       HashMap<String, toml::Value>,

	pub user_pipelines: Option<Arc<PipelineRegistry>>,

	pub source_outline_level: OutlineLevel,

	pub legacy_filters_active: bool,
}

impl Default for MinimizerConfig {
	fn default() -> Self {
		Self {
			enabled:               false,
			only:                  HashSet::new(),
			except:                HashSet::new(),
			max_capture_bytes:     DEFAULT_MAX_CAPTURE_BYTES,
			per_command:           HashMap::new(),
			user_pipelines:        None,
			source_outline_level:  OutlineLevel::Default,
			legacy_filters_active: false,
		}
	}
}

impl MinimizerConfig {
	#[must_use]
	pub fn from_options(opts: &MinimizerOptions) -> Self {
		let mut cfg = Self::default();
		if let Some(enabled) = opts.enabled {
			cfg.enabled = enabled;
		}
		if let Some(list) = opts.only.as_ref() {
			cfg.only = list.iter().map(|s| s.to_lowercase()).collect();
		}
		if let Some(list) = opts.except.as_ref() {
			cfg.except = list.iter().map(|s| s.to_lowercase()).collect();
		}
		if let Some(n) = opts.max_capture_bytes {
			cfg.max_capture_bytes = n.max(1024);
		}
		if let Some(raw) = opts.source_outline_level.as_deref()
			&& let Some(level) = OutlineLevel::parse(raw)
		{
			cfg.source_outline_level = level;
		}
		let legacy_requested = resolve_legacy_filters(
			opts.legacy_filters,
			std::env::var("PROTO_MINIMIZER_LEGACY_FILTERS")
				.ok()
				.as_deref(),
		);
		cfg.legacy_filters_active = legacy_requested;
		if let Some(path) = opts.settings_path.as_deref()
			&& !path.is_empty()
		{
			let expanded = expand_tilde(path);
			if let Ok(contents) = fs::read_to_string(&expanded) {
				if let Some(expected) = opts.settings_hash.as_deref()
					&& !expected.is_empty()
				{
					let actual = xxhash_rust::xxh64::xxh64(contents.as_bytes(), 0);
					let actual_hex = format!("{actual:016x}");
					if !actual_hex.eq_ignore_ascii_case(expected) {
						eprintln!(
							"[pi-natives minimizer] settings_hash mismatch for {} (expected {}, got {}); \
							 ignoring file",
							expanded.display(),
							expected,
							actual_hex
						);
						return cfg;
					}
				}
				if let Ok(file) = toml::from_str::<SettingsFile>(&contents) {
					file.merge_into(&mut cfg);
					if opts.enabled == Some(false) {
						cfg.enabled = false;
					}
					if legacy_requested {
						cfg.legacy_filters_active = true;
					}
					if opts.legacy_filters == Some(false) {
						cfg.legacy_filters_active = false;
					}
				}
				match pipeline::parse_file(&contents, "user") {
					Ok((pipelines, tests)) => {
						if !pipelines.is_empty() {
							cfg.user_pipelines = Some(Arc::new(PipelineRegistry { pipelines, tests }));
						}
					},
					Err(err) => {
						eprintln!("[pi-natives minimizer] user filters: {err}");
					},
				}
			}
		}
		cfg
	}

	#[must_use]
	pub fn is_program_enabled(&self, program: &str) -> bool {
		if !self.enabled {
			return false;
		}
		let key = program.to_lowercase();
		if self.except.contains(&key) {
			return false;
		}
		if !self.only.is_empty() && !self.only.contains(&key) {
			return false;
		}
		true
	}

	#[must_use]
	pub fn per_command(&self, program: &str) -> Option<&toml::Value> {
		self.per_command.get(&program.to_lowercase())
	}

	#[must_use]
	pub const fn legacy_filters_active(&self) -> bool {
		self.legacy_filters_active
	}
}

#[derive(Debug, Default, Deserialize)]
struct SettingsFile {
	#[serde(default)]
	schema_version:       Option<u32>,
	enabled:              Option<bool>,
	only:                 Option<Vec<String>>,
	except:               Option<Vec<String>>,
	max_capture_bytes:    Option<u32>,
	source_outline_level: Option<String>,
	legacy_filters:       Option<bool>,
	#[serde(flatten)]
	tables:               HashMap<String, toml::Value>,
}

impl SettingsFile {
	fn merge_into(self, cfg: &mut MinimizerConfig) {
		if let Some(v) = self.schema_version
			&& v != SUPPORTED_SCHEMA_VERSION
		{
			eprintln!(
				"[pi-natives minimizer] unsupported schema_version {v} in settings file (expected \
				 {SUPPORTED_SCHEMA_VERSION})"
			);
			return;
		}
		if let Some(v) = self.enabled {
			cfg.enabled = v;
		}
		if let Some(list) = self.only {
			cfg.only = list.into_iter().map(|s| s.to_lowercase()).collect();
		}
		if let Some(list) = self.except {
			cfg.except = list.into_iter().map(|s| s.to_lowercase()).collect();
		}
		if let Some(n) = self.max_capture_bytes {
			cfg.max_capture_bytes = n.max(1024);
		}
		if let Some(raw) = self.source_outline_level.as_deref()
			&& let Some(level) = OutlineLevel::parse(raw)
		{
			cfg.source_outline_level = level;
		}
		if let Some(v) = self.legacy_filters {
			cfg.legacy_filters_active = resolve_legacy_filters(Some(v), None);
		}
		for (k, v) in self.tables {
			if v.is_table() && k != "filters" && k != "tests" {
				cfg.per_command.insert(k.to_lowercase(), v);
			}
		}
	}
}

fn resolve_legacy_filters(option: Option<bool>, env_value: Option<&str>) -> bool {
	match option {
		Some(v) => v,
		None => env_value.is_some_and(|raw| {
			matches!(raw.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes")
		}),
	}
}

fn expand_tilde(path: &str) -> PathBuf {
	if let Some(rest) = path.strip_prefix("~/")
		&& let Some(home) = home_dir()
	{
		return home.join(rest);
	}
	if path == "~"
		&& let Some(home) = home_dir()
	{
		return home;
	}
	Path::new(path).to_path_buf()
}

fn home_dir() -> Option<PathBuf> {
	std::env::var_os("HOME").map(PathBuf::from)
}
