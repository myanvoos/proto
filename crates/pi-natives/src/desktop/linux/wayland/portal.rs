use std::{
	fs,
	path::{Path, PathBuf},
	sync::LazyLock,
	time::Duration,
};

use ashpd::desktop::remote_desktop::RemoteDesktop;
use tokio::runtime::{Builder, Runtime};

use crate::desktop::error::{CoreResult, DesktopError};

/// How long the input probe waits for the portal frontend to answer.
const INPUT_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

static PORTAL_RUNTIME: LazyLock<Result<Runtime, String>> = LazyLock::new(|| {
	Builder::new_multi_thread()
		.worker_threads(1)
		.enable_all()
		.build()
		.map_err(|err| err.to_string())
});

pub(super) fn portal_runtime() -> CoreResult<&'static Runtime> {
	PORTAL_RUNTIME
		.as_ref()
		.map_err(|err| DesktopError::internal(format!("xdg-desktop-portal runtime: {err}")))
}

const ORPHANED_REMOTE_DESKTOP_TOKEN: &str = "remote-desktop-token";

fn proto_state_dir() -> Option<PathBuf> {
	let base = std::env::var_os("XDG_STATE_HOME")
		.map(PathBuf::from)
		.or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state")))?;
	Some(base.join("proto"))
}

fn remove_token_in(dir: &Path) {
	let _ = fs::remove_file(dir.join(ORPHANED_REMOTE_DESKTOP_TOKEN));
}

pub(super) fn remove_orphaned_remote_desktop_token() {
	if let Some(dir) = proto_state_dir() {
		remove_token_in(&dir);
	}
}

#[cfg(feature = "wayland-pipewire")]
fn token_path(name: &str) -> Option<PathBuf> {
	Some(proto_state_dir()?.join(name))
}

/// Why native input can never reach this desktop, or `None` when it may.
///
/// `LIBEI_SOCKET` reaches an EIS server directly; otherwise input needs a
/// `RemoteDesktop` portal backend, which wlroots compositors such as sway
/// lack. Reads only the frontend's `version` property: no session, no prompt.
/// A frontend that fails to answer counts as reachable, so only a definite
/// absence turns input off.
pub(super) fn input_unavailable_reason() -> Option<String> {
	if std::env::var_os("LIBEI_SOCKET").is_some() {
		return None;
	}
	remote_desktop_missing(portal_runtime().ok()?)
}

fn remote_desktop_missing(runtime: &Runtime) -> Option<String> {
	// The timeout is built inside the runtime: its timer needs the reactor.
	let probe = runtime
		.block_on(async { tokio::time::timeout(INPUT_PROBE_TIMEOUT, RemoteDesktop::new()).await });
	probe.ok()?.err().as_ref().and_then(missing_remote_desktop)
}

fn missing_remote_desktop(error: &ashpd::Error) -> Option<String> {
	matches!(error, ashpd::Error::PortalNotFound(_)).then(|| {
		format!(
			"Wayland input is unavailable: no xdg-desktop-portal backend implements RemoteDesktop on \
			 this desktop ({error}), and LIBEI_SOCKET is unset; use AX actions instead"
		)
	})
}

#[cfg(feature = "wayland-pipewire")]
pub(super) fn read_token(name: &str) -> Option<String> {
	fs::read_to_string(token_path(name)?)
		.ok()
		.map(|token| token.trim().to_string())
		.filter(|token| !token.is_empty())
}

#[cfg(feature = "wayland-pipewire")]
pub(super) fn store_token(name: &str, token: Option<&str>) {
	let (Some(path), Some(token)) = (token_path(name), token) else {
		return;
	};
	let Some(parent) = path.parent() else {
		return;
	};
	if fs::create_dir_all(parent).is_ok() {
		let _ = fs::write(path, token);
	}
}
