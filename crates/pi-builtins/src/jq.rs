use core::fmt::{self, Display, Formatter};
use std::{
	cell::RefCell,
	ffi::OsString,
	io::{self, BufRead, Write},
	path::PathBuf,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
};

use brush_core::{ShellExtensions, builtins::Registration, openfiles::OpenFile};
use clap::{ArgMatches, Command, CommandFactory, FromArgMatches, Parser, error::ErrorKind};
use cli::Cli;
use filter::{FileReports, Filter};
use jaq_json::Val;

use crate::host::{Host, Utility, util};

mod cli {

	use core::fmt;
	use std::{ffi::OsString, path::PathBuf};

	type Args = std::vec::IntoIter<OsString>;

	#[derive(Debug, Default)]
	pub struct Cli {
		pub null_input: bool,

		pub raw_input: bool,

		pub slurp: bool,

		pub compact_output: bool,
		pub raw_output:     bool,

		pub join_output:       bool,
		pub in_place:          bool,
		pub sort_keys:         bool,
		pub color_output:      bool,
		pub monochrome_output: bool,
		pub tab:               bool,
		pub indent:            usize,

		pub from_file: bool,

		pub library_path: Vec<PathBuf>,

		pub arg:       Vec<(String, String)>,
		pub argjson:   Vec<(String, String)>,
		pub slurpfile: Vec<(String, OsString)>,
		pub rawfile:   Vec<(String, OsString)>,

		pub filter: Option<Filter>,
		pub files:  Vec<PathBuf>,
		pub args:   Vec<String>,

		pub run_tests: Option<Vec<PathBuf>>,

		pub exit_status: bool,
		pub version:     bool,
		pub help:        bool,
	}

	#[derive(Debug)]
	pub enum Filter {
		Inline(String),
		FromFile(PathBuf),
	}

	impl Cli {
		fn positional(&mut self, mode: &Mode, arg: OsString) -> Result<(), Error> {
			if self.filter.is_none() {
				self.filter = Some(if self.from_file {
					Filter::FromFile(arg.into())
				} else {
					Filter::Inline(arg.into_string()?)
				})
			} else {
				match mode {
					Mode::Files => self.files.push(arg.into()),
					Mode::Args => self.args.push(arg.into_string()?),
				}
			}
			Ok(())
		}

		fn long(&mut self, mode: &mut Mode, arg: &str, args: &mut Args) -> Result<(), Error> {
			let int = |s: OsString| s.into_string().ok()?.parse().ok();
			match arg {
				"" => args.try_for_each(|arg| self.positional(mode, arg))?,

				"null-input" => self.short('n', args)?,
				"raw-input" => self.short('R', args)?,
				"slurp" => self.short('s', args)?,

				"compact-output" => self.short('c', args)?,
				"raw-output" => self.short('r', args)?,
				"join-output" => self.short('j', args)?,
				"in-place" => self.short('i', args)?,
				"sort-keys" => self.short('S', args)?,
				"color-output" => self.short('C', args)?,
				"monochrome-output" => self.short('M', args)?,
				"tab" => self.tab = true,
				"indent" => self.indent = args.next().and_then(int).ok_or(Error::Int("--indent"))?,
				"from-file" => self.short('f', args)?,
				"library-path" => self.short('L', args)?,
				"arg" => {
					let (name, value) = parse_key_val("--arg", args)?;
					self.arg.push((name, value.into_string()?));
				},
				"argjson" => {
					let (name, value) = parse_key_val("--argjson", args)?;
					self.argjson.push((name, value.into_string()?));
				},
				"slurpfile" => self.slurpfile.push(parse_key_val("--slurpfile", args)?),
				"rawfile" => self.rawfile.push(parse_key_val("--rawfile", args)?),

				"args" => *mode = Mode::Args,

				"run-tests" => self.run_tests = Some(args.map(PathBuf::from).collect()),
				"exit-status" => self.short('e', args)?,
				"version" => self.short('V', args)?,
				"help" => self.short('h', args)?,

				arg => Err(Error::Flag(format!("--{arg}")))?,
			}
			Ok(())
		}

		fn short(&mut self, arg: char, args: &mut Args) -> Result<(), Error> {
			match arg {
				'n' => self.null_input = true,
				'R' => self.raw_input = true,
				's' => self.slurp = true,

				'c' => self.compact_output = true,
				'r' => self.raw_output = true,
				'j' => self.join_output = true,
				'i' => self.in_place = true,
				'S' => self.sort_keys = true,
				'C' => self.color_output = true,
				'M' => self.monochrome_output = true,

				'f' => self.from_file = true,
				'L' => self
					.library_path
					.push(args.next().ok_or(Error::Path("-L"))?.into()),
				'e' => self.exit_status = true,
				'V' => self.version = true,
				'h' => self.help = true,
				arg => Err(Error::Flag(format!("-{arg}")))?,
			}
			Ok(())
		}

		pub fn parse(argv: Vec<OsString>) -> Result<Self, Error> {
			let mut cli = Self { indent: 2, ..Self::default() };
			let mut mode = Mode::Files;
			let mut args = argv.into_iter();
			args.next();
			while let Some(arg) = args.next() {
				match arg.to_str() {
					Some(s) => match s.strip_prefix("--") {
						Some(rest) => cli.long(&mut mode, rest, &mut args)?,
						None => match s.strip_prefix("-") {
							Some(rest) => rest.chars().try_for_each(|c| cli.short(c, &mut args))?,
							None => cli.positional(&mode, arg)?,
						},
					},

					None => cli.positional(&mode, arg)?,
				}
			}
			Ok(cli)
		}

		pub fn color_if(&self, f: impl Fn() -> bool) -> bool {
			if self.monochrome_output {
				false
			} else if self.color_output {
				true
			} else {
				f()
			}
		}
	}

	#[derive(Debug)]
	pub enum Error {
		Flag(String),
		Utf8(OsString),
		KeyValue(&'static str),
		Int(&'static str),
		Path(&'static str),
	}

	impl fmt::Display for Error {
		fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
			match self {
				Self::Flag(s) => write!(f, "unknown flag: {s}"),
				Self::Utf8(s) => write!(f, "invalid UTF-8: {s:?}"),
				Self::KeyValue(o) => write!(f, "{o} expects a key and a value"),
				Self::Int(o) => write!(f, "{o} expects an integer"),
				Self::Path(o) => write!(f, "{o} expects a path"),
			}
		}
	}

	impl From<OsString> for Error {
		fn from(e: OsString) -> Self {
			Self::Utf8(e)
		}
	}

	fn parse_key_val(arg: &'static str, args: &mut Args) -> Result<(String, OsString), Error> {
		let err = || Error::KeyValue(arg);
		let key = args.next().ok_or_else(err)?.into_string()?;
		let val = args.next().ok_or_else(err)?;
		Ok((key, val))
	}

	enum Mode {
		Args,

		Files,
	}
}

mod filter {

	use core::fmt::{self, Display, Formatter};
	use std::{
		io::{self, Write},
		path::PathBuf,
	};

	use jaq_core::{
		Ctx, DataT, Lut, RunPtr, ValT, Vars, compile, data::HasLut, load, native,
	};
	use jaq_std::input::{HasInputs, Inputs, RcIter};

	use super::{Cli, Error, Val, read};

	pub struct Data;

	#[derive(Clone)]
	pub struct Context<'a> {
		lut: &'a Lut<Data>,
		inputs: Inputs<'a, Val>,
	}

	impl DataT for Data {
		type V<'a> = Val;
		type Data<'a> = Context<'a>;
	}

	impl<'a> HasLut<'a, Data> for Context<'a> {
		fn lut(&self) -> &'a Lut<Data> {
			self.lut
		}
	}

	impl<'a> HasInputs<'a, Val> for Context<'a> {
		fn inputs(&self) -> Inputs<'a, Val> {
			self.inputs
		}
	}

	pub type Filter = jaq_core::Filter<Data>;

	fn overrides() -> impl Iterator<Item = native::Fun<Data>> {
		use jaq_core::box_iter::box_once;
		use jaq_std::ValT as _;

		let funs: [native::Filter<RunPtr<Data>>; 3] = [
			("env", native::v(0), |_| {
				let env = super::runtime_env()
					.into_iter()
					.map(|(key, value)| (key.into(), Val::from(value)));
				box_once(Ok(Val::obj(env.collect())))
			}),
			("debug_empty", native::v(0), |cv| {
				super::with_runtime(|runtime| {
					let _ = writeln!(runtime.stderr, "[\"DEBUG:\", {}]", cv.1);
				});
				Box::new(core::iter::empty())
			}),
			("stderr_empty", native::v(0), |cv| {
				super::with_runtime(|runtime| {
					if let Some(bytes) = cv.1.as_bytes() {
						let _ = runtime.stderr.write_all(bytes);
					} else {
						let _ = write!(runtime.stderr, "{}", cv.1);
					}
				});
				Box::new(core::iter::empty())
			}),
		];
		funs.into_iter().map(native::run::<Data>)
	}

	pub fn parse_compile(
		path: &PathBuf,
		code: &str,
		vars: &[String],
		paths: &[PathBuf],
	) -> Result<(Vec<Val>, Filter), Vec<FileReports>> {
		use compile::Compiler;
		use load::{Arena, File, Loader, import};

		let default = ["~/.jq", "$ORIGIN/../lib/jq", "$ORIGIN/../lib"].map(|x| x.into());
		let paths = if paths.is_empty() { &default } else { paths };

		let vars: Vec<_> = vars.iter().map(|v| format!("${v}")).collect();
		let arena = Arena::default();
		let defs = jaq_core::defs().chain(jaq_std::defs()).chain(jaq_json::defs());
		let loader = Loader::new(defs).with_std_read(paths);
		let path = path.into();
		let modules = loader
			.load(&arena, File { path, code })
			.map_err(load_errors)?;

		let mut vals = Vec::new();
		import(&modules, |p| {
			let path = p.find(paths, "json")?;
			vals.push(read::json_array(path).map_err(|e| e.to_string())?);
			Ok(())
		})
		.map_err(load_errors)?;

		let funs = overrides()
			.chain(jaq_core::funs())
			.chain(jaq_std::funs())
			.chain(jaq_json::funs())
			.chain(jaq_std::input::funs().into_vec().into_iter().map(native::run));
		let compiler = Compiler::default()
			.with_funs(funs)
			.with_global_vars(vars.iter().map(|v| &**v));
		let filter = compiler.compile(modules).map_err(compile_errors)?;
		Ok((vals, filter))
	}

	pub(crate) fn run(
		cli: &Cli,
		filter: &Filter,
		vars: Vec<Val>,
		iter: impl Iterator<Item = io::Result<Val>>,
		mut f: impl FnMut(Val) -> io::Result<()>,
	) -> Result<Option<bool>, Error> {
		let mut last = None;
		let iter = iter.map(|r| r.map_err(|e| e.to_string()));

		let iter = Box::new(iter) as Box<dyn Iterator<Item = _>>;
		let null = Box::new(core::iter::once(Ok(Val::Null))) as Box<dyn Iterator<Item = _>>;

		let iter = RcIter::new(iter);
		let null = RcIter::new(null);

		let ctx = Ctx::<Data>::new(Context { lut: &filter.lut, inputs: &iter }, Vars::new(vars));

		for item in if cli.null_input { &null } else { &iter } {
			if super::runtime_cancelled() {
				break;
			}
			let input = item.map_err(Error::Parse)?;
			for output in filter.id.run((ctx.clone(), input)) {
				if super::runtime_cancelled() {
					return Ok(last);
				}
				let output = output.map_err(|exception| match exception.get_halt() {
					Ok(code) => Error::Halt(code),
					Err(exception) => Error::Jaq(exception.get_err().expect("jq exposes only errors or halt exceptions")),
				})?;
				last = Some(output.as_bool());
				f(output)?;
			}
		}
		Ok(last)
	}

	#[derive(Debug)]
	pub struct FileReports(load::File<String, PathBuf>, Vec<Report>);

	impl Display for FileReports {
		fn fmt(&self, f: &mut Formatter) -> fmt::Result {
			let Self(file, reports) = self;
			let idx = codesnake::LineIndex::new(&file.code);
			reports.iter().try_for_each(|e| {
				writeln!(f, "Error: {}", e.message)?;
				let block = e.to_block(&idx);
				writeln!(f, "{}[{}]", block.prologue(), file.path.display())?;
				writeln!(f, "{}{}", block, block.epilogue())
			})
		}
	}

	fn load_errors(errs: load::Errors<&str, PathBuf>) -> Vec<FileReports> {
		use load::Error;

		let errs = errs.into_iter().map(|(file, err)| {
			let code = file.code;
			let err = match err {
				Error::Io(errs) => errs.into_iter().map(|e| report_io(code, e)).collect(),
				Error::Lex(errs) => errs.into_iter().map(|e| report_lex(code, e)).collect(),
				Error::Parse(errs) => errs.into_iter().map(|e| report_parse(code, e)).collect(),
			};
			FileReports(file.map_code(|s| s.into()), err)
		});
		errs.collect()
	}

	fn compile_errors(errs: compile::Errors<&str, PathBuf>) -> Vec<FileReports> {
		let errs = errs.into_iter().map(|(file, errs)| {
			let code = file.code;
			let errs = errs.into_iter().map(|e| report_compile(code, e)).collect();
			FileReports(file.map_code(|s| s.into()), errs)
		});
		errs.collect()
	}

	type StringColors = Vec<(String, Option<Color>)>;

	#[derive(Debug)]
	struct Report {
		message: String,
		labels:  Vec<(core::ops::Range<usize>, StringColors, Color)>,
	}

	#[derive(Clone, Debug)]
	enum Color {
		Yellow,
		Red,
	}

	impl Color {
		fn apply(&self, d: impl Display) -> String {
			use yansi::{Color, Paint};
			let color = match self {
				Self::Yellow => Color::Yellow,
				Self::Red => Color::Red,
			};
			d.fg(color).to_string()
		}
	}

	fn report_io(code: &str, (path, error): (&str, String)) -> Report {
		let path_range = load::span(code, path);
		Report {
			message: format!("could not load file {}: {}", path, error),
			labels:  [(path_range, [(error, None)].into(), Color::Red)].into(),
		}
	}

	fn report_lex(code: &str, (expected, found): load::lex::Error<&str>) -> Report {
		let found = &found[..found.char_indices().nth(1).map_or(found.len(), |(i, _)| i)];

		let found_range = load::span(code, found);
		let found = match found {
			"" => [("unexpected end of input".to_string(), None)].into(),
			c => [("unexpected character ", None), (c, Some(Color::Red))]
				.map(|(s, c)| (s.into(), c))
				.into(),
		};
		let label = (found_range, found, Color::Red);

		let labels = match expected {
			load::lex::Expect::Delim(open) => {
				let text = [("unclosed delimiter ", None), (open, Some(Color::Yellow))]
					.map(|(s, c)| (s.into(), c));
				Vec::from([(load::span(code, open), text.into(), Color::Yellow), label])
			},
			_ => Vec::from([label]),
		};

		Report { message: format!("expected {}", expected.as_str()), labels }
	}

	fn report_parse(code: &str, (expected, found): load::parse::Error<&str>) -> Report {
		let found_range = load::span(code, found);

		let found = if found.is_empty() {
			"unexpected end of input"
		} else {
			"unexpected token"
		};
		let found = [(found.to_string(), None)].into();

		Report {
			message: format!("expected {}", expected.as_str()),
			labels:  Vec::from([(found_range, found, Color::Red)]),
		}
	}

	fn report_compile(code: &str, (found, undefined): compile::Error<&str>) -> Report {
		use compile::Undefined::Filter;
		let found_range = load::span(code, found);
		let wnoa = |exp, got| format!("wrong number of arguments (expected {exp}, found {got})");
		let message = match (found, undefined) {
			("reduce", Filter(arity)) => wnoa("2", arity),
			("foreach", Filter(arity)) => wnoa("2 or 3", arity),
			(_, undefined) => format!("undefined {}", undefined.as_str()),
		};
		let found = [(message.clone(), None)].into();

		Report { message, labels: Vec::from([(found_range, found, Color::Red)]) }
	}

	type CodeBlock = codesnake::Block<codesnake::CodeWidth<String>, String, Option<Color>>;

	impl Report {
		fn to_block(&self, idx: &codesnake::LineIndex) -> CodeBlock {
			use codesnake::{Block, CodeWidth, Label};
			let color_maybe = |(text, color): (_, Option<Color>)| match color {
				None => text,
				Some(color) => color.apply(text).to_string(),
			};
			let labels = self.labels.iter().cloned().map(|(range, text, color)| {
				let text = text.into_iter().map(color_maybe).collect::<Vec<_>>();
				Label::new(range)
					.with_text(text.join(""))
					.with_style(Some(color))
			});
			Block::new(idx, labels)
				.unwrap()
				.with_paint(|f, color, text| match color {
					Some(color) => write!(f, "{}", color.apply(text)),
					None => write!(f, "{text}"),
				})
				.map_code(|c| {
					let c = c.replace('\t', "    ");
					let w = xutf::width_str(&c);
					CodeWidth::new(c, core::cmp::max(w, 1))
				})
		}
	}
}

mod read {
	use std::{
		io::{self, BufRead},
		path::Path,
	};

	use super::{Cli, Val};

	pub fn load_file(
		path: impl AsRef<Path>,
	) -> io::Result<Box<dyn core::ops::Deref<Target = [u8]>>> {
		let path = path.as_ref();
		Ok(Box::new(brush_core::heldfiles::read(path)?))
	}

	pub fn invalid_data(e: impl std::error::Error + Send + Sync + 'static) -> std::io::Error {
		io::Error::new(io::ErrorKind::InvalidData, e)
	}

	fn json_slice(slice: &[u8]) -> impl Iterator<Item = io::Result<Val>> + '_ {
		jaq_json::read::parse_many(json_bytes(slice)).map(|value| value.map_err(invalid_data))
	}

	fn json_bytes(bytes: &[u8]) -> &[u8] {
		bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes)
	}

	fn json_reader(mut read: impl BufRead) -> io::Result<impl BufRead> {
		use std::io::Read;
		let mut prefix = [0; 3];
		let mut len = 0;
		while len < prefix.len() {
			let available = read.fill_buf()?;
			let n = available.len().min(prefix.len() - len);
			if n == 0 {
				break;
			}
			prefix[len..len + n].copy_from_slice(&available[..n]);
			read.consume(n);
			len += n;
			if prefix[..len] != b"\xef\xbb\xbf"[..len] {
				break;
			}
		}
		let keep = if prefix == *b"\xef\xbb\xbf" { 0 } else { len };
		Ok(io::Cursor::new(prefix).take(keep as u64).chain(read))
	}

	fn json_read<'a>(read: impl BufRead + 'a) -> Box<dyn Iterator<Item = io::Result<Val>> + 'a> {
		let read = match json_reader(read) {
			Ok(read) => read,
			Err(error) => return Box::new(std::iter::once(Err(error))),
		};
		Box::new(jaq_json::read::read_many(read))
	}

	pub fn json_array(path: impl AsRef<Path>) -> io::Result<Val> {
		json_slice(&load_file(path.as_ref())?).collect()
	}

	pub fn buffered<'a, R>(cli: &Cli, read: R) -> Box<dyn Iterator<Item = io::Result<Val>> + 'a>
	where
		R: BufRead + 'a,
	{
		if cli.raw_input {
			Box::new(raw_input(cli.slurp, read).map(|r| r.map(Val::from)))
		} else {
			Box::new(collect_if(cli.slurp, json_read(read)))
		}
	}

	pub fn slice<'a>(cli: &Cli, slice: &'a [u8]) -> Box<dyn Iterator<Item = io::Result<Val>> + 'a> {
		if cli.raw_input {
			let read = io::BufReader::new(slice);
			Box::new(raw_input(cli.slurp, read).map(|r| r.map(Val::from)))
		} else {
			Box::new(collect_if(cli.slurp, json_slice(slice)))
		}
	}

	fn raw_input<'a, R>(slurp: bool, mut read: R) -> impl Iterator<Item = io::Result<String>> + 'a
	where
		R: BufRead + 'a,
	{
		if slurp {
			let mut buf = String::new();
			let s = read.read_to_string(&mut buf).map(|_| buf);
			Box::new(std::iter::once(s))
		} else {
			Box::new(read.lines()) as Box<dyn Iterator<Item = _>>
		}
	}

	fn collect_if<'a, T: FromIterator<T> + 'a, E: 'a>(
		slurp: bool,
		iter: impl Iterator<Item = Result<T, E>> + 'a,
	) -> Box<dyn Iterator<Item = Result<T, E>> + 'a> {
		if slurp {
			Box::new(core::iter::once(iter.collect()))
		} else {
			Box::new(iter)
		}
	}
}

mod output {
	use core::fmt::{self, Display, Formatter};
	use std::io::{self, Write};

	use super::{Cli, Val};

	struct FormatterFn<F>(F);

	impl<F: Fn(&mut Formatter) -> fmt::Result> Display for FormatterFn<F> {
		fn fmt(&self, f: &mut Formatter) -> fmt::Result {
			self.0(f)
		}
	}

	struct PpOpts {
		compact:   bool,
		indent:    String,
		sort_keys: bool,
	}

	impl PpOpts {
		fn indent(&self, f: &mut Formatter, level: usize) -> fmt::Result {
			if !self.compact {
				write!(f, "{}", self.indent.repeat(level))?;
			}
			Ok(())
		}

		fn newline(&self, f: &mut Formatter) -> fmt::Result {
			if !self.compact {
				writeln!(f)?;
			}
			Ok(())
		}
	}

	fn fmt_seq<T, I, F>(fmt: &mut Formatter, opts: &PpOpts, level: usize, xs: I, f: F) -> fmt::Result
	where
		I: IntoIterator<Item = T>,
		F: Fn(&mut Formatter, T) -> fmt::Result,
	{
		opts.newline(fmt)?;
		let mut iter = xs.into_iter().peekable();
		while let Some(x) = iter.next() {
			opts.indent(fmt, level + 1)?;
			f(fmt, x)?;
			if iter.peek().is_some() {
				write!(fmt, ",")?;
			}
			opts.newline(fmt)?;
		}
		opts.indent(fmt, level)
	}

	fn fmt_val(f: &mut Formatter, opts: &PpOpts, level: usize, v: &Val) -> fmt::Result {
		use yansi::Paint;
		match v {
			Val::Num(jaq_json::Num::Float(number)) if !number.is_finite() => write!(f, "null"),
			Val::Null | Val::Bool(_) | Val::Num(_) => v.fmt(f),
			Val::TStr(_) | Val::BStr(_) => write!(f, "{}", v.green()),
			Val::Arr(a) => {
				'['.bold().fmt(f)?;
				if !a.is_empty() {
					fmt_seq(f, opts, level, &**a, |f, x| fmt_val(f, opts, level + 1, x))?;
				}
				']'.bold().fmt(f)
			},
			Val::Obj(o) => {
				'{'.bold().fmt(f)?;
				let kv = |f: &mut Formatter, (k, val): (&Val, &Val)| {
					write!(f, "{}:", k.bold())?;
					if !opts.compact {
						write!(f, " ")?;
					}
					fmt_val(f, opts, level + 1, val)
				};
				if !o.is_empty() {
					if opts.sort_keys {
						let mut o: Vec<_> = o.iter().collect();
						o.sort_by_key(|(k, _v)| *k);
						fmt_seq(f, opts, level, o, kv)
					} else {
						fmt_seq(f, opts, level, &**o, kv)
					}?
				}
				'}'.bold().fmt(f)
			},
		}
	}

	pub fn print(w: &mut (impl Write + ?Sized), cli: &Cli, val: &Val) -> io::Result<()> {
		let f = |f: &mut Formatter| {
			let opts = PpOpts {
				compact:   cli.compact_output,
				indent:    if cli.tab {
					String::from("\t")
				} else {
					" ".repeat(cli.indent)
				},
				sort_keys: cli.sort_keys,
			};
			fmt_val(f, &opts, 0, val)
		};

		let mut rendered = Vec::new();
		match val {
			Val::TStr(s) | Val::BStr(s) if cli.raw_output || cli.join_output => {
				rendered.extend_from_slice(s)
			},
			_ => write!(&mut rendered, "{}", FormatterFn(f))?,
		};
		if !cli.join_output {
			rendered.push(b'\n');
		}
		w.write_all(&rendered)?;

		if cli.join_output { w.flush() } else { Ok(()) }
	}

	pub fn with_stdout<T>(stdout: &mut dyn Write, f: impl FnOnce(&mut dyn Write) -> T) -> T {
		let res = f(stdout);
		let _ = stdout.flush();
		res
	}
}

pub(crate) struct Jq {
	cli: Cli,
}

impl FromArgMatches for Jq {
	fn from_arg_matches(_matches: &ArgMatches) -> Result<Self, clap::Error> {
		Err(clap::Error::raw(ErrorKind::InvalidValue, "jq uses its order-preserving argument parser"))
	}

	fn update_from_arg_matches(&mut self, _matches: &ArgMatches) -> Result<(), clap::Error> {
		Err(clap::Error::raw(ErrorKind::InvalidValue, "jq uses its order-preserving argument parser"))
	}
}

fn command(name: &'static str) -> Command {
	Command::new(name)
		.version("2.3.0")
		.about(include_str!("jq-help.txt"))
		.help_template("{about}\n")
}

impl CommandFactory for Jq {
	fn command() -> Command {
		command("jq")
	}

	fn command_for_update() -> Command {
		Self::command()
	}
}

impl Parser for Jq {
	fn try_parse_from<I, T>(itr: I) -> Result<Self, clap::Error>
	where
		I: IntoIterator<Item = T>,
		T: Into<OsString> + Clone,
	{
		let cli = Cli::parse(itr.into_iter().map(Into::into).collect())
			.map_err(|error| clap::Error::raw(ErrorKind::InvalidValue, format!("Error: {error}\n")))?;
		if cli.version {
			return Err(
				command("jaq")
					.try_get_matches_from(["jaq", "--version"])
					.expect_err("--version always short-circuits"),
			);
		}
		if cli.help {
			return Err(
				command("jaq")
					.try_get_matches_from(["jaq", "--help"])
					.expect_err("--help always short-circuits"),
			);
		}
		Ok(Self { cli })
	}
}

impl Utility for Jq {
	const NAME: &'static str = "jq";
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {
		color::init();
		color::set(false);

		let mut cli = self.cli;
		resolve_cli_paths(&mut cli, host);
		let stdout_is_terminal = host.stdout.is_terminal();
		let _runtime = RuntimeGuard::install(host);
		color::set(!cli.in_place && cli.color_if(|| stdout_is_terminal));

		let mut stdout = host.stdout_writer();
		let result = real_main(&cli, host, &mut stdout);
		match result {
			Ok(exit) | Err(Error::Halt(exit)) => exit,
			Err(error) => {
				if let Some(flag) = host.reported_error_flag() {
					flag.store(true, Ordering::Relaxed);
				}
				color::set(cli.color_if(|| stdout_is_terminal));
				let _ = write!(host.stderr, "{error}");
				error.report()
			},
		}
	}
}

fn resolve_cli_paths(cli: &mut Cli, host: &Host) {
	for path in &mut cli.library_path {
		*path = host.resolve(&*path);
	}
	if let Some(cli::Filter::FromFile(path)) = &mut cli.filter {
		*path = host.resolve(&*path);
	}
	for path in &mut cli.files {
		*path = host.resolve(&*path);
	}
	for path in cli
		.rawfile
		.iter_mut()
		.chain(&mut cli.slurpfile)
		.map(|(_, path)| path)
	{
		*path = host.resolve(&*path).into_os_string();
	}
	if let Some(paths) = &mut cli.run_tests {
		for path in paths {
			*path = host.resolve(&*path);
		}
	}
}

struct Runtime {
	stderr: OpenFile,
	env:    Vec<(String, String)>,
	cancel: Arc<AtomicBool>,
}

thread_local! {
	static RUNTIME: RefCell<Option<Runtime>> = const { RefCell::new(None) };
}

struct RuntimeGuard;

impl RuntimeGuard {
	fn install(host: &Host) -> Self {
		let runtime = Runtime {
			stderr: host.stderr_clone(),
			env:    host
				.env()
				.map(|(key, value)| (key.to_owned(), value.to_owned()))
				.collect(),
			cancel: host.cancel_flag(),
		};
		RUNTIME.with(|slot| {
			debug_assert!(slot.borrow().is_none());
			*slot.borrow_mut() = Some(runtime);
		});
		Self
	}
}

impl Drop for RuntimeGuard {
	fn drop(&mut self) {
		RUNTIME.with(|slot| *slot.borrow_mut() = None);
	}
}

fn with_runtime<T>(f: impl FnOnce(&mut Runtime) -> T) -> T {
	RUNTIME.with(|slot| {
		let mut runtime = slot.borrow_mut();
		f(runtime.as_mut().expect("jq runtime is installed"))
	})
}

fn runtime_env() -> Vec<(String, String)> {
	RUNTIME.with(|slot| {
		slot
			.borrow()
			.as_ref()
			.expect("jq runtime is installed")
			.env
			.clone()
	})
}

fn runtime_cancelled() -> bool {
	RUNTIME.with(|slot| {
		slot
			.borrow()
			.as_ref()
			.expect("jq runtime is installed")
			.cancel
			.load(Ordering::Relaxed)
	})
}

mod color {
	use std::{cell::Cell, sync::Once};

	thread_local! {
		static COLOR: Cell<bool> = const { Cell::new(false) };
	}

	pub fn init() {
		static ONCE: Once = Once::new();
		ONCE.call_once(|| yansi::whenever(yansi::Condition(|| COLOR.with(Cell::get))));
	}

	pub fn set(on: bool) {
		COLOR.with(|color| color.set(on));
	}
}

fn real_main(cli: &Cli, host: &mut Host, stdout: &mut dyn Write) -> Result<i32, Error> {
	if let Some(test_files) = &cli.run_tests {
		return Ok(match test_files.last() {
			Some(file) => run_tests(
				io::BufReader::new(brush_core::heldfiles::open_read(file)?),
				&mut host.stdout,
				&mut host.stderr,
			),
			None => run_tests(io::BufReader::new(&mut host.stdin), &mut host.stdout, &mut host.stderr),
		});
	}

	let (vars, mut ctx): (Vec<String>, Vec<Val>) = binds(cli, host)?.into_iter().unzip();

	let (vals, filter) = match &cli.filter {
		None => (Vec::new(), Filter::default()),
		Some(filter) => {
			let (path, code) = match filter {
				cli::Filter::FromFile(path) => {
					(path.into(), brush_core::heldfiles::read_to_string(path)?)
				},
				cli::Filter::Inline(filter) => ("<inline>".into(), filter.clone()),
			};
			filter::parse_compile(&path, &code, &vars, &cli.library_path).map_err(Error::Report)?
		},
	};
	ctx.extend(vals);

	let last = if cli.files.is_empty() {
		let inputs = read::buffered(cli, io::BufReader::new(&mut host.stdin));
		output::with_stdout(stdout, |out| {
			filter::run(cli, &filter, ctx, inputs, |v| output::print(out, cli, &v))
		})?
	} else {
		let mut last = None;
		for file in &cli.files {
			let path = file.as_path();
			let file =
				read::load_file(path).map_err(|e| Error::Io(Some(path.display().to_string()), e))?;
			host.note_read(path);
			let inputs = read::slice(cli, &file);
			if cli.in_place {
				let observation = host.prepare_write(path)?;

				let location = path.parent().unwrap();
				let mut tmp = tempfile::Builder::new()
					.prefix("jaq")
					.tempfile_in(location)?;

				last = filter::run(cli, &filter, ctx.clone(), inputs, |output| {
					output::print(tmp.as_file_mut(), cli, &output)
				})?;

				std::mem::drop(file);
				let perms = std::fs::metadata(path)?.permissions();
				tmp.persist(path).map_err(Error::Persist)?;
				host.commit_write(observation);
				std::fs::set_permissions(path, perms)?;
			} else {
				last = output::with_stdout(stdout, |out| {
					filter::run(cli, &filter, ctx.clone(), inputs, |v| output::print(out, cli, &v))
				})?;
			}
		}
		last
	};

	if cli.exit_status {
		last.map_or_else(|| Err(Error::NoOutput), |b| if b { Ok(0) } else { Err(Error::FalseOrNull) })
	} else {
		Ok(0)
	}
}

fn binds(cli: &Cli, host: &Host) -> Result<Vec<(String, Val)>, Error> {
	let arg = cli.arg.iter().map(|(k, s)| {
		let s = s.to_owned();
		Ok((k.to_owned(), Val::from(s)))
	});
	let argjson = cli.argjson.iter().map(|(k, s)| {
		let err = |e| Error::Parse(format!("{e} (for value passed to `--argjson {k}`)"));
		Ok((k.to_owned(), jaq_json::read::parse_single(s.as_bytes()).map_err(err)?))
	});
	let rawfile = cli.rawfile.iter().map(|(k, path)| {
		let s = brush_core::heldfiles::read_to_string(path)
			.map_err(|e| Error::Io(Some(format!("{path:?}")), e));
		Ok((k.to_owned(), Val::from(s?)))
	});
	let slurpfile = cli.slurpfile.iter().map(|(k, path)| {
		let a = read::json_array(path).map_err(|e| Error::Io(Some(format!("{path:?}")), e));
		Ok((k.to_owned(), a?))
	});

	let positional = cli.args.iter().cloned().map(|s| Ok(Val::from(s)));
	let positional = positional.collect::<Result<Vec<_>, Error>>()?;

	let var_val = arg.chain(rawfile).chain(slurpfile).chain(argjson);
	let mut var_val = var_val.collect::<Result<Vec<_>, Error>>()?;

	var_val.push(("ARGS".to_string(), args(&positional, &var_val)));

	let env = host
		.env()
		.map(|(key, value)| (key.to_owned().into(), Val::from(value.to_owned())));
	var_val.push(("ENV".to_string(), Val::obj(env.collect())));

	Ok(var_val)
}

fn args(positional: &[Val], named: &[(String, Val)]) -> Val {
	let key = |k: &str| k.to_string().into();
	let positional = positional.iter().cloned();
	let named = named.iter().map(|(var, val)| (key(var), val.clone()));
	let obj = [(key("positional"), positional.collect()), (key("named"), Val::obj(named.collect()))];
	Val::obj(obj.into_iter().collect())
}

#[derive(Debug)]
enum Error {
	Io(Option<String>, io::Error),
	Report(Vec<FileReports>),
	Parse(String),
	Jaq(jaq_core::Error<Val>),
	Halt(i32),
	Persist(tempfile::PersistError),
	FalseOrNull,
	NoOutput,
}

impl Display for Error {
	fn fmt(&self, f: &mut Formatter) -> fmt::Result {
		match self {
			Self::FalseOrNull | Self::NoOutput | Self::Halt(_) => Ok(()),
			Self::Io(prefix, e) => {
				write!(f, "Error: ")?;
				if let Some(p) = prefix {
					write!(f, "{p}: ")?;
				}
				writeln!(f, "{e}")
			},
			Self::Persist(e) => {
				writeln!(f, "Error: {e}")
			},
			Self::Report(reports) => reports.iter().try_for_each(|fr| write!(f, "{fr}")),
			Self::Parse(e) => writeln!(f, "Error: failed to parse: {e}"),
			Self::Jaq(e) => writeln!(f, "Error: {e}"),
		}
	}
}

impl Error {
	fn report(&self) -> i32 {
		match self {
			Self::Halt(code) => *code,
			Self::FalseOrNull => 1,
			Self::Io(..) | Self::Persist(_) => 2,
			Self::Report(_) => 3,
			Self::NoOutput => 4,
			Self::Parse(_) | Self::Jaq(_) => 5,
		}
	}
}

impl From<io::Error> for Error {
	fn from(e: io::Error) -> Self {
		Self::Io(None, e)
	}
}

struct FilterTest {
	filter: String,
	input: String,
	output: Vec<String>,
}

fn run_test(test: FilterTest) -> Result<(Val, Val), Error> {
	let (vars, filter) =
		filter::parse_compile(&PathBuf::new(), &test.filter, &[], &[]).map_err(Error::Report)?;

	let json = |s: String| jaq_json::read::parse_single(s.as_bytes()).map_err(read::invalid_data);
	let input = json(test.input)?;
	let expect: Result<Val, _> = test.output.into_iter().map(json).collect();
	let mut obtain = Vec::new();
	filter::run(&Cli::default(), &filter, vars, core::iter::once(Ok(input)), |value| {
		obtain.push(value);
		Ok(())
	})?;
	Ok((expect?, obtain.into_iter().collect()))
}

fn run_tests(read: impl BufRead, stdout: &mut dyn Write, stderr: &mut dyn Write) -> i32 {
	let mut lines = read.lines().map(Result::unwrap);
	let tests = core::iter::from_fn(move || {
		Some(FilterTest {
			filter: lines.find(|line| !(line.is_empty() || line.starts_with('#')))?,
			input: lines.next()?,
			output: lines.by_ref().take_while(|line| !line.is_empty()).collect(),
		})
	});

	let (mut passed, mut total) = (0, 0);
	for test in tests {
		if runtime_cancelled() {
			break;
		}
		let _ = writeln!(stdout, "Testing {}", test.filter);
		match run_test(test) {
			Err(e) => {
				let _ = writeln!(stderr, "{e:?}");
			},
			Ok((expect, obtain)) if expect != obtain => {
				let _ = writeln!(stderr, "expected {expect}, obtained {obtain}",);
			},
			Ok(_) => passed += 1,
		}
		total += 1;
	}

	let _ = writeln!(stdout, "{passed} out of {total} tests passed");

	i32::from(total > passed)
}

pub(crate) fn jq_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Jq, SE>()
}
