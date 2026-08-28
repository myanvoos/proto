

use std::{
	borrow::Cow,
	collections::{HashMap, hash_map},
};

use crate::{
	Shell, error, extensions,
	variables::{self, ShellValue, ShellValueUnsetType, ShellVariable},
};


#[derive(Clone, Copy)]
pub enum EnvironmentLookup {

	Anywhere,

	OnlyInGlobal,

	OnlyInCurrentLocal,

	OnlyInLocal,
}


#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum EnvironmentScope {

	Local,

	Global,

	Command,
}

impl std::fmt::Display for EnvironmentScope {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Local => write!(f, "local"),
			Self::Global => write!(f, "global"),
			Self::Command => write!(f, "command"),
		}
	}
}



pub(crate) struct ScopeGuard<'a, SE: extensions::ShellExtensions> {
	scope_type: EnvironmentScope,
	shell:      &'a mut crate::Shell<SE>,
	detached:   bool,
}

impl<'a, SE: extensions::ShellExtensions> ScopeGuard<'a, SE> {







	pub fn new(shell: &'a mut crate::Shell<SE>, scope_type: EnvironmentScope) -> Self {
		shell.env_mut().push_scope(scope_type);
		Self { scope_type, shell, detached: false }
	}


	pub const fn shell(&mut self) -> &mut crate::Shell<SE> {
		self.shell
	}


	pub const fn detach(&mut self) {
		self.detached = true;
	}
}

impl<SE: extensions::ShellExtensions> Drop for ScopeGuard<'_, SE> {
	fn drop(&mut self) {
		if !self.detached {
			let _ = self.shell.env_mut().pop_scope(self.scope_type);
		}
	}
}


#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct ShellEnvironment {

	scopes: Vec<(EnvironmentScope, ShellVariableMap)>,

	export_variables_on_modification: bool,

	entry_count: usize,
}

impl Default for ShellEnvironment {
	fn default() -> Self {
		Self::new()
	}
}

impl ShellEnvironment {

	pub fn new() -> Self {
		Self {
			scopes: vec![(EnvironmentScope::Global, ShellVariableMap::default())],
			export_variables_on_modification: false,
			entry_count: 0,
		}
	}






	pub fn push_scope(&mut self, scope_type: EnvironmentScope) {
		self.scopes.push((scope_type, ShellVariableMap::default()));
	}







	pub fn pop_scope(&mut self, expected_scope_type: EnvironmentScope) -> Result<(), error::Error> {


		match self.scopes.pop() {
			Some((actual_scope_type, _)) if actual_scope_type == expected_scope_type => Ok(()),
			Some((actual_scope_type, _)) => Err(
				error::ErrorKind::UnexpectedScopeType {
					expected: expected_scope_type,
					actual:   actual_scope_type,
				}
				.into(),
			),
			None => Err(error::ErrorKind::MissingScope.into()),
		}
	}






	pub fn iter_exported(&self) -> impl Iterator<Item = (&String, &ShellVariable)> {


		let mut visible_vars: HashMap<&String, &ShellVariable> =
			HashMap::with_capacity(self.entry_count);

		for (_, var_map) in self.scopes.iter().rev() {
			for (name, var) in var_map.iter().filter(|(_, v)| v.is_exported()) {

				if let hash_map::Entry::Vacant(entry) = visible_vars.entry(name) {
					entry.insert(var);
				}
			}
		}

		visible_vars.into_iter()
	}


	pub fn iter(&self) -> impl Iterator<Item = (&String, &ShellVariable)> {
		self.iter_using_policy(EnvironmentLookup::Anywhere)
	}







	pub fn iter_using_policy(
		&self,
		lookup_policy: EnvironmentLookup,
	) -> impl Iterator<Item = (&String, &ShellVariable)> {


		let mut visible_vars: HashMap<&String, &ShellVariable> =
			HashMap::with_capacity(self.entry_count);

		let mut local_count = 0;
		for (scope_type, var_map) in self.scopes.iter().rev() {
			if matches!(scope_type, EnvironmentScope::Local) {
				local_count += 1;
			}

			match lookup_policy {
				EnvironmentLookup::Anywhere => (),
				EnvironmentLookup::OnlyInGlobal => {
					if !matches!(scope_type, EnvironmentScope::Global) {
						continue;
					}
				},
				EnvironmentLookup::OnlyInCurrentLocal => {
					if !(matches!(scope_type, EnvironmentScope::Local) && local_count == 1) {
						continue;
					}
				},
				EnvironmentLookup::OnlyInLocal => {
					if !matches!(scope_type, EnvironmentScope::Local) {
						continue;
					}
				},
			}

			for (name, var) in var_map.iter() {

				if let hash_map::Entry::Vacant(entry) = visible_vars.entry(name) {
					entry.insert(var);
				}
			}

			if matches!(scope_type, EnvironmentScope::Local)
				&& matches!(lookup_policy, EnvironmentLookup::OnlyInCurrentLocal)
			{
				break;
			}
		}

		visible_vars.into_iter()
	}







	pub fn get<S: AsRef<str>>(&self, name: S) -> Option<(EnvironmentScope, &ShellVariable)> {

		for (scope_type, map) in self.scopes.iter().rev() {
			if let Some(var) = map.get(name.as_ref()) {
				return Some((*scope_type, var));
			}
		}

		None
	}







	pub fn get_mut<S: AsRef<str>>(
		&mut self,
		name: S,
	) -> Option<(EnvironmentScope, &mut ShellVariable)> {

		for (scope_type, map) in self.scopes.iter_mut().rev() {
			if let Some(var) = map.get_mut(name.as_ref()) {
				return Some((*scope_type, var));
			}
		}

		None
	}








	pub fn get_str<S: AsRef<str>, SE: extensions::ShellExtensions>(
		&self,
		name: S,
		shell: &Shell<SE>,
	) -> Option<Cow<'_, str>> {
		self
			.get(name.as_ref())
			.map(|(_, v)| v.value().to_cow_str(shell))
	}






	pub fn is_set<S: AsRef<str>>(&self, name: S) -> bool {
		if let Some((_, var)) = self.get(name) {
			!matches!(var.value(), ShellValue::Unset(_))
		} else {
			false
		}
	}











	pub fn unset(&mut self, name: &str) -> Result<Option<ShellVariable>, error::Error> {
		let mut local_count = 0;
		for (scope_type, map) in self.scopes.iter_mut().rev() {
			if matches!(scope_type, EnvironmentScope::Local) {
				local_count += 1;
			}

			let unset_result = Self::try_unset_in_map(map, name)?;

			if unset_result.is_some() {


				if matches!(scope_type, EnvironmentScope::Local) && local_count == 1 {
					map.set(name, ShellVariable::new(ShellValue::Unset(ShellValueUnsetType::Untyped)));
				} else if self.entry_count > 0 {

					self.entry_count -= 1;
				}

				return Ok(unset_result);
			}
		}

		Ok(None)
	}









	pub fn unset_index(&mut self, name: &str, index: &str) -> Result<bool, error::Error> {
		if let Some((_, var)) = self.get_mut(name) {
			var.unset_index(index)
		} else {
			Ok(false)
		}
	}

	fn try_unset_in_map(
		map: &mut ShellVariableMap,
		name: &str,
	) -> Result<Option<ShellVariable>, error::Error> {
		match map.get(name).map(|v| v.is_readonly()) {
			Some(true) => Err(error::ErrorKind::ReadonlyVariable.into()),
			Some(false) => Ok(map.unset(name)),
			None => Ok(None),
		}
	}








	pub fn get_using_policy<N: AsRef<str>>(
		&self,
		name: N,
		lookup_policy: EnvironmentLookup,
	) -> Option<&ShellVariable> {
		let mut local_count = 0;
		for (scope_type, var_map) in self.scopes.iter().rev() {
			if matches!(scope_type, EnvironmentScope::Local) {
				local_count += 1;
			}

			match lookup_policy {
				EnvironmentLookup::Anywhere => (),
				EnvironmentLookup::OnlyInGlobal => {
					if !matches!(scope_type, EnvironmentScope::Global) {
						continue;
					}
				},
				EnvironmentLookup::OnlyInCurrentLocal => {
					if !(matches!(scope_type, EnvironmentScope::Local) && local_count == 1) {
						continue;
					}
				},
				EnvironmentLookup::OnlyInLocal => {
					if !matches!(scope_type, EnvironmentScope::Local) {
						continue;
					}
				},
			}

			if let Some(var) = var_map.get(name.as_ref()) {
				return Some(var);
			}

			if matches!(scope_type, EnvironmentScope::Local)
				&& matches!(lookup_policy, EnvironmentLookup::OnlyInCurrentLocal)
			{
				break;
			}
		}

		None
	}








	pub fn get_mut_using_policy<N: AsRef<str>>(
		&mut self,
		name: N,
		lookup_policy: EnvironmentLookup,
	) -> Option<&mut ShellVariable> {
		let mut local_count = 0;
		for (scope_type, var_map) in self.scopes.iter_mut().rev() {
			if matches!(scope_type, EnvironmentScope::Local) {
				local_count += 1;
			}

			match lookup_policy {
				EnvironmentLookup::Anywhere => (),
				EnvironmentLookup::OnlyInGlobal => {
					if !matches!(scope_type, EnvironmentScope::Global) {
						continue;
					}
				},
				EnvironmentLookup::OnlyInCurrentLocal => {
					if !(matches!(scope_type, EnvironmentScope::Local) && local_count == 1) {
						continue;
					}
				},
				EnvironmentLookup::OnlyInLocal => {
					if !matches!(scope_type, EnvironmentScope::Local) {
						continue;
					}
				},
			}

			if let Some(var) = var_map.get_mut(name.as_ref()) {
				return Some(var);
			}

			if matches!(scope_type, EnvironmentScope::Local)
				&& matches!(lookup_policy, EnvironmentLookup::OnlyInCurrentLocal)
			{
				break;
			}
		}

		None
	}













	pub fn update_or_add<N: Into<String>>(
		&mut self,
		name: N,
		value: variables::ShellValueLiteral,
		updater: impl Fn(&mut ShellVariable) -> Result<(), error::Error>,
		lookup_policy: EnvironmentLookup,
		scope_if_creating: EnvironmentScope,
	) -> Result<(), error::Error> {
		let name = name.into();

		let auto_export = self.export_variables_on_modification;
		if let Some(var) = self.get_mut_using_policy(&name, lookup_policy) {
			var.assign(value, false)?;
			if auto_export {
				var.export();
			}
			updater(var)
		} else {
			let mut var = ShellVariable::new(ShellValue::Unset(ShellValueUnsetType::Untyped));
			var.assign(value, false)?;
			if auto_export {
				var.export();
			}
			updater(&mut var)?;

			self.add(name, var, scope_if_creating)
		}
	}














	pub fn update_or_add_array_element<N: Into<String>>(
		&mut self,
		name: N,
		index: String,
		value: String,
		updater: impl Fn(&mut ShellVariable) -> Result<(), error::Error>,
		lookup_policy: EnvironmentLookup,
		scope_if_creating: EnvironmentScope,
	) -> Result<(), error::Error> {
		let name = name.into();

		if let Some(var) = self.get_mut_using_policy(&name, lookup_policy) {
			var.assign_at_index(index, value, false)?;
			updater(var)
		} else {
			let mut var = ShellVariable::new(ShellValue::Unset(ShellValueUnsetType::Untyped));
			var.assign(
				variables::ShellValueLiteral::Array(variables::ArrayLiteral(vec![(
					Some(index),
					value,
				)])),
				false,
			)?;
			updater(&mut var)?;

			self.add(name, var, scope_if_creating)
		}
	}








	pub fn add<N: Into<String>>(
		&mut self,
		name: N,
		mut var: ShellVariable,
		target_scope: EnvironmentScope,
	) -> Result<(), error::Error> {
		if self.export_variables_on_modification {
			var.export();
		}

		for (scope_type, map) in self.scopes.iter_mut().rev() {
			if *scope_type == target_scope {
				let prev_var = map.set(name, var);
				if prev_var.is_none() {
					self.entry_count += 1;
				}

				return Ok(());
			}
		}

		Err(error::ErrorKind::MissingScopeForNewVariable.into())
	}







	pub fn set_global<N: Into<String>>(
		&mut self,
		name: N,
		var: ShellVariable,
	) -> Result<(), error::Error> {
		self.add(name, var, EnvironmentScope::Global)
	}
}


#[derive(Clone, Debug, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct ShellVariableMap {
	variables: HashMap<String, ShellVariable>,
}

impl ShellVariableMap {





	pub fn iter(&self) -> impl Iterator<Item = (&String, &ShellVariable)> {
		self.variables.iter()
	}







	pub fn get(&self, name: &str) -> Option<&ShellVariable> {
		self.variables.get(name)
	}







	pub fn get_mut(&mut self, name: &str) -> Option<&mut ShellVariable> {
		self.variables.get_mut(name)
	}











	pub fn unset(&mut self, name: &str) -> Option<ShellVariable> {
		self.variables.remove(name)
	}







	pub fn set<N: Into<String>>(&mut self, name: N, var: ShellVariable) -> Option<ShellVariable> {
		self.variables.insert(name.into(), var)
	}
}


pub fn valid_variable_name(s: &str) -> bool {
	let mut cs = s.chars();
	match cs.next() {
		Some(c) if c.is_ascii_alphabetic() || c == '_' => {
			cs.all(|c| c.is_ascii_alphanumeric() || c == '_')
		},
		Some(_) | None => false,
	}
}


