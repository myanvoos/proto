

use crate::{error, openfiles, sys, terminal};


#[derive(Clone, Debug)]
pub struct Config;

#[allow(clippy::unused_self)]
impl Config {






	pub fn from_term(_file: &openfiles::OpenFile) -> Result<Self, error::Error> {
		Ok(Self)
	}







	pub fn apply_to_term(&self, _file: &openfiles::OpenFile) -> Result<(), error::Error> {
		Ok(())
	}








	pub fn update(&mut self, _settings: &terminal::Settings) {}
}




pub fn get_parent_process_id() -> Option<sys::process::ProcessId> {
	None
}




pub fn get_process_group_id() -> Option<sys::process::ProcessId> {
	None
}




pub fn get_foreground_pid() -> Option<sys::process::ProcessId> {
	None
}




pub fn move_to_foreground(_pid: sys::process::ProcessId) -> Result<(), error::Error> {
	Ok(())
}




pub fn move_self_to_foreground() -> Result<(), std::io::Error> {
	Ok(())
}





pub fn try_get_terminal_device_path() -> Option<std::path::PathBuf> {
	None
}
