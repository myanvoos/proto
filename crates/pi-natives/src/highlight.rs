use std::{cell::RefCell, collections::HashMap, sync::OnceLock};

use napi::{JsString, Result};
use napi_derive::napi;
use syntect::parsing::{
	ParseState, Scope, ScopeStack, ScopeStackOp, SyntaxDefinition, SyntaxReference, SyntaxSet,
};

use crate::js::{self, InlineStr};

pub type Color = InlineStr<48>;

static SYNTAX_SET: OnceLock<SyntaxSet> = OnceLock::new();
static SCOPE_MATCHERS: OnceLock<ScopeMatchers> = OnceLock::new();

thread_local! {
	static SCOPE_COLOR_CACHE: RefCell<HashMap<Scope, usize>> = RefCell::new(HashMap::with_capacity(256));
}

const EXTRA_SYNTAXES: &[&str] = &[
	include_str!("syntaxes/Julia.sublime-syntax"),
	include_str!("syntaxes/Nix.sublime-syntax"),
	include_str!("syntaxes/Mermaid.sublime-syntax"),
];

fn get_syntax_set() -> &'static SyntaxSet {
	SYNTAX_SET.get_or_init(build_syntax_set)
}

fn build_syntax_set() -> SyntaxSet {
	let mut builder = SyntaxSet::load_defaults_newlines().into_builder();
	for src in EXTRA_SYNTAXES {
		if let Ok(def) = SyntaxDefinition::load_from_str(src, true, None) {
			builder.add(def);
		}
	}
	builder.build()
}

struct ScopeMatchers {
	comment: Scope,

	string:             Scope,
	constant_character: Scope,
	meta_string:        Scope,

	constant_numeric: Scope,
	constant_integer: Scope,
	constant:         Scope,

	keyword:          Scope,
	storage_type:     Scope,
	storage_modifier: Scope,

	entity_name_function: Scope,
	support_function:     Scope,
	meta_function_call:   Scope,
	variable_function:    Scope,

	entity_name_type:      Scope,
	support_type:          Scope,
	support_class:         Scope,
	entity_name_class:     Scope,
	entity_name_struct:    Scope,
	entity_name_enum:      Scope,
	entity_name_interface: Scope,
	entity_name_trait:     Scope,

	keyword_operator:     Scope,
	punctuation_accessor: Scope,

	punctuation: Scope,

	variable:    Scope,
	entity_name: Scope,
	meta_path:   Scope,

	markup_inserted:  Scope,
	markup_deleted:   Scope,
	meta_diff_header: Scope,
	meta_diff_range:  Scope,
}

impl ScopeMatchers {
	fn new() -> Self {
		Self {
			comment:               Scope::new("comment").unwrap(),
			string:                Scope::new("string").unwrap(),
			constant_character:    Scope::new("constant.character").unwrap(),
			meta_string:           Scope::new("meta.string").unwrap(),
			constant_numeric:      Scope::new("constant.numeric").unwrap(),
			constant_integer:      Scope::new("constant.integer").unwrap(),
			constant:              Scope::new("constant").unwrap(),
			keyword:               Scope::new("keyword").unwrap(),
			storage_type:          Scope::new("storage.type").unwrap(),
			storage_modifier:      Scope::new("storage.modifier").unwrap(),
			entity_name_function:  Scope::new("entity.name.function").unwrap(),
			support_function:      Scope::new("support.function").unwrap(),
			meta_function_call:    Scope::new("meta.function-call").unwrap(),
			variable_function:     Scope::new("variable.function").unwrap(),
			entity_name_type:      Scope::new("entity.name.type").unwrap(),
			support_type:          Scope::new("support.type").unwrap(),
			support_class:         Scope::new("support.class").unwrap(),
			entity_name_class:     Scope::new("entity.name.class").unwrap(),
			entity_name_struct:    Scope::new("entity.name.struct").unwrap(),
			entity_name_enum:      Scope::new("entity.name.enum").unwrap(),
			entity_name_interface: Scope::new("entity.name.interface").unwrap(),
			entity_name_trait:     Scope::new("entity.name.trait").unwrap(),
			keyword_operator:      Scope::new("keyword.operator").unwrap(),
			punctuation_accessor:  Scope::new("punctuation.accessor").unwrap(),
			punctuation:           Scope::new("punctuation").unwrap(),
			variable:              Scope::new("variable").unwrap(),
			entity_name:           Scope::new("entity.name").unwrap(),
			meta_path:             Scope::new("meta.path").unwrap(),
			markup_inserted:       Scope::new("markup.inserted").unwrap(),
			markup_deleted:        Scope::new("markup.deleted").unwrap(),
			meta_diff_header:      Scope::new("meta.diff.header").unwrap(),
			meta_diff_range:       Scope::new("meta.diff.range").unwrap(),
		}
	}
}

fn get_scope_matchers() -> &'static ScopeMatchers {
	SCOPE_MATCHERS.get_or_init(ScopeMatchers::new)
}

#[derive(Debug)]
#[napi(object)]
pub struct HighlightColors {
	#[napi(ts_type = "string")]
	pub comment: Color,

	#[napi(ts_type = "string")]
	pub keyword: Color,

	#[napi(ts_type = "string")]
	pub function: Color,

	#[napi(ts_type = "string")]
	pub variable: Color,

	#[napi(ts_type = "string")]
	pub string: Color,

	#[napi(ts_type = "string")]
	pub number: Color,

	#[napi(ts_type = "string")]
	pub r#type: Color,

	#[napi(ts_type = "string")]
	pub operator: Color,

	#[napi(ts_type = "string")]
	pub punctuation: Color,

	#[napi(ts_type = "string")]
	pub inserted: Option<Color>,

	#[napi(ts_type = "string")]
	pub deleted: Option<Color>,
}

const LANG_ALIASES: &[(&[&str], &str)] = &[
	(&["ts", "tsx", "typescript", "js", "jsx", "javascript", "mjs", "cjs"], "JavaScript"),
	(&["py", "python"], "Python"),
	(&["rb", "ruby"], "Ruby"),
	(&["jl", "julia"], "Julia"),
	(&["nix"], "Nix"),
	(&["mermaid", "mmd"], "Mermaid"),
	(&["rs", "rust"], "Rust"),
	(&["go", "golang"], "Go"),
	(&["java"], "Java"),
	(&["kt", "kotlin"], "Java"),
	(&["swift"], "Objective-C"),
	(&["c", "h"], "C"),
	(&["cpp", "cc", "cxx", "c++", "hpp", "hxx", "hh"], "C++"),
	(&["cs", "csharp"], "C#"),
	(&["php"], "PHP"),
	(&["sh", "bash", "zsh", "shell"], "Bash"),
	(&["html", "htm", "astro", "vue", "svelte"], "HTML"),
	(&["css"], "CSS"),
	(&["scss"], "SCSS"),
	(&["sass"], "Sass"),
	(&["less"], "LESS"),
	(&["json"], "JSON"),
	(&["yaml", "yml"], "YAML"),
	(&["toml"], "TOML"),
	(&["xml"], "XML"),
	(&["md", "markdown"], "Markdown"),
	(&["sql"], "SQL"),
	(&["lua"], "Lua"),
	(&["r"], "R"),
	(&["scala"], "Scala"),
	(&["clj", "clojure"], "Clojure"),
	(&["el", "elisp", "emacs-lisp", "emacslisp"], "Lisp"),
	(&["ex", "exs", "elixir"], "Ruby"),
	(&["erl", "erlang"], "Erlang"),
	(&["hs", "haskell"], "Haskell"),
	(&["ml", "ocaml"], "OCaml"),
	(&["vim"], "VimL"),
	(&["graphql", "gql"], "GraphQL"),
	(&["proto", "protobuf"], "Protocol Buffers"),
	(&["tf", "hcl", "terraform"], "Terraform"),
	(&["dockerfile", "docker", "containerfile"], "Dockerfile"),
	(&["makefile", "make", "just", "justfile"], "Makefile"),
	(&["cmake", "cmakelists"], "CMake"),
	(&["ini", "cfg", "conf", "config", "properties"], "INI"),
	(&["diff", "patch"], "Diff"),
	(&["gitignore", "gitattributes", "gitmodules"], "Git Ignore"),
];

#[inline]
fn find_alias(lang: &str) -> Option<&'static str> {
	LANG_ALIASES
		.iter()
		.find(|(aliases, _)| aliases.iter().any(|a| lang.eq_ignore_ascii_case(a)))
		.map(|(_, target)| *target)
}

#[inline]
fn is_known_alias(lang: &str) -> bool {
	LANG_ALIASES
		.iter()
		.any(|(aliases, _)| aliases.iter().any(|a| lang.eq_ignore_ascii_case(a)))
}

#[inline]
fn compute_scope_color(s: Scope) -> usize {
	let m = get_scope_matchers();

	if m.comment.is_prefix_of(s) {
		return 0;
	}

	if m.markup_inserted.is_prefix_of(s) {
		return 9;
	}

	if m.markup_deleted.is_prefix_of(s) {
		return 10;
	}

	if m.meta_diff_header.is_prefix_of(s) || m.meta_diff_range.is_prefix_of(s) {
		return 1;
	}

	if m.string.is_prefix_of(s)
		|| m.constant_character.is_prefix_of(s)
		|| m.meta_string.is_prefix_of(s)
	{
		return 4;
	}

	if m.constant_numeric.is_prefix_of(s) || m.constant_integer.is_prefix_of(s) {
		return 5;
	}

	if m.keyword.is_prefix_of(s)
		|| m.storage_type.is_prefix_of(s)
		|| m.storage_modifier.is_prefix_of(s)
	{
		return 1;
	}

	if m.entity_name_function.is_prefix_of(s)
		|| m.support_function.is_prefix_of(s)
		|| m.meta_function_call.is_prefix_of(s)
		|| m.variable_function.is_prefix_of(s)
	{
		return 2;
	}

	if m.entity_name_type.is_prefix_of(s)
		|| m.support_type.is_prefix_of(s)
		|| m.support_class.is_prefix_of(s)
		|| m.entity_name_class.is_prefix_of(s)
		|| m.entity_name_struct.is_prefix_of(s)
		|| m.entity_name_enum.is_prefix_of(s)
		|| m.entity_name_interface.is_prefix_of(s)
		|| m.entity_name_trait.is_prefix_of(s)
	{
		return 6;
	}

	if m.keyword_operator.is_prefix_of(s) || m.punctuation_accessor.is_prefix_of(s) {
		return 7;
	}

	if m.punctuation.is_prefix_of(s) {
		return 8;
	}

	if m.variable.is_prefix_of(s) || m.entity_name.is_prefix_of(s) || m.meta_path.is_prefix_of(s) {
		return 3;
	}

	if m.constant.is_prefix_of(s) {
		return 5;
	}

	usize::MAX
}

#[inline]
fn scope_to_color_index(scope: &ScopeStack) -> usize {
	SCOPE_COLOR_CACHE.with(|cache| {
		let mut cache = cache.borrow_mut();

		for s in scope.as_slice().iter().rev() {
			let color_idx = *cache.entry(*s).or_insert_with(|| compute_scope_color(*s));
			if color_idx != usize::MAX {
				return color_idx;
			}
		}

		usize::MAX
	})
}

fn find_syntax<'a>(ss: &'a SyntaxSet, lang: &str) -> Option<&'a SyntaxReference> {
	if let Some(syn) = ss.find_syntax_by_token(lang) {
		return Some(syn);
	}

	if let Some(syn) = ss.find_syntax_by_extension(lang) {
		return Some(syn);
	}

	let alias = find_alias(lang)?;

	ss.find_syntax_by_name(alias)
		.or_else(|| ss.find_syntax_by_token(alias))
}

#[napi]
pub fn highlight_code(
	code: JsString,
	lang: Option<JsString>,
	colors: HighlightColors,
) -> Result<String> {
	let code = js::utf8(code)?;
	let lang = lang.map(js::utf8).transpose()?;
	Ok(highlight_code_impl(&code, lang.as_deref(), &colors))
}

fn palette(colors: &HighlightColors) -> [&str; 11] {
	[
		&*colors.comment,
		&*colors.keyword,
		&*colors.function,
		&*colors.variable,
		&*colors.string,
		&*colors.number,
		&*colors.r#type,
		&*colors.operator,
		&*colors.punctuation,
		colors.inserted.as_deref().unwrap_or(""),
		colors.deleted.as_deref().unwrap_or(""),
	]
}

fn highlight_code_impl(code: &str, lang: Option<&str>, colors: &HighlightColors) -> String {
	let Some(lang) = lang else {
		return code.to_owned();
	};
	let ss = get_syntax_set();
	let Some(syntax) = find_syntax(ss, lang) else {
		return code.to_owned();
	};

	let mut parse_state = ParseState::new(syntax);
	let mut scope_stack = ScopeStack::new();
	let mut result = String::with_capacity(code.len() * 2);
	highlight_into(code, ss, &mut parse_state, &mut scope_stack, &palette(colors), &mut result);
	result
}

fn highlight_into(
	code: &str,
	ss: &SyntaxSet,
	parse_state: &mut ParseState,
	scope_stack: &mut ScopeStack,
	palette: &[&str; 11],
	result: &mut String,
) {
	for line in syntect::util::LinesWithEndings::from(code) {
		let Ok(ops) = parse_state.parse_line(line, ss) else {
			result.push_str(line);
			continue;
		};

		let mut prev_end = 0;
		for (offset, op) in ops {
			let offset = offset.min(line.len());

			if offset > prev_end {
				let text = &line[prev_end..offset];
				let color_idx = scope_to_color_index(scope_stack);

				if color_idx < palette.len() && !palette[color_idx].is_empty() {
					result.push_str(palette[color_idx]);
					result.push_str(text);
					result.push_str("\x1b[39m");
				} else {
					result.push_str(text);
				}
			}
			prev_end = offset;

			match op {
				ScopeStackOp::Push(scope) => {
					scope_stack.push(scope);
				},
				ScopeStackOp::Pop(count) => {
					for _ in 0..count {
						scope_stack.pop();
					}
				},
				ScopeStackOp::Restore | ScopeStackOp::Clear(_) | ScopeStackOp::Noop => {},
			}
		}

		if prev_end < line.len() {
			let text = &line[prev_end..];
			let color_idx = scope_to_color_index(scope_stack);

			if color_idx < palette.len() && !palette[color_idx].is_empty() {
				result.push_str(palette[color_idx]);
				result.push_str(text);
				result.push_str("\x1b[39m");
			} else {
				result.push_str(text);
			}
		}
	}
}

#[napi]
pub struct HighlightStream {
	state:  Option<(ParseState, ScopeStack)>,
	colors: HighlightColors,
}

#[napi]
impl HighlightStream {
	#[napi(constructor)]
	pub fn new(lang: Option<JsString>, colors: HighlightColors) -> Result<Self> {
		let lang = lang.map(js::utf8).transpose()?;
		let state = lang
			.as_deref()
			.and_then(|l| find_syntax(get_syntax_set(), l))
			.map(|syntax| (ParseState::new(syntax), ScopeStack::new()));
		Ok(Self { state, colors })
	}

	#[napi(getter)]
	pub const fn supported(&self) -> bool {
		self.state.is_some()
	}

	#[napi]
	pub fn push(&mut self, chunk: JsString) -> Result<String> {
		let chunk = js::utf8(chunk)?;
		let Some((parse_state, scope_stack)) = self.state.as_mut() else {
			return Ok(chunk.to_owned());
		};
		let mut result = String::with_capacity(chunk.len() * 2);
		highlight_into(
			&chunk,
			get_syntax_set(),
			parse_state,
			scope_stack,
			&palette(&self.colors),
			&mut result,
		);
		Ok(result)
	}
}

#[napi]
pub fn supports_language(lang: JsString) -> Result<bool> {
	Ok(supports_language_impl(&js::utf8(lang)?))
}

fn supports_language_impl(lang: &str) -> bool {
	if is_known_alias(lang) {
		return true;
	}

	let ss = get_syntax_set();
	find_syntax(ss, lang).is_some()
}

#[napi]
pub fn get_supported_languages() -> Vec<String> {
	let ss = get_syntax_set();
	ss.syntaxes().iter().map(|s| s.name.clone()).collect()
}
