

use std::collections::HashMap;

use crate::{builtins, extensions};

impl<SE: extensions::ShellExtensions> crate::Shell<SE> {







	pub fn register_builtin<S: Into<String>>(
		&mut self,
		name: S,
		registration: builtins::Registration<SE>,
	) {
		self.builtins.insert(name.into(), registration);
	}








	pub fn register_builtin_if_unset<S: Into<String>>(
		&mut self,
		name: S,
		registration: builtins::Registration<SE>,
	) {
		self.builtins.entry(name.into()).or_insert(registration);
	}







	pub fn builtin_mut(&mut self, name: &str) -> Option<&mut builtins::Registration<SE>> {
		self.builtins.get_mut(name)
	}


	pub const fn builtins(&self) -> &HashMap<String, builtins::Registration<SE>> {
		&self.builtins
	}
}
