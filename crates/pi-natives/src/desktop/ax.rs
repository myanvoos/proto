use std::{
	collections::HashMap,
	fmt::Write as _,
	hash::{Hash, Hasher},
};

use super::{
	backend::AxBackend,
	error::{CoreResult, DesktopError},
	types::{AxNode, AxQuery, AxSnapshot, AxSnapshotOptions, DesktopWindow},
};

#[derive(Clone)]
pub enum AxHandle {
	#[cfg(target_os = "macos")]
	Mac(objc2_core_foundation::CFRetained<objc2_application_services::AXUIElement>),
	#[cfg(target_os = "linux")]
	AtSpi(atspi::ObjectRefOwned),
}

impl PartialEq for AxHandle {
	fn eq(&self, other: &Self) -> bool {
		match (self, other) {
			#[cfg(target_os = "macos")]
			(Self::Mac(a), Self::Mac(b)) => a == b,
			#[cfg(target_os = "linux")]
			(Self::AtSpi(a), Self::AtSpi(b)) => a == b,
		}
	}
}
impl Eq for AxHandle {}
impl Hash for AxHandle {
	fn hash<H: Hasher>(&self, state: &mut H) {
		match self {
			#[cfg(target_os = "macos")]
			Self::Mac(element) => element.hash(state),
			#[cfg(target_os = "linux")]
			Self::AtSpi(object) => object.hash(state),
		}
	}
}

#[derive(Debug, Clone, Copy)]
pub enum WalkBounds {
	Read,
	Skip,
}

#[derive(Debug, Clone)]
pub struct AxProps {
	pub role:        String,
	pub native_role: String,
	pub title:       Option<String>,
	pub value:       Option<String>,
	pub description: Option<String>,
	pub enabled:     bool,
	pub focused:     bool,
	pub bounds:      Option<AxBounds>,
	pub actions:     Vec<String>,
	pub child_count: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct AxBounds {
	pub x:      f64,
	pub y:      f64,
	pub width:  f64,
	pub height: f64,
}

struct Registered {
	handle:     AxHandle,
	target_key: String,
	generation: u64,
	role:       String,
	label:      Option<String>,
}

pub struct AxRegistry {
	next_ref:    u64,
	generations: HashMap<String, u64>,
	entries:     HashMap<u64, Registered>,
	refs:        HashMap<String, HashMap<AxHandle, u64>>,
}

impl Default for AxRegistry {
	fn default() -> Self {
		Self {
			next_ref:    1,
			generations: HashMap::new(),
			entries:     HashMap::new(),
			refs:        HashMap::new(),
		}
	}
}

impl AxRegistry {
	pub(crate) fn begin_snapshot(&mut self, target: &str) -> u64 {
		let generation = self.generations.entry(target.to_string()).or_default();
		*generation = generation.saturating_add(1);
		*generation
	}

	pub(crate) fn end_snapshot(&mut self, target: &str, generation: u64) {
		self.evict(|entry| {
			entry.target_key == target && entry.generation.saturating_add(1) < generation
		});
	}

	pub(crate) fn current_generation(&mut self, target: &str) -> u64 {
		*self.generations.entry(target.to_string()).or_insert(1)
	}

	/// Re-read live elements retain their refs per target. A changed role or
	/// label gets a new ref; the previous ref keeps its original handle until
	/// expiration.
	pub(crate) fn register(
		&mut self,
		target: &str,
		generation: u64,
		handle: AxHandle,
		props: &AxProps,
	) -> String {
		let name = label(props);
		let known = self
			.refs
			.get(target)
			.and_then(|refs| refs.get(&handle))
			.copied();
		let renewed = known.filter(|id| {
			self
				.entries
				.get(id)
				.is_some_and(|entry| entry.role == props.role && entry.label.as_deref() == name)
		});
		let id = renewed.unwrap_or_else(|| {
			let id = self.next_ref;
			self.next_ref = self.next_ref.saturating_add(1);
			self
				.refs
				.entry(target.to_owned())
				.or_default()
				.insert(handle.clone(), id);
			id
		});
		self.entries.insert(id, Registered {
			handle,
			target_key: target.to_owned(),
			generation,
			role: props.role.clone(),
			label: name.map(str::to_owned),
		});
		self.enforce_cap();
		format!("e{id}")
	}

	fn evict(&mut self, mut expired: impl FnMut(&Registered) -> bool) {
		self.entries.retain(|id, entry| {
			if !expired(entry) {
				return true;
			}
			if let Some(refs) = self.refs.get_mut(&entry.target_key)
				&& refs.get(&entry.handle) == Some(id)
			{
				refs.remove(&entry.handle);
			}
			false
		});
		self.refs.retain(|_, refs| !refs.is_empty());
	}

	pub(crate) fn resolve(&self, reference: &str) -> CoreResult<AxHandle> {
		let id = reference
			.strip_prefix('e')
			.and_then(|id| id.parse::<u64>().ok());
		id.and_then(|id| self.entries.get(&id))
			.map(|entry| entry.handle.clone())
			.ok_or_else(|| DesktopError::stale_ref(format!("{reference} expired; re-run ax()/find()")))
	}

	pub(crate) fn target(&self, reference: &str) -> CoreResult<String> {
		let id = reference
			.strip_prefix('e')
			.and_then(|id| id.parse::<u64>().ok());
		id.and_then(|id| self.entries.get(&id))
			.map(|entry| entry.target_key.clone())
			.ok_or_else(|| DesktopError::stale_ref(format!("{reference} expired; re-run ax()/find()")))
	}

	fn enforce_cap(&mut self) {
		while self.entries.len() > 5_000 {
			let mut target_sizes: HashMap<&str, usize> = HashMap::new();
			for entry in self.entries.values() {
				*target_sizes.entry(&entry.target_key).or_default() += 1;
			}
			let Some(target) = target_sizes
				.into_iter()
				.max_by_key(|(_, count)| *count)
				.map(|(target, _)| target.to_string())
			else {
				break;
			};
			let Some(oldest) = self
				.entries
				.values()
				.filter(|entry| entry.target_key == target)
				.map(|entry| entry.generation)
				.min()
			else {
				break;
			};
			self.evict(|entry| entry.target_key == target && entry.generation == oldest);
		}
	}
}

#[derive(Clone)]
struct WalkNode {
	handle:   AxHandle,
	props:    AxProps,
	children: Vec<Self>,
}

struct WalkState {
	visited:   u32,
	skipped:   u32,
	max_nodes: u32,
	max_depth: u32,
	truncated: bool,
	bounds:    WalkBounds,
}

fn walk_raw(
	backend: &mut dyn AxBackend,
	handle: AxHandle,
	depth: u32,
	state: &mut WalkState,
) -> CoreResult<Option<WalkNode>> {
	if depth > state.max_depth || state.visited >= state.max_nodes {
		state.truncated = true;
		return Ok(None);
	}
	state.visited += 1;
	let (props, child_handles) = match backend.walk_node(&handle, state.bounds) {
		Ok(node) => node,
		Err(_) if depth > 0 => {
			state.skipped = state.skipped.saturating_add(1);
			return Ok(None);
		},
		Err(error) => return Err(error),
	};
	let mut children = Vec::new();
	for child in child_handles {
		if let Some(child) = walk_raw(backend, child, depth + 1, state)? {
			children.push(child);
		}
		if state.truncated && state.visited >= state.max_nodes {
			break;
		}
	}
	Ok(Some(WalkNode { handle, props, children }))
}

fn named(props: &AxProps) -> bool {
	[&props.title, &props.value, &props.description]
		.into_iter()
		.flatten()
		.any(|value| !value.trim().is_empty())
}

fn label(props: &AxProps) -> Option<&str> {
	[props.title.as_deref(), props.description.as_deref()]
		.into_iter()
		.flatten()
		.map(str::trim)
		.find(|label| !label.is_empty())
}
fn interactable(props: &AxProps) -> bool {
	!props.actions.is_empty()
		|| matches!(
			props.role.as_str(),
			"button"
				| "checkbox"
				| "radio"
				| "textfield"
				| "textarea"
				| "link" | "menuitem"
				| "tab" | "slider"
				| "combobox"
				| "popupbutton"
				| "listitem"
				| "outlineitem"
				| "cell"
		)
}
fn structural(role: &str) -> bool {
	matches!(
		role,
		"window"
			| "group"
			| "webarea"
			| "list"
			| "table"
			| "row"
			| "menu"
			| "menubar"
			| "tabgroup"
			| "toolbar"
			| "scrollarea"
			| "outline"
	)
}

fn filter_node(mut node: WalkNode, all: bool) -> Option<WalkNode> {
	node.children = node
		.children
		.into_iter()
		.filter_map(|child| filter_node(child, all))
		.collect();
	if all || interactable(&node.props) || named(&node.props) {
		return Some(node);
	}
	match node.children.len() {
		0 => None,
		1 if node.props.role == "group" || !structural(&node.props.role) => node.children.pop(),
		_ => Some(node),
	}
}

fn escaped_truncated(value: &str, max: usize) -> String {
	let mut out: String = value.chars().take(max).collect();
	if value.chars().count() > max {
		out.push('…');
	}
	out.replace('\\', "\\\\")
		.replace('"', "\\\"")
		.replace('\n', " ")
}

fn node_to_napi(reference: String, props: AxProps) -> AxNode {
	let (x, y, width, height) = props
		.bounds
		.map_or((None, None, None, None), |b| (Some(b.x), Some(b.y), Some(b.width), Some(b.height)));
	AxNode {
		ref_: reference,
		role: props.role,
		native_role: props.native_role,
		title: props.title,
		value: props.value,
		description: props.description,
		enabled: props.enabled,
		focused: props.focused,
		x,
		y,
		width,
		height,
		actions: (!props.actions.is_empty()).then_some(props.actions),
		child_count: props.child_count,
	}
}

fn format_tree(
	node: WalkNode,
	depth: usize,
	window: &DesktopWindow,
	registry: &mut AxRegistry,
	target: &str,
	generation: u64,
	text: &mut String,
	nodes: &mut u32,
) {
	let reference = registry.register(target, generation, node.handle, &node.props);
	if !text.is_empty() {
		text.push('\n');
	}
	text.push_str(&"  ".repeat(depth));
	text.push_str("- ");
	text.push_str(&node.props.role);
	if let Some(label) = label(&node.props) {
		let _ = write!(text, " \"{}\"", escaped_truncated(label, 80));
	}
	let _ = write!(text, " [ref={reference}]");
	if depth == 0 {
		let _ = write!(text, " app={}", window.app);
	}
	if let Some(value) = node
		.props
		.value
		.as_deref()
		.filter(|value| !value.is_empty())
	{
		let _ = write!(text, ": \"{}\"", escaped_truncated(value, 80));
	}
	if !node.props.enabled {
		text.push_str(" (disabled)");
	}

	let focused = if depth == 0 {
		window.focused
	} else {
		node.props.focused
	};
	if focused {
		text.push_str(" (focused)");
	}
	*nodes += 1;
	for child in node.children {
		format_tree(child, depth + 1, window, registry, target, generation, text, nodes);
	}
}

pub fn snapshot(
	backend: &mut dyn AxBackend,
	registry: &mut AxRegistry,
	window: &DesktopWindow,
	options: &AxSnapshotOptions,
) -> CoreResult<AxSnapshot> {
	let target = &window.id;
	let generation = registry.begin_snapshot(target);
	let root = backend.window_root(window)?;
	let mut state = WalkState {
		visited:   0,
		skipped:   0,
		max_nodes: options.max_nodes.unwrap_or(800).max(1),
		max_depth: options.max_depth.unwrap_or(24),
		truncated: false,
		bounds:    WalkBounds::Skip,
	};
	let root = walk_raw(backend, root, 0, &mut state)?
		.and_then(|node| filter_node(node, options.all.unwrap_or(false)));
	let mut text = String::new();
	let mut node_count = 0;
	if let Some(root) = root {
		format_tree(root, 0, window, registry, target, generation, &mut text, &mut node_count);
	}
	registry.end_snapshot(target, generation);
	if state.truncated {
		if !text.is_empty() {
			text.push('\n');
		}
		let _ = write!(text, "… truncated ({} nodes)", state.visited);
	}
	if state.skipped > 0 {
		if !text.is_empty() {
			text.push('\n');
		}
		let _ = write!(text, "… skipped {} unreadable nodes", state.skipped);
	}
	Ok(AxSnapshot { text, node_count, truncated: state.truncated })
}

pub fn query(
	backend: &mut dyn AxBackend,
	registry: &mut AxRegistry,
	window: &DesktopWindow,
	query: &AxQuery,
) -> CoreResult<Vec<AxNode>> {
	let target = &window.id;
	let generation = registry.current_generation(target);
	let root = backend.window_root(window)?;
	let mut state = WalkState {
		visited:   0,
		skipped:   0,
		max_nodes: 5_000,
		max_depth: 24,
		truncated: false,
		bounds:    WalkBounds::Read,
	};
	let Some(root) = walk_raw(backend, root, 0, &mut state)? else {
		return Ok(Vec::new());
	};
	let role = query.role.as_deref().map(str::to_lowercase);
	let title = query.title.as_deref().map(str::to_lowercase);
	let value = query.value.as_deref().map(str::to_lowercase);
	let limit = query.limit.unwrap_or(100).min(5_000) as usize;
	let mut result = Vec::new();
	let mut stack = vec![root];
	while let Some(node) = stack.pop() {
		stack.extend(node.children.iter().rev().cloned());
		let contains = |actual: Option<&str>, expected: Option<&String>| {
			expected
				.is_none_or(|needle| actual.is_some_and(|text| text.to_lowercase().contains(needle)))
		};
		if contains(Some(&node.props.role), role.as_ref())
			&& contains(label(&node.props), title.as_ref())
			&& contains(node.props.value.as_deref(), value.as_ref())
		{
			let reference = registry.register(target, generation, node.handle, &node.props);
			result.push(node_to_napi(reference, node.props));
			if result.len() >= limit {
				break;
			}
		}
	}
	Ok(result)
}

pub fn register_node(
	backend: &mut dyn AxBackend,
	registry: &mut AxRegistry,
	target: &str,
	handle: AxHandle,
) -> CoreResult<AxNode> {
	let props = backend.props(&handle)?;
	let generation = registry.current_generation(target);
	let reference = registry.register(target, generation, handle, &props);
	Ok(node_to_napi(reference, props))
}
pub fn element_at_node(
	backend: &mut dyn AxBackend,
	registry: &mut AxRegistry,
	target: &str,
	x: f64,
	y: f64,
) -> CoreResult<Option<AxNode>> {
	let Some(handle) = backend.element_at(x, y)? else {
		return Ok(None);
	};
	register_node(backend, registry, target, handle).map(Some)
}

pub fn ax_press(backend: &mut dyn AxBackend, handle: &AxHandle) -> CoreResult<()> {
	backend.perform(handle, "press")
}

#[cfg(target_os = "macos")]
pub fn normalize_role_macos(native: &str) -> String {
	match native {
		"AXTextArea" => "textarea",
		"AXTextField" => "textfield",
		"AXPopUpButton" => "popupbutton",
		"AXRadioButton" => "radio",
		"AXCheckBox" => "checkbox",
		"AXStaticText" => "statictext",
		"AXScrollArea" => "scrollarea",
		"AXTabGroup" => "tabgroup",
		"AXWebArea" => "webarea",
		"AXRow" => "row",
		"AXCell" => "cell",
		"AXOutline" => "outline",
		_ => native.strip_prefix("AX").unwrap_or(native),
	}
	.to_ascii_lowercase()
}
#[cfg(target_os = "linux")]
pub fn normalize_role_atspi(native: &str, multiline: bool) -> String {
	match native.to_ascii_lowercase().as_str() {
		"push button" | "toggle button" => "button".into(),
		"entry" | "text" if multiline => "textarea".into(),
		"entry" | "text" => "textfield".into(),
		"label" => "statictext".into(),
		"page tab" => "tab".into(),
		"page tab list" => "tabgroup".into(),
		"table cell" => "cell".into(),
		"tree" => "outline".into(),
		"tree item" => "outlineitem".into(),
		"frame" | "dialog" => "window".into(),
		other => other.replace(' ', ""),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn handle(id: u32) -> AxHandle {
		#[cfg(target_os = "macos")]
		{
			unsafe extern "C" {
				fn AXUIElementCreateApplication(
					pid: libc::pid_t,
				) -> *mut objc2_application_services::AXUIElement;
			}
			let pointer =
				std::ptr::NonNull::new(unsafe { AXUIElementCreateApplication(id as libc::pid_t) })
					.unwrap();
			AxHandle::Mac(unsafe { objc2_core_foundation::CFRetained::from_raw(pointer) })
		}
		#[cfg(target_os = "linux")]
		{
			AxHandle::AtSpi(atspi::ObjectRefOwned::from_static_str_unchecked(
				":1.7",
				Box::leak(format!("/org/a11y/atspi/{id}").into_boxed_str()),
			))
		}
	}

	#[test]
	fn refs_survive_rereads_and_one_missing_snapshot_but_expire_after_two() {
		let mut registry = AxRegistry::default();
		let props = node("button", Some("Go"), vec![]).props;
		let mut read = |present: bool| {
			let generation = registry.begin_snapshot("window");
			let reference =
				present.then(|| registry.register("window", generation, handle(2), &props));
			registry.end_snapshot("window", generation);
			reference
		};
		let first = read(true).unwrap();
		assert_eq!(read(true).as_deref(), Some(first.as_str()));
		read(false);
		assert_eq!(read(true).as_deref(), Some(first.as_str()));
		read(false);
		read(false);
		assert_eq!(
			registry.resolve(&first).err().unwrap().code,
			super::super::error::ErrorCode::StaleRef
		);
	}

	#[test]
	fn relabelled_elements_keep_old_handles_without_overwriting_new_refs() {
		let mut registry = AxRegistry::default();
		let old = node("button", Some("Play"), vec![]).props;
		let new = node("button", Some("Pause"), vec![]).props;
		let generation = registry.begin_snapshot("window");
		let first = registry.register("window", generation, handle(2), &old);
		let generation = registry.begin_snapshot("window");
		let second = registry.register("window", generation, handle(2), &new);
		assert_ne!(first, second);
		assert!(registry.resolve(&first).is_ok());
		for _ in 0..2 {
			let generation = registry.begin_snapshot("window");
			assert_eq!(registry.register("window", generation, handle(2), &new), second);
			registry.end_snapshot("window", generation);
		}
		assert!(registry.resolve(&first).is_err());
		assert!(registry.resolve(&second).is_ok());
	}

	#[test]
	fn refs_are_isolated_between_targets_and_capped() {
		let mut registry = AxRegistry::default();
		let props = node("button", Some("Go"), vec![]).props;
		let first = registry.register("desktop", 1, handle(2), &props);
		let generation = registry.current_generation("window");
		let second = registry.register("window", generation, handle(2), &props);
		assert_ne!(first, second);
		for _ in 0..2 {
			let generation = registry.begin_snapshot("window");
			registry.end_snapshot("window", generation);
		}
		assert!(registry.resolve(&first).is_ok());
		assert!(registry.resolve(&second).is_err());
		for id in 10..5_011 {
			registry.register("large", 1, handle(id), &props);
		}
		assert!(registry.entries.len() <= 5_000);
		assert!(registry.resolve(&first).is_ok());
	}

	fn node(role: &str, title: Option<&str>, children: Vec<WalkNode>) -> WalkNode {
		WalkNode {
			handle: handle(1),
			props: AxProps {
				role:        role.into(),
				native_role: role.into(),
				title:       title.map(str::to_owned),
				value:       None,
				description: None,
				enabled:     true,
				focused:     false,
				bounds:      None,
				actions:     Vec::new(),
				child_count: children.len() as u32,
			},
			children,
		}
	}

	#[test]
	fn unnamed_containers_preserve_controls_and_drop_empty_wrappers() {
		let tree = node("splitgroup", None, vec![
			node("scrollarea", None, vec![node("button", Some("Groceries"), vec![])]),
			node("layoutarea", None, vec![node("textfield", Some("Notes"), vec![])]),
			node("group", None, vec![]),
		]);
		let filtered = filter_node(tree, false).unwrap();
		assert_eq!(filtered.props.role, "splitgroup");
		assert_eq!(filtered.children.len(), 2);
		assert_eq!(filtered.children[0].props.role, "scrollarea");
		assert_eq!(filtered.children[0].children[0].props.title.as_deref(), Some("Groceries"));
		assert_eq!(filtered.children[1].props.title.as_deref(), Some("Notes"));
	}
}
