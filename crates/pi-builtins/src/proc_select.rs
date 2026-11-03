//! Comma-separated process selector lists shared by `ps`, `pgrep`, `pkill`,
//! and `pidwait` (`-p`/`-P`/`-g`/`-s`/`-u`/`-U`/`-G`/`-t`).
//!
//! Errors are `(exit status, message)` pairs, matching both callers' parsers.

use std::path::Path;

pub(crate) fn parse_i32_list(value: &str, target: &mut Vec<i32>) -> Result<(), (u8, String)> {
	for item in value.split(',') {
		let parsed = item
			.parse::<i32>()
			.map_err(|_| (2, format!("invalid numeric selector '{item}'")))?;
		target.push(parsed);
	}
	Ok(())
}

pub(crate) fn parse_user_list(value: &str, target: &mut Vec<u32>) -> Result<(), (u8, String)> {
	for item in value.split(',') {
		// Numeric ids win even when they don't name an account, unlike
		// uucore's name-first lookup, so check them before the passwd database.
		let uid = item.parse().ok();
		#[cfg(unix)]
		let uid = uid.or_else(|| uucore::entries::usr2uid(item).ok());
		target.push(uid.ok_or_else(|| (2, format!("unknown user '{item}'")))?);
	}
	Ok(())
}

pub(crate) fn parse_group_list(value: &str, target: &mut Vec<u32>) -> Result<(), (u8, String)> {
	for item in value.split(',') {
		// Numeric-first for the same reason as `parse_user_list`.
		let gid = item.parse().ok();
		#[cfg(unix)]
		let gid = gid.or_else(|| uucore::entries::grp2gid(item).ok());
		target.push(gid.ok_or_else(|| (2, format!("unknown group '{item}'")))?);
	}
	Ok(())
}

/// `?` and `-` select processes without a controlling terminal (`None`).
pub(crate) fn parse_terminal_list(
	value: &str,
	target: &mut Vec<Option<u64>>,
	paths: &Path,
) -> Result<(), (u8, String)> {
	for item in value.split(',') {
		if matches!(item, "?" | "-") {
			target.push(None);
		} else if let Some(id) = resolve_terminal(item, paths) {
			target.push(Some(id));
		} else if let Ok(id) = item.parse() {
			target.push(Some(id));
		} else {
			return Err((2, format!("unknown terminal '{item}'")));
		}
	}
	Ok(())
}

/// Device number of terminal `value`: an absolute or virtual path, a name
/// under `/dev`, or a `/dev/tty` suffix (`pts/0`, `S0`).
#[cfg(unix)]
fn resolve_terminal(value: &str, paths: &Path) -> Option<u64> {
	use std::{
		os::unix::fs::MetadataExt,
		path::{Path, PathBuf},
	};
	let primary = if value.starts_with('/') {
		PathBuf::from(value)
	} else {
		Path::new("/dev").join(value)
	};
	let _ = paths;
	std::fs::metadata(primary)
		.or_else(|_| std::fs::metadata(Path::new("/dev").join(format!("tty{value}"))))
		.ok()
		.map(|metadata| metadata.rdev())
}

#[cfg(not(unix))]
fn resolve_terminal(_value: &str, _paths: &Path) -> Option<u64> {
	None
}
