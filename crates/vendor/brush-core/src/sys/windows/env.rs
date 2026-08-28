





use std::collections::BTreeMap;












pub(crate) fn get_host_env_vars() -> impl Iterator<Item = (String, String)> {
	collect_host_env_vars(std::env::vars())
}




fn collect_host_env_vars<I>(source: I) -> std::collections::btree_map::IntoIter<String, String>
where
	I: IntoIterator<Item = (String, String)>,
{
	let mut vars = BTreeMap::new();


	for (k, v) in source {
		let normalized = normalize_env_name(&k);
		if let Some(existing) = vars.get(&normalized)
			&& existing != &v
		{
			tracing::warn!(
				"environment variable collision under canonical name {normalized}: two different \
				 values were supplied (last-write wins)"
			);
		}
		vars.insert(normalized, v);
	}


	if !vars.contains_key("HOME") {
		let home = vars.get("USERPROFILE").cloned().or_else(|| {
			let d = vars.get("HOMEDRIVE")?;
			let p = vars.get("HOMEPATH")?;
			Some(format!("{d}{p}"))
		});
		if let Some(home) = home {
			vars.insert("HOME".to_string(), home);
		}
	}


	if !vars.contains_key("TMPDIR")
		&& let Some(tmp) = vars.get("TEMP").or_else(|| vars.get("TMP")).cloned()
	{
		vars.insert("TMPDIR".to_string(), tmp);
	}

	vars.into_iter()
}







fn normalize_env_name(name: &str) -> String {



	const WELL_KNOWN: &[&str] =
		&["PATH", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP", "TMPDIR"];

	for &canonical in WELL_KNOWN {
		if name.eq_ignore_ascii_case(canonical) {
			return canonical.to_string();
		}
	}

	name.to_string()
}


