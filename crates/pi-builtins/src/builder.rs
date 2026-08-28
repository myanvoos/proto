use crate::BuiltinSet;


pub trait ShellBuilderExt {





	#[must_use]
	fn default_builtins(self, set: BuiltinSet) -> Self;
}

impl<SE: brush_core::extensions::ShellExtensions, S: brush_core::ShellBuilderState> ShellBuilderExt
	for brush_core::ShellBuilder<SE, S>
{
	fn default_builtins(self, set: BuiltinSet) -> Self {
		self.builtins(crate::default_builtins(set))
	}
}
