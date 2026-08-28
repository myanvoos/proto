

use std::{collections::HashMap, sync::Arc};


#[derive(Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct FunctionEnv {
	functions: HashMap<String, Registration>,
}

impl FunctionEnv {





	pub fn get(&self, name: &str) -> Option<&Registration> {
		self.functions.get(name)
	}







	pub fn get_mut(&mut self, name: &str) -> Option<&mut Registration> {
		self.functions.get_mut(name)
	}






	pub fn remove(&mut self, name: &str) -> Option<Registration> {
		self.functions.remove(name)
	}







	pub fn update(&mut self, name: String, registration: Registration) {
		self.functions.insert(name, registration);
	}


	pub fn clear(&mut self) {
		self.functions.clear();
	}


	pub fn iter(&self) -> impl Iterator<Item = (&String, &Registration)> {
		self.functions.iter()
	}
}


#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Registration {

	definition:  Arc<brush_parser::ast::FunctionDefinition>,

	source_info: crate::SourceInfo,

	exported:    bool,
}

impl From<brush_parser::ast::FunctionDefinition> for Registration {
	fn from(definition: brush_parser::ast::FunctionDefinition) -> Self {
		Self {
			definition:  Arc::new(definition),
			source_info: crate::SourceInfo::default(),
			exported:    false,
		}
	}
}

impl Registration {






	pub fn new(
		definition: brush_parser::ast::FunctionDefinition,
		source_info: &crate::SourceInfo,
	) -> Self {
		Self {
			definition:  Arc::new(definition),
			source_info: source_info.clone(),
			exported:    false,
		}
	}


	pub fn definition(&self) -> &brush_parser::ast::FunctionDefinition {
		&self.definition
	}


	pub const fn source(&self) -> &crate::SourceInfo {
		&self.source_info
	}


	pub const fn export(&mut self) {
		self.exported = true;
	}


	pub const fn unexport(&mut self) {
		self.exported = false;
	}


	pub const fn is_exported(&self) -> bool {
		self.exported
	}
}
