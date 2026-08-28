

use std::{
	borrow::Cow,
	collections::BTreeMap,
	ffi::OsString,
	fmt::{Display, Write},
};

use crate::{
	error, escape, extensions,
	shell::{Shell, ShellState},
};


#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct ShellVariable {

	value:               ShellValue,

	exported:            bool,

	readonly:            bool,


	enumerable:          bool,

	transform_on_update: ShellVariableUpdateTransform,

	trace:               bool,

	treat_as_integer:    bool,

	treat_as_nameref:    bool,
}


#[derive(Clone, Copy, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum ShellVariableUpdateTransform {

	None,

	Lowercase,

	Uppercase,

	Capitalize,
}

impl Default for ShellVariable {
	fn default() -> Self {
		Self {
			value:               ShellValue::String(String::new()),
			exported:            false,
			readonly:            false,
			enumerable:          true,
			transform_on_update: ShellVariableUpdateTransform::None,
			trace:               false,
			treat_as_integer:    false,
			treat_as_nameref:    false,
		}
	}
}

impl ShellVariable {





	pub fn new<I: Into<ShellValue>>(value: I) -> Self {
		Self { value: value.into(), ..Self::default() }
	}


	pub const fn value(&self) -> &ShellValue {
		&self.value
	}


	pub const fn is_exported(&self) -> bool {
		self.exported
	}


	pub const fn export(&mut self) -> &mut Self {
		self.exported = true;
		self
	}


	pub const fn unexport(&mut self) -> &mut Self {
		self.exported = false;
		self
	}


	pub const fn is_readonly(&self) -> bool {
		self.readonly
	}


	pub const fn set_readonly(&mut self) -> &mut Self {
		self.readonly = true;
		self
	}


	pub fn unset_readonly(&mut self) -> Result<&mut Self, error::Error> {
		if self.readonly {
			return Err(error::ErrorKind::ReadonlyVariable.into());
		}

		self.readonly = false;
		Ok(self)
	}


	pub const fn is_trace_enabled(&self) -> bool {
		self.trace
	}


	pub const fn enable_trace(&mut self) -> &mut Self {
		self.trace = true;
		self
	}


	pub const fn disable_trace(&mut self) -> &mut Self {
		self.trace = false;
		self
	}



	pub const fn is_enumerable(&self) -> bool {
		self.enumerable
	}


	pub const fn hide_from_enumeration(&mut self) -> &mut Self {
		self.enumerable = false;
		self
	}


	pub const fn get_update_transform(&self) -> ShellVariableUpdateTransform {
		self.transform_on_update
	}


	pub const fn set_update_transform(&mut self, transform: ShellVariableUpdateTransform) {
		self.transform_on_update = transform;
	}


	pub const fn is_treated_as_integer(&self) -> bool {
		self.treat_as_integer
	}


	pub const fn treat_as_integer(&mut self) -> &mut Self {
		self.treat_as_integer = true;
		self
	}


	pub const fn unset_treat_as_integer(&mut self) -> &mut Self {
		self.treat_as_integer = false;
		self
	}



	pub const fn is_treated_as_nameref(&self) -> bool {
		self.treat_as_nameref
	}


	pub const fn treat_as_nameref(&mut self) -> &mut Self {
		self.treat_as_nameref = true;
		self
	}


	pub const fn unset_treat_as_nameref(&mut self) -> &mut Self {
		self.treat_as_nameref = false;
		self
	}


	pub fn convert_to_indexed_array(&mut self) -> Result<(), error::Error> {
		match self.value() {
			ShellValue::IndexedArray(_) => Ok(()),
			ShellValue::AssociativeArray(_) => {
				Err(error::ErrorKind::ConvertingAssociativeArrayToIndexedArray.into())
			},
			_ => {
				let mut new_values = BTreeMap::new();
				new_values.insert(0, self.value.to_cow_str_without_dynamic_support().to_string());
				self.value = ShellValue::IndexedArray(new_values);
				Ok(())
			},
		}
	}


	pub fn convert_to_associative_array(&mut self) -> Result<(), error::Error> {
		match self.value() {
			ShellValue::AssociativeArray(_) => Ok(()),
			ShellValue::IndexedArray(_) => {
				Err(error::ErrorKind::ConvertingIndexedArrayToAssociativeArray.into())
			},
			_ => {
				let mut new_values: BTreeMap<String, String> = BTreeMap::new();
				new_values.insert(
					String::from("0"),
					self.value.to_cow_str_without_dynamic_support().to_string(),
				);
				self.value = ShellValue::AssociativeArray(new_values);
				Ok(())
			},
		}
	}








	pub fn assign(&mut self, value: ShellValueLiteral, append: bool) -> Result<(), error::Error> {
		if self.is_readonly() {
			return Err(error::ErrorKind::ReadonlyVariable.into());
		}

		let value = self.convert_value_literal_for_assignment(value);

		if append {
			match (&self.value, &value) {


				(ShellValue::Unset(_), ShellValueLiteral::Array(_))
				| (
					ShellValue::Unset(
						ShellValueUnsetType::IndexedArray | ShellValueUnsetType::AssociativeArray,
					),
					_,
				) => {
					self.assign(ShellValueLiteral::Array(ArrayLiteral(vec![])), false)?;
				},



				(ShellValue::Unset(_), ShellValueLiteral::Scalar(_)) => {
					self.assign(ShellValueLiteral::Scalar(String::new()), false)?;
				},


				(ShellValue::String(_), ShellValueLiteral::Array(_)) => {
					self.convert_to_indexed_array()?;
				},
				_ => (),
			}

			let treat_as_int = self.is_treated_as_integer();
			let update_transform = self.get_update_transform();

			match &mut self.value {
				ShellValue::String(base) => match value {
					ShellValueLiteral::Scalar(suffix) => {
						if treat_as_int {
							let int_value =
								base.parse::<i64>().unwrap_or(0) + suffix.parse::<i64>().unwrap_or(0);
							base.clear();
							base.push_str(int_value.to_string().as_str());
						} else {
							base.push_str(suffix.as_str());
							Self::apply_value_transforms(base, treat_as_int, update_transform);
						}
						Ok(())
					},
					ShellValueLiteral::Array(_) => {

						Ok(())
					},
				},
				ShellValue::IndexedArray(existing_values) => match value {
					ShellValueLiteral::Scalar(new_value) => {
						self.assign_at_index(String::from("0"), new_value, append)
					},
					ShellValueLiteral::Array(new_values) => {
						ShellValue::update_indexed_array_from_literals(existing_values, new_values);
						Ok(())
					},
				},
				ShellValue::AssociativeArray(existing_values) => match value {
					ShellValueLiteral::Scalar(new_value) => {
						self.assign_at_index(String::from("0"), new_value, append)
					},
					ShellValueLiteral::Array(new_values) => {
						ShellValue::update_associative_array_from_literals(existing_values, new_values)
					},
				},
				ShellValue::Unset(_) => unreachable!("covered in conversion above"),

				ShellValue::Dynamic { .. } => Ok(()),
			}
		} else {
			match (&self.value, value) {


				(
					ShellValue::IndexedArray(_)
					| ShellValue::AssociativeArray(_)
					| ShellValue::Unset(
						ShellValueUnsetType::AssociativeArray | ShellValueUnsetType::IndexedArray,
					),
					ShellValueLiteral::Scalar(s),
				) => self.assign_at_index(String::from("0"), s, false),




				(
					ShellValue::IndexedArray(_)
					| ShellValue::Unset(ShellValueUnsetType::IndexedArray | ShellValueUnsetType::Untyped)
					| ShellValue::String(_)
					| ShellValue::Dynamic { .. },
					ShellValueLiteral::Array(literal_values),
				) => {
					self.value = ShellValue::indexed_array_from_literals(literal_values);
					Ok(())
				},



				(
					ShellValue::AssociativeArray(_)
					| ShellValue::Unset(ShellValueUnsetType::AssociativeArray),
					ShellValueLiteral::Array(literal_values),
				) => {
					self.value = ShellValue::associative_array_from_literals(literal_values)?;
					Ok(())
				},



				(ShellValue::Dynamic { .. }, _) => Ok(()),


				(ShellValue::String(_) | ShellValue::Unset(_), ShellValueLiteral::Scalar(s)) => {
					self.value = ShellValue::String(s);
					Ok(())
				},
			}
		}
	}











	pub fn assign_at_index(
		&mut self,
		array_index: String,
		value: String,
		append: bool,
	) -> Result<(), error::Error> {
		match &self.value {
			ShellValue::Unset(_) => {
				self.assign(ShellValueLiteral::Array(ArrayLiteral(vec![])), false)?;
			},
			ShellValue::String(_) => {
				self.convert_to_indexed_array()?;
			},
			_ => (),
		}

		let treat_as_int = self.is_treated_as_integer();
		let value = self.convert_value_str_for_assignment(value);

		match &mut self.value {
			ShellValue::IndexedArray(arr) => {
				let key = get_key_for_indexed_array(arr, array_index.as_str())?;

				if append {
					let existing_value = arr.get(&key).map_or_else(|| "", |v| v.as_str());

					let mut new_value;
					if treat_as_int {
						new_value = (existing_value.parse::<i64>().unwrap_or(0)
							+ value.parse::<i64>().unwrap_or(0))
						.to_string();
					} else {
						new_value = existing_value.to_owned();
						new_value.push_str(value.as_str());
					}

					arr.insert(key, new_value);
				} else {
					arr.insert(key, value);
				}

				Ok(())
			},
			ShellValue::AssociativeArray(arr) => {
				if append {
					let existing_value = arr
						.get(array_index.as_str())
						.map_or_else(|| "", |v| v.as_str());

					let mut new_value;
					if treat_as_int {
						new_value = (existing_value.parse::<i64>().unwrap_or(0)
							+ value.parse::<i64>().unwrap_or(0))
						.to_string();
					} else {
						new_value = existing_value.to_owned();
						new_value.push_str(value.as_str());
					}

					arr.insert(array_index, new_value.clone());
				} else {
					arr.insert(array_index, value);
				}
				Ok(())
			},
			ShellValue::Dynamic { .. } => Ok(()),
			ShellValue::Unset(_) | ShellValue::String(_) => Err(error::ErrorKind::NotArray.into()),
		}
	}

	fn convert_value_literal_for_assignment(&self, value: ShellValueLiteral) -> ShellValueLiteral {
		match value {
			ShellValueLiteral::Scalar(s) => {
				ShellValueLiteral::Scalar(self.convert_value_str_for_assignment(s))
			},
			ShellValueLiteral::Array(literals) => ShellValueLiteral::Array(ArrayLiteral(
				literals
					.0
					.into_iter()
					.map(|(k, v)| (k, self.convert_value_str_for_assignment(v)))
					.collect(),
			)),
		}
	}

	fn convert_value_str_for_assignment(&self, mut s: String) -> String {
		Self::apply_value_transforms(
			&mut s,
			self.is_treated_as_integer(),
			self.get_update_transform(),
		);

		s
	}

	fn apply_value_transforms(
		s: &mut String,
		treat_as_int: bool,
		update_transform: ShellVariableUpdateTransform,
	) {
		if treat_as_int {
			*s = (*s).parse::<i64>().unwrap_or(0).to_string();
		} else {
			match update_transform {
				ShellVariableUpdateTransform::None => (),
				ShellVariableUpdateTransform::Lowercase => *s = (*s).to_lowercase(),
				ShellVariableUpdateTransform::Uppercase => *s = (*s).to_uppercase(),
				ShellVariableUpdateTransform::Capitalize => {

					*s = s.to_lowercase();
					if let Some(c) = s.chars().next() {
						s.replace_range(0..1, &c.to_uppercase().to_string());
					}
				},
			}
		}
	}







	pub fn unset_index(&mut self, index: &str) -> Result<bool, error::Error> {
		match &mut self.value {
			ShellValue::Unset(ty) => match ty {
				ShellValueUnsetType::Untyped => Err(error::ErrorKind::NotArray.into()),
				ShellValueUnsetType::AssociativeArray | ShellValueUnsetType::IndexedArray => Ok(false),
			},
			ShellValue::String(_) => Err(error::ErrorKind::NotArray.into()),
			ShellValue::AssociativeArray(values) => Ok(values.remove(index).is_some()),
			ShellValue::IndexedArray(values) => {
				let key = get_key_for_indexed_array(values, index)?;
				Ok(values.remove(&key).is_some())
			},
			ShellValue::Dynamic { .. } => Ok(false),
		}
	}







	pub fn resolve_value(&self, shell: &Shell<impl extensions::ShellExtensions>) -> ShellValue {


		match &self.value {
			ShellValue::Dynamic { getter, .. } => getter(shell),
			_ => self.value.clone(),
		}
	}


	pub fn attribute_flags(&self, shell: &Shell<impl extensions::ShellExtensions>) -> String {
		let value = self.resolve_value(shell);

		let mut result = String::new();

		if matches!(
			value,
			ShellValue::IndexedArray(_) | ShellValue::Unset(ShellValueUnsetType::IndexedArray)
		) {
			result.push('a');
		}
		if matches!(
			value,
			ShellValue::AssociativeArray(_) | ShellValue::Unset(ShellValueUnsetType::AssociativeArray)
		) {
			result.push('A');
		}
		if matches!(self.get_update_transform(), ShellVariableUpdateTransform::Capitalize) {
			result.push('c');
		}
		if self.is_treated_as_integer() {
			result.push('i');
		}
		if self.is_treated_as_nameref() {
			result.push('n');
		}
		if self.is_readonly() {
			result.push('r');
		}
		if matches!(self.get_update_transform(), ShellVariableUpdateTransform::Lowercase) {
			result.push('l');
		}
		if self.is_trace_enabled() {
			result.push('t');
		}
		if matches!(self.get_update_transform(), ShellVariableUpdateTransform::Uppercase) {
			result.push('u');
		}
		if self.is_exported() {
			result.push('x');
		}

		result
	}
}

type DynamicValueGetter = fn(&dyn ShellState) -> ShellValue;
type DynamicValueSetter = fn(&dyn ShellState) -> ();


#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum ShellValue {

	Unset(ShellValueUnsetType),

	String(String),

	AssociativeArray(BTreeMap<String, String>),

	IndexedArray(BTreeMap<u64, String>),

	Dynamic {


		#[cfg_attr(feature = "serde", serde(skip, default = "default_dynamic_value_getter"))]
		getter: DynamicValueGetter,


		#[cfg_attr(feature = "serde", serde(skip, default = "default_dynamic_value_setter"))]
		setter: DynamicValueSetter,
	},
}

#[cfg(feature = "serde")]
fn default_dynamic_value_getter() -> DynamicValueGetter {
	|_shell: &dyn ShellState| ShellValue::String(String::new())
}

#[cfg(feature = "serde")]
fn default_dynamic_value_setter() -> DynamicValueSetter {
	|_shell: &dyn ShellState| {}
}


#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum ShellValueUnsetType {

	Untyped,

	AssociativeArray,

	IndexedArray,
}


#[derive(Clone, Debug)]
pub enum ShellValueLiteral {

	Scalar(String),

	Array(ArrayLiteral),
}

impl ShellValueLiteral {
	pub(crate) fn fmt_for_tracing(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Scalar(s) => Self::fmt_scalar_for_tracing(s.as_str(), f),
			Self::Array(elements) => {
				write!(f, "(")?;
				for (i, (key, value)) in elements.0.iter().enumerate() {
					if i > 0 {
						write!(f, " ")?;
					}
					if let Some(key) = key {
						write!(f, "[")?;
						Self::fmt_scalar_for_tracing(key.as_str(), f)?;
						write!(f, "]=")?;
					}
					Self::fmt_scalar_for_tracing(value.as_str(), f)?;
				}
				write!(f, ")")
			},
		}
	}

	fn fmt_scalar_for_tracing(s: &str, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		let processed = escape::quote_if_needed(s, escape::QuoteMode::SingleQuote);
		write!(f, "{processed}")
	}
}

impl Display for ShellValueLiteral {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		self.fmt_for_tracing(f)
	}
}

impl From<&str> for ShellValueLiteral {
	fn from(value: &str) -> Self {
		Self::Scalar(value.to_owned())
	}
}

impl From<String> for ShellValueLiteral {
	fn from(value: String) -> Self {
		Self::Scalar(value)
	}
}

impl From<Vec<&str>> for ShellValueLiteral {
	fn from(value: Vec<&str>) -> Self {
		Self::Array(ArrayLiteral(value.into_iter().map(|s| (None, s.to_owned())).collect()))
	}
}


#[derive(Clone, Debug)]
pub struct ArrayLiteral(pub Vec<(Option<String>, String)>);


#[derive(Copy, Clone, Debug)]
pub enum FormatStyle {

	Basic,

	DeclarePrint,
}

impl ShellValue {

	pub const fn is_array(&self) -> bool {
		matches!(
			self,
			Self::IndexedArray(_)
				| Self::AssociativeArray(_)
				| Self::Unset(
					ShellValueUnsetType::IndexedArray | ShellValueUnsetType::AssociativeArray
				)
		)
	}


	pub const fn is_set(&self) -> bool {
		!matches!(self, Self::Unset(_))
	}







	pub fn indexed_array_from_strings<S>(values: S) -> Self
	where
		S: IntoIterator<Item = String>,
	{
		let mut owned_values = BTreeMap::new();
		for (i, value) in values.into_iter().enumerate() {
			owned_values.insert(i as u64, value);
		}

		Self::IndexedArray(owned_values)
	}







	pub fn indexed_array_from_strs(values: &[&str]) -> Self {
		let mut owned_values = BTreeMap::new();
		for (i, value) in values.iter().enumerate() {
			owned_values.insert(i as u64, (*value).to_string());
		}

		Self::IndexedArray(owned_values)
	}






	pub fn indexed_array_from_literals(literals: ArrayLiteral) -> Self {
		let mut values = BTreeMap::new();
		Self::update_indexed_array_from_literals(&mut values, literals);

		Self::IndexedArray(values)
	}

	fn update_indexed_array_from_literals(
		existing_values: &mut BTreeMap<u64, String>,
		literal_values: ArrayLiteral,
	) {
		let mut new_key = if let Some((largest_index, _)) = existing_values.last_key_value() {
			largest_index + 1
		} else {
			0
		};

		for (key, value) in literal_values.0 {
			if let Some(key) = key {
				new_key = key.parse().unwrap_or(0);
			}

			existing_values.insert(new_key, value);
			new_key += 1;
		}
	}







	pub fn associative_array_from_literals(literals: ArrayLiteral) -> Result<Self, error::Error> {
		let mut values = BTreeMap::new();
		Self::update_associative_array_from_literals(&mut values, literals)?;

		Ok(Self::AssociativeArray(values))
	}

	fn update_associative_array_from_literals(
		existing_values: &mut BTreeMap<String, String>,
		literal_values: ArrayLiteral,
	) -> Result<(), error::Error> {
		let mut literal_values = literal_values.0.into_iter();
		let Some((first_key, first_value)) = literal_values.next() else {
			return Ok(());
		};

		if let Some(first_key) = first_key {
			existing_values.insert(first_key, first_value);

			for (key, value) in literal_values {
				let Some(key) = key else {
					return Err(error::ErrorKind::AssociativeArrayMissingSubscript.into());
				};

				existing_values.insert(key, value);
			}
		} else {
			let mut current_key = Some(first_value);
			for (key, value) in literal_values {
				let value = if let Some(key) = key {
					let mut word = String::with_capacity(key.len() + value.len() + 3);
					word.push('[');
					word.push_str(key.as_str());
					word.push_str("]=");
					word.push_str(value.as_str());
					word
				} else {
					value
				};

				if let Some(key) = current_key.take() {
					existing_values.insert(key, value);
				} else {
					current_key = Some(value);
				}
			}

			if let Some(current_key) = current_key {
				existing_values.insert(current_key, String::new());
			}
		}

		Ok(())
	}






	pub fn format(
		&self,
		style: FormatStyle,
		shell: &Shell<impl extensions::ShellExtensions>,
	) -> Result<Cow<'_, str>, error::Error> {
		match self {
			Self::Unset(_) => Ok("".into()),
			Self::String(s) => match style {
				FormatStyle::Basic => {
					Ok(escape::quote_if_needed(s.as_str(), escape::QuoteMode::SingleQuote))
				},
				FormatStyle::DeclarePrint => {
					Ok(escape::force_quote(s.as_str(), escape::QuoteMode::DoubleQuote).into())
				},
			},
			Self::AssociativeArray(values) => {
				let mut result = String::new();
				result.push('(');

				for (key, value) in values {
					let formatted_key =
						escape::quote_if_needed(key.as_str(), escape::QuoteMode::DoubleQuote);
					let formatted_value =
						escape::force_quote(value.as_str(), escape::QuoteMode::DoubleQuote);




					write!(result, "[{formatted_key}]={formatted_value} ")?;
				}

				result.push(')');
				Ok(result.into())
			},
			Self::IndexedArray(values) => {
				let mut result = String::new();
				result.push('(');

				for (i, (key, value)) in values.iter().enumerate() {
					if i > 0 {
						result.push(' ');
					}

					let formatted_value =
						escape::force_quote(value.as_str(), escape::QuoteMode::DoubleQuote);
					write!(result, "[{key}]={formatted_value}")?;
				}

				result.push(')');
				Ok(result.into())
			},
			Self::Dynamic { getter, .. } => {
				let dynamic_value = getter(shell);
				let result = dynamic_value.format(style, shell)?.to_string();
				Ok(result.into())
			},
		}
	}






	pub fn get_at(
		&self,
		index: &str,
		shell: &Shell<impl extensions::ShellExtensions>,
	) -> Result<Option<Cow<'_, str>>, error::Error> {
		match self {
			Self::Unset(_) => Ok(None),
			Self::String(s) => {
				if index.parse::<u64>().unwrap_or(0) == 0 {
					Ok(Some(Cow::Borrowed(s)))
				} else {
					Ok(None)
				}
			},
			Self::AssociativeArray(values) => Ok(values.get(index).map(|s| Cow::Borrowed(s.as_str()))),
			Self::IndexedArray(values) => {
				let key = get_key_for_indexed_array(values, index)?;
				Ok(values.get(&key).map(|s| Cow::Borrowed(s.as_str())))
			},
			Self::Dynamic { getter, .. } => {
				let dynamic_value = getter(shell);
				let result = dynamic_value.get_at(index, shell)?;
				Ok(result.map(|s| s.to_string().into()))
			},
		}
	}


	pub fn element_keys(&self, shell: &Shell<impl extensions::ShellExtensions>) -> Vec<String> {
		match self {
			Self::Unset(_) => vec![],
			Self::String(_) => vec!["0".to_owned()],
			Self::AssociativeArray(array) => array.keys().map(|k| k.to_owned()).collect(),
			Self::IndexedArray(array) => array.keys().map(|k| k.to_string()).collect(),
			Self::Dynamic { getter, .. } => getter(shell).element_keys(shell),
		}
	}


	pub fn element_values(&self, shell: &Shell<impl extensions::ShellExtensions>) -> Vec<String> {
		match self {
			Self::Unset(_) => vec![],
			Self::String(s) => vec![s.to_owned()],
			Self::AssociativeArray(array) => array.values().map(|v| v.to_owned()).collect(),
			Self::IndexedArray(array) => array.values().map(|v| v.to_owned()).collect(),
			Self::Dynamic { getter, .. } => getter(shell).element_values(shell),
		}
	}


	pub fn to_cow_str(&self, shell: &Shell<impl extensions::ShellExtensions>) -> Cow<'_, str> {
		self.try_get_cow_str(shell).unwrap_or(Cow::Borrowed(""))
	}

	fn to_cow_str_without_dynamic_support(&self) -> Cow<'_, str> {
		self
			.try_get_cow_str_without_dynamic_support()
			.unwrap_or(Cow::Borrowed(""))
	}



	pub fn try_get_cow_str(
		&self,
		shell: &Shell<impl extensions::ShellExtensions>,
	) -> Option<Cow<'_, str>> {
		match self {
			Self::Dynamic { getter, .. } => {
				let dynamic_value = getter(shell);
				dynamic_value
					.try_get_cow_str(shell)
					.map(|s| s.to_string().into())
			},
			_ => self.try_get_cow_str_without_dynamic_support(),
		}
	}

	fn try_get_cow_str_without_dynamic_support(&self) -> Option<Cow<'_, str>> {
		match self {
			Self::Unset(_) => None,
			Self::String(s) => Some(Cow::Borrowed(s.as_str())),
			Self::AssociativeArray(values) => values.get("0").map(|s| Cow::Borrowed(s.as_str())),
			Self::IndexedArray(values) => values.get(&0).map(|s| Cow::Borrowed(s.as_str())),
			Self::Dynamic { .. } => None,
		}
	}







	pub fn to_assignable_str(
		&self,
		index: Option<&str>,
		shell: &Shell<impl extensions::ShellExtensions>,
	) -> Result<String, error::Error> {
		match self {
			Self::Unset(_) => Ok(String::new()),
			Self::String(s) => Ok(escape::force_quote(s.as_str(), escape::QuoteMode::SingleQuote)),
			Self::AssociativeArray(_) | Self::IndexedArray(_) => {
				if let Some(index) = index {
					if let Ok(Some(value)) = self.get_at(index, shell) {
						Ok(escape::force_quote(value.as_ref(), escape::QuoteMode::SingleQuote))
					} else {
						Ok(String::new())
					}
				} else {
					Ok(self.format(FormatStyle::DeclarePrint, shell)?.into_owned())
				}
			},
			Self::Dynamic { getter, .. } => getter(shell).to_assignable_str(index, shell),
		}
	}
}

fn get_key_for_indexed_array(
	values: &BTreeMap<u64, String>,
	index_str: &str,
) -> Result<u64, error::Error> {
	let mut index_value = index_str.parse::<i64>().unwrap_or(0);


	#[expect(clippy::cast_possible_wrap)]
	if index_value < 0 {
		index_value += values.len() as i64;
		if index_value < 0 {
			return Err(error::ErrorKind::ArrayIndexOutOfRange(index_str.to_owned()).into());
		}
	}



	#[expect(clippy::cast_sign_loss)]
	Ok(index_value as u64)
}

impl From<&str> for ShellValue {
	fn from(value: &str) -> Self {
		Self::String(value.to_owned())
	}
}

impl From<&String> for ShellValue {
	fn from(value: &String) -> Self {
		Self::String(value.clone())
	}
}

impl From<String> for ShellValue {
	fn from(value: String) -> Self {
		Self::String(value)
	}
}

impl From<OsString> for ShellValue {
	fn from(value: OsString) -> Self {
		Self::String(value.to_string_lossy().into_owned())
	}
}

impl From<Vec<String>> for ShellValue {
	fn from(values: Vec<String>) -> Self {
		Self::indexed_array_from_strings(values)
	}
}

impl From<Vec<&str>> for ShellValue {
	fn from(values: Vec<&str>) -> Self {
		Self::indexed_array_from_strs(values.as_slice())
	}
}
