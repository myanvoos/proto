

use std::io::Write;

use crate::{error, extensions, ioutils};

impl<SE: extensions::ShellExtensions> crate::Shell<SE> {


	pub fn stdout(&self) -> impl std::io::Write + 'static {
		self.open_files.try_stdout().cloned().unwrap_or_else(|| {
			ioutils::FailingReaderWriter::new("standard output not available").into()
		})
	}



	pub fn stderr(&self) -> impl std::io::Write + 'static {
		self.open_files.try_stderr().cloned().unwrap_or_else(|| {
			ioutils::FailingReaderWriter::new("standard error not available").into()
		})
	}









	pub(crate) async fn trace_command<S: AsRef<str>>(
		&mut self,
		params: &crate::interp::ExecutionParameters,
		command: S,
	) {

		let mut prefix = self
			.as_mut()
			.expand_prompt_var("PS4", "")
			.await
			.unwrap_or_default();


		let additional_depth = self.call_stack.script_source_depth() + self.depth;
		if let Some(c) = prefix.chars().next() {
			for _ in 0..additional_depth {
				prefix.insert(0, c);
			}
		}




		let trace_file = if let Some((_, xtracefd_var)) = self.env.get("BASH_XTRACEFD")
			&& let Ok(fd) = xtracefd_var
				.value()
				.to_cow_str(self)
				.parse::<super::ShellFd>()
			&& let Some(file) = self.open_files.try_fd(fd)
		{
			Some(file.clone())
		} else {
			params.try_stderr(self)
		};


		if let Some(trace_file) = trace_file
			&& let Ok(mut trace_file) = trace_file.try_clone()
		{
			let _ = writeln!(trace_file, "{prefix}{}", command.as_ref());
		}
	}









	pub fn display_error(
		&self,
		file: &mut impl std::io::Write,
		err: &error::Error,
	) -> Result<(), error::Error> {
		use crate::extensions::ErrorFormatter as _;
		let str = self.error_formatter.format_error(err, self);
		write!(file, "{str}")?;

		Ok(())
	}
}
