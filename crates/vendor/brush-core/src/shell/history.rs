

use std::path::PathBuf;

use crate::{error, openfiles};

impl<SE: crate::extensions::ShellExtensions> crate::Shell<SE> {
	pub(super) fn load_history(&self) -> Result<Option<crate::history::History>, error::Error> {
		const MAX_FILE_SIZE_FOR_HISTORY_IMPORT: u64 = 1024 * 1024 * 1024;

		let Some(history_path) = self.history_file_path() else {
			return Ok(None);
		};

		let mut options = std::fs::File::options();
		options.read(true);

		let mut history_file = self.open_file(&options, history_path, &self.default_exec_params())?;


		if let openfiles::OpenFile::File(file) = &mut history_file {
			let file_metadata = file.metadata()?;
			let file_size = file_metadata.len();




			if file_size == 0 {
				return Ok(None);
			}



			if file_size > MAX_FILE_SIZE_FOR_HISTORY_IMPORT {
				return Err(error::ErrorKind::HistoryFileTooLargeToImport.into());
			}
		}

		Ok(Some(crate::history::History::import(history_file)?))
	}


	pub fn history_file_path(&self) -> Option<PathBuf> {
		self
			.env_str("HISTFILE")
			.map(|s| PathBuf::from(s.into_owned()))
	}


	pub fn history_time_format(&self) -> Option<String> {
		self.env_str("HISTTIMEFORMAT").map(|s| s.into_owned())
	}


	pub fn save_history(&mut self) -> Result<(), error::Error> {
		if let Some(history_file_path) = self.history_file_path()
			&& let Some(history) = &mut self.history
		{


			let write_timestamps = self.env.is_set("HISTTIMEFORMAT");


			history.flush(
				history_file_path,
				true,
				true,
				write_timestamps,
			)?;
		}

		Ok(())
	}


	pub fn add_to_history(&mut self, command: &str) -> Result<(), error::Error> {
		if let Some(history) = &mut self.history {

			let command = command.trim();


			if command.is_empty() {
				return Ok(());
			}


			history.add(crate::history::Item {
				id:           0,
				command_line: command.to_owned(),
				timestamp:    Some(chrono::Utc::now()),
				dirty:        true,
			})?;
		}

		Ok(())
	}
}
