use std::{
	ffi::c_void,
	mem,
	process::{Command, Stdio},
	ptr::{self, NonNull},
	sync::LazyLock,
	thread,
	time::{Duration, Instant},
};

use core_graphics::window::{
	kCGWindowListExcludeDesktopElements, kCGWindowListOptionIncludingWindow,
	kCGWindowListOptionOnScreenOnly,
};
use image::{DynamicImage, Rgba, RgbaImage, imageops::FilterType};
use objc2_app_kit::NSWorkspace;
use objc2_core_foundation::{
	CFArray, CFBoolean, CFDictionary, CFNumber, CFNumberType, CFRetained, CFString, CFType, CGRect,
};
use xcap::Monitor;

use super::super::{
	error::{CoreResult, DesktopError},
	frame::{FrameGeometry, MAX_COMPOSITE_PIXELS},
	types::{DesktopDisplay, DesktopWindow, DisplaySelector, Target},
};
const MIN_WINDOW_EDGE: u32 = 16;
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
	fn CGPreflightScreenCaptureAccess() -> bool;
	fn CGWindowListCopyWindowInfo(options: u32, relative_to_window: u32) -> *const CFArray;
	fn CGRectMakeWithDictionaryRepresentation(
		dictionary: *const CFDictionary,
		rect: *mut CGRect,
	) -> bool;
}

pub(super) fn capture_permission() -> bool {
	unsafe { CGPreflightScreenCaptureAccess() }
}

fn capture_denied() -> DesktopError {
	super::permission::denied(super::permission::screen_recording_pane())
}

type CreateDisplayInfoFn = unsafe extern "C" fn(display_id: u32) -> *const CFDictionary;

/// `CoreDisplay_DisplayCreateInfoDictionary`, resolved once per process.
static CREATE_DISPLAY_INFO: LazyLock<Option<CreateDisplayInfoFn>> = LazyLock::new(|| {
	let path = c"/System/Library/Frameworks/CoreDisplay.framework/CoreDisplay";
	// SAFETY: `path` is a static NUL-terminated framework path; the handle is
	// intentionally process-lived.
	let handle = unsafe { libc::dlopen(path.as_ptr(), libc::RTLD_LAZY) };
	if handle.is_null() {
		return None;
	}
	// SAFETY: `handle` is a live dlopen handle and the name is NUL-terminated.
	let raw = unsafe { libc::dlsym(handle, c"CoreDisplay_DisplayCreateInfoDictionary".as_ptr()) };
	if raw.is_null() {
		return None;
	}
	// SAFETY: CoreDisplay exports this symbol as
	// `CFDictionaryRef (*)(CGDirectDisplayID)`, which `CreateDisplayInfoFn`
	// spells.
	Some(unsafe { mem::transmute::<*mut c_void, CreateDisplayInfoFn>(raw) })
});

/// The product name the system records for a display, such as "Color LCD".
///
/// xcap's `Monitor::friendly_name` reads `NSScreen.localizedName` instead. The
/// first `NSScreen` call initializes `AppKit`, and `AppKit` registers an
/// unbundled process like proto as a regular application, so every session
/// that listed displays gained a Dock icon until it exited. `CoreDisplay`
/// reads the same display records without `AppKit`.
fn display_product_name(display_id: u32) -> Option<String> {
	let create = (*CREATE_DISPLAY_INFO)?;
	// SAFETY: `create` has the exported signature and accepts any display ID;
	// unknown IDs return NULL.
	let info = NonNull::new(unsafe { create(display_id) }.cast_mut())?;
	// SAFETY: A `Create` function returns a +1 reference, adopted exactly once.
	let info = unsafe { CFRetained::from_raw(info) };
	// SAFETY: The info dictionary is keyed by CFString; values are checked
	// below.
	let info = unsafe { CFRetained::cast_unchecked::<CFDictionary<CFString, CFType>>(info) };
	let names = info
		.get(&CFString::from_str("DisplayProductName"))?
		.downcast::<CFDictionary>()
		.ok()?;
	// SAFETY: `DisplayProductName` maps locale identifiers to localized names.
	let names = unsafe { CFRetained::cast_unchecked::<CFDictionary<CFString, CFString>>(names) };
	// Agents read these names; keep them in one language instead of the
	// session user's locale.
	if let Some(name) = names.get(&CFString::from_str("en_US")) {
		return Some(name.to_string());
	}
	let (_, localized) = names.to_vecs();
	localized.first().map(ToString::to_string)
}

#[derive(Debug, Clone)]
pub(super) struct MacCapture {
	selector: DisplaySelector,
}

impl MacCapture {
	pub(super) const fn new(selector: DisplaySelector) -> Self {
		Self { selector }
	}

	pub(super) fn displays(&self) -> CoreResult<Vec<DesktopDisplay>> {
		if !capture_permission() {
			return Err(capture_denied());
		}
		let monitors = Monitor::all().map_err(|error| {
			DesktopError::capture_failed(format!("Quartz monitor enumeration failed: {error}"))
		})?;
		let mut displays = Vec::with_capacity(monitors.len());
		for monitor in monitors {
			let display_id = monitor.id().map_err(metadata_error)?;
			let id = display_id.to_string();
			if matches!(&self.selector, DisplaySelector::Id(selected) if selected != &id) {
				continue;
			}
			let x = monitor.x().map_err(metadata_error)?;
			let y = monitor.y().map_err(metadata_error)?;
			let width = monitor.width().map_err(metadata_error)?;
			let height = monitor.height().map_err(metadata_error)?;
			let scale = f64::from(monitor.scale_factor().map_err(metadata_error)?);

			let name = display_product_name(display_id)
				.or_else(|| monitor.name().ok())
				.unwrap_or_else(|| format!("Display {id}"));
			displays.push(DesktopDisplay {
				id,
				name,
				x,
				y,
				width,
				height,
				scale,
				pixel_x: 0,
				pixel_y: 0,
				pixel_width: scaled_edge(width, scale),
				pixel_height: scaled_edge(height, scale),
				is_primary: monitor.is_primary().map_err(metadata_error)?,
			});
		}
		if displays.is_empty() {
			return Err(match &self.selector {
				DisplaySelector::All => {
					DesktopError::capture_failed("Quartz reported no active displays")
				},
				DisplaySelector::Id(id) => {
					DesktopError::invalid_target(format!("selected display id '{id}' is not active"))
				},
			});
		}
		displays
			.sort_by(|left, right| (left.y, left.x, &left.id).cmp(&(right.y, right.x, &right.id)));
		Ok(displays)
	}

	#[allow(clippy::unused_self, reason = "keeps discovery on the backend capture object")]
	pub(super) fn windows(&self) -> CoreResult<Vec<DesktopWindow>> {
		window_snapshot(None)
	}

	#[allow(clippy::unused_self, reason = "keeps discovery on the backend capture object")]
	pub(super) fn window(&self, id: &str) -> CoreResult<DesktopWindow> {
		let native_id = id
			.parse::<u32>()
			.map_err(|_| DesktopError::invalid_target(format!("invalid macOS window id '{id}'")))?;
		window_snapshot(Some(native_id))?
			.into_iter()
			.next()
			.ok_or_else(|| {
				DesktopError::window_not_found(format!(
					"window '{id}' was not found; it may be closed or minimized"
				))
			})
	}

	pub(super) fn capture(&self, target: &Target) -> CoreResult<(RgbaImage, FrameGeometry)> {
		match target {
			Target::Desktop => self.capture_displays(),
			Target::Window(id) => self.capture_window(id),
		}
	}

	fn capture_window(&self, id: &str) -> CoreResult<(RgbaImage, FrameGeometry)> {
		if !capture_permission() {
			return Err(capture_denied());
		}
		let window = self.window(id)?;
		let window_id = id
			.parse::<u32>()
			.map_err(|_| DesktopError::invalid_target(format!("invalid macOS window id '{id}'")))?;
		let image = run_screencapture(&[
			"-x".to_string(),
			"-o".to_string(),
			"-l".to_string(),
			window_id.to_string(),
		])?;
		if image.width() == 0 || image.height() == 0 {
			return Err(DesktopError::capture_failed(format!(
				"capture of window '{id}' returned an empty image"
			)));
		}
		let geometry = FrameGeometry::for_window(&window, image.width(), image.height());
		Ok((image, geometry))
	}

	fn capture_displays(&self) -> CoreResult<(RgbaImage, FrameGeometry)> {
		let displays = self.displays()?;
		let mut regions = Vec::with_capacity(displays.len());
		let mut render_scale = 1.0f64;
		for display in displays {
			let rect = format!("-R{},{},{},{}", display.x, display.y, display.width, display.height);
			let image = run_screencapture(&["-x".to_string(), rect])?;
			if image.width() == 0 || image.height() == 0 {
				return Err(DesktopError::capture_failed(format!(
					"capture of display '{}' returned an empty image",
					display.id
				)));
			}
			render_scale = render_scale
				.max(f64::from(image.width()) / f64::from(display.width))
				.max(f64::from(image.height()) / f64::from(display.height));
			regions.push((display, image));
		}
		let min_x = regions
			.iter()
			.map(|(display, _)| i64::from(display.x))
			.min()
			.unwrap_or(0);
		let min_y = regions
			.iter()
			.map(|(display, _)| i64::from(display.y))
			.min()
			.unwrap_or(0);
		let max_x = regions
			.iter()
			.map(|(display, _)| i64::from(display.x) + i64::from(display.width))
			.max()
			.unwrap_or(0);
		let max_y = regions
			.iter()
			.map(|(display, _)| i64::from(display.y) + i64::from(display.height))
			.max()
			.unwrap_or(0);
		let logical_width = u32::try_from(max_x - min_x)
			.map_err(|_| DesktopError::capture_failed("desktop logical width overflow"))?;
		let logical_height = u32::try_from(max_y - min_y)
			.map_err(|_| DesktopError::capture_failed("desktop logical height overflow"))?;
		let target_width = scaled_edge(logical_width, render_scale).max(1);
		let target_height = scaled_edge(logical_height, render_scale).max(1);
		if u64::from(target_width) * u64::from(target_height) > MAX_COMPOSITE_PIXELS {
			return Err(DesktopError::capture_failed(format!(
				"composite {target_width}x{target_height} exceeds the native safety limit",
			)));
		}
		if regions.len() == 1 && regions[0].1.dimensions() == (target_width, target_height) {
			let (mut display, image) = regions
				.pop()
				.ok_or_else(|| DesktopError::capture_failed("single-display capture is missing"))?;
			display.pixel_x = 0;
			display.pixel_y = 0;
			display.pixel_width = target_width;
			display.pixel_height = target_height;
			let geometry = FrameGeometry::for_displays(&[display]);
			return Ok((image, geometry));
		}
		let mut composite = RgbaImage::from_pixel(target_width, target_height, Rgba([0, 0, 0, 255]));
		let mut metadata = Vec::with_capacity(regions.len());
		for (mut display, image) in regions {
			let offset_x = u32::try_from(i64::from(display.x) - min_x)
				.map_err(|_| DesktopError::capture_failed("display x offset overflow"))?;
			let offset_y = u32::try_from(i64::from(display.y) - min_y)
				.map_err(|_| DesktopError::capture_failed("display y offset overflow"))?;
			display.pixel_x = scaled_edge(offset_x, render_scale);
			display.pixel_y = scaled_edge(offset_y, render_scale);
			display.pixel_width = scaled_edge(display.width, render_scale).max(1);
			display.pixel_height = scaled_edge(display.height, render_scale).max(1);
			let rendered =
				if image.width() == display.pixel_width && image.height() == display.pixel_height {
					image
				} else {
					image::imageops::resize(
						&image,
						display.pixel_width,
						display.pixel_height,
						FilterType::Triangle,
					)
				};
			image::imageops::replace(
				&mut composite,
				&rendered,
				i64::from(display.pixel_x),
				i64::from(display.pixel_y),
			);
			metadata.push(display);
		}
		let geometry = FrameGeometry::for_displays(&metadata);
		Ok((composite, geometry))
	}
}

type WindowDictionary = CFDictionary<CFString, CFType>;

/// Reads each window from one immutable Quartz snapshot; individual xcap
/// property getters would re-enumerate the whole desktop for every field.
/// Window metadata needs no Screen Recording permission; without it, macOS
/// leaves other applications' window titles empty and reports their sharing
/// state as none, so that state filters windows only when capture is granted.
fn window_snapshot(target: Option<u32>) -> CoreResult<Vec<DesktopWindow>> {
	let options = if target.is_some() {
		kCGWindowListOptionIncludingWindow
	} else {
		kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements
	};
	// SAFETY: Quartz returns a +1 immutable array, adopted once below.
	let snapshot =
		NonNull::new(unsafe { CGWindowListCopyWindowInfo(options, target.unwrap_or(0)) }.cast_mut())
			.ok_or_else(|| DesktopError::capture_failed("Quartz window enumeration failed"))?;
	let snapshot = unsafe { CFRetained::from_raw(snapshot) };
	// SAFETY: CoreGraphics returns an immutable array of dictionaries whose
	// documented window keys are CFStrings and whose values are CFTypes.
	let snapshot = unsafe { CFRetained::cast_unchecked::<CFArray<WindowDictionary>>(snapshot) };
	let active_pid = NSWorkspace::sharedWorkspace()
		.frontmostApplication()
		.and_then(|app| u32::try_from(app.processIdentifier()).ok());
	let capture_granted = capture_permission();
	let mut result = Vec::with_capacity(snapshot.len());
	let mut active = Vec::new();
	// SAFETY: This copy-rule snapshot remains alive and is never mutated.
	for dictionary in unsafe { snapshot.iter_unchecked() } {
		// SAFETY: The CoreGraphics key constant is process-lived.
		let sharing = window_number(dictionary, "kCGWindowSharingState");
		if capture_granted && matches!(sharing, None | Some(0)) {
			continue;
		}
		let Some((id, window)) = window_metadata(dictionary) else {
			continue;
		};
		if window.pid.is_some() && window.pid == active_pid {
			active.push(id);
		}
		result.push(window);
	}
	let focused = active_pid
		.and_then(|pid| libc::pid_t::try_from(pid).ok())
		.and_then(super::ax::focused_window_id);
	// A targeted snapshot cannot infer front-to-back ordering of sibling
	// windows when AX cannot identify the application's focused window.
	let focused = if target.is_some() {
		focused
	} else {
		key_window(&active, focused)
	};
	if let Some(focused) = focused {
		let id = focused.to_string();
		if let Some(window) = result.iter_mut().find(|window| window.id == id) {
			window.focused = true;
		}
	}
	Ok(result)
}

fn window_value<'a>(dictionary: &'a WindowDictionary, key: &str) -> Option<&'a CFType> {
	// SAFETY: All callers borrow an immutable copy-rule Quartz snapshot.
	unsafe { dictionary.get_unchecked(&CFString::from_str(key)) }
}

fn window_number(dictionary: &WindowDictionary, key: &str) -> Option<i64> {
	let number = window_value(dictionary, key)?.downcast_ref::<CFNumber>()?;
	let mut value = 0i64;
	// SAFETY: The output is writable storage for the requested signed 64-bit
	// type.
	unsafe { number.value(CFNumberType::SInt64Type, ptr::from_mut(&mut value).cast()) }
		.then_some(value)
}

fn window_string(dictionary: &WindowDictionary, key: &str) -> String {
	window_value(dictionary, key)
		.and_then(CFType::downcast_ref::<CFString>)
		.map_or_default(ToString::to_string)
}

fn window_metadata(dictionary: &WindowDictionary) -> Option<(u32, DesktopWindow)> {
	// SAFETY: The CoreGraphics key constants are process-lived. Typed
	// downcasts below reject absent or malformed window metadata.
	unsafe {
		let onscreen = window_value(dictionary, "kCGWindowIsOnscreen")?
			.downcast_ref::<CFBoolean>()?
			.value();
		if !onscreen {
			return None;
		}
		let id = u32::try_from(window_number(dictionary, "kCGWindowNumber")?).ok()?;
		let bounds = window_value(dictionary, "kCGWindowBounds")?.downcast_ref::<CFDictionary>()?;
		let mut rect = CGRect::default();
		if !CGRectMakeWithDictionaryRepresentation(bounds, &mut rect) {
			return None;
		}
		let (x, y, width, height) = logical_bounds(rect).ok()?;
		if width < MIN_WINDOW_EDGE || height < MIN_WINDOW_EDGE {
			return None;
		}
		let title = window_string(dictionary, "kCGWindowName");
		let app = window_string(dictionary, "kCGWindowOwnerName");
		if (title.is_empty() && app.is_empty())
			|| (title == "StatusIndicator" && app == "Window Server")
		{
			return None;
		}
		let pid =
			window_number(dictionary, "kCGWindowOwnerPID").and_then(|pid| u32::try_from(pid).ok());
		Some((id, DesktopWindow {
			id: id.to_string(),
			title,
			app,
			pid,
			x,
			y,
			width,
			height,
			focused: false,
		}))
	}
}

fn logical_bounds(bounds: CGRect) -> CoreResult<(i32, i32, u32, u32)> {
	let x = bounds.origin.x.round();
	let y = bounds.origin.y.round();
	let width = bounds.size.width.round();
	let height = bounds.size.height.round();
	if !x.is_finite()
		|| !y.is_finite()
		|| !width.is_finite()
		|| !height.is_finite()
		|| x < f64::from(i32::MIN)
		|| x > f64::from(i32::MAX)
		|| y < f64::from(i32::MIN)
		|| y > f64::from(i32::MAX)
		|| width < 1.0
		|| width > f64::from(u32::MAX)
		|| height < 1.0
		|| height > f64::from(u32::MAX)
	{
		return Err(DesktopError::capture_failed("native capture returned invalid logical bounds"));
	}
	Ok((x as i32, y as i32, width as u32, height as u32))
}

fn key_window(active: &[u32], ax_focused: Option<u32>) -> Option<u32> {
	match ax_focused {
		Some(id) => active.contains(&id).then_some(id),
		None => active.first().copied(),
	}
}

fn metadata_error(error: impl std::fmt::Display) -> DesktopError {
	DesktopError::capture_failed(format!("failed to read native display metadata: {error}"))
}

fn scaled_edge(value: u32, scale: f64) -> u32 {
	(f64::from(value) * scale)
		.round()
		.clamp(0.0, f64::from(u32::MAX)) as u32
}

fn run_screencapture(args: &[String]) -> CoreResult<RgbaImage> {
	let file = tempfile::Builder::new()
		.prefix("proto-computer-")
		.suffix(".png")
		.tempfile()
		.map_err(|error| {
			DesktopError::capture_failed(format!(
				"failed to create temporary screenshot file: {error}"
			))
		})?;
	let mut child = Command::new("/usr/sbin/screencapture")
		.args(args)
		.arg(file.path())
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.spawn()
		.map_err(|error| {
			DesktopError::capture_failed(format!("failed to start macOS screen capture: {error}"))
		})?;
	let deadline = Instant::now() + CAPTURE_TIMEOUT;
	let status = loop {
		match child.try_wait() {
			Ok(Some(status)) => break status,
			Ok(None) => {},
			Err(error) => {
				let _ = child.kill();
				let _ = child.wait();
				return Err(DesktopError::capture_failed(format!(
					"failed while waiting for macOS screen capture: {error}"
				)));
			},
		}
		if Instant::now() >= deadline {
			let _ = child.kill();
			let _ = child.wait();
			return Err(DesktopError::capture_failed(
				"macOS screen capture exceeded its five-second deadline",
			));
		}
		thread::sleep(Duration::from_millis(10));
	};
	if !status.success() {
		return Err(if capture_permission() {
			DesktopError::capture_failed(format!("macOS screen capture exited with {status}"))
		} else {
			DesktopError::permission_denied(
				"macOS Screen & System Audio Recording permission is not granted for this process",
			)
		});
	}
	image::open(file.path())
		.map_err(|error| {
			DesktopError::capture_failed(format!("failed to decode macOS screenshot: {error}"))
		})
		.map(DynamicImage::into_rgba8)
}

#[cfg(test)]
mod metadata_tests {
	use super::*;

	#[test]
	fn untitled_windows_keep_their_identity_and_logical_bounds() {
		let bounds = CFDictionary::<CFString, CFType>::from_slices(
			&[
				&CFString::from_str("X"),
				&CFString::from_str("Y"),
				&CFString::from_str("Width"),
				&CFString::from_str("Height"),
			],
			&[
				CFNumber::new_f64(-120.0).as_ref(),
				CFNumber::new_f64(30.0).as_ref(),
				CFNumber::new_f64(800.0).as_ref(),
				CFNumber::new_f64(600.0).as_ref(),
			],
		);
		let dictionary = CFDictionary::<CFString, CFType>::from_slices(
			&[
				&CFString::from_str("kCGWindowIsOnscreen"),
				&CFString::from_str("kCGWindowNumber"),
				&CFString::from_str("kCGWindowBounds"),
				&CFString::from_str("kCGWindowOwnerName"),
				&CFString::from_str("kCGWindowOwnerPID"),
			],
			&[
				CFBoolean::new(true).as_ref(),
				CFNumber::new_i32(42).as_ref(),
				bounds.as_ref(),
				CFString::from_str("Editor").as_ref(),
				CFNumber::new_i32(123).as_ref(),
			],
		);
		let (id, window) = window_metadata(&dictionary)
			.expect("blank titles must not hide windows without Screen Recording");
		assert_eq!(id, 42);
		assert_eq!(window.app, "Editor");
		assert_eq!(window.title, "");
		assert_eq!(window.pid, Some(123));
		assert_eq!((window.x, window.y, window.width, window.height), (-120, 30, 800, 600));
	}
}
