//! Filesystem helpers exported to JavaScript.

use napi::{JsString, bindgen_prelude::*};
use napi_derive::napi;

use crate::held_files;

/// Whether `path` is a SQLite database or `-shm` index this process holds open.
/// Reading its bytes in-process and closing the handle would release the
/// process's SQLite locks.
#[napi(catch_unwind)]
pub fn is_held_sqlite_store(path: String) -> bool {
	held_files::is_held_sqlite_store(path)
}

/// Drop cached directory listings.
///
/// The engine-era walker validates each cached listing against the directory's
/// device/inode and timestamp, so a changed directory is listed again without
/// explicit invalidation. The binding stays for callers that request it; the
/// optional path is accepted and ignored.
#[napi(catch_unwind)]
#[allow(clippy::missing_const_for_fn, reason = "a const fn cannot drop the JsString argument")]
pub fn invalidate_fs_scan_cache(path: Option<JsString>) -> Result<()> {
	let _ = path;
	Ok(())
}
