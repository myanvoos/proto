

use crate::{error, openfiles, sys};


pub struct TerminalControl {
	prev_fg_pid: Option<sys::process::ProcessId>,
}

impl TerminalControl {

	pub fn acquire() -> Result<Self, error::Error> {








		sys::signal::mask_sigttou()?;

		let prev_fg_pid = sys::terminal::get_foreground_pid();



		let _ = sys::signal::lead_new_process_group();


		sys::terminal::move_self_to_foreground()?;

		Ok(Self { prev_fg_pid })
	}

	fn try_release(&mut self) {

		if let Some(pid) = self.prev_fg_pid
			&& sys::terminal::move_to_foreground(pid).is_ok()
		{
			self.prev_fg_pid = None;
		}
	}
}

impl Drop for TerminalControl {
	fn drop(&mut self) {
		self.try_release();
	}
}


#[derive(Default, bon::Builder)]
pub struct Settings {

	pub echo_input:        Option<bool>,

	pub line_input:        Option<bool>,


	pub interrupt_signals: Option<bool>,

	pub output_nl_as_nlcr: Option<bool>,
}


pub struct AutoModeGuard {
	initial: sys::terminal::Config,
	file:    openfiles::OpenFile,
}

impl AutoModeGuard {





	pub fn new(file: openfiles::OpenFile) -> Result<Self, error::Error> {
		let initial = sys::terminal::Config::from_term(&file)?;
		Ok(Self { initial, file })
	}






	pub fn apply_settings(&self, settings: &Settings) -> Result<(), error::Error> {
		let mut config = sys::terminal::Config::from_term(&self.file)?;
		config.update(settings);
		config.apply_to_term(&self.file)?;

		Ok(())
	}
}

impl Drop for AutoModeGuard {
	fn drop(&mut self) {
		let _ = self.initial.apply_to_term(&self.file);
	}
}
