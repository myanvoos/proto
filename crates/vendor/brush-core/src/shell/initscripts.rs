

use std::path::PathBuf;

use crate::{Shell, error, expansion, extensions, interp};


#[derive(Default)]
pub enum ProfileLoadBehavior {

	#[default]
	LoadDefault,

	Skip,
}

impl ProfileLoadBehavior {

	pub const fn skip(&self) -> bool {
		matches!(self, Self::Skip)
	}
}


#[derive(Default)]
pub enum RcLoadBehavior {

	#[default]
	LoadDefault,

	LoadCustom(PathBuf),

	Skip,
}

impl RcLoadBehavior {

	pub const fn skip(&self) -> bool {
		matches!(self, Self::Skip)
	}
}

impl<SE: extensions::ShellExtensions> Shell<SE> {







	pub async fn load_config(
		&mut self,
		profile_behavior: &ProfileLoadBehavior,
		rc_behavior: &RcLoadBehavior,
	) -> Result<(), error::Error> {
		let mut params = self.default_exec_params();
		params.process_group_policy = interp::ProcessGroupPolicy::SameProcessGroup;

		if self.options.login_shell {

			if matches!(profile_behavior, ProfileLoadBehavior::Skip) {
				return Ok(());
			}









			if let Some(system_profile) = crate::sys::fs::get_system_profile_path() {
				self.source_if_exists(system_profile, &params).await?;
			}
			if let Some(home_path) = self.home_dir() {
				if self.options.sh_mode {
					self
						.source_if_exists(home_path.join(".profile").as_path(), &params)
						.await?;
				} else {
					if !self
						.source_if_exists(home_path.join(".bash_profile").as_path(), &params)
						.await?
					{
						if !self
							.source_if_exists(home_path.join(".bash_login").as_path(), &params)
							.await?
						{
							self
								.source_if_exists(home_path.join(".profile").as_path(), &params)
								.await?;
						}
					}
				}
			}
		} else {
			if self.options.interactive {
				match rc_behavior {
					_ if self.options.sh_mode => (),
					RcLoadBehavior::Skip => (),
					RcLoadBehavior::LoadCustom(rc_file) => {

						self.source_if_exists(rc_file, &params).await?;
					},
					RcLoadBehavior::LoadDefault => {






						if let Some(system_rc) = crate::sys::fs::get_system_rc_path() {
							self.source_if_exists(system_rc, &params).await?;
						}
						if let Some(home_path) = self.home_dir() {
							self
								.source_if_exists(home_path.join(".bashrc").as_path(), &params)
								.await?;
							self
								.source_if_exists(home_path.join(".brushrc").as_path(), &params)
								.await?;
						}
					},
				}
			} else {
				let env_var_name = if self.options.sh_mode {
					"ENV"
				} else {
					"BASH_ENV"
				};

				if let Some(config_path) = self.env_str(env_var_name) {
					let config_path = config_path.into_owned();
					let options = expansion::ExpanderOptions {
						brace_expand:    false,
						pathname_expand: false,
						..Default::default()
					};
					let expanded_path = expansion::basic_expand_word_with_options(
						self,
						&params,
						config_path.as_str(),
						&options,
					)
					.await?;

					if !expanded_path.is_empty() {
						self.source_if_exists(PathBuf::from(expanded_path), &params).await?;
					}
				}
			}
		}

		Ok(())
	}
}
