

use std::borrow::Cow;

use crate::{Shell, error, extensions, prompt};

impl<SE: extensions::ShellExtensions> Shell<SE> {

	const fn default_prompt(&self) -> &'static str {
		if self.options.sh_mode {
			"$ "
		} else {
			"brush$ "
		}
	}



	pub async fn compose_precmd_prompt(&mut self) -> Result<String, error::Error> {
		self.expand_prompt_var("PS0", "").await
	}


	pub async fn compose_prompt(&mut self) -> Result<String, error::Error> {
		self.expand_prompt_var("PS1", self.default_prompt()).await
	}



	pub async fn compose_alt_side_prompt(&mut self) -> Result<String, error::Error> {

		self.expand_prompt_var("BRUSH_PS_ALT", "").await
	}


	pub async fn compose_continuation_prompt(&mut self) -> Result<String, error::Error> {
		self.expand_prompt_var("PS2", "> ").await
	}

	pub(super) async fn expand_prompt_var(
		&mut self,
		var_name: &str,
		default: &str,
	) -> Result<String, error::Error> {






		let prompt_spec = self.parameter_or_default(var_name, default);
		if prompt_spec.is_empty() {
			return Ok(String::new());
		}


		let prev_last_result = self.last_exit_status();
		let prev_last_pipeline_statuses = self.last_pipeline_statuses.clone();


		let params = self.default_exec_params();
		let result = prompt::expand_prompt(self, &params, prompt_spec.into_owned()).await;


		self.last_pipeline_statuses = prev_last_pipeline_statuses;
		self.set_last_exit_status(prev_last_result);



		let mut expanded = result?;
		expanded.retain(|c| c != '\x01' && c != '\x02');

		Ok(expanded)
	}

	fn parameter_or_default<'a>(&'a self, name: &str, default: &'a str) -> Cow<'a, str> {
		self.env_str(name).unwrap_or_else(|| default.into())
	}
}
