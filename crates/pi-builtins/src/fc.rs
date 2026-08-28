use std::{
	fs::{self, OpenOptions},
	io::Write,
	path::{Path, PathBuf},
};

use brush_core::{ExecutionResult, builtins, error, history};
use clap::Parser;


#[derive(Parser)]
pub(crate) struct FcCommand {

	#[arg(short = 'l')]
	list: bool,


	#[arg(short = 'n', requires = "list")]
	no_line_numbers: bool,


	#[arg(short = 'r')]
	reverse: bool,


	#[arg(short = 's')]
	substitute: bool,


	#[arg(short = 'e', value_name = "ENAME")]
	editor: Option<String>,


	#[arg(value_name = "FIRST", allow_hyphen_values = true)]
	first: Option<String>,


	#[arg(value_name = "LAST", allow_hyphen_values = true)]
	last: Option<String>,
}

impl builtins::Command for FcCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		if self.substitute {
			return self.do_execute(context).await;
		}

		if self.list {
			return self.do_list(&context);
		}

		self.do_edit(context).await
	}
}

impl FcCommand {
	fn do_list(
		&self,
		context: &brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
	) -> Result<ExecutionResult, brush_core::Error> {
		let history = context
			.shell
			.history()
			.ok_or_else(|| brush_core::Error::from(brush_core::ErrorKind::HistoryNotEnabled))?;

		let (first_idx, last_idx, reverse) = self.resolve_range(history)?;


		let indices: Vec<usize> = if reverse {
			(first_idx..=last_idx).rev().collect()
		} else {
			(first_idx..=last_idx).collect()
		};

		for idx in indices {
			if let Some(item) = history.get(idx) {
				if self.no_line_numbers {

					writeln!(context.stdout(), "\t {}", item.command_line)?;
				} else {

					writeln!(context.stdout(), "{}\t {}", idx + 1, item.command_line)?;
				}
			}
		}

		Ok(ExecutionResult::success())
	}

	async fn do_edit(
		&self,
		context: brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
	) -> Result<ExecutionResult, brush_core::Error> {
		let history = context
			.shell
			.history()
			.ok_or_else(|| brush_core::Error::from(brush_core::ErrorKind::HistoryNotEnabled))?;

		let (first_idx, last_idx, reverse) = self.resolve_range(history)?;
		let mut commands = String::new();
		let indices: Vec<usize> = if reverse {
			(first_idx..=last_idx).rev().collect()
		} else {
			(first_idx..=last_idx).collect()
		};

		for idx in indices {
			let item = history
				.get(idx)
				.ok_or_else(|| brush_core::Error::from(error::ErrorKind::HistoryItemNotFound))?;
			commands.push_str(&item.command_line);
			commands.push('\n');
		}

		let editor = self.editor_name(&context);
		if editor.as_deref() != Some("-") {
			let temp_file = FcTempFile::create()?;
			fs::write(temp_file.path(), commands)?;

			let edit_cmd = format!(
				"{} {}",
				editor.as_deref().unwrap_or("vi"),
				shell_quote_path(temp_file.path())
			);
			let source_info = brush_core::SourceInfo::from("(fc editor)");
			let edit_result = context
				.shell
				.run_string(edit_cmd, &source_info, &context.params)
				.await?;
			if !edit_result.is_success() {
				return Ok(edit_result);
			}

			commands = fs::read_to_string(temp_file.path())?;
		}

		let history_mut = context
			.shell
			.history_mut()
			.ok_or_else(|| brush_core::Error::from(brush_core::ErrorKind::HistoryNotEnabled))?;
		history_mut.remove_nth_item(history_mut.count().saturating_sub(1));

		if commands.trim().is_empty() {
			return Ok(ExecutionResult::success());
		}

		let source_info = brush_core::SourceInfo::from("(history)");
		let result = context
			.shell
			.run_string(commands.clone(), &source_info, &context.params)
			.await?;
		context.shell.add_to_history(commands.trim_end())?;

		Ok(result)
	}

	fn editor_name(
		&self,
		context: &brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
	) -> Option<String> {
		if let Some(editor) = self.editor.as_ref().filter(|value| !value.is_empty()) {
			return Some(editor.clone());
		}

		context
			.shell
			.env()
			.get_str("FCEDIT", context.shell)
			.filter(|value| !value.is_empty())
			.or_else(|| {
				context
					.shell
					.env()
					.get_str("EDITOR", context.shell)
					.filter(|value| !value.is_empty())
			})
			.map(|value| value.into_owned())
	}

	async fn do_execute(
		&self,
		context: brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
	) -> Result<ExecutionResult, brush_core::Error> {
		let history = context
			.shell
			.history()
			.ok_or_else(|| brush_core::Error::from(brush_core::ErrorKind::HistoryNotEnabled))?;


		let (pattern, replacement) = self
			.first
			.as_ref()
			.and_then(|s| s.split_once('='))
			.map_or((None, None), |(p, r)| (Some(p), Some(r)));


		let cmd_spec = if pattern.is_some() {

			self.last.as_deref()
		} else {

			self.first.as_deref()
		};


		let cmd_line = if let Some(spec) = cmd_spec {
			Self::find_command_by_specifier(history, spec)?
		} else {

			let effective_count = effective_history_count(history);
			history
				.get(effective_count.saturating_sub(1))
				.map(|item| item.command_line.clone())
				.ok_or_else(|| brush_core::Error::from(error::ErrorKind::HistoryItemNotFound))?
		};


		let final_cmd = if let (Some(pat), Some(rep)) = (pattern, replacement) {
			cmd_line.replace(pat, rep)
		} else {
			cmd_line
		};


		writeln!(context.stderr(), "{final_cmd}")?;




		let history_mut = context
			.shell
			.history_mut()
			.ok_or_else(|| brush_core::Error::from(brush_core::ErrorKind::HistoryNotEnabled))?;
		history_mut.remove_nth_item(history_mut.count().saturating_sub(1));

		let source_info = brush_core::SourceInfo::from("(history)");


		let result = context
			.shell
			.run_string(final_cmd.clone(), &source_info, &context.params)
			.await?;


		context.shell.add_to_history(&final_cmd)?;

		Ok(result)
	}

	fn resolve_range(
		&self,
		history: &history::History,
	) -> Result<(usize, usize, bool), brush_core::Error> {
		let effective_count = effective_history_count(history);
		let max_idx = effective_count.saturating_sub(1);


		let first_idx = self
			.first
			.as_ref()
			.map(|s| Self::resolve_position(history, s))
			.transpose()?
			.unwrap_or_else(|| {
				if self.list {
					effective_count.saturating_sub(16)
				} else {
					max_idx
				}
			});


		let default_last = if self.list { max_idx } else { first_idx };
		let last_idx = self
			.last
			.as_ref()
			.map(|s| Self::resolve_position(history, s))
			.transpose()?
			.unwrap_or(default_last);


		let (first_idx, last_idx, force_reverse) = if first_idx > last_idx {
			(last_idx, first_idx, true)
		} else {
			(first_idx, last_idx, false)
		};


		Ok((first_idx.min(max_idx), last_idx.min(max_idx), force_reverse || self.reverse))
	}









	fn resolve_position(history: &history::History, spec: &str) -> Result<usize, brush_core::Error> {


		let Ok(num) = spec.parse::<i64>() else {

			return Self::find_command_by_prefix(history, spec);
		};

		let effective_count = effective_history_count(history);

		#[expect(clippy::cast_sign_loss)]
		#[expect(clippy::cast_possible_truncation)]
		let result = match num.cmp(&0) {
			std::cmp::Ordering::Equal => {

				effective_count.saturating_sub(1)
			},
			std::cmp::Ordering::Greater => {

				let idx = (num - 1) as usize;
				if idx < effective_count {
					idx
				} else {

					0
				}
			},
			std::cmp::Ordering::Less => {

				let offset = (-num) as usize;
				effective_count.saturating_sub(offset)
			},
		};

		Ok(result)
	}









	fn find_command_by_specifier(
		history: &history::History,
		spec: &str,
	) -> Result<String, brush_core::Error> {
		let idx = Self::resolve_position(history, spec)?;
		history
			.get(idx)
			.map(|item| item.command_line.clone())
			.ok_or_else(|| brush_core::Error::from(error::ErrorKind::HistoryItemNotFound))
	}









	fn find_command_by_prefix(
		history: &history::History,
		prefix: &str,
	) -> Result<usize, brush_core::Error> {


		let effective_count = effective_history_count(history);

		for idx in (0..effective_count).rev() {
			if let Some(item) = history.get(idx) {
				if item.command_line.starts_with(prefix) {
					return Ok(idx);
				}
			}
		}

		Err(brush_core::Error::from(error::ErrorKind::HistoryItemNotFound))
	}
}

struct FcTempFile {
	path: PathBuf,
}

impl FcTempFile {
	fn create() -> Result<Self, brush_core::Error> {
		let temp_dir = std::env::temp_dir();
		let process_id = std::process::id();

		for attempt in 0_u32..100 {
			let path = temp_dir.join(format!("brush-fc-{process_id}-{attempt}.sh"));
			match OpenOptions::new().write(true).create_new(true).open(&path) {
				Ok(_) => return Ok(Self { path }),
				Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {},
				Err(err) => return Err(err.into()),
			}
		}

		Err(std::io::Error::new(
			std::io::ErrorKind::AlreadyExists,
			"failed to create a unique fc temporary file",
		)
		.into())
	}

	fn path(&self) -> &Path {
		&self.path
	}
}

impl Drop for FcTempFile {
	fn drop(&mut self) {
		let _ = fs::remove_file(&self.path);
	}
}

fn shell_quote_path(path: &Path) -> String {
	let mut quoted = String::from("'");
	for ch in path.to_string_lossy().chars() {
		if ch == '\'' {
			quoted.push_str("'\\''");
		} else {
			quoted.push(ch);
		}
	}
	quoted.push('\'');
	quoted
}


fn effective_history_count(history: &history::History) -> usize {
	history.count().saturating_sub(1)
}
