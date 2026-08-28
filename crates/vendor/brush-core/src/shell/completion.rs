

use crate::{completion, error, extensions};

impl<SE: extensions::ShellExtensions> crate::Shell<SE> {







	pub async fn complete(
		&mut self,
		input: &str,
		position: usize,
	) -> Result<completion::Completions, error::Error> {
		let completion_config = self.completion_config.clone();
		completion_config
			.get_completions(self, input, position)
			.await
	}
}
