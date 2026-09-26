

use crate::{Shell, error, extensions};



pub trait ShellExtensions: Clone + Default + Send + Sync + 'static {

	type ErrorFormatter: ErrorFormatter;

	/// The registered builtin that serves a command word no builtin is named
	/// after (an interpreter invoked by path or version, say). Functions and
	/// same-named builtins still take precedence.
	fn builtin_alias(command_name: &str) -> Option<&'static str> {
		let _ = command_name;
		None
	}
}


#[derive(Clone, Default)]
pub struct ShellExtensionsImpl<EF: ErrorFormatter = DefaultErrorFormatter> {
	_marker: std::marker::PhantomData<EF>,
}

impl<EF: ErrorFormatter> ShellExtensions for ShellExtensionsImpl<EF> {
	type ErrorFormatter = EF;
}



pub type DefaultShellExtensions = ShellExtensionsImpl<DefaultErrorFormatter>;


pub trait ErrorFormatter: Clone + Default + Send + Sync + 'static {







	fn format_error(
		&self,
		error: &error::Error,
		shell: &Shell<impl extensions::ShellExtensions>,
	) -> String {
		let _ = shell;
		std::format!("error: {error:#}\n")
	}
}


#[derive(Clone, Default)]
pub struct DefaultErrorFormatter;

impl ErrorFormatter for DefaultErrorFormatter {}


pub trait PlaceholderBehavior: Clone + Default + Send + Sync + 'static {}


#[derive(Clone, Default)]
pub struct DefaultPlaceholder;

impl PlaceholderBehavior for DefaultPlaceholder {}
