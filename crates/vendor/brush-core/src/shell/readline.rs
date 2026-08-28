

use crate::{error, extensions, variables::ShellVariable};

impl<SE: extensions::ShellExtensions> crate::Shell<SE> {






	pub fn set_edit_buffer(&mut self, contents: String, cursor: usize) -> Result<(), error::Error> {
		self
			.env
			.set_global("READLINE_LINE", ShellVariable::new(contents))?;

		self
			.env
			.set_global("READLINE_POINT", ShellVariable::new(cursor.to_string()))?;

		Ok(())
	}



	pub fn pop_edit_buffer(&mut self) -> Result<Option<(String, usize)>, error::Error> {
		let line = self
			.env
			.unset("READLINE_LINE")?
			.map(|line| line.value().to_cow_str(self).to_string());

		let point = self
			.env
			.unset("READLINE_POINT")?
			.and_then(|point| point.value().to_cow_str(self).parse::<usize>().ok())
			.unwrap_or(0);

		if let Some(line) = line {
			Ok(Some((line, point)))
		} else {
			Ok(None)
		}
	}
}
