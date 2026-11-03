use std::path::PathBuf;

use crate::{Shell, ShellFd, extensions, results, sys};

#[derive(thiserror::Error, Debug)]
#[error("{kind}")]
pub struct Error {
	#[source]
	kind: ErrorKind,

	fatal: bool,
}

#[derive(thiserror::Error, Debug)]
pub enum ErrorKind {
	#[error("cannot expand tilde expression with HOME not set")]
	TildeWithoutValidHome,

	#[error("cannot assign list to array member")]
	AssigningListToArrayMember,

	#[error("must use subscript when assigning associative array")]
	AssociativeArrayMissingSubscript,

	#[error("cannot convert associative array to indexed array")]
	ConvertingAssociativeArrayToIndexedArray,

	#[error("cannot convert indexed array to associative array")]
	ConvertingIndexedArrayToAssociativeArray,

	#[error("failed to source file: {0}")]
	FailedSourcingFile(PathBuf, #[source] std::io::Error),

	#[error("failed to send signal to process")]
	FailedToSendSignal,

	#[error("cannot assign in this way")]
	CannotAssignToSpecialParameter,

	#[error("expansion error: {0}")]
	CheckedExpansionError(String),

	#[error("function not found: {0}")]
	FunctionNotFound(String),

	#[error("command not found: {0}")]
	CommandNotFound(String),

	#[error("not a shell builtin: {0}")]
	BuiltinNotFound(String),

	#[error("working directory does not exist: {0}")]
	WorkingDirMissing(PathBuf),

	#[error("failed to execute command '{0}': {1}")]
	FailedToExecuteCommand(String, #[source] std::io::Error),

	#[error("history item not found")]
	HistoryItemNotFound,

	#[error("not yet implemented: {0}")]
	Unimplemented(&'static str),

	#[error("not yet implemented: {0}; see https://github.com/reubeno/brush/issues/{1}")]
	UnimplementedAndTracked(&'static str, u32),

	#[error("missing environment scope")]
	MissingScope,

	#[error("environment scope required for new variable is not available")]
	MissingScopeForNewVariable,

	#[error("unexpected environment scope type: expected '{expected}', found '{actual}'")]
	UnexpectedScopeType {
		expected: crate::env::EnvironmentScope,

		actual: crate::env::EnvironmentScope,
	},

	#[error("not a directory: {0}")]
	NotADirectory(PathBuf),

	#[error("path is a directory")]
	IsADirectory,

	#[error("variable is not an array")]
	NotArray,

	#[error("no current user")]
	NoCurrentUser,

	#[error("invalid redirection target")]
	InvalidRedirection,

	#[error("failed to redirect to {0}: {1}")]
	RedirectionFailure(String, #[source] std::io::Error),

	/// A pipe for the named construct could not be made.
	#[error("cannot make pipe for {0}: {1}")]
	PipeCreationFailure(&'static str, #[source] std::io::Error),

	/// The process reached its limit of open files (`EMFILE`); `cause` is the
	/// message of the operation that needed one more.
	#[error(
		"{cause}; the process reached its limit of {soft} open files (hard limit {hard}): raise it \
		 with ulimit -n before the process starts"
	)]
	OpenFileLimitReached {
		/// The message of the operation that failed.
		cause: String,
		/// The soft `RLIMIT_NOFILE` of the process.
		soft:  String,
		/// The hard `RLIMIT_NOFILE` of the process.
		hard:  String,
	},

	/// An error occurred evaluating an arithmetic expression.
	#[error("arithmetic evaluation error: {0}")]
	EvalError(#[from] crate::arithmetic::EvalError),

	#[error("failed to parse '{s}' as a {int_type_name}, base-{radix} integer: {inner}")]
	IntParseError {
		s: String,

		int_type_name: &'static str,

		radix: u32,

		inner: std::num::ParseIntError,
	},

	#[error("integer conversion error")]
	TryIntParseError(#[from] std::num::TryFromIntError),

	#[error("failed to decode utf-8")]
	FromUtf8Error(#[from] std::string::FromUtf8Error),

	#[error("failed to decode utf-8")]
	Utf8Error(#[from] std::str::Utf8Error),

	#[error("cannot mutate readonly variable")]
	ReadonlyVariable,

	#[error("invalid pattern: '{0}'")]
	InvalidPattern(String),

	#[error("regex error: {0}")]
	RegexError(#[from] fancy_regex::Error),

	#[error("invalid regex: {0}; expression: '{1}'")]
	InvalidRegexError(fancy_regex::Error, String),

	#[error("i/o error: {0}")]
	IoError(#[from] std::io::Error),

	#[error("bad substitution: {0}")]
	BadSubstitution(String),

	#[error("failed to create child process")]
	ChildCreationFailure,

	#[error(transparent)]
	FormattingError(#[from] std::fmt::Error),

	#[error("{1}: {0}")]
	ParseError(crate::parser::ParseError, crate::SourceInfo),

	#[error("{0}: {1}")]
	FunctionParseError(String, crate::parser::ParseError),

	#[error(transparent)]
	WordParseError(#[from] crate::parser::WordParseError),

	#[error("invalid test command")]
	TestCommandParseError(#[from] crate::parser::TestCommandParseError),

	#[error(transparent)]
	BindingParseError(#[from] crate::parser::BindingParseError),

	#[error("threading error")]
	ThreadingError(#[from] tokio::task::JoinError),

	#[error("{0}: invalid signal specification")]
	InvalidSignal(String),

	#[error("platform error: {0}")]
	PlatformError(#[from] sys::PlatformError),

	#[error("invalid umask value")]
	InvalidUmask,

	#[error("cannot read from {0}")]
	OpenFileNotReadable(&'static str),

	#[error("cannot write to {0}")]
	OpenFileNotWritable(&'static str),

	#[error("bad file descriptor: {0}")]
	BadFileDescriptor(ShellFd),

	#[error("printf failure: {0}")]
	PrintfFailure(i32),

	#[error("printf: {0}")]
	PrintfInvalidUsage(String),

	#[error("interrupted")]
	Interrupted,

	#[error("maximum function call depth exceeded")]
	MaxFunctionCallDepthExceeded,

	#[error("system time error: {0}")]
	TimeError(#[from] std::time::SystemTimeError),

	#[error("array index out of range: {0}")]
	ArrayIndexOutOfRange(String),

	#[error("unhandled key code: {0:?}")]
	UnhandledKeyCode(Vec<u8>),

	#[error("{1}: {0}")]
	BuiltinError(Box<dyn BuiltinError>, String),

	#[error("operation not supported on this platform: {0}")]
	NotSupportedOnThisPlatform(&'static str),

	#[error("command history is not enabled in this shell")]
	HistoryNotEnabled,

	#[error("expanding unset variable: {0}")]
	ExpandingUnsetVariable(String),

	#[error("internal shell error: {0}")]
	InternalError(String),

	#[error("operation requires an interactive session")]
	NotInInteractiveSession,

	#[error("operation requires command-string mode")]
	NotExecutingCommandString,

	#[error("too much data")]
	TooMuchData,

	#[error("cannot convert open file to native file descriptor")]
	CannotConvertToNativeFd,

	#[error("history file is too large to import")]
	HistoryFileTooLargeToImport,

	#[error("too many open files")]
	TooManyOpenFiles,

	#[error("function name '{}' shadows a special built-in command", .name)]
	FunctionNameShadowsSpecialBuiltin { name: String },

	#[error("no match: {0}")]
	NoMatch(String),
}

pub trait BuiltinError: std::error::Error + ConvertibleToExitCode + Send + Sync {
	fn as_io_error(&self) -> Option<&std::io::Error> {
		None
	}
}

impl BuiltinError for Error {
	fn as_io_error(&self) -> Option<&std::io::Error> {
		self.as_io_error()
	}
}

pub trait ConvertibleToExitCode {
	fn as_exit_code(&self) -> results::ExecutionExitCode;
}

impl<T> ConvertibleToExitCode for T
where
	results::ExecutionExitCode: for<'a> From<&'a T>,
{
	fn as_exit_code(&self) -> results::ExecutionExitCode {
		self.into()
	}
}

impl From<&ErrorKind> for results::ExecutionExitCode {
	fn from(value: &ErrorKind) -> Self {
		match value {
			ErrorKind::CommandNotFound(..) => Self::NotFound,
			ErrorKind::Unimplemented(..) | ErrorKind::UnimplementedAndTracked(..) => {
				Self::Unimplemented
			},
			ErrorKind::ParseError(..) => Self::InvalidUsage,
			ErrorKind::FunctionParseError(..) => Self::InvalidUsage,
			ErrorKind::TestCommandParseError(..) => Self::InvalidUsage,
			ErrorKind::FailedToExecuteCommand(..) => Self::CannotExecute,
			ErrorKind::FunctionNameShadowsSpecialBuiltin { .. } => Self::InvalidUsage,
			ErrorKind::IoError(io_err) => io_err.into(),
			ErrorKind::BuiltinError(inner, ..) => inner.as_exit_code(),
			_ => Self::GeneralError,
		}
	}
}

impl From<&std::io::Error> for results::ExecutionExitCode {
	fn from(io_err: &std::io::Error) -> Self {
		if io_err.kind() == std::io::ErrorKind::BrokenPipe {
			Self::BrokenPipe
		} else {
			Self::GeneralError
		}
	}
}

impl From<&Error> for results::ExecutionExitCode {
	fn from(error: &Error) -> Self {
		Self::from(&error.kind)
	}
}

impl<T> From<T> for Error
where
	ErrorKind: From<T>,
{
	fn from(convertible_to_kind: T) -> Self {
		Self { kind: convertible_to_kind.into(), fatal: false }
	}
}

impl Error {
	#[must_use]
	pub const fn into_fatal(mut self) -> Self {
		self.fatal = true;
		self
	}

	pub const fn is_fatal(&self) -> bool {
		self.fatal
	}

	pub const fn kind(&self) -> &ErrorKind {
		&self.kind
	}

	pub fn as_io_error(&self) -> Option<&std::io::Error> {
		match &self.kind {
			ErrorKind::IoError(io_err) => Some(io_err),
			ErrorKind::BuiltinError(inner, _) => inner.as_io_error(),
			_ => None,
		}
	}

	/// When this error, or an error that caused it, is the process running
	/// out of file descriptors (`EMFILE`), returns it restated with that cause
	/// and the process's open-file limit, so the message names the limit to
	/// raise. Only for display: the original error keeps deciding the exit
	/// status.
	#[cfg(unix)]
	pub(crate) fn with_open_file_limit(&self) -> Option<Self> {
		let emfile = emfile_cause(self)?;
		let (soft, hard) = rlimit::Resource::NOFILE.get().ok()?;
		let show = |limit: u64| {
			if limit == rlimit::INFINITY {
				"unlimited".to_string()
			} else {
				limit.to_string()
			}
		};
		// Some messages leave their I/O error out (`failed to source file: …`).
		let message = self.to_string();
		let os_message = emfile.to_string();
		let cause = if message.contains(&os_message) {
			message
		} else {
			format!("{message}: {os_message}")
		};
		Some(ErrorKind::OpenFileLimitReached { cause, soft: show(soft), hard: show(hard) }.into())
	}

	/// Only Unix reports running out of file descriptors as `EMFILE`.
	#[cfg(not(unix))]
	pub(crate) fn with_open_file_limit(&self) -> Option<Self> {
		None
	}

	/// Converts this error into the appropriate control flow based on the
	/// shell's current state. This centralizes the logic for determining how
	/// fatal errors should affect execution flow.
	///
	/// # Arguments
	///
	/// * `shell` - The shell instance, used to check interactive mode and script
	///   call stack.
	pub fn to_control_flow(
		&self,
		shell: &Shell<impl extensions::ShellExtensions>,
	) -> results::ExecutionControlFlow {
		if self.is_fatal() && !shell.options().interactive {
			results::ExecutionControlFlow::ExitShell
		} else {
			results::ExecutionControlFlow::Normal
		}
	}

	pub fn into_result(
		self,
		shell: &Shell<impl extensions::ShellExtensions>,
	) -> results::ExecutionResult {
		let next_control_flow = self.to_control_flow(shell);
		let exit_code = results::ExecutionExitCode::from(&self);

		results::ExecutionResult { next_control_flow, exit_code }
	}
}

/// The `EMFILE` error among the causes of `err`, following each error's
/// source and also the two links `source` does not report: the error a
/// builtin returned (`ErrorKind::BuiltinError`), and the error inside a custom
/// I/O error, whose own `source` skips it.
#[cfg(unix)]
fn emfile_cause<'a>(err: &'a (dyn std::error::Error + 'static)) -> Option<&'a std::io::Error> {
	let mut next = Some(err);
	while let Some(err) = next {
		if let Some(io_err) = err.downcast_ref::<std::io::Error>() {
			if io_err.raw_os_error() == Some(libc::EMFILE) {
				return Some(io_err);
			}
			if let Some(inner) = io_err.get_ref() {
				next = Some(inner as &(dyn std::error::Error + 'static));
				continue;
			}
		}
		if let Some(ErrorKind::BuiltinError(inner, _)) = err.downcast_ref::<ErrorKind>() {
			if let Some(io_err) = inner.as_io_error()
				&& io_err.raw_os_error() == Some(libc::EMFILE)
			{
				return Some(io_err);
			}
			next = Some(&**inner as &(dyn std::error::Error + 'static));
			continue;
		}
		next = err.source();
	}
	None
}

/// Convenience function for returning an error for unimplemented functionality.
///
/// # Arguments
///
/// * `msg` - The message to include in the error
pub fn unimp<T>(msg: &'static str) -> Result<T, Error> {
	Err(ErrorKind::Unimplemented(msg).into())
}

pub fn unimp_with_issue<T>(msg: &'static str, project_issue_id: u32) -> Result<T, Error> {
	Err(ErrorKind::UnimplementedAndTracked(msg, project_issue_id).into())
}
