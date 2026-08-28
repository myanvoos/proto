







pub(crate) fn get_host_env_vars() -> impl Iterator<Item = (String, String)> {
	std::env::vars_os().filter_map(|(key, value)| {
		let key = key.into_string().ok()?;
		let value = value.into_string().ok()?;
		Some((key, value))
	})
}


