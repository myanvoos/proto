use napi::{JsString, bindgen_prelude::*};
use napi_derive::napi;

use crate::js;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi]
pub enum FileType {
	File    = 1,

	Dir     = 2,

	Symlink = 3,
}

#[derive(Clone)]
#[napi(object)]
pub struct GlobMatch {
	pub path: String,

	pub file_type: FileType,

	pub mtime: Option<f64>,

	pub size: Option<f64>,
}

fn walker_error_to_napi<E: std::fmt::Display>(err: pi_walker::WalkError<E>) -> Error {
	match err {
		pi_walker::WalkError::Interrupted(err) => Error::from_reason(err.to_string()),
		pi_walker::WalkError::InvalidData { path, message } => Error::from_reason(format!(
			"Native directory scan failed for {}: {message}",
			path.display()
		)),
	}
}

pub(crate) const fn from_walker_file_type(file_type: pi_walker::FileType) -> FileType {
	match file_type {
		pi_walker::FileType::File => FileType::File,
		pi_walker::FileType::Dir => FileType::Dir,
		pi_walker::FileType::Symlink => FileType::Symlink,
	}
}

impl From<pi_walker::CollectedEntry> for GlobMatch {
	fn from(entry: pi_walker::CollectedEntry) -> Self {
		Self {
			path:      entry.path,
			file_type: from_walker_file_type(entry.file_type),
			mtime:     entry.mtime,
			size:      entry.size,
		}
	}
}

pub(crate) fn map_walker_error<E: std::fmt::Display>(err: pi_walker::WalkError<E>) -> Error {
	walker_error_to_napi(err)
}

#[napi]
pub fn invalidate_fs_scan_cache(path: Option<JsString>) -> Result<()> {
	match path {
		Some(path) => pi_walker::invalidate_path_string(&js::utf8(path)?),
		None => pi_walker::invalidate_all(),
	}
	Ok(())
}
