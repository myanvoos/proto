

use std::io::Write;

use crate::{error, extensions};

impl<SE: extensions::ShellExtensions> crate::Shell<SE> {

	pub fn check_for_completed_jobs(&mut self) -> Result<(), error::Error> {
		let results = self.jobs.poll()?;

		if self.options.enable_job_control {
			for (job, _result) in results {
				writeln!(self.stderr(), "{job}")?;
			}
		}

		Ok(())
	}
}
