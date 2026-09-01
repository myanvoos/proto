










use std::{
	ffi::{OsStr, OsString},
	fs::File,
	io::{self, Read, Write},
	path::{Path, PathBuf},
};

use clap::{ArgAction, Parser, ValueEnum};
use grep_cli::DecompressionReaderBuilder;
use grep_matcher::{Captures, LineTerminator, Matcher};
use grep_pcre2::{RegexMatcher as PcreMatcher, RegexMatcherBuilder as PcreMatcherBuilder};
use grep_printer::{JSONBuilder, Stats};
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{
	BinaryDetection, Encoding, Searcher, SearcherBuilder, Sink, SinkContext, SinkFinish, SinkMatch,
};
use crate::host::{Host, StreamWriter, Utility};

const SIGPIPE_EXIT_CODE: i32 = 141;

use ignore::{
	Match,
	gitignore::{Gitignore, GitignoreBuilder},
	overrides::{Override, OverrideBuilder},
	types::{Types, TypesBuilder},
};

#[derive(Parser, Debug)]
#[command(
	name = "rg",
	version = "15.1.0",
	author = "Andrew Gallant <jamslam@gmail.com>",
	about = "ripgrep recursively searches the current directory for lines matching a regex pattern.",
	args_override_self = true
)]
pub(crate) struct Rg {

	#[arg(short = 'e', long = "regexp", value_name = "PATTERN")]
	patterns: Vec<String>,


	#[arg(short = 'f', long = "file", value_name = "PATTERNFILE")]
	pattern_files: Vec<OsString>,


	#[arg(short = 'z', long = "search-zip", overrides_with = "no_search_zip")]
	search_zip: bool,


	#[arg(long = "no-search-zip", overrides_with = "search_zip")]
	no_search_zip: bool,


	#[arg(
		long = "engine",
		value_name = "ENGINE",
		overrides_with_all = ["pcre2", "no_pcre2"]
	)]
	engine: Option<RegexEngine>,


	#[arg(
		short = 'P',
		long = "pcre2",
		overrides_with_all = ["engine", "no_pcre2"]
	)]
	pcre2: bool,


	#[arg(long = "no-pcre2", overrides_with_all = ["engine", "pcre2"])]
	no_pcre2: bool,


	#[arg(short = 'E', long = "encoding", value_name = "ENCODING", overrides_with = "no_encoding")]
	encoding: Option<String>,


	#[arg(long = "no-encoding", overrides_with = "encoding")]
	no_encoding: bool,


	#[arg(long = "crlf", overrides_with = "no_crlf")]
	crlf: bool,


	#[arg(long = "no-crlf", overrides_with = "crlf")]
	no_crlf: bool,


	#[arg(long = "no-unicode", overrides_with = "unicode")]
	no_unicode: bool,


	#[arg(long = "unicode", overrides_with = "no_unicode", hide = true)]
	unicode: bool,


	#[arg(short = 'F', long = "fixed-strings")]
	fixed_strings: bool,


	#[arg(long = "no-fixed-strings")]
	no_fixed_strings: bool,


	#[arg(short = 'i', long = "ignore-case", overrides_with_all = ["case_sensitive", "smart_case"])]
	ignore_case: bool,


	#[arg(short = 's', long = "case-sensitive", overrides_with_all = ["ignore_case", "smart_case"])]
	case_sensitive: bool,


	#[arg(short = 'S', long = "smart-case", overrides_with_all = ["ignore_case", "case_sensitive"])]
	smart_case: bool,


	#[arg(short = 'v', long = "invert-match")]
	invert_match: bool,


	#[arg(short = 'w', long = "word-regexp")]
	word_regexp: bool,


	#[arg(short = 'x', long = "line-regexp")]
	line_regexp: bool,


	#[arg(short = 'm', long = "max-count", value_name = "NUM")]
	max_count: Option<u64>,


	#[arg(short = 'U', long = "multiline")]
	multiline: bool,


	#[arg(long = "multiline-dotall")]
	multiline_dotall: bool,


	#[arg(short = 'a', long = "text")]
	text: bool,


	#[arg(long = "binary")]
	binary: bool,


	#[arg(short = 'u', long = "unrestricted", action = ArgAction::Count)]
	unrestricted: u8,


	#[arg(short = 'L', long = "follow", overrides_with = "no_follow")]
	follow: bool,


	#[arg(long = "no-follow", overrides_with = "follow")]
	no_follow: bool,


	#[arg(long = "glob-case-insensitive", overrides_with = "no_glob_case_insensitive")]
	glob_case_insensitive: bool,


	#[arg(long = "no-glob-case-insensitive", overrides_with = "glob_case_insensitive", hide = true)]
	no_glob_case_insensitive: bool,


	#[arg(short = 'g', long = "glob", value_name = "GLOB")]
	globs: Vec<String>,


	#[arg(long = "iglob", value_name = "GLOB")]
	iglobs: Vec<String>,


	#[arg(short = '.', long = "hidden")]
	hidden: bool,


	#[arg(long = "no-hidden")]
	no_hidden: bool,


	#[arg(long = "no-ignore")]
	no_ignore: bool,


	#[arg(long = "ignore")]
	ignore: bool,


	#[arg(long = "ignore-file", value_name = "PATH")]
	ignore_files: Vec<OsString>,


	#[arg(long = "no-ignore-dot")]
	no_ignore_dot: bool,


	#[arg(long = "ignore-dot")]
	ignore_dot: bool,


	#[arg(long = "no-ignore-exclude")]
	no_ignore_exclude: bool,


	#[arg(long = "ignore-exclude")]
	ignore_exclude: bool,


	#[arg(long = "no-ignore-global")]
	no_ignore_global: bool,


	#[arg(long = "ignore-global")]
	ignore_global: bool,


	#[arg(long = "no-ignore-parent")]
	no_ignore_parent: bool,


	#[arg(long = "ignore-parent")]
	ignore_parent: bool,


	#[arg(long = "no-ignore-vcs")]
	no_ignore_vcs: bool,


	#[arg(long = "ignore-vcs")]
	ignore_vcs: bool,


	#[arg(long = "no-require-git")]
	no_require_git: bool,


	#[arg(long = "require-git")]
	require_git: bool,


	#[arg(long = "one-file-system", overrides_with = "no_one_file_system")]
	one_file_system: bool,


	#[arg(long = "no-one-file-system", overrides_with = "one_file_system", hide = true)]
	no_one_file_system: bool,


	#[arg(short = 'd', long = "max-depth", alias = "maxdepth", value_name = "NUM")]
	max_depth: Option<usize>,


	#[arg(long = "max-filesize", value_name = "NUM")]
	max_filesize: Option<String>,


	#[arg(short = 't', long = "type", value_name = "TYPE")]
	types: Vec<String>,


	#[arg(short = 'T', long = "type-not", value_name = "TYPE")]
	type_nots: Vec<String>,


	#[arg(long = "type-add", value_name = "TYPESPEC")]
	type_adds: Vec<String>,


	#[arg(long = "type-clear", value_name = "TYPE")]
	type_clears: Vec<String>,


	#[arg(short = 'A', long = "after-context", value_name = "NUM")]
	after_context: Option<usize>,


	#[arg(short = 'B', long = "before-context", value_name = "NUM")]
	before_context: Option<usize>,


	#[arg(short = 'C', long = "context", value_name = "NUM")]
	context: Option<usize>,


	#[arg(short = 'n', long = "line-number", overrides_with = "no_line_number")]
	line_number: bool,


	#[arg(short = 'N', long = "no-line-number", overrides_with = "line_number")]
	no_line_number: bool,


	#[arg(long = "column", overrides_with = "no_column")]
	column: bool,


	#[arg(long = "no-column", overrides_with = "column")]
	no_column: bool,


	#[arg(short = 'b', long = "byte-offset", overrides_with = "no_byte_offset")]
	byte_offset: bool,


	#[arg(long = "no-byte-offset", overrides_with = "byte_offset", hide = true)]
	no_byte_offset: bool,


	#[arg(short = 'H', long = "with-filename")]
	with_filename: bool,


	#[arg(short = 'I', long = "no-filename")]
	no_filename: bool,


	#[arg(short = 'l', long = "files-with-matches")]
	files_with_matches: bool,


	#[arg(long = "files-without-match")]
	files_without_match: bool,


	#[arg(short = 'c', long = "count")]
	count: bool,


	#[arg(long = "count-matches")]
	count_matches: bool,


	#[arg(short = 'o', long = "only-matching")]
	only_matching: bool,


	#[arg(short = 'r', long = "replace", value_name = "REPLACEMENT")]
	replacement: Option<OsString>,


	#[arg(long = "json", overrides_with = "no_json")]
	json: bool,


	#[arg(long = "no-json", overrides_with = "json", hide = true)]
	no_json: bool,


	#[arg(short = 'q', long = "quiet")]
	quiet: bool,


	#[arg(long = "vimgrep")]
	vimgrep: bool,


	#[arg(short = '0', long = "null")]
	null: bool,


	#[arg(long = "null-data")]
	null_data: bool,


	#[arg(long = "line-buffered", overrides_with = "no_line_buffered")]
	line_buffered: bool,


	#[arg(long = "no-line-buffered", overrides_with = "line_buffered", hide = true)]
	no_line_buffered: bool,


	#[arg(long = "files")]
	files: bool,


	#[arg(long = "type-list")]
	type_list: bool,


	#[arg(long = "no-messages")]
	no_messages: bool,


	#[arg(long = "messages")]
	messages: bool,


	#[arg(long = "sort", value_name = "SORTBY")]
	sort: Option<String>,


	#[arg(long = "sortr", value_name = "SORTBY")]
	sortr: Option<String>,


	#[arg(long = "sort-files")]
	sort_files: bool,


	#[arg(long = "no-sort-files")]
	no_sort_files: bool,


	#[arg(long = "passthru", alias = "passthrough")]
	passthru: bool,


	#[arg(long = "trim")]
	trim: bool,


	#[arg(long = "no-trim")]
	no_trim: bool,


	#[arg(short = 'M', long = "max-columns", value_name = "NUM")]
	max_columns: Option<usize>,


	#[arg(long = "max-columns-preview")]
	max_columns_preview: bool,


	#[arg(long = "no-max-columns-preview")]
	no_max_columns_preview: bool,


	#[arg(long = "color", value_name = "WHEN")]
	_color: Option<String>,


	#[arg(long = "colors", value_name = "COLOR_SPEC")]
	_colors: Vec<String>,


	#[arg(long = "heading")]
	_heading: bool,


	#[arg(long = "no-heading")]
	_no_heading: bool,


	#[arg(short = 'p', long = "pretty")]
	_pretty: bool,


	#[arg(long = "stats")]
	_stats: bool,


	#[arg(long = "no-stats")]
	_no_stats: bool,


	#[arg(long = "no-config")]
	_no_config: bool,



	#[arg(short = 'j', long = "threads", value_name = "NUM")]
	_threads: Option<usize>,


	#[arg(long = "path-separator", value_name = "SEPARATOR")]
	path_separator: Option<String>,


	#[arg(value_name = "ARGS")]
	args: Vec<OsString>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum RegexEngine {
	Default,
	Pcre2,
	Auto,
}

enum CompiledMatcher {
	Rust(RegexMatcher),
	Pcre(PcreMatcher),
}

struct SearchOptions {
	line_number:         bool,
	column:              bool,
	byte_offset:         bool,
	count:               bool,
	count_matches:       bool,
	files_with_matches:  bool,
	files_without_match: bool,
	only_matching:       bool,
	quiet:               bool,
	vimgrep:             bool,
	before:              usize,
	after:               usize,
	passthru:            bool,
	trim:                bool,
	max_columns:         Option<usize>,
	max_columns_preview: bool,
	null_paths:          bool,
	path_separator:      Option<u8>,
	no_messages:         bool,
	replacement:         Option<Vec<u8>>,
	json:                bool,
}

struct SearchOutcome {
	any_match: bool,
	had_error: bool,
}

struct RgSink<'a, M: Matcher, W: Write> {
	out:         &'a mut W,
	matcher:     &'a M,
	display:     Option<&'a [u8]>,
	opts:        &'a SearchOptions,
	captures:    M::Captures,
	scratch:     Vec<u8>,
	line_count:  u64,
	match_count: u64,
	any_match:   bool,
}

impl<M: Matcher, W: Write> RgSink<'_, M, W> {
	fn write_path(&mut self) -> io::Result<()> {
		if let Some(name) = self.display {
			write_display_bytes(&mut *self.out, name, self.opts.path_separator)?;
			if self.opts.null_paths {
				self.out.write_all(b"\0")?;
			}
		}
		Ok(())
	}

	fn write_prefix(
		&mut self,
		line_number: Option<u64>,
		column: Option<usize>,
		byte_offset: u64,
		separator: u8,
	) -> io::Result<()> {
		if self.display.is_some() {
			self.write_path()?;
			if !self.opts.null_paths {
				self.out.write_all(&[separator])?;
			}
		}
		if self.opts.line_number
			&& let Some(number) = line_number
		{
			write!(self.out, "{number}")?;
			self.out.write_all(&[separator])?;
		}
		if self.opts.column {
			write!(self.out, "{}", column.unwrap_or(1))?;
			self.out.write_all(&[separator])?;
		}
		if self.opts.byte_offset {
			write!(self.out, "{byte_offset}")?;
			self.out.write_all(&[separator])?;
		}
		Ok(())
	}

	fn write_line(&mut self, line: &[u8]) -> io::Result<()> {
		let mut bytes = line;
		if self.opts.trim {
			bytes = trim_ascii_start(bytes);
		}
		if let Some(limit) = self.opts.max_columns
			&& limit > 0
			&& bytes.len() > limit
		{
			if self.opts.max_columns_preview {
				self.out.write_all(&bytes[..limit.min(bytes.len())])?;
				self.out.write_all(b"\n")?;
			} else {
				writeln!(self.out, "[Omitted long matching line]")?;
			}
			return Ok(());
		}
		self.out.write_all(bytes)?;
		if !bytes.ends_with(b"\n") {
			self.out.write_all(b"\n")?;
		}
		Ok(())
	}

	fn write_replaced_line(&mut self, line: &[u8]) -> io::Result<()> {
		let Some(replacement) = self.opts.replacement.as_deref() else {
			return self.write_line(line);
		};
		self.scratch.clear();
		let matcher = self.matcher;
		matcher
			.replace_with_captures(line, &mut self.captures, &mut self.scratch, |captures, output| {
				captures.interpolate(|name| matcher.capture_index(name), line, replacement, output);
				true
			})
			.map_err(|error| io::Error::other(error.to_string()))?;
		let mut output = std::mem::take(&mut self.scratch);
		let result = self.write_line(&output);
		output.clear();
		self.scratch = output;
		result
	}

	fn print_only_matching(
		&mut self,
		line: &[u8],
		line_number: Option<u64>,
		line_offset: u64,
	) -> io::Result<()> {
		let mut at = 0usize;
		while at <= line.len() {
			let Some(found) = self
				.matcher
				.find_at(line, at)
				.map_err(|error| io::Error::other(error.to_string()))?
			else {
				break;
			};
			if found.is_empty() {
				at = found.end() + 1;
				continue;
			}
			let match_offset = line_offset.saturating_add(
				u64::try_from(found.start()).map_err(|error| io::Error::other(error.to_string()))?,
			);
			self.write_prefix(line_number, Some(found.start() + 1), match_offset, b':')?;
			if let Some(replacement) = self.opts.replacement.as_deref() {
				let matched = self
					.matcher
					.captures_at(line, found.start(), &mut self.captures)
					.map_err(|error| io::Error::other(error.to_string()))?;
				if matched {
					self.scratch.clear();
					self.captures.interpolate(
						|name| self.matcher.capture_index(name),
						line,
						replacement,
						&mut self.scratch,
					);
					self.out.write_all(&self.scratch)?;
				}
			} else {
				self.out.write_all(&line[found.start()..found.end()])?;
			}
			self.out.write_all(b"\n")?;
			at = found.end();
		}
		Ok(())
	}

	fn print_vimgrep(
		&mut self,
		line: &[u8],
		line_number: Option<u64>,
		line_offset: u64,
	) -> io::Result<()> {
		let mut at = 0usize;
		let mut printed = false;
		while at <= line.len() {
			let Some(found) = self
				.matcher
				.find_at(line, at)
				.map_err(|error| io::Error::other(error.to_string()))?
			else {
				break;
			};
			let next = if found.end() > at {
				found.end()
			} else {
				at + 1
			};
			let match_offset = line_offset.saturating_add(
				u64::try_from(found.start()).map_err(|error| io::Error::other(error.to_string()))?,
			);
			self.write_prefix(line_number, Some(found.start() + 1), match_offset, b':')?;
			self.write_replaced_line(line)?;
			printed = true;
			at = next;
		}
		if !printed {
			self.write_prefix(line_number, Some(1), line_offset, b':')?;
			self.write_replaced_line(line)?;
		}
		Ok(())
	}
}

impl<M: Matcher, W: Write> Sink for RgSink<'_, M, W> {
	type Error = io::Error;

	fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, io::Error> {
		self.any_match = true;
		self.line_count += 1;
		let line = mat.bytes();
		let matches_on_line = count_matches(self.matcher, line)?;
		self.match_count += if self.opts.count_matches || self.opts.only_matching {
			matches_on_line.max(1)
		} else {
			1
		};

		if self.opts.quiet || self.opts.files_with_matches {
			return Ok(false);
		}
		if self.opts.files_without_match || self.opts.count || self.opts.count_matches {
			return Ok(true);
		}
		if self.opts.vimgrep {
			self.print_vimgrep(line, mat.line_number(), mat.absolute_byte_offset())?;
		} else if self.opts.only_matching {
			self.print_only_matching(line, mat.line_number(), mat.absolute_byte_offset())?;
		} else {
			let column = if self.opts.column {
				first_column(self.matcher, line)?
			} else {
				None
			};
			self.write_prefix(mat.line_number(), column, mat.absolute_byte_offset(), b':')?;
			self.write_replaced_line(line)?;
		}
		Ok(true)
	}

	fn context(&mut self, _searcher: &Searcher, ctx: &SinkContext<'_>) -> Result<bool, io::Error> {
		if self.opts.count
			|| self.opts.count_matches
			|| self.opts.files_with_matches
			|| self.opts.files_without_match
			|| self.opts.only_matching
			|| self.opts.vimgrep
		{
			return Ok(true);
		}
		self.write_prefix(ctx.line_number(), None, ctx.absolute_byte_offset(), b'-')?;
		self.write_line(ctx.bytes())?;
		Ok(true)
	}

	fn context_break(&mut self, _searcher: &Searcher) -> Result<bool, io::Error> {
		if !(self.opts.count
			|| self.opts.count_matches
			|| self.opts.files_with_matches
			|| self.opts.files_without_match
			|| self.opts.only_matching
			|| self.opts.vimgrep
			|| self.opts.passthru)
		{
			self.out.write_all(b"--\n")?;
		}
		Ok(true)
	}

	fn finish(&mut self, _searcher: &Searcher, _: &SinkFinish) -> Result<(), io::Error> {
		if self.opts.quiet {
			return Ok(());
		}
		if self.opts.files_with_matches {
			if self.any_match {
				self.write_path()?;
				if !self.opts.null_paths {
					self.out.write_all(b"\n")?;
				}
			}
		} else if self.opts.files_without_match {
			if !self.any_match {
				self.write_path()?;
				if !self.opts.null_paths {
					self.out.write_all(b"\n")?;
				}
			}
		} else if self.opts.count || self.opts.count_matches {
			if self.display.is_some() {
				self.write_path()?;
				if !self.opts.null_paths {
					self.out.write_all(b":")?;
				}
			}
			let count = if self.opts.count_matches {
				self.match_count
			} else {
				self.line_count
			};
			writeln!(self.out, "{count}")?;
		}
		Ok(())
	}
}

fn trim_ascii_start(bytes: &[u8]) -> &[u8] {
	let start = bytes
		.iter()
		.position(|b| !b.is_ascii_whitespace() || *b == b'\n' || *b == b'\r')
		.unwrap_or(bytes.len());
	&bytes[start..]
}



fn write_display_bytes<W: Write>(out: &mut W, bytes: &[u8], separator: Option<u8>) -> io::Result<()> {
	let Some(separator) = separator else {
		return out.write_all(bytes);
	};
	let mut rest = bytes;
	while let Some(pos) = rest.iter().position(|&byte| byte == b'/') {
		out.write_all(&rest[..pos])?;
		out.write_all(&[separator])?;
		rest = &rest[pos + 1..];
	}
	out.write_all(rest)
}

fn parse_path_separator(spec: Option<&str>) -> Result<Option<u8>, String> {
	match spec {
		None | Some("") => Ok(None),
		Some(separator) if separator.len() == 1 => Ok(Some(separator.as_bytes()[0])),
		Some(separator) => Err(format!(
			"error parsing flag --path-separator: a path separator must be exactly one byte, but the given separator is {} bytes",
			separator.len()
		)),
	}
}




fn effective_line_number(cli: &Rg) -> bool {
	if cli.no_line_number {
		return false;
	}
	cli.line_number || cli.column || cli.vimgrep
}

fn first_column<M: Matcher>(matcher: &M, line: &[u8]) -> io::Result<Option<usize>> {
	Ok(matcher
		.find(line)
		.map_err(|error| io::Error::other(error.to_string()))?
		.filter(|matched| !matched.is_empty())
		.map(|matched| matched.start() + 1))
}

fn count_matches<M: Matcher>(matcher: &M, line: &[u8]) -> io::Result<u64> {
	let mut at = 0usize;
	let mut count = 0u64;
	while at <= line.len() {
		let Some(matched) = matcher
			.find_at(line, at)
			.map_err(|error| io::Error::other(error.to_string()))?
		else {
			break;
		};
		if matched.is_empty() {
			at += 1;
			continue;
		}
		count += 1;
		at = matched.end();
	}
	Ok(count)
}

fn build_rust_matcher(patterns: &[String], cli: &Rg) -> Result<RegexMatcher, grep_regex::Error> {
	let crlf = cli.crlf && !cli.no_crlf && !cli.null_data;
	let mut builder = RegexMatcherBuilder::new();
	builder
		.case_insensitive(cli.ignore_case)
		.case_smart(cli.smart_case)
		.word(cli.word_regexp && !cli.line_regexp)
		.whole_line(cli.line_regexp)
		.fixed_strings(cli.fixed_strings && !cli.no_fixed_strings)
		.multi_line(true)
		.dot_matches_new_line(cli.multiline && cli.multiline_dotall)
		.unicode(!cli.no_unicode)
		.crlf(crlf);
	if cli.null_data {
		builder.line_terminator(Some(b'\0'));
	} else if !cli.multiline {
		builder.line_terminator(Some(b'\n'));
	}
	builder.build_many(patterns)
}

fn build_pcre_matcher(host: &Host, patterns: &[String], cli: &Rg) -> Result<PcreMatcher, String> {
	let unicode = !cli.no_unicode;
	let mut builder = PcreMatcherBuilder::new();
	builder
		.caseless(cli.ignore_case)
		.case_smart(cli.smart_case)
		.word(cli.word_regexp && !cli.line_regexp)
		.whole_line(cli.line_regexp)
		.fixed_strings(cli.fixed_strings && !cli.no_fixed_strings)
		.multi_line(true)
		.dotall(cli.multiline && cli.multiline_dotall)
		.crlf(cli.crlf && !cli.no_crlf && !cli.null_data)
		.utf(unicode)
		.ucp(unicode)
		.jit_if_available(crate::grep::pcre2_jit_enabled(host));
	builder
		.build_many(patterns)
		.map_err(|error| error.to_string())
}

fn build_matcher(host: &Host, patterns: &[String], cli: &Rg) -> Result<CompiledMatcher, String> {
	let engine = cli.engine.unwrap_or(if cli.pcre2 {
		RegexEngine::Pcre2
	} else {
		RegexEngine::Default
	});
	match engine {
		RegexEngine::Default => build_rust_matcher(patterns, cli)
			.map(CompiledMatcher::Rust)
			.map_err(|error| error.to_string()),
		RegexEngine::Pcre2 => build_pcre_matcher(host, patterns, cli).map(CompiledMatcher::Pcre),
		RegexEngine::Auto => match build_rust_matcher(patterns, cli) {
			Ok(matcher) => Ok(CompiledMatcher::Rust(matcher)),
			Err(_) => build_pcre_matcher(host, patterns, cli).map(CompiledMatcher::Pcre),
		},
	}
}

#[derive(Clone, Copy)]
enum BinaryMode {
	Automatic,
	Explicit,
}

fn binary_detection(cli: &Rg, mode: BinaryMode) -> BinaryDetection {
	if cli.text || cli.null_data {
		return BinaryDetection::none();
	}
	if cli.binary || cli.unrestricted >= 3 || matches!(mode, BinaryMode::Explicit) {
		BinaryDetection::convert(b'\0')
	} else {
		BinaryDetection::quit(b'\0')
	}
}

fn build_searcher(cli: &Rg, opts: &SearchOptions, mode: BinaryMode) -> Result<Searcher, String> {
	let (encoding, bom_sniffing) = match cli.encoding.as_deref() {
		None | Some("auto") => (None, true),
		Some("none") => (None, false),
		Some(label) => (Some(Encoding::new(label).map_err(|error| format!("rg: {error}"))?), true),
	};
	let mut builder = SearcherBuilder::new();
	builder
		.line_number(opts.line_number || opts.column || opts.vimgrep || opts.json)
		.before_context(opts.before)
		.after_context(opts.after)
		.passthru(opts.passthru)
		.invert_match(cli.invert_match)
		.multi_line(cli.multiline)
		.binary_detection(binary_detection(cli, mode))
		.max_matches(cli.max_count)
		.encoding(encoding)
		.bom_sniffing(bom_sniffing);
	if cli.null_data {
		builder.line_terminator(LineTerminator::byte(b'\0'));
	} else if cli.crlf && !cli.no_crlf {
		builder.line_terminator(LineTerminator::crlf());
	}
	Ok(builder.build())
}

fn read_pattern_file(host: &mut Host, path: &OsStr) -> Result<Vec<String>, String> {
	let mut text = String::new();
	if path == OsStr::new("-") {
		host.stdin
			.read_to_string(&mut text)
			.map_err(|err| format!("rg: -: {err}"))?;
	} else {
		let resolved = host.resolve(path);
		File::open(&resolved)
			.and_then(|mut file| file.read_to_string(&mut text))
			.map_err(|err| format!("rg: {}: {err}", path.to_string_lossy()))?;
	}
	Ok(text
		.lines()
		.map(|line| line.strip_suffix('\r').unwrap_or(line).to_string())
		.collect())
}

fn resolve_patterns(host: &mut Host, cli: &Rg) -> Result<(Vec<String>, Vec<OsString>), String> {
	let mut patterns = cli.patterns.clone();
	for pattern_file in &cli.pattern_files {
		patterns.extend(read_pattern_file(host, pattern_file.as_os_str())?);
	}
	let mut paths = Vec::new();
	if cli.files || cli.type_list || !cli.patterns.is_empty() || !cli.pattern_files.is_empty() {
		paths = cli.args.clone();
	} else {
		let mut rest = cli.args.iter();
		let Some(pattern) = rest.next() else {
			return Err("rg: required pattern missing".to_string());
		};
		patterns.push(pattern.to_string_lossy().into_owned());
		paths.extend(rest.cloned());
	}
	Ok((patterns, paths))
}

fn search_options(cli: &Rg) -> SearchOptions {
	let context = cli.context.unwrap_or(0);
	let count_matches = cli.count_matches || (cli.count && cli.only_matching);
	let line_number = (cli.line_number || cli.column || cli.vimgrep) && !cli.no_line_number;
	SearchOptions {
		line_number,
		column: cli.column || cli.vimgrep,
		byte_offset: cli.byte_offset,
		count: cli.count && !count_matches,
		count_matches,
		files_with_matches: cli.files_with_matches && !cli.files_without_match,
		files_without_match: cli.files_without_match,
		only_matching: cli.only_matching,
		quiet: cli.quiet,
		vimgrep: cli.vimgrep,
		before: cli.before_context.unwrap_or(context),
		after: cli.after_context.unwrap_or(context),
		passthru: cli.passthru,
		trim: cli.trim && !cli.no_trim,
		max_columns: cli.max_columns,
		max_columns_preview: cli.max_columns_preview && !cli.no_max_columns_preview,
		null_paths: cli.null,


		path_separator: None,
		no_messages: cli.no_messages && !cli.messages,
		replacement: cli
			.replacement
			.as_ref()
			.map(|replacement| replacement.as_encoded_bytes().to_vec()),
		json: cli.json,
	}
}

fn parse_size(input: &str) -> Result<u64, String> {
	let trimmed = input.trim();
	let Some(last) = trimmed.chars().last() else {
		return Err("empty size".to_string());
	};
	let (digits, multiplier) = match last {
		'K' | 'k' => (&trimmed[..trimmed.len() - 1], 1024),
		'M' | 'm' => (&trimmed[..trimmed.len() - 1], 1024 * 1024),
		'G' | 'g' => (&trimmed[..trimmed.len() - 1], 1024 * 1024 * 1024),
		_ => (trimmed, 1),
	};
	let value = digits
		.parse::<u64>()
		.map_err(|err| format!("invalid size {input:?}: {err}"))?;
	Ok(value.saturating_mul(multiplier))
}

fn type_builder(cli: &Rg) -> Result<TypesBuilder, String> {
	let mut builder = TypesBuilder::new();
	builder.add_defaults();
	for name in &cli.type_clears {
		builder.clear(name);
	}
	for def in &cli.type_adds {
		builder
			.add_def(def)
			.map_err(|err| format!("rg: --type-add {def:?}: {err}"))?;
	}
	for name in &cli.types {
		builder.select(name);
	}
	for name in &cli.type_nots {
		builder.negate(name);
	}
	Ok(builder)
}

fn print_type_list<W: Write>(cli: &Rg, out: &mut W) -> Result<(), String> {
	let builder = type_builder(cli)?;
	for def in builder.definitions() {
		write!(out, "{}: ", def.name()).map_err(|err| err.to_string())?;
		for (idx, glob) in def.globs().iter().enumerate() {
			if idx > 0 {
				out.write_all(b", ").map_err(|err| err.to_string())?;
			}
			out.write_all(glob.as_bytes())
				.map_err(|err| err.to_string())?;
		}
		out.write_all(b"\n").map_err(|err| err.to_string())?;
	}
	Ok(())
}

struct RgWalk {
	request: pi_walker::WalkRequest,
	filters: PathFilters,
}

struct PathFilters {
	overrides:    Option<Override>,
	explicit:     Option<Gitignore>,
	types:        Option<Types>,
	max_filesize: Option<u64>,
}

impl PathFilters {
	fn includes(&self, path: &Path, file_type: pi_walker::FileType, size: Option<f64>) -> bool {
		let is_dir = file_type == pi_walker::FileType::Dir;
		let override_match = self
			.overrides
			.as_ref()
			.map(|overrides| overrides.matched(path, is_dir));
		if override_match
			.as_ref()
			.is_some_and(|matched| matches!(matched, Match::Ignore(_)))
		{
			return false;
		}
		let explicitly_included = override_match
			.as_ref()
			.is_some_and(|matched| matches!(matched, Match::Whitelist(_)));
		if !explicitly_included
			&& self
				.explicit
				.as_ref()
				.is_some_and(|ignore| matches!(ignore.matched(path, is_dir), Match::Ignore(_)))
		{
			return false;
		}
		if file_type != pi_walker::FileType::File {
			return true;
		}
		if !explicitly_included
			&& self
				.types
				.as_ref()
				.is_some_and(|types| matches!(types.matched(path, false), Match::Ignore(_)))
		{
			return false;
		}
		if let Some(limit) = self.max_filesize {
			let size = size.or_else(|| std::fs::metadata(path).ok().map(|meta| meta.len() as f64));
			if size.is_some_and(|size| size > limit as f64) {
				return false;
			}
		}
		true
	}
}

fn build_path_filters(host: &mut Host, cli: &Rg) -> Result<PathFilters, String> {
	let cwd = host.cwd().to_path_buf();
	let max_filesize = cli
		.max_filesize
		.as_ref()
		.map(|size| parse_size(size).map_err(|error| format!("rg: {error}")))
		.transpose()?;
	let overrides = if cli.globs.is_empty() && cli.iglobs.is_empty() {
		None
	} else {
		let mut overrides = OverrideBuilder::new(&cwd);
		if cli.glob_case_insensitive {
			overrides
				.case_insensitive(true)
				.map_err(|error| format!("rg: --glob-case-insensitive: {error}"))?;
		}
		for glob in &cli.globs {
			overrides
				.add(glob)
				.map_err(|error| format!("rg: --glob {glob:?}: {error}"))?;
		}
		if !cli.iglobs.is_empty() && !cli.glob_case_insensitive {
			overrides
				.case_insensitive(true)
				.map_err(|error| format!("rg: --iglob: {error}"))?;
		}
		for glob in &cli.iglobs {
			overrides
				.add(glob)
				.map_err(|error| format!("rg: --iglob {glob:?}: {error}"))?;
		}
		Some(overrides.build().map_err(|error| format!("rg: {error}"))?)
	};
	let explicit = if cli.ignore_files.is_empty() {
		None
	} else {
		let mut builder = GitignoreBuilder::new(&cwd);
		for path in &cli.ignore_files {
			let resolved = host.resolve(path);
			if let Some(error) = builder.add(&resolved) {
				return Err(format!("rg: {}: {error}", path.to_string_lossy()));
			}
		}
		Some(builder.build().map_err(|error| format!("rg: {error}"))?)
	};
	let types = if cli.types.is_empty() && cli.type_nots.is_empty() {
		None
	} else {
		Some(
			type_builder(cli)?
				.build()
				.map_err(|error| format!("rg: {error}"))?,
		)
	};
	Ok(PathFilters { overrides, explicit, types, max_filesize })
}

fn build_walk(host: &mut Host, cli: &Rg, root: &Path) -> Result<RgWalk, String> {
	let filters = build_path_filters(host, cli)?;
	let unrestricted_no_ignore = cli.unrestricted >= 1;
	let include_hidden = (cli.hidden || cli.unrestricted >= 2) && !cli.no_hidden;
	let no_ignore = (cli.no_ignore || unrestricted_no_ignore) && !cli.ignore;
	let order = if cli.sort_files || cli.sort.as_deref() == Some("path") {
		pi_walker::WalkOrder::Path
	} else {
		pi_walker::WalkOrder::Unordered
	};
	let request = pi_walker::WalkRequest::new(root)
		.hidden(include_hidden)
		.gitignore(!no_ignore)
		.skip_git(!no_ignore)
		.skip_node_modules(false)
		.follow_links(pi_walker::FollowLinks::from(cli.follow && !cli.no_follow))
		.detail(if filters.max_filesize.is_some() {
			pi_walker::WalkDetail::Full
		} else {
			pi_walker::WalkDetail::Minimal
		})
		.order(order)
		.emit_root(false)
		.depth(1, cli.max_depth.unwrap_or(usize::MAX))
		.visit_order(pi_walker::VisitOrder::PreOrder)
		.directory_errors(pi_walker::DirectoryErrorMode::Visit)
		.same_file_system(cli.one_file_system && !cli.no_one_file_system)
		.cache(false);
	Ok(RgWalk { request, filters })
}

fn display_path(operand: &OsStr, root: &Path, path: &Path) -> PathBuf {
	let rel = path.strip_prefix(root).unwrap_or(path);
	if rel.as_os_str().is_empty() {
		return PathBuf::from(operand);
	}
	if operand == OsStr::new(".") {
		rel.to_path_buf()
	} else {
		Path::new(operand).join(rel)
	}
}

fn process_reader<M: Matcher, R: Read, W: Write>(
	matcher: &M,
	searcher: &mut Searcher,
	reader: R,
	display: Option<&[u8]>,
	opts: &SearchOptions,
	stats: &mut Stats,
	out: &mut W,
) -> io::Result<bool> {
	if opts.json {
		let mut builder = JSONBuilder::new();
		builder.replacement(opts.replacement.clone());
		let mut printer = builder.build(out);
		if let Some(display) = display {
			let path = PathBuf::from(String::from_utf8_lossy(display).into_owned());
			let mut sink = printer.sink_with_path(matcher, &path);
			searcher.search_reader(matcher, reader, &mut sink)?;
			let matched = sink.has_match();
			*stats += sink.stats();
			return Ok(matched);
		}
		let mut sink = printer.sink(matcher);
		searcher.search_reader(matcher, reader, &mut sink)?;
		let matched = sink.has_match();
		*stats += sink.stats();
		return Ok(matched);
	}

	let captures = matcher
		.new_captures()
		.map_err(|error| io::Error::other(error.to_string()))?;
	let mut sink = RgSink {
		out,
		matcher,
		display,
		opts,
		captures,
		scratch: Vec::new(),
		line_count: 0,
		match_count: 0,
		any_match: false,
	};
	searcher.search_reader(matcher, reader, &mut sink)?;
	Ok(sink.any_match)
}

#[allow(
	clippy::too_many_arguments,
	reason = "file processing needs the matcher, searcher, output state, and path metadata"
)]
fn process_file<M: Matcher, W: Write>(
	host: &mut Host,
	cli: &Rg,
	matcher: &M,
	searcher: &mut Searcher,
	path: &Path,
	display: Option<&[u8]>,
	opts: &SearchOptions,
	stats: &mut Stats,
	out: &mut W,
) -> io::Result<SearchOutcome> {
	let result = if cli.search_zip && !cli.no_search_zip {
		let builder = DecompressionReaderBuilder::new();
		if builder.get_matcher().has_command(path) {
			builder
				.build(path)
				.map_err(|error| io::Error::other(error.to_string()))
				.and_then(|reader| process_reader(matcher, searcher, reader, display, opts, stats, out))
		} else {
			File::open(path)
				.and_then(|file| process_reader(matcher, searcher, file, display, opts, stats, out))
		}
	} else {
		File::open(path)
			.and_then(|file| process_reader(matcher, searcher, file, display, opts, stats, out))
	};
	match result {
		Ok(any_match) => {
			if any_match {
				host.note_read(path);
			}
			Ok(SearchOutcome { any_match, had_error: false })
		},
		Err(error) if error.kind() == io::ErrorKind::BrokenPipe => Err(error),
		Err(error) => Ok(SearchOutcome {
			any_match: false,
			had_error: report_path_error(host, display, path, error, opts),
		}),
	}
}

fn report_path_error(
	host: &mut Host,
	display: Option<&[u8]>,
	fallback: &Path,
	err: io::Error,
	opts: &SearchOptions,
) -> bool {
	if !opts.no_messages {
		let name = display
			.map(|bytes| String::from_utf8_lossy(bytes).into_owned())
			.unwrap_or_else(|| fallback.display().to_string());
		let _ = writeln!(host.stderr, "rg: {name}: {err}");
	}
	true
}

#[allow(
	clippy::too_many_arguments,
	reason = "required by standard walk/configure interfaces and search parameters"
)]
fn search_collected_files<M: Matcher, W: Write>(
	host: &mut Host,
	cli: &Rg,
	matcher: &M,
	searcher: &mut Searcher,
	operand: &OsStr,
	root: &Path,
	show_names: bool,
	opts: &SearchOptions,
	stats: &mut Stats,
	out: &mut W,
) -> io::Result<SearchOutcome> {
	let mut files = match collect_filtered_files(host, cli, root) {
		Ok(files) => files,
		Err(_) if host.is_cancelled() => {
			return Ok(SearchOutcome { any_match: false, had_error: true });
		},
		Err(err) if err.kind() == io::ErrorKind::BrokenPipe => return Err(err),
		Err(err) => {
			if !opts.no_messages {
				let _ = writeln!(host.stderr, "{err}");
			}
			return Ok(SearchOutcome { any_match: false, had_error: true });
		},
	};
	files.sort_unstable_by(|a, b| b.cmp(a));
	let mut any_match = false;
	let mut had_error = false;
	let mut processed_file = false;
	for path in files {
		if opts.quiet && any_match {
			break;
		}
		if processed_file && host.is_cancelled() {
			had_error = true;
			break;
		}
		processed_file = true;
		let display_path = display_path(operand, root, &path);
		let display_bytes = display_path.as_os_str().as_encoded_bytes().to_vec();
		let display = (show_names || opts.json).then_some(display_bytes.as_slice());
		let outcome = process_file(host, cli, matcher, searcher, &path, display, opts, stats, out)?;
		any_match |= outcome.any_match;
		had_error |= outcome.had_error;
		if host.is_cancelled() {
			had_error = true;
			break;
		}
	}
	Ok(SearchOutcome { any_match, had_error })
}

#[allow(
	clippy::too_many_arguments,
	reason = "required by standard walk/configure interfaces and search parameters"
)]
fn search_dir<M: Matcher, W: Write>(
	host: &mut Host,
	cli: &Rg,
	matcher: &M,
	searcher: &mut Searcher,
	operand: &OsStr,
	root: &Path,
	show_names: bool,
	opts: &SearchOptions,
	stats: &mut Stats,
	out: &mut W,
) -> io::Result<SearchOutcome> {
	if cli.sortr.as_deref() == Some("path") {
		return search_collected_files(
			host, cli, matcher, searcher, operand, root, show_names, opts, stats, out,
		);
	}
	let walk = match build_walk(host, cli, root) {
		Ok(walk) => walk,
		Err(err) => {
			if !opts.no_messages {
				let _ = writeln!(host.stderr, "{err}");
			}
			return Ok(SearchOutcome { any_match: false, had_error: true });
		},
	};
	let any_match = std::cell::Cell::new(false);
	let had_error = std::cell::Cell::new(false);
	let cancel = host.cancel_flag();
	let mut walk_err = host.stderr_clone();
	let streamed = match walk.request.for_each_entry_with_heartbeat(
		|| {
			if cancel.load(std::sync::atomic::Ordering::Relaxed) {
				Err(io::Error::from(io::ErrorKind::Interrupted))
			} else {
				Ok::<(), io::Error>(())
			}
		},
		|entry| {
			if opts.quiet && any_match.get() {
				return Ok(pi_walker::WalkDecision::Stop);
			}
			let path = entry.absolute_path.as_ref();
			if !walk.filters.includes(path, entry.file_type, entry.size) {
				return Ok(if entry.file_type == pi_walker::FileType::Dir {
					pi_walker::WalkDecision::SkipDescend
				} else {
					pi_walker::WalkDecision::Skip
				});
			}
			if entry.file_type != pi_walker::FileType::File {
				return Ok(pi_walker::WalkDecision::Skip);
			}
			let display_path = display_path(operand, root, path);
			let display_bytes = display_path.as_os_str().as_encoded_bytes().to_vec();
			let display = (show_names || opts.json).then_some(display_bytes.as_slice());
			let outcome = process_file(host, cli, matcher, searcher, path, display, opts, stats, out)?;
			any_match.set(any_match.get() || outcome.any_match);
			had_error.set(had_error.get() || outcome.had_error);
			Ok(if opts.quiet && any_match.get() {
				pi_walker::WalkDecision::Stop
			} else {
				pi_walker::WalkDecision::Include
			})
		},
		|error| {
			had_error.set(true);
			if !opts.no_messages {
				let _ =
					writeln!(walk_err, "rg: {}: {}", error.path.display(), error.error);
			}
			Ok(pi_walker::WalkDecision::Include)
		},
	) {
		Ok(pi_walker::WalkStatus::Complete | pi_walker::WalkStatus::Stopped) => {
			Some(Ok(SearchOutcome { any_match: any_match.get(), had_error: had_error.get() }))
		},
		Err(pi_walker::WalkError::Interrupted(_)) if host.is_cancelled() => {


			had_error.set(true);
			Some(Ok(SearchOutcome { any_match: any_match.get(), had_error: true }))
		},
		Err(pi_walker::WalkError::Interrupted(error))
			if error.kind() == io::ErrorKind::BrokenPipe =>
		{
			Some(Err(error))
		},
		Err(err) => {
			had_error.set(true);
			if !opts.no_messages {
				let _ = writeln!(host.stderr, "rg: {err}");
			}
			Some(Ok(SearchOutcome {
				any_match: any_match.get(),
				had_error: had_error.get(),
			}))
		},
	};
	streamed.unwrap_or_else(|| {
		search_collected_files(host, cli, matcher, searcher, operand, root, show_names, opts, stats, out)
	})
}

fn collect_filtered_files(host: &mut Host, cli: &Rg, root: &Path) -> io::Result<Vec<PathBuf>> {
	let walk = build_walk(host, cli, root).map_err(io::Error::other)?;
	let cancel = host.cancel_flag();
	let mut files = Vec::new();
	let result = walk.request.for_each_entry_with_heartbeat(
		|| {
			if cancel.load(std::sync::atomic::Ordering::Relaxed) {
				Err(io::Error::from(io::ErrorKind::Interrupted))
			} else {
				Ok::<(), io::Error>(())
			}
		},
		|entry| {
			if entry.file_type == pi_walker::FileType::File {
				let path = entry.absolute_path.as_ref();
				if walk.filters.includes(path, entry.file_type, entry.size) {
					files.push(path.to_path_buf());
				}
			}
			Ok(pi_walker::WalkDecision::Include)
		},
		|_| Ok(pi_walker::WalkDecision::Include),
	);
	match result {
		Ok(pi_walker::WalkStatus::Complete | pi_walker::WalkStatus::Stopped) => Ok(files),
		Err(pi_walker::WalkError::Interrupted(_)) if host.is_cancelled() => {
			Err(io::Error::other("rg: cancelled"))
		},
		Err(pi_walker::WalkError::Interrupted(error))
			if error.kind() == io::ErrorKind::BrokenPipe =>
		{
			Err(error)
		},
		Err(err) => Err(io::Error::other(format!("rg: {err}"))),
	}
}

fn list_files<W: Write>(
	host: &mut Host,
	cli: &Rg,
	paths: &[OsString],
	path_separator: Option<u8>,
	out: &mut W,
) -> SearchOutcome {
	let mut any = false;
	let mut had_error = false;
	let mut processed_operand = false;
	for operand in paths {
		if processed_operand && host.is_cancelled() {
			had_error = true;
			break;
		}
		processed_operand = true;
		let resolved = host.resolve(operand);
		match std::fs::metadata(&resolved) {
			Ok(meta) if meta.is_dir() => {
				let mut files = match collect_filtered_files(host, cli, &resolved) {
					Ok(files) => files,
					Err(_) if host.is_cancelled() => {
						had_error = true;
						break;
					},
					Err(err) => {
						let _ = writeln!(host.stderr, "{err}");
						had_error = true;
						continue;
					},
				};
				if cli.sortr.as_deref() == Some("path") {
					files.sort_unstable_by(|a, b| b.cmp(a));
				}
				for path in files {
					let display = display_path(operand.as_os_str(), &resolved, &path);
					let _ =
						write_display_bytes(out, display.as_os_str().as_encoded_bytes(), path_separator);
					let _ = out.write_all(if cli.null { b"\0" } else { b"\n" });
					any = true;
				}
			},
			Ok(meta) if meta.is_file() => {
				let _ = write_display_bytes(out, operand.as_encoded_bytes(), path_separator);
				let _ = out.write_all(if cli.null { b"\0" } else { b"\n" });
				any = true;
			},
			Ok(_) => {},
			Err(err) => {
				let _ = writeln!(host.stderr, "rg: {}: {err}", operand.to_string_lossy());
				had_error = true;
			},
		}
		if host.is_cancelled() {
			had_error = true;
			break;
		}
	}
	SearchOutcome { any_match: any, had_error }
}

fn default_paths(paths: &mut Vec<OsString>, use_implicit_stdin: bool) {
	if !paths.is_empty() {
		return;
	}
	if use_implicit_stdin {
		paths.push(OsString::from("-"));
	} else {
		paths.push(OsString::from("."));
	}
}

fn show_names_for(paths: &[OsString], recursive: bool, cli: &Rg, opts: &SearchOptions) -> bool {
	if cli.no_filename {
		false
	} else if cli.with_filename || opts.files_with_matches || opts.files_without_match || cli.vimgrep
	{
		true
	} else {
		recursive || paths.len() > 1
	}
}

fn write_json_summary<W: Write>(out: &mut W, stats: &Stats) -> io::Result<()> {
	let elapsed = stats.elapsed();
	let summary = serde_json::json!({
		"type": "summary",
		"data": {
			"stats": {
				"elapsed": {
					"secs": elapsed.as_secs(),
					"nanos": elapsed.subsec_nanos(),
					"human": format!("{elapsed:?}"),
				},
				"searches": stats.searches(),
				"searches_with_match": stats.searches_with_match(),
				"bytes_searched": stats.bytes_searched(),
				"bytes_printed": stats.bytes_printed(),
				"matched_lines": stats.matched_lines(),
				"matches": stats.matches(),
			}
		}
	});
	serde_json::to_writer(&mut *out, &summary).map_err(|error| {
		io::Error::new(error.io_error_kind().unwrap_or(io::ErrorKind::Other), error)
	})?;
	out.write_all(b"\n")
}

fn execute_search<M: Matcher, W: Write>(
	host: &mut Host,
	cli: &Rg,
	matcher: &M,
	paths: &[OsString],
	opts: &SearchOptions,
	out: &mut W,
) -> i32 {
	let mut auto_searcher = match build_searcher(cli, opts, BinaryMode::Automatic) {
		Ok(searcher) => searcher,
		Err(error) => {
			let _ = writeln!(host.stderr, "rg: {error}");
			return 2;
		},
	};
	let mut explicit_searcher = match build_searcher(cli, opts, BinaryMode::Explicit) {
		Ok(searcher) => searcher,
		Err(error) => {
			let _ = writeln!(host.stderr, "rg: {error}");
			return 2;
		},
	};
	let recursive = paths.iter().any(|path| {
		path.as_os_str() != OsStr::new("-")
			&& std::fs::metadata(host.resolve(path)).is_ok_and(|meta| meta.is_dir())
	});
	let show_names = show_names_for(paths, recursive, cli, opts);
	let mut stats = Stats::new();
	let mut any_match = false;
	let mut had_error = false;
	let mut processed_operand = false;
	for operand in paths {
		if opts.quiet && any_match {
			break;
		}
		if processed_operand && host.is_cancelled() {
			had_error = true;
			break;
		}
		processed_operand = true;
		if operand.as_os_str() == OsStr::new("-") {
			let display = show_names.then_some(b"<stdin>".as_slice());
			match process_reader(
				matcher,
				&mut explicit_searcher,
				&mut host.stdin,
				display,
				opts,
				&mut stats,
				out,
			) {
				Ok(matched) => any_match |= matched,
				Err(error) if error.kind() == io::ErrorKind::BrokenPipe => {
					return SIGPIPE_EXIT_CODE;
				},
				Err(error) => {
					had_error = true;
					if !opts.no_messages {
						let _ = writeln!(host.stderr, "rg: <stdin>: {error}");
					}
				},
			}
			if host.is_cancelled() {
				had_error = true;
				break;
			}
			continue;
		}
		let resolved = host.resolve(operand);
		match std::fs::metadata(&resolved) {
			Ok(meta) if meta.is_dir() => {
				match search_dir(
					host,
					cli,
					matcher,
					&mut auto_searcher,
					operand.as_os_str(),
					&resolved,
					show_names,
					opts,
					&mut stats,
					out,
				) {
					Ok(outcome) => {
						any_match |= outcome.any_match;
						had_error |= outcome.had_error;
					},
					Err(error) if error.kind() == io::ErrorKind::BrokenPipe => {
						return SIGPIPE_EXIT_CODE;
					},
					Err(error) => {
						had_error = true;
						if !opts.no_messages {
							let _ = writeln!(host.stderr, "rg: {error}");
						}
					},
				}
			},
			Ok(meta) if meta.is_file() => {
				let display =
					(show_names || opts.json).then_some(operand.as_os_str().as_encoded_bytes());
				match process_file(
					host,
					cli,
					matcher,
					&mut explicit_searcher,
					&resolved,
					display,
					opts,
					&mut stats,
					out,
				) {
					Ok(outcome) => {
						any_match |= outcome.any_match;
						had_error |= outcome.had_error;
					},
					Err(error) if error.kind() == io::ErrorKind::BrokenPipe => {
						return SIGPIPE_EXIT_CODE;
					},
					Err(error) => {
						had_error = true;
						if !opts.no_messages {
							let _ = writeln!(host.stderr, "rg: {error}");
						}
					},
				}
			},
			Ok(_) => {},
			Err(error) => {
				had_error = true;
				if !opts.no_messages {
					let _ =
						writeln!(host.stderr, "rg: {}: {error}", operand.to_string_lossy());
				}
			},
		}
		if host.is_cancelled() {
			had_error = true;
			break;
		}
	}
	if opts.json {
		if write_json_summary(out, &stats)
			.is_err_and(|error| error.kind() == io::ErrorKind::BrokenPipe)
		{
			return SIGPIPE_EXIT_CODE;
		}
	}
	if out.flush().is_err_and(|error| error.kind() == io::ErrorKind::BrokenPipe) {
		return SIGPIPE_EXIT_CODE;
	}
	if opts.quiet {
		if any_match {
			0
		} else if had_error {
			2
		} else {
			1
		}
	} else if had_error {
		2
	} else if any_match {
		0
	} else {
		1
	}
}

impl Utility for Rg {
	const NAME: &'static str = "rg";
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {
		let cli = self;
	let mut opts = search_options(&cli);
	match parse_path_separator(cli.path_separator.as_deref()) {
		Ok(separator) => opts.path_separator = separator,
		Err(error) => {
			let _ = writeln!(host.stderr, "rg: {error}");
			return 2;
		},
	}
	if opts.json
		&& (cli.files
			|| cli.type_list
			|| opts.count
			|| opts.count_matches
			|| opts.files_with_matches
			|| opts.files_without_match
			|| opts.quiet
			|| cli.only_matching
			|| cli.vimgrep)
	{
		let _ = writeln!(host.stderr, "rg: --json cannot be combined with summary modes");
		return 2;
	}
	let mut out = if cli.line_buffered && !cli.no_line_buffered {
		StreamWriter::line(host.stdout_clone())
	} else if cli.no_line_buffered {
		StreamWriter::block(host.stdout_clone())
	} else {
		host.stdout_writer()
	};
	let (patterns, mut paths) = match resolve_patterns(host, &cli) {
		Ok(resolved) => resolved,
		Err(error) => {
			let _ = writeln!(host.stderr, "{error}");
			return 2;
		},
	};
	if cli.type_list {
		return match print_type_list(&cli, &mut out) {
			Ok(()) => 0,
			Err(error) => {
				let _ = writeln!(host.stderr, "rg: {error}");
				2
			},
		};
	}
	let pattern_stdin_consumed = cli.pattern_files.iter().any(|file| file == OsStr::new("-"));
	default_paths(
		&mut paths,
		!cli.files && !pattern_stdin_consumed && host.stdin_is_search_input(),
	);
	opts.line_number = effective_line_number(&cli);
	if cli.files {
		let outcome = list_files(host, &cli, &paths, opts.path_separator, &mut out);
		let _ = out.flush();
		return if outcome.had_error {
			2
		} else if outcome.any_match {
			0
		} else {
			1
		};
	}
	if patterns.is_empty() {
		return 1;
	}
	let matcher = match build_matcher(host, &patterns, &cli) {
		Ok(matcher) => matcher,
		Err(error) => {
			let _ = writeln!(host.stderr, "rg: {error}");
			return 2;
		},
	};
	match &matcher {
		CompiledMatcher::Rust(matcher) => execute_search(host, &cli, matcher, &paths, &opts, &mut out),
		CompiledMatcher::Pcre(matcher) => execute_search(host, &cli, matcher, &paths, &opts, &mut out),
	}
}
}



use brush_core::{ShellExtensions, builtins::Registration};

use crate::host::util;


pub(crate) fn rg_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Rg, SE>()
}
