

use crate::{Shell, error, extensions};



pub trait ShellExtensions: Clone + Default + Send + Sync + 'static {

	type ErrorFormatter: ErrorFormatter;
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
