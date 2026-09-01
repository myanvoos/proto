// Copyright 2017 Google Inc.


pub mod matchers {
	// Copyright 2017 Google Inc.


	mod access {
		// Copyright 2022 Tavian Barnes


		use faccess::PathExt;

		use super::{Matcher, MatcherIO, WalkEntry};


		pub enum AccessMatcher {
			Readable,
			Writable,
			Executable,
		}

		impl Matcher for AccessMatcher {
			fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
				let path = file_info.path();

				match self {
					Self::Readable => path.readable(),
					Self::Writable => path.writable(),
					Self::Executable => path.executable(),
				}
			}
		}
	}
	mod delete {


		use std::{
			fs,
			io::{self, Write},
		};


		use super::{Matcher, MatcherIO, WalkEntry};

		pub struct DeleteMatcher;

		impl DeleteMatcher {
			pub fn new() -> Self {
				Self
			}

			fn delete(&self, entry: &WalkEntry) -> io::Result<()> {
				if entry.file_type().is_dir() && !entry.path_is_symlink() {
					fs::remove_dir(entry.path())
				} else {
					fs::remove_file(entry.path())
				}
			}
		}

		impl Matcher for DeleteMatcher {
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				let path = file_info.path();
				let path_str = path.to_string_lossy();


				if path_str == "." {
					return true;
				}

				match self.delete(file_info) {
					Ok(()) => true,
					Err(e) => {
						matcher_io.set_exit_code(1);
						writeln!(&mut matcher_io.host().stderr, "Failed to delete {path_str}: {e}").unwrap();
						false
					},
				}
			}

			fn has_side_effects(&self) -> bool {
				true
			}
		}
	}
	mod empty {
		// Copyright 2021 Collabora, Ltd.


		use std::{fs::read_dir, io::Write};


		use super::{Matcher, MatcherIO, WalkEntry};

		pub struct EmptyMatcher;

		impl EmptyMatcher {
			pub fn new() -> Self {
				Self
			}
		}

		impl Matcher for EmptyMatcher {
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				if file_info.file_type().is_file() {
					match file_info.metadata() {
						Ok(meta) => meta.len() == 0,
						Err(err) => {
							writeln!(
								&mut matcher_io.host().stderr,
								"Error getting size for {}: {}",
								file_info.path().display(),
								err
							)
							.unwrap();
							false
						},
					}
				} else if file_info.file_type().is_dir() {
					match read_dir(file_info.path()) {
						Ok(mut it) => it.next().is_none(),
						Err(err) => {
							writeln!(
								&mut matcher_io.host().stderr,
								"Error getting contents of {}: {}",
								file_info.path().display(),
								err
							)
							.unwrap();
							false
						},
					}
				} else {
					false
				}
			}
		}
	}
	mod entry {


		#[cfg(unix)]
		use std::os::unix::fs::FileTypeExt;
		use std::{
			cell::OnceCell,
			error::Error,
			ffi::OsStr,
			fmt::{self, Display, Formatter},
			fs::{self, Metadata},
			io::{self, ErrorKind},
			path::{Path, PathBuf},
		};

		use super::Follow;


		#[derive(Clone, Copy, Debug, Eq, PartialEq)]
		pub enum FileType {
			Unknown,
			Fifo,
			CharDevice,
			Directory,
			BlockDevice,
			Regular,
			Symlink,
			Socket,
		}

		impl FileType {
			pub fn is_dir(self) -> bool {
				self == Self::Directory
			}

			pub fn is_file(self) -> bool {
				self == Self::Regular
			}

			pub fn is_symlink(self) -> bool {
				self == Self::Symlink
			}
		}

		impl From<fs::FileType> for FileType {
			fn from(t: fs::FileType) -> Self {
				if t.is_dir() {
					return Self::Directory;
				}
				if t.is_file() {
					return Self::Regular;
				}
				if t.is_symlink() {
					return Self::Symlink;
				}

				#[cfg(unix)]
				{
					if t.is_fifo() {
						return Self::Fifo;
					}
					if t.is_char_device() {
						return Self::CharDevice;
					}
					if t.is_block_device() {
						return Self::BlockDevice;
					}
					if t.is_socket() {
						return Self::Socket;
					}
				}

				Self::Unknown
			}
		}


		#[derive(Clone, Debug)]
		pub struct WalkError {

			path:  Option<PathBuf>,

			depth: Option<usize>,

			raw:   Option<i32>,
		}

		impl WalkError {

			pub fn path(&self) -> Option<&Path> {
				self.path.as_deref()
			}


			pub fn depth(&self) -> Option<usize> {
				self.depth
			}


			pub fn kind(&self) -> ErrorKind {
				io::Error::from(self).kind()
			}


			pub fn is_not_found(&self) -> bool {
				if self.kind() == ErrorKind::NotFound {
					return true;
				}


				#[cfg(unix)]
				{
					if self.raw == Some(uucore::libc::ENOTDIR) {
						return true;
					}
				}

				false
			}


			pub fn is_loop(&self) -> bool {
				#[cfg(unix)]
				return self.raw == Some(uucore::libc::ELOOP);

				#[cfg(not(unix))]
				return false;
			}
		}

		impl Display for WalkError {
			fn fmt(&self, f: &mut Formatter<'_>) -> Result<(), fmt::Error> {
				let ioe = io::Error::from(self);
				if let Some(path) = &self.path {
					write!(f, "{}: {}", path.display(), ioe)
				} else {
					write!(f, "{}", ioe)
				}
			}
		}

		impl Error for WalkError {}

		impl From<io::Error> for WalkError {
			fn from(e: io::Error) -> Self {
				Self::from(&e)
			}
		}

		impl From<&io::Error> for WalkError {
			fn from(e: &io::Error) -> Self {
				Self { path: None, depth: None, raw: e.raw_os_error() }
			}
		}

		impl From<WalkError> for io::Error {
			fn from(e: WalkError) -> Self {
				Self::from(&e)
			}
		}

		impl From<&WalkError> for io::Error {
			fn from(e: &WalkError) -> Self {
				e.raw
					.map(Self::from_raw_os_error)
					.unwrap_or_else(|| ErrorKind::Other.into())
			}
		}


		#[derive(Debug)]
		pub struct WalkEntry {

			path:    PathBuf,

			depth:   usize,

			follow:  Follow,

			meta:    OnceCell<Result<Metadata, WalkError>>,


			display: Option<PathBuf>,
		}

		impl WalkEntry {

			pub fn new(path: impl Into<PathBuf>, depth: usize, follow: Follow) -> Self {
				Self { path: path.into(), depth, follow, meta: OnceCell::new(), display: None }
			}


			pub fn path(&self) -> &Path {
				self.path.as_path()
			}


			pub fn display_path(&self) -> &Path {
				self.display.as_deref().unwrap_or_else(|| self.path())
			}


			pub fn set_display_root(&mut self, operand: &Path, resolved_root: &Path) {
				let display = match self.path().strip_prefix(resolved_root) {
					Ok(rel) if rel.as_os_str().is_empty() => operand.to_path_buf(),
					Ok(rel) => operand.join(rel),
					Err(_) => return,
				};
				self.display = Some(display);
			}


			pub fn file_name(&self) -> &OsStr {

				self
					.path
					.components()
					.next_back()
					.map(|c| c.as_os_str())
					.unwrap_or_else(|| self.path.as_os_str())
			}


			pub fn depth(&self) -> usize {
				self.depth
			}


			pub fn follow(&self) -> bool {
				self.follow.follow_at_depth(self.depth())
			}


			fn get_metadata(&self) -> Result<Metadata, WalkError> {
				self.follow.metadata_at_depth(&self.path, self.depth)
			}


			pub fn metadata(&self) -> Result<&Metadata, WalkError> {
				let result = self.meta.get_or_init(|| self.get_metadata());
				result.as_ref().map_err(|e| e.clone())
			}


			pub fn file_type(&self) -> FileType {
				self
					.metadata()
					.map(|m| m.file_type().into())
					.unwrap_or(FileType::Unknown)
			}


			pub fn path_is_symlink(&self) -> bool {
				if self.follow() {
					self
						.path
						.symlink_metadata()
						.is_ok_and(|m| m.file_type().is_symlink())
				} else {
					self.file_type().is_symlink()
				}
			}
		}
	}
	pub mod exec {
		// Copyright 2017 Google Inc.


		use std::{cell::RefCell, error::Error, ffi::OsString, io::Write, path::Path, process::Command};


		use super::{Matcher, MatcherIO, WalkEntry};

		enum Arg {
			FileArg(Vec<OsString>),
			LiteralArg(OsString),
		}

		pub struct SingleExecMatcher {
			executable:         String,
			args:               Vec<Arg>,
			exec_in_parent_dir: bool,
		}

		impl SingleExecMatcher {
			pub fn new(
				executable: &str,
				args: &[&str],
				exec_in_parent_dir: bool,
			) -> Result<Self, Box<dyn Error>> {
				let transformed_args = args
					.iter()
					.map(|&a| {
						let parts = a.split("{}").collect::<Vec<_>>();
						if parts.len() == 1 {

							Arg::LiteralArg(OsString::from(a))
						} else {
							Arg::FileArg(parts.iter().map(OsString::from).collect())
						}
					})
					.collect();

				Ok(Self { executable: executable.to_string(), args: transformed_args, exec_in_parent_dir })
			}
		}

		impl Matcher for SingleExecMatcher {
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				let mut command = Command::new(&self.executable);
				let path_to_file = if self.exec_in_parent_dir {
					if let Some(f) = file_info.path().file_name() {
						Path::new(".").join(f)
					} else {
						Path::new(".").join(file_info.path())
					}
				} else {
					file_info.display_path().to_path_buf()
				};

				for arg in &self.args {
					match *arg {
						Arg::LiteralArg(ref a) => command.arg(a.as_os_str()),
						Arg::FileArg(ref parts) => command.arg(parts.join(path_to_file.as_os_str())),
					};
				}
				if self.exec_in_parent_dir {
					match file_info.path().parent() {
						None => {


							command.current_dir(file_info.path());
						},
						Some(parent) if parent == Path::new("") => {

						},
						Some(parent) => {
							command.current_dir(parent);
						},
					}
				} else {


					command.current_dir(matcher_io.host().cwd());
				}
				command.env_clear().envs(matcher_io.host().env());


				match matcher_io.host().run_captured(&mut command) {
					Ok(status) => status.success(),
					Err(e) => {
						writeln!(&mut matcher_io.host().stderr, "Failed to run {}: {}", self.executable, e).unwrap();
						false
					},
				}
			}

			fn has_side_effects(&self) -> bool {
				true
			}
		}

		pub struct MultiExecMatcher {
			executable:         String,
			args:               Vec<OsString>,
			exec_in_parent_dir: bool,

			command:            RefCell<Option<argmax::Command>>,
		}

		impl MultiExecMatcher {
			pub fn new(
				executable: &str,
				args: &[&str],
				exec_in_parent_dir: bool,
			) -> Result<Self, Box<dyn Error>> {
				let transformed_args = args.iter().map(OsString::from).collect();

				Ok(Self {
					executable: executable.to_string(),
					args: transformed_args,
					exec_in_parent_dir,
					command: RefCell::new(None),
				})
			}

			fn new_command(&self, matcher_io: &mut MatcherIO) -> argmax::Command {
				let mut command = argmax::Command::new(&self.executable);
				command.try_args(&self.args).unwrap();
				if !self.exec_in_parent_dir {


					command.current_dir(matcher_io.host().cwd());
				}
				command
			}

			fn run_command(&self, command: &mut argmax::Command, matcher_io: &mut MatcherIO) {


				let mut std_command = Command::new(command.get_program());
				std_command.args(command.get_args());
				if let Some(dir) = command.get_current_dir() {
					std_command.current_dir(dir);
				}
				std_command.env_clear().envs(matcher_io.host().env());
				match matcher_io.host().run_captured(&mut std_command) {
					Ok(status) => {
						if !status.success() {
							matcher_io.set_exit_code(1);
						}
					},
					Err(e) => {
						writeln!(&mut matcher_io.host().stderr, "Failed to run {}: {}", self.executable, e).unwrap();
						matcher_io.set_exit_code(1);
					},
				}
			}
		}

		impl Matcher for MultiExecMatcher {
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				let path_to_file = if self.exec_in_parent_dir {
					if let Some(f) = file_info.path().file_name() {
						Path::new(".").join(f)
					} else {
						Path::new(".").join(file_info.path())
					}
				} else {
					file_info.display_path().to_path_buf()
				};
				let mut command = self.command.borrow_mut();
				let command = command.get_or_insert_with(|| self.new_command(matcher_io));


				if command.try_arg(&path_to_file).is_err() {
					if self.exec_in_parent_dir {
						match file_info.path().parent() {
							None => {


								command.current_dir(file_info.path());
							},
							Some(parent) if parent == Path::new("") => {

							},
							Some(parent) => {
								command.current_dir(parent);
							},
						}
					}
					self.run_command(command, matcher_io);


					*command = self.new_command(matcher_io);
					if let Err(e) = command.try_arg(&path_to_file) {
						writeln!(
							&mut matcher_io.host().stderr,
							"Cannot fit a single argument {}: {}",
							path_to_file.to_string_lossy(),
							e
						)
						.unwrap();
						matcher_io.set_exit_code(1);
					}
				}
				true
			}

			fn finished_dir(&self, dir: &Path, matcher_io: &mut MatcherIO) {

				if self.exec_in_parent_dir {
					let mut command = self.command.borrow_mut();
					if let Some(mut command) = command.take() {
						command.current_dir(Path::new(".").join(dir));
						self.run_command(&mut command, matcher_io);
					}
				}
			}

			fn finished(&self, matcher_io: &mut MatcherIO) {

				if !self.exec_in_parent_dir {
					let mut command = self.command.borrow_mut();
					if let Some(mut command) = command.take() {
						self.run_command(&mut command, matcher_io);
					}
				}
			}

			fn has_side_effects(&self) -> bool {
				true
			}
		}
	}
	pub mod fs {


		#[cfg(unix)]
		use std::{cell::RefCell, io, io::Write, path::Path};

		use super::{Matcher, MatcherIO, WalkEntry};


		#[cfg(unix)]
		pub struct Cache {
			dev_id:  String,
			fs_type: String,
		}


		#[cfg(unix)]
		pub fn get_file_system_type(
			path: &Path,
			cache: &RefCell<Option<Cache>>,
		) -> io::Result<String> {
			use std::os::unix::fs::MetadataExt;


			let dev_id = path.symlink_metadata()?.dev().to_string();

			if let Some(cache) = cache.borrow().as_ref()
				&& cache.dev_id == dev_id
			{
				return Ok(cache.fs_type.clone());
			}


			let fs_list = uucore::fsext::read_fs_list().map_err(|err| io::Error::other(err.to_string()))?;
			let result = fs_list
				.into_iter()
				.find(|fs| fs.dev_id == dev_id)
				.map_or_else(String::new, |fs| fs.fs_type);


			cache.replace(Some(Cache { dev_id, fs_type: result.clone() }));

			Ok(result)
		}


		pub struct FileSystemMatcher {
			#[cfg(unix)]
			fs_text: String,
			#[cfg(unix)]
			cache:   RefCell<Option<Cache>>,
		}

		impl FileSystemMatcher {
			#[cfg(unix)]
			pub fn new(fs_text: String) -> Self {
				Self { fs_text, cache: RefCell::new(None) }
			}

			#[cfg(not(unix))]
			pub fn new(_fs_text: String) -> Self {
				Self {}
			}
		}

		impl Matcher for FileSystemMatcher {
			#[cfg(unix)]
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				match get_file_system_type(file_info.path(), &self.cache) {
					Ok(result) => result == self.fs_text,
					Err(_) => {
						writeln!(
							&mut matcher_io.host().stderr,
							"Error getting filesystem type for {}",
							file_info.path().to_string_lossy()
						)
						.unwrap();

						false
					},
				}
			}

			#[cfg(not(unix))]
			fn matches(&self, _file_info: &WalkEntry, _matcher_io: &mut MatcherIO) -> bool {
				false
			}
		}
	}
	mod glob {
		// Copyright 2022 Tavian Barnes


		use onig::{Regex, RegexOptions, Syntax};


		fn parse_bre(expr: &str, options: RegexOptions) -> Result<Regex, onig::Error> {
			let bre = Syntax::posix_basic();
			Regex::with_options(expr, bre.options() | options, bre)
		}


		fn regex_push_literal(regex: &mut String, ch: char) {

			if matches!(ch, '.' | '[' | '\\' | '*' | '^' | '$') {
				regex.push('\\');
			}
			regex.push(ch);
		}


		fn extract_bracket_expr(pattern: &str) -> Option<(String, &str)> {


			let mut expr = "[".to_string();

			let mut chars = pattern.chars();
			let mut next = chars.next();


			if next == Some('!') {
				expr.push('^');
				next = chars.next();
			}


			if next == Some(']') {
				expr.push(']');
				next = chars.next();
			}

			while let Some(ch) = next {
				expr.push(ch);

				match ch {
					'[' => {


						next = chars.next();
						if let Some(delim) = next {
							expr.push(delim);

							if matches!(delim, '.' | '=' | ':') {
								let rest = chars.as_str();
								let end = rest.find([delim, ']'])? + 2;
								expr.push_str(&rest[..end]);
								chars = rest[end..].chars();
							}
						}
					},
					']' => {


						break;
					},
					_ => {},
				}

				next = chars.next();
			}

			if parse_bre(&expr, RegexOptions::REGEX_OPTION_NONE).is_ok() {
				Some((expr, chars.as_str()))
			} else {
				None
			}
		}


		fn glob_to_regex(pattern: &str) -> Option<String> {
			let mut regex = String::new();

			let mut chars = pattern.chars();
			while let Some(ch) = chars.next() {

				match ch {
					'?' => regex.push('.'),
					'*' => regex.push_str(".*"),
					'\\' => {
						let ch = chars.next()?;
						regex_push_literal(&mut regex, ch);
					},
					'[' => {
						if let Some((expr, rest)) = extract_bracket_expr(chars.as_str()) {
							regex.push_str(&expr);
							chars = rest.chars();
						} else {
							regex_push_literal(&mut regex, ch);
						}
					},
					_ => regex_push_literal(&mut regex, ch),
				}
			}

			Some(regex)
		}


		pub struct Pattern {
			regex: Option<Regex>,
		}

		impl Pattern {

			pub fn new(pattern: &str, caseless: bool) -> Self {
				let options = if caseless {
					RegexOptions::REGEX_OPTION_IGNORECASE
				} else {
					RegexOptions::REGEX_OPTION_NONE
				};


				let regex = glob_to_regex(pattern).map(|r| parse_bre(&r, options).unwrap());
				Self { regex }
			}


			pub fn matches(&self, string: &str) -> bool {
				self.regex.as_ref().is_some_and(|r| r.is_match(string))
			}
		}
	}
	mod group {


		#[cfg(unix)]
		use std::os::unix::fs::MetadataExt;

		#[cfg(unix)]
		use nix::unistd::Group;

		use super::{ComparableValue, Matcher, MatcherIO, WalkEntry};

		pub struct GroupMatcher {
			#[cfg_attr(not(unix), allow(dead_code))]
			gid: ComparableValue,
		}

		impl GroupMatcher {
			#[cfg(unix)]
			pub fn from_group_name(group: &str) -> Option<Self> {

				let group = Group::from_name(group).ok()??;
				let gid = group.gid.as_raw();
				Some(Self::from_gid(gid))
			}

			pub fn from_gid(gid: u32) -> Self {
				Self::from_comparable(ComparableValue::EqualTo(gid as u64))
			}

			pub fn from_comparable(gid: ComparableValue) -> Self {
				Self { gid }
			}

		}

		impl Matcher for GroupMatcher {
			#[cfg(unix)]
			fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
				match file_info.metadata() {
					Ok(metadata) => self.gid.matches(metadata.gid().into()),
					Err(_) => false,
				}
			}

		}

		pub struct NoGroupMatcher {}

		impl Matcher for NoGroupMatcher {
			#[cfg(unix)]
			fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
				use nix::unistd::Gid;

				if file_info.path().is_symlink() {
					return false;
				}

				let Ok(metadata) = file_info.metadata() else {
					return true;
				};

				let Ok(gid) = Group::from_gid(Gid::from_raw(metadata.gid())) else {
					return true;
				};

				let Some(_group) = gid else {
					return true;
				};

				false
			}

		}
	}
	mod lname {
		// Copyright 2017 Google Inc.


		use std::{io::Write, path::PathBuf};


		use super::{Matcher, MatcherIO, WalkEntry, glob::Pattern};

		fn read_link_target(file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> Option<PathBuf> {
			match file_info.path().read_link() {
				Ok(target) => Some(target),
				Err(err) => {


					if err.kind() != std::io::ErrorKind::InvalidInput {
						writeln!(
							&mut matcher_io.host().stderr,
							"Error reading target of {}: {}",
							file_info.path().display(),
							err
						)
						.unwrap();
					}

					None
				},
			}
		}


		pub struct LinkNameMatcher {
			pattern: Pattern,
		}

		impl LinkNameMatcher {
			pub fn new(pattern_string: &str, caseless: bool) -> Self {
				let pattern = Pattern::new(pattern_string, caseless);
				Self { pattern }
			}
		}

		impl Matcher for LinkNameMatcher {
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				if let Some(target) = read_link_target(file_info, matcher_io) {
					self.pattern.matches(&target.to_string_lossy())
				} else {
					false
				}
			}
		}
	}
	mod logical_matchers {
		// Copyright 2017 Google Inc.


		use std::{error::Error, path::Path};

		use super::{Matcher, MatcherIO, WalkEntry};


		pub struct AndMatcher {
			submatchers: Vec<Box<dyn Matcher>>,
		}

		impl AndMatcher {
			pub fn new(submatchers: Vec<Box<dyn Matcher>>) -> Self {
				Self { submatchers }
			}
		}

		impl Matcher for AndMatcher {


			fn matches(&self, dir_entry: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				for matcher in &self.submatchers {
					if !matcher.matches(dir_entry, matcher_io) {
						return false;
					}
					if matcher_io.should_quit() {
						break;
					}
				}

				true
			}

			fn has_side_effects(&self) -> bool {
				self
					.submatchers
					.iter()
					.any(super::Matcher::has_side_effects)
			}

			fn finished_dir(&self, dir: &Path, matcher_io: &mut MatcherIO) {
				for m in &self.submatchers {
					m.finished_dir(dir, matcher_io);
				}
			}

			fn finished(&self, matcher_io: &mut MatcherIO) {
				for m in &self.submatchers {
					m.finished(matcher_io);
				}
			}
		}

		pub struct AndMatcherBuilder {
			submatchers: Vec<Box<dyn Matcher>>,
		}

		impl AndMatcherBuilder {
			pub fn new() -> Self {
				Self { submatchers: Vec::new() }
			}

			pub fn new_and_condition(&mut self, matcher: impl Matcher) {
				self.submatchers.push(matcher.into_box());
			}


			pub fn build(mut self) -> Box<dyn Matcher> {

				if self.submatchers.len() == 1 {

					return self.submatchers.pop().unwrap();
				}
				AndMatcher::new(self.submatchers).into_box()
			}
		}


		pub struct OrMatcher {
			submatchers: Vec<Box<dyn Matcher>>,
		}

		impl OrMatcher {
			pub fn new(submatchers: Vec<Box<dyn Matcher>>) -> Self {
				Self { submatchers }
			}
		}

		impl Matcher for OrMatcher {


			fn matches(&self, dir_entry: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				for matcher in &self.submatchers {
					if matcher.matches(dir_entry, matcher_io) {
						return true;
					}
					if matcher_io.should_quit() {
						break;
					}
				}

				false
			}

			fn has_side_effects(&self) -> bool {
				self
					.submatchers
					.iter()
					.any(super::Matcher::has_side_effects)
			}

			fn finished_dir(&self, dir: &Path, matcher_io: &mut MatcherIO) {
				for m in &self.submatchers {
					m.finished_dir(dir, matcher_io);
				}
			}

			fn finished(&self, matcher_io: &mut MatcherIO) {
				for m in &self.submatchers {
					m.finished(matcher_io);
				}
			}
		}

		pub struct OrMatcherBuilder {
			submatchers: Vec<AndMatcherBuilder>,
		}

		impl OrMatcherBuilder {
			pub fn new_and_condition(&mut self, matcher: impl Matcher) {

				self
					.submatchers
					.last_mut()
					.unwrap()
					.new_and_condition(matcher);
			}

			pub fn new_or_condition(&mut self, arg: &str) -> Result<(), Box<dyn Error>> {
				if self.submatchers.last().unwrap().submatchers.is_empty() {
					return Err(From::from(format!(
						"invalid expression; you have used a binary operator '{arg}' with nothing before it."
					)));
				}
				self.submatchers.push(AndMatcherBuilder::new());
				Ok(())
			}

			pub fn new() -> Self {
				let mut o = Self { submatchers: Vec::new() };
				o.submatchers.push(AndMatcherBuilder::new());
				o
			}


			pub fn build(mut self) -> Box<dyn Matcher> {

				if self.submatchers.len() == 1 {

					return self.submatchers.pop().unwrap().build();
				}
				let mut submatchers = vec![];
				for x in self.submatchers {
					submatchers.push(x.build());
				}
				OrMatcher::new(submatchers).into_box()
			}
		}


		pub struct ListMatcher {
			submatchers: Vec<Box<dyn Matcher>>,
		}

		impl ListMatcher {
			pub fn new(submatchers: Vec<Box<dyn Matcher>>) -> Self {
				Self { submatchers }
			}
		}

		impl Matcher for ListMatcher {


			fn matches(&self, dir_entry: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				let mut rc = false;
				for matcher in &self.submatchers {
					rc = matcher.matches(dir_entry, matcher_io);
					if matcher_io.should_quit() {
						break;
					}
				}
				rc
			}

			fn has_side_effects(&self) -> bool {
				self
					.submatchers
					.iter()
					.any(super::Matcher::has_side_effects)
			}

			fn finished_dir(&self, dir: &Path, matcher_io: &mut MatcherIO) {
				for m in &self.submatchers {
					m.finished_dir(dir, matcher_io);
				}
			}

			fn finished(&self, matcher_io: &mut MatcherIO) {
				for m in &self.submatchers {
					m.finished(matcher_io);
				}
			}
		}

		pub struct ListMatcherBuilder {
			submatchers: Vec<OrMatcherBuilder>,
		}

		impl ListMatcherBuilder {
			pub fn new_and_condition(&mut self, matcher: impl Matcher) {

				self
					.submatchers
					.last_mut()
					.unwrap()
					.new_and_condition(matcher);
			}

			pub fn new_or_condition(&mut self, arg: &str) -> Result<(), Box<dyn Error>> {
				self.submatchers.last_mut().unwrap().new_or_condition(arg)
			}

			pub fn check_new_and_condition(&mut self) -> Result<(), Box<dyn Error>> {
				{
					let child_or_matcher = &self.submatchers.last().unwrap();
					let grandchild_and_matcher = &child_or_matcher.submatchers.last().unwrap();

					if grandchild_and_matcher.submatchers.is_empty() {
						return Err(From::from(
							"invalid expression; you have used a binary operator '-a' with nothing before it.",
						));
					}
				}
				Ok(())
			}

			pub fn new_list_condition(&mut self) -> Result<(), Box<dyn Error>> {
				{
					let child_or_matcher = &self.submatchers.last().unwrap();
					let grandchild_and_matcher = &child_or_matcher.submatchers.last().unwrap();

					if grandchild_and_matcher.submatchers.is_empty() {
						return Err(From::from(
							"invalid expression; you have used a binary operator ',' with nothing before it.",
						));
					}
				}
				self.submatchers.push(OrMatcherBuilder::new());
				Ok(())
			}

			pub fn new() -> Self {
				let mut o = Self { submatchers: Vec::new() };
				o.submatchers.push(OrMatcherBuilder::new());
				o
			}


			pub fn build(mut self) -> Box<dyn Matcher> {

				if self.submatchers.len() == 1 {

					return self.submatchers.pop().unwrap().build();
				}
				let mut submatchers = vec![];
				for x in self.submatchers {
					submatchers.push(x.build());
				}
				Box::new(ListMatcher::new(submatchers))
			}
		}


		pub struct TrueMatcher;

		impl Matcher for TrueMatcher {
			fn matches(&self, _dir_entry: &WalkEntry, _: &mut MatcherIO) -> bool {
				true
			}
		}


		pub struct FalseMatcher;

		impl Matcher for FalseMatcher {
			fn matches(&self, _dir_entry: &WalkEntry, _: &mut MatcherIO) -> bool {
				false
			}
		}


		pub struct NotMatcher {
			submatcher: Box<dyn Matcher>,
		}

		impl NotMatcher {
			pub fn new(submatcher: impl Matcher) -> Self {
				Self { submatcher: submatcher.into_box() }
			}
		}

		impl Matcher for NotMatcher {
			fn matches(&self, dir_entry: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				!self.submatcher.matches(dir_entry, matcher_io)
			}

			fn has_side_effects(&self) -> bool {
				self.submatcher.has_side_effects()
			}

			fn finished_dir(&self, dir: &Path, matcher_io: &mut MatcherIO) {
				self.submatcher.finished_dir(dir, matcher_io);
			}

			fn finished(&self, matcher_io: &mut MatcherIO) {
				self.submatcher.finished(matcher_io);
			}
		}
	}
	mod ls {


		use std::{fs::File, io::Write};

		use chrono::DateTime;

		use super::{Matcher, MatcherIO, WalkEntry};

		#[cfg(unix)]
		fn format_permissions(mode: uucore::libc::mode_t) -> String {
			let file_type = match mode & (uucore::libc::S_IFMT as uucore::libc::mode_t) {
				uucore::libc::S_IFDIR => "d",
				uucore::libc::S_IFREG => "-",
				_ => "?",
			};


			let user_perms = format!(
				"{}{}{}",
				if mode & uucore::libc::S_IRUSR != 0 {
					"r"
				} else {
					"-"
				},
				if mode & uucore::libc::S_IWUSR != 0 {
					"w"
				} else {
					"-"
				},
				if mode & uucore::libc::S_IXUSR != 0 {
					"x"
				} else {
					"-"
				}
			);


			let group_perms = format!(
				"{}{}{}",
				if mode & uucore::libc::S_IRGRP != 0 {
					"r"
				} else {
					"-"
				},
				if mode & uucore::libc::S_IWGRP != 0 {
					"w"
				} else {
					"-"
				},
				if mode & uucore::libc::S_IXGRP != 0 {
					"x"
				} else {
					"-"
				}
			);


			let other_perms = format!(
				"{}{}{}",
				if mode & uucore::libc::S_IROTH != 0 {
					"r"
				} else {
					"-"
				},
				if mode & uucore::libc::S_IWOTH != 0 {
					"w"
				} else {
					"-"
				},
				if mode & uucore::libc::S_IXOTH != 0 {
					"x"
				} else {
					"-"
				}
			);

			format!("{}{}{}{}", file_type, user_perms, group_perms, other_perms)
		}


		pub struct Ls {
			output_file: Option<File>,
		}

		impl Ls {
			pub fn new(output_file: Option<File>) -> Self {
				Self { output_file }
			}

			#[cfg(unix)]
			fn print(
				&self,
				file_info: &WalkEntry,
				matcher_io: &mut MatcherIO,
				mut out: impl Write,
				print_error_message: bool,
			) {
				use std::os::unix::fs::{MetadataExt, PermissionsExt};

				use nix::unistd::{Gid, Group, Uid, User};

				let metadata = file_info.metadata().unwrap();

				let inode_number = metadata.ino();
				let number_of_blocks = {
					let size = metadata.size();
					let number_of_blocks = size / 1024;
					let remainder = number_of_blocks % 4;

					if remainder == 0 {
						if number_of_blocks == 0 {
							4
						} else {
							number_of_blocks
						}
					} else {
						number_of_blocks + (4 - (remainder))
					}
				};
				let permission =
					{ format_permissions(metadata.permissions().mode() as uucore::libc::mode_t) };
				let hard_links = metadata.nlink();
				let user = {
					let uid = metadata.uid();
					User::from_uid(Uid::from_raw(uid)).unwrap().unwrap().name
				};
				let group = {
					let gid = metadata.gid();
					Group::from_gid(Gid::from_raw(gid)).unwrap().unwrap().name
				};
				let size = metadata.size();
				let last_modified = {
					let system_time = metadata.modified().unwrap();
					let now_utc: DateTime<chrono::Utc> = system_time.into();
					now_utc.format("%b %e %H:%M")
				};
				let path = file_info.display_path().to_string_lossy();

				match writeln!(
					out,
					" {:<4} {:>6} {:<10} {:>3} {:<8} {:<8} {:>8} {} {}",
					inode_number,
					number_of_blocks,
					permission,
					hard_links,
					user,
					group,
					size,
					last_modified,
					path,
				) {
					Ok(_) => {},
					Err(e) => {
						if print_error_message {
							writeln!(
								&mut matcher_io.host().stderr,
								"Error writing {:?} for {}",
								file_info.display_path().to_string_lossy(),
								e
							)
							.unwrap();
							matcher_io.set_exit_code(1);
						}
					},
				}
			}

		}

		impl Matcher for Ls {
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				if let Some(file) = &self.output_file {
					self.print(file_info, matcher_io, file, true);
				} else {
					self.print(file_info, matcher_io, &mut *matcher_io.deps.get_output().borrow_mut(), false);
				}
				true
			}

			fn has_side_effects(&self) -> bool {
				true
			}
		}
	}
	mod name {
		// Copyright 2017 Google Inc.


		use super::{Matcher, MatcherIO, WalkEntry, glob::Pattern};


		pub struct NameMatcher {
			pattern: Pattern,
		}

		impl NameMatcher {
			pub fn new(pattern_string: &str, caseless: bool) -> Self {
				let pattern = Pattern::new(pattern_string, caseless);
				Self { pattern }
			}
		}

		impl Matcher for NameMatcher {
			fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
				let name = file_info.file_name().to_string_lossy();

				#[cfg(unix)]
				if name.len() > 1 && name.chars().all(|x| x == '/') {
					self.pattern.matches("/")
				} else {
					self.pattern.matches(&name)
				}

			}
		}
	}
	mod path {
		// Copyright 2017 Google Inc.


		use super::{Matcher, MatcherIO, WalkEntry, glob::Pattern};


		pub struct PathMatcher {
			pattern: Pattern,
		}

		impl PathMatcher {
			pub fn new(pattern_string: &str, caseless: bool) -> Self {
				let pattern = Pattern::new(pattern_string, caseless);
				Self { pattern }
			}
		}

		impl Matcher for PathMatcher {
			fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
				let path = file_info.display_path().to_string_lossy();
				self.pattern.matches(&path)
			}
		}
	}
	mod perm {
		// Copyright 2017 Google Inc.


		use std::{error::Error, io::Write};

		#[cfg(unix)]
		use uucore::mode::{parse_numeric, parse_symbolic};

		use super::{Matcher, MatcherIO, WalkEntry};

		#[derive(Clone, Copy, Debug, Eq, PartialEq)]
		#[cfg(unix)]
		pub enum ComparisonType {

			Exact,

			AtLeast,


			AnyOf,
		}

		#[cfg(unix)]
		impl ComparisonType {
			fn mode_bits_match(self, pattern: u32, value: u32) -> bool {
				match self {
					Self::Exact => (0o7777 & value) == pattern,
					Self::AtLeast => (value & pattern) == pattern,
					Self::AnyOf => pattern == 0 || (value & pattern) > 0,
				}
			}
		}

		#[cfg(unix)]
		mod parsing {
			use super::{ComparisonType, Error, parse_numeric, parse_symbolic};

			pub fn split_comparison_type(pattern: &str) -> (ComparisonType, &str) {
				let mut chars = pattern.chars();

				match chars.next() {
					Some('-') => (ComparisonType::AtLeast, chars.as_str()),


					Some('/') | Some('+') => (ComparisonType::AnyOf, chars.as_str()),
					_ => (ComparisonType::Exact, pattern),
				}
			}

			pub fn parse_mode(pattern: &str, for_dir: bool) -> Result<u32, Box<dyn Error>> {
				let mode = if pattern.contains(|c: char| c.is_ascii_digit()) {
					parse_numeric(0, pattern, for_dir)?
				} else {
					let mut mode = 0;
					for chunk in pattern.split(',') {
						mode = parse_symbolic(mode, chunk, 0, for_dir)?;
					}
					mode
				};
				Ok(mode)
			}
		}

		#[cfg(unix)]
		#[derive(Debug)]
		pub struct PermMatcher {
			comparison_type: ComparisonType,
			file_pattern:    u32,
			dir_pattern:     u32,
		}

		#[cfg(not(unix))]
		pub struct PermMatcher {}

		impl PermMatcher {
			#[cfg(unix)]
			pub fn new(pattern: &str) -> Result<Self, Box<dyn Error>> {
				let (comparison_type, pattern) = parsing::split_comparison_type(pattern);
				let file_pattern = parsing::parse_mode(pattern, false)?;
				let dir_pattern = parsing::parse_mode(pattern, true)?;
				Ok(Self { comparison_type, file_pattern, dir_pattern })
			}

			#[cfg(not(unix))]
			pub fn new(_dummy_pattern: &str) -> Result<PermMatcher, Box<dyn Error>> {
				Err(From::from("Permission matching is not available on this platform"))
			}
		}

		impl Matcher for PermMatcher {
			#[cfg(unix)]
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				use std::os::unix::fs::PermissionsExt;
				match file_info.metadata() {
					Ok(metadata) => {
						let pattern = if metadata.is_dir() {
							self.dir_pattern
						} else {
							self.file_pattern
						};
						self
							.comparison_type
							.mode_bits_match(pattern, metadata.permissions().mode())
					},
					Err(e) => {
						writeln!(
							&mut matcher_io.host().stderr,
							"Error getting permissions for {}: {}",
							file_info.path().to_string_lossy(),
							e
						)
						.unwrap();
						false
					},
				}
			}

			#[cfg(not(unix))]
			fn matches(&self, _dummy_file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				writeln!(&mut matcher_io.host().stderr, "Permission matching not available on this platform!").unwrap();
				return false;
			}
		}
	}
	mod printer {
		// Copyright 2017 Google Inc.


		use std::{fs::File, io::Write};


		use super::{Matcher, MatcherIO, WalkEntry};

		pub enum PrintDelimiter {
			Newline,
			Null,
		}

		impl std::fmt::Display for PrintDelimiter {
			fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
				match self {
					Self::Newline => writeln!(f),
					Self::Null => write!(f, "\0"),
				}
			}
		}


		pub struct Printer {
			delimiter:   PrintDelimiter,
			output_file: Option<File>,
		}

		impl Printer {
			pub fn new(delimiter: PrintDelimiter, output_file: Option<File>) -> Self {
				Self { delimiter, output_file }
			}

			fn print(
				&self,
				file_info: &WalkEntry,
				matcher_io: &mut MatcherIO,
				mut out: impl Write,
				print_error_message: bool,
			) {
				match write!(out, "{}{}", file_info.display_path().to_string_lossy(), self.delimiter) {
					Ok(_) => {},
					Err(e) => {
						if print_error_message {
							writeln!(
								&mut matcher_io.host().stderr,
								"Error writing {:?} for {}",
								file_info.display_path().to_string_lossy(),
								e
							)
							.unwrap();
							matcher_io.set_exit_code(1);
						}
					},
				}
				out.flush().unwrap();
			}
		}

		impl Matcher for Printer {
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				if let Some(file) = &self.output_file {
					self.print(file_info, matcher_io, file, true);
				} else {
					self.print(file_info, matcher_io, &mut *matcher_io.deps.get_output().borrow_mut(), false);
				}
				true
			}

			fn has_side_effects(&self) -> bool {
				true
			}
		}
	}
	mod printf {
		// Copyright 2021 Collabora, Ltd.


		#[cfg(unix)]
		use std::os::unix::prelude::MetadataExt;
		use std::{
			borrow::Cow,
			error::Error,
			fs::{self, File},
			io::Write,
			path::Path,
			time::SystemTime,
		};

		use chrono::{DateTime, Local, format::StrftimeItems};

		use super::{FileType, Matcher, MatcherIO, WalkEntry, WalkError};

		const STANDARD_BLOCK_SIZE: u64 = 512;

		#[derive(Debug, PartialEq, Eq)]
		enum Justify {
			Left,
			Right,
		}

		#[derive(Debug, PartialEq, Eq)]
		enum TimeFormat {

			Ctime,

			SinceEpoch,

			Strftime(String),
		}

		impl TimeFormat {
			fn apply(&self, time: SystemTime) -> Result<Cow<'static, str>, Box<dyn Error>> {
				let formatted = match self {
					Self::SinceEpoch => {
						let duration = time.duration_since(SystemTime::UNIX_EPOCH)?;
						format!("{}.{:09}0", duration.as_secs(), duration.subsec_nanos())
					},
					Self::Ctime => {
						const CTIME_FORMAT: &str = "%a %b %d %H:%M:%S.%f0 %Y";

						DateTime::<Local>::from(time)
							.format(CTIME_FORMAT)
							.to_string()
					},
					Self::Strftime(format) => {

						let custom_format = format.replace("%+", "%Y-%m-%d+%H:%M:%S%.f0");
						DateTime::<Local>::from(time)
							.format(&custom_format)
							.to_string()
					},
				};

				Ok(formatted.into())
			}
		}

		#[derive(Debug, PartialEq, Eq)]
		enum PermissionsFormat {
			Octal,

			Symbolic,
		}


		#[derive(Debug, PartialEq, Eq)]
		enum FormatDirective {

			AccessTime(TimeFormat),

			Blocks { large_blocks: bool },

			ChangeTime(TimeFormat),

			Depth,

			Device,

			Basename,

			Filesystem,

			Group { as_name: bool },

			Dirname,

			StartingPoint,

			Inode,

			SymlinkTarget,

			Permissions(PermissionsFormat),

			HardlinkCount,

			Path { strip_starting_point: bool },

			Size,

			Sparseness,

			ModificationTime(TimeFormat),

			User { as_name: bool },

			Type { follow_links: bool },
		}


		#[derive(Debug, PartialEq, Eq)]
		enum FormatComponent {
			Literal(String),
			Flush,
			Directive { directive: FormatDirective, width: Option<usize>, justify: Justify },
		}

		struct FormatStringParser<'a> {
			string: &'a str,
		}

		impl FormatStringParser<'_> {
			fn front(&self) -> Result<char, Box<dyn Error>> {
				self
					.string
					.chars()
					.next()
					.ok_or_else(|| "Unexpected EOF".into())
			}

			fn peek(&self, count: usize) -> Result<&str, Box<dyn Error>> {
				if self.string.len() < count {
					return Err("Unexpected EOF".into());
				}

				Ok(&self.string[0..count])
			}

			fn advance_one(&mut self) -> Result<char, Box<dyn Error>> {
				let c = self.front()?;
				self.string = &self.string[1..];
				Ok(c)
			}

			fn advance_by(&mut self, count: usize) -> Result<&str, Box<dyn Error>> {
				self.peek(count)?;

				let skipped = &self.string[0..count];
				self.string = &self.string[count..];
				Ok(skipped)
			}

			fn parse_escape_sequence(&mut self) -> Result<FormatComponent, Box<dyn Error>> {
				const OCTAL_LEN: usize = 3;
				const OCTAL_RADIX: u32 = 8;


				let first = self.front()?;
				if first.is_digit(OCTAL_RADIX)
					&& let Ok(code) = self.peek(OCTAL_LEN).and_then(|octal| {
						u32::from_str_radix(octal, OCTAL_RADIX).map_err(std::convert::Into::into)
					}) {

					let octal = self.advance_by(OCTAL_LEN).unwrap();
					return match char::from_u32(code) {
						Some(c) => Ok(FormatComponent::Literal(c.to_string())),
						None => Err(format!("Invalid character value: \\{octal}").into()),
					};
				}

				self.advance_one()?;

				if first == 'c' {
					Ok(FormatComponent::Flush)
				} else {
					let c = match first {
						'a' => "\x07",
						'b' => "\x08",
						'f' => "\x0C",
						'n' => "\n",
						'r' => "\r",
						't' => "\t",
						'v' => "\x0B",
						'0' => "\0",
						'\\' => "\\",
						c => return Err(format!("Invalid escape sequence: \\{c}").into()),
					};

					Ok(FormatComponent::Literal(c.to_string()))
				}
			}

			fn parse_format_width(&mut self) -> Option<usize> {
				let start = self.string;
				let mut digits = 0;

				while self.front().map(|c| c.is_ascii_digit()).unwrap_or(false) {
					digits += 1;

					self.advance_one().unwrap();
				}

				if digits > 0 {


					Some((start[0..digits]).parse().unwrap())
				} else {
					None
				}
			}

			fn parse_time_specifier(&mut self, first: char) -> Result<TimeFormat, Box<dyn Error>> {
				match self.advance_one()? {
					'@' => Ok(TimeFormat::SinceEpoch),
					'S' => Ok(TimeFormat::Strftime("%S.%f0".to_string())),
					c => {


						let format = format!("%{c}");
						match StrftimeItems::new(&format).next() {
							None | Some(chrono::format::Item::Error) => {
								Err(format!("Invalid time specifier: %{first}{c}").into())
							},
							Some(_item) => Ok(TimeFormat::Strftime(format)),
						}
					},
				}
			}

			fn parse_format_specifier(&mut self) -> Result<FormatComponent, Box<dyn Error>> {
				let mut justify = Justify::Right;
				loop {
					match self.front()? {
						' ' => (),
						'-' => justify = Justify::Left,
						_ => break,
					}


					self.advance_one().unwrap();
				}

				let width = self.parse_format_width();

				let first = self.advance_one()?;
				if first == '%' {
					return Ok(FormatComponent::Literal("%".to_owned()));
				}

				let directive = match first {
					'a' => FormatDirective::AccessTime(TimeFormat::Ctime),
					'A' => FormatDirective::AccessTime(self.parse_time_specifier(first)?),
					'b' => FormatDirective::Blocks { large_blocks: false },
					'c' => FormatDirective::ChangeTime(TimeFormat::Ctime),
					'C' => FormatDirective::ChangeTime(self.parse_time_specifier(first)?),
					'd' => FormatDirective::Depth,
					'D' => FormatDirective::Device,
					'f' => FormatDirective::Basename,
					'F' => FormatDirective::Filesystem,
					'g' => FormatDirective::Group { as_name: true },
					'G' => FormatDirective::Group { as_name: false },
					'h' => FormatDirective::Dirname,
					'H' => FormatDirective::StartingPoint,
					'k' => FormatDirective::Blocks { large_blocks: true },
					'i' => FormatDirective::Inode,
					'l' => FormatDirective::SymlinkTarget,
					'm' => FormatDirective::Permissions(PermissionsFormat::Octal),
					'M' => FormatDirective::Permissions(PermissionsFormat::Symbolic),
					'n' => FormatDirective::HardlinkCount,
					'p' => FormatDirective::Path { strip_starting_point: false },
					'P' => FormatDirective::Path { strip_starting_point: true },
					's' => FormatDirective::Size,
					'S' => FormatDirective::Sparseness,
					't' => FormatDirective::ModificationTime(TimeFormat::Ctime),
					'T' => FormatDirective::ModificationTime(self.parse_time_specifier(first)?),
					'u' => FormatDirective::User { as_name: true },
					'U' => FormatDirective::User { as_name: false },
					'y' => FormatDirective::Type { follow_links: false },
					'Y' => FormatDirective::Type { follow_links: true },

					_ => return Ok(FormatComponent::Literal(first.to_string())),
				};

				Ok(FormatComponent::Directive { directive, width, justify })
			}

			pub fn parse(&mut self) -> Result<FormatString, Box<dyn Error>> {
				let mut components = vec![];

				while let Some(i) = self.string.find(['%', '\\']) {
					if i > 0 {


						let literal = self.advance_by(i).unwrap();
						if !literal.is_empty() {
							components.push(FormatComponent::Literal(literal.to_owned()));
						}
					}


					let component = match self.advance_one().unwrap() {
						'\\' => self.parse_escape_sequence()?,
						'%' => self.parse_format_specifier()?,
						_ => panic!("{}", "Stopped at unexpected character: {self.string}"),
					};
					components.push(component);
				}

				if !self.string.is_empty() {
					components.push(FormatComponent::Literal(self.string.to_owned()));
				}

				Ok(FormatString { components })
			}
		}

		struct FormatString {
			components: Vec<FormatComponent>,
		}

		impl FormatString {
			fn parse(string: &str) -> Result<Self, Box<dyn Error>> {
				FormatStringParser { string }.parse()
			}
		}

		fn get_starting_point(file_info: &WalkEntry) -> &Path {
			file_info
				.display_path()
				.ancestors()
				.nth(file_info.depth())


				.unwrap()
		}

		fn format_non_link_file_type(file_type: FileType) -> char {
			match file_type {
				FileType::Regular => 'f',
				FileType::Directory => 'd',
				FileType::BlockDevice => 'b',
				FileType::CharDevice => 'c',
				FileType::Fifo => 'p',
				FileType::Socket => 's',
				_ => 'U',
			}
		}

		fn format_directive<'entry>(
			file_info: &'entry WalkEntry,
			directive: &FormatDirective,
		) -> Result<Cow<'entry, str>, Box<dyn Error>> {
			let meta = || file_info.metadata();


			let res: Cow<'entry, str> = match directive {
				FormatDirective::AccessTime(tf) => tf.apply(meta()?.accessed()?)?,

				FormatDirective::Basename => file_info.file_name().to_string_lossy(),

				FormatDirective::Blocks { large_blocks } => {
					#[cfg(unix)]
					let blocks = meta()?.blocks();
					#[cfg(not(unix))]

					let blocks = (meta()?.len() + STANDARD_BLOCK_SIZE - 1) / STANDARD_BLOCK_SIZE;


					if *large_blocks {

						blocks.div_ceil(2)
					} else {
						blocks
					}
					.to_string()
					.into()
				},

				#[cfg(not(unix))]
				FormatDirective::ChangeTime(tf) => tf.apply(meta()?.modified()?)?,
				#[cfg(unix)]
				FormatDirective::ChangeTime(tf) => {
					use std::time::Duration;

					let meta = meta()?;
					let ctime = SystemTime::UNIX_EPOCH
						+ Duration::from_secs(meta.ctime() as u64)
						+ Duration::from_nanos(meta.ctime_nsec() as u64);
					tf.apply(ctime)?
				},

				FormatDirective::Depth => file_info.depth().to_string().into(),

				#[cfg(not(unix))]
				FormatDirective::Device => "0".into(),
				#[cfg(unix)]
				FormatDirective::Device => meta()?.dev().to_string().into(),


				FormatDirective::Dirname => match file_info.display_path().parent() {
					None => "".into(),
					Some(p) if p == Path::new("/") => "".into(),
					Some(p) if p == Path::new("") => ".".into(),
					Some(parent) => parent.to_string_lossy(),
				},

				#[cfg(not(unix))]
				FormatDirective::Filesystem => "".into(),
				#[cfg(unix)]
				FormatDirective::Filesystem => {
					let dev_id = meta()?.dev().to_string();
					let fs_list = uucore::fsext::read_fs_list().expect("Could not find the filesystem info");
					fs_list
						.into_iter()
						.find(|fs| fs.dev_id == dev_id)
						.map_or_else(String::new, |fs| fs.fs_type)
						.into()
				},

				#[cfg(not(unix))]
				FormatDirective::Group { .. } => "0".into(),
				#[cfg(unix)]
				FormatDirective::Group { as_name } => {
					let gid = meta()?.gid();
					if *as_name {
						uucore::entries::gid2grp(gid).unwrap_or_else(|_| gid.to_string())
					} else {
						gid.to_string()
					}
					.into()
				},

				#[cfg(not(unix))]
				FormatDirective::HardlinkCount => "0".into(),
				#[cfg(unix)]
				FormatDirective::HardlinkCount => meta()?.nlink().to_string().into(),

				#[cfg(not(unix))]
				FormatDirective::Inode => "0".into(),
				#[cfg(unix)]
				FormatDirective::Inode => meta()?.ino().to_string().into(),

				FormatDirective::ModificationTime(tf) => tf.apply(meta()?.modified()?)?,

				FormatDirective::Path { strip_starting_point } => file_info
					.display_path()
					.strip_prefix(if *strip_starting_point {
						get_starting_point(file_info)
					} else {
						Path::new("")
					})


					.unwrap()
					.to_string_lossy(),

				FormatDirective::Permissions(PermissionsFormat::Symbolic) => {
					uucore::fs::display_permissions(meta()?, true).into()
				},
				#[cfg(not(unix))]
				FormatDirective::Permissions(PermissionsFormat::Octal) => "777".into(),
				#[cfg(unix)]
				FormatDirective::Permissions(PermissionsFormat::Octal) => {
					format!("{:>03o}", meta()?.mode() & 0o777).into()
				},

				FormatDirective::Size => meta()?.len().to_string().into(),

				#[cfg(not(unix))]
				FormatDirective::Sparseness => "1.0".into(),
				#[cfg(unix)]
				FormatDirective::Sparseness => {
					let meta = meta()?;

					if meta.len() > 0 {
						format!(
							"{:.1}",


							(meta.blocks() * STANDARD_BLOCK_SIZE) as f64 / (meta.len() as f64)
						)
						.into()
					} else {
						"1.0".into()
					}
				},

				FormatDirective::StartingPoint => get_starting_point(file_info).to_string_lossy(),

				FormatDirective::SymlinkTarget => {
					if file_info.path_is_symlink() {
						fs::read_link(file_info.path())?
							.to_string_lossy()
							.into_owned()
							.into()
					} else {
						"".into()
					}
				},

				FormatDirective::Type { follow_links } => if file_info.path_is_symlink() {
					if *follow_links {
						match file_info.path().metadata().map_err(WalkError::from) {
							Ok(meta) => format_non_link_file_type(meta.file_type().into()),
							Err(e) if e.is_not_found() => 'N',
							Err(e) if e.is_loop() => 'L',
							Err(_) => '?',
						}
					} else {
						'l'
					}
				} else {
					format_non_link_file_type(file_info.file_type())
				}
				.to_string()
				.into(),

				#[cfg(not(unix))]
				FormatDirective::User { .. } => "0".into(),
				#[cfg(unix)]
				FormatDirective::User { as_name } => {
					let uid = meta()?.uid();
					if *as_name {
						uucore::entries::uid2usr(uid).unwrap_or_else(|_| uid.to_string())
					} else {
						uid.to_string()
					}
					.into()
				},
			};

			Ok(res)
		}


		pub struct Printf {
			format:      FormatString,
			output_file: Option<File>,
		}

		impl Printf {
			pub fn new(format: &str, output_file: Option<File>) -> Result<Self, Box<dyn Error>> {
				Ok(Self { format: FormatString::parse(format)?, output_file })
			}

			fn print(&self, file_info: &WalkEntry, mut out: impl Write, mut err: impl Write) {
				for component in &self.format.components {
					match component {
						FormatComponent::Literal(literal) => write!(out, "{literal}").unwrap(),
						FormatComponent::Flush => out.flush().unwrap(),
						FormatComponent::Directive { directive, width, justify } => {
							match format_directive(file_info, directive) {
								Ok(content) => {
									if let Some(width) = width {
										match justify {
											Justify::Left => {
												write!(out, "{content:<width$}").unwrap();
											},
											Justify::Right => {
												write!(out, "{content:>width$}").unwrap();
											},
										}
									} else {
										write!(out, "{content}").unwrap();
									}
								},
								Err(e) => {
									let _ = writeln!(
										err,
										"Error processing '{}': {}",
										file_info.path().to_string_lossy(),
										e
									);
									break;
								},
							}
						},
					}
				}
			}
		}

		impl Matcher for Printf {
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				let err = matcher_io.host().stderr_clone();
				if let Some(file) = &self.output_file {
					self.print(file_info, file, err);
				} else {
					self.print(file_info, &mut *matcher_io.deps.get_output().borrow_mut(), err);
				}

				true
			}

			fn has_side_effects(&self) -> bool {
				true
			}
		}
	}
	mod prune {
		// Copyright 2017 Google Inc.


		use super::{Matcher, MatcherIO, WalkEntry};


		pub struct PruneMatcher;

		impl PruneMatcher {
			pub fn new() -> Self {
				Self {}
			}
		}

		impl Matcher for PruneMatcher {
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				if file_info.file_type().is_dir() {
					matcher_io.mark_current_dir_to_be_skipped();
				}

				true
			}
		}
	}
	mod quit {
		// Copyright 2017 Tavian Barnes


		use super::{Matcher, MatcherIO, WalkEntry};


		pub struct QuitMatcher;

		impl Matcher for QuitMatcher {
			fn matches(&self, _: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				matcher_io.quit();
				true
			}
		}
	}
	mod regex {
		// Copyright 2022 Collabora, Ltd.


		use std::{error::Error, fmt, str::FromStr};

		use onig::{Regex, RegexOptions, SearchOptions, Syntax};

		use super::{Matcher, MatcherIO, WalkEntry};

		#[derive(Debug)]
		pub struct ParseRegexTypeError(String);

		impl Error for ParseRegexTypeError {}

		impl fmt::Display for ParseRegexTypeError {
			fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
				write!(
					f,
					"Invalid regex type: {} (must be one of {})",
					self.0,
					RegexType::VALUES
						.iter()
						.map(|t| format!("'{t}'"))
						.collect::<Vec<_>>()
						.join(", ")
				)
			}
		}

		#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
		pub enum RegexType {
			#[default]
			Emacs,
			Grep,
			PosixBasic,
			PosixExtended,
		}

		impl RegexType {
			pub const VALUES: &'static [Self] =
				&[Self::Emacs, Self::Grep, Self::PosixBasic, Self::PosixExtended];
		}

		impl fmt::Display for RegexType {
			fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
				match self {
					Self::Emacs => write!(f, "emacs"),
					Self::Grep => write!(f, "grep"),
					Self::PosixBasic => write!(f, "posix-basic"),
					Self::PosixExtended => write!(f, "posix-extended"),
				}
			}
		}

		impl FromStr for RegexType {
			type Err = ParseRegexTypeError;

			fn from_str(s: &str) -> Result<Self, Self::Err> {
				match s {
					"emacs" => Ok(Self::Emacs),
					"grep" => Ok(Self::Grep),
					"posix-basic" => Ok(Self::PosixBasic),
					"posix-extended" => Ok(Self::PosixExtended),

					"ed" | "sed" => Ok(Self::PosixBasic),
					_ => Err(ParseRegexTypeError(s.to_owned())),
				}
			}
		}

		pub struct RegexMatcher {
			regex: Regex,
		}

		impl RegexMatcher {
			pub fn new(
				regex_type: RegexType,
				pattern: &str,
				ignore_case: bool,
			) -> Result<Self, Box<dyn Error>> {
				let syntax = match regex_type {
					RegexType::Emacs => Syntax::emacs(),
					RegexType::Grep => Syntax::grep(),
					RegexType::PosixBasic => Syntax::posix_basic(),
					RegexType::PosixExtended => Syntax::posix_extended(),
				};

				let regex = Regex::with_options(
					pattern,
					if ignore_case {
						RegexOptions::REGEX_OPTION_IGNORECASE
					} else {
						RegexOptions::REGEX_OPTION_NONE
					},
					syntax,
				)?;
				Ok(Self { regex })
			}
		}

		impl Matcher for RegexMatcher {
			fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
				let path = file_info.display_path().to_string_lossy();


				self
					.regex
					.match_with_options(path.as_ref(), 0, SearchOptions::SEARCH_OPTION_WHOLE_STRING, None)
					.is_some()
			}
		}
	}
	mod samefile {


		use std::{error::Error, path::Path};

		use uucore::fs::FileInformation;

		use super::{Follow, Matcher, MatcherIO, WalkEntry, WalkError};
		use crate::host::Host;

		pub struct SameFileMatcher {
			info: FileInformation,
		}


		fn get_file_info(path: &Path, follow: bool) -> Result<FileInformation, WalkError> {
			if follow {
				let result = FileInformation::from_path(path, true).map_err(WalkError::from);

				match result {
					Ok(info) => return Ok(info),
					Err(e) if !e.is_not_found() => return Err(e),
					_ => {},
				}
			}

			Ok(FileInformation::from_path(path, false)?)
		}

		impl SameFileMatcher {
			pub fn new(path: impl AsRef<Path>, follow: Follow, host: &Host) -> Result<Self, Box<dyn Error>> {
				let info = get_file_info(&host.resolve(path.as_ref()), follow != Follow::Never)?;
				Ok(Self { info })
			}
		}

		impl Matcher for SameFileMatcher {
			fn matches(&self, file_info: &WalkEntry, _matcher_io: &mut MatcherIO) -> bool {
				if let Ok(info) = get_file_info(file_info.path(), file_info.follow()) {
					info == self.info
				} else {
					false
				}
			}
		}
	}
	mod size {
		// Copyright 2017 Google Inc.


		use std::{error::Error, io::Write, str::FromStr};


		use super::{ComparableValue, Matcher, MatcherIO, WalkEntry};

		#[derive(Clone, Copy, Debug)]
		enum Unit {
			Byte,
			TwoByteWord,
			Block,
			KibiByte,
			MebiByte,
			GibiByte,
			TebiByte,
			PebiByte,
		}

		impl FromStr for Unit {
			type Err = Box<dyn Error>;

			fn from_str(s: &str) -> Result<Self, Box<dyn Error>> {
				Ok(match s {
					"c" => Self::Byte,
					"w" => Self::TwoByteWord,
					"" | "b" => Self::Block,
					"k" => Self::KibiByte,
					"M" => Self::MebiByte,
					"G" => Self::GibiByte,
					"T" => Self::TebiByte,
					"P" => Self::PebiByte,
					_ => {
						return Err(From::from(format!(
							"Invalid suffix {s} for -size. Only allowed values are <nothing>, b, c, w, k, M, G, \
							 T or P"
						)));
					},
				})
			}
		}

		fn byte_size_to_unit_size(unit: Unit, byte_size: u64) -> u64 {

			if byte_size == 0 {
				return 0;
			}
			let bits_to_shift = match unit {
				Unit::Byte => 0,
				Unit::TwoByteWord => 1,
				Unit::Block => 9,
				Unit::KibiByte => 10,
				Unit::MebiByte => 20,
				Unit::GibiByte => 30,
				Unit::TebiByte => 40,
				Unit::PebiByte => 50,
			};

			if bits_to_shift == 0 {
				return byte_size;
			}


			((byte_size - 1) >> bits_to_shift) + 1
		}


		pub struct SizeMatcher {
			value_to_match: ComparableValue,
			unit:           Unit,
		}

		impl SizeMatcher {
			pub fn new(
				value_to_match: ComparableValue,
				suffix_string: &str,
			) -> Result<Self, Box<dyn Error>> {
				Ok(Self { unit: suffix_string.parse()?, value_to_match })
			}
		}

		impl Matcher for SizeMatcher {
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				match file_info.metadata() {
					Ok(metadata) => self
						.value_to_match
						.matches(byte_size_to_unit_size(self.unit, metadata.len())),
					Err(e) => {
						writeln!(
							&mut matcher_io.host().stderr,
							"Error getting file size for {}: {}",
							file_info.path().to_string_lossy(),
							e
						)
						.unwrap();
						false
					},
				}
			}
		}
	}
	#[cfg(unix)]
	mod stat {
		// Copyright 2022 Tavian Barnes


		use std::os::unix::fs::MetadataExt;

		use super::{ComparableValue, Matcher, MatcherIO, WalkEntry};


		pub struct InodeMatcher {
			ino: ComparableValue,
		}

		impl InodeMatcher {
			pub fn new(ino: ComparableValue) -> Self {
				Self { ino }
			}
		}

		impl Matcher for InodeMatcher {
			fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
				match file_info.metadata() {
					Ok(metadata) => self.ino.matches(metadata.ino()),
					Err(_) => false,
				}
			}
		}


		pub struct LinksMatcher {
			nlink: ComparableValue,
		}

		impl LinksMatcher {
			pub fn new(nlink: ComparableValue) -> Self {
				Self { nlink }
			}
		}

		impl Matcher for LinksMatcher {
			fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
				match file_info.metadata() {
					Ok(metadata) => self.nlink.matches(metadata.nlink()),
					Err(_) => false,
				}
			}
		}
	}
	pub mod time {
		// Copyright 2017 Google Inc.


		#[cfg(unix)]
		use std::os::unix::fs::MetadataExt;
		use std::{
			error::Error,
			fs::{self, Metadata},
			io::Write,
			time::{Duration, SystemTime, UNIX_EPOCH},
		};

		use chrono::{DateTime, Local, Timelike};

		use super::{ComparableValue, Follow, Matcher, MatcherIO, WalkEntry};
		use crate::host::Host;

		const SECONDS_PER_DAY: i64 = 60 * 60 * 24;

		fn get_time(matcher_io: &mut MatcherIO, today_start: bool) -> SystemTime {
			if today_start {

				let duration_since_unix_epoch = matcher_io.now().duration_since(UNIX_EPOCH).unwrap();
				let seconds_since_unix_epoch = duration_since_unix_epoch.as_secs();
				let utc_time = DateTime::from_timestamp(seconds_since_unix_epoch as i64, 0).unwrap();
				let local_time = utc_time.with_timezone(&Local);
				let seconds_since_last_midnight = local_time.num_seconds_from_midnight();
				let local_midnight_seconds = local_time.timestamp() - seconds_since_last_midnight as i64;

				UNIX_EPOCH + Duration::from_secs(local_midnight_seconds as u64)
			} else {
				matcher_io.now()
			}
		}


		pub struct NewerMatcher {
			given_modification_time: SystemTime,
		}

		impl NewerMatcher {
			pub fn new(path_to_file: &str, follow: Follow, host: &Host) -> Result<Self, Box<dyn Error>> {
				let metadata = follow.root_metadata(host.resolve(path_to_file))?;
				Ok(Self { given_modification_time: metadata.modified()? })
			}


			fn matches_impl(&self, file_info: &WalkEntry) -> Result<bool, Box<dyn Error>> {
				let this_time = file_info.metadata()?.modified()?;


				Ok(self
					.given_modification_time
					.duration_since(this_time)
					.is_err())
			}
		}

		impl Matcher for NewerMatcher {
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				match self.matches_impl(file_info) {
					Err(e) => {
						writeln!(
							&mut matcher_io.host().stderr,
							"Error getting modification time for {}: {}",
							file_info.path().to_string_lossy(),
							e
						)
						.unwrap();
						false
					},
					Ok(t) => t,
				}
			}
		}


		#[derive(Clone, Copy, Debug)]
		pub enum NewerOptionType {
			Accessed,
			Birthed,
			Changed,
			Modified,
		}

		impl NewerOptionType {
			#[allow(clippy::should_implement_trait)]
			pub fn from_str(option: &str) -> Self {
				match option {
					"a" => Self::Accessed,
					"B" => Self::Birthed,
					"c" => Self::Changed,
					_ => Self::Modified,
				}
			}

			fn get_file_time(self, metadata: &Metadata) -> std::io::Result<SystemTime> {
				match self {
					Self::Accessed => metadata.accessed(),
					Self::Birthed => metadata.created(),
					Self::Changed => metadata.changed(),
					Self::Modified => metadata.modified(),
				}
			}
		}


		pub struct NewerOptionMatcher {
			x_option:       NewerOptionType,
			reference_time: SystemTime,
		}

		impl NewerOptionMatcher {
			pub fn new(x_option: &str, y_option: &str, path_to_file: &str, host: &Host) -> Result<Self, Box<dyn Error>> {
				let metadata = fs::metadata(host.resolve(path_to_file))?;
				let x_option = NewerOptionType::from_str(x_option);
				let y_option = NewerOptionType::from_str(y_option);
				let reference_time = y_option.get_file_time(&metadata)?;
				Ok(Self { x_option, reference_time })
			}

			fn matches_impl(&self, file_info: &WalkEntry) -> Result<bool, Box<dyn Error>> {
				let x_option_time = self.x_option.get_file_time(file_info.metadata()?)?;


				Ok(self
					.reference_time
					.duration_since(x_option_time)
					.is_err())
			}
		}

		impl Matcher for NewerOptionMatcher {
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				match self.matches_impl(file_info) {
					Err(e) => {
						writeln!(
							&mut matcher_io.host().stderr,
							"Error getting {:?} time for {}: {}",
							self.x_option,
							file_info.path().to_string_lossy(),
							e
						)
						.unwrap();
						false
					},
					Ok(t) => t,
				}
			}
		}


		pub struct NewerTimeMatcher {
			time:            i64,
			newer_time_type: NewerOptionType,
		}

		impl NewerTimeMatcher {
			pub fn new(newer_time_type: NewerOptionType, time: i64) -> Self {
				Self { time, newer_time_type }
			}

			fn matches_impl(&self, file_info: &WalkEntry) -> Result<bool, Box<dyn Error>> {
				let this_time = self.newer_time_type.get_file_time(file_info.metadata()?)?;
				let timestamp = this_time
					.duration_since(UNIX_EPOCH)
					.unwrap_or_else(|e| e.duration());


				Ok(self.time
					<= timestamp
						.as_millis()
						.try_into()
						.expect("timestamp memory implications"))
			}
		}

		impl Matcher for NewerTimeMatcher {
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				match self.matches_impl(file_info) {
					Err(e) => {
						writeln!(
							&mut matcher_io.host().stderr,
							"Error getting {:?} time for {}: {}",
							self.newer_time_type,
							file_info.path().to_string_lossy(),
							e
						)
						.unwrap();
						false
					},
					Ok(t) => t,
				}
			}
		}


		pub trait ChangeTime {

			fn changed(&self) -> std::io::Result<SystemTime>;
		}

		#[cfg(unix)]
		impl ChangeTime for Metadata {
			fn changed(&self) -> std::io::Result<SystemTime> {
				let ctime_sec = self.ctime();
				let ctime_nsec = self.ctime_nsec() as u32;
				let ctime = if ctime_sec >= 0 {
					UNIX_EPOCH + std::time::Duration::new(ctime_sec as u64, ctime_nsec)
				} else {
					UNIX_EPOCH - std::time::Duration::new(-ctime_sec as u64, ctime_nsec)
				};
				Ok(ctime)
			}
		}

		#[cfg(not(unix))]
		impl ChangeTime for Metadata {
			fn changed(&self) -> std::io::Result<SystemTime> {


				Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
			}
		}

		#[derive(Clone, Copy, Debug)]
		pub enum FileTimeType {
			Accessed,
			Changed,
			Modified,
		}

		impl FileTimeType {
			fn get_file_time(self, metadata: &Metadata) -> std::io::Result<SystemTime> {
				match self {
					Self::Accessed => metadata.accessed(),
					Self::Changed => metadata.changed(),
					Self::Modified => metadata.modified(),
				}
			}
		}


		pub struct FileTimeMatcher {
			days:           ComparableValue,
			file_time_type: FileTimeType,
			today_start:    bool,
		}

		impl Matcher for FileTimeMatcher {
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				let start_time = get_time(matcher_io, self.today_start);
				match self.matches_impl(file_info, start_time) {
					Err(e) => {
						writeln!(
							&mut matcher_io.host().stderr,
							"Error getting {:?} time for {}: {}",
							self.file_time_type,
							file_info.path().to_string_lossy(),
							e
						)
						.unwrap();
						false
					},
					Ok(t) => t,
				}
			}
		}

		impl FileTimeMatcher {


			fn matches_impl(
				&self,
				file_info: &WalkEntry,
				start_time: SystemTime,
			) -> Result<bool, Box<dyn Error>> {
				let this_time = self.file_time_type.get_file_time(file_info.metadata()?)?;
				let mut is_negative = false;


				let age = match start_time.duration_since(this_time) {
					Ok(duration) => duration,
					Err(e) => {
						is_negative = true;
						e.duration()
					},
				};
				let age_in_seconds: i64 = age.as_secs() as i64 * if is_negative { -1 } else { 1 };


				let negative_offset = if is_negative && !self.today_start {
					-1
				} else {
					0
				};

				let age_in_days = age_in_seconds / SECONDS_PER_DAY + negative_offset;
				Ok(self.days.imatches(age_in_days))
			}

			pub fn new(file_time_type: FileTimeType, days: ComparableValue, today_start: bool) -> Self {
				Self { days, file_time_type, today_start }
			}
		}

		pub struct FileAgeRangeMatcher {
			minutes:        ComparableValue,
			file_time_type: FileTimeType,
			today_start:    bool,
		}

		impl Matcher for FileAgeRangeMatcher {
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				let start_time = get_time(matcher_io, self.today_start);
				match self.matches_impl(file_info, start_time) {
					Err(e) => {
						writeln!(
							&mut matcher_io.host().stderr,
							"Error getting {:?} time for {}: {}",
							self.file_time_type,
							file_info.path().to_string_lossy(),
							e
						)
						.unwrap();
						false
					},
					Ok(t) => t,
				}
			}
		}

		impl FileAgeRangeMatcher {
			fn matches_impl(
				&self,
				file_info: &WalkEntry,
				start_time: SystemTime,
			) -> Result<bool, Box<dyn Error>> {
				let this_time = self.file_time_type.get_file_time(file_info.metadata()?)?;
				let mut is_negative = false;
				let age = match start_time.duration_since(this_time) {
					Ok(duration) => duration,
					Err(e) => {
						is_negative = true;
						e.duration()
					},
				};
				let age_in_seconds: i64 = age.as_secs() as i64 * if is_negative { -1 } else { 1 };
				let age_in_minutes = age_in_seconds / 60 + if is_negative { -1 } else { 0 };
				Ok(self.minutes.imatches(age_in_minutes))
			}

			pub fn new(file_time_type: FileTimeType, minutes: ComparableValue, today_start: bool) -> Self {
				Self { minutes, file_time_type, today_start }
			}
		}
	}
	mod type_matcher {
		// Copyright 2017 Google Inc.


		use std::error::Error;

		use super::{FileType, Follow, Matcher, MatcherIO, WalkEntry};


		pub struct TypeMatcher {
			file_types: Vec<FileType>,
		}


		fn parse_one(type_string: &str) -> Result<Option<FileType>, Box<dyn Error>> {
			let file_type = match type_string {
				"f" => FileType::Regular,
				"d" => FileType::Directory,
				"l" => FileType::Symlink,
				"b" => FileType::BlockDevice,
				"c" => FileType::CharDevice,
				"p" => FileType::Fifo,
				"s" => FileType::Socket,

				"w" => return Ok(None),

				"D" => return Err(From::from(format!("Type argument {type_string} not supported yet"))),
				_ => return Err(From::from(format!("Unrecognised type argument {type_string}"))),
			};
			Ok(Some(file_type))
		}

		fn parse(type_string: &str) -> Result<Vec<FileType>, Box<dyn Error>> {
			let mut file_types = Vec::new();
			for part in type_string.split(',') {
				if part.is_empty() {
					return Err(From::from(format!("Unrecognised type argument {type_string}")));
				}
				if let Some(file_type) = parse_one(part)? {
					file_types.push(file_type);
				}
			}
			Ok(file_types)
		}

		impl TypeMatcher {
			pub fn new(type_string: &str) -> Result<Self, Box<dyn Error>> {
				let file_types = parse(type_string)?;
				Ok(Self { file_types })
			}
		}

		impl Matcher for TypeMatcher {
			fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
				self.file_types.contains(&file_info.file_type())
			}
		}


		pub struct XtypeMatcher {
			file_types: Vec<FileType>,
		}

		impl XtypeMatcher {
			pub fn new(type_string: &str) -> Result<Self, Box<dyn Error>> {
				let file_types = parse(type_string)?;
				Ok(Self { file_types })
			}
		}

		impl Matcher for XtypeMatcher {
			fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
				let follow = if file_info.follow() {
					Follow::Never
				} else {
					Follow::Always
				};

				let file_type = follow
					.metadata(file_info)
					.map(|m| m.file_type())
					.map(FileType::from);

				match file_type {
					Ok(file_type) if self.file_types.contains(&file_type) => true,

					Err(e) if self.file_types.iter().any(|t| t.is_symlink()) && e.is_loop() => true,
					_ => false,
				}
			}
		}
	}
	mod user {


		#[cfg(unix)]
		use std::os::unix::fs::MetadataExt;

		#[cfg(unix)]
		use nix::unistd::User;

		use super::{ComparableValue, Matcher, MatcherIO, WalkEntry};

		pub struct UserMatcher {
			#[cfg_attr(not(unix), allow(dead_code))]
			uid: ComparableValue,
		}

		impl UserMatcher {
			#[cfg(unix)]
			pub fn from_user_name(user: &str) -> Option<Self> {

				let user = User::from_name(user).ok()??;
				let uid = user.uid.as_raw();
				Some(Self::from_uid(uid))
			}

			pub fn from_uid(uid: u32) -> Self {
				Self::from_comparable(ComparableValue::EqualTo(uid as u64))
			}

			pub fn from_comparable(uid: ComparableValue) -> Self {
				Self { uid }
			}

		}

		impl Matcher for UserMatcher {
			#[cfg(unix)]
			fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
				match file_info.metadata() {
					Ok(metadata) => self.uid.matches(metadata.uid().into()),
					Err(_) => false,
				}
			}

		}

		pub struct NoUserMatcher {}

		impl Matcher for NoUserMatcher {
			#[cfg(unix)]
			fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
				use nix::unistd::Uid;

				if file_info.path().is_symlink() {
					return false;
				}

				let Ok(metadata) = file_info.metadata() else {
					return true;
				};

				let Ok(uid) = User::from_uid(Uid::from_raw(metadata.uid())) else {
					return true;
				};

				let Some(_user) = uid else {
					return true;
				};

				false
			}

		}
	}

	use std::{
		error::Error,
		fs::{File, Metadata},
		io::{Read, Write},
		path::Path,
		str::FromStr,
		time::SystemTime,
	};

	use ::regex::Regex;
	use chrono::{DateTime, Datelike, Local, NaiveDate, NaiveDateTime, TimeZone, Utc};
	pub use entry::{FileType, WalkEntry, WalkError};
	use fs::FileSystemMatcher;
	use ls::Ls;

	#[cfg(unix)]
	use self::stat::{InodeMatcher, LinksMatcher};
	use self::{
		access::AccessMatcher,
		delete::DeleteMatcher,
		empty::EmptyMatcher,
		exec::{MultiExecMatcher, SingleExecMatcher},
		group::{GroupMatcher, NoGroupMatcher},
		lname::LinkNameMatcher,
		logical_matchers::{
			AndMatcherBuilder, FalseMatcher, ListMatcherBuilder, NotMatcher, TrueMatcher,
		},
		name::NameMatcher,
		path::PathMatcher,
		perm::PermMatcher,
		printer::{PrintDelimiter, Printer},
		printf::Printf,
		prune::PruneMatcher,
		quit::QuitMatcher,
		regex::RegexMatcher,
		samefile::SameFileMatcher,
		size::SizeMatcher,
		time::{
			FileAgeRangeMatcher, FileTimeMatcher, FileTimeType, NewerMatcher, NewerOptionMatcher,
			NewerOptionType, NewerTimeMatcher,
		},
		type_matcher::{TypeMatcher, XtypeMatcher},
		user::{NoUserMatcher, UserMatcher},
	};
	use super::{Config, Dependencies};
	use crate::host::Host;


	#[derive(Clone, Copy, Debug, Eq, PartialEq)]
	pub enum Follow {

		Never,

		Roots,

		Always,
	}

	impl Follow {

		pub fn follow_at_depth(self, depth: usize) -> bool {
			match self {
				Self::Never => false,
				Self::Roots => depth == 0,
				Self::Always => true,
			}
		}


		pub fn metadata(self, entry: &WalkEntry) -> Result<Metadata, WalkError> {
			if self.follow_at_depth(entry.depth()) == entry.follow() {

				entry.metadata().cloned()
			} else if !entry.follow() && !entry.file_type().is_symlink() {

				entry.metadata().cloned()
			} else if entry.follow() && entry.file_type().is_symlink() {

				entry.metadata().cloned()
			} else {
				self.metadata_at_depth(entry.path(), entry.depth())
			}
		}


		pub fn root_metadata(self, path: impl AsRef<Path>) -> Result<Metadata, WalkError> {
			self.metadata_at_depth(path, 0)
		}


		pub fn metadata_at_depth(
			self,
			path: impl AsRef<Path>,
			depth: usize,
		) -> Result<Metadata, WalkError> {
			let path = path.as_ref();

			if self.follow_at_depth(depth) {
				match path.metadata().map_err(WalkError::from) {
					Ok(meta) => return Ok(meta),
					Err(e) if !e.is_not_found() => return Err(e),
					_ => {},
				}
			}

			Ok(path.symlink_metadata()?)
		}
	}


	pub struct MatcherIO<'a> {
		should_skip_dir: bool,
		exit_code:       i32,
		quit:            bool,
		deps:            &'a dyn Dependencies,
		host:            &'a mut Host,
	}

	impl MatcherIO<'_> {
		pub fn new<'a>(deps: &'a dyn Dependencies, host: &'a mut Host) -> MatcherIO<'a> {
			MatcherIO { should_skip_dir: false, exit_code: 0, quit: false, deps, host }
		}

		pub fn host(&mut self) -> &mut Host {
			self.host
		}

		pub fn mark_current_dir_to_be_skipped(&mut self) {
			self.should_skip_dir = true;
		}

		#[must_use]
		pub fn should_skip_current_dir(&self) -> bool {
			self.should_skip_dir
		}

		pub fn set_exit_code(&mut self, code: i32) {
			self.exit_code = code;
		}

		#[must_use]
		pub fn exit_code(&self) -> i32 {
			self.exit_code
		}

		pub fn quit(&mut self) {
			self.quit = true;
		}

		#[must_use]
		pub fn should_quit(&self) -> bool {
			self.quit
		}

		#[must_use]
		pub fn now(&self) -> SystemTime {
			self.deps.now()
		}
	}


	pub trait Matcher: 'static {

		fn into_box(self) -> Box<dyn Matcher>
		where
			Self: Sized,
		{
			Box::new(self)
		}


		fn matches(&self, entry: &WalkEntry, matcher_io: &mut MatcherIO) -> bool;


		fn has_side_effects(&self) -> bool {

			false
		}


		fn finished_dir(&self, _finished_directory: &Path, _matcher_io: &mut MatcherIO) {}


		fn finished(&self, _matcher_io: &mut MatcherIO) {}
	}

	impl Matcher for Box<dyn Matcher> {
		fn into_box(self) -> Box<dyn Matcher> {
			self
		}

		fn matches(&self, entry: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
			(**self).matches(entry, matcher_io)
		}

		fn has_side_effects(&self) -> bool {
			(**self).has_side_effects()
		}

		fn finished_dir(&self, finished_directory: &Path, matcher_io: &mut MatcherIO) {
			(**self).finished_dir(finished_directory, matcher_io);
		}

		fn finished(&self, matcher_io: &mut MatcherIO) {
			(**self).finished(matcher_io);
		}
	}

	#[derive(Debug, Eq, PartialEq)]
	pub enum ComparableValue {
		MoreThan(u64),
		EqualTo(u64),
		LessThan(u64),
	}

	impl ComparableValue {
		fn matches(&self, value: u64) -> bool {
			match *self {
				Self::MoreThan(limit) => value > limit,
				Self::EqualTo(limit) => value == limit,
				Self::LessThan(limit) => value < limit,
			}
		}


		fn imatches(&self, value: i64) -> bool {
			match *self {
				Self::MoreThan(limit) => value >= 0 && (value as u64) > limit,
				Self::EqualTo(limit) => value >= 0 && (value as u64) == limit,
				Self::LessThan(limit) => value < 0 || (value as u64) < limit,
			}
		}
	}


	pub fn build_top_level_matcher(
		args: &[&str],
		config: &mut Config,
		host: &mut Host,
	) -> Result<Box<dyn Matcher>, Box<dyn Error>> {
		let (_, top_level_matcher) = (build_matcher_tree(args, config, 0, false, host))?;


		if !top_level_matcher.has_side_effects() {
			let mut new_and_matcher = AndMatcherBuilder::new();
			new_and_matcher.new_and_condition(top_level_matcher);
			new_and_matcher.new_and_condition(Printer::new(PrintDelimiter::Newline, None));
			return Ok(new_and_matcher.build());
		}
		Ok(top_level_matcher)
	}


	fn are_more_expressions(args: &[&str], index: usize) -> bool {
		(index < args.len() - 1) && args[index + 1] != ")"
	}

	fn convert_arg_to_number(
		option_name: &str,
		value_as_string: &str,
	) -> Result<usize, Box<dyn Error>> {
		match value_as_string.parse::<usize>() {
			Ok(val) => Ok(val),
			_ => Err(From::from(format!(
				"Expected a positive decimal integer argument to {option_name}, but got \
				 `{value_as_string}'"
			))),
		}
	}

	fn convert_arg_to_comparable_value(
		option_name: &str,
		value_as_string: &str,
	) -> Result<ComparableValue, Box<dyn Error>> {
		let re = Regex::new(r"^([-+]?)[-+]?(\d+)$")?;
		if let Some(groups) = re.captures(value_as_string)
			&& let Ok(val) = groups[2].parse::<u64>()
		{
			return Ok(match &groups[1] {
				"+" => ComparableValue::MoreThan(val),
				"-" => ComparableValue::LessThan(val),
				_ => ComparableValue::EqualTo(val),
			});
		}
		Err(From::from(format!(
			"Expected a decimal integer (with optional + or - prefix) argument to {option_name}, but \
			 got `{value_as_string}'"
		)))
	}

	fn convert_arg_to_comparable_value_and_suffix(
		option_name: &str,
		value_as_string: &str,
	) -> Result<(ComparableValue, String), Box<dyn Error>> {
		let re = Regex::new(r"([-+]?)[-+]?(\d+)(.*)$")?;
		if let Some(groups) = re.captures(value_as_string)
			&& let Ok(val) = groups[2].parse::<u64>()
		{
			return Ok((
				match &groups[1] {
					"+" => ComparableValue::MoreThan(val),
					"-" => ComparableValue::LessThan(val),
					_ => ComparableValue::EqualTo(val),
				},
				groups[3].to_string(),
			));
		}
		Err(From::from(format!(
			"Expected a decimal integer (with optional + or - prefix) and (optional suffix) argument to \
			 {option_name}, but got `{value_as_string}'"
		)))
	}


	fn parse_date_str_to_timestamps(date_str: &str) -> Option<i64> {
		if let Some(epoch) = date_str.strip_prefix('@')
			&& let Ok(seconds) = epoch.parse::<f64>()
		{
			return Some((seconds * 1000.0) as i64);
		}

		if let Ok(datetime) = DateTime::parse_from_rfc3339(date_str) {
			return Some(datetime.timestamp_millis());
		}

		let naive = NaiveDate::parse_from_str(date_str, "%Y-%m-%d")
			.ok()
			.and_then(|date| date.and_hms_opt(0, 0, 0))
			.or_else(|| NaiveDateTime::parse_from_str(date_str, "%Y-%m-%d %H:%M:%S").ok())
			.or_else(|| NaiveDateTime::parse_from_str(date_str, "%Y-%m-%dT%H:%M:%S").ok())
			.or_else(|| NaiveDateTime::parse_from_str(date_str, "%Y-%m-%d %H:%M").ok())
			.or_else(|| NaiveDateTime::parse_from_str(date_str, "%Y-%m-%dT%H:%M").ok());
		if let Some(naive) = naive {
			return Some(Local.from_local_datetime(&naive).earliest()?.timestamp_millis());
		}

		let regex_pattern =
			r"^(?P<month_day>\w{3} \d{2})?(?:, (?P<year>\d{4}))?(?: (?P<time>\d{2}:\d{2}:\d{2}))?$";
		let re = Regex::new(regex_pattern);

		if let Some(captures) = re.ok()?.captures(date_str) {
			let now = Utc::now();
			let month_day = captures
				.get(1)
				.map_or(format!("{} {}", now.format("%b"), now.format("%d")), |m| m.as_str().to_string());

			let year = captures
				.get(2)
				.map_or(now.year(), |m| m.as_str().parse().unwrap());

			let time_str = captures.get(3).map_or("00:00:00", |m| m.as_str());
			let date_time_str = format!("{month_day}, {year} {time_str}");
			let datetime = NaiveDateTime::parse_from_str(&date_time_str, "%b %d, %Y %H:%M:%S").ok()?;
			let utc_datetime = DateTime::<Utc>::from_naive_utc_and_offset(datetime, Utc);
			Some(utc_datetime.timestamp_millis())
		} else {
			None
		}
	}


	fn parse_str_to_newer_args(input: &str) -> Option<(String, String)> {
		if input.is_empty() {
			return None;
		}

		if input == "-newer" {
			return Some(("m".to_string(), "m".to_string()));
		}

		if input == "-anewer" {
			return Some(("a".to_string(), "m".to_string()));
		}

		if input == "-cnewer" {
			return Some(("c".to_string(), "m".to_string()));
		}

		let re = Regex::new(r"-newer([aBcm])([aBcmt])").unwrap();
		if let Some(captures) = re.captures(input) {
			let x = captures.get(1)?.as_str().to_string();
			let y = captures.get(2)?.as_str().to_string();
			Some((x, y))
		} else {
			None
		}
	}


	fn get_or_create_file(path: &str, host: &Host) -> Result<File, Box<dyn Error>> {
		let file = File::create(host.resolve(path))?;
		host.note_write(path);
		Ok(file)
	}


	fn build_matcher_tree(
		args: &[&str],
		config: &mut Config,
		arg_index: usize,
		mut expecting_bracket: bool,
		host: &mut Host,
	) -> Result<(usize, Box<dyn Matcher>), Box<dyn Error>> {
		let mut top_level_matcher = ListMatcherBuilder::new();

		let mut regex_type = regex::RegexType::default();


		let mut i = arg_index;
		let mut invert_next_matcher = false;
		while i < args.len() {
			let possible_submatcher = match args[i] {
				"-print" => Some(Printer::new(PrintDelimiter::Newline, None).into_box()),
				"-print0" => Some(Printer::new(PrintDelimiter::Null, None).into_box()),
				"-printf" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;
					Some(Printf::new(args[i], None)?.into_box())
				},
				"-fprint" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;

					let file = get_or_create_file(args[i], host)?;
					Some(Printer::new(PrintDelimiter::Newline, Some(file)).into_box())
				},
				"-fprintf" => {
					if i >= args.len() - 2 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}


					i += 1;
					let file = get_or_create_file(args[i], host)?;
					i += 1;
					Some(Printf::new(args[i], Some(file))?.into_box())
				},
				"-fprint0" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;

					let file = get_or_create_file(args[i], host)?;
					Some(Printer::new(PrintDelimiter::Null, Some(file)).into_box())
				},
				"-ls" => Some(Ls::new(None).into_box()),
				"-fls" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;

					let file = get_or_create_file(args[i], host)?;
					Some(Ls::new(Some(file)).into_box())
				},
				"-true" => Some(TrueMatcher.into_box()),
				"-false" => Some(FalseMatcher.into_box()),
				"-lname" | "-ilname" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;
					Some(LinkNameMatcher::new(args[i], args[i - 1].starts_with("-i")).into_box())
				},
				"-name" | "-iname" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;
					Some(NameMatcher::new(args[i], args[i - 1].starts_with("-i")).into_box())
				},
				"-path" | "-ipath" | "-wholename" | "-iwholename" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;
					Some(PathMatcher::new(args[i], args[i - 1].starts_with("-i")).into_box())
				},
				"-readable" => Some(AccessMatcher::Readable.into_box()),
				"-regextype" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;
					regex_type = regex::RegexType::from_str(args[i])?;
					Some(TrueMatcher.into_box())
				},
				"-regex" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;
					Some(RegexMatcher::new(regex_type, args[i], false)?.into_box())
				},
				"-iregex" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;
					Some(RegexMatcher::new(regex_type, args[i], true)?.into_box())
				},
				"-type" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;
					Some(TypeMatcher::new(args[i])?.into_box())
				},
				"-xtype" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;
					Some(XtypeMatcher::new(args[i])?.into_box())
				},
				"-fstype" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;
					Some(FileSystemMatcher::new(args[i].to_string()).into_box())
				},
				"-delete" => {

					config.depth_first = true;
					Some(DeleteMatcher::new().into_box())
				},
				"-newer" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;
					Some(NewerMatcher::new(args[i], config.follow, host)?.into_box())
				},
				"-mtime" | "-atime" | "-ctime" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					let file_time_type = match args[i] {
						"-atime" => FileTimeType::Accessed,
						"-ctime" => FileTimeType::Changed,
						"-mtime" => FileTimeType::Modified,


						_ => unreachable!("Encountered unexpected value {}", args[i]),
					};
					let days = convert_arg_to_comparable_value(args[i], args[i + 1])?;
					i += 1;
					Some(FileTimeMatcher::new(file_time_type, days, config.today_start).into_box())
				},
				"-amin" | "-cmin" | "-mmin" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					let file_time_type = match args[i] {
						"-amin" => FileTimeType::Accessed,
						"-cmin" => FileTimeType::Changed,
						"-mmin" => FileTimeType::Modified,
						_ => unreachable!("Encountered unexpected value {}", args[i]),
					};
					let minutes = convert_arg_to_comparable_value(args[i], args[i + 1])?;
					i += 1;
					Some(FileAgeRangeMatcher::new(file_time_type, minutes, config.today_start).into_box())
				},
				"-size" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					let (size, unit) = convert_arg_to_comparable_value_and_suffix(args[i], args[i + 1])?;
					i += 1;
					Some(SizeMatcher::new(size, &unit)?.into_box())
				},
				"-empty" => Some(EmptyMatcher::new().into_box()),
				"-exec" | "-execdir" => {
					let mut arg_index = i + 1;
					while arg_index < args.len()
						&& args[arg_index] != ";"
						&& (args[arg_index - 1] != "{}" || args[arg_index] != "+")
					{
						arg_index += 1;
					}
					let required_arg = if arg_index < args.len() && args[arg_index] == "+" {
						3
					} else {
						2
					};
					if arg_index < i + required_arg || arg_index == args.len() {


						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					let expression = args[i];
					let executable = args[i + 1];
					let exec_args = &args[i + 2..arg_index];
					i = arg_index;
					match args[arg_index] {
						";" => Some(
							SingleExecMatcher::new(executable, exec_args, expression == "-execdir")?
								.into_box(),
						),
						"+" => {
							if exec_args.iter().filter(|x| matches!(**x, "{}")).count() == 1 {
								Some(
									MultiExecMatcher::new(
										executable,
										&exec_args[0..exec_args.len() - 1],
										expression == "-execdir",
									)?
									.into_box(),
								)
							} else {
								return Err(From::from(
									"Only one instance of {} is supported with -execdir ... +",
								));
							}
						},
						_ => unreachable!("Encountered unexpected value {}", args[arg_index]),
					}
				},
				#[cfg(unix)]
				"-inum" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					let inum = convert_arg_to_comparable_value(args[i], args[i + 1])?;
					i += 1;
					Some(InodeMatcher::new(inum).into_box())
				},
				#[cfg(not(unix))]
				"-inum" => {
					return Err(From::from("Inode numbers are not available on this platform"));
				},
				#[cfg(unix)]
				"-links" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					let inum = convert_arg_to_comparable_value(args[i], args[i + 1])?;
					i += 1;
					Some(LinksMatcher::new(inum).into_box())
				},
				#[cfg(not(unix))]
				"-links" => {
					return Err(From::from("Link counts are not available on this platform"));
				},
				"-samefile" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;
					let path = args[i];
					let matcher = SameFileMatcher::new(path, config.follow, host)
						.map_err(|e| format!("{path}: {e}"))?;
					Some(matcher.into_box())
				},
				"-user" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}

					let user = args[i + 1];

					if user.is_empty() {
						return Err(From::from("The argument to -user should not be empty"));
					}

					i += 1;
					let matcher = UserMatcher::from_user_name(user)
						.or_else(|| Some(UserMatcher::from_uid(user.parse::<u32>().ok()?)))
						.ok_or_else(|| format!("{user} is not the name of a known user"))?;
					Some(matcher.into_box())
				},
				"-nouser" => Some(NoUserMatcher {}.into_box()),
				"-uid" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}

					let uid = convert_arg_to_comparable_value(args[i], args[i + 1])?;
					i += 1;
					Some(UserMatcher::from_comparable(uid).into_box())
				},
				"-group" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}

					let group = args[i + 1];

					if group.is_empty() {
						return Err(From::from("Argument to -group is empty, but should be a group name"));
					}

					i += 1;
					let matcher = GroupMatcher::from_group_name(group)
						.or_else(|| Some(GroupMatcher::from_gid(group.parse::<u32>().ok()?)))
						.ok_or_else(|| format!("{group} is not the name of an existing group"))?;
					Some(matcher.into_box())
				},
				"-nogroup" => Some(NoGroupMatcher {}.into_box()),
				"-gid" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}

					let gid = convert_arg_to_comparable_value(args[i], args[i + 1])?;
					i += 1;
					Some(GroupMatcher::from_comparable(gid).into_box())
				},
				"-executable" => Some(AccessMatcher::Executable.into_box()),
				"-perm" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;
					Some(PermMatcher::new(args[i])?.into_box())
				},
				"-prune" => Some(PruneMatcher::new().into_box()),
				"-quit" => Some(QuitMatcher.into_box()),
				"-writable" => Some(AccessMatcher::Writable.into_box()),
				"-not" | "!" => {
					if !are_more_expressions(args, i) {
						return Err(From::from(format!("expected an expression after {}", args[i])));
					}
					invert_next_matcher = !invert_next_matcher;
					None
				},
				"-and" | "-a" => {
					if !are_more_expressions(args, i) {
						return Err(From::from(format!("expected an expression after {}", args[i])));
					}
					top_level_matcher.check_new_and_condition()?;
					None
				},
				"-or" | "-o" => {
					if !are_more_expressions(args, i) {
						return Err(From::from(format!("expected an expression after {}", args[i])));
					}
					top_level_matcher.new_or_condition(args[i])?;
					None
				},
				"," => {
					if !are_more_expressions(args, i) {
						return Err(From::from(format!("expected an expression after {}", args[i])));
					}
					top_level_matcher.new_list_condition()?;
					None
				},
				"(" => {
					let (new_arg_index, sub_matcher) = build_matcher_tree(args, config, i + 1, true, host)?;
					i = new_arg_index;
					Some(sub_matcher)
				},
				")" => {
					if !expecting_bracket {
						return Err(From::from(
							"invalid expression: expected expression before closing parentheses ')'.",
						));
					}

					let bracket = args[i - 1];
					if bracket == "(" {
						return Err(From::from("invalid expression; empty parentheses are not allowed."));
					}

					return Ok((i, top_level_matcher.build()));
				},
				"-follow" => {


					config.follow = Follow::Always;
					config.no_leaf_dirs = true;
					Some(TrueMatcher.into_box())
				},
				"-daystart" => {
					config.today_start = true;
					Some(TrueMatcher.into_box())
				},
				"-noleaf" => {

					config.no_leaf_dirs = true;
					Some(TrueMatcher.into_box())
				},
				"-d" | "-depth" => {

					config.depth_first = true;
					Some(TrueMatcher.into_box())
				},
				"-mount" | "-xdev" => {

					config.same_file_system = true;
					Some(TrueMatcher.into_box())
				},
				"-sorted" => {

					config.sorted_output = true;
					Some(TrueMatcher.into_box())
				},
				"-maxdepth" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					config.max_depth = convert_arg_to_number(args[i], args[i + 1])?;
					i += 1;
					Some(TrueMatcher.into_box())
				},
				"-mindepth" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					config.min_depth = convert_arg_to_number(args[i], args[i + 1])?;
					i += 1;
					Some(TrueMatcher.into_box())
				},
				"-help" | "--help" => {
					config.help_requested = true;
					None
				},
				"-version" | "--version" => {
					config.version_requested = true;
					None
				},
				"-files0-from" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					let _ = config.files0_argument.insert(args[i + 1].to_string());
					i += 1;
					Some(TrueMatcher.into_box())
				},

				_ => {
					match parse_str_to_newer_args(args[i]) {
						Some((x_option, y_option)) => {
							if i >= args.len() - 1 {
								return Err(From::from(format!("missing argument to {}", args[i])));
							}
							#[cfg(target_os = "linux")]
							if x_option == "B" {
								return Err(From::from(
									"find: This system does not provide a way to find the birth time of a \
									 file.",
								));
							}
							if y_option == "t" {
								let time = args[i + 1];
								let newer_time_type = NewerOptionType::from_str(x_option.as_str());

								let Some(comparable_time) = parse_date_str_to_timestamps(time) else {
									return Err(From::from(format!(
										"find: I cannot figure out how to interpret ‘{}’ as a date or time",
										args[i + 1]
									)));
								};
								i += 1;
								Some(NewerTimeMatcher::new(newer_time_type, comparable_time).into_box())
							} else {
								let file_path = args[i + 1];
								i += 1;
								Some(NewerOptionMatcher::new(&x_option, &y_option, file_path, host)?.into_box())
							}
						},
						None => return Err(From::from(format!("Unrecognized flag: '{}'", args[i]))),
					}
				},
			};
			i += 1;
			if config.help_requested || config.version_requested {

				expecting_bracket = false;
				break;
			}
			if let Some(submatcher) = possible_submatcher {
				if invert_next_matcher {
					top_level_matcher.new_and_condition(NotMatcher::new(submatcher));
					invert_next_matcher = false;
				} else {
					top_level_matcher.new_and_condition(submatcher);
				}
			}
		}
		if expecting_bracket {
			return Err(From::from(
				"invalid expression; I was expecting to find a ')' somewhere but did not see one.",
			));
		}
		if config.files0_argument.is_some() {
			parse_files0_args(config, host)?;
		}
		Ok((i, top_level_matcher.build()))
	}


	fn parse_files0_args(config: &mut Config, host: &mut Host) -> Result<(), Box<dyn Error>> {
		let mode = config.files0_argument.as_ref().unwrap();
		let mut buffer = Vec::new();
		let new_paths = config.new_paths.insert(Vec::new());

		if mode == "-" {
			host.stdin.read_to_end(&mut buffer)?;
		} else {
			let mut file = File::open(host.resolve(mode))
				.map_err(|e| format!("cannot open '{}' for reading: {}", mode, e))?;
			file.read_to_end(&mut buffer)?;
		}

		let mut buffer_split: Vec<&[u8]> = buffer.split(|&b| b == 0).collect();

		if buffer_split.last().is_some_and(|s| s.is_empty()) {
			buffer_split.remove(buffer_split.len() - 1);
		}

		let mut string_segments: Vec<String> = buffer_split
			.iter()
			.filter_map(|s| std::str::from_utf8(s).ok())
			.map(|s| s.to_string())
			.collect();

		if string_segments.iter().any(|s| s.is_empty()) {
			let _ = writeln!(host.stderr, "find: invalid zero-length file name");

			string_segments.retain(|s| !s.is_empty());
		}

		new_paths.extend(string_segments);
		Ok(())
	}
}

use std::{
	cell::{Cell, RefCell},
	error::Error,
	io::{self, Write},
	path::{Path, PathBuf},
	rc::Rc,
	time::SystemTime,
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command, builder::OsStringValueParser};

use crate::host::{Host, Utility, matches_parser, util};
use matchers::{Follow, WalkEntry};

pub struct Config {
	same_file_system:  bool,
	depth_first:       bool,
	min_depth:         usize,
	max_depth:         usize,
	sorted_output:     bool,
	help_requested:    bool,
	version_requested: bool,
	today_start:       bool,
	no_leaf_dirs:      bool,
	follow:            Follow,
	new_paths:         Option<Vec<String>>,
	files0_argument:   Option<String>,
}

impl Default for Config {
	fn default() -> Self {
		Self {
			same_file_system:  false,
			depth_first:       false,
			min_depth:         0,
			max_depth:         usize::MAX,
			sorted_output:     false,
			help_requested:    false,
			version_requested: false,
			today_start:       false,


			no_leaf_dirs:      false,
			follow:            Follow::Never,
			new_paths:         None,
			files0_argument:   None,
		}
	}
}


pub trait Dependencies {
	fn get_output(&self) -> &RefCell<dyn Write>;
	fn now(&self) -> SystemTime;
}


struct StandardDependencies {
	output: Rc<RefCell<dyn Write>>,
	now:    SystemTime,
}

impl StandardDependencies {
	#[must_use]
	fn new(host: &Host) -> Self {
		Self { output: Rc::new(RefCell::new(host.stdout_clone())), now: SystemTime::now() }
	}
}


impl Dependencies for StandardDependencies {
	fn get_output(&self) -> &RefCell<dyn Write> {
		self.output.as_ref()
	}

	fn now(&self) -> SystemTime {
		self.now
	}
}


struct ParsedInfo {
	matcher: Box<dyn self::matchers::Matcher>,
	paths:   Vec<String>,
	config:  Config,
}


fn parse_args(args: &[&str], host: &mut Host) -> Result<ParsedInfo, Box<dyn Error>> {
	let mut paths = vec![];
	let mut i = 0;
	let mut config = Config::default();
	let mut extended_regex = false;

	while i < args.len() {
		match args[i] {
			"-O0" | "-O1" | "-O2" | "-O3" => {

			},
			"-H" => config.follow = Follow::Roots,
			"-L" => config.follow = Follow::Always,
			"-P" => config.follow = Follow::Never,

			"-E" => extended_regex = true,

			"-x" => config.same_file_system = true,

			"-s" => config.sorted_output = true,
			"--" => {

				i += 1;
				break;
			},
			_ => break,
		}

		i += 1;
	}

	let paths_start = i;
	while i < args.len()
		&& (args[i] == "-" || !args[i].starts_with('-'))
		&& args[i] != "!"
		&& args[i] != "("
	{
		paths.push(args[i].to_string());
		i += 1;
	}
	if i == paths_start {
		paths.push(".".to_string());
	}
	let matcher = if extended_regex {


		let mut expression = Vec::with_capacity(args.len() - i + 2);
		expression.extend(["-regextype", "posix-extended"]);
		expression.extend_from_slice(&args[i..]);
		matchers::build_top_level_matcher(&expression, &mut config, host)?
	} else {
		matchers::build_top_level_matcher(&args[i..], &mut config, host)?
	};
	if let Some(new_paths) = &config.new_paths {
		if paths.len() == 1 && paths[0] == "." {
			paths = new_paths.to_vec();
		} else {
			return Err(From::from(format!(
				"extra operand '{}'\nfile operands cannot be combined with -files0-from",
				paths[0]
			)));
		}
	}
	Ok(ParsedInfo { matcher, paths, config })
}

fn apply_find_entry(
	mut entry: WalkEntry,
	operand: &Path,
	resolved_root: &Path,
	deps: &dyn Dependencies,
	host: &mut Host,
	matcher: &dyn matchers::Matcher,
	current_dir: &mut Option<PathBuf>,
	ret: &mut i32,
) -> (bool, bool) {
	entry.set_display_root(operand, resolved_root);
	let mut matcher_io = matchers::MatcherIO::new(deps, host);

	let new_dir = entry.path().parent().map(|x| x.to_path_buf());
	if new_dir != *current_dir {
		if let Some(dir) = current_dir.take() {
			matcher.finished_dir(dir.as_path(), &mut matcher_io);
		}
		*current_dir = new_dir;
	}

	matcher.matches(&entry, &mut matcher_io);
	match matcher_io.exit_code() {
		0 => {},
		code => *ret = code,
	}
	(matcher_io.should_quit(), matcher_io.should_skip_current_dir())
}

fn finish_find_walk(
	deps: &dyn Dependencies,
	host: &mut Host,
	matcher: &dyn matchers::Matcher,
	current_dir: &mut Option<PathBuf>,
	ret: &mut i32,
) {
	let mut matcher_io = matchers::MatcherIO::new(deps, host);
	if let Some(dir) = current_dir.take() {
		matcher.finished_dir(dir.as_path(), &mut matcher_io);
	}
	matcher.finished(&mut matcher_io);

	match matcher_io.exit_code() {
		0 => {},
		code => *ret = code,
	}
}

fn walker_follow_links(follow: Follow) -> pi_walker::FollowLinks {
	match follow {
		Follow::Never => pi_walker::FollowLinks::Never,
		Follow::Roots => pi_walker::FollowLinks::Roots,
		Follow::Always => pi_walker::FollowLinks::Always,
	}
}

fn build_find_walk_request(config: &Config, root: &Path) -> pi_walker::WalkRequest {
	pi_walker::WalkRequest::new(root)
		.hidden(true)
		.gitignore(false)
		.skip_git(false)
		.skip_node_modules(false)
		.follow_links(walker_follow_links(config.follow))
		.detail(pi_walker::WalkDetail::Minimal)
		.order(if config.sorted_output {
			pi_walker::WalkOrder::Path
		} else {
			pi_walker::WalkOrder::Unordered
		})
		.emit_root(true)
		.depth(config.min_depth, config.max_depth)
		.visit_order(if config.depth_first {
			pi_walker::VisitOrder::ContentsFirst
		} else {
			pi_walker::VisitOrder::PreOrder
		})
		.directory_errors(pi_walker::DirectoryErrorMode::Visit)
		.same_file_system(config.same_file_system)
		.cache(false)
}
fn process_dir_walk_request(
	config: &Config,
	deps: &dyn Dependencies,
	host: &mut Host,
	matcher: &dyn matchers::Matcher,
	quit: &mut bool,
	resolved_root: &Path,
	operand: &Path,
) -> i32 {
	let request = build_find_walk_request(config, resolved_root);
	let current_dir = RefCell::new(None);
	let ret = Cell::new(0);
	let local_quit = Cell::new(false);
	let cancel = host.cancel_flag();
	let mut walk_stderr = host.stderr_clone();
	let status = request.for_each_entry_with_heartbeat(
		move || {
			if cancel.load(std::sync::atomic::Ordering::Relaxed) {
				Err(io::Error::new(io::ErrorKind::Interrupted, "cancelled"))
			} else {
				Ok(())
			}
		},
		|entry: pi_walker::EntryMeta<'_>| {
			let walk_entry =
				WalkEntry::new(entry.absolute_path.as_ref().to_path_buf(), entry.depth, config.follow);
			let mut current_dir = current_dir.borrow_mut();
			let mut ret_value = ret.get();
			let (should_quit, should_skip_current_dir) = apply_find_entry(
				walk_entry,
				operand,
				resolved_root,
				deps,
				host,
				matcher,
				&mut current_dir,
				&mut ret_value,
			);
			ret.set(ret_value);
			if should_quit {
				local_quit.set(true);
				Ok(pi_walker::WalkDecision::Stop)
			} else if should_skip_current_dir {
				Ok(pi_walker::WalkDecision::SkipDescend)
			} else {
				Ok(pi_walker::WalkDecision::Include)
			}
		},
		|error| {
			ret.set(1);
			let _ = writeln!(walk_stderr, "Error: {}: {}", error.path.display(), error.error);
			Ok(pi_walker::WalkDecision::Include)
		},
	);
	let mut current_dir = current_dir.into_inner();
	let mut ret_value = ret.get();
	match status {
		Ok(pi_walker::WalkStatus::Complete | pi_walker::WalkStatus::Stopped) => {
			finish_find_walk(deps, host, matcher, &mut current_dir, &mut ret_value);
			if local_quit.get() {
				*quit = true;
			}
			ret_value
		},
		Err(pi_walker::WalkError::Interrupted(err)) => {
			ret_value = 1;
			let _ = writeln!(host.stderr, "Error: {err}");
			finish_find_walk(deps, host, matcher, &mut current_dir, &mut ret_value);
			ret_value
		},
		Err(pi_walker::WalkError::InvalidData { path, message }) => {
			ret_value = 1;
			let _ = writeln!(host.stderr, "Error: {}: {message}", path.display());
			finish_find_walk(deps, host, matcher, &mut current_dir, &mut ret_value);
			ret_value
		},
	}
}

fn process_dir(
	dir: &str,
	config: &Config,
	deps: &dyn Dependencies,
	host: &mut Host,
	matcher: &dyn matchers::Matcher,
	quit: &mut bool,
) -> i32 {
	let resolved_root = host.resolve(dir);
	let operand = Path::new(dir);
	if config.min_depth > config.max_depth {
		let mut current_dir = None;
		let mut ret = 0;
		finish_find_walk(deps, host, matcher, &mut current_dir, &mut ret);
		return ret;
	}
	process_dir_walk_request(config, deps, host, matcher, quit, &resolved_root, operand)
}

fn do_find(args: &[&str], deps: &dyn Dependencies, host: &mut Host) -> Result<i32, Box<dyn Error>> {
	let paths_and_matcher = parse_args(args, host)?;
	if paths_and_matcher.config.help_requested {
		print_help(host);
		return Ok(0);
	}
	if paths_and_matcher.config.version_requested {
		print_version(host);
		return Ok(0);
	}

	let mut ret = 0;
	let mut quit = false;
	for path in paths_and_matcher.paths {
		let dir_ret = process_dir(
			&path,
			&paths_and_matcher.config,
			deps,
			host,
			&*paths_and_matcher.matcher,
			&mut quit,
		);
		if dir_ret != 0 {
			ret = dir_ret;
		}
		if quit {
			break;
		}
	}

	Ok(ret)
}

fn print_help(host: &mut Host) {
	let _ = writeln!(
		&mut host.stdout,
		r"Usage: find [path...] [expression]

If no path is supplied then the current working directory is used by default.

Early alpha implementation. Currently the only expressions supported are
 -print
 -print0
 -printf
 -name case-sensitive_filename_pattern
 -lname case-sensitive_filename_pattern
 -iname case-insensitive_filename_pattern
 -ilname case-insensitive_filename_pattern
 -regextype type
 -files0-from
 -regex pattern
 -iregex pattern
 -type type_char[,type_char...]
    type_char is one of f d l b c p s w
 -size [+-]N[bcwkMGTP]
 -delete
 -prune
 -not
 -a
 -o[r]
 ,
 ()
 -true
 -false
 -maxdepth N
 -mindepth N
 -d[epth]
 -xdev
 -ctime [+-]N
 -atime [+-]N
 -mtime [+-]N
 -perm [-/+]{{octal|u=rwx,go=w}}
 -newer path_to_file
 -exec[dir] executable [args] [{{}}] [more args] ;
 -sorted
    a non-standard extension that sorts directory contents by name before
    processing them. Less efficient, but allows for deterministic output.
"
	);
}

fn print_version(host: &mut Host) {
	let _ = writeln!(host.stdout, "find (Rust) 0.8.0");
}


fn rewrite_bsd_invocation(args: &[&str], host: &mut Host) -> Option<Vec<String>> {
	if !args.contains(&"-E") {
		return None;
	}
	let Err(error) = parse_args(args, host) else {
		return None;
	};
	if !error.to_string().contains("Unrecognized flag: '-E'") {
		return None;
	}

	let mut rewritten: Vec<String> = args
		.iter()
		.filter(|arg| **arg != "-E")
		.map(|arg| (*arg).to_string())
		.collect();

	let mut i = 0;
	while i < rewritten.len() {
		match rewritten[i].as_str() {
			"-O0" | "-O1" | "-O2" | "-O3" | "-H" | "-L" | "-P" | "-x" | "-s" => i += 1,
			"--" => {
				i += 1;
				break;
			},
			_ => break,
		}
	}
	while i < rewritten.len()
		&& (rewritten[i] == "-" || !rewritten[i].starts_with('-'))
		&& rewritten[i] != "!"
		&& rewritten[i] != "("
	{
		i += 1;
	}
	rewritten.splice(i..i, ["-regextype".to_string(), "posix-extended".to_string()]);
	Some(rewritten)
}


pub(crate) struct Find {
	matches: ArgMatches,
}

matches_parser!(Find, app);

fn app() -> Command {
	Command::new("find").version("0.8.0").arg(
		Arg::new("args")
			.action(ArgAction::Append)
			.num_args(0..)
			.allow_hyphen_values(true)
			.trailing_var_arg(true)
			.value_parser(OsStringValueParser::new()),
	)
}

impl Utility for Find {
	const NAME: &'static str = "find";

	fn run(self, host: &mut Host) -> i32 {
		let owned: Vec<String> = self
			.matches
			.get_many::<std::ffi::OsString>("args")
			.into_iter()
			.flatten()
			.map(|arg| arg.to_string_lossy().into_owned())
			.collect();
		let raw: Vec<&str> = owned.iter().map(String::as_str).collect();
		let rewritten = rewrite_bsd_invocation(&raw, host);
		let args: Vec<&str> = match &rewritten {
			Some(args) => args.iter().map(String::as_str).collect(),
			None => raw,
		};
		let deps = StandardDependencies::new(host);
		match do_find(&args, &deps, host) {
			Ok(code) => code,
			Err(error) => {
				let _ = writeln!(host.stderr, "Error: {error}");
				1
			},
		}
	}
}


pub(crate) fn find_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Find, SE>()
}


