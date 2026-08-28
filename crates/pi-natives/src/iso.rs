use napi::bindgen_prelude::*;
use napi_derive::napi;
use pi_iso::{BackendKind, ChangeKind, Diff, FileChange, IsoError, IsolationBackend};

use crate::js;

const ISO_UNAVAILABLE_PREFIX: &str = "ISO_UNAVAILABLE:";
const ISO_UNAVAILABLE_WITH_LEADING_SPACE: &str = " ISO_UNAVAILABLE:";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi]
pub enum IsoBackendKind {
	Apfs         = 0,
	Btrfs        = 1,
	Zfs          = 2,
	LinuxReflink = 3,
	Overlayfs    = 4,
	Rcopy        = 7,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi]
pub enum IsoChangeKind {
	Added    = 0,
	Modified = 1,
	Removed  = 2,
}

#[napi(object)]
pub struct IsoProbeResult {
	pub available: bool,

	pub reason: Option<String>,

	pub kind: IsoBackendKind,
}

#[napi(object)]
pub struct IsoResolveResult {
	pub kind: IsoBackendKind,

	pub candidates: Vec<IsoBackendKind>,

	pub fell_back: bool,

	pub reason: Option<String>,
}

#[napi(object)]
pub struct IsoFileChange {
	pub path: String,
	pub op:   IsoChangeKind,

	pub diff: Option<String>,
}

#[napi(object)]
pub struct IsoDiff {
	pub files: Vec<IsoFileChange>,
}

#[napi]
pub const fn iso_backend() -> IsoBackendKind {
	to_napi_kind(BackendKind::native())
}

#[napi]
pub fn iso_probe(kind: Option<IsoBackendKind>) -> IsoProbeResult {
	let resolved = kind.map_or_else(BackendKind::native, from_napi_kind);
	let backend = pi_iso::backend(resolved);
	let probe = backend.probe();
	IsoProbeResult {
		available: probe.available,
		reason:    probe.reason,
		kind:      to_napi_kind(resolved),
	}
}

#[napi]
pub fn iso_resolve(preferred: Option<IsoBackendKind>) -> IsoResolveResult {
	let resolution = pi_iso::resolve(preferred.map(from_napi_kind));
	IsoResolveResult {
		kind:       to_napi_kind(resolution.kind),
		candidates: resolution
			.candidates
			.into_iter()
			.map(to_napi_kind)
			.collect(),
		fell_back:  resolution.fell_back,
		reason:     resolution.reason,
	}
}

#[napi]
pub async fn iso_start(kind: Option<IsoBackendKind>, lower: String, merged: String) -> Result<()> {
	let resolved = kind.map_or_else(BackendKind::native, from_napi_kind);
	let lower_path = std::path::PathBuf::from(lower);
	let merged_path = std::path::PathBuf::from(merged);
	tokio::task::spawn_blocking(move || pi_iso::backend(resolved).start(&lower_path, &merged_path))
		.await
		.map_err(|err| Error::from_reason(format!("iso_start join: {err}")))?
		.map_err(to_napi_error)
}

#[napi]
pub async fn iso_stop(kind: Option<IsoBackendKind>, merged: String) -> Result<()> {
	let resolved = kind.map_or_else(BackendKind::native, from_napi_kind);
	let merged_path = std::path::PathBuf::from(merged);
	tokio::task::spawn_blocking(move || pi_iso::backend(resolved).stop(&merged_path))
		.await
		.map_err(|err| Error::from_reason(format!("iso_stop join: {err}")))?
		.map_err(to_napi_error)
}

#[napi]
pub async fn iso_diff(lower: String, merged: String) -> Result<IsoDiff> {
	let lower_path = std::path::PathBuf::from(lower);
	let merged_path = std::path::PathBuf::from(merged);

	let backend = pi_iso::backend(BackendKind::Rcopy);
	let diff = backend
		.diff(&lower_path, &merged_path)
		.await
		.map_err(to_napi_error)?;
	Ok(into_iso_diff(diff))
}

#[napi]
pub fn iso_is_unavailable_error(message: napi::JsString) -> Result<bool> {
	let message = js::utf8(message)?;
	Ok(message.starts_with(ISO_UNAVAILABLE_PREFIX)
		|| message.contains(ISO_UNAVAILABLE_WITH_LEADING_SPACE))
}

const fn to_napi_kind(kind: BackendKind) -> IsoBackendKind {
	match kind {
		BackendKind::Apfs => IsoBackendKind::Apfs,
		BackendKind::Btrfs => IsoBackendKind::Btrfs,
		BackendKind::Zfs => IsoBackendKind::Zfs,
		BackendKind::LinuxReflink => IsoBackendKind::LinuxReflink,
		BackendKind::Overlayfs => IsoBackendKind::Overlayfs,
		BackendKind::Rcopy => IsoBackendKind::Rcopy,
	}
}

const fn from_napi_kind(kind: IsoBackendKind) -> BackendKind {
	match kind {
		IsoBackendKind::Apfs => BackendKind::Apfs,
		IsoBackendKind::Btrfs => BackendKind::Btrfs,
		IsoBackendKind::Zfs => BackendKind::Zfs,
		IsoBackendKind::LinuxReflink => BackendKind::LinuxReflink,
		IsoBackendKind::Overlayfs => BackendKind::Overlayfs,
		IsoBackendKind::Rcopy => BackendKind::Rcopy,
	}
}

const fn to_napi_change_kind(kind: ChangeKind) -> IsoChangeKind {
	match kind {
		ChangeKind::Added => IsoChangeKind::Added,
		ChangeKind::Modified => IsoChangeKind::Modified,
		ChangeKind::Removed => IsoChangeKind::Removed,
	}
}

fn to_napi_error(err: IsoError) -> Error {
	match err {
		IsoError::Unavailable(msg) => Error::from_reason(format!("{ISO_UNAVAILABLE_PREFIX} {msg}")),
		IsoError::Other(msg) => Error::from_reason(msg),
	}
}

fn into_iso_diff(diff: Diff) -> IsoDiff {
	IsoDiff {
		files: diff
			.files
			.into_iter()
			.map(|f| IsoFileChange {
				path: f.path.to_string_lossy().into_owned(),
				op:   to_napi_change_kind(f.op),
				diff: f.diff,
			})
			.collect(),
	}
}

#[allow(dead_code, reason = "compile-time check that the trait stays dyn-compatible")]
fn _assert_backend_object_safe() {
	fn assert_object_safe(_: &dyn IsolationBackend) {}
	let backend = pi_iso::default_backend();
	assert_object_safe(backend);
	let _: FileChange;
}
