

use std::path::PathBuf;

use crate::{error, variables};


#[derive(Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct PathCache {

	cache: std::collections::HashMap<String, PathBuf>,
}

impl PathCache {

	pub fn reset(&mut self) {
		self.cache.clear();
	}






	pub fn get<S: AsRef<str>>(&self, name: S) -> Option<PathBuf> {
		self.cache.get(name.as_ref()).cloned()
	}







	pub fn set<T: Into<String>>(&mut self, name: T, path: PathBuf) {
		self.cache.insert(name.into(), path);
	}


	pub fn to_value(&self) -> Result<variables::ShellValue, error::Error> {
		let pairs = self
			.cache
			.iter()
			.map(|(k, v)| (Some(k.to_owned()), v.to_string_lossy().to_string()))
			.collect::<Vec<_>>();

		variables::ShellValue::associative_array_from_literals(variables::ArrayLiteral(pairs))
	}







	pub fn unset<S: AsRef<str>>(&mut self, name: S) -> bool {
		self.cache.remove(name.as_ref()).is_some()
	}
}
