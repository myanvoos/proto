use anyhow::Result;
use serde::{Deserialize, Serialize};
use tree_sitter::Node;

use crate::{language::SupportLang, parse_cache::parse_cached};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutlineOptions {
	pub code: String,

	pub lang: Option<String>,

	pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OutlineEntry {
	pub kind:     String,
	pub modifier: Option<String>,
	pub name:     Option<String>,
	pub detail:   Option<String>,
	pub doc:      Option<String>,
	pub notes:    Vec<String>,
	pub asks:     Vec<String>,
	pub line:     u32,
	pub children: Vec<OutlineEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OutlineResult {
	pub language: Option<String>,

	pub parsed: bool,

	pub entries: Vec<OutlineEntry>,
}

const CAP_COND: usize = 64;
const CAP_VALUE: usize = 64;
const CAP_EXPR: usize = 80;
const CAP_IMPORT: usize = 56;

const AUG_OPS: [&str; 15] = [
	"+=", "-=", "*=", "/=", "%=", "**=", "&&=", "||=", "??=", "&=", "|=", "^=", "<<=", ">>=", ">>>=",
];

const MEMBER_MODIFIERS: [&str; 10] = [
	"static",
	"async",
	"get",
	"set",
	"override",
	"public",
	"private",
	"protected",
	"abstract",
	"readonly",
];

fn collapse(text: &str) -> String {
	text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn unwrap_parens(text: &str) -> &str {
	let trimmed = text.trim();
	if trimmed.starts_with('(') && trimmed.ends_with(')') {
		trimmed[1..trimmed.len() - 1].trim()
	} else {
		trimmed
	}
}

fn condition_text(node: Node, code: &str, limit: usize) -> Option<String> {
	let raw = text_of(node, code);
	let inner = unwrap_parens(&raw);
	if inner.is_empty() {
		None
	} else {
		Some(cap(inner, limit))
	}
}

fn cap(text: &str, limit: usize) -> String {
	let flat = collapse(text);
	if flat.len() <= limit {
		return flat;
	}
	let mut cut = limit.saturating_sub(1);
	while cut > 0 && !flat.is_char_boundary(cut) {
		cut -= 1;
	}
	format!("{}…", flat[..cut].trim_end())
}

fn text_of(node: Node, code: &str) -> String {
	node
		.utf8_text(code.as_bytes())
		.unwrap_or_default()
		.to_string()
}

fn summarized(node: Node, code: &str, limit: usize) -> Option<String> {
	let text = text_of(node, code);
	if text.trim().is_empty() {
		None
	} else {
		Some(cap(&text, limit))
	}
}

fn named_iter<'tree>(node: Node<'tree>) -> impl Iterator<Item = Node<'tree>> {
	(0..node.named_child_count()).filter_map(move |index| node.named_child(index))
}

fn child_of_kind<'tree>(node: Node<'tree>, kinds: &[&str]) -> Option<Node<'tree>> {
	named_iter(node).find(|child| kinds.contains(&child.kind()))
}

fn modifier_prefix(node: Node, stop_at: &Node) -> String {
	let mut parts: Vec<&str> = Vec::new();
	for index in 0..node.child_count() {
		let Some(child) = node.child(index) else {
			continue;
		};
		if child.id() == stop_at.id() {
			break;
		}
		if child.kind() == "decorator" {
			continue;
		}
		if !child.is_named() && MEMBER_MODIFIERS.contains(&child.kind()) {
			parts.push(child.kind());
		}
	}
	parts.join(" ")
}

fn has_anonymous_token(node: Node, token: &str) -> bool {
	(0..node.child_count()).any(|index| {
		node
			.child(index)
			.is_some_and(|child| !child.is_named() && child.kind() == token)
	})
}

fn async_token(node: Node) -> bool {
	has_anonymous_token(node, "async")
}

fn generator_token(node: Node) -> bool {
	has_anonymous_token(node, "*")
}

fn parameters_of<'tree>(node: Node<'tree>) -> Option<Node<'tree>> {
	node
		.child_by_field_name("parameters")
		.or_else(|| child_of_kind(node, &["formal_parameters"]))
}

fn summarize_params(node: Option<Node>, code: &str) -> String {
	let Some(parameters) = node else {
		return String::new();
	};
	let parts: Vec<String> = named_iter(parameters)
		.filter(|child| child.kind() != "comment")
		.map(|child| cap(&text_of(child, code), 32))
		.filter(|part| !part.is_empty())
		.collect();
	parts.join(", ")
}

fn return_type_detail(node: Node, code: &str) -> Option<String> {
	let annotation = child_of_kind(node, &["type_annotation", "return_type"])?;
	let raw = text_of(annotation, code);
	let text = strip_type_annotation(&raw);
	if text.is_empty() {
		None
	} else {
		Some(format!("→ {}", cap(text, 40)))
	}
}

fn strip_type_annotation(text: &str) -> &str {
	text.trim().trim_start_matches(':').trim()
}

#[derive(Default)]
struct Pending {
	doc:   Option<String>,
	notes: Vec<String>,
	asks:  Vec<String>,
	decor: Vec<String>,
}

impl Pending {
	fn attach(&mut self, entry: &mut OutlineEntry) {
		if self.doc.is_some() && entry.doc.is_none() {
			entry.doc = self.doc.take();
		}
		if !self.notes.is_empty() {
			entry.notes.extend(self.notes.drain(..));
		}
		if !self.asks.is_empty() {
			entry.asks.extend(self.asks.drain(..));
		}
		if !self.decor.is_empty() {
			let prefix = self.decor.join(" ");
			entry.detail = Some(match entry.detail.take() {
				Some(detail) => format!("{prefix} {detail}"),
				None => prefix,
			});
			self.decor.clear();
		}
	}
}

fn new_entry(kind: &str, line: u32) -> OutlineEntry {
	OutlineEntry {
		kind: kind.to_string(),
		modifier: None,
		name: None,
		detail: None,
		doc: None,
		notes: Vec::new(),
		asks: Vec::new(),
		line,
		children: Vec::new(),
	}
}

fn observe_comment(node: Node, code: &str, pending: &mut Pending) {
	let raw = text_of(node, code);
	let trimmed = raw.trim();
	if trimmed.starts_with("///") || trimmed.contains("eslint") {
		return;
	}
	if trimmed.starts_with("/**") {
		for line in trimmed.lines() {
			let cleaned = line.trim();
			let cleaned = cleaned.strip_prefix("/**").unwrap_or(cleaned);
			let cleaned = cleaned.strip_prefix('*').unwrap_or(cleaned);
			let cleaned = cleaned.strip_suffix("*/").unwrap_or(cleaned).trim();
			if !cleaned.is_empty() {
				pending.doc.get_or_insert_with(|| cleaned.to_string());
				return;
			}
		}
		return;
	}
	if let Some(body) = trimmed.strip_prefix("//") {
		let body = body.trim();
		if let Some(rest) = body.strip_prefix("@?") {
			let note = rest.trim();
			if !note.is_empty() && !note.starts_with("ts-") {
				pending.asks.push(note.to_string());
			}
		} else if let Some(rest) = body.strip_prefix('@') {
			let note = rest.trim();
			if !note.is_empty() && !note.starts_with("ts-") {
				pending.notes.push(note.to_string());
			}
		}
		return;
	}
	// `#`-comment languages (Python, Ruby, ...): `#@` margin notes, `#@?`
	// questions.
	if let Some(rest) = trimmed.strip_prefix("#@?") {
		let note = rest.trim();
		if !note.is_empty() {
			pending.asks.push(note.to_string());
		}
		return;
	}
	if let Some(rest) = trimmed.strip_prefix("#@") {
		let note = rest.trim();
		if !note.is_empty() {
			pending.notes.push(note.to_string());
		}
	}
}

/// First meaningful line of a leading docstring statement, quotes and prefixes
/// stripped.
fn docstring_text(statement: Node, code: &str) -> Option<String> {
	if statement.kind() != "expression_statement" {
		return None;
	}
	let expression = named_iter(statement).next()?;
	if expression.kind() != "string" {
		return None;
	}
	let raw = text_of(expression, code);
	let body = raw
		.trim()
		.trim_start_matches(['r', 'R', 'b', 'B', 'u', 'U', 'f', 'F']);
	let inner = [("\"\"\"", "\"\"\""), ("'''", "'''"), ("\"", "\""), ("'", "'")]
		.into_iter()
		.find_map(|(open, close)| {
			body
				.strip_prefix(open)
				.and_then(|rest| rest.strip_suffix(close))
		})?;
	let first_line = inner.lines().map(str::trim).find(|line| !line.is_empty())?;
	Some(first_line.to_string())
}

/// Walk a Python `_suite` block into `entry.children`, optionally lifting a
/// leading docstring into `entry.doc` instead of an expr child.
fn fill_python_body(
	entry: &mut OutlineEntry,
	suite: Node,
	code: &str,
	lang: SupportLang,
	extract_doc: bool,
) {
	let mut pending = Pending::default();
	let mut children: Vec<OutlineEntry> = Vec::new();
	let mut iter = named_iter(suite).peekable();
	if extract_doc
		&& let Some(&first) = iter.peek()
		&& let Some(doc) = docstring_text(first, code)
	{
		entry.doc.get_or_insert(doc);
		iter.next();
	}
	for child in iter {
		walk_statement(child, code, lang, &mut pending, &mut children);
	}
	entry.children = children;
}

fn python_function_entry(
	node: Node,
	code: &str,
	lang: SupportLang,
	pending: &mut Pending,
) -> OutlineEntry {
	let line = node.start_position().row as u32 + 1;
	let mut entry = new_entry(
		if async_token(node) {
			"async def"
		} else {
			"def"
		},
		line,
	);
	let name = node
		.child_by_field_name("name")
		.map(|name| text_of(name, code))
		.unwrap_or_default();
	entry.name = Some(format!("{name}({})", summarize_params(parameters_of(node), code)));
	entry.detail = node
		.child_by_field_name("return_type")
		.and_then(|annotation| summarized(annotation, code, 40))
		.map(|text| format!("→ {text}"));
	if let Some(body) = node.child_by_field_name("body") {
		fill_python_body(&mut entry, body, code, lang, true);
	}
	pending.attach(&mut entry);
	entry
}

fn python_class_entry(
	node: Node,
	code: &str,
	lang: SupportLang,
	pending: &mut Pending,
) -> OutlineEntry {
	let line = node.start_position().row as u32 + 1;
	let mut entry = new_entry("class", line);
	entry.name = node
		.child_by_field_name("name")
		.map(|name| text_of(name, code));
	entry.detail = node
		.child_by_field_name("superclasses")
		.and_then(|superclasses| summarized(superclasses, code, 48));
	if let Some(body) = node.child_by_field_name("body") {
		fill_python_body(&mut entry, body, code, lang, true);
	}
	pending.attach(&mut entry);
	entry
}

fn python_elif_entry(node: Node, code: &str, lang: SupportLang) -> OutlineEntry {
	let line = node.start_position().row as u32 + 1;
	let mut entry = new_entry("elif", line);
	entry.detail = node
		.child_by_field_name("condition")
		.and_then(|condition| condition_text(condition, code, CAP_COND));
	if let Some(consequence) = node.child_by_field_name("consequence") {
		fill_python_body(&mut entry, consequence, code, lang, false);
	}
	entry
}

fn python_else_entry(node: Node, code: &str, lang: SupportLang) -> OutlineEntry {
	let line = node.start_position().row as u32 + 1;
	let mut entry = new_entry("else", line);
	if let Some(body) = node.child_by_field_name("body") {
		fill_python_body(&mut entry, body, code, lang, false);
	}
	entry
}

fn collect_body(node: Node, code: &str, lang: SupportLang, out: &mut Vec<OutlineEntry>) {
	let mut pending = Pending::default();
	for child in named_iter(node) {
		walk_statement(child, code, lang, &mut pending, out);
	}
}

fn walk_block_into(node: Node, code: &str, lang: SupportLang, entry: &mut OutlineEntry) {
	let mut children = Vec::new();
	collect_body(node, code, lang, &mut children);
	entry.children = children;
}

fn import_entry(node: Node, code: &str, line: u32) -> OutlineEntry {
	let mut entry = new_entry("import", line);
	let mut bindings: Vec<String> = Vec::new();
	let mut module_text: Option<String> = None;
	for child in named_iter(node) {
		match child.kind() {
			"import_clause" => {
				for clause_child in named_iter(child) {
					match clause_child.kind() {
						"identifier" => bindings.push(text_of(clause_child, code)),
						"namespace_import" => bindings.push(collapse(&text_of(clause_child, code))),
						"named_imports" => {
							let inner: Vec<String> = named_iter(clause_child)
								.map(|spec| collapse(&text_of(spec, code)))
								.filter(|spec| !spec.is_empty())
								.collect();
							if !inner.is_empty() {
								bindings.push(format!("{{{}}}", inner.join(", ")));
							}
						},
						_ => {},
					}
				}
			},
			"string" => module_text = Some(text_of(child, code)),
			_ => {},
		}
	}
	if bindings.is_empty() {
		if let Some(module) = module_text.clone() {
			entry.detail = Some(cap(&module, CAP_IMPORT));
			return entry;
		}
	}
	if !bindings.is_empty() {
		entry.name = Some(cap(&bindings.join(", "), CAP_IMPORT));
	}
	if let Some(module) = module_text {
		entry.detail = Some(format!("← {}", cap(&module, CAP_IMPORT)));
	}
	entry
}

fn export_entries(
	node: Node,
	code: &str,
	lang: SupportLang,
	pending: &mut Pending,
	out: &mut Vec<OutlineEntry>,
) {
	let line = node.start_position().row as u32 + 1;
	let is_default = has_anonymous_token(node, "default");
	let modifier = if is_default {
		"export default"
	} else {
		"export"
	};

	let export_clause = child_of_kind(node, &["export_clause"]);
	let star = has_anonymous_token(node, "*");
	let string_child = named_iter(node).find(|child| child.kind() == "string");

	if let Some(clause) = export_clause {
		let mut entry = new_entry("export", line);
		entry.modifier = Some(modifier.to_string());
		entry.name = Some(cap(&collapse(&text_of(clause, code)), CAP_IMPORT));
		if let Some(module) = string_child {
			entry.detail = Some(format!("← {}", cap(&text_of(module, code), CAP_IMPORT)));
		}
		pending.attach(&mut entry);
		out.push(entry);
		return;
	}
	if star {
		let mut entry = new_entry("export", line);
		entry.modifier = Some(modifier.to_string());
		entry.name = Some("*".to_string());
		if let Some(module) = string_child {
			entry.detail = Some(format!("← {}", cap(&text_of(module, code), CAP_IMPORT)));
		}
		pending.attach(&mut entry);
		out.push(entry);
		return;
	}

	let before = out.len();
	for child in named_iter(node) {
		if child.kind() == "comment" {
			observe_comment(child, code, pending);
			continue;
		}
		walk_statement(child, code, lang, pending, out);
	}
	for entry in &mut out[before..] {
		entry.modifier = Some(modifier.to_string());
	}
}

fn class_entry(
	node: Node,
	code: &str,
	lang: SupportLang,
	pending: &mut Pending,
	abstract_class: bool,
) -> OutlineEntry {
	let line = node.start_position().row as u32 + 1;
	let mut entry = new_entry("class", line);
	if abstract_class {
		entry.modifier = Some("abstract".to_string());
	}
	entry.name = node
		.child_by_field_name("name")
		.map(|name| text_of(name, code));
	entry.detail =
		child_of_kind(node, &["class_heritage"]).and_then(|heritage| summarized(heritage, code, 48));

	if let Some(body) = node.child_by_field_name("body") {
		let mut children = Vec::new();
		let mut member_pending = Pending::default();
		for member in named_iter(body) {
			match member.kind() {
				"comment" => observe_comment(member, code, &mut member_pending),
				"decorator" => member_pending.decor.push(cap(&text_of(member, code), 48)),
				"method_definition" => {
					let mut method = method_definition_entry(member, code, lang, true);
					member_pending.attach(&mut method);
					children.push(method);
				},
				"abstract_method_signature" => {
					let mut method = signature_method_entry(member, code);
					member_pending.attach(&mut method);
					children.push(method);
				},
				"public_field_definition" | "field_definition" | "property_definition" => {
					if let Some(mut field) = field_entry(member, code) {
						member_pending.attach(&mut field);
						children.push(field);
					}
				},
				"static_block" => {
					let mut block = new_entry("block", member.start_position().row as u32 + 1);
					block.name = Some("static".to_string());
					walk_block_into(member, code, lang, &mut block);
					member_pending.attach(&mut block);
					children.push(block);
				},
				_ => {},
			}
		}
		pending.attach(&mut entry);
		// Body-level pending leftovers attach to the class entry itself.
		if member_pending.doc.is_some()
			|| !member_pending.notes.is_empty()
			|| !member_pending.asks.is_empty()
		{
			if let Some(first) = children.first_mut() {
				member_pending.attach(first);
			}
		}
		entry.children = children;
		return entry;
	}
	pending.attach(&mut entry);
	entry
}

fn method_definition_entry(
	node: Node,
	code: &str,
	lang: SupportLang,
	with_body: bool,
) -> OutlineEntry {
	let line = node.start_position().row as u32 + 1;
	let name_node = node.child_by_field_name("name").or_else(|| {
		child_of_kind(node, &[
			"property_identifier",
			"private_property_identifier",
			"computed_property_name",
			"identifier",
		])
	});
	let parameters = parameters_of(node);
	let prefix = name_node
		.map(|name| modifier_prefix(node, &name))
		.unwrap_or_default();
	let name = name_node
		.map(|name| text_of(name, code))
		.unwrap_or_default();
	let generator = if generator_token(node) { "*" } else { "" };
	let mut entry = new_entry("method", line);
	let joined = if prefix.is_empty() {
		format!("{generator}{name}")
	} else {
		format!("{prefix} {generator}{name}")
	};
	entry.name = Some(format!("{joined}({})", summarize_params(parameters, code)));
	entry.detail = return_type_detail(node, code);
	if with_body {
		if let Some(body) = node.child_by_field_name("body") {
			walk_block_into(body, code, lang, &mut entry);
		}
	}
	entry
}

fn signature_method_entry(node: Node, code: &str) -> OutlineEntry {
	let line = node.start_position().row as u32 + 1;
	let name_node = node
		.child_by_field_name("name")
		.or_else(|| child_of_kind(node, &["property_identifier", "private_property_identifier"]));
	let parameters = parameters_of(node);
	let prefix = name_node
		.map(|name| modifier_prefix(node, &name))
		.unwrap_or_default();
	let name = name_node
		.map(|name| text_of(name, code))
		.unwrap_or_default();
	let mut entry = new_entry("method", line);
	entry.name = Some(if prefix.is_empty() {
		format!("{name}({})", summarize_params(parameters, code))
	} else {
		format!("{prefix} {name}({})", summarize_params(parameters, code))
	});
	entry.detail = return_type_detail(node, code);
	entry
}

fn field_entry(node: Node, code: &str) -> Option<OutlineEntry> {
	let line = node.start_position().row as u32 + 1;
	let name_node = node.child_by_field_name("name").or_else(|| {
		child_of_kind(node, &["property_identifier", "private_property_identifier", "identifier"])
	})?;
	let prefix = modifier_prefix(node, &name_node);
	let mut entry = new_entry("assign", line);
	entry.name = Some(if prefix.is_empty() {
		text_of(name_node, code)
	} else {
		format!("{prefix} {}", text_of(name_node, code))
	});
	let annotation = child_of_kind(node, &["type_annotation"]).and_then(|a| summarized(a, code, 40));
	let annotation = annotation.map(|text| strip_type_annotation(&text).to_string());
	let value = node
		.child_by_field_name("value")
		.and_then(|v| summarized(v, code, CAP_VALUE));
	entry.detail = match (annotation, value) {
		(Some(annotation), Some(value)) => Some(format!("{annotation} ← {value}")),
		(Some(annotation), None) => Some(annotation),
		(None, value) => value,
	};
	Some(entry)
}

fn function_entry(
	node: Node,
	code: &str,
	lang: SupportLang,
	pending: &mut Pending,
) -> OutlineEntry {
	let line = node.start_position().row as u32 + 1;
	let async_fn = async_token(node);
	let mut entry = new_entry(
		if async_fn {
			"async function"
		} else {
			"function"
		},
		line,
	);
	let name = node
		.child_by_field_name("name")
		.map(|name| text_of(name, code))
		.unwrap_or_default();
	let generator = if generator_token(node) { "*" } else { "" };
	let parameters = parameters_of(node);
	entry.name = Some(format!("{generator}{name}({})", summarize_params(parameters, code)));
	entry.detail = return_type_detail(node, code);
	if let Some(body) = node.child_by_field_name("body") {
		walk_block_into(body, code, lang, &mut entry);
	}
	pending.attach(&mut entry);
	entry
}

fn declarators_entries(
	node: Node,
	code: &str,
	lang: SupportLang,
	pending: &mut Pending,
	out: &mut Vec<OutlineEntry>,
) {
	for declarator in named_iter(node).filter(|child| child.kind() == "variable_declarator") {
		let line = declarator.start_position().row as u32 + 1;
		let Some(name_node) = declarator.child_by_field_name("name") else {
			continue;
		};
		let target = cap(&text_of(name_node, code), 40);
		let annotation =
			child_of_kind(declarator, &["type_annotation"]).and_then(|a| summarized(a, code, 40));
		let annotation = annotation.map(|text| strip_type_annotation(&text).to_string());
		let value_node = declarator.child_by_field_name("value");

		if let Some(value) = value_node {
			if matches!(
				value.kind(),
				"arrow_function" | "function" | "function_expression" | "function_signature"
			) {
				let mut entry = new_entry("fn", line);
				let params = summarize_params(parameters_of(value), code);
				entry.name = Some(format!("{target}({params})"));
				if async_token(value) {
					entry.modifier = Some("async".to_string());
				}
				match value.child_by_field_name("body") {
					Some(body) if body.kind() == "statement_block" => {
						entry.detail = Some("=> …".to_string());
						walk_block_into(body, code, lang, &mut entry);
					},
					Some(body) => {
						entry.detail =
							Some(format!("=> {}", summarized(body, code, CAP_VALUE).unwrap_or_default()))
					},
					None => entry.detail = Some("=> …".to_string()),
				}
				pending.attach(&mut entry);
				out.push(entry);
				continue;
			}
		}

		let mut entry = new_entry("assign", line);
		entry.name = Some(target);
		let value_text = value_node.and_then(|value| summarized(value, code, CAP_VALUE));
		entry.detail = match (annotation, value_text) {
			(Some(annotation), Some(value)) => Some(format!("{annotation} ← {value}")),
			(Some(annotation), None) => Some(annotation),
			(None, value) => value,
		};
		pending.attach(&mut entry);
		out.push(entry);
	}
}

fn else_clause_entry(clause: Node, code: &str, lang: SupportLang) -> OutlineEntry {
	let line = clause.start_position().row as u32 + 1;
	let alternative = clause
		.child_by_field_name("alternative")
		.or_else(|| named_iter(clause).next());
	if let Some(inner) = alternative {
		if inner.kind() == "if_statement" {
			let mut entry = new_entry("else if", line);
			entry.detail = inner
				.child_by_field_name("condition")
				.and_then(|condition| condition_text(condition, code, CAP_COND));
			if let Some(consequence) = inner.child_by_field_name("consequence") {
				append_statement_body(consequence, code, lang, &mut entry);
			}
			if let Some(nested_else) = named_iter(inner).find(|child| child.kind() == "else_clause") {
				let nested = else_clause_entry(nested_else, code, lang);
				entry.children.push(nested);
			}
			return entry;
		}
		let mut entry = new_entry("else", line);
		append_statement_body(inner, code, lang, &mut entry);
		return entry;
	}
	new_entry("else", line)
}

fn append_statement_body(statement: Node, code: &str, lang: SupportLang, entry: &mut OutlineEntry) {
	if statement.kind() == "statement_block" {
		let mut children = Vec::new();
		collect_body(statement, code, lang, &mut children);
		entry.children = children;
	} else {
		let mut pending = Pending::default();
		let mut children = Vec::new();
		walk_statement(statement, code, lang, &mut pending, &mut children);
		entry.children = children;
	}
}

fn for_entry(node: Node, code: &str, lang: SupportLang, kind: &str) -> OutlineEntry {
	let line = node.start_position().row as u32 + 1;
	let mut entry = new_entry(kind, line);
	match node.kind() {
		"for_statement" => {
			let raw = text_of(node, code);
			let header_end = node
				.child_by_field_name("body")
				.map(|body| body.start_byte() - node.start_byte())
				.unwrap_or(raw.len());
			let header = unwrap_parens(
				raw[..header_end]
					.trim()
					.strip_prefix("for")
					.unwrap_or("")
					.trim(),
			);
			if !header.is_empty() {
				entry.detail = Some(cap(header, CAP_COND));
			}
		},
		_ => {
			let target = node
				.child_by_field_name("left")
				.map(|n| text_of(n, code))
				.unwrap_or_default();
			entry.name = Some(cap(target.trim(), 40));
			entry.detail = node
				.child_by_field_name("right")
				.and_then(|right| summarized(right, code, CAP_COND));
		},
	}
	if let Some(body) = node.child_by_field_name("body") {
		append_statement_body(body, code, lang, &mut entry);
	}
	entry
}

fn switch_case_entry(node: Node, code: &str, lang: SupportLang) -> OutlineEntry {
	let line = node.start_position().row as u32 + 1;
	let is_default = node.kind() == "switch_default";
	let mut entry = new_entry(if is_default { "default" } else { "case" }, line);
	if !is_default {
		if let Some(value) = named_iter(node).next() {
			entry.detail = summarized(value, code, CAP_COND);
		}
	}
	let mut pending = Pending::default();
	let mut children = Vec::new();
	for child in named_iter(node).skip(if is_default { 0 } else { 1 }) {
		walk_statement(child, code, lang, &mut pending, &mut children);
	}
	entry.children = children;
	entry
}

fn try_entry(node: Node, code: &str, lang: SupportLang) -> OutlineEntry {
	let line = node.start_position().row as u32 + 1;
	let mut entry = new_entry("try", line);
	if let Some(body) = node.child_by_field_name("body") {
		walk_block_into(body, code, lang, &mut entry);
	}
	for child in named_iter(node) {
		match child.kind() {
			"catch_clause" => {
				let mut clause = new_entry("catch", child.start_position().row as u32 + 1);
				if let Some(param) = named_iter(child).find(|c| c.kind() != "statement_block") {
					clause.detail = summarized(param, code, 48);
				}
				if let Some(body) = child.child_by_field_name("body") {
					walk_block_into(body, code, lang, &mut clause);
				}
				entry.children.push(clause);
			},
			"finally_clause" => {
				let mut clause = new_entry("finally", child.start_position().row as u32 + 1);
				if let Some(body) = child.child_by_field_name("body") {
					walk_block_into(body, code, lang, &mut clause);
				}
				entry.children.push(clause);
			},
			_ => {},
		}
	}
	entry
}

fn interface_entry(node: Node, code: &str) -> OutlineEntry {
	let line = node.start_position().row as u32 + 1;
	let mut entry = new_entry("interface", line);
	entry.name = node
		.child_by_field_name("name")
		.map(|name| text_of(name, code));
	if let Some(body) = child_of_kind(node, &["interface_body", "declaration_body", "object_type"]) {
		let mut children = Vec::new();
		for member in named_iter(body) {
			match member.kind() {
				"property_signature" => {
					if let Some(field) = field_entry(member, code) {
						children.push(field);
					}
				},
				"method_signature" => children.push(signature_method_entry(member, code)),
				"construct_signature" => {
					let mut method = signature_method_entry(member, code);
					method.name =
						Some(format!("constructor({})", summarize_params(parameters_of(member), code)));
					method.detail = return_type_detail(member, code);
					children.push(method);
				},
				_ => {},
			}
		}
		entry.children = children;
	}
	entry
}

fn type_alias_entry(node: Node, code: &str) -> OutlineEntry {
	let line = node.start_position().row as u32 + 1;
	let mut entry = new_entry("type", line);
	entry.name = node
		.child_by_field_name("name")
		.map(|name| text_of(name, code));
	entry.detail = node
		.child_by_field_name("value")
		.and_then(|value| summarized(value, code, CAP_VALUE));
	entry
}

fn enum_entry(node: Node, code: &str) -> OutlineEntry {
	let line = node.start_position().row as u32 + 1;
	let mut entry = new_entry("enum", line);
	entry.name = node
		.child_by_field_name("name")
		.map(|name| text_of(name, code));
	if let Some(body) = child_of_kind(node, &["enum_body"]) {
		let mut children = Vec::new();
		for member in named_iter(body) {
			match member.kind() {
				"enum_assignment" => {
					let member_line = member.start_position().row as u32 + 1;
					let mut field = new_entry("assign", member_line);
					field.name = member
						.child_by_field_name("name")
						.map(|name| text_of(name, code));
					field.detail = member
						.child_by_field_name("value")
						.and_then(|value| summarized(value, code, 48));
					children.push(field);
				},
				"property_identifier" | "identifier" => {
					let member_line = member.start_position().row as u32 + 1;
					let mut field = new_entry("assign", member_line);
					field.name = Some(text_of(member, code));
					children.push(field);
				},
				_ => {},
			}
		}
		entry.children = children;
	}
	entry
}

fn walk_statement(
	node: Node,
	code: &str,
	lang: SupportLang,
	pending: &mut Pending,
	out: &mut Vec<OutlineEntry>,
) {
	match node.kind() {
		"comment" => observe_comment(node, code, pending),
		// --- Python (guarded arms intercept shared kind names before the JS arms) ---
		"function_definition" if lang == SupportLang::Python => {
			let entry = python_function_entry(node, code, lang, pending);
			out.push(entry);
		},
		"class_definition" if lang == SupportLang::Python => {
			let entry = python_class_entry(node, code, lang, pending);
			out.push(entry);
		},
		"decorated_definition" if lang == SupportLang::Python => {
			for child in named_iter(node) {
				if child.kind() == "decorator" {
					pending.decor.push(cap(&text_of(child, code), 48));
				} else {
					walk_statement(child, code, lang, pending, out);
				}
			}
		},
		"if_statement" if lang == SupportLang::Python => {
			let line = node.start_position().row as u32 + 1;
			let mut entry = new_entry("if", line);
			entry.detail = node
				.child_by_field_name("condition")
				.and_then(|condition| condition_text(condition, code, CAP_COND));
			if let Some(consequence) = node.child_by_field_name("consequence") {
				fill_python_body(&mut entry, consequence, code, lang, false);
			}
			for child in named_iter(node) {
				match child.kind() {
					"elif_clause" => entry.children.push(python_elif_entry(child, code, lang)),
					"else_clause" => entry.children.push(python_else_entry(child, code, lang)),
					_ => {},
				}
			}
			pending.attach(&mut entry);
			out.push(entry);
		},
		"for_statement" if lang == SupportLang::Python => {
			let kind = if async_token(node) {
				"async for"
			} else {
				"for"
			};
			let mut entry = new_entry(kind, node.start_position().row as u32 + 1);
			entry.name = node
				.child_by_field_name("left")
				.and_then(|left| summarized(left, code, 40));
			entry.detail = node
				.child_by_field_name("right")
				.and_then(|right| summarized(right, code, CAP_COND));
			if let Some(body) = node.child_by_field_name("body") {
				fill_python_body(&mut entry, body, code, lang, false);
			}
			for child in named_iter(node) {
				if child.kind() == "else_clause" {
					entry.children.push(python_else_entry(child, code, lang));
				}
			}
			pending.attach(&mut entry);
			out.push(entry);
		},
		"while_statement" if lang == SupportLang::Python => {
			let line = node.start_position().row as u32 + 1;
			let mut entry = new_entry("while", line);
			entry.detail = node
				.child_by_field_name("condition")
				.and_then(|condition| condition_text(condition, code, CAP_COND));
			if let Some(body) = node.child_by_field_name("body") {
				fill_python_body(&mut entry, body, code, lang, false);
			}
			for child in named_iter(node) {
				if child.kind() == "else_clause" {
					entry.children.push(python_else_entry(child, code, lang));
				}
			}
			pending.attach(&mut entry);
			out.push(entry);
		},
		"try_statement" if lang == SupportLang::Python => {
			let line = node.start_position().row as u32 + 1;
			let mut entry = new_entry("try", line);
			if let Some(body) = node.child_by_field_name("body") {
				fill_python_body(&mut entry, body, code, lang, false);
			}
			for child in named_iter(node) {
				match child.kind() {
					"except_clause" => {
						let mut clause = new_entry("except", child.start_position().row as u32 + 1);
						let value = child
							.child_by_field_name("value")
							.and_then(|value| summarized(value, code, 48));
						let alias = child
							.child_by_field_name("alias")
							.map(|alias| text_of(alias, code));
						clause.detail = match (value, alias) {
							(Some(value), Some(alias)) => Some(format!("{value} as {alias}")),
							(value, None) => value,
							(None, Some(alias)) => Some(alias),
						};
						if let Some(body) = child_of_kind(child, &["block"]) {
							fill_python_body(&mut clause, body, code, lang, false);
						}
						entry.children.push(clause);
					},
					"else_clause" => entry.children.push(python_else_entry(child, code, lang)),
					"finally_clause" => {
						let mut clause = new_entry("finally", child.start_position().row as u32 + 1);
						if let Some(body) = child_of_kind(child, &["block"]) {
							fill_python_body(&mut clause, body, code, lang, false);
						}
						entry.children.push(clause);
					},
					_ => {},
				}
			}
			out.push(entry);
		},
		"with_statement" if lang == SupportLang::Python => {
			let kind = if async_token(node) {
				"async with"
			} else {
				"with"
			};
			let mut entry = new_entry(kind, node.start_position().row as u32 + 1);
			let items: Vec<String> = child_of_kind(node, &["with_clause"])
				.map(|clause| {
					named_iter(clause)
						.filter(|item| item.kind() == "with_item")
						.map(|item| cap(&text_of(item, code), 48))
						.collect()
				})
				.unwrap_or_default();
			if !items.is_empty() {
				entry.detail = Some(items.join(", "));
			}
			if let Some(body) = node.child_by_field_name("body") {
				fill_python_body(&mut entry, body, code, lang, false);
			}
			pending.attach(&mut entry);
			out.push(entry);
		},
		"match_statement" if lang == SupportLang::Python => {
			let line = node.start_position().row as u32 + 1;
			let mut entry = new_entry("match", line);
			let subjects: Vec<String> = named_iter(node)
				.filter(|child| child.kind() != "block")
				.map(|child| text_of(child, code))
				.collect();
			if !subjects.is_empty() {
				entry.detail = Some(cap(&subjects.join(", "), CAP_COND));
			}
			if let Some(body) = child_of_kind(node, &["block"]) {
				let mut children: Vec<OutlineEntry> = Vec::new();
				for child in named_iter(body) {
					if child.kind() != "case_clause" {
						continue;
					}
					let mut case = new_entry("case", child.start_position().row as u32 + 1);
					let parts: Vec<String> = named_iter(child)
						.filter(|part| part.kind() != "block")
						.map(|part| text_of(part, code))
						.collect();
					if !parts.is_empty() {
						case.detail = Some(cap(&parts.join(" "), CAP_COND));
					}
					if let Some(consequence) = child_of_kind(child, &["block"]) {
						fill_python_body(&mut case, consequence, code, lang, false);
					}
					children.push(case);
				}
				entry.children = children;
			}
			pending.attach(&mut entry);
			out.push(entry);
		},
		"import_statement" if lang == SupportLang::Python => {
			let line = node.start_position().row as u32 + 1;
			let mut entry = new_entry("import", line);
			let bindings: Vec<String> = named_iter(node).map(|child| text_of(child, code)).collect();
			if !bindings.is_empty() {
				entry.name = Some(cap(&bindings.join(", "), CAP_IMPORT));
			}
			pending.attach(&mut entry);
			out.push(entry);
		},
		"import_from_statement" | "future_import_statement" if lang == SupportLang::Python => {
			let line = node.start_position().row as u32 + 1;
			let mut entry = new_entry("from-import", line);
			let module = node.child_by_field_name("module_name");
			entry.name = Some(
				module
					.map(|module| text_of(module, code))
					.unwrap_or_else(|| "__future__".to_string()),
			);
			let bindings: Vec<String> = named_iter(node)
				.filter(|child| Some(child.id()) != module.map(|module| module.id()))
				.map(|child| text_of(child, code))
				.collect();
			if !bindings.is_empty() {
				entry.detail = Some(cap(&bindings.join(", "), CAP_IMPORT));
			}
			pending.attach(&mut entry);
			out.push(entry);
		},
		"raise_statement" if lang == SupportLang::Python => {
			let line = node.start_position().row as u32 + 1;
			let mut entry = new_entry("raise", line);
			let cause = node.child_by_field_name("cause");
			let parts: Vec<String> = named_iter(node)
				.filter(|child| Some(child.id()) != cause.map(|cause| cause.id()))
				.map(|child| text_of(child, code))
				.collect();
			let mut detail = parts.join(", ");
			if let Some(cause) = cause {
				let cause_text = text_of(cause, code);
				detail = if detail.is_empty() {
					format!("from {cause_text}")
				} else {
					format!("{detail} from {cause_text}")
				};
			}
			if !detail.is_empty() {
				entry.detail = Some(cap(&detail, 56));
			}
			pending.attach(&mut entry);
			out.push(entry);
		},
		"assert_statement" if lang == SupportLang::Python => {
			let line = node.start_position().row as u32 + 1;
			let mut entry = new_entry("assert", line);
			let parts: Vec<String> = named_iter(node)
				.map(|child| cap(&text_of(child, code), 48))
				.collect();
			if !parts.is_empty() {
				entry.detail = Some(parts.join(", "));
			}
			pending.attach(&mut entry);
			out.push(entry);
		},
		"delete_statement" if lang == SupportLang::Python => {
			let line = node.start_position().row as u32 + 1;
			let mut entry = new_entry("del", line);
			entry.detail = named_iter(node)
				.next()
				.and_then(|value| summarized(value, code, CAP_VALUE));
			pending.attach(&mut entry);
			out.push(entry);
		},
		"pass_statement" | "break_statement" | "continue_statement"
			if lang == SupportLang::Python =>
		{
			let kind = match node.kind() {
				"pass_statement" => "pass",
				"break_statement" => "break",
				_ => "continue",
			};
			let mut entry = new_entry(kind, node.start_position().row as u32 + 1);
			pending.attach(&mut entry);
			out.push(entry);
		},
		"global_statement" | "nonlocal_statement" if lang == SupportLang::Python => {
			let kind = if node.kind() == "global_statement" {
				"global"
			} else {
				"nonlocal"
			};
			let line = node.start_position().row as u32 + 1;
			let mut entry = new_entry(kind, line);
			let names: Vec<String> = named_iter(node).map(|child| text_of(child, code)).collect();
			if !names.is_empty() {
				entry.detail = Some(names.join(", "));
			}
			pending.attach(&mut entry);
			out.push(entry);
		},
		"expression_statement" if lang == SupportLang::Python => {
			let line = node.start_position().row as u32 + 1;
			if let Some(expression) = named_iter(node).next() {
				if expression.kind() == "assignment" {
					let mut entry = new_entry("assign", line);
					entry.name = expression
						.child_by_field_name("left")
						.and_then(|left| summarized(left, code, 40));
					let annotation = expression
						.child_by_field_name("type")
						.and_then(|annotation| summarized(annotation, code, 40));
					let value = expression
						.child_by_field_name("right")
						.and_then(|right| summarized(right, code, CAP_VALUE));
					entry.detail = match (annotation, value) {
						(Some(annotation), Some(value)) => Some(format!("{annotation} ← {value}")),
						(Some(annotation), None) => Some(annotation),
						(None, value) => value,
					};
					pending.attach(&mut entry);
					out.push(entry);
					return;
				}
				if expression.kind() == "augmented_assignment" {
					if let Some(operator) = expression.child_by_field_name("operator") {
						let mut entry = new_entry(operator.kind(), line);
						entry.name = expression
							.child_by_field_name("left")
							.and_then(|left| summarized(left, code, 40));
						entry.detail = expression
							.child_by_field_name("right")
							.and_then(|right| summarized(right, code, CAP_VALUE));
						pending.attach(&mut entry);
						out.push(entry);
						return;
					}
				}
				let mut entry = new_entry("expr", line);
				entry.detail = summarized(expression, code, CAP_EXPR);
				pending.attach(&mut entry);
				out.push(entry);
			}
		},
		"import_statement" => {
			let mut entry = import_entry(node, code, node.start_position().row as u32 + 1);
			pending.attach(&mut entry);
			out.push(entry);
		},
		"export_statement" => export_entries(node, code, lang, pending, out),
		"class_declaration" => {
			let entry = class_entry(node, code, lang, pending, false);
			out.push(entry);
		},
		"abstract_class_declaration" => {
			let entry = class_entry(node, code, lang, pending, true);
			out.push(entry);
		},
		"function_declaration" | "generator_function_declaration" | "function_signature" => {
			let entry = function_entry(node, code, lang, pending);
			out.push(entry);
		},
		"lexical_declaration" | "variable_declaration" => {
			declarators_entries(node, code, lang, pending, out)
		},
		"if_statement" => {
			let line = node.start_position().row as u32 + 1;
			let mut entry = new_entry("if", line);
			entry.detail = node
				.child_by_field_name("condition")
				.and_then(|condition| condition_text(condition, code, CAP_COND));
			if let Some(consequence) = node.child_by_field_name("consequence") {
				append_statement_body(consequence, code, lang, &mut entry);
			}
			if let Some(else_clause) = named_iter(node).find(|child| child.kind() == "else_clause") {
				let clause = else_clause_entry(else_clause, code, lang);
				entry.children.push(clause);
			}
			pending.attach(&mut entry);
			out.push(entry);
		},
		"for_statement" => {
			let mut entry = for_entry(node, code, lang, "for");
			pending.attach(&mut entry);
			out.push(entry);
		},
		"for_of_statement" | "for_in_statement" => {
			let kind = if has_anonymous_token(node, "await") {
				"for await"
			} else {
				"for"
			};
			let mut entry = for_entry(node, code, lang, kind);
			pending.attach(&mut entry);
			out.push(entry);
		},
		"while_statement" => {
			let line = node.start_position().row as u32 + 1;
			let mut entry = new_entry("while", line);
			entry.detail = node
				.child_by_field_name("condition")
				.and_then(|condition| condition_text(condition, code, CAP_COND));
			if let Some(body) = node.child_by_field_name("body") {
				append_statement_body(body, code, lang, &mut entry);
			}
			pending.attach(&mut entry);
			out.push(entry);
		},
		"do_statement" => {
			let line = node.start_position().row as u32 + 1;
			let mut entry = new_entry("do", line);
			if let Some(body) = node.child_by_field_name("body") {
				append_statement_body(body, code, lang, &mut entry);
			}
			let parens: Vec<Node<'_>> = named_iter(node)
				.filter(|child| child.kind() == "parenthesized_expression")
				.collect();
			entry.detail = parens
				.last()
				.and_then(|condition| condition_text(*condition, code, CAP_COND));
			pending.attach(&mut entry);
			out.push(entry);
		},
		"switch_statement" => {
			let line = node.start_position().row as u32 + 1;
			let mut entry = new_entry("switch", line);
			entry.detail = node
				.child_by_field_name("value")
				.and_then(|condition| condition_text(condition, code, CAP_COND));
			if let Some(body) = node.child_by_field_name("body") {
				let mut children = Vec::new();
				for case in named_iter(body)
					.filter(|child| matches!(child.kind(), "switch_case" | "switch_default"))
				{
					children.push(switch_case_entry(case, code, lang));
				}
				entry.children = children;
			}
			pending.attach(&mut entry);
			out.push(entry);
		},
		"try_statement" => {
			let entry = try_entry(node, code, lang);
			out.push(entry);
		},
		"return_statement" => {
			let line = node.start_position().row as u32 + 1;
			let mut entry = new_entry("return", line);
			entry.detail = named_iter(node)
				.next()
				.and_then(|value| summarized(value, code, CAP_EXPR));
			pending.attach(&mut entry);
			out.push(entry);
		},
		"throw_statement" => {
			let line = node.start_position().row as u32 + 1;
			let mut entry = new_entry("throw", line);
			entry.detail = named_iter(node)
				.next()
				.and_then(|value| summarized(value, code, CAP_EXPR));
			pending.attach(&mut entry);
			out.push(entry);
		},
		"break_statement" | "continue_statement" => {
			let kind = if node.kind() == "break_statement" {
				"break"
			} else {
				"continue"
			};
			let line = node.start_position().row as u32 + 1;
			let mut entry = new_entry(kind, line);
			entry.detail = named_iter(node)
				.next()
				.and_then(|label| summarized(label, code, 32));
			pending.attach(&mut entry);
			out.push(entry);
		},
		"interface_declaration" => {
			let entry = interface_entry(node, code);
			out.push(entry);
		},
		"type_alias_declaration" => {
			let mut entry = type_alias_entry(node, code);
			pending.attach(&mut entry);
			out.push(entry);
		},
		"enum_declaration" => {
			let mut entry = enum_entry(node, code);
			pending.attach(&mut entry);
			out.push(entry);
		},
		"module_declaration" | "namespace_declaration" => {
			let line = node.start_position().row as u32 + 1;
			let mut entry = new_entry("block", line);
			entry.name = node
				.child_by_field_name("name")
				.map(|name| text_of(name, code));
			if let Some(body) = child_of_kind(node, &["statement_block", "declaration_body"]) {
				walk_block_into(body, code, lang, &mut entry);
			}
			pending.attach(&mut entry);
			out.push(entry);
		},
		"expression_statement" => {
			let line = node.start_position().row as u32 + 1;
			let expression = named_iter(node).next();
			if let Some(expression) = expression {
				if expression.kind() == "assignment_expression" {
					let operator = (0..expression.child_count()).find_map(|index| {
						let child = expression.child(index)?;
						if child.is_named() {
							return None;
						}
						let kind = child.kind();
						(AUG_OPS.contains(&kind) || kind == "=").then_some(child)
					});
					if let Some(operator) = operator {
						let mut entry = if operator.kind() == "=" {
							new_entry("assign", line)
						} else {
							new_entry(operator.kind(), line)
						};
						entry.name = expression
							.child_by_field_name("left")
							.and_then(|left| summarized(left, code, 40));
						entry.detail = expression
							.child_by_field_name("right")
							.and_then(|right| summarized(right, code, CAP_VALUE));
						pending.attach(&mut entry);
						out.push(entry);
						return;
					}
				}
				let mut entry = new_entry("expr", line);
				entry.detail = summarized(expression, code, CAP_EXPR);
				pending.attach(&mut entry);
				out.push(entry);
			}
		},
		"statement_block" => {
			let line = node.start_position().row as u32 + 1;
			let mut entry = new_entry("block", line);
			walk_block_into(node, code, lang, &mut entry);
			pending.attach(&mut entry);
			out.push(entry);
		},
		"labeled_statement" => {
			for child in named_iter(node) {
				walk_statement(child, code, lang, pending, out);
			}
		},
		"empty_statement" | "debugger_statement" | "ERROR" | "MISSING" => {
			if node.kind() == "ERROR" {
				for child in named_iter(node) {
					walk_statement(child, code, lang, pending, out);
				}
			}
		},
		_other => {
			let line = node.start_position().row as u32 + 1;
			let mut entry = new_entry("expr", line);
			entry.detail = summarized(node, code, CAP_EXPR);
			pending.attach(&mut entry);
			out.push(entry);
		},
	}
}

fn parse_with(lang: SupportLang, code: &str) -> Result<Option<OutlineResult>> {
	let Some(tree) = parse_cached(code, lang)? else {
		return Ok(None);
	};
	let root = tree.root_node();
	let mut pending = Pending::default();
	let mut entries = Vec::new();
	for child in named_iter(root) {
		walk_statement(child, code, lang, &mut pending, &mut entries);
	}
	Ok(Some(OutlineResult {
		language: Some(lang.canonical_name().to_string()),
		parsed: true,
		entries,
	}))
}

pub fn code_outline(options: OutlineOptions) -> Result<OutlineResult> {
	let source = options.code;
	if source.trim().is_empty() {
		return Ok(OutlineResult { language: None, parsed: false, entries: Vec::new() });
	}
	let Some(lang) = resolve_outline_language(options.lang.as_deref(), options.path.as_deref())
	else {
		return Ok(OutlineResult { language: None, parsed: false, entries: Vec::new() });
	};

	// JS cells routinely carry TS syntax (Bun executes both), so fall back to the
	// TSX grammar — a superset that also covers JSX — when the JS grammar errors.
	let mut result = parse_with(lang, &source)?;
	if lang == SupportLang::JavaScript {
		let errored = parse_cached(&source, lang)?
			.map(|tree| tree.root_node().has_error())
			.unwrap_or(true);
		if errored {
			if let Ok(Some(tsx_result)) = parse_with(SupportLang::Tsx, &source) {
				result = Some(tsx_result);
			}
		}
	}

	Ok(result.unwrap_or(OutlineResult { language: None, parsed: false, entries: Vec::new() }))
}

fn resolve_outline_language(lang: Option<&str>, path: Option<&str>) -> Option<SupportLang> {
	let extension;
	let alias: &str = match lang.map(str::trim).filter(|lang| !lang.is_empty()) {
		Some(lang) => lang,
		None => {
			extension = path.map(extension_of).unwrap_or_default();
			extension.as_str()
		},
	};
	if alias.is_empty() {
		return None;
	}
	match alias.to_ascii_lowercase().as_str() {
		"js" | "jsx" | "javascript" | "mjs" | "cjs" => Some(SupportLang::JavaScript),
		"ts" | "tsx" | "typescript" | "mts" | "cts" => Some(SupportLang::Tsx),
		"py" | "py3" | "pyi" | "python" => Some(SupportLang::Python),
		_ => None,
	}
}

fn extension_of(path: &str) -> String {
	path.rsplit('.').next().unwrap_or_default().to_string()
}
