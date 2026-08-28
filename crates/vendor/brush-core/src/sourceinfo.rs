

use std::{path::PathBuf, sync::Arc};


#[derive(Clone, Debug, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct SourceInfo {

	pub source: String,


	pub start:  Option<Arc<crate::SourcePosition>>,
}

impl From<&str> for SourceInfo {
	fn from(source: &str) -> Self {
		Self { source: source.to_owned(), start: None }
	}
}

impl From<PathBuf> for SourceInfo {
	fn from(path: PathBuf) -> Self {
		Self { source: path.to_string_lossy().to_string(), start: None }
	}
}

impl std::fmt::Display for SourceInfo {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		write!(f, "{}", self.source)?;

		if let Some(pos) = &self.start {
			write!(f, ":{},{}", pos.line, pos.column)?;
		}

		Ok(())
	}
}
