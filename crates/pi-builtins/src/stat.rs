



use brush_core::{ShellExtensions, builtins::Registration};

use crate::host::util;

#[cfg(not(any(unix, windows)))]
use crate::host::{self, Host, Utility, matches_parser};

#[cfg(any(unix, windows))]
use imp::Stat;

#[cfg(not(any(unix, windows)))]
struct Stat {
	matches: clap::ArgMatches,
}

#[cfg(not(any(unix, windows)))]
matches_parser!(Stat, app);

#[cfg(not(any(unix, windows)))]
impl Utility for Stat {
	const NAME: &'static str = "stat";

	fn run(self, host: &mut Host) -> i32 {
		let _ = self;
		host.error("unsupported on this platform", 1);
		1
	}
}

#[cfg(not(any(unix, windows)))]
fn app() -> clap::Command {
	clap::Command::new(Stat::NAME)
		.version("0.8.0")
		.about("Display file or file system status.")
		.override_usage(host::format_usage("stat [OPTION]... FILE..."))
}


pub(crate) fn stat_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Stat, SE>()
}

#[cfg(any(unix, windows))]
mod imp {
	#[cfg(unix)]
	use std::os::unix::fs::{FileTypeExt, MetadataExt};
	use std::{
		borrow::Cow,
		cell::OnceCell,
		ffi::{OsStr, OsString},
		fs::{self, FileType, Metadata},
		io::Write,
		path::Path,
	};

	use clap::{Arg, ArgAction, ArgMatches, Command, builder::ValueParser};
	use thiserror::Error;
	#[cfg(windows)]
	use uucore::time::{FormatSystemTimeFallback, format_system_time, system_time_to_sec};
	use uucore::display::Quotable;

	use crate::host::{self, Host, Utility, matches_parser};
	#[cfg(unix)]
	use uucore::{
		entries,
		fs::{display_permissions, major, minor},
		fsext::{
			FsMeta, MetadataTimeField, StatFs, metadata_get_time, pretty_filetype, pretty_fstype,
			read_fs_list, statfs,
		},
		libc::mode_t,
		time::{FormatSystemTimeFallback, format_system_time, system_time_to_sec},
	};

	const ABOUT: &str = "Display file or file system status.";
	const USAGE: &str = "stat [OPTION]... FILE...";
	const AFTER_HELP: &str = "Valid format sequences for files (without `--file-system`):

-`%a`: access rights in octal (note '#' and '0' printf flags)
-`%A`: access rights in human readable form
-`%b`: number of blocks allocated (see %B)
-`%B`: the size in bytes of each block reported by %b
-`%C`: SELinux security context string
-`%d`: device number in decimal
-`%D`: device number in hex
-`%f`: raw mode in hex
-`%F`: file type
-`%g`: group ID of owner
-`%G`: group name of owner
-`%h`: number of hard links
-`%i`: inode number
-`%m`: mount point
-`%n`: file name
-`%N`: quoted file name with dereference (follow) if symbolic link
-`%o`: optimal I/O transfer size hint
-`%s`: total size, in bytes
-`%t`: major device type in hex, for character/block device special files
-`%T`: minor device type in hex, for character/block device special files
-`%u`: user ID of owner
-`%U`: user name of owner
-`%w`: time of file birth, human-readable; - if unknown
-`%W`: time of file birth, seconds since Epoch; 0 if unknown
-`%x`: time of last access, human-readable
-`%X`: time of last access, seconds since Epoch
-`%y`: time of last data modification, human-readable

-`%Y`: time of last data modification, seconds since Epoch
-`%z`: time of last status change, human-readable
-`%Z`: time of last status change, seconds since Epoch

Valid format sequences for file systems:

-`%a`: free blocks available to non-superuser
-`%b`: total data blocks in file system
-`%c`: total file nodes in file system
-`%d`: free file nodes in file system
-`%f`: free blocks in file system
-`%i`: file system ID in hex
-`%l`: maximum length of filenames
-`%n`: file name
-`%s`: block size (for faster transfers)
-`%S`: fundamental block size (for block counts)
-`%t`: file system type in hex
-`%T`: file system type in human readable form

NOTE: your shell may have its own version of stat, which usually supersedes
the version described here.  Please refer to your shell's documentation
for details about the options it supports.";

	#[derive(Debug, Error)]
	enum StatError {
		#[error("Invalid quoting style: {style}")]
		InvalidQuotingStyle { style: String },
		#[error("missing operand\nTry 'stat --help' for more information.")]
		MissingOperand,
		#[error("{directive}: invalid directive")]
		InvalidDirective { directive: String },
		#[error("cannot read table of mounted file systems: {error}")]
		#[cfg_attr(not(unix), allow(dead_code, reason = "mount tables are unix-only"))]
		CannotReadFilesystem { error: String },
		#[error("using '-' to denote standard input does not work in file system mode")]
		#[cfg_attr(not(unix), allow(dead_code, reason = "stdin filesystem mode is unix-only"))]
		StdinFilesystemMode,
		#[error("cannot read file system information for {file}: {error}")]
		CannotReadFilesystemInfo { file: String, error: String },
		#[error("cannot stat {file}: {error}")]
		CannotStat { file: String, error: String },
	}

	mod options {
		pub const DEREFERENCE: &str = "dereference";
		pub const FILE_SYSTEM: &str = "file-system";
		pub const FORMAT: &str = "format";
		pub const PRINTF: &str = "printf";
		pub const TERSE: &str = "terse";
		pub const BSD_SHELL: &str = "bsd-shell";
		pub const BSD_TIMEFMT: &str = "bsd-timefmt";
		pub const FILES: &str = "files";
	}

	#[derive(Default, Debug, PartialEq, Eq, Clone, Copy)]
	struct Flags {
		alter: bool,
		zero:  bool,
		left:  bool,
		space: bool,
		sign:  bool,
		group: bool,
		major: bool,
		minor: bool,
	}





	fn check_bound(slice: &str, bound: usize, beg: usize, end: usize) -> Result<(), StatError> {
		if end >= bound {
			return Err(StatError::InvalidDirective {
				directive: slice[beg..end].quote().to_string(),
			});
		}
		Ok(())
	}

	enum Padding {
		Zero,
		Space,
	}










	fn pad_and_print(out: &mut dyn Write, result: &str, left: bool, width: usize, padding: Padding) {
		let _ = match (left, padding) {
			(false, Padding::Zero) => write!(out, "{result:0>width$}"),
			(false, Padding::Space) => write!(out, "{result:>width$}"),
			(true, Padding::Zero) => write!(out, "{result:0<width$}"),
			(true, Padding::Space) => write!(out, "{result:<width$}"),
		};
	}






	#[cfg(unix)]
	fn pad_and_print_bytes<W: Write>(
		mut writer: W,
		bytes: &[u8],
		left: bool,
		width: usize,
		precision: Precision,
	) -> Result<(), std::io::Error> {
		let display_bytes = match precision {
			Precision::Number(p) if p < bytes.len() => &bytes[..p],
			_ => bytes,
		};

		let display_len = display_bytes.len();
		let padding_needed = width.saturating_sub(display_len);

		let (left_pad, right_pad) = if left {
			(0, padding_needed)
		} else {
			(padding_needed, 0)
		};

		if left_pad > 0 {
			write_padding(&mut writer, left_pad)?;
		}
		writer.write_all(display_bytes)?;
		if right_pad > 0 {
			write_padding(&mut writer, right_pad)?;
		}

		Ok(())
	}




	#[cfg(unix)]
	fn write_padding<W: Write>(writer: &mut W, n: usize) -> Result<(), std::io::Error> {
		for _ in 0..n {
			writer.write_all(b" ")?;
		}
		Ok(())
	}

	#[derive(Debug)]
	pub enum OutputType<'a> {
		Str(String),
		#[cfg_attr(not(unix), allow(dead_code))]
		OsStr(&'a OsString),
		Integer(i64),
		Unsigned(u64),
		UnsignedHex(u64),
		UnsignedOct(u32),
		Timestamp { sec: i64, nsec: u32 },
		Unknown,
	}

	#[derive(Default)]
	enum QuotingStyle {
		Locale,
		Shell,
		#[default]
		ShellEscapeAlways,
		Quote,
	}

	impl std::str::FromStr for QuotingStyle {
		type Err = StatError;

		fn from_str(s: &str) -> Result<Self, Self::Err> {
			match s {
				"locale" => Ok(Self::Locale),
				"shell" => Ok(Self::Shell),
				"shell-escape-always" => Ok(Self::ShellEscapeAlways),

				_ => Err(StatError::InvalidQuotingStyle { style: s.to_string() }),
			}
		}
	}

	#[derive(Debug, PartialEq, Eq, Clone, Copy)]
	enum Precision {
		NotSpecified,
		NoNumber,
		Number(usize),
	}

	#[derive(Debug, PartialEq, Eq)]
	enum Token {
		Char(char),
		Byte(u8),
		Directive { flag: Flags, width: usize, precision: Precision, format: char },
	}

	trait ScanUtil {
		fn scan_num<F>(&self) -> Option<(F, usize)>
		where
			F: std::str::FromStr;
		fn scan_char(&self, radix: u32) -> Option<(char, usize)>;
	}

	impl ScanUtil for str {




		fn scan_num<F>(&self) -> Option<(F, usize)>
		where
			F: std::str::FromStr,
		{
			let mut chars = self.chars();
			let count = chars
				.next()
				.filter(|&c| c.is_ascii_digit() || c == '-' || c == '+')
				.map_or(0, |_| 1 + chars.take_while(char::is_ascii_digit).count());

			if count > 0 {
				F::from_str(&self[..count]).ok().map(|x| (x, count))
			} else {
				None
			}
		}

		fn scan_char(&self, radix: u32) -> Option<(char, usize)> {
			let count = match radix {
				8 => 3,
				16 => 2,
				_ => return None,
			};
			let chars = self.chars().enumerate();
			let mut res = 0;
			let mut offset = 0;
			for (i, c) in chars {
				if i >= count {
					break;
				}
				match c.to_digit(radix) {
					Some(digit) => {
						let tmp = res * radix + digit;
						if tmp < 256 {
							res = tmp;
						} else {
							break;
						}
					},
					None => break,
				}
				offset = i + 1;
			}
			if offset > 0 {
				Some((res as u8 as char, offset))
			} else {
				None
			}
		}
	}

	fn group_num(s: &str) -> Cow<'_, str> {
		let is_negative = s.starts_with('-');
		assert!(is_negative || s.chars().take(1).all(|c| c.is_ascii_digit()));
		assert!(s.chars().skip(1).all(|c| c.is_ascii_digit()));
		if s.len() < 4 {
			return s.into();
		}
		let mut res = String::with_capacity((s.len() - 1) / 3);
		let s = if is_negative {
			res.push('-');
			&s[1..]
		} else {
			s
		};
		let mut alone = (s.len() - 1) % 3 + 1;
		res.push_str(&s[..alone]);
		while alone != s.len() {
			res.push(',');
			res.push_str(&s[alone..alone + 3]);
			alone += 3;
		}
		res.into()
	}

	struct Stater {
		follow:             bool,
		show_fs:            bool,
		from_user:          bool,
		files:              Vec<OsString>,
		time_format:        Option<String>,
		#[cfg_attr(not(unix), allow(dead_code))]
		mount_list:         OnceCell<Option<Vec<OsString>>>,
		#[cfg_attr(not(unix), allow(dead_code))]
		mount_list_needed:  bool,
		default_tokens:     Vec<Token>,
		#[cfg_attr(not(unix), allow(dead_code))]
		default_dev_tokens: Vec<Token>,
	}














	fn print_it(
		out: &mut dyn Write,
		output: &OutputType,
		flags: Flags,
		width: usize,
		precision: Precision,
	) {



































		let padding_char = determine_padding_char(flags);

		match output {
			OutputType::Str(s) => print_str(out, s, flags, width, precision),
			OutputType::OsStr(s) => print_os_str(out, s, flags, width, precision),
			OutputType::Integer(num) => print_integer(out, *num, flags, width, precision, padding_char),
			OutputType::Unsigned(num) => {
				print_unsigned(out, *num, flags, width, precision, padding_char);
			},
			OutputType::UnsignedOct(num) => {
				print_unsigned_oct(out, *num, flags, width, precision, padding_char);
			},
			OutputType::UnsignedHex(num) => {
				print_unsigned_hex(out, *num, flags, width, precision, padding_char);
			},
			OutputType::Timestamp { sec, nsec } => {
				print_timestamp(out, *sec, *nsec, flags, width, precision, padding_char);
			},
			OutputType::Unknown => {
				let _ = write!(out, "?");
			},
		}
	}












	fn determine_padding_char(flags: Flags) -> Padding {
		if flags.zero && !flags.left {
			Padding::Zero
		} else {
			Padding::Space
		}
	}









	fn print_str(out: &mut dyn Write, s: &str, flags: Flags, width: usize, precision: Precision) {
		let s = match precision {
			Precision::Number(p) if p < s.len() => &s[..p],
			_ => s,
		};
		pad_and_print(out, s, flags.left, width, Padding::Space);
	}











	fn print_os_str(
		out: &mut dyn Write,
		s: &OsString,
		flags: Flags,
		width: usize,
		precision: Precision,
	) {



		#[cfg(unix)]
		{
			use std::os::unix::ffi::OsStrExt;

			let bytes = s.as_bytes();

			if pad_and_print_bytes(&mut *out, bytes, flags.left, width, precision)
				.is_err()
			{


				let fallback_string = s.to_string_lossy();
				print_str(out, &fallback_string, flags, width, precision);
			}
		}
		#[cfg(not(unix))]
		{
			print_str(out, &s.to_string_lossy(), flags, width, precision);
		}
	}

	fn quote_file_name(file_name: &str, quoting_style: &QuotingStyle) -> String {
		match quoting_style {
			QuotingStyle::Locale | QuotingStyle::Shell => {
				let escaped = file_name.replace('\'', r"\'");
				format!("'{escaped}'")
			},
			QuotingStyle::ShellEscapeAlways => {
				let quote = if file_name.contains('\'') { '"' } else { '\'' };
				format!("{quote}{file_name}{quote}")
			},
			QuotingStyle::Quote => file_name.to_string(),
		}
	}

	fn get_quoted_file_name(
		display_name: &str,

		resolved: &Path,
		file_type: FileType,
		from_user: bool,
		host: &mut Host,
	) -> Result<String, i32> {
		let quoting_style = host.var("QUOTING_STYLE")
			.and_then(|style| style.parse().ok())
			.unwrap_or_default();

		if file_type.is_symlink() {
			let quoted_display_name = quote_file_name(display_name, &quoting_style);
			match fs::read_link(resolved) {
				Ok(dst) => {
					let quoted_dst = quote_file_name(&dst.to_string_lossy(), &quoting_style);
					Ok(format!("{quoted_display_name} -> {quoted_dst}"))
				},
				Err(e) => {
					host.error(e, 1);
					Err(1)
				},
			}
		} else {
			let style = if from_user {
				quoting_style
			} else {
				QuotingStyle::Quote
			};
			Ok(quote_file_name(display_name, &style))
		}
	}

	#[cfg(unix)]
	fn process_token_filesystem(
		out: &mut dyn Write,
		t: &Token,
		meta: &StatFs,
		display_name: &str,
	) {
		match *t {
			Token::Byte(byte) => write_raw_byte(out, byte),
			Token::Char(c) => {
				let _ = write!(out, "{c}");
			},
			Token::Directive { flag, width, precision, format } => {
				let output = match format {

					'a' => OutputType::Unsigned(meta.avail_blocks()),

					'b' => OutputType::Unsigned(meta.total_blocks()),

					'c' => OutputType::Unsigned(meta.total_file_nodes()),

					'd' => OutputType::Unsigned(meta.free_file_nodes()),

					'f' => OutputType::Unsigned(meta.free_blocks()),

					'i' => OutputType::UnsignedHex(meta.fsid()),

					'l' => OutputType::Unsigned(meta.namelen()),

					'n' => OutputType::Str(display_name.to_string()),

					's' => OutputType::Unsigned(meta.io_size()),

					'S' => OutputType::Integer(meta.block_size()),

					't' => OutputType::UnsignedHex(meta.fs_type() as u64),

					'T' => OutputType::Str(pretty_fstype(meta.fs_type()).into()),
					_ => OutputType::Unknown,
				};

				print_it(out, &output, flag, width, precision);
			},
		}
	}












	fn print_integer(
		out: &mut dyn Write,
		num: i64,
		flags: Flags,
		width: usize,
		precision: Precision,
		padding_char: Padding,
	) {
		let num = num.to_string();
		let arg = if flags.group {
			group_num(&num)
		} else {
			Cow::Borrowed(num.as_str())
		};
		let prefix = if flags.sign {
			"+"
		} else if flags.space {
			" "
		} else {
			""
		};
		let extended = match precision {
			Precision::NotSpecified => format!("{prefix}{arg}"),
			Precision::NoNumber => format!("{prefix}{arg}"),
			Precision::Number(p) => format!("{prefix}{arg:0>p$}"),
		};
		pad_and_print(out, &extended, flags.left, width, padding_char);
	}





	fn timestamp_string(sec: i64, nsec: u32, precision: Precision) -> String {
		match precision {
			Precision::NotSpecified | Precision::Number(0) => sec.to_string(),
			Precision::NoNumber => format!("{sec}.{nsec:09}"),
			Precision::Number(p) if p <= 9 => {
				let frac = format!("{nsec:09}");
				format!("{sec}.{}", &frac[..p])
			},
			Precision::Number(p) => format!("{sec}.{nsec:09}{:0<pad$}", "", pad = p - 9),
		}
	}

	fn print_timestamp(
		out: &mut dyn Write,
		sec: i64,
		nsec: u32,
		flags: Flags,
		width: usize,
		precision: Precision,
		padding_char: Padding,
	) {
		let prefix = if flags.sign {
			"+"
		} else if flags.space {
			" "
		} else {
			""
		};
		let extended = format!("{prefix}{}", timestamp_string(sec, nsec, precision));
		pad_and_print(out, &extended, flags.left, width, padding_char);
	}












	fn print_unsigned(
		out: &mut dyn Write,
		num: u64,
		flags: Flags,
		width: usize,
		precision: Precision,
		padding_char: Padding,
	) {
		let num = num.to_string();
		let s = if flags.group {
			group_num(&num)
		} else {
			Cow::Borrowed(num.as_str())
		};
		let s = match precision {
			Precision::NotSpecified => s,
			Precision::NoNumber => s,
			Precision::Number(p) => format!("{s:0>p$}").into(),
		};
		pad_and_print(out, &s, flags.left, width, padding_char);
	}













	fn print_unsigned_oct(
		out: &mut dyn Write,
		num: u32,
		flags: Flags,
		width: usize,
		precision: Precision,
		padding_char: Padding,
	) {
		let prefix = if flags.alter { "0" } else { "" };
		let s = match precision {
			Precision::NotSpecified => format!("{prefix}{num:o}"),
			Precision::NoNumber => format!("{prefix}{num:o}"),
			Precision::Number(p) => format!("{prefix}{num:0>p$o}"),
		};
		pad_and_print(out, &s, flags.left, width, padding_char);
	}













	fn print_unsigned_hex(
		out: &mut dyn Write,
		num: u64,
		flags: Flags,
		width: usize,
		precision: Precision,
		padding_char: Padding,
	) {
		let prefix = if flags.alter { "0x" } else { "" };
		let s = match precision {
			Precision::NotSpecified => format!("{prefix}{num:x}"),
			Precision::NoNumber => format!("{prefix}{num:x}"),
			Precision::Number(p) => format!("{prefix}{num:0>p$x}"),
		};
		pad_and_print(out, &s, flags.left, width, padding_char);
	}

	fn write_raw_byte(out: &mut dyn Write, byte: u8) {
		let _ = out.write_all(&[byte]);
	}

	impl Stater {
		fn process_flags(chars: &[char], i: &mut usize, bound: usize, flag: &mut Flags) {
			while *i < bound {
				match chars[*i] {
					'#' => flag.alter = true,
					'0' => flag.zero = true,
					'-' => flag.left = true,
					' ' => flag.space = true,



					'I' => flag.space = true,
					'+' => flag.sign = true,
					'\'' => flag.group = true,
					_ => break,
				}
				*i += 1;
			}
		}





		fn char_index_to_byte_index(format_str: &str, char_index: usize) -> usize {
			format_str
				.char_indices()
				.nth(char_index)
				.map_or(format_str.len(), |(byte_idx, _)| byte_idx)
		}

		fn handle_percent_case(
			chars: &[char],
			i: &mut usize,
			bound: usize,
			format_str: &str,
		) -> Result<Token, StatError> {
			let old = *i;

			*i += 1;
			if *i >= bound {
				return Ok(Token::Char('%'));
			}
			if chars[*i] == '%' {
				return Ok(Token::Char('%'));
			}

			let mut flag = Flags::default();

			Self::process_flags(chars, i, bound, &mut flag);

			let mut width = 0;
			let mut precision = Precision::NotSpecified;
			let mut j = *i;

			let j_byte = Self::char_index_to_byte_index(format_str, j);
			if let Some((field_width, offset)) = format_str[j_byte..].scan_num::<usize>() {
				width = field_width;
				j += offset;


				if j >= bound || chars[j] == '%' {
					let invalid_directive: String = chars[old..=j.min(bound - 1)].iter().collect();
					return Err(StatError::InvalidDirective {
						directive: invalid_directive.quote().to_string(),
					});
				}
			}
			check_bound(format_str, bound, old, j)?;

			if chars[j] == '.' {
				j += 1;
				check_bound(format_str, bound, old, j)?;

				let j_byte = Self::char_index_to_byte_index(format_str, j);
				match format_str[j_byte..].scan_num::<i32>() {
					Some((value, offset)) => {
						if value >= 0 {
							precision = Precision::Number(value as usize);
						}
						j += offset;
					},
					None => precision = Precision::NoNumber,
				}
				check_bound(format_str, bound, old, j)?;
			}

			*i = j;


			if *i + 1 < bound
				&& let Some(&next_char) = chars.get(*i + 1)
				&& (chars[*i] == 'H' || chars[*i] == 'L')
				&& (next_char == 'd' || next_char == 'r')
			{
				flag.major = chars[*i] == 'H';
				flag.minor = chars[*i] == 'L';
				*i += 1;
				return Ok(Token::Directive { flag, width, precision, format: next_char });
			}

			Ok(Token::Directive { flag, width, precision, format: chars[*i] })
		}

		fn handle_escape_sequences(
			chars: &[char],
			i: &mut usize,
			bound: usize,
			format_str: &str,
			err: &mut dyn Write,
		) -> Token {
			*i += 1;
			if *i >= bound {

				let _ = writeln!(err, "stat: warning: backslash at end of format");
				return Token::Char('\\');
			}
			match chars[*i] {
				'a' => Token::Byte(0x07),
				'b' => Token::Byte(0x08),
				'f' => Token::Byte(0x0c),
				'n' => Token::Byte(0x0a),
				'r' => Token::Byte(0x0d),
				't' => Token::Byte(0x09),
				'\\' => Token::Byte(b'\\'),
				'\'' => Token::Byte(b'\''),
				'"' => Token::Byte(b'"'),
				'0'..='7' => {

					let mut value = 0u8;
					let mut count = 0;
					while *i < bound && count < 3 {
						if let Some(digit) = chars[*i].to_digit(8) {
							value = value * 8 + digit as u8;
							*i += 1;
							count += 1;
						} else {
							break;
						}
					}
					*i -= 1;
					Token::Byte(value)
				},
				'x' => {


					if *i + 1 < bound {
						let byte_index = Self::char_index_to_byte_index(format_str, *i + 1);
						if let Some((c, offset)) = format_str[byte_index..].scan_char(16) {
							*i += offset;
							Token::Byte(c as u8)
						} else {

							let _ = writeln!(
								err,
								"stat: warning: unrecognized escape '\\x'"
							);
							Token::Byte(b'x')
						}
					} else {

						let _ = writeln!(
							err,
							"stat: warning: incomplete hex escape '\\x'"
						);
						Token::Byte(b'x')
					}
				},
				other => {

					let _ = writeln!(
						err,
						"stat: warning: unrecognized escape '\\{other}'"
					);
					Token::Byte(other as u8)
				},
			}
		}

		fn generate_tokens(
			format_str: &str,
			use_printf: bool,
			err: &mut dyn Write,
		) -> Result<Vec<Token>, StatError> {
			let mut tokens = Vec::new();
			let chars = format_str.chars().collect::<Vec<char>>();
			let bound = chars.len();
			let mut i = 0;
			while i < bound {
				match chars.get(i) {
					Some('%') => {
						tokens.push(Self::handle_percent_case(&chars, &mut i, bound, format_str)?);
					},
					Some('\\') => {
						if use_printf {
							tokens.push(Self::handle_escape_sequences(&chars, &mut i, bound, format_str, err));
						} else {
							tokens.push(Token::Char('\\'));
						}
					},
					Some(c) => tokens.push(Token::Char(*c)),
					None => break,
				}
				i += 1;
			}
			if !use_printf && !format_str.ends_with('\n') {
				tokens.push(Token::Char('\n'));
			}
			Ok(tokens)
		}

		#[cfg(unix)]
		fn populate_mount_list() -> Result<Vec<OsString>, StatError> {
			let mut mount_list = read_fs_list()
				.map_err(|e| StatError::CannotReadFilesystem { error: e.to_string() })?
				.iter()
				.map(|mi| mi.mount_dir.clone())
				.collect::<Vec<_>>();


			mount_list.sort();
			mount_list.reverse();

			Ok(mount_list)
		}

		fn new(matches: &ArgMatches, host: &mut Host) -> Result<Self, StatError> {
			let files: Vec<OsString> = matches
				.get_many::<OsString>(options::FILES)
				.map(|v| v.map(OsString::from).collect())
				.unwrap_or_default();
			if files.is_empty() {
				return Err(StatError::MissingOperand);
			}
			let format_str = if matches.contains_id(options::PRINTF) {
				matches
					.get_one::<String>(options::PRINTF)
					.expect("Invalid format string")
			} else {
				matches
					.get_one::<String>(options::FORMAT)
					.map_or("", |s| s.as_str())
			};

			let use_printf = matches.contains_id(options::PRINTF);
			let terse = matches.get_flag(options::TERSE);
			let show_fs = matches.get_flag(options::FILE_SYSTEM);

			let default_tokens = if format_str.is_empty() {
				Self::generate_tokens(
					&Self::default_format(show_fs, terse, false),
					use_printf,
					&mut host.stderr,
				)?
			} else {
				Self::generate_tokens(format_str, use_printf, &mut host.stderr)?
			};
			let default_dev_tokens =
				Self::generate_tokens(
					&Self::default_format(show_fs, terse, true),
					use_printf,
					&mut host.stderr,
				)?;



			let mount_list_needed = !show_fs
				&& default_tokens
					.iter()
					.any(|tok| matches!(tok, Token::Directive { format: 'm', .. }));

			Ok(Self {
				follow: matches.get_flag(options::DEREFERENCE),
				show_fs,
				from_user: !format_str.is_empty(),
				files,
				time_format: matches.get_one::<String>(options::BSD_TIMEFMT).cloned(),
				mount_list: OnceCell::new(),
				mount_list_needed,
				default_tokens,
				default_dev_tokens,
			})
		}



		fn time_fmt(&self) -> &str {
			self.time_format.as_deref().unwrap_or(PRETTY_DATETIME_FORMAT)
		}

		#[cfg(unix)]
		fn find_mount_point<P: AsRef<Path>>(
			&self,
			p: P,
			host: &mut Host,
		) -> Option<&OsString> {
			if !self.mount_list_needed {
				return None;
			}

			let mount_list = self.mount_list.get_or_init(|| {
				match Self::populate_mount_list() {
					Ok(list) => Some(list),
					Err(e) => {


						let _ = writeln!(
							&mut host.stderr,
							"stat: warning: cannot read table of mounted file systems: {e}"
						);
						None
					},
				}
			});

			let path = p.as_ref().canonicalize().ok()?;
			mount_list
				.as_ref()?
				.iter()
				.find(|root| path.starts_with(root))
		}

		#[cfg(unix)]
		fn exec(&self, host: &mut Host) -> i32 {
			let mut stdin_is_fifo = false;
			if let Ok(md) = fs::metadata("/dev/stdin") {
				stdin_is_fifo = md.file_type().is_fifo();
			}

			let mut ret = 0;
			for f in &self.files {
				ret |= self.do_stat(f, stdin_is_fifo, host);
			}
			ret
		}

		#[cfg(unix)]
		fn process_token_files(
			&self,
			t: &Token,
			meta: &Metadata,
			display_name: &str,




			resolved: &Path,
			file_type: FileType,
			from_user: bool,
			host: &mut Host,
		) -> Result<(), i32> {
			match *t {
				Token::Byte(byte) => write_raw_byte(&mut host.stdout, byte),
				Token::Char(c) => {
					let _ = write!(host.stdout, "{c}");
				},

				Token::Directive { flag, width, precision, format } => {
					let output = match format {

						'a' => OutputType::UnsignedOct(0o7777 & meta.mode()),

						'A' => OutputType::Str(display_permissions(meta, true)),

						'b' => OutputType::Unsigned(meta.blocks()),




						'B' => OutputType::Unsigned(512),


						'C' => OutputType::Str("unsupported for this operating system".to_string()),

						'd' if flag.major => OutputType::Unsigned(major(meta.dev() as _) as u64),
						'd' if flag.minor => OutputType::Unsigned(minor(meta.dev() as _) as u64),
						'd' => OutputType::Unsigned(meta.dev()),

						'D' => OutputType::UnsignedHex(meta.dev()),

						'f' => OutputType::UnsignedHex(meta.mode() as u64),

						'F' => OutputType::Str(pretty_filetype(meta.mode() as mode_t, meta.len())),

						'g' => OutputType::Unsigned(meta.gid() as u64),

						'G' => {
							let group_name =
								entries::gid2grp(meta.gid()).unwrap_or_else(|_| "UNKNOWN".to_owned());
							OutputType::Str(group_name)
						},

						'h' => OutputType::Unsigned(meta.nlink()),

						'i' => OutputType::Unsigned(meta.ino()),

						'm' => match self.find_mount_point(resolved, host) {
							Some(s) => OutputType::OsStr(s),
							None => OutputType::Str(String::new()),
						},

						'n' => OutputType::Str(display_name.to_string()),

						'N' => {
							let file_name =
								get_quoted_file_name(display_name, resolved, file_type, from_user, host)?;
							OutputType::Str(file_name)
						},

						'o' => OutputType::Unsigned(meta.blksize()),

						's' => OutputType::Integer(meta.len() as i64),


						't' => OutputType::UnsignedHex(major(meta.rdev() as _) as u64),


						'T' => OutputType::UnsignedHex(minor(meta.rdev() as _) as u64),

						'u' => OutputType::Unsigned(meta.uid() as u64),

						'U' => {
							let user_name =
								entries::uid2usr(meta.uid()).unwrap_or_else(|_| "UNKNOWN".to_owned());
							OutputType::Str(user_name)
						},


						'w' => OutputType::Str(pretty_time(meta, MetadataTimeField::Birth, self.time_fmt())),

						'W' => {
							let (sec, nsec) = metadata_get_time(meta, MetadataTimeField::Birth)
								.map_or((0, 0), system_time_to_sec);
							OutputType::Timestamp { sec, nsec }
						},

						'x' => OutputType::Str(pretty_time(meta, MetadataTimeField::Access, self.time_fmt())),

						'X' => {
							let (sec, nsec) = metadata_get_time(meta, MetadataTimeField::Access)
								.map_or((0, 0), system_time_to_sec);
							OutputType::Timestamp { sec, nsec }
						},

						'y' => OutputType::Str(pretty_time(meta, MetadataTimeField::Modification, self.time_fmt())),

						'Y' => {
							let (sec, nsec) = metadata_get_time(meta, MetadataTimeField::Modification)
								.map_or((0, 0), system_time_to_sec);
							OutputType::Timestamp { sec, nsec }
						},

						'z' => OutputType::Str(pretty_time(meta, MetadataTimeField::Change, self.time_fmt())),

						'Z' => {
							let (sec, nsec) = metadata_get_time(meta, MetadataTimeField::Change)
								.map_or((0, 0), system_time_to_sec);
							OutputType::Timestamp { sec, nsec }
						},
						'R' => OutputType::UnsignedHex(meta.rdev()),
						'r' if flag.major => OutputType::Unsigned(major(meta.rdev() as _) as u64),
						'r' if flag.minor => OutputType::Unsigned(minor(meta.rdev() as _) as u64),
						'r' => OutputType::Unsigned(meta.rdev()),
						_ => OutputType::Unknown,
					};
					print_it(&mut host.stdout, &output, flag, width, precision);
				},
			}
			Ok(())
		}

		#[cfg(unix)]
		fn do_stat(&self, file: &OsStr, stdin_is_fifo: bool, host: &mut Host) -> i32 {
			let display_name = file.to_string_lossy();
			let file = if display_name == "-" {
				if self.show_fs {

					let _ =
						writeln!(&mut host.stderr, "stat: {}", StatError::StdinFilesystemMode);
					return 1;
				}
				if let Ok(p) = Path::new("/dev/stdin").canonicalize() {
					p.into_os_string()
				} else {
					OsString::from("/dev/stdin")
				}
			} else {
				OsString::from(file)
			};


			let resolved = host.resolve(&file);
			if self.show_fs {
				match statfs(resolved.as_os_str()) {
					Ok(meta) => {
						let tokens = &self.default_tokens;


						for t in tokens {
							process_token_filesystem(&mut host.stdout, t, &meta, &display_name);
						}
					},
					Err(error) => {

						let _ = writeln!(
							&mut host.stderr,
							"stat: {}",
							StatError::CannotReadFilesystemInfo {
								file: display_name.quote().to_string(),
								error,
							}
						);
						return 1;
					},
				}
			} else {
				let follow_symbolic_links = self.follow || stdin_is_fifo && display_name == "-";
				let result = if follow_symbolic_links {
					fs::metadata(&resolved)
				} else {
					fs::symlink_metadata(&resolved)
				};
				match result {
					Ok(meta) => {
						let file_type = meta.file_type();
						let tokens = if self.from_user
							|| !(file_type.is_char_device() || file_type.is_block_device())
						{
							&self.default_tokens
						} else {
							&self.default_dev_tokens
						};

						for t in tokens {
							if let Err(code) = self.process_token_files(
								t,
								&meta,
								&display_name,
								&resolved,
								file_type,
								self.from_user,
								host,
							) {
								return code;
							}
						}
					},
					Err(e) => {

						let _ = writeln!(&mut host.stderr, "stat: {}", StatError::CannotStat {
							file:  display_name.quote().to_string(),
							error: e.to_string(),
						});
						return 1;
					},
				}
			}
			0
		}

		fn default_format(show_fs: bool, terse: bool, show_dev_type: bool) -> String {



			if show_fs {
				if terse {
					"%n %i %l %t %s %S %b %f %a %c %d\n".into()
				} else {
					"  File: \"%n\"\n    ID: %-8i Namelen: %-7l Type: %T\nBlock size: %-10s Fundamental \
					 block size: %S\nBlocks: Total: %-10b Free: %-10f Available: %a\nInodes: Total: \
					 %-10c Free: %d\n"
						.into()
				}
			} else if terse {
				"%n %s %b %f %u %g %D %i %h %t %T %X %Y %Z %W %o\n".into()
			} else {
				let device_line = if show_dev_type {
					"Device: %Hd,%Ld\tInode: %-10i  Links: %-5h Device type: %t,%T\n"
				} else {
					"Device: %Hd,%Ld\tInode: %-10i  Links: %h\n"
				};

				format!(
					"  File: %N\n  size: %-10s\tBlocks: %-10b IO Block: %-6o %F\n{device_line}Access: \
					 (%04a/%10.10A)  Uid: (%5u/%8U)   Gid: (%5g/%8G)\nAccess: %x\nModify: %y\nChange: \
					 %z\n Birth: %w\n"
				)
			}
		}
	}

















	fn rewrite_bsd_invocation(argv: &[OsString]) -> Option<Result<Vec<OsString>, String>> {
		let toks: Vec<Cow<'_, str>> = argv.iter().map(|a| a.to_string_lossy()).collect();
		let mut detected = false;
		for (idx, tok) in toks.iter().enumerate().skip(1) {
			if tok.as_ref() == "--" {
				break;
			}
			let Some(cluster) = tok.strip_prefix('-') else {
				continue;
			};
			if cluster.is_empty() || cluster.starts_with('-') {
				continue;
			}


			if cluster
				.chars()
				.all(|c| matches!(c, 'L' | 'n' | 'q' | 'F' | 's' | 'x'))
				&& cluster.chars().any(|c| matches!(c, 's' | 'x'))
			{
				detected = true;
				break;
			}
			let Some(fpos) = cluster.find('f') else {
				continue;
			};
			if !cluster[..fpos]
				.chars()
				.all(|c| matches!(c, 'L' | 'n' | 'q' | 'F' | 's' | 'x'))
			{
				continue;
			}
			let attached = &cluster[fpos + 1..];
			let format = if attached.is_empty() {
				toks.get(idx + 1).map(Cow::as_ref)
			} else {
				Some(attached)
			};
			if format.is_some_and(|f| f.contains('%')) {
				detected = true;
				break;
			}
		}
		if !detected {
			return None;
		}
		Some(bsd_to_gnu_argv(argv, &toks))
	}


	enum BsdStyle {

		Custom(String),

		Shell,

		Verbose,
	}


	fn bsd_to_gnu_argv(argv: &[OsString], toks: &[Cow<'_, str>]) -> Result<Vec<OsString>, String> {
		let mut follow = false;
		let mut no_newline = false;
		let mut style: Option<BsdStyle> = None;
		let mut timefmt: Option<String> = None;
		let mut files: Vec<OsString> = Vec::new();

		let mut i = 1;
		while i < toks.len() {
			if toks[i].as_ref() == "--" {
				files.extend_from_slice(&argv[i + 1..]);
				break;
			}
			let cluster: Vec<char> = match toks[i].strip_prefix('-') {
				Some(c) if !c.is_empty() && !c.starts_with('-') => c.chars().collect(),

				_ => {
					files.push(argv[i].clone());
					i += 1;
					continue;
				},
			};
			let mut consumed_next = false;
			let mut k = 0;
			while k < cluster.len() {
				match cluster[k] {
					'L' => follow = true,
					'n' => no_newline = true,


					'q' | 'F' => {},

					's' => style = Some(BsdStyle::Shell),
					'x' => style = Some(BsdStyle::Verbose),
					c @ ('f' | 't') => {


						let value: String = if k + 1 < cluster.len() {
							cluster[k + 1..].iter().collect()
						} else {
							consumed_next = true;
							match toks.get(i + 1) {
								Some(v) => v.to_string(),
								None => return Err(format!("option '-{c}' requires an argument")),
							}
						};
						if c == 'f' {
							style = Some(BsdStyle::Custom(value));
						} else {
							timefmt = Some(value);
						}
						break;
					},
					other => {
						return Err(format!(
							"option '-{other}' is not supported (BSD stat compatibility)"
						));
					},
				}
				k += 1;
			}
			i += 1 + usize::from(consumed_next);
		}

		let mut out: Vec<OsString> = Vec::with_capacity(files.len() + 7);
		out.push(argv[0].clone());
		if follow {
			out.push("-L".into());
		}
		match style {



			Some(BsdStyle::Shell) => out.push("--bsd-shell".into()),
			Some(BsdStyle::Verbose) => {
				out.push("--bsd-timefmt".into());
				out.push(timefmt.unwrap_or_else(|| BSD_VERBOSE_TIMEFMT.into()).into());
				out.push(if no_newline { "--printf".into() } else { "-c".into() });
				out.push(BSD_VERBOSE_FORMAT.into());
			},
			Some(BsdStyle::Custom(format)) => {
				let translated = translate_bsd_format(&format, no_newline)?;
				if let Some(timefmt) = timefmt {
					out.push("--bsd-timefmt".into());
					out.push(timefmt.into());
				}



				out.push(if no_newline { "--printf".into() } else { "-c".into() });
				out.push(translated.into());
			},
			None => return Err("BSD-style '-f' expects a format string".to_string()),
		}
		out.push("--".into());
		out.extend(files);
		Ok(out)
	}






	fn translate_bsd_format(fmt: &str, printf_mode: bool) -> Result<String, String> {
		let chars: Vec<char> = fmt.chars().collect();
		let mut out = String::with_capacity(fmt.len() + 8);
		let mut i = 0;
		while i < chars.len() {
			if chars[i] != '%' {
				if printf_mode && chars[i] == '\\' {
					out.push_str(r"\\");
				} else {
					out.push(chars[i]);
				}
				i += 1;
				continue;
			}
			let start = i;
			i += 1;
			if i >= chars.len() {
				out.push('%');
				break;
			}
			if chars[i] == '%' {
				out.push_str("%%");
				i += 1;
				continue;
			}


			let mut spec = String::new();
			while i < chars.len() && matches!(chars[i], '#' | '+' | '-' | '0' | ' ') {
				spec.push(chars[i]);
				i += 1;
			}
			while i < chars.len() && chars[i].is_ascii_digit() {
				spec.push(chars[i]);
				i += 1;
			}
			if i < chars.len() && chars[i] == '.' {
				spec.push('.');
				i += 1;
				while i < chars.len() && chars[i].is_ascii_digit() {
					spec.push(chars[i]);
					i += 1;
				}
			}




			let mut string_form = false;
			if i < chars.len() && matches!(chars[i], 'D' | 'O' | 'U' | 'X' | 'F' | 'S') {
				string_form = chars[i] == 'S';
				i += 1;
			}
			let mut sub = None;
			if i < chars.len() && matches!(chars[i], 'H' | 'M' | 'L') {
				sub = Some(chars[i]);
				i += 1;
			}
			let Some(&datum) = chars.get(i) else {
				return Err(unsupported_bsd_directive(&chars[start..]));
			};
			i += 1;
			let gnu: &str = match datum {


				'm' => {
					if string_form {
						"y"
					} else {
						"Y"
					}
				},
				'a' => {
					if string_form {
						"x"
					} else {
						"X"
					}
				},
				'c' => {
					if string_form {
						"z"
					} else {
						"Z"
					}
				},
				'B' => {
					if string_form {
						"w"
					} else {
						"W"
					}
				},

				'N' => "n",

				'z' => "s",

				'u' => {
					if string_form {
						"U"
					} else {
						"u"
					}
				},
				'g' => {
					if string_form {
						"G"
					} else {
						"g"
					}
				},

				'p' if string_form => "A",
				'p' if matches!(sub, None | Some('L')) => "a",

				'i' => "i",
				'l' => "h",
				'd' => match sub {
					Some('H') => "Hd",
					Some('L') => "Ld",
					None => "d",
					Some(_) => return Err(unsupported_bsd_directive(&chars[start..i])),
				},
				'r' => match sub {
					Some('H') => "Hr",
					Some('L') => "Lr",
					None => "r",
					Some(_) => return Err(unsupported_bsd_directive(&chars[start..i])),
				},
				'b' => "b",
				'k' => "o",

				'T' => "F",

				'n' => {
					out.push('\n');
					continue;
				},
				't' => {
					out.push('\t');
					continue;
				},
				_ => return Err(unsupported_bsd_directive(&chars[start..i])),
			};
			out.push('%');
			out.push_str(&spec);
			out.push_str(gnu);
		}
		Ok(out)
	}

	fn unsupported_bsd_directive(directive: &[char]) -> String {
		let directive: String = directive.iter().collect();
		format!("unsupported BSD format directive '{directive}'")
	}


	const BSD_VERBOSE_FORMAT: &str = concat!(
		"  File: \"%n\"\n",
		"  Size: %-11s  FileType: %F\n",
		"  Mode: (%04a/%.10A)         Uid: (%5u/%8U)  Gid: (%5g/%8G)\n",
		"Device: %Hd,%Ld   Inode: %i    Links: %h\n",
		"Access: %x\n",
		"Modify: %y\n",
		"Change: %z\n",
		" Birth: %w",
	);


	const BSD_VERBOSE_TIMEFMT: &str = "%a %b %e %H:%M:%S %Y";



	fn bsd_shell_exec(matches: &ArgMatches, host: &mut Host) -> i32 {
		let files: Vec<OsString> = matches
			.get_many::<OsString>(options::FILES)
			.map(|v| v.cloned().collect())
			.unwrap_or_default();
		if files.is_empty() {
			host.error(StatError::MissingOperand, 1);
			return 1;
		}
		let follow = matches.get_flag(options::DEREFERENCE);
		let mut ret = 0;
		for file in &files {
			let display_name = file.to_string_lossy();
			let resolved = host.resolve(file);
			let result = if follow {
				fs::metadata(&resolved)
			} else {
				fs::symlink_metadata(&resolved)
			};
			match result {
				Ok(meta) => {
					let _ = writeln!(host.stdout, "{}", bsd_shell_line(&meta, &resolved));
				},
				Err(e) => {
					let _ = writeln!(&mut host.stderr, "stat: {}", StatError::CannotStat {
						file:  display_name.quote().to_string(),
						error: e.to_string(),
					});
					ret = 1;
				},
			}
		}
		ret
	}

	#[cfg(unix)]
	fn bsd_shell_line(meta: &Metadata, _resolved: &Path) -> String {
		#[cfg(target_os = "macos")]
		let flags = std::os::macos::fs::MetadataExt::st_flags(meta);
		#[cfg(not(target_os = "macos"))]
		let flags = 0u32;
		let birth = metadata_get_time(meta, MetadataTimeField::Birth)
			.map_or(0, |t| system_time_to_sec(t).0);
		format!(
			"st_dev={} st_ino={} st_mode=0{:o} st_nlink={} st_uid={} st_gid={} st_rdev={} \
			 st_size={} st_atime={} st_mtime={} st_ctime={} st_birthtime={birth} st_blksize={} \
			 st_blocks={} st_flags={flags}",
			meta.dev(),
			meta.ino(),
			meta.mode(),
			meta.nlink(),
			meta.uid(),
			meta.gid(),
			meta.rdev(),
			meta.len(),
			meta.atime(),
			meta.mtime(),
			meta.ctime(),
			meta.blksize(),
			meta.blocks(),
		)
	}

	#[cfg(windows)]
	fn bsd_shell_line(meta: &Metadata, resolved: &Path) -> String {
		let ids = win::handle_info(resolved, !meta.file_type().is_symlink());
		let (dev, ino, nlink) = ids.map_or((0, 0, 1), |i| (i.volume_serial, i.file_index, i.links));
		let sec = |field| win::md_time(meta, field).map_or(0, |t| system_time_to_sec(t).0);
		format!(
			"st_dev={dev} st_ino={ino} st_mode=0{:o} st_nlink={nlink} st_uid=0 st_gid=0 st_rdev=0 \
			 st_size={} st_atime={} st_mtime={} st_ctime={} st_birthtime={} st_blksize=4096 \
			 st_blocks={} st_flags=0",
			win::synth_mode(meta),
			meta.len(),
			sec(win::TimeField::Access),
			sec(win::TimeField::Modification),
			sec(win::TimeField::Change),
			sec(win::TimeField::Birth),
			win::allocated_size(resolved, meta.len()).div_ceil(512),
		)
	}






	fn bsd_filesystem_fallback(matches: &ArgMatches, host: &Host) -> Option<Vec<OsString>> {
		if !matches.get_flag(options::FILE_SYSTEM)
			|| matches.contains_id(options::FORMAT)
			|| matches.contains_id(options::PRINTF)
		{
			return None;
		}
		let files: Vec<&OsString> = matches.get_many::<OsString>(options::FILES)?.collect();


		if files.len() < 2 {
			return None;
		}
		let fmt = files[0].to_string_lossy();
		if !(fmt.contains('%') || fmt.chars().any(char::is_whitespace)) {
			return None;
		}
		if host.resolve(files[0]).symlink_metadata().is_ok() {
			return None;
		}
		let translated = translate_bsd_format(&fmt, false).ok()?;
		let mut argv: Vec<OsString> = Vec::with_capacity(files.len() + 4);
		argv.push("stat".into());
		if matches.get_flag(options::DEREFERENCE) {
			argv.push("-L".into());
		}
		argv.push("-c".into());
		argv.push(translated.into());
		argv.push("--".into());
		argv.extend(files[1..].iter().map(|f| (*f).clone()));
		Some(argv)
	}


	fn run_stater(matches: &ArgMatches, host: &mut Host) -> i32 {
		match Stater::new(matches, host) {
			Ok(stater) => stater.exec(host),
			Err(error) => {
				host.error(error, 1);
				1
			},
		}
	}



	pub(crate) struct Stat {
		matches: ArgMatches,
	}

	matches_parser!(Stat, app);

	impl Utility for Stat {
		const NAME: &'static str = "stat";

		fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
			match rewrite_bsd_invocation(&argv) {
				None => Ok(argv),
				Some(result) => result,
			}
		}

		fn run(self, host: &mut Host) -> i32 {
			if self.matches.get_flag(options::BSD_SHELL) {
				return bsd_shell_exec(&self.matches, host);
			}
			if let Some(argv) = bsd_filesystem_fallback(&self.matches, host) {
				return match app().try_get_matches_from(argv) {
					Ok(matches) => run_stater(&matches, host),


					Err(err) => {
						let _ = write!(host.stderr, "{err}");
						1
					},
				};
			}
			run_stater(&self.matches, host)
		}
	}

	pub(crate) fn app() -> Command {
		Command::new(Stat::NAME)
			.version("0.8.0")
			.about(ABOUT)
			.after_help(AFTER_HELP)
			.override_usage(host::format_usage(USAGE))
			.infer_long_args(true)
			.arg(
				Arg::new(options::DEREFERENCE)
					.short('L')
					.long(options::DEREFERENCE)
					.help("follow links")
					.action(ArgAction::SetTrue),
			)
			.arg(
				Arg::new(options::FILE_SYSTEM)
					.short('f')
					.long(options::FILE_SYSTEM)
					.help("display file system status instead of file status")
					.action(ArgAction::SetTrue),
			)
			.arg(
				Arg::new(options::TERSE)
					.short('t')
					.long(options::TERSE)
					.help("print the information in terse form")
					.action(ArgAction::SetTrue),
			)
			.arg(
				Arg::new(options::BSD_SHELL)
					.long(options::BSD_SHELL)
					.hide(true)
					.action(ArgAction::SetTrue),
			)
			.arg(
				Arg::new(options::BSD_TIMEFMT)
					.long(options::BSD_TIMEFMT)
					.value_name("TIMEFMT")
					.hide(true),
			)
			.arg(
				Arg::new(options::FORMAT)
					.short('c')
					.long(options::FORMAT)
					.help(
						"use the specified FORMAT instead of the default;\noutput a newline after each \
						 use of FORMAT",
					)
					.value_name("FORMAT"),
			)
			.arg(
				Arg::new(options::PRINTF)
					.long(options::PRINTF)
					.value_name("FORMAT")
					.help(
						"like --format, but interpret backslash escapes,\nand do not output a mandatory \
						 trailing newline;\nif you want a newline, include \\n in FORMAT",
					),
			)
			.arg(
				Arg::new(options::FILES)
					.action(ArgAction::Append)
					.value_parser(ValueParser::os_string())
					.value_hint(clap::ValueHint::FilePath),
			)
	}

	const PRETTY_DATETIME_FORMAT: &str = "%Y-%m-%d %H:%M:%S.%N %z";

	#[cfg(unix)]
	fn pretty_time(meta: &Metadata, md_time_field: MetadataTimeField, fmt: &str) -> String {
		if let Some(time) = metadata_get_time(meta, md_time_field) {
			let mut tmp = Vec::new();
			if format_system_time(
				&mut tmp,
				time,
				fmt,
				FormatSystemTimeFallback::Float,
			)
			.is_ok()
			{
				return String::from_utf8(tmp).unwrap();
			}
		}
		"-".to_string()
	}






	#[cfg(windows)]
	mod win {
		use std::{
			ffi::OsStr, fs::Metadata, os::windows::fs::MetadataExt, path::Path, time::SystemTime,
		};


		const READONLY: u32 = 0x0000_0001;


		const S_IFDIR: u32 = 0o040000;
		const S_IFREG: u32 = 0o100000;
		const S_IFLNK: u32 = 0o120000;





		#[derive(Clone, Copy)]
		pub enum TimeField {
			Access,
			Modification,
			Change,
			Birth,
		}



		pub fn md_time(md: &Metadata, field: TimeField) -> Option<SystemTime> {
			match field {
				TimeField::Access => md.accessed().ok(),
				TimeField::Modification | TimeField::Change => md.modified().ok(),
				TimeField::Birth => md.created().ok(),
			}
		}




		pub fn synth_mode(md: &Metadata) -> u32 {
			let readonly = md.file_attributes() & READONLY != 0;
			let ft = md.file_type();
			if ft.is_symlink() {
				S_IFLNK | 0o777
			} else if ft.is_dir() {
				S_IFDIR | if readonly { 0o555 } else { 0o755 }
			} else {
				S_IFREG | if readonly { 0o444 } else { 0o644 }
			}
		}



		pub fn file_type_str(mode: u32, size: u64) -> String {
			match mode & 0o170000 {
				S_IFDIR => "directory",
				S_IFLNK => "symbolic link",
				_ if size == 0 => "regular empty file",
				_ => "regular file",
			}
			.to_string()
		}



		pub fn perms_string(mode: u32) -> String {
			let mut s = String::with_capacity(10);
			s.push(match mode & 0o170000 {
				S_IFDIR => 'd',
				S_IFLNK => 'l',
				_ => '-',
			});
			for shift in [6u32, 3, 0] {
				let bits = (mode >> shift) & 0o7;
				s.push(if bits & 0o4 != 0 { 'r' } else { '-' });
				s.push(if bits & 0o2 != 0 { 'w' } else { '-' });
				s.push(if bits & 0o1 != 0 { 'x' } else { '-' });
			}
			s
		}






		pub fn allocated_size(path: &Path, logical: u64) -> u64 {
			use std::os::windows::ffi::OsStrExt;

			use windows_sys::Win32::Storage::FileSystem::GetCompressedFileSizeW;

			const INVALID_FILE_SIZE: u32 = u32::MAX;

			let wide: Vec<u16> = path
				.as_os_str()
				.encode_wide()
				.chain(std::iter::once(0))
				.collect();
			let mut high: u32 = 0;

			let low = unsafe { GetCompressedFileSizeW(wide.as_ptr(), &mut high) };


			if low == INVALID_FILE_SIZE
				&& std::io::Error::last_os_error().raw_os_error().unwrap_or(0) != 0
			{
				return logical;
			}
			(u64::from(high) << 32) | u64::from(low)
		}



		pub struct HandleInfo {
			pub volume_serial: u64,
			pub links:         u64,
			pub file_index:    u64,
		}






		pub fn handle_info(path: &Path, follow_links: bool) -> Option<HandleInfo> {
			use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};

			use windows_sys::Win32::Storage::FileSystem::{
				BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
				FILE_FLAG_OPEN_REPARSE_POINT, GetFileInformationByHandle,
			};



			let mut flags = FILE_FLAG_BACKUP_SEMANTICS;
			if !follow_links {
				flags |= FILE_FLAG_OPEN_REPARSE_POINT;
			}
			let file = std::fs::OpenOptions::new()
				.access_mode(0)
				.custom_flags(flags)
				.open(path)
				.ok()?;


			let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
			if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
				return None;
			}
			Some(HandleInfo {
				volume_serial: u64::from(info.dwVolumeSerialNumber),
				links:         u64::from(info.nNumberOfLinks),
				file_index:    (u64::from(info.nFileIndexHigh) << 32)
					| u64::from(info.nFileIndexLow),
			})
		}


		pub struct StatFs {
			pub fs_type:      String,
			pub serial:       u64,
			pub name_len:     u64,
			pub cluster_size: u64,
			pub total_blocks: u64,
			pub free_blocks:  u64,
		}




		pub fn statfs(path: &Path) -> Result<StatFs, String> {
			use std::os::windows::ffi::OsStrExt;

			use windows_sys::Win32::Storage::FileSystem::{
				GetDiskFreeSpaceW, GetVolumeInformationW, GetVolumePathNameW,
			};

			fn wide(s: &OsStr) -> Vec<u16> {
				s.encode_wide().chain(std::iter::once(0)).collect()
			}

			fn wide_to_string(buf: &[u16]) -> String {
				let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
				String::from_utf16_lossy(&buf[..len])
			}

			let file_wide = wide(path.as_os_str());

			let mut root = [0u16; 260];


			if unsafe { GetVolumePathNameW(file_wide.as_ptr(), root.as_mut_ptr(), root.len() as u32) }
				== 0
			{
				return Err(std::io::Error::last_os_error().to_string());
			}

			let mut fs_name = [0u16; 260];
			let mut serial: u32 = 0;
			let mut max_component: u32 = 0;
			let mut flags: u32 = 0;



			if unsafe {
				GetVolumeInformationW(
					root.as_ptr(),
					std::ptr::null_mut(),
					0,
					&mut serial,
					&mut max_component,
					&mut flags,
					fs_name.as_mut_ptr(),
					fs_name.len() as u32,
				)
			} == 0
			{
				return Err(std::io::Error::last_os_error().to_string());
			}

			let mut sectors_per_cluster: u32 = 0;
			let mut bytes_per_sector: u32 = 0;
			let mut free_clusters: u32 = 0;
			let mut total_clusters: u32 = 0;


			if unsafe {
				GetDiskFreeSpaceW(
					root.as_ptr(),
					&mut sectors_per_cluster,
					&mut bytes_per_sector,
					&mut free_clusters,
					&mut total_clusters,
				)
			} == 0
			{
				return Err(std::io::Error::last_os_error().to_string());
			}

			let cluster_size = u64::from(sectors_per_cluster) * u64::from(bytes_per_sector);
			Ok(StatFs {
				fs_type: wide_to_string(&fs_name),
				serial: u64::from(serial),
				name_len: u64::from(max_component),
				cluster_size,
				total_blocks: u64::from(total_clusters),
				free_blocks: u64::from(free_clusters),
			})
		}
	}


	#[cfg(windows)]
	fn pretty_time(meta: &Metadata, field: win::TimeField, fmt: &str) -> String {
		if let Some(time) = win::md_time(meta, field) {
			let mut tmp = Vec::new();
			if format_system_time(
				&mut tmp,
				time,
				fmt,
				FormatSystemTimeFallback::Float,
			)
			.is_ok()
			{
				return String::from_utf8(tmp).unwrap();
			}
		}
		"-".to_string()
	}

	#[cfg(windows)]
	fn process_token_filesystem(
		out: &mut dyn Write,
		t: &Token,
		meta: &win::StatFs,
		display_name: &str,
	) {
		match *t {
			Token::Byte(byte) => write_raw_byte(out, byte),
			Token::Char(c) => {
				let _ = write!(out, "{c}");
			},
			Token::Directive { flag, width, precision, format } => {
				let output = match format {

					'a' => OutputType::Unsigned(meta.free_blocks),

					'b' => OutputType::Unsigned(meta.total_blocks),

					'c' | 'd' => OutputType::Unsigned(0),

					'f' => OutputType::Unsigned(meta.free_blocks),

					'i' => OutputType::UnsignedHex(meta.serial),

					'l' => OutputType::Unsigned(meta.name_len),

					'n' => OutputType::Str(display_name.to_string()),

					's' => OutputType::Unsigned(meta.cluster_size),

					'S' => OutputType::Integer(meta.cluster_size as i64),

					't' => OutputType::UnsignedHex(0),

					'T' => OutputType::Str(meta.fs_type.clone()),
					_ => OutputType::Unknown,
				};
				print_it(out, &output, flag, width, precision);
			},
		}
	}

	#[cfg(windows)]
	impl Stater {
		fn exec(&self, host: &mut Host) -> i32 {
			let mut ret = 0;
			for f in &self.files {
				ret |= self.do_stat(f, host);
			}
			ret
		}

		fn process_token_files(
			&self,
			t: &Token,
			meta: &Metadata,
			display_name: &str,
			resolved: &Path,
			file_type: FileType,
			from_user: bool,
			host: &mut Host,
		) -> Result<(), i32> {
			match *t {
				Token::Byte(byte) => write_raw_byte(&mut host.stdout, byte),
				Token::Char(c) => {
					let _ = write!(host.stdout, "{c}");
				},
				Token::Directive { flag, width, precision, format } => {
					let mode = win::synth_mode(meta);


					let ids = matches!(format, 'd' | 'D' | 'h' | 'i')
						.then(|| win::handle_info(resolved, !meta.file_type().is_symlink()))
						.flatten();
					let output = match format {

						'a' => OutputType::UnsignedOct(0o7777 & mode),

						'A' => OutputType::Str(win::perms_string(mode)),

						'b' => {
							OutputType::Unsigned(win::allocated_size(resolved, meta.len()).div_ceil(512))
						},

						'B' => OutputType::Unsigned(512),

						'C' => OutputType::Str("unsupported for this operating system".to_string()),

						'd' if flag.major || flag.minor => OutputType::Unsigned(0),
						'd' => OutputType::Unsigned(ids.as_ref().map_or(0, |ids| ids.volume_serial)),

						'D' => {
							OutputType::UnsignedHex(ids.as_ref().map_or(0, |ids| ids.volume_serial))
						},

						'f' => OutputType::UnsignedHex(u64::from(mode)),

						'F' => OutputType::Str(win::file_type_str(mode, meta.len())),

						'g' => OutputType::Unsigned(0),

						'G' => OutputType::Str("UNKNOWN".to_string()),

						'h' => OutputType::Unsigned(ids.as_ref().map_or(1, |ids| ids.links)),

						'i' => OutputType::Unsigned(ids.as_ref().map_or(0, |ids| ids.file_index)),

						'm' => OutputType::Str(String::new()),

						'n' => OutputType::Str(display_name.to_string()),

						'N' => OutputType::Str(get_quoted_file_name(
							display_name,
							resolved,
							file_type,
							from_user,
							host,
						)?),

						'o' => OutputType::Unsigned(4096),

						's' => OutputType::Integer(meta.len() as i64),

						't' | 'T' => OutputType::UnsignedHex(0),

						'u' => OutputType::Unsigned(0),

						'U' => OutputType::Str("UNKNOWN".to_string()),

						'w' => OutputType::Str(pretty_time(meta, win::TimeField::Birth, self.time_fmt())),

						'W' => {
							let (sec, nsec) = win::md_time(meta, win::TimeField::Birth)
								.map_or((0, 0), system_time_to_sec);
							OutputType::Timestamp { sec, nsec }
						},

						'x' => OutputType::Str(pretty_time(meta, win::TimeField::Access, self.time_fmt())),

						'X' => {
							let (sec, nsec) = win::md_time(meta, win::TimeField::Access)
								.map_or((0, 0), system_time_to_sec);
							OutputType::Timestamp { sec, nsec }
						},

						'y' => OutputType::Str(pretty_time(meta, win::TimeField::Modification, self.time_fmt())),

						'Y' => {
							let (sec, nsec) = win::md_time(meta, win::TimeField::Modification)
								.map_or((0, 0), system_time_to_sec);
							OutputType::Timestamp { sec, nsec }
						},

						'z' => OutputType::Str(pretty_time(meta, win::TimeField::Change, self.time_fmt())),

						'Z' => {
							let (sec, nsec) = win::md_time(meta, win::TimeField::Change)
								.map_or((0, 0), system_time_to_sec);
							OutputType::Timestamp { sec, nsec }
						},

						'R' => OutputType::UnsignedHex(0),
						'r' => OutputType::Unsigned(0),
						_ => OutputType::Unknown,
					};
					print_it(&mut host.stdout, &output, flag, width, precision);
				},
			}
			Ok(())
		}

		fn do_stat(&self, file: &OsStr, host: &mut Host) -> i32 {
			let display_name = file.to_string_lossy();


			let resolved = host.resolve(file);
			if self.show_fs {
				let result = fs::metadata(&resolved)
					.map_err(|error| error.to_string())
					.and_then(|_| win::statfs(&resolved));
				match result {
					Ok(meta) => {
						for t in &self.default_tokens {
							process_token_filesystem(&mut host.stdout, t, &meta, &display_name);
						}
					},
					Err(error) => {
						let _ = writeln!(
							&mut host.stderr,
							"stat: {}",
							StatError::CannotReadFilesystemInfo {
								file: display_name.quote().to_string(),
								error,
							}
						);
						return 1;
					},
				}
			} else {
				let result = if self.follow {
					fs::metadata(&resolved)
				} else {
					fs::symlink_metadata(&resolved)
				};
				match result {
					Ok(meta) => {
						let file_type = meta.file_type();


						for t in &self.default_tokens {
							if let Err(code) = self.process_token_files(
								t,
								&meta,
								&display_name,
								&resolved,
								file_type,
								self.from_user,
								host,
							) {
								return code;
							}
						}
					},
					Err(e) => {
						let _ = writeln!(&mut host.stderr, "stat: {}", StatError::CannotStat {
							file:  display_name.quote().to_string(),
							error: e.to_string(),
						});
						return 1;
					},
				}
			}
			0
		}
	}
}

