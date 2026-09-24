//! Inline interpreter programs and heredoc file writes inside a shell command,
//! read with the embedded shell's own tokenizer.

use napi_derive::napi;

/// Program text an interpreter invocation carries inline.
#[napi(object)]
pub struct ShellCodeCell {
	#[napi(ts_type = "\"python\" | \"js\"")]
	pub language: String,
	/// The program as the interpreter receives it.
	pub code:     String,
	/// UTF-16 range of the raw region: heredoc body, or the code word with its
	/// quoting.
	pub start:    u32,
	pub end:      u32,
	/// Executes as a persistent kernel cell rather than a real interpreter.
	pub kernel:   bool,
	/// The command holds shell source besides this interpreter call.
	pub mixed:    bool,
}

/// Source a `cat`/`tee` heredoc writes to a file.
#[napi(object)]
pub struct ShellFileWrite {
	/// Destination path after shell quote removal.
	pub path:  String,
	pub code:  String,
	/// UTF-16 range of the heredoc body.
	pub start: u32,
	pub end:   u32,
}

#[napi(object)]
pub struct ShellEmbeddedCode {
	/// Interpreter programs in source order.
	pub cells:  Vec<ShellCodeCell>,
	/// Heredoc file writes in source order.
	pub writes: Vec<ShellFileWrite>,
}

fn offset(value: usize) -> u32 {
	u32::try_from(value).unwrap_or(u32::MAX)
}

/// Find the interpreter programs (`python -c …`, `.venv/bin/python - <<EOF`,
/// `node -e …`) and heredoc file writes in a shell command. Partial
/// (streaming) commands are closed synthetically before scanning.
#[napi(catch_unwind)]
pub fn scan_shell_embedded_code(command: String) -> ShellEmbeddedCode {
	let scan = pi_builtins::scan_embedded_code(&command);
	ShellEmbeddedCode {
		cells:  scan
			.cells
			.into_iter()
			.map(|cell| ShellCodeCell {
				language: match cell.language {
					pi_builtins::CodeLanguage::Python => "python",
					pi_builtins::CodeLanguage::Js => "js",
				}
				.to_owned(),
				code:     cell.code,
				start:    offset(cell.start),
				end:      offset(cell.end),
				kernel:   cell.kernel,
				mixed:    cell.mixed,
			})
			.collect(),
		writes: scan
			.writes
			.into_iter()
			.map(|write| ShellFileWrite {
				path:  write.path,
				code:  write.code,
				start: offset(write.start),
				end:   offset(write.end),
			})
			.collect(),
	}
}
