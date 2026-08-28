

use std::borrow::Cow;

use crate::{error, expansion, extensions, interp::ExecutionParameters};

impl<SE: extensions::ShellExtensions> crate::Shell<SE> {


	pub fn ifs(&self) -> Cow<'_, str> {
		self.env_str("IFS").unwrap_or_else(|| " \t\n".into())
	}



	pub(crate) fn get_ifs_first_char(&self) -> char {
		self.ifs().chars().next().unwrap_or(' ')
	}






	pub async fn basic_expand_string<S: AsRef<str>>(
		&mut self,
		params: &ExecutionParameters,
		s: S,
	) -> Result<String, error::Error> {
		let result = expansion::basic_expand_word(self, params, s.as_ref()).await?;
		Ok(result)
	}







	pub async fn full_expand_and_split_string<S: AsRef<str>>(
		&mut self,
		params: &ExecutionParameters,
		s: S,
	) -> Result<Vec<String>, error::Error> {
		let result = expansion::full_expand_and_split_word(self, params, s.as_ref()).await?;
		Ok(result)
	}
}
