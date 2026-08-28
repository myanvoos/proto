

use std::borrow::Cow;

use crate::{ShellVariable, error};

impl<SE: crate::extensions::ShellExtensions> crate::Shell<SE> {






	pub fn env_str(&self, name: &str) -> Option<Cow<'_, str>> {
		self.env.get_str(name, self)
	}






	pub fn env_var(&self, name: &str) -> Option<&ShellVariable> {
		self.env.get(name).map(|(_, var)| var)
	}







	pub fn set_env_global(&mut self, name: &str, var: ShellVariable) -> Result<(), error::Error> {
		self.env.set_global(name, var)
	}
}
