





use std::{
	borrow::Cow,
	collections::BTreeSet,
	ffi::{OsStr, OsString},
	fs,
	io::{Read, Write},
	ops::Range,
	path::{Path, PathBuf},
	time::SystemTime,
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{ArgAction, Parser};
use similar::{Algorithm, DiffOp, DiffTag, capture_diff_slices};

use crate::host::{Host, Utility, util};


#[derive(Parser)]
#[command(
	name = "diff",
	version = "diff (pi-uu-diff) 0.8.0",
	about = "Compare files line by line.",
	override_usage = "diff [OPTION]... FILE1 FILE2",
	infer_long_args = true
)]
pub(crate) struct Diff {

	#[arg(short = 'u', action = ArgAction::SetTrue)]
	unified_flag: bool,


	#[arg(short = 'U', long = "unified", value_name = "NUM")]
	unified: Option<usize>,


	#[arg(short = 'c', action = ArgAction::SetTrue, conflicts_with_all = ["unified_flag", "unified"])]
	context_flag: bool,


	#[arg(
		short = 'C',
		long = "context",
		value_name = "NUM",
		conflicts_with_all = ["unified_flag", "unified"]
	)]
	context: Option<usize>,


	#[arg(short = 'q', long = "brief", action = ArgAction::SetTrue)]
	brief: bool,


	#[arg(short = 's', long = "report-identical-files", action = ArgAction::SetTrue)]
	report_identical: bool,


	#[arg(short = 'r', long = "recursive", action = ArgAction::SetTrue)]
	recursive: bool,


	#[arg(short = 'N', long = "new-file", action = ArgAction::SetTrue)]
	new_file: bool,


	#[arg(short = 'i', long = "ignore-case", action = ArgAction::SetTrue)]
	ignore_case: bool,


	#[arg(short = 'w', long = "ignore-all-space", action = ArgAction::SetTrue)]
	ignore_all_space: bool,


	#[arg(short = 'b', long = "ignore-space-change", action = ArgAction::SetTrue)]
	ignore_space_change: bool,


	#[arg(short = 'B', long = "ignore-blank-lines", action = ArgAction::SetTrue)]
	ignore_blank_lines: bool,


	#[arg(long = "strip-trailing-cr", action = ArgAction::SetTrue)]
	strip_trailing_cr: bool,


	#[arg(short = 'x', long = "exclude", value_name = "PAT", action = ArgAction::Append)]
	exclude: Vec<String>,



	#[arg(short = 'L', long = "label", value_name = "LABEL", action = ArgAction::Append)]
	labels: Vec<OsString>,


	#[arg(
		long = "color",
		value_name = "WHEN",
		num_args = 0..=1,
		require_equals = true,
		default_missing_value = "auto"
	)]
	_color: Option<String>,


	#[arg(required = true, num_args = 2, value_hint = clap::ValueHint::AnyPath)]
	files: Vec<OsString>,
}



#[derive(Clone, Copy)]
enum Format {
	Normal,
	Unified(usize),
	Context(usize),
}

#[derive(Clone, Copy)]
struct Options<'a> {
	format:              Format,
	brief:               bool,
	report_identical:    bool,
	recursive:           bool,
	new_file:            bool,
	ignore_case:         bool,
	ignore_all_space:    bool,
	ignore_space_change: bool,
	ignore_blank_lines:  bool,
	strip_trailing_cr:   bool,
	labels:              &'a [OsString],
	excludes:            &'a [glob::Pattern],
}


enum Operand {

	Stdin,

	File(PathBuf),

	Dir(PathBuf),

	Absent,
}

impl Utility for Diff {
	const NAME: &'static str = "diff";
	const USAGE_ERROR: u8 = 2;

	fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		let mut out = Vec::with_capacity(argv.len());
		let mut iter = argv.into_iter();
		if let Some(name) = iter.next() {
			out.push(name);
		}
		let mut past_separator = false;
		for arg in iter {
			if !past_separator {
				if arg == "--" {
					past_separator = true;
				} else if let Some(rewritten) = rewrite_obsolete_count(&arg) {
					out.push(rewritten);
					continue;
				}
			}
			out.push(arg);
		}
		Ok(out)
	}

	fn run(self, host: &mut Host) -> i32 {
		if self.labels.len() > 2 {
			host.error("too many file label options", 2);
			return 2;
		}


		let excludes: Vec<glob::Pattern> = self
			.exclude
			.iter()
			.map(|pat| {
				glob::Pattern::new(pat).unwrap_or_else(|_| {
					glob::Pattern::new(&glob::Pattern::escape(pat))
						.expect("escaped pattern always compiles")
				})
			})
			.collect();
		let format = if let Some(num) = self.unified {
			Format::Unified(num)
		} else if self.unified_flag {
			Format::Unified(3)
		} else if let Some(num) = self.context {
			Format::Context(num)
		} else if self.context_flag {
			Format::Context(3)
		} else {
			Format::Normal
		};
		let opts = Options {
			format,
			brief: self.brief,
			report_identical: self.report_identical,
			recursive: self.recursive,
			new_file: self.new_file,
			ignore_case: self.ignore_case,
			ignore_all_space: self.ignore_all_space,
			ignore_space_change: self.ignore_space_change,
			ignore_blank_lines: self.ignore_blank_lines,
			strip_trailing_cr: self.strip_trailing_cr,
			labels: &self.labels,
			excludes: &excludes,
		};
		match diff_main(&self.files, opts, host) {
			Ok(code) => code,
			Err(message) => {
				host.error(message, 2);
				2
			},
		}
	}
}



fn rewrite_obsolete_count(arg: &OsStr) -> Option<OsString> {
	let text = arg.to_str()?;
	let (upper, digits) = text
		.strip_prefix("-u")
		.map(|rest| ('U', rest))
		.or_else(|| text.strip_prefix("-c").map(|rest| ('C', rest)))?;
	if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
		return None;
	}
	Some(OsString::from(format!("-{upper}{digits}")))
}

fn diff_main(files: &[OsString], opts: Options<'_>, host: &mut Host) -> Result<i32, String> {
	let (mut name_a, mut name_b) = (PathBuf::from(&files[0]), PathBuf::from(&files[1]));
	let mut op_a = classify(&name_a, opts.new_file, host)?;
	let mut op_b = classify(&name_b, opts.new_file, host)?;



	let a_is_dir = matches!(op_a, Operand::Dir(_));
	let b_is_dir = matches!(op_b, Operand::Dir(_));
	if a_is_dir != b_is_dir {
		if matches!(op_a, Operand::Stdin) || matches!(op_b, Operand::Stdin) {
			return Err("cannot compare '-' to a directory".to_string());
		}
		if a_is_dir {
			name_a = descend(&name_a, &name_b)?;
			op_a = classify(&name_a, opts.new_file, host)?;
		} else {
			name_b = descend(&name_b, &name_a)?;
			op_b = classify(&name_b, opts.new_file, host)?;
		}
	}

	let differed = if let (Operand::Dir(res_a), Operand::Dir(res_b)) = (&op_a, &op_b) {
		diff_dirs(&name_a, res_a, &name_b, res_b, opts, host)?
	} else {
		let (bytes_a, mtime_a) = read_operand(&op_a, &name_a, host)?;
		let (bytes_b, mtime_b) = read_operand(&op_b, &name_b, host)?;
		diff_pair(&name_a, &bytes_a, mtime_a, &name_b, &bytes_b, mtime_b, opts, None, host)?
	};
	Ok(i32::from(differed))
}



fn descend(dir: &Path, other: &Path) -> Result<PathBuf, String> {
	let base = other
		.file_name()
		.ok_or_else(|| format!("cannot compare {} to a directory", other.display()))?;
	Ok(dir.join(base))
}

fn classify(name: &Path, new_file: bool, host: &Host) -> Result<Operand, String> {
	if name.as_os_str() == OsStr::new("-") {
		return Ok(Operand::Stdin);
	}


	let resolved = host.resolve(name);
	match fs::metadata(&resolved) {
		Ok(meta) if meta.is_dir() => Ok(Operand::Dir(resolved)),
		Ok(_) => Ok(Operand::File(resolved)),
		Err(err) if err.kind() == std::io::ErrorKind::NotFound && new_file => Ok(Operand::Absent),
		Err(err) => Err(format!("{}: {}", name.display(), io_msg(&err))),
	}
}




fn read_operand(
	op: &Operand,
	name: &Path,
	host: &mut Host,
) -> Result<(Vec<u8>, Option<SystemTime>), String> {
	match op {
		Operand::Stdin => {
			let mut buf = Vec::new();
			host.stdin
				.read_to_end(&mut buf)
				.map_err(|err| format!("-: {}", io_msg(&err)))?;
			Ok((buf, None))
		},
		Operand::File(resolved) => {
			let bytes = fs::read(resolved)
				.map_err(|err| format!("{}: {}", name.display(), io_msg(&err)))?;
			let mtime = fs::metadata(resolved).ok().and_then(|meta| meta.modified().ok());
			Ok((bytes, mtime))
		},
		Operand::Dir(_) => unreachable!("directories are handled by diff_dirs"),
		Operand::Absent => Ok((Vec::new(), Some(SystemTime::UNIX_EPOCH))),
	}
}



struct FileLines<'a> {
	lines:           Vec<&'a str>,
	missing_newline: bool,
}

impl<'a> FileLines<'a> {
	fn split(text: &'a str) -> Self {
		let lines = text
			.split_inclusive('\n')
			.map(|line| line.strip_suffix('\n').unwrap_or(line))
			.collect();
		FileLines { lines, missing_newline: !text.is_empty() && !text.ends_with('\n') }
	}
}



fn normalize_line<'a>(line: &'a str, opts: Options<'_>) -> Cow<'a, str> {
	let mut norm: Cow<'a, str> = Cow::Borrowed(line);
	if opts.strip_trailing_cr {
		if let Some(stripped) = line.strip_suffix('\r') {
			norm = Cow::Borrowed(stripped);
		}
	}
	if opts.ignore_case {
		norm = Cow::Owned(norm.to_lowercase());
	}
	if opts.ignore_all_space {
		if norm.contains(char::is_whitespace) {
			norm = Cow::Owned(norm.chars().filter(|ch| !ch.is_whitespace()).collect());
		}
	} else if opts.ignore_space_change && norm.contains(char::is_whitespace) {
		norm = Cow::Owned(collapse_spaces(norm.trim_end()));
	}
	norm
}


fn collapse_spaces(line: &str) -> String {
	let mut out = String::with_capacity(line.len());
	let mut in_space = false;
	for ch in line.chars() {
		if ch.is_whitespace() {
			if !in_space {
				out.push(' ');
			}
			in_space = true;
		} else {
			out.push(ch);
			in_space = false;
		}
	}
	out
}




fn normalize_lines<'a>(file: &FileLines<'a>, opts: Options<'_>) -> Vec<Cow<'a, str>> {
	let mut norm: Vec<Cow<'a, str>> =
		file.lines.iter().map(|&line| normalize_line(line, opts)).collect();
	if file.missing_newline {
		if let Some(last) = norm.last_mut() {
			last.to_mut().push('\0');
		}
	}
	norm
}


fn is_suppressed(
	op: &DiffOp,
	norm_a: &[Cow<'_, str>],
	norm_b: &[Cow<'_, str>],
	opts: Options<'_>,
) -> bool {
	if !opts.ignore_blank_lines || op.tag() == DiffTag::Equal {
		return false;
	}
	let blank = |line: &Cow<'_, str>| line.trim().is_empty();
	norm_a[op.old_range()].iter().all(blank) && norm_b[op.new_range()].iter().all(blank)
}



fn wline(host: &mut Host, line: std::fmt::Arguments<'_>) -> Result<(), String> {
	writeln!(host.stdout, "{line}").map_err(|e| io_msg(&e))
}



#[allow(clippy::too_many_arguments)]
fn diff_pair(
	name_a: &Path,
	bytes_a: &[u8],
	mtime_a: Option<SystemTime>,
	name_b: &Path,
	bytes_b: &[u8],
	mtime_b: Option<SystemTime>,
	opts: Options<'_>,
	prefix: Option<&str>,
	host: &mut Host,
) -> Result<bool, String> {
	let label_a = display_label(opts.labels.first(), name_a);
	let label_b = display_label(opts.labels.get(1), name_b);
	if bytes_a == bytes_b {
		if opts.report_identical {
			wline(host, format_args!("Files {label_a} and {label_b} are identical"))?;
		}
		return Ok(false);
	}
	if is_binary(bytes_a) || is_binary(bytes_b) {
		if opts.brief {
			wline(host, format_args!("Files {label_a} and {label_b} differ"))?;
		} else {
			wline(host, format_args!("Binary files {label_a} and {label_b} differ"))?;
		}
		return Ok(true);
	}
	let text_a = String::from_utf8_lossy(bytes_a);
	let text_b = String::from_utf8_lossy(bytes_b);
	let old = FileLines::split(&text_a);
	let new = FileLines::split(&text_b);
	let norm_a = normalize_lines(&old, opts);
	let norm_b = normalize_lines(&new, opts);
	let ops = capture_diff_slices(Algorithm::Myers, &norm_a, &norm_b);
	let suppressed: Vec<bool> =
		ops.iter().map(|op| is_suppressed(op, &norm_a, &norm_b, opts)).collect();


	if !ops.iter().zip(&suppressed).any(|(op, &sup)| op.tag() != DiffTag::Equal && !sup) {
		if opts.report_identical {
			wline(host, format_args!("Files {label_a} and {label_b} are identical"))?;
		}
		return Ok(false);
	}
	if opts.brief {
		wline(host, format_args!("Files {label_a} and {label_b} differ"))?;
		return Ok(true);
	}
	if let Some(line) = prefix {
		wline(host, format_args!("{line}"))?;
	}
	match opts.format {
		Format::Normal => write_normal(host, &ops, &suppressed, &old, &new)?,
		Format::Unified(context) => {
			wline(host, format_args!("--- {}", header(opts.labels.first(), name_a, mtime_a)))?;
			wline(host, format_args!("+++ {}", header(opts.labels.get(1), name_b, mtime_b)))?;
			write_unified(host, &ops, &suppressed, &old, &new, context)?;
		},
		Format::Context(context) => {
			wline(host, format_args!("*** {}", header(opts.labels.first(), name_a, mtime_a)))?;
			wline(host, format_args!("--- {}", header(opts.labels.get(1), name_b, mtime_b)))?;
			write_context_format(host, &ops, &suppressed, &old, &new, context)?;
		},
	}
	Ok(true)
}

fn display_label(label: Option<&OsString>, name: &Path) -> String {
	label.map_or_else(|| name.display().to_string(), |label| label.to_string_lossy().into_owned())
}



fn header(label: Option<&OsString>, name: &Path, mtime: Option<SystemTime>) -> String {
	match label {
		Some(label) => label.to_string_lossy().into_owned(),
		None => format!("{}\t{}", name.display(), timestamp(mtime)),
	}
}



fn timestamp(mtime: Option<SystemTime>) -> String {
	let time = mtime.unwrap_or_else(SystemTime::now);
	chrono::DateTime::<chrono::Local>::from(time)
		.format("%Y-%m-%d %H:%M:%S%.9f %z")
		.to_string()
}



fn write_marked(
	host: &mut Host,
	marker: &str,
	range: Range<usize>,
	file: &FileLines<'_>,
) -> Result<(), String> {
	for idx in range {
		wline(host, format_args!("{marker}{}", file.lines[idx]))?;
		if idx + 1 == file.lines.len() && file.missing_newline {
			wline(host, format_args!("\\ No newline at end of file"))?;
		}
	}
	Ok(())
}


fn normal_range(range: &Range<usize>) -> String {
	if range.len() <= 1 {
		(range.start + 1).to_string()
	} else {
		format!("{},{}", range.start + 1, range.end)
	}
}


fn write_normal(
	host: &mut Host,
	ops: &[DiffOp],
	suppressed: &[bool],
	old: &FileLines<'_>,
	new: &FileLines<'_>,
) -> Result<(), String> {
	for (op, &sup) in ops.iter().zip(suppressed) {
		if sup || op.tag() == DiffTag::Equal {
			continue;
		}
		let (old_range, new_range) = (op.old_range(), op.new_range());
		match op.tag() {
			DiffTag::Delete => {


				wline(host, format_args!("{}d{}", normal_range(&old_range), new_range.start))?;
				write_marked(host, "< ", old_range, old)?;
			},
			DiffTag::Insert => {
				wline(host, format_args!("{}a{}", old_range.start, normal_range(&new_range)))?;
				write_marked(host, "> ", new_range, new)?;
			},
			DiffTag::Replace => {
				wline(
					host,
					format_args!("{}c{}", normal_range(&old_range), normal_range(&new_range)),
				)?;
				write_marked(host, "< ", old_range, old)?;
				wline(host, format_args!("---"))?;
				write_marked(host, "> ", new_range, new)?;
			},
			DiffTag::Equal => unreachable!(),
		}
	}
	Ok(())
}




fn group_ops(ops: &[DiffOp], suppressed: &[bool], context: usize) -> Vec<(usize, usize)> {
	let mut groups: Vec<(usize, usize)> = Vec::new();
	for (idx, op) in ops.iter().enumerate() {
		if op.tag() == DiffTag::Equal {
			continue;
		}
		if let Some(last) = groups.last_mut() {
			let gap = op.old_range().start - ops[last.1].old_range().end;
			if gap <= 2 * context {
				last.1 = idx;
				continue;
			}
		}
		groups.push((idx, idx));
	}
	groups.retain(|&(first, last)| {
		ops[first..=last]
			.iter()
			.zip(&suppressed[first..=last])
			.any(|(op, &sup)| op.tag() != DiffTag::Equal && !sup)
	});
	groups
}


fn group_padding(ops: &[DiffOp], first: usize, last: usize, context: usize) -> (usize, usize) {
	let lead = if first > 0 { context.min(ops[first - 1].old_range().len()) } else { 0 };
	let trail = ops.get(last + 1).map_or(0, |op| context.min(op.old_range().len()));
	(lead, trail)
}



fn unified_range(start: usize, count: usize) -> String {
	match count {
		0 => format!("{start},0"),
		1 => (start + 1).to_string(),
		_ => format!("{},{count}", start + 1),
	}
}

fn write_unified(
	host: &mut Host,
	ops: &[DiffOp],
	suppressed: &[bool],
	old: &FileLines<'_>,
	new: &FileLines<'_>,
	context: usize,
) -> Result<(), String> {
	for (first, last) in group_ops(ops, suppressed, context) {
		let (lead, trail) = group_padding(ops, first, last, context);
		let old_start = ops[first].old_range().start - lead;
		let new_start = ops[first].new_range().start - lead;
		let old_count = ops[last].old_range().end + trail - old_start;
		let new_count = ops[last].new_range().end + trail - new_start;
		wline(
			host,
			format_args!(
				"@@ -{} +{} @@",
				unified_range(old_start, old_count),
				unified_range(new_start, new_count)
			),
		)?;
		write_marked(host, " ", old_start..ops[first].old_range().start, old)?;
		for op in &ops[first..=last] {
			match op.tag() {
				DiffTag::Equal => write_marked(host, " ", op.old_range(), old)?,
				DiffTag::Delete => write_marked(host, "-", op.old_range(), old)?,
				DiffTag::Insert => write_marked(host, "+", op.new_range(), new)?,
				DiffTag::Replace => {
					write_marked(host, "-", op.old_range(), old)?;
					write_marked(host, "+", op.new_range(), new)?;
				},
			}
		}
		let tail = ops[last].old_range().end;
		write_marked(host, " ", tail..tail + trail, old)?;
	}
	Ok(())
}


fn context_range(start: usize, count: usize) -> String {
	match count {
		0 => start.to_string(),
		1 => (start + 1).to_string(),
		_ => format!("{},{}", start + 1, start + count),
	}
}

fn write_context_format(
	host: &mut Host,
	ops: &[DiffOp],
	suppressed: &[bool],
	old: &FileLines<'_>,
	new: &FileLines<'_>,
	context: usize,
) -> Result<(), String> {
	for (first, last) in group_ops(ops, suppressed, context) {
		let (lead, trail) = group_padding(ops, first, last, context);
		let old_start = ops[first].old_range().start - lead;
		let new_start = ops[first].new_range().start - lead;
		let old_count = ops[last].old_range().end + trail - old_start;
		let new_count = ops[last].new_range().end + trail - new_start;
		let group = &ops[first..=last];
		wline(host, format_args!("***************"))?;
		wline(host, format_args!("*** {} ****", context_range(old_start, old_count)))?;

		if group.iter().any(|op| matches!(op.tag(), DiffTag::Delete | DiffTag::Replace)) {
			write_marked(host, "  ", old_start..ops[first].old_range().start, old)?;
			for op in group {
				match op.tag() {
					DiffTag::Equal => write_marked(host, "  ", op.old_range(), old)?,
					DiffTag::Delete => write_marked(host, "- ", op.old_range(), old)?,
					DiffTag::Replace => write_marked(host, "! ", op.old_range(), old)?,
					DiffTag::Insert => {},
				}
			}
			let tail = ops[last].old_range().end;
			write_marked(host, "  ", tail..tail + trail, old)?;
		}
		wline(host, format_args!("--- {} ----", context_range(new_start, new_count)))?;
		if group.iter().any(|op| matches!(op.tag(), DiffTag::Insert | DiffTag::Replace)) {
			write_marked(host, "  ", new_start..ops[first].new_range().start, new)?;
			for op in group {
				match op.tag() {
					DiffTag::Equal => write_marked(host, "  ", op.new_range(), new)?,
					DiffTag::Insert => write_marked(host, "+ ", op.new_range(), new)?,
					DiffTag::Replace => write_marked(host, "! ", op.new_range(), new)?,
					DiffTag::Delete => {},
				}
			}
			let tail = ops[last].new_range().end;
			write_marked(host, "  ", tail..tail + trail, new)?;
		}
	}
	Ok(())
}



fn pair_prefix(name_a: &Path, name_b: &Path, opts: Options<'_>) -> String {
	let flag = if opts.recursive { " -r" } else { "" };
	format!("diff{flag} {} {}", name_a.display(), name_b.display())
}


fn is_excluded(name: &OsStr, excludes: &[glob::Pattern]) -> bool {
	if excludes.is_empty() {
		return false;
	}
	let name = name.to_string_lossy();
	excludes.iter().any(|pattern| pattern.matches(&name))
}




fn diff_dirs(
	name_a: &Path,
	res_a: &Path,
	name_b: &Path,
	res_b: &Path,
	opts: Options<'_>,
	host: &mut Host,
) -> Result<bool, String> {
	let mut names: BTreeSet<OsString> = BTreeSet::new();
	for (dir_name, dir_res) in [(name_a, res_a), (name_b, res_b)] {
		let entries = fs::read_dir(dir_res)
			.map_err(|err| format!("{}: {}", dir_name.display(), io_msg(&err)))?;
		for entry in entries {
			let entry = entry.map_err(|err| format!("{}: {}", dir_name.display(), io_msg(&err)))?;
			let name = entry.file_name();
			if !is_excluded(&name, opts.excludes) {
				names.insert(name);
			}
		}
	}

	let mut differed = false;
	for name in names {
		if host.is_cancelled() {
			return Err("interrupted".to_string());
		}
		let (child_name_a, child_name_b) = (name_a.join(&name), name_b.join(&name));


		let child_res_a = host.resolve(&child_name_a);
		let child_res_b = host.resolve(&child_name_b);
		let meta_a = fs::metadata(&child_res_a).ok();
		let meta_b = fs::metadata(&child_res_b).ok();
		match (meta_a.as_ref(), meta_b.as_ref()) {
			(Some(ma), Some(mb)) if ma.is_dir() && mb.is_dir() => {
				if opts.recursive {
					differed |= diff_dirs(
						&child_name_a,
						&child_res_a,
						&child_name_b,
						&child_res_b,
						opts,
						host,
					)?;
				} else {
					wline(
						host,
						format_args!(
							"Common subdirectories: {} and {}",
							child_name_a.display(),
							child_name_b.display()
						),
					)?;
				}
			},
			(Some(ma), Some(mb)) if ma.is_dir() != mb.is_dir() => {
				let (dir, file) = if ma.is_dir() {
					(&child_name_a, &child_name_b)
				} else {
					(&child_name_b, &child_name_a)
				};
				wline(
					host,
					format_args!(
						"File {} is a directory while file {} is a regular file",
						dir.display(),
						file.display()
					),
				)?;
				differed = true;
			},
			(Some(ma), Some(mb)) => {
				let bytes_a = fs::read(&child_res_a)
					.map_err(|err| format!("{}: {}", child_name_a.display(), io_msg(&err)))?;
				let bytes_b = fs::read(&child_res_b)
					.map_err(|err| format!("{}: {}", child_name_b.display(), io_msg(&err)))?;
				let prefix = pair_prefix(&child_name_a, &child_name_b, opts);
				differed |= diff_pair(
					&child_name_a,
					&bytes_a,
					ma.modified().ok(),
					&child_name_b,
					&bytes_b,
					mb.modified().ok(),
					opts,
					Some(&prefix),
					host,
				)?;
			},
			(Some(meta), None) | (None, Some(meta)) => {
				let in_a = meta_b.is_none();
				if opts.new_file && meta.is_file() {
					let (present_name, present_res) = if in_a {
						(&child_name_a, &child_res_a)
					} else {
						(&child_name_b, &child_res_b)
					};
					let bytes = fs::read(present_res)
						.map_err(|err| format!("{}: {}", present_name.display(), io_msg(&err)))?;
					let prefix = pair_prefix(&child_name_a, &child_name_b, opts);
					let present_mtime = meta.modified().ok();
					let epoch = Some(SystemTime::UNIX_EPOCH);
					let (ba, bb, mta, mtb): (&[u8], &[u8], _, _) = if in_a {
						(&bytes, &[], present_mtime, epoch)
					} else {
						(&[], &bytes, epoch, present_mtime)
					};
					differed |= diff_pair(
						&child_name_a,
						ba,
						mta,
						&child_name_b,
						bb,
						mtb,
						opts,
						Some(&prefix),
						host,
					)?;
				} else {
					let present_dir = if in_a { name_a } else { name_b };
					wline(
						host,
						format_args!(
							"Only in {}: {}",
							present_dir.display(),
							Path::new(&name).display()
						),
					)?;
					differed = true;
				}
			},
			(None, None) => {},
		}
	}
	Ok(differed)
}



fn is_binary(bytes: &[u8]) -> bool {
	bytes.iter().take(8192).any(|&byte| byte == 0)
}


fn io_msg(err: &std::io::Error) -> String {
	let msg = err.to_string();
	match msg.find(" (os error") {
		Some(idx) => msg[..idx].to_string(),
		None => msg,
	}
}


pub(crate) fn diff_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Diff, SE>()
}


