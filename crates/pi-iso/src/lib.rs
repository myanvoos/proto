#![cfg_attr(
	not(any(target_os = "macos", target_os = "linux")),
	allow(unused_imports, dead_code, reason = "platform without an isolation backend")
)]

use std::{fmt, path::Path};

use async_trait::async_trait;

mod apfs;
mod btrfs;
mod diff;
mod linux_reflink;
mod overlayfs;
mod rcopy;
mod zfs;

pub use diff::{ChangeKind, Diff, FileChange};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BackendKind {
	Apfs,

	Btrfs,

	Zfs,

	LinuxReflink,

	Overlayfs,

	Rcopy,
}

impl BackendKind {
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Apfs => "apfs",
			Self::Btrfs => "btrfs",
			Self::Zfs => "zfs",
			Self::LinuxReflink => "linux-reflink",
			Self::Overlayfs => "overlayfs",
			Self::Rcopy => "rcopy",
		}
	}

	#[allow(
		clippy::should_implement_trait,
		reason = "Option<Self> return is more ergonomic than FromStr's Result"
	)]
	pub fn from_str(s: &str) -> Option<Self> {
		Some(match s {
			"apfs" => Self::Apfs,
			"btrfs" => Self::Btrfs,
			"zfs" => Self::Zfs,
			"linux-reflink" | "reflink" => Self::LinuxReflink,
			"overlayfs" => Self::Overlayfs,
			"rcopy" => Self::Rcopy,
			_ => return None,
		})
	}

	pub const fn native() -> Self {
		#[cfg(target_os = "macos")]
		{
			Self::Apfs
		}
		#[cfg(target_os = "linux")]
		{
			Self::Overlayfs
		}
		#[cfg(not(any(target_os = "macos", target_os = "linux")))]
		{
			Self::Rcopy
		}
	}
}

#[cfg(target_os = "macos")]
const MACOS_AUTO_ORDER: &[BackendKind] = &[BackendKind::Apfs, BackendKind::Zfs, BackendKind::Rcopy];
#[cfg(target_os = "linux")]
const LINUX_AUTO_ORDER: &[BackendKind] = &[
	BackendKind::Btrfs,
	BackendKind::Zfs,
	BackendKind::LinuxReflink,
	BackendKind::Overlayfs,
	BackendKind::Rcopy,
];
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
const FALLBACK_AUTO_ORDER: &[BackendKind] = &[BackendKind::Rcopy];

impl fmt::Display for BackendKind {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(self.as_str())
	}
}

#[derive(Debug, Clone)]
pub struct ProbeResult {
	pub available: bool,
	pub reason:    Option<String>,
}

impl ProbeResult {
	pub const fn available() -> Self {
		Self { available: true, reason: None }
	}

	pub fn unavailable(reason: impl Into<String>) -> Self {
		Self { available: false, reason: Some(reason.into()) }
	}
}

#[derive(Debug, Clone)]
pub enum IsoError {
	Unavailable(String),
	Other(String),
}

impl IsoError {
	pub fn unavailable(msg: impl Into<String>) -> Self {
		Self::Unavailable(msg.into())
	}

	pub fn other(msg: impl Into<String>) -> Self {
		Self::Other(msg.into())
	}

	pub const fn is_unavailable(&self) -> bool {
		matches!(self, Self::Unavailable(_))
	}

	pub fn message(&self) -> &str {
		match self {
			Self::Unavailable(m) | Self::Other(m) => m,
		}
	}
}

impl fmt::Display for IsoError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(self.message())
	}
}

impl std::error::Error for IsoError {}

pub type IsoResult<T> = Result<T, IsoError>;

pub(crate) fn command_failed(
	what: impl fmt::Display,
	code: impl fmt::Display,
	stderr: &[u8],
) -> IsoError {
	let stderr = String::from_utf8_lossy(stderr);
	IsoError::other(format!("{what} (exit {code}): {}", stderr.trim()))
}

#[async_trait]
pub trait IsolationBackend: Send + Sync {
	fn kind(&self) -> BackendKind;

	fn probe(&self) -> ProbeResult;

	fn start(&self, lower: &Path, merged: &Path) -> IsoResult<()>;

	fn stop(&self, merged: &Path) -> IsoResult<()>;

	async fn diff(&self, lower: &Path, merged: &Path) -> IsoResult<Diff> {
		diff::default_diff(lower, merged).await
	}
}

pub fn default_backend() -> &'static dyn IsolationBackend {
	backend(BackendKind::native())
}

pub fn backend(kind: BackendKind) -> &'static dyn IsolationBackend {
	match kind {
		BackendKind::Apfs => apfs::backend(),
		BackendKind::Btrfs => btrfs::backend(),
		BackendKind::Zfs => zfs::backend(),
		BackendKind::LinuxReflink => linux_reflink::backend(),
		BackendKind::Overlayfs => overlayfs::backend(),
		BackendKind::Rcopy => &rcopy::RcopyBackend,
	}
}

pub const fn auto_order() -> &'static [BackendKind] {
	#[cfg(target_os = "macos")]
	{
		MACOS_AUTO_ORDER
	}
	#[cfg(target_os = "linux")]
	{
		LINUX_AUTO_ORDER
	}
	#[cfg(not(any(target_os = "macos", target_os = "linux")))]
	{
		FALLBACK_AUTO_ORDER
	}
}

#[derive(Debug, Clone)]
pub struct Resolution {
	pub kind:       BackendKind,
	pub candidates: Vec<BackendKind>,
	pub fell_back:  bool,
	pub reason:     Option<String>,
}

pub fn resolve(preferred: Option<BackendKind>) -> Resolution {
	let mut reason = None;
	let mut candidates = Vec::with_capacity(auto_order().len() + usize::from(preferred.is_some()));

	if let Some(p) = preferred {
		let probe = backend(p).probe();
		if probe.available {
			candidates.push(p);
		} else {
			reason = probe.reason;
		}
	}

	for candidate in auto_order() {
		if Some(*candidate) == preferred {
			continue;
		}
		let probe = backend(*candidate).probe();
		if probe.available {
			candidates.push(*candidate);
		} else if reason.is_none() {
			reason = probe.reason;
		}
	}

	if candidates.is_empty() {
		candidates.push(BackendKind::Rcopy);
	}
	let kind = candidates[0];
	let fell_back = match preferred {
		Some(p) => kind != p,
		None => kind != auto_order()[0],
	};

	Resolution { kind, candidates, fell_back, reason }
}
