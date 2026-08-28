//! Environment variable retrieval for Unix platforms.

/// Retrieves environment variables from the host process.
///
/// This is a best-effort passthrough to [`std::env::vars()`], skipping entries
/// whose key or value is not valid Unicode: a corrupt entry carries no usable
/// meaning, and a naive [`std::env::vars()`] call panics on the first one
/// before any command can run.
pub(crate) fn get_host_env_vars() -> impl Iterator<Item = (String, String)> {
	std::env::vars_os().filter_map(|(key, value)| {
		let key = key.into_string().ok()?;
		let value = value.into_string().ok()?;
		Some((key, value))
	})
}


