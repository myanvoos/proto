use std::{
	collections::{HashSet, VecDeque},
	ffi::c_void,
	mem,
	ops::Range,
	ptr::{self, NonNull},
	sync::LazyLock,
	thread,
	time::{Duration, Instant},
};

use objc2_application_services::{
	AXCopyMultipleAttributeOptions, AXError, AXIsProcessTrusted, AXUIElement, AXValue, AXValueType,
};
use objc2_core_foundation::{
	CFArray, CFBoolean, CFDate, CFIndex, CFNull, CFNumber, CFRetained, CFString, CFTimeZone, CFType,
	CFURL, CGPoint, CGSize,
};

use super::super::{
	ax::{AxBounds, AxHandle, AxProps, WalkBounds, normalize_role_macos},
	backend::AxBackend,
	error::{CoreResult, DesktopError},
	types::DesktopWindow,
};

const AX_TIMEOUT_SECONDS: f32 = 2.0;

/// The attributes read of every element a tree walk or `props` visits, all in
/// one `AXUIElementCopyMultipleAttributeValues` round trip rather than one
/// message each. Ordered so every [`NodeRead`] is a contiguous range: a walk
/// that skips bounds drops the last two, and `props` drops `AXChildren`,
/// whose count `AXUIElementGetAttributeValueCount` reads without copying the
/// array.
const NODE_ATTRIBUTES: [&str; 10] = [
	"AXChildren",
	"AXRole",
	"AXTitle",
	"AXValue",
	"AXDescription",
	"AXEnabled",
	"AXFocused",
	"AXPlaceholderValue",
	"AXPosition",
	"AXSize",
];
const CHILDREN: usize = 0;
const ROLE: usize = 1;
const TITLE: usize = 2;
const VALUE: usize = 3;
const DESCRIPTION: usize = 4;
const ENABLED: usize = 5;
const FOCUSED: usize = 6;
const PLACEHOLDER: usize = 7;
const POSITION: usize = 8;
const SIZE: usize = 9;

/// Which slice of [`NODE_ATTRIBUTES`] one element read requests.
#[derive(Clone, Copy)]
enum NodeRead {
	Walk,
	WalkWithBounds,
	Props,
}

impl NodeRead {
	const ALL: [Self; 3] = [Self::Walk, Self::WalkWithBounds, Self::Props];

	const fn attributes(self) -> Range<usize> {
		match self {
			Self::Walk => CHILDREN..POSITION,
			Self::WalkWithBounds => CHILDREN..NODE_ATTRIBUTES.len(),
			Self::Props => ROLE..NODE_ATTRIBUTES.len(),
		}
	}
}

thread_local! {
	/// Each [`NodeRead`]'s attribute names as the `CFArray` it sends, indexed by
	/// the read and built once per session thread.
	static NODE_REQUESTS: [CFRetained<CFArray<CFString>>; 3] = NodeRead::ALL.map(|read| {
		let names: Vec<_> = NODE_ATTRIBUTES[read.attributes()]
			.iter()
			.map(|name| CFString::from_static_str(name))
			.collect();
		CFArray::from_retained_objects(&names)
	});
}

/// One element's [`NODE_ATTRIBUTES`] from a single batched read.
struct NodeValues {
	values: NodeBatch,
	/// [`NODE_ATTRIBUTES`] index of the first value.
	first:  usize,
}

enum NodeBatch {
	/// The values in request order.
	Read(CFRetained<CFArray<CFType>>),
	/// One lone read per requested attribute, in request order.
	Lone(Vec<Result<Option<CFRetained<CFType>>, AXError>>),
	/// The element is gone, so every attribute fails with this error.
	Gone(AXError),
}

impl NodeValues {
	fn read(element: &AXUIElement, read: NodeRead) -> Self {
		let mut output: *const CFArray = ptr::null();
		let error = NODE_REQUESTS.with(|requests| {
			// SAFETY: The request is a CFArray of CFString attribute names and
			// `output` is writable; a successful call stores a +1 CFArray there.
			unsafe {
				element.copy_multiple_attribute_values(
					requests[read as usize].as_opaque(),
					AXCopyMultipleAttributeOptions::empty(),
					NonNull::from(&mut output),
				)
			}
		});
		let batch = if error == AXError::Success {
			NonNull::new(output.cast_mut())
				.ok_or(AXError::Failure)
				.map(|pointer| {
					// SAFETY: The successful copy returned this array at +1; its
					// entries are attribute values or AXError-typed AXValues.
					let array: CFRetained<CFArray> = unsafe { CFRetained::from_raw(pointer) };
					// SAFETY: Every entry is a CF object.
					unsafe { CFRetained::cast_unchecked::<CFArray<CFType>>(array) }
				})
		} else {
			Err(error)
		};
		Self::from_batch(batch, read.attributes(), |index| {
			copy_attribute_result(element, NODE_ATTRIBUTES[index])
		})
	}

	/// The batch's values, or `lone` reads of each attribute when the batch
	/// failed as a whole for a live element: a messaging timeout gives the
	/// batch one deadline for every attribute, and one slow attribute must
	/// not lose the element's role and children.
	fn from_batch(
		batch: Result<CFRetained<CFArray<CFType>>, AXError>,
		attributes: Range<usize>,
		mut lone: impl FnMut(usize) -> Result<Option<CFRetained<CFType>>, AXError>,
	) -> Self {
		let first = attributes.start;
		let values = match batch {
			Ok(values) => NodeBatch::Read(values),
			Err(error) if error == AXError::InvalidUIElement => NodeBatch::Gone(error),
			Err(_) => NodeBatch::Lone(
				attributes
					.map(|index| {
						// Do not add a timeout for naming-only metadata when the
						// batch is unresponsive.
						if index == PLACEHOLDER {
							Err(AXError::CannotComplete)
						} else {
							lone(index)
						}
					})
					.collect(),
			),
		};
		Self { values, first }
	}

	/// `NODE_ATTRIBUTES[index]` as a lone `AXUIElementCopyAttributeValue`
	/// reports it: the attribute's error, or `None` when it has no value.
	fn get(&self, index: usize) -> Result<Option<CFRetained<CFType>>, AXError> {
		let offset = index.checked_sub(self.first);
		let values = match &self.values {
			NodeBatch::Read(values) => values,
			NodeBatch::Lone(values) => {
				return offset
					.and_then(|offset| values.get(offset))
					.cloned()
					.unwrap_or(Err(AXError::Failure));
			},
			NodeBatch::Gone(error) => return Err(*error),
		};
		let value = offset
			.and_then(|offset| values.get(offset))
			.ok_or(AXError::Failure)?;
		if value.downcast_ref::<CFNull>().is_some() {
			return Ok(None);
		}
		if let Some(ax_value) = value.downcast_ref::<AXValue>()
			// SAFETY: Reading the type of a live AXValue has no preconditions.
			&& unsafe { ax_value.r#type() } == AXValueType::AXError
		{
			let mut error = AXError::Failure;
			// SAFETY: An AXError-typed AXValue holds exactly one AXError, which
			// `error` has room for.
			unsafe { ax_value.value(AXValueType::AXError, NonNull::from(&mut error).cast()) };
			return Err(error);
		}
		Ok(Some(value))
	}
}

type GetWindowIdFn = unsafe extern "C" fn(&AXUIElement, *mut u32) -> AXError;

static GET_WINDOW_ID: LazyLock<Option<GetWindowIdFn>> = LazyLock::new(|| {
	let symbol = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"_AXUIElementGetWindow".as_ptr()) };
	if symbol.is_null() {
		None
	} else {
		Some(unsafe { mem::transmute::<*mut c_void, GetWindowIdFn>(symbol) })
	}
});

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
	fn AXUIElementCreateApplication(pid: libc::pid_t) -> *mut AXUIElement;
}

pub(super) fn focused_window_id(pid: libc::pid_t) -> Option<u32> {
	if !is_trusted() {
		return None;
	}
	let app = create_application(pid).ok()?;
	set_timeout(&app).ok()?;
	let _ = copy_string(&app, "AXRole");
	let window = copy_element(&app, "AXFocusedWindow")?;
	let get_id = (*GET_WINDOW_ID)?;
	let mut id = 0;
	(unsafe { get_id(&window, &mut id) } == AXError::Success).then_some(id)
}

pub(super) fn is_trusted() -> bool {
	unsafe { AXIsProcessTrusted() }
}

#[derive(Default)]
pub(super) struct MacAx {
	read_processes: HashSet<(libc::pid_t, u64, u64)>,
}

impl MacAx {
	pub(super) fn new() -> Self {
		Self::default()
	}

	pub(super) fn raise(&mut self, window: &DesktopWindow) -> CoreResult<()> {
		let root = Self::window_element(window)?;
		self.perform(&root, "AXRaise")
	}

	fn window_element(win: &DesktopWindow) -> CoreResult<AxHandle> {
		ensure_trusted()?;
		let pid = win.pid.ok_or_else(|| {
			DesktopError::ax_failed(format!("window {} has no owning process id", win.id))
		})?;
		let pid = i32::try_from(pid).map_err(|_| {
			DesktopError::ax_failed(format!("window {} has an invalid process id", win.id))
		})?;
		let app = create_application(pid)?;
		set_timeout(&app)?;
		let _ = copy_string(&app, "AXRole");
		let windows = copy_elements(&app, "AXWindows")?;
		let expected_id = win.id.parse::<u32>().ok();
		if let (Some(get_id), Some(expected_id)) = (*GET_WINDOW_ID, expected_id) {
			for element in &windows {
				let mut actual_id = 0u32;

				if unsafe { get_id(element, &mut actual_id) } == AXError::Success
					&& actual_id == expected_id
				{
					set_timeout(element)?;
					return Ok(AxHandle::Mac(element.clone()));
				}
			}
		}

		let mut title_match = None;
		for element in windows {
			let title = copy_string(&element, "AXTitle").unwrap_or_default();
			if title != win.title {
				continue;
			}
			if bounds(&element).is_some_and(|bounds| bounds_matches_window(bounds, win)) {
				set_timeout(&element)?;
				return Ok(AxHandle::Mac(element));
			}
			if title_match.is_some() {
				title_match = None;
				break;
			}
			title_match = Some(element);
		}
		let element = title_match.ok_or_else(|| {
			DesktopError::ax_failed(format!(
				"accessibility window for native window {} ('{}') was not found",
				win.id, win.title,
			))
		})?;
		set_timeout(&element)?;
		Ok(AxHandle::Mac(element))
	}
}

pub(super) fn prepare_foreground_input(window: &DesktopWindow) -> CoreResult<()> {
	let mut backend = MacAx::new();
	let root = MacAx::window_element(window)?;
	let element = mac_handle(&root)?;
	for attribute in ["AXMain", "AXFocused"] {
		let attribute = CFString::from_str(attribute);

		let _ = unsafe { element.set_attribute_value(&attribute, CFBoolean::new(true)) };
	}
	backend.perform(&root, "AXRaise")
}

impl AxBackend for MacAx {
	fn window_root(&mut self, win: &DesktopWindow) -> CoreResult<AxHandle> {
		let root = Self::window_element(win)?;
		let element = mac_handle(&root)?;
		if let Some(pid) = win.pid.and_then(|pid| i32::try_from(pid).ok())
			&& let Some(process) = process_identity(pid)
			&& !self.read_processes.contains(&process)
		{
			let family = web_family(pid);
			let app = create_application(pid)?;
			await_web_content(
				family,
				|| wait_for_web_content(element),
				|| {
					let _ = unsafe {
						app.set_attribute_value(
							&CFString::from_static_str("AXManualAccessibility"),
							CFBoolean::new(true),
						)
					};
				},
			);
			self.read_processes.insert(process);
		}
		Ok(root)
	}

	fn props(&mut self, h: &AxHandle) -> CoreResult<AxProps> {
		let element = mac_handle(h)?;
		let values = NodeValues::read(element, NodeRead::Props);
		let mut count: CFIndex = 0;
		// SAFETY: `count` is writable and the retained element outlives the
		// query.
		let counted = unsafe {
			element.attribute_value_count(
				&CFString::from_static_str("AXChildren"),
				NonNull::from(&mut count),
			)
		};
		let child_count = if counted == AXError::Success {
			usize::try_from(count).unwrap_or(0)
		} else {
			0
		};
		element_props(element, &values, child_count, WalkBounds::Read)
	}

	fn walk_node(
		&mut self,
		h: &AxHandle,
		read_bounds: WalkBounds,
	) -> CoreResult<(AxProps, Vec<AxHandle>)> {
		let element = mac_handle(h)?;
		let read = match read_bounds {
			WalkBounds::Read => NodeRead::WalkWithBounds,
			WalkBounds::Skip => NodeRead::Walk,
		};
		let values = NodeValues::read(element, read);
		let children = values
			.get(CHILDREN)
			.ok()
			.flatten()
			.and_then(element_array)
			.unwrap_or_default();
		let props = element_props(element, &values, children.len(), read_bounds)?;
		Ok((props, children.into_iter().map(AxHandle::Mac).collect()))
	}

	fn children(&mut self, h: &AxHandle) -> CoreResult<Vec<AxHandle>> {
		Ok(copy_held_attribute(mac_handle(h)?, "AXChildren")?
			.and_then(element_array)
			.unwrap_or_default()
			.into_iter()
			.map(AxHandle::Mac)
			.collect())
	}

	fn parent(&mut self, h: &AxHandle) -> CoreResult<Option<AxHandle>> {
		Ok(copy_held_attribute(mac_handle(h)?, "AXParent")?
			.and_then(|value| value.downcast::<AXUIElement>().ok())
			.map(AxHandle::Mac))
	}

	fn perform(&mut self, h: &AxHandle, action: &str) -> CoreResult<()> {
		let element = mac_handle(h)?;
		let native = action_name(action);
		let actions = copy_strings_from_action_names(element)?;
		if !actions.contains(&native) {
			return Err(unsupported_action(&native, &actions));
		}
		let scroll = scrolls_before_press(&native, &actions, || is_uikit(element));
		if scroll {
			let _ = perform_action(element, "AXScrollToVisible");
		}
		perform_action(element, &native)
	}

	fn set_value(&mut self, h: &AxHandle, value: &str) -> CoreResult<()> {
		let element = mac_handle(h)?;
		let role = copy_held_attribute(element, "AXRole")?
			.and_then(|value| value.downcast::<CFString>().ok());
		if role.is_some_and(|role| role.to_string() == "AXPopUpButton") {
			return popup::choose(element, value);
		}
		if let Some(current) = copy_date(element, "AXValue") {
			return set_date_value(element, value, current);
		}
		let attribute = CFString::from_str("AXValue");
		let text = CFString::from_str(value);
		let error = unsafe { element.set_attribute_value(&attribute, &text) };
		ax_result(error, "AXValue is not settable; no typing fallback was attempted")?;
		verify_text_readback(value, copy_string(element, "AXValue").as_deref())
	}

	fn focus(&mut self, h: &AxHandle) -> CoreResult<()> {
		let element = mac_handle(h)?;
		let attribute = CFString::from_str("AXFocused");

		let error = unsafe { element.set_attribute_value(&attribute, CFBoolean::new(true)) };
		ax_result(error, "setting AXFocused=true failed")
	}

	fn element_at(&mut self, x: f64, y: f64) -> CoreResult<Option<AxHandle>> {
		ensure_trusted()?;
		if !x.is_finite()
			|| !y.is_finite()
			|| x < f64::from(f32::MIN)
			|| x > f64::from(f32::MAX)
			|| y < f64::from(f32::MIN)
			|| y > f64::from(f32::MAX)
		{
			return Err(DesktopError::ax_failed(format!(
				"AX hit-test point ({x}, {y}) is outside the platform range"
			)));
		}
		let system = create_system_wide();
		set_timeout(&system)?;
		let mut output: *const AXUIElement = ptr::null();
		let slot = NonNull::from(&mut output);

		let error = unsafe { system.copy_element_at_position(x as f32, y as f32, slot) };
		if error == AXError::NoValue {
			return Ok(None);
		}
		ax_result(error, format!("AX hit-test at ({x}, {y}) failed"))?;
		retained_element(output).map(|element| Some(AxHandle::Mac(element)))
	}

	fn focused_element(&mut self) -> CoreResult<Option<AxHandle>> {
		ensure_trusted()?;
		let system = create_system_wide();
		set_timeout(&system)?;
		Ok(copy_element(&system, "AXFocusedUIElement").map(AxHandle::Mac))
	}

	fn attributes(&mut self, h: &AxHandle) -> CoreResult<Vec<(String, String)>> {
		let element = mac_handle(h)?;
		let names = copy_attribute_names(element)?;
		let mut result = Vec::with_capacity(names.len());
		for name in names {
			let Some(name) = name
				.downcast::<CFString>()
				.ok()
				.map(|name| name.to_string())
			else {
				continue;
			};
			let value = copy_attribute(element, &name)
				.map_or_else(|| "<no value>".to_string(), |value| stringify_value(&value));
			result.push((name, truncate_chars(value, 200)));
		}
		Ok(result)
	}
}

fn element_props(
	element: &AXUIElement,
	values: &NodeValues,
	child_count: usize,
	read_bounds: WalkBounds,
) -> CoreResult<AxProps> {
	let native_role = required_string(values.get(ROLE), "AXRole")?;
	let actions = copy_strings_from_action_names(element).unwrap_or_default();
	let read = |index| values.get(index).ok().flatten();
	let string = |index| {
		read(index)
			.and_then(|value| value.downcast::<CFString>().ok())
			.map(|value| value.to_string())
	};
	let boolean = |index| {
		read(index)
			.and_then(|value| value.downcast::<CFBoolean>().ok())
			.map(|value| value.as_bool())
	};
	let title = nonempty(string(TITLE));
	let description = nonempty(string(DESCRIPTION))
		.or_else(|| nonempty(string(PLACEHOLDER)).filter(|_| title.is_none()));
	Ok(AxProps {
		role: normalize_role_macos(&native_role),
		native_role,
		title,
		value: nonempty(read(VALUE).map(|value| stringify_value(&value))),
		description,
		enabled: boolean(ENABLED).unwrap_or(true),
		focused: boolean(FOCUSED).unwrap_or(false),
		bounds: match read_bounds {
			WalkBounds::Read => read(POSITION)
				.zip(read(SIZE))
				.and_then(|(position, size)| frame(&position, &size)),
			WalkBounds::Skip => None,
		},
		actions,
		child_count: u32::try_from(child_count).unwrap_or(u32::MAX),
	})
}

fn ensure_trusted() -> CoreResult<()> {
	if is_trusted() {
		Ok(())
	} else {
		Err(super::permission::denied("Accessibility"))
	}
}

fn create_application(pid: libc::pid_t) -> CoreResult<CFRetained<AXUIElement>> {
	let raw = unsafe { AXUIElementCreateApplication(pid) };
	let pointer = NonNull::new(raw).ok_or_else(|| {
		DesktopError::ax_failed(format!("AXUIElementCreateApplication({pid}) returned null"))
	})?;

	Ok(unsafe { CFRetained::from_raw(pointer) })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum WebFamily {
	Other,
	Chromium,
	Electron,
}

fn web_family(pid: libc::pid_t) -> WebFamily {
	use objc2_app_kit::NSRunningApplication;
	use objc2_foundation::NSBundle;
	let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) else {
		return WebFamily::Other;
	};
	let bundle = app
		.bundleURL()
		.and_then(|url| NSBundle::bundleWithURL(&url));
	if bundle
		.and_then(|bundle| bundle.privateFrameworksPath())
		.is_some_and(|path| {
			std::path::Path::new(&path.to_string())
				.join("Electron Framework.framework")
				.exists()
		}) {
		return WebFamily::Electron;
	}
	let id = app
		.bundleIdentifier()
		.map(|id| id.to_string())
		.unwrap_or_default();
	let chromium = [
		"com.google.Chrome",
		"com.google.chrome.for.testing",
		"org.chromium.Chromium",
		"com.brave.Browser",
		"com.microsoft.edgemac",
		"com.operasoftware.Opera",
		"com.vivaldi.Vivaldi",
		"company.thebrowser.Browser",
	]
	.iter()
	.any(|prefix| {
		id == *prefix
			|| id
				.strip_prefix(prefix)
				.is_some_and(|rest| rest.starts_with('.'))
	});
	if chromium {
		WebFamily::Chromium
	} else {
		WebFamily::Other
	}
}

fn process_identity(pid: libc::pid_t) -> Option<(libc::pid_t, u64, u64)> {
	let mut info: libc::proc_bsdinfo = unsafe { mem::zeroed() };
	let size = libc::c_int::try_from(mem::size_of::<libc::proc_bsdinfo>()).ok()?;
	let written =
		unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&raw mut info).cast(), size) };
	(written == size).then_some((pid, info.pbi_start_tvsec, info.pbi_start_tvusec))
}

fn await_web_content(family: WebFamily, mut wait: impl FnMut() -> bool, enable: impl FnOnce()) {
	if family == WebFamily::Other || wait() {
		return;
	}
	if family == WebFamily::Electron {
		enable();
		wait();
	}
}

fn wait_for_web_content(window: &AXUIElement) -> bool {
	use objc2_core_foundation::Type;
	let deadline = Instant::now() + Duration::from_secs(1);
	loop {
		let mut queue = VecDeque::from([(window.retain(), 0)]);
		let mut visited = 0;
		while let Some((element, depth)) = queue.pop_front() {
			let left = deadline.saturating_duration_since(Instant::now());
			visited += 1;
			if left < Duration::from_millis(10) || visited > 400 {
				break;
			}
			let _ = unsafe { element.set_messaging_timeout(left.as_secs_f32()) };
			let children = copy_elements_optional(&element, "AXChildren").unwrap_or_default();
			let web =
				!children.is_empty() && copy_string(&element, "AXRole").as_deref() == Some("AXWebArea");
			let _ = set_timeout(&element);
			if web {
				return true;
			}
			if depth < 16 {
				queue.extend(children.into_iter().map(|child| (child, depth + 1)));
			}
		}
		let left = deadline.saturating_duration_since(Instant::now());
		if left.is_zero() {
			return false;
		}
		thread::sleep(Duration::from_millis(20).min(left));
	}
}

fn create_system_wide() -> CFRetained<AXUIElement> {
	unsafe { AXUIElement::new_system_wide() }
}

fn set_timeout(element: &AXUIElement) -> CoreResult<()> {
	let error = unsafe { element.set_messaging_timeout(AX_TIMEOUT_SECONDS) };
	ax_result(error, "AXUIElementSetMessagingTimeout(2.0) failed")
}

fn copy_attribute_result(
	element: &AXUIElement,
	attribute: &str,
) -> Result<Option<CFRetained<CFType>>, AXError> {
	let attribute = CFString::from_str(attribute);
	let mut output: *const CFType = ptr::null();
	let slot = NonNull::from(&mut output);

	let error = unsafe { element.copy_attribute_value(&attribute, slot) };
	if error != AXError::Success {
		return Err(error);
	}
	let Some(pointer) = NonNull::new(output.cast_mut()) else {
		return Ok(None);
	};

	Ok(Some(unsafe { CFRetained::from_raw(pointer) }))
}

fn copy_attribute(element: &AXUIElement, attribute: &str) -> Option<CFRetained<CFType>> {
	copy_attribute_result(element, attribute).ok().flatten()
}

fn copy_string(element: &AXUIElement, attribute: &str) -> Option<String> {
	let value = copy_attribute(element, attribute)?;
	if let Ok(value) = value.downcast::<CFString>() {
		Some(value.to_string())
	} else {
		None
	}
}
fn required_string(
	value: Result<Option<CFRetained<CFType>>, AXError>,
	attribute: &str,
) -> CoreResult<String> {
	value
		.map_err(|error| ax_error(error, format!("copying {attribute} failed")))?
		.ok_or_else(|| DesktopError::ax_failed(format!("copying {attribute} returned no value")))?
		.downcast::<CFString>()
		.map(|value| value.to_string())
		.map_err(|_| DesktopError::ax_failed(format!("{attribute} was not a string")))
}

fn copy_held_attribute(
	element: &AXUIElement,
	attribute: &str,
) -> CoreResult<Option<CFRetained<CFType>>> {
	match copy_attribute_result(element, attribute) {
		Err(AXError::InvalidUIElement) => Err(element_gone()),
		result => Ok(result.ok().flatten()),
	}
}

fn copy_bool(element: &AXUIElement, attribute: &str) -> Option<bool> {
	copy_attribute(element, attribute)?
		.downcast::<CFBoolean>()
		.ok()
		.map(|value| value.as_bool())
}

fn copy_element(element: &AXUIElement, attribute: &str) -> Option<CFRetained<AXUIElement>> {
	copy_attribute(element, attribute)?
		.downcast::<AXUIElement>()
		.ok()
}

fn copy_elements(
	element: &AXUIElement,
	attribute: &str,
) -> CoreResult<Vec<CFRetained<AXUIElement>>> {
	copy_elements_optional(element, attribute)
		.ok_or_else(|| DesktopError::ax_failed(format!("copying {attribute} failed")))
}

fn copy_elements_optional(
	element: &AXUIElement,
	attribute: &str,
) -> Option<Vec<CFRetained<AXUIElement>>> {
	element_array(copy_attribute(element, attribute)?)
}

fn element_array(value: CFRetained<CFType>) -> Option<Vec<CFRetained<AXUIElement>>> {
	let array = value.downcast::<CFArray>().ok()?;
	let array = unsafe { CFRetained::cast_unchecked::<CFArray<CFType>>(array) };
	Some(
		array
			.iter()
			.filter_map(|value| value.downcast::<AXUIElement>().ok())
			.collect(),
	)
}

fn copy_attribute_names(element: &AXUIElement) -> CoreResult<Vec<CFRetained<CFType>>> {
	let mut output: *const CFArray = ptr::null();
	let slot = NonNull::from(&mut output);

	let error = unsafe { element.copy_attribute_names(slot) };
	ax_result(error, "AXUIElementCopyAttributeNames failed")?;
	let pointer = NonNull::new(output.cast_mut())
		.ok_or_else(|| DesktopError::ax_failed("AX attribute names returned null"))?;

	let array: CFRetained<CFArray> = unsafe { CFRetained::from_raw(pointer) };

	let array = unsafe { CFRetained::cast_unchecked::<CFArray<CFType>>(array) };
	Ok(array.iter().collect())
}

fn copy_strings_from_action_names(element: &AXUIElement) -> CoreResult<Vec<String>> {
	let mut output: *const CFArray = ptr::null();
	let slot = NonNull::from(&mut output);

	ax_result(unsafe { element.copy_action_names(slot) }, "reading AX action names failed")?;
	let Some(pointer) = NonNull::new(output.cast_mut()) else {
		return Ok(Vec::new());
	};

	let array: CFRetained<CFArray> = unsafe { CFRetained::from_raw(pointer) };

	let array = unsafe { CFRetained::cast_unchecked::<CFArray<CFType>>(array) };
	Ok(array
		.iter()
		.filter_map(|value| {
			value
				.downcast::<CFString>()
				.ok()
				.map(|value| value.to_string())
		})
		.collect())
}

fn bounds(element: &AXUIElement) -> Option<AxBounds> {
	let position = copy_attribute(element, "AXPosition")?;
	let size = copy_attribute(element, "AXSize")?;
	frame(&position, &size)
}

fn frame(position: &CFType, size: &CFType) -> Option<AxBounds> {
	let position = position.downcast_ref::<AXValue>()?;
	let size = size.downcast_ref::<AXValue>()?;
	let mut point = CGPoint { x: 0.0, y: 0.0 };
	let mut dimensions = CGSize { width: 0.0, height: 0.0 };

	let got_point =
		unsafe { position.value(AXValueType::CGPoint, NonNull::from(&mut point).cast()) };

	let got_size = unsafe { size.value(AXValueType::CGSize, NonNull::from(&mut dimensions).cast()) };
	if !got_point || !got_size {
		return None;
	}
	Some(AxBounds {
		x:      point.x,
		y:      point.y,
		width:  dimensions.width,
		height: dimensions.height,
	})
}

fn retained_element(pointer: *const AXUIElement) -> CoreResult<CFRetained<AXUIElement>> {
	let pointer = NonNull::new(pointer.cast_mut())
		.ok_or_else(|| DesktopError::ax_failed("AX operation returned a null element"))?;

	Ok(unsafe { CFRetained::from_raw(pointer) })
}

#[allow(clippy::unnecessary_wraps, reason = "uniform handle-access call contract")]
fn mac_handle(handle: &AxHandle) -> CoreResult<&AXUIElement> {
	match handle {
		AxHandle::Mac(element) => Ok(element),
	}
}

fn bounds_matches_window(bounds: AxBounds, window: &DesktopWindow) -> bool {
	(bounds.x - f64::from(window.x)).abs() <= 2.0
		&& (bounds.y - f64::from(window.y)).abs() <= 2.0
		&& (bounds.width - f64::from(window.width)).abs() <= 2.0
		&& (bounds.height - f64::from(window.height)).abs() <= 2.0
}

fn action_name(action: &str) -> String {
	match action.trim().to_ascii_lowercase().as_str() {
		"press" => "AXPress".to_string(),
		"raise" => "AXRaise".to_string(),
		"showmenu" | "show_menu" => "AXShowMenu".to_string(),
		_ if action.starts_with("AX") => action.to_string(),
		_ => format!("AX{action}"),
	}
}

fn stringify_value(value: &CFType) -> String {
	if let Some(string) = value.downcast_ref::<CFString>() {
		return string.to_string();
	}
	if let Some(boolean) = value.downcast_ref::<CFBoolean>() {
		return boolean.as_bool().to_string();
	}
	if let Some(number) = value.downcast_ref::<CFNumber>() {
		return stringify_number(number);
	}
	if let Some(element) = value.downcast_ref::<AXUIElement>() {
		return nonempty(copy_string(element, "AXTitle"))
			.or_else(|| nonempty(copy_string(element, "AXDescription")))
			.unwrap_or_default();
	}
	if let Some(url) = value.downcast_ref::<CFURL>() {
		return url.string().to_string();
	}
	format!("{value:?}")
}

fn stringify_number(number: &CFNumber) -> String {
	let text = if !number.is_float_type() {
		number.as_i64().map(|value| value.to_string())
	} else if number.byte_size() <= 4 {
		number.as_f32().map(|value| value.to_string())
	} else {
		number.as_f64().map(|value| value.to_string())
	};
	text.unwrap_or_default()
}

fn nonempty(value: Option<String>) -> Option<String> {
	value.filter(|value| !value.is_empty())
}

fn truncate_chars(value: String, max: usize) -> String {
	if value.chars().count() <= max {
		return value;
	}
	let mut result: String = value.chars().take(max.saturating_sub(1)).collect();
	result.push('…');
	result
}

fn ax_result(error: AXError, context: impl Into<String>) -> CoreResult<()> {
	if error == AXError::Success {
		Ok(())
	} else {
		Err(ax_error(error, context))
	}
}

fn ax_error(error: AXError, context: impl Into<String>) -> DesktopError {
	if error == AXError::InvalidUIElement {
		element_gone()
	} else {
		DesktopError::ax_failed(format!("{} ({error:?})", context.into()))
	}
}

fn element_gone() -> DesktopError {
	DesktopError::stale_ref("the element no longer exists; re-run ax()/find()")
}

fn set_date_value(element: &AXUIElement, text: &str, current: f64) -> CoreResult<()> {
	// CF caches the system zone per process; the target app follows changes to
	// it.
	CFTimeZone::reset_system();
	let zone = CFTimeZone::system()
		.ok_or_else(|| DesktopError::ax_failed("the system time zone is unavailable"))?;
	let offset_at = |at: f64| zone.seconds_from_gmt(at) as i64;
	let Some(request) = super::date::parse(text) else {
		return Err(DesktopError::ax_failed(format!(
			"AXValue is a date and {text:?} is not ISO-8601: write {}; it reads {} now; nothing was \
			 written",
			super::date::ACCEPTED_FORMS,
			super::date::format_local(current, offset_at),
		)));
	};
	let target = request
		.absolute_time(current, offset_at)
		.map_err(|reason| DesktopError::ax_failed(format!("{reason}; nothing was written")))?;
	let value = CFDate::new(None, target)
		.ok_or_else(|| DesktopError::ax_failed("creating the CFDate to write failed"))?;
	let attribute = CFString::from_str("AXValue");
	{
		// SAFETY: The element, attribute and date remain retained for the setter.
		let error = unsafe { element.set_attribute_value(&attribute, &value) };
		ax_result(error, "setting AXValue to a date failed")?;
		match copy_date(element, "AXValue") {
			Some(actual) if (actual - target).abs() < 1e-3 => Ok(()),
			actual => Err(DesktopError::ax_failed(format!(
				"AX accepted the date write but the control reads {} instead of {}",
				actual
					.map_or_else(|| "no date".to_owned(), |at| super::date::format_local(at, offset_at)),
				super::date::format_local(target, offset_at),
			))),
		}
	}
}

/// Never quote text in errors: secure fields and unreadable subroles must not
/// disclose either the requested text or the app's read-back value.
fn verify_text_readback(expected: &str, actual: Option<&str>) -> CoreResult<()> {
	if actual == Some(expected) {
		return Ok(());
	}
	Err(DesktopError::ax_failed(
		"AX accepted the text write but its complete value could not be confirmed; the app may have \
		 reformatted it or not taken it. Inspect the target before writing again; no typing \
		 fallback was attempted",
	))
}

fn copy_date(element: &AXUIElement, attribute: &str) -> Option<f64> {
	Some(
		copy_attribute(element, attribute)?
			.downcast::<CFDate>()
			.ok()?
			.absolute_time(),
	)
}

fn perform_action(element: &AXUIElement, action: &str) -> CoreResult<()> {
	let name = CFString::from_str(action);
	let error = unsafe { element.perform_action(&name) };
	element_action_result(action, error)
}

fn element_action_result(action: &str, error: AXError) -> CoreResult<()> {
	if error == AXError::CannotComplete {
		return Err(DesktopError::ax_unconfirmed(format!(
			"AX action '{action}' was requested but its outcome could not be confirmed: the app did \
			 not reply in time ({error:?}). It may already have taken effect; observe the window \
			 before retrying"
		)));
	}
	ax_result(error, format!("AX action '{action}' failed"))
}

fn unsupported_action(native: &str, actions: &[String]) -> DesktopError {
	let instead = if native == "AXPress" {
		"; nothing was sent: if this is the control you meant, click() it instead"
	} else {
		""
	};
	DesktopError::ax_failed(format!(
		"AX action '{native}' is not supported by this element; available actions: {}{instead}",
		actions.join(", ")
	))
}

fn scrolls_before_press(native: &str, actions: &[String], uikit: impl FnOnce() -> bool) -> bool {
	native == "AXPress" && actions.iter().any(|action| action == "AXScrollToVisible") && uikit()
}

fn is_uikit(element: &AXUIElement) -> bool {
	use objc2_app_kit::NSRunningApplication;
	use objc2_foundation::{NSBundle, ns_string};
	let mut pid = 0;
	if unsafe { element.pid(NonNull::from(&mut pid)) } != AXError::Success {
		return false;
	}
	NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
		.and_then(|app| app.bundleURL())
		.and_then(|url| NSBundle::bundleWithURL(&url))
		.is_some_and(|bundle| {
			bundle
				.objectForInfoDictionaryKey(ns_string!("UIDeviceFamily"))
				.is_some()
		})
}

mod popup {
	use std::{
		thread,
		time::{Duration, Instant},
	};

	use objc2_application_services::AXUIElement;
	use objc2_core_foundation::CFRetained;

	use super::{
		CoreResult, DesktopError, copy_bool, copy_elements_optional, copy_string,
		copy_strings_from_action_names, perform_action,
	};

	/// How long a popup has to publish its menu items after the open action.
	const MENU_OPEN_WAIT: Duration = Duration::from_millis(1000);
	/// How long a pressed option has to show up as the popup's value.
	const CHOICE_SETTLE_WAIT: Duration = Duration::from_millis(1000);
	/// How long a cancelled menu has to leave the popup's children.
	const MENU_CLOSE_WAIT: Duration = Duration::from_millis(300);
	/// How long a pressed option's menu has to close: one that refuses
	/// `AXCancel` flashes the item and fades out for about 340 ms.
	const PRESSED_MENU_CLOSE_WAIT: Duration = Duration::from_millis(1000);
	const POLL_INTERVAL: Duration = Duration::from_millis(25);

	/// Chooses the option of `popup` titled exactly `value` and confirms it by
	/// reading the popup's `AXValue` back. A menu this call opened is closed
	/// again whenever no choice is made.
	pub(super) fn choose(popup: &AXUIElement, value: &str) -> CoreResult<()> {
		// Already showing `value`: the read-back verdict holds without opening
		// the menu.
		if copy_string(popup, "AXValue").as_deref() == Some(value) {
			return Ok(());
		}
		if copy_bool(popup, "AXEnabled") == Some(false) {
			return Err(DesktopError::ax_failed("popup button is disabled; nothing was selected"));
		}
		let mut items = menu_items(popup);
		let opened = items.is_empty();
		if opened {
			items = open_menu(popup)?;
		}
		let titles: Vec<String> = items
			.iter()
			.map(|item| copy_string(item, "AXTitle").unwrap_or_default())
			.collect();
		let result = choose_option(&titles, value)
			.map_err(|refusal| DesktopError::ax_failed(refusal_message(&refusal, value, &titles)))
			.and_then(|index| press_option(popup, &items[index], value));
		match result {
			Err(error) if opened && !close_menu(popup) => Err(menu_left_open(error)),
			result => result,
		}
	}

	fn menu_left_open(mut error: DesktopError) -> DesktopError {
		error
			.message
			.push_str("; the menu this call opened is still open");
		error
	}

	/// Why a requested value chooses no option.
	#[derive(Debug, PartialEq, Eq)]
	enum Refusal {
		/// No option is titled exactly the value.
		Missing,
		/// Several options share the title, so the value cannot say which.
		Ambiguous,
	}

	/// The index of the option titled exactly `requested`. Matching is exact:
	/// options are the app's own strings, the refusal lists them, and two titles
	/// differing only in case or spacing are distinct options. Untitled items
	/// are menu separators, not options.
	fn choose_option(titles: &[String], requested: &str) -> Result<usize, Refusal> {
		let mut matches = titles
			.iter()
			.enumerate()
			.filter(|(_, title)| !title.is_empty() && *title == requested)
			.map(|(index, _)| index);
		match (matches.next(), matches.next()) {
			(Some(index), None) => Ok(index),
			(Some(_), Some(_)) => Err(Refusal::Ambiguous),
			(None, _) => Err(Refusal::Missing),
		}
	}

	fn refusal_message(refusal: &Refusal, requested: &str, titles: &[String]) -> String {
		let options = option_list(titles);
		match refusal {
			Refusal::Missing => format!(
				"no popup option is titled exactly \"{requested}\"; nothing was selected. Options: \
				 {options}"
			),
			Refusal::Ambiguous => format!(
				"several popup options are titled \"{requested}\", so the value cannot say which; \
				 nothing was selected. Options: {options}"
			),
		}
	}

	/// The titled options, quoted, in menu order.
	fn option_list(titles: &[String]) -> String {
		titles
			.iter()
			.filter(|title| !title.is_empty())
			.map(|title| format!("\"{title}\""))
			.collect::<Vec<_>>()
			.join(", ")
	}

	/// The popup's options: the items of its open `AXMenu`, plus any options it
	/// publishes as direct children.
	fn menu_items(popup: &AXUIElement) -> Vec<CFRetained<AXUIElement>> {
		let mut items = Vec::new();
		for child in copy_elements_optional(popup, "AXChildren").unwrap_or_default() {
			match copy_string(&child, "AXRole").as_deref() {
				Some("AXMenu") => {
					items.extend(copy_elements_optional(&child, "AXChildren").unwrap_or_default());
				},
				Some("AXMenuItem") => items.push(child),
				_ => {},
			}
		}
		items
	}

	fn open_menu_element(popup: &AXUIElement) -> Option<CFRetained<AXUIElement>> {
		copy_elements_optional(popup, "AXChildren")?
			.into_iter()
			.find(|child| copy_string(child, "AXRole").as_deref() == Some("AXMenu"))
	}

	/// Opens a closed popup's menu with the control's own action and returns its
	/// items once `AppKit` has built them. `AXPress` is what a click does;
	/// `AXShowMenu` is the fallback for popups the first leaves without options.
	fn open_menu(popup: &AXUIElement) -> CoreResult<Vec<CFRetained<AXUIElement>>> {
		let actions = copy_strings_from_action_names(popup)?;
		let mut attempts = Vec::new();
		let mut left_open = false;
		for action in ["AXPress", "AXShowMenu"] {
			if !actions.iter().any(|name| name == action) {
				continue;
			}
			// The probes before can block; an app the user used meanwhile is left
			// to them ([`control::intervention::check_press`]).
			if let Err(error) = perform_action(popup, action) {
				attempts.push(error.message);
				continue;
			}
			let published = poll(MENU_OPEN_WAIT, || {
				let items = menu_items(popup);
				(!items.is_empty()).then_some(items)
			});
			if let Some(items) = published {
				return Ok(items);
			}
			attempts.push(format!(
				"{action} published no options within {} ms",
				MENU_OPEN_WAIT.as_millis()
			));
			// Close an empty menu so the next action opens it instead of toggling
			// it shut; a menu that stays open ends the attempts.
			if !close_menu(popup) {
				left_open = true;
				break;
			}
		}
		if attempts.is_empty() {
			return Err(DesktopError::ax_failed(format!(
				"popup button advertises neither AXPress nor AXShowMenu (actions: {}); nothing was \
				 selected",
				actions.join(", ")
			)));
		}
		let error = DesktopError::ax_failed(format!(
			"popup menu published no options ({}); nothing was selected",
			attempts.join("; ")
		));
		Err(if left_open {
			menu_left_open(error)
		} else {
			error
		})
	}

	/// Presses the chosen item, ends its menu at once, and waits for the popup
	/// to report the choice. The popup's value, not the press's return code,
	/// says whether the app took the choice.
	fn press_option(popup: &AXUIElement, item: &AXUIElement, title: &str) -> CoreResult<()> {
		if copy_bool(item, "AXEnabled") == Some(false) {
			return Err(DesktopError::ax_failed(format!(
				"popup option \"{title}\" is disabled; nothing was selected"
			)));
		}
		settle_choice(
			title,
			(PRESSED_MENU_CLOSE_WAIT, CHOICE_SETTLE_WAIT),
			|| perform_action(item, "AXPress"),
			|| {
				if let Some(menu) = open_menu_element(popup) {
					let _ = perform_action(&menu, "AXCancel");
				}
			},
			|| open_menu_element(popup).is_some(),
			|| copy_string(popup, "AXValue"),
		)
	}

	/// Runs `press` on the option titled `title`, then `cancel`s its menu and
	/// waits up to `closing` for the menu to be gone (`menu_open`), then up to
	/// `taking` for the popup's `value` to read `title`. A pressed item flashes
	/// and its menu fades out for about 340 ms, and until the menu is gone
	/// `WindowServer` sends the user's keys to the target, which types them into
	/// its own key window once it closes; `AXCancel` right behind the press ends
	/// the menu within a few milliseconds, and `AppKit` still sends the item's
	/// action. A menu that refuses the cancel closes after its fade, and the
	/// choice is not reported until it has: one still open then fails.
	fn settle_choice(
		title: &str,
		(closing, taking): (Duration, Duration),
		press: impl FnOnce() -> CoreResult<()>,
		cancel: impl FnOnce(),
		mut menu_open: impl FnMut() -> bool,
		mut value: impl FnMut() -> Option<String>,
	) -> CoreResult<()> {
		press()?;
		cancel();
		if poll(closing, || (!menu_open()).then_some(())).is_none() {
			return Err(DesktopError::ax_failed(format!(
				"pressed popup option \"{title}\" but its menu did not close, and an open menu keeps \
				 the keyboard from the user's app; inspect the popup before retrying"
			)));
		}
		let mut after = None;
		let taken = poll(taking, || {
			after = value();
			(after.as_deref() == Some(title)).then_some(())
		});
		if taken.is_some() {
			return Ok(());
		}
		Err(DesktopError::ax_failed(match after {
			Some(after) => format!(
				"pressed popup option \"{title}\" but the popup still reads \"{after}\"; the app did \
				 not take the choice"
			),
			None => format!(
				"pressed popup option \"{title}\" but the popup publishes no readable value, so the \
				 choice could not be confirmed"
			),
		}))
	}

	/// Cancels the popup's open menu. `true` once no menu is open.
	fn close_menu(popup: &AXUIElement) -> bool {
		let Some(menu) = open_menu_element(popup) else {
			return true;
		};
		if perform_action(&menu, "AXCancel").is_err() {
			return false;
		}
		poll(MENU_CLOSE_WAIT, || open_menu_element(popup).is_none().then_some(())).is_some()
	}

	/// Runs `probe` every `POLL_INTERVAL` until it yields a value or `wait` has
	/// elapsed; the last probe runs at or after the deadline.
	pub(super) fn poll<T>(wait: Duration, mut probe: impl FnMut() -> Option<T>) -> Option<T> {
		let deadline = Instant::now() + wait;
		loop {
			if let Some(value) = probe() {
				return Some(value);
			}
			if Instant::now() >= deadline {
				return None;
			}
			thread::sleep(POLL_INTERVAL);
		}
	}

	#[cfg(test)]
	mod tests {
		use std::{cell::RefCell, time::Duration};

		use super::{Refusal, choose_option, option_list, settle_choice};

		fn titles(names: &[&str]) -> Vec<String> {
			names.iter().map(ToString::to_string).collect()
		}

		#[test]
		fn the_exactly_titled_option_is_chosen_at_its_menu_position() {
			let menu = titles(&["Rich Text Document", "", "Web Page (.html)", "OpenDocument Text"]);
			assert_eq!(choose_option(&menu, "Web Page (.html)"), Ok(2));
		}

		#[test]
		fn a_case_or_spacing_near_miss_chooses_nothing() {
			let menu = titles(&["JPEG", "jpeg ", "PNG"]);
			assert_eq!(choose_option(&menu, "jpeg"), Err(Refusal::Missing));
			assert_eq!(choose_option(&menu, " PNG"), Err(Refusal::Missing));
		}

		#[test]
		fn a_shared_title_is_ambiguous() {
			let menu = titles(&["Custom…", "None", "Custom…"]);
			assert_eq!(choose_option(&menu, "Custom…"), Err(Refusal::Ambiguous));
		}

		#[test]
		fn separators_are_neither_chosen_nor_listed() {
			let menu = titles(&["Small", "", "Large"]);
			assert_eq!(choose_option(&menu, ""), Err(Refusal::Missing));
			assert_eq!(option_list(&menu), "\"Small\", \"Large\"");
		}

		#[test]
		fn a_pressed_option_ends_its_menu_before_the_choice_is_read() {
			let log = RefCell::new(Vec::new());
			let open = std::cell::Cell::new(true);
			let chosen = settle_choice(
				"Large",
				(Duration::ZERO, Duration::ZERO),
				|| {
					log.borrow_mut().push("press");
					Ok(())
				},
				|| {
					log.borrow_mut().push("cancel");
					open.set(false);
				},
				|| open.get(),
				|| {
					log.borrow_mut().push("value");
					Some("Large".to_string())
				},
			);
			assert!(chosen.is_ok(), "{chosen:?}");
			// Read before the cancel, the menu would still be fading with the
			// keyboard.
			assert_eq!(*log.borrow(), ["press", "cancel", "value"]);
		}

		#[test]
		fn a_choice_waits_for_a_menu_that_refuses_cancel_to_fade_out() {
			// The menu ignores `AXCancel` and closes on its own after its fade:
			// the choice is reported only once it is gone.
			let reads = std::cell::Cell::new(0);
			let fading = || {
				reads.update(|v| v + 1);
				reads.get() < 4
			};
			let chosen = settle_choice(
				"Large",
				(Duration::from_secs(5), Duration::ZERO),
				|| Ok(()),
				|| {},
				fading,
				|| {
					assert_eq!(reads.get(), 4, "the choice is read once the menu is gone");
					Some("Large".to_string())
				},
			);
			assert!(chosen.is_ok(), "{chosen:?}");
			// A menu that never closes fails even though the app took the choice.
			let error = settle_choice(
				"Large",
				(Duration::ZERO, Duration::ZERO),
				|| Ok(()),
				|| {},
				|| true,
				|| Some("Large".to_string()),
			)
			.expect_err("the menu is still open");
			assert!(error.message.contains("its menu did not close"), "{}", error.message);
		}

		#[test]
		fn a_choice_the_app_did_not_take_is_reported_after_the_cancel() {
			let error = settle_choice(
				"Large",
				(Duration::ZERO, Duration::ZERO),
				|| Ok(()),
				|| {},
				|| false,
				|| Some("Small".to_string()),
			)
			.expect_err("the popup still reads Small");
			assert!(error.message.contains("still reads \"Small\""), "{}", error.message);
		}
	}
}

#[cfg(test)]
mod tests {
	use objc2_core_foundation::{Type, kCFNull};

	use super::*;
	use crate::desktop::error::ErrorCode;

	#[test]
	fn unconfirmed_text_writes_never_leak_text_or_report_success() {
		for actual in [None, Some("••••"), Some("different secret")] {
			let error = verify_text_readback("hunter2", actual).unwrap_err();
			assert_eq!(error.code, ErrorCode::AxFailed);
			assert!(!error.message.contains("hunter2"));
			assert!(!error.message.contains("different secret"));
		}
		assert!(verify_text_readback("edited", Some("edited")).is_ok());
	}

	#[test]
	fn web_content_wait_only_enables_legacy_electron_after_readiness_failure() {
		use std::cell::Cell;
		for (family, appears, waits, writes) in [
			(WebFamily::Other, false, 0, 0),
			(WebFamily::Chromium, false, 1, 0),
			(WebFamily::Electron, true, 1, 0),
			(WebFamily::Electron, false, 2, 1),
		] {
			let called = Cell::new(0);
			let enabled = Cell::new(0);
			await_web_content(
				family,
				|| {
					called.set(called.get() + 1);
					appears
				},
				|| enabled.set(enabled.get() + 1),
			);
			assert_eq!((called.get(), enabled.get()), (waits, writes));
		}
	}

	#[test]
	fn only_a_supported_catalyst_press_scrolls_first() {
		let actions = vec!["AXPress".to_owned(), "AXScrollToVisible".to_owned()];
		assert!(scrolls_before_press("AXPress", &actions, || true));
		assert!(!scrolls_before_press("AXPress", &actions, || false));
		assert!(!scrolls_before_press("AXShowMenu", &actions, || panic!("not a press")));
		assert!(!scrolls_before_press("AXPress", &[], || panic!("not scrollable")));
		let error = unsupported_action("AXPress", &actions[1..]);
		assert!(error.message.contains("if this is the control you meant"));
		assert!(error.message.contains("click()"));
	}

	#[test]
	fn numeric_values_preserve_stored_precision() {
		assert_eq!(stringify_value(&CFNumber::new_i64(-3)), "-3");
		assert_eq!(stringify_value(&CFNumber::new_f64(0.185)), "0.185");
		assert_eq!(stringify_value(&CFNumber::new_f32(0.185)), "0.185");
	}

	#[test]
	fn destroyed_elements_are_stale_and_unanswered_actions_are_unconfirmed() {
		assert_eq!(
			ax_result(AXError::InvalidUIElement, "read")
				.unwrap_err()
				.code,
			ErrorCode::StaleRef
		);
		assert_eq!(
			element_action_result("AXPress", AXError::CannotComplete)
				.unwrap_err()
				.code,
			ErrorCode::AxUnconfirmed
		);
		assert_eq!(
			element_action_result("AXPress", AXError::ActionUnsupported)
				.unwrap_err()
				.code,
			ErrorCode::AxFailed
		);
		assert!(element_action_result("AXPress", AXError::Success).is_ok());
	}

	#[test]
	fn batched_attribute_errors_and_nulls_decode_like_lone_reads() {
		let title = CFString::from_static_str("Save");
		let mut no_value = AXError::NoValue;
		let missing =
			unsafe { AXValue::new(AXValueType::AXError, NonNull::from(&mut no_value).cast()) }
				.unwrap();
		let null: &CFType = unsafe { kCFNull }.unwrap();
		let entries: [&CFType; 3] = [&title, &missing, null];
		let values = NodeValues::from_batch(
			Ok(CFArray::from_objects(&entries)),
			TITLE..ENABLED,
			|_| unreachable!(),
		);
		assert_eq!(required_string(values.get(TITLE), "AXTitle").unwrap(), "Save");
		assert_eq!(values.get(VALUE).unwrap_err(), AXError::NoValue);
		assert!(values.get(DESCRIPTION).unwrap().is_none());
		assert_eq!(values.get(CHILDREN).unwrap_err(), AXError::Failure);
	}

	#[test]
	fn unanswered_batch_recovers_role_without_extra_placeholder_timeouts() {
		let role = CFString::from_static_str("AXTextArea");
		let role: &CFType = &role;
		let mut asked = Vec::new();
		let values = NodeValues::from_batch(
			Err(AXError::CannotComplete),
			NodeRead::Walk.attributes(),
			|index| {
				asked.push(index);
				match index {
					ROLE => Ok(Some(role.retain())),
					VALUE => Err(AXError::CannotComplete),
					_ => Ok(None),
				}
			},
		);
		assert_eq!(required_string(values.get(ROLE), "AXRole").unwrap(), "AXTextArea");
		assert_eq!(values.get(VALUE).unwrap_err(), AXError::CannotComplete);
		assert_eq!(values.get(PLACEHOLDER).unwrap_err(), AXError::CannotComplete);
		assert!(!asked.contains(&PLACEHOLDER));
		let gone = NodeValues::from_batch(
			Err(AXError::InvalidUIElement),
			NodeRead::Walk.attributes(),
			|_| panic!("destroyed element must not be retried"),
		);
		assert_eq!(required_string(gone.get(ROLE), "AXRole").unwrap_err().code, ErrorCode::StaleRef);
	}

	#[test]
	fn unnamed_fields_use_placeholder_but_never_override_labels() {
		let role = CFString::from_static_str("AXTextField");
		let name = CFString::from_static_str("Due");
		let placeholder = CFString::from_static_str("Add Date");
		let null: &CFType = unsafe { kCFNull }.unwrap();
		let field = |title: &CFType, description: &CFType| {
			let mut entries = [null; POSITION];
			entries[ROLE] = &role;
			entries[TITLE] = title;
			entries[DESCRIPTION] = description;
			entries[PLACEHOLDER] = &placeholder;
			let values = NodeValues::from_batch(
				Ok(CFArray::from_objects(&entries)),
				NodeRead::Walk.attributes(),
				|_| unreachable!(),
			);
			element_props(&create_system_wide(), &values, 0, WalkBounds::Skip).unwrap()
		};
		assert_eq!(field(null, null).description.as_deref(), Some("Add Date"));
		assert_eq!(field(null, &name).description.as_deref(), Some("Due"));
		assert_eq!(field(&name, null).description, None);
	}
}
