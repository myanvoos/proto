use std::{
	thread,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use core_graphics::{
	event::{
		CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, EventField,
		ScrollEventUnit,
	},
	event_source::{CGEventSource, CGEventSourceStateID},
	geometry::CGPoint,
	sys::CGEventSourceRef,
};
use foreign_types::ForeignType;

use super::{
	super::{
		backend::{DeliveryMode, Modifiers, MouseButton, PointerEvent},
		error::{CoreResult, DesktopError},
		keys::KeyName,
		types::{DesktopWindow, Target},
	},
	ax,
	capture::MacCapture,
	skylight,
};

pub(super) struct MacInput {
	source: CGEventSource,
}
#[allow(
	clippy::non_send_fields_in_send_ty,
	reason = "CGEventSource is an immutable CF object; `&mut self` receivers serialize all posting"
)]
unsafe impl Send for MacInput {}

impl MacInput {
	pub(super) fn new() -> CoreResult<Self> {
		Ok(Self { source: source()? })
	}

	#[allow(
		clippy::needless_pass_by_ref_mut,
		reason = "`&mut self` exclusivity backs the `Send` safety argument for the CF event source"
	)]
	pub(super) fn pointer(
		&mut self,
		target: &Target,
		event: PointerEvent,
		mode: DeliveryMode,
		capture: &MacCapture,
	) -> CoreResult<()> {
		match target {
			Target::Desktop => global_pointer(&self.source, event),
			Target::Window(id) => {
				let entry_front = skylight::front_pid();
				let window = capture.window(id)?;
				let (pid, wid) = window_identity(&window)?;
				match mode {
					DeliveryMode::Background => {
						refuse_context_gesture(&window, &event)?;
						background_guard(&window, pointer_kind(&event), pointer_button(&event))?;
						let focus = BackgroundTarget { pid, wid, entry_front };
						make_key_in_background(&self.source, &window, focus)?;
						background_pointer(&self.source, pid, wid, &window, event, focus)
					},
					DeliveryMode::Foreground => skylight::with_foreground(pid, wid, || match event {
						PointerEvent::Scroll { x, y, dx, dy } => {
							global_scroll(&self.source, x, y, dx, dy, primer_side(&window, x), || {
								skylight::require_front_window(pid, wid)
							})
						},
						event => global_pointer(&self.source, event),
					}),
				}
			},
		}
	}

	#[allow(
		clippy::needless_pass_by_ref_mut,
		reason = "`&mut self` exclusivity backs the `Send` safety argument for the CF event source"
	)]
	pub(super) fn type_text(
		&mut self,
		target: &Target,
		text: &str,
		mode: DeliveryMode,
		capture: &MacCapture,
	) -> CoreResult<()> {
		if text.is_empty() {
			return Ok(());
		}
		match target {
			Target::Desktop => global_type(&self.source, text),
			Target::Window(id) => {
				let entry_front = skylight::front_pid();
				let window = capture.window(id)?;
				let (pid, wid) = window_identity(&window)?;
				match mode {
					DeliveryMode::Background => {
						background_guard(&window, "keyboard", None)?;
						let focus = BackgroundTarget { pid, wid, entry_front };
						prepare_background_keys(&self.source, &window, focus, capture)?;
						background_type(&self.source, pid, text, || focus.require_keys(&window))
					},
					DeliveryMode::Foreground => skylight::with_foreground(pid, wid, || {
						ax::prepare_foreground_input(&window)?;
						let mut sent = false;
						type_text(&self.source, text, |event, down| {
							post_foreground_key(event, down, pid, wid, &mut sent)
						})
					}),
				}
			},
		}
	}

	#[allow(
		clippy::needless_pass_by_ref_mut,
		reason = "`&mut self` exclusivity backs the `Send` safety argument for the CF event source"
	)]
	pub(super) fn key_chord(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		mode: DeliveryMode,
		capture: &MacCapture,
	) -> CoreResult<()> {
		for &key in keys {
			key_code(key)?;
		}
		match target {
			Target::Desktop => global_chord(&self.source, keys),
			Target::Window(id) => {
				let entry_front = skylight::front_pid();
				let window = capture.window(id)?;
				let (pid, wid) = window_identity(&window)?;
				match mode {
					DeliveryMode::Background => {
						background_guard(&window, "keyboard", None)?;
						let focus = BackgroundTarget { pid, wid, entry_front };
						prepare_background_keys(&self.source, &window, focus, capture)?;
						background_chord(&self.source, pid, keys, || focus.require_keys(&window))
					},
					DeliveryMode::Foreground => skylight::with_foreground(pid, wid, || {
						ax::prepare_foreground_input(&window)?;
						let mut sent = false;
						key_chord(&self.source, keys, |event, down| {
							post_foreground_key(event, down, pid, wid, &mut sent)
						})
					}),
				}
			},
		}
	}
}

fn window_identity(window: &DesktopWindow) -> CoreResult<(libc::pid_t, u32)> {
	let pid = window.pid.ok_or_else(|| {
		DesktopError::input_failed(format!("window {} has no owning process id", window.id))
	})?;
	let pid = i32::try_from(pid).map_err(|_| {
		DesktopError::input_failed(format!("window {} has an invalid process id", window.id))
	})?;
	let wid = window.id.parse::<u32>().map_err(|_| {
		DesktopError::invalid_target(format!("invalid macOS window id '{}'", window.id))
	})?;
	Ok((pid, wid))
}

#[derive(Clone, Copy)]
struct BackgroundTarget {
	pid:         libc::pid_t,
	wid:         u32,
	entry_front: Option<libc::pid_t>,
}

impl BackgroundTarget {
	fn require(self, window: &DesktopWindow) -> CoreResult<()> {
		require_background_focus(self.entry_front, skylight::front_pid(), self.pid, self.wid, || {
			ax::focused_window_id(self.pid)
		})
		.map_err(|reason| {
			DesktopError::background_unavailable(format!(
				"window {} ({}): {reason}; no further input was sent",
				window.id, window.app,
			))
		})
	}

	fn require_keys(self, window: &DesktopWindow) -> CoreResult<()> {
		self.require(window)?;
		if ax::focused_window_id(self.pid) != Some(self.wid) {
			return Err(DesktopError::background_unavailable(format!(
				"window {} ({}) is not its application's confirmed key window; no further keys were \
				 sent",
				window.id, window.app,
			)));
		}
		Ok(())
	}
}

fn require_background_focus(
	entry_front: Option<libc::pid_t>,
	front: Option<libc::pid_t>,
	pid: libc::pid_t,
	wid: u32,
	focused: impl FnOnce() -> Option<u32>,
) -> Result<(), &'static str> {
	match (entry_front, front) {
		(None, _) | (_, None) => Err("the front application is unknown"),
		(Some(entry), Some(front)) if front == pid && entry != pid => {
			Err("the background application came to the front after input began")
		},
		(_, Some(front)) if front == pid && focused() != Some(wid) => {
			Err("the target is not the front application's key window")
		},
		_ => Ok(()),
	}
}

fn make_key_in_background(
	source: &CGEventSource,
	window: &DesktopWindow,
	focus: BackgroundTarget,
) -> CoreResult<()> {
	focus.require(window)?;
	// Re-keying an already focused window closes inline editors and popovers.
	let already_key = ax::focused_window_id(focus.pid) == Some(focus.wid);
	if skylight::front_pid() == Some(focus.pid) {
		return Ok(());
	}
	let event = CGEvent::new(source.clone())
		.map_err(|()| DesktopError::input_failed("failed to create a Quartz activation event"))?;
	// AppKit-defined application-activated event, absent from CGEventType.
	unsafe { set_event_type(event.as_ptr().cast(), 13) };
	event.set_flags(CGEventFlags::from_bits_retain(0xc0000));
	focus.require(window)?;
	skylight::activate_application(focus.pid, focus.wid, &event)?;
	if already_key {
		thread::sleep(Duration::from_millis(50));
		return focus.require(window);
	}
	let group = click_group_id();
	let press = |kind| {
		post_mouse(
			focus.pid,
			focus.wid,
			window,
			source.clone(),
			kind,
			CGMouseButton::Left,
			f64::from(window.x) - 1.0,
			f64::from(window.y) - 1.0,
			1,
			1,
			0,
			group,
			CGEventFlags::CGEventFlagNull,
		)
	};
	focus.require(window)?;
	let result = press(CGEventType::LeftMouseDown);
	let released = press(CGEventType::LeftMouseUp);
	result.and(released)?;
	thread::sleep(Duration::from_millis(50));
	focus.require(window)
}

fn prepare_background_keys(
	source: &CGEventSource,
	window: &DesktopWindow,
	focus: BackgroundTarget,
	capture: &MacCapture,
) -> CoreResult<()> {
	let wid = focus.wid;
	focus.require(window)?;
	let siblings = capture
		.windows()?
		.into_iter()
		.filter(|candidate| candidate.pid == window.pid)
		.count();
	if siblings > 1 {
		return Err(DesktopError::background_unavailable(format!(
			"window {wid} is one of {siblings} windows in its application; macOS delivers background \
			 keystrokes to whichever window the application treats as key, so retry with \
			 delivery:\"foreground\" or use ax actions",
		)));
	}

	make_key_in_background(source, window, focus)?;
	focus.require_keys(window)
}

const fn pointer_kind(event: &PointerEvent) -> &'static str {
	match event {
		PointerEvent::Click { .. } => "click",
		PointerEvent::Move { .. } => "pointer move",
		PointerEvent::Drag { .. } => "drag",
		PointerEvent::Scroll { .. } => "scroll",
	}
}

const fn pointer_button(event: &PointerEvent) -> Option<MouseButton> {
	match event {
		PointerEvent::Click { button, .. } | PointerEvent::Drag { button, .. } => Some(*button),
		PointerEvent::Move { .. } | PointerEvent::Scroll { .. } => None,
	}
}

fn background_guard(
	window: &DesktopWindow,
	kind: &str,
	button: Option<MouseButton>,
) -> CoreResult<()> {
	let app = window.app.to_ascii_lowercase();
	let chromium = ["chrome", "chromium", "electron", "brave", "edge", "arc"]
		.iter()
		.any(|name| app.contains(name));
	if chromium && button == Some(MouseButton::Right) {
		return Err(DesktopError::background_unavailable(format!(
			"window {} ({}) coerces synthetic background right-click events to left-clicks; retry \
			 with delivery:\"foreground\" or use ax actions",
			window.id, window.app,
		)));
	}
	let canvas_or_game = ["blender", "unity", "godot", "unreal", "ghost"]
		.iter()
		.any(|name| app.contains(name));
	if canvas_or_game {
		return Err(DesktopError::background_unavailable(format!(
			"window {} ({}) drops background {kind} events in its canvas/game input stack; retry \
			 with delivery:\"foreground\" or use ax actions",
			window.id, window.app,
		)));
	}
	Ok(())
}

fn refuse_context_gesture(window: &DesktopWindow, event: &PointerEvent) -> CoreResult<()> {
	let opens_context = |button, modifiers: Modifiers| {
		button == MouseButton::Right || (button == MouseButton::Left && modifiers.ctrl)
	};
	let refuse = match event {
		PointerEvent::Click { button, count, modifiers, .. } => {
			*count > 1 && opens_context(*button, *modifiers)
		},
		PointerEvent::Drag { button, modifiers, .. } => opens_context(*button, *modifiers),
		_ => false,
	};
	if refuse {
		Err(DesktopError::background_unavailable(format!(
			"window {} ({}): this background gesture can hold a context menu open and take the \
			 user's keyboard; no input was sent",
			window.id, window.app,
		)))
	} else {
		Ok(())
	}
}

const LOCAL_EVENT_FILTER: u32 = 0x01 | 0x02 | 0x04;
const SUPPRESSION_INTERVAL: u32 = 0;
const REMOTE_MOUSE_DRAG: u32 = 1;

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
	#[link_name = "CGEventSetType"]
	fn set_event_type(event: *mut std::ffi::c_void, kind: u32);
	#[link_name = "CGEventSourceSetLocalEventsSuppressionInterval"]
	fn set_local_events_suppression_interval(source: CGEventSourceRef, seconds: f64);
	#[link_name = "CGEventSourceSetLocalEventsFilterDuringSuppressionState"]
	fn set_local_events_filter_during_suppression_state(
		source: CGEventSourceRef,
		filter: u32,
		state: u32,
	);

}

fn source() -> CoreResult<CGEventSource> {
	let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
		.map_err(|()| DesktopError::input_failed("failed to create a Quartz input event source"))?;

	unsafe {
		set_local_events_suppression_interval(source.as_ptr(), 0.0);
		set_local_events_filter_during_suppression_state(
			source.as_ptr(),
			LOCAL_EVENT_FILTER,
			SUPPRESSION_INTERVAL,
		);
		set_local_events_filter_during_suppression_state(
			source.as_ptr(),
			LOCAL_EVENT_FILTER,
			REMOTE_MOUSE_DRAG,
		);
	}
	Ok(source)
}

fn modifier_flags(modifiers: Modifiers) -> CGEventFlags {
	let mut flags = CGEventFlags::CGEventFlagNull;
	if modifiers.ctrl {
		flags |= CGEventFlags::CGEventFlagControl;
	}
	if modifiers.alt {
		flags |= CGEventFlags::CGEventFlagAlternate;
	}
	if modifiers.shift {
		flags |= CGEventFlags::CGEventFlagShift;
	}
	if modifiers.meta {
		flags |= CGEventFlags::CGEventFlagCommand;
	}
	flags
}

const fn button_types(
	button: MouseButton,
) -> (CGMouseButton, CGEventType, CGEventType, CGEventType, i64) {
	match button {
		MouseButton::Left => (
			CGMouseButton::Left,
			CGEventType::LeftMouseDown,
			CGEventType::LeftMouseUp,
			CGEventType::LeftMouseDragged,
			0,
		),
		MouseButton::Right => (
			CGMouseButton::Right,
			CGEventType::RightMouseDown,
			CGEventType::RightMouseUp,
			CGEventType::RightMouseDragged,
			1,
		),
		MouseButton::Middle => (
			CGMouseButton::Center,
			CGEventType::OtherMouseDown,
			CGEventType::OtherMouseUp,
			CGEventType::OtherMouseDragged,
			2,
		),
	}
}

fn background_pointer(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	event: PointerEvent,
	focus: BackgroundTarget,
) -> CoreResult<()> {
	focus.require(window)?;
	match event {
		PointerEvent::Click { x, y, button, count, modifiers } => {
			background_click(source, pid, wid, window, x, y, button, count, modifiers, focus)
		},
		PointerEvent::Move { x, y } => {
			let group = click_group_id();
			post_mouse(
				pid,
				wid,
				window,
				source.clone(),
				CGEventType::MouseMoved,
				CGMouseButton::Left,
				x,
				y,
				2,
				0,
				0,
				group,
				CGEventFlags::CGEventFlagNull,
			)
		},
		PointerEvent::Drag { path, button, modifiers } => {
			background_drag(source, pid, wid, window, &path, button, modifiers, focus)
		},
		PointerEvent::Scroll { x, y, dx, dy } => {
			background_scroll(source, pid, wid, window, x, y, dx, dy, focus)
		},
	}
}

fn background_click(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	x: f64,
	y: f64,
	button: MouseButton,
	count: u32,
	modifiers: Modifiers,
	focus: BackgroundTarget,
) -> CoreResult<()> {
	let group = click_group_id();
	let (cg_button, down, up, _, number) = button_types(button);
	let flags = modifier_flags(modifiers);
	pointer_prologue(pid, wid, window, source, x, y, group, flags)?;
	for click_state in 1..=count.max(1) {
		focus
			.require(window)
			.map_err(|error| sent_error(error, click_state > 1))?;
		post_mouse(
			pid,
			wid,
			window,
			source.clone(),
			down,
			cg_button,
			x,
			y,
			3,
			i64::from(click_state),
			number,
			group,
			flags,
		)?;
		thread::sleep(Duration::from_millis(1));
		post_mouse(
			pid,
			wid,
			window,
			source.clone(),
			up,
			cg_button,
			x,
			y,
			3,
			i64::from(click_state),
			number,
			group,
			flags,
		)?;
		if click_state < count.max(1) {
			thread::sleep(Duration::from_millis(80));
		}
	}
	Ok(())
}

fn pointer_prologue(
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	source: &CGEventSource,
	x: f64,
	y: f64,
	group: i64,
	flags: CGEventFlags,
) -> CoreResult<()> {
	post_mouse(
		pid,
		wid,
		window,
		source.clone(),
		CGEventType::MouseMoved,
		CGMouseButton::Left,
		x,
		y,
		2,
		0,
		0,
		group,
		flags,
	)?;
	thread::sleep(Duration::from_millis(15));
	Ok(())
}

fn background_drag(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	path: &[(f64, f64)],
	button: MouseButton,
	modifiers: Modifiers,
	focus: BackgroundTarget,
) -> CoreResult<()> {
	let Some(&(start_x, start_y)) = path.first() else {
		return Err(DesktopError::input_failed("drag path must contain at least two points"));
	};
	if path.len() < 2 {
		return Err(DesktopError::input_failed("drag path must contain at least two points"));
	}
	let group = click_group_id();
	let (cg_button, down, up, dragged, number) = button_types(button);
	let flags = modifier_flags(modifiers);
	pointer_prologue(pid, wid, window, source, start_x, start_y, group, flags)?;
	focus.require(window)?;
	let mut location = (start_x, start_y);
	let result = (|| {
		post_mouse(
			pid,
			wid,
			window,
			source.clone(),
			down,
			cg_button,
			start_x,
			start_y,
			3,
			1,
			number,
			group,
			flags,
		)?;
		for &(x, y) in &path[1..] {
			thread::sleep(Duration::from_millis(16));
			focus
				.require(window)
				.map_err(|error| sent_error(error, true))?;
			post_mouse(
				pid,
				wid,
				window,
				source.clone(),
				dragged,
				cg_button,
				x,
				y,
				3,
				1,
				number,
				group,
				flags,
			)?;
			location = (x, y);
		}
		thread::sleep(Duration::from_millis(50));
		Ok(())
	})();
	let released = post_mouse(
		pid,
		wid,
		window,
		source.clone(),
		up,
		cg_button,
		location.0,
		location.1,
		3,
		1,
		number,
		group,
		flags,
	);
	result.and(released)
}

#[allow(
	clippy::too_many_arguments,
	reason = "the parameters are the native CGEvent fields stamped together"
)]
fn post_mouse(
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	source: CGEventSource,
	event_type: CGEventType,
	button: CGMouseButton,
	x: f64,
	y: f64,
	phase: i64,
	click_state: i64,
	button_number: i64,
	click_group: i64,
	flags: CGEventFlags,
) -> CoreResult<()> {
	let event = CGEvent::new_mouse_event(source, event_type, CGPoint::new(x, y), button)
		.map_err(|()| DesktopError::input_failed("failed to create a Quartz pointer event"))?;

	event.set_flags(flags);
	let local = CGPoint::new(x - f64::from(window.x), y - f64::from(window.y));
	skylight::stamp_event(&event, pid, wid, local, phase, click_state, button_number, click_group)?;
	skylight::post_dual(pid, &event)
}

fn background_scroll(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	x: f64,
	y: f64,
	dx: f64,
	dy: f64,
	focus: BackgroundTarget,
) -> CoreResult<()> {
	let group = click_group_id();
	post_mouse(
		pid,
		wid,
		window,
		source.clone(),
		CGEventType::MouseMoved,
		CGMouseButton::Left,
		x,
		y,
		2,
		0,
		0,
		group,
		CGEventFlags::CGEventFlagNull,
	)?;
	thread::sleep(Duration::from_millis(15));
	let wheel_x = finite_i32(dx, "horizontal scroll delta")?;
	let wheel_y = finite_i32(dy, "vertical scroll delta")?;
	let event =
		CGEvent::new_scroll_event(source.clone(), ScrollEventUnit::PIXEL, 2, wheel_y, wheel_x, 0)
			.map_err(|()| DesktopError::input_failed("failed to create a Quartz scroll event"))?;
	event.set_location(CGPoint::new(x, y));
	skylight::stamp_event(
		&event,
		pid,
		wid,
		CGPoint::new(x - f64::from(window.x), y - f64::from(window.y)),
		3,
		0,
		0,
		group,
	)?;
	focus.require(window)?;
	skylight::post_dual(pid, &event)
}

fn click_group_id() -> i64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.subsec_nanos()
		.into()
}

fn sent_error(error: DesktopError, sent: bool) -> DesktopError {
	if sent {
		DesktopError::input_failed(format!(
			"{}; input was already partially sent; inspect before retrying",
			error.message,
		))
	} else {
		error
	}
}

fn post_foreground_key(
	event: &CGEvent,
	down: bool,
	pid: libc::pid_t,
	wid: u32,
	sent: &mut bool,
) -> CoreResult<()> {
	if down {
		skylight::require_front_window(pid, wid).map_err(|error| sent_error(error, *sent))?;
	}
	post_global(event)?;
	*sent |= down;
	Ok(())
}

fn background_type(
	source: &CGEventSource,
	pid: libc::pid_t,
	text: &str,
	mut before_press: impl FnMut() -> CoreResult<()>,
) -> CoreResult<()> {
	let mut sent = false;
	type_text(source, text, |event, down| {
		if down {
			before_press().map_err(|error| sent_error(error, sent))?;
		}
		skylight::post_keyboard(pid, event)?;
		sent |= down;
		Ok(())
	})
}

fn global_type(source: &CGEventSource, text: &str) -> CoreResult<()> {
	type_text(source, text, |event, _| post_global(event))
}

fn type_text(
	source: &CGEventSource,
	text: &str,
	mut post: impl FnMut(&CGEvent, bool) -> CoreResult<()>,
) -> CoreResult<()> {
	for character in text.chars() {
		let value = character.to_string();
		let transition = |down, post: &mut dyn FnMut(&CGEvent, bool) -> CoreResult<()>| {
			let event = CGEvent::new_keyboard_event(source.clone(), 0, down)
				.map_err(|()| DesktopError::input_failed("failed to create a Quartz keyboard event"))?;
			event.set_string(&value);
			event.set_flags(CGEventFlags::CGEventFlagNull);
			post(&event, down)
		};
		let result = transition(true, &mut post);
		thread::sleep(Duration::from_millis(8));
		let released = transition(false, &mut post);
		result.and(released)?;
		thread::sleep(Duration::from_millis(8));
	}
	Ok(())
}

fn background_chord(
	source: &CGEventSource,
	pid: libc::pid_t,
	keys: &[KeyName],
	mut before_press: impl FnMut() -> CoreResult<()>,
) -> CoreResult<()> {
	let mut sent = false;
	key_chord(source, keys, |event, down| {
		if down {
			before_press().map_err(|error| sent_error(error, sent))?;
		}
		skylight::post_keyboard(pid, event)?;
		sent |= down;
		Ok(())
	})
}

fn global_chord(source: &CGEventSource, keys: &[KeyName]) -> CoreResult<()> {
	key_chord(source, keys, |event, _| post_global(event))
}

fn key_chord(
	source: &CGEventSource,
	keys: &[KeyName],
	mut post: impl FnMut(&CGEvent, bool) -> CoreResult<()>,
) -> CoreResult<()> {
	if keys.is_empty() {
		return Err(DesktopError::invalid_key("key chord must not be empty"));
	}
	// Reject an unpressable later key before leaving any earlier modifier held.
	for &key in keys {
		key_code(key)?;
	}
	let mut active = Modifiers::default();
	let mut pressed = 0;
	let mut first_error = None;
	for &key in keys {
		update_modifier(&mut active, key, true);
		pressed += 1;
		if let Err(error) = post_key(source, key, true, modifier_flags(active), &mut post) {
			first_error = Some(error);
			break;
		}
		thread::sleep(Duration::from_millis(8));
	}
	for &key in keys[..pressed].iter().rev() {
		update_modifier(&mut active, key, false);
		if let Err(error) = post_key(source, key, false, modifier_flags(active), &mut post)
			&& first_error.is_none()
		{
			first_error = Some(error);
		}
		thread::sleep(Duration::from_millis(8));
	}
	first_error.map_or(Ok(()), Err)
}

fn post_key(
	source: &CGEventSource,
	key: KeyName,
	down: bool,
	flags: CGEventFlags,
	post: &mut impl FnMut(&CGEvent, bool) -> CoreResult<()>,
) -> CoreResult<()> {
	let code = key_code(key)?;
	let event = CGEvent::new_keyboard_event(source.clone(), code, down)
		.map_err(|()| DesktopError::input_failed("failed to create a Quartz keyboard event"))?;
	event.set_flags(flags);
	post(&event, down)
}

const fn update_modifier(modifiers: &mut Modifiers, key: KeyName, down: bool) {
	match key {
		KeyName::Ctrl => modifiers.ctrl = down,
		KeyName::Alt => modifiers.alt = down,
		KeyName::Shift => modifiers.shift = down,
		KeyName::Meta => modifiers.meta = down,
		_ => {},
	}
}

fn key_code(key: KeyName) -> CoreResult<u16> {
	let code = match key {
		KeyName::Ctrl => 59,
		KeyName::Alt => 58,
		KeyName::Shift => 56,
		KeyName::Meta => 55,
		KeyName::Enter => 36,
		KeyName::Escape => 53,
		KeyName::Tab => 48,
		KeyName::Space => 49,
		KeyName::Backspace => 51,
		KeyName::Delete => 117,
		KeyName::Insert => 114,
		KeyName::Home => 115,
		KeyName::End => 119,
		KeyName::PageUp => 116,
		KeyName::PageDown => 121,
		KeyName::Up => 126,
		KeyName::Down => 125,
		KeyName::Left => 123,
		KeyName::Right => 124,
		KeyName::CapsLock => 57,
		KeyName::NumLock => 71,
		KeyName::PrintScreen => 105,
		KeyName::F1 => 122,
		KeyName::F2 => 120,
		KeyName::F3 => 99,
		KeyName::F4 => 118,
		KeyName::F5 => 96,
		KeyName::F6 => 97,
		KeyName::F7 => 98,
		KeyName::F8 => 100,
		KeyName::F9 => 101,
		KeyName::F10 => 109,
		KeyName::F11 => 103,
		KeyName::F12 => 111,
		KeyName::F13 => 105,
		KeyName::F14 => 107,
		KeyName::F15 => 113,
		KeyName::F16 => 106,
		KeyName::F17 => 64,
		KeyName::F18 => 79,
		KeyName::F19 => 80,
		KeyName::F20 => 90,
		KeyName::F21 => 110,
		KeyName::F22 => 111,
		KeyName::F23 => 112,
		KeyName::F24 => 113,
		KeyName::Char(character) => char_key_code(character)?,
	};
	Ok(code)
}

fn char_key_code(character: char) -> CoreResult<u16> {
	let normalized = character.to_ascii_lowercase();
	let code = match normalized {
		'a' => 0,
		's' => 1,
		'd' => 2,
		'f' => 3,
		'h' => 4,
		'g' => 5,
		'z' => 6,
		'x' => 7,
		'c' => 8,
		'v' => 9,
		'b' => 11,
		'q' => 12,
		'w' => 13,
		'e' => 14,
		'r' => 15,
		'y' => 16,
		't' => 17,
		'1' => 18,
		'2' => 19,
		'3' => 20,
		'4' => 21,
		'6' => 22,
		'5' => 23,
		'=' => 24,
		'9' => 25,
		'7' => 26,
		'-' => 27,
		'8' => 28,
		'0' => 29,
		']' => 30,
		'o' => 31,
		'u' => 32,
		'[' => 33,
		'i' => 34,
		'p' => 35,
		'l' => 37,
		'j' => 38,
		'\'' => 39,
		'k' => 40,
		';' => 41,
		'\\' => 42,
		',' => 43,
		'/' => 44,
		'n' => 45,
		'm' => 46,
		'.' => 47,
		'`' => 50,
		_ => {
			return Err(DesktopError::invalid_key(format!(
				"key '{character}' has no macOS virtual keycode"
			)));
		},
	};
	Ok(code)
}

fn global_pointer(source: &CGEventSource, event: PointerEvent) -> CoreResult<()> {
	match event {
		PointerEvent::Click { x, y, button, count, modifiers } => {
			post_global_mouse(
				source,
				CGEventType::MouseMoved,
				CGMouseButton::Left,
				x,
				y,
				0,
				0,
				CGEventFlags::CGEventFlagNull,
			)?;
			let (cg_button, down, up, _, number) = button_types(button);
			let flags = modifier_flags(modifiers);
			for click_state in 1..=count.max(1) {
				post_global_mouse(
					source,
					down,
					cg_button,
					x,
					y,
					i64::from(click_state),
					number,
					flags,
				)?;
				thread::sleep(Duration::from_millis(1));
				post_global_mouse(source, up, cg_button, x, y, i64::from(click_state), number, flags)?;
				if click_state < count.max(1) {
					thread::sleep(Duration::from_millis(80));
				}
			}
			Ok(())
		},
		PointerEvent::Move { x, y } => post_global_mouse(
			source,
			CGEventType::MouseMoved,
			CGMouseButton::Left,
			x,
			y,
			0,
			0,
			CGEventFlags::CGEventFlagNull,
		),
		PointerEvent::Drag { path, button, modifiers } => {
			let Some(&(start_x, start_y)) = path.first() else {
				return Err(DesktopError::input_failed("drag path must contain at least two points"));
			};
			if path.len() < 2 {
				return Err(DesktopError::input_failed("drag path must contain at least two points"));
			}
			let (cg_button, down, up, dragged, number) = button_types(button);
			let flags = modifier_flags(modifiers);
			post_global_mouse(
				source,
				CGEventType::MouseMoved,
				CGMouseButton::Left,
				start_x,
				start_y,
				0,
				0,
				CGEventFlags::CGEventFlagNull,
			)?;
			post_global_mouse(source, down, cg_button, start_x, start_y, 1, number, flags)?;
			for &(x, y) in &path[1..] {
				thread::sleep(Duration::from_millis(16));
				post_global_mouse(source, dragged, cg_button, x, y, 1, number, flags)?;
			}
			thread::sleep(Duration::from_millis(50));
			let &(end_x, end_y) = path
				.last()
				.ok_or_else(|| DesktopError::input_failed("drag path is empty"))?;
			post_global_mouse(source, up, cg_button, end_x, end_y, 1, number, flags)
		},
		PointerEvent::Scroll { x, y, dx, dy } => global_scroll(source, x, y, dx, dy, -1.0, || Ok(())),
	}
}

const MAX_WHEEL_STEP: u32 = 30;
const MAX_WHEEL_EVENTS: u32 = 40;
const PRIMER_OFFSETS: [f64; 3] = [2.0, 1.0, 0.0];

fn primer_side(window: &DesktopWindow, x: f64) -> f64 {
	if x < f64::from(window.x) + f64::from(window.width) / 2.0 {
		1.0
	} else {
		-1.0
	}
}

fn global_scroll(
	source: &CGEventSource,
	x: f64,
	y: f64,
	dx: f64,
	dy: f64,
	approach: f64,
	mut before_wheel: impl FnMut() -> CoreResult<()>,
) -> CoreResult<()> {
	let location = point(x, y)?;
	let steps = wheel_steps(
		finite_i32(dx, "horizontal scroll delta")?,
		finite_i32(dy, "vertical scroll delta")?,
	);
	if steps.is_empty() {
		return Ok(());
	}
	// Pixel-forwarding surfaces need actual pointer moves since activation,
	// not only a cursor warp or a wheel stamped with a location.
	for (index, offset) in PRIMER_OFFSETS.into_iter().enumerate() {
		if index > 0 {
			thread::sleep(Duration::from_millis(20));
		}
		before_wheel()?;
		post_global_mouse(
			source,
			CGEventType::MouseMoved,
			CGMouseButton::Left,
			approach.mul_add(offset, location.x),
			location.y,
			0,
			0,
			CGEventFlags::CGEventFlagNull,
		)?;
	}
	thread::sleep(Duration::from_millis(50));
	for (index, &(wheel_x, wheel_y)) in steps.iter().enumerate() {
		if index > 0 {
			thread::sleep(Duration::from_millis(16));
		}
		before_wheel().map_err(|error| sent_error(error, index > 0))?;
		let event =
			CGEvent::new_scroll_event(source.clone(), ScrollEventUnit::PIXEL, 2, wheel_y, wheel_x, 0)
				.map_err(|()| DesktopError::input_failed("failed to create a Quartz scroll event"))?;
		event.set_location(location);
		post_global(&event)?;
	}
	Ok(())
}

/// Keep per-event deltas below remote-surface caps without losing distance.
fn wheel_steps(dx: i32, dy: i32) -> Vec<(i32, i32)> {
	let count = dx
		.unsigned_abs()
		.max(dy.unsigned_abs())
		.div_ceil(MAX_WHEEL_STEP)
		.min(MAX_WHEEL_EVENTS);
	let share =
		|total: i32, index: u32| (i64::from(total) * i64::from(index) / i64::from(count)) as i32;
	(0..count)
		.map(|index| {
			(share(dx, index + 1) - share(dx, index), share(dy, index + 1) - share(dy, index))
		})
		.collect()
}

#[allow(
	clippy::too_many_arguments,
	reason = "the parameters are the native CGEvent fields stamped together"
)]
fn post_global_mouse(
	source: &CGEventSource,
	event_type: CGEventType,
	button: CGMouseButton,
	x: f64,
	y: f64,
	click_state: i64,
	button_number: i64,
	flags: CGEventFlags,
) -> CoreResult<()> {
	let event = CGEvent::new_mouse_event(source.clone(), event_type, point(x, y)?, button)
		.map_err(|()| DesktopError::input_failed("failed to create a Quartz pointer event"))?;
	event.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, click_state);
	if button_number != 0 {
		event.set_integer_value_field(EventField::MOUSE_EVENT_BUTTON_NUMBER, button_number);
	}
	event.set_flags(flags);
	post_global(&event)
}

#[allow(
	clippy::unnecessary_wraps,
	reason = "matches the fallible `FnMut(&CGEvent) -> CoreResult<()>` post callback used by \
	          background posting"
)]
fn post_global(event: &CGEvent) -> CoreResult<()> {
	event.post(CGEventTapLocation::HID);
	Ok(())
}

fn point(x: f64, y: f64) -> CoreResult<CGPoint> {
	Ok(CGPoint::new(
		f64::from(finite_i32(x, "x coordinate")?),
		f64::from(finite_i32(y, "y coordinate")?),
	))
}

fn finite_i32(value: f64, name: &str) -> CoreResult<i32> {
	if !value.is_finite() || value < f64::from(i32::MIN) || value > f64::from(i32::MAX) {
		return Err(DesktopError::input_failed(format!(
			"{name} {value} is outside the macOS input range"
		)));
	}
	Ok(value.round() as i32)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn window() -> DesktopWindow {
		DesktopWindow {
			id:      "42".to_owned(),
			title:   String::new(),
			app:     "Test".to_owned(),
			pid:     Some(7),
			x:       100,
			y:       50,
			width:   300,
			height:  200,
			focused: false,
		}
	}

	#[test]
	fn scrolls_preserve_distance_without_exceeding_remote_wheel_caps() {
		assert_eq!(wheel_steps(0, -300), vec![(0, -30); 10]);
		assert_eq!(wheel_steps(0, 0), Vec::<(i32, i32)>::new());
		for (dx, dy, count, largest) in [
			(7, 95, 4, 30),
			(-301, 44, 11, 30),
			(0, -1201, 40, 31),
			(i32::MIN, i32::MAX, 40, 53_687_092),
		] {
			let steps = wheel_steps(dx, dy);
			assert_eq!(steps.len(), count);
			assert!(
				steps
					.iter()
					.all(|&(x, y)| x.unsigned_abs() <= largest && y.unsigned_abs() <= largest)
			);
			assert_eq!(steps.iter().map(|step| i64::from(step.0)).sum::<i64>(), i64::from(dx));
			assert_eq!(steps.iter().map(|step| i64::from(step.1)).sum::<i64>(), i64::from(dy));
		}
		let window = window();
		for x in [100.0, 101.0, 249.0, 250.0, 398.0, 399.0] {
			let start = primer_side(&window, x).mul_add(PRIMER_OFFSETS[0], x);
			assert!((100.0..400.0).contains(&start));
		}
	}

	#[test]
	fn background_input_never_rekeys_the_users_sibling_or_newly_selected_app() {
		let unread =
			|| -> Option<u32> { panic!("background focus does not need the target's key window") };
		assert!(require_background_focus(Some(9), Some(9), 7, 42, unread).is_ok());
		assert!(require_background_focus(Some(9), None, 7, 42, unread).is_err());
		assert!(require_background_focus(None, Some(9), 7, 42, unread).is_err());
		assert!(require_background_focus(Some(9), Some(7), 7, 42, unread).is_err());
		assert!(require_background_focus(Some(7), Some(7), 7, 42, || Some(43)).is_err());
		assert!(require_background_focus(Some(7), Some(7), 7, 42, || None).is_err());
		assert!(require_background_focus(Some(7), Some(7), 7, 42, || Some(42)).is_ok());
	}

	#[test]
	fn failed_chord_press_releases_attempted_modifiers_without_posting_later_keys() {
		let source = source().expect("Quartz source");
		let mut events = Vec::new();
		let result =
			key_chord(&source, &[KeyName::Ctrl, KeyName::Shift, KeyName::Enter], |event, down| {
				let code = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
				let flags = event.get_flags();
				events.push((
					code,
					down,
					flags.contains(CGEventFlags::CGEventFlagControl),
					flags.contains(CGEventFlags::CGEventFlagShift),
				));
				if code == 56 && down {
					Err(DesktopError::input_failed("partial press"))
				} else {
					Ok(())
				}
			});
		assert!(result.is_err());
		assert_eq!(events, [
			(59, true, true, false),
			(56, true, true, true),
			(56, false, true, false),
			(59, false, false, false)
		]);
	}

	#[test]
	fn unpressable_later_chord_key_sends_no_initial_modifier() {
		let source = source().expect("Quartz source");
		let error = key_chord(&source, &[KeyName::Ctrl, KeyName::Char('é')], |_, _| {
			panic!("invalid chords must be rejected before any event is posted")
		})
		.expect_err("unpressable key");
		assert_eq!(error.code, super::super::super::error::ErrorCode::InvalidKey);
	}

	#[test]
	fn empty_text_does_not_prepare_or_query_its_target() {
		let mut input = MacInput::new().expect("Quartz source");
		input
			.type_text(
				&Target::Window("not-a-window".to_owned()),
				"",
				DeliveryMode::Background,
				&MacCapture::new(super::super::super::types::DisplaySelector::All),
			)
			.expect("no-op text");
	}

	#[test]
	fn background_context_menu_gestures_refuse_before_input() {
		let click = |button, count, ctrl| PointerEvent::Click {
			x: 110.0,
			y: 60.0,
			button,
			count,
			modifiers: Modifiers { ctrl, ..Modifiers::default() },
		};
		assert!(refuse_context_gesture(&window(), &click(MouseButton::Right, 2, false)).is_err());
		assert!(refuse_context_gesture(&window(), &click(MouseButton::Left, 2, true)).is_err());
		assert!(refuse_context_gesture(&window(), &click(MouseButton::Left, 3, false)).is_ok());
		assert!(
			refuse_context_gesture(&window(), &PointerEvent::Drag {
				path:      vec![(110.0, 60.0), (120.0, 70.0)],
				button:    MouseButton::Right,
				modifiers: Modifiers::default(),
			})
			.is_err()
		);
	}
}
