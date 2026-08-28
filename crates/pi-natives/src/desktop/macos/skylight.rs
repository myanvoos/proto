use std::{
	ffi::{CStr, c_void},
	mem,
	os::raw::{c_char, c_int, c_uint},
	ptr,
	sync::LazyLock,
	thread,
	time::Duration,
};

use core_graphics::{event::CGEvent, geometry::CGPoint};
use foreign_types::ForeignType;
use libc::pid_t;
use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication, NSWorkspace};

use super::super::error::{CoreResult, DesktopError};

const EVENT_RECORD_LENGTH: usize = 248;
const EVENT_RECORD_LENGTH_BYTE: u8 = 0xf8;
const EVENT_RECORD_KIND: u8 = 0x0d;
const WINDOW_ID_OFFSET: usize = 0x3c;
const FOCUS_MARKER_OFFSET: usize = 0x8a;

unsafe extern "C" {
	fn CGEventPostToPid(pid: pid_t, event: core_graphics::sys::CGEventRef);
}

#[repr(C)]
#[derive(Clone, Copy, Default, PartialEq, Eq)]
struct ProcessSerialNumber {
	high: u32,
	low:  u32,
}

type SLEventPostToPidFn = unsafe extern "C" fn(pid_t, *mut c_void);
type SLEventSetIntegerValueFieldFn = unsafe extern "C" fn(*mut c_void, u32, i64);
type SLPSPostEventRecordToFn = unsafe extern "C" fn(*const ProcessSerialNumber, *const u8) -> i32;
type SLPSGetFrontProcessFn = unsafe extern "C" fn(*mut ProcessSerialNumber) -> i32;
type CGSMainConnectionIDFn = unsafe extern "C" fn() -> u32;
type SLSGetWindowOwnerFn = unsafe extern "C" fn(u32, u32, *mut u32) -> i32;
type SLSGetConnectionPSNFn = unsafe extern "C" fn(u32, *mut ProcessSerialNumber) -> i32;
type GetProcessForPIDFn = unsafe extern "C" fn(pid_t, *mut ProcessSerialNumber) -> i32;
type CGEventSetWindowLocationFn = unsafe extern "C" fn(*mut c_void, CGPoint);
type SLPSSetFrontProcessWithOptionsFn =
	unsafe extern "C" fn(*const ProcessSerialNumber, u32, u32) -> i32;
type SLEventSetAuthenticationMessageFn = unsafe extern "C" fn(*mut c_void, *mut c_void);
type ObjcGetClassFn = unsafe extern "C" fn(*const c_char) -> *mut c_void;
type SelRegisterNameFn = unsafe extern "C" fn(*const c_char) -> *mut c_void;
type ClassRespondsToSelectorFn = unsafe extern "C" fn(*mut c_void, *mut c_void) -> bool;
type AuthenticationFactoryFn =
	unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void, c_int, c_uint) -> *mut c_void;

#[derive(Clone, Copy)]
struct PsnLookup {
	main_connection:     Option<CGSMainConnectionIDFn>,
	get_window_owner:    Option<SLSGetWindowOwnerFn>,
	get_connection_psn:  Option<SLSGetConnectionPSNFn>,
	get_process_for_pid: Option<GetProcessForPIDFn>,
}

impl PsnLookup {
	fn can_resolve(self) -> bool {
		(self.main_connection.is_some()
			&& self.get_window_owner.is_some()
			&& self.get_connection_psn.is_some())
			|| self.get_process_for_pid.is_some()
	}
}

#[derive(Clone, Copy)]
struct RequiredSpi {
	post_to_pid:         SLEventPostToPidFn,
	set_integer:         SLEventSetIntegerValueFieldFn,
	post_record:         SLPSPostEventRecordToFn,
	get_front:           SLPSGetFrontProcessFn,
	set_window_location: CGEventSetWindowLocationFn,
	psn:                 PsnLookup,
}

#[derive(Clone, Copy)]
struct ForegroundSpi {
	set_front: SLPSSetFrontProcessWithOptionsFn,
	get_front: SLPSGetFrontProcessFn,
	psn:       PsnLookup,
}

#[derive(Clone, Copy)]
struct AuthenticationSpi {
	set_message:       SLEventSetAuthenticationMessageFn,
	objc_get_class:    ObjcGetClassFn,
	sel_register_name: SelRegisterNameFn,
	class_responds:    ClassRespondsToSelectorFn,
	factory:           AuthenticationFactoryFn,
}

static REQUIRED: LazyLock<Option<RequiredSpi>> = LazyLock::new(resolve_required);
static AUTHENTICATION: LazyLock<Option<AuthenticationSpi>> = LazyLock::new(resolve_authentication);
static FOREGROUND: LazyLock<Option<ForegroundSpi>> = LazyLock::new(resolve_foreground);

pub(super) fn is_available() -> bool {
	required().is_ok()
}

fn required() -> CoreResult<&'static RequiredSpi> {
	REQUIRED.as_ref().ok_or_else(|| {
		DesktopError::background_unavailable(
			"skylight-spi-missing: required SkyLight background input symbols are unavailable; retry \
			 with delivery:\"foreground\" or use ax actions",
		)
	})
}

fn resolve_required() -> Option<RequiredSpi> {
	ensure_skylight_loaded()?;
	let psn = PsnLookup {
		main_connection:     Some(symbol(c"CGSMainConnectionID")?),
		get_window_owner:    symbol(c"SLSGetWindowOwner"),
		get_connection_psn:  symbol(c"SLSGetConnectionPSN"),
		get_process_for_pid: symbol(c"GetProcessForPID"),
	};
	if !psn.can_resolve() {
		return None;
	}
	Some(RequiredSpi {
		post_to_pid: symbol(c"SLEventPostToPid")?,
		set_integer: symbol(c"SLEventSetIntegerValueField")?,
		post_record: symbol(c"SLPSPostEventRecordTo")?,
		get_front: symbol(c"_SLPSGetFrontProcess")?,
		set_window_location: symbol(c"CGEventSetWindowLocation")?,
		psn,
	})
}

fn resolve_foreground() -> Option<ForegroundSpi> {
	ensure_skylight_loaded()?;
	let psn = PsnLookup {
		main_connection:     symbol(c"CGSMainConnectionID"),
		get_window_owner:    symbol(c"SLSGetWindowOwner"),
		get_connection_psn:  symbol(c"SLSGetConnectionPSN"),
		get_process_for_pid: symbol(c"GetProcessForPID"),
	};
	if !psn.can_resolve() {
		return None;
	}
	Some(ForegroundSpi {
		set_front: symbol(c"_SLPSSetFrontProcessWithOptions")?,
		get_front: symbol(c"_SLPSGetFrontProcess")?,
		psn,
	})
}

fn ensure_skylight_loaded() -> Option<()> {
	static LOADED: LazyLock<bool> = LazyLock::new(|| {
		let path = c"/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight";

		!unsafe { libc::dlopen(path.as_ptr(), libc::RTLD_NOW | libc::RTLD_GLOBAL) }.is_null()
	});
	if *LOADED { Some(()) } else { None }
}

fn symbol<T: Copy>(name: &CStr) -> Option<T> {
	let raw = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
	if raw.is_null() {
		return None;
	}

	Some(unsafe { mem::transmute_copy::<*mut c_void, T>(&raw) })
}

fn event_ptr(event: &CGEvent) -> *mut c_void {
	event.as_ptr().cast()
}

pub(super) fn stamp_event(
	event: &CGEvent,
	pid: pid_t,
	wid: u32,
	window_local: CGPoint,
	phase: i64,
	click_state: i64,
	button_number: i64,
	click_group: i64,
) -> CoreResult<()> {
	let spi = required()?;
	let ptr = event_ptr(event);

	unsafe {
		(spi.set_integer)(ptr, 0, phase);
		(spi.set_integer)(ptr, 1, click_state);
		(spi.set_integer)(ptr, 3, button_number);
		(spi.set_integer)(ptr, 7, 3);
		(spi.set_integer)(ptr, 40, i64::from(pid));
		(spi.set_integer)(ptr, 51, i64::from(wid));
		(spi.set_integer)(ptr, 58, click_group);
		(spi.set_integer)(ptr, 91, i64::from(wid));
		(spi.set_integer)(ptr, 92, i64::from(wid));
		(spi.set_window_location)(ptr, window_local);
	}
	Ok(())
}

pub(super) fn post_dual(pid: pid_t, event: &CGEvent) -> CoreResult<()> {
	let spi = required()?;

	unsafe { (spi.post_to_pid)(pid, event_ptr(event)) };

	unsafe { CGEventPostToPid(pid, event.as_ptr()) };
	Ok(())
}

pub(super) fn post_keyboard(pid: pid_t, event: &CGEvent) -> CoreResult<()> {
	let spi = required()?;
	attach_keyboard_authentication(pid, event);

	unsafe { (spi.post_to_pid)(pid, event_ptr(event)) };
	Ok(())
}

pub(super) fn activate_without_raise(pid: pid_t, wid: u32) -> CoreResult<()> {
	let spi = required()?;
	let mut previous = ProcessSerialNumber::default();

	if unsafe { (spi.get_front)(&mut previous) } != 0 {
		return Err(DesktopError::background_unavailable(format!(
			"window {wid} could not resolve the front process for background input; retry with \
			 delivery:\"foreground\" or use ax actions",
		)));
	}
	let target = process_psn(spi.psn, pid, wid).ok_or_else(|| {
		DesktopError::background_unavailable(format!(
			"window {wid} could not resolve its process serial number for background input; retry \
			 with delivery:\"foreground\" or use ax actions",
		))
	})?;
	let mut record = [0u8; EVENT_RECORD_LENGTH];
	record[0x04] = EVENT_RECORD_LENGTH_BYTE;
	record[0x08] = EVENT_RECORD_KIND;
	record[WINDOW_ID_OFFSET..WINDOW_ID_OFFSET + 4].copy_from_slice(&wid.to_le_bytes());
	record[FOCUS_MARKER_OFFSET] = 0x02;

	let defocused = unsafe { (spi.post_record)(&previous, record.as_ptr()) } == 0;
	record[FOCUS_MARKER_OFFSET] = 0x01;

	let focused = unsafe { (spi.post_record)(&target, record.as_ptr()) } == 0;
	if !defocused || !focused {
		return Err(DesktopError::background_unavailable(format!(
			"window {wid} rejected the 248-byte SkyLight focus-without-raise record; retry with \
			 delivery:\"foreground\" or use ax actions",
		)));
	}
	thread::sleep(Duration::from_millis(50));
	Ok(())
}

pub(super) fn with_foreground<T>(
	pid: pid_t,
	wid: u32,
	action: impl FnOnce() -> CoreResult<T>,
) -> CoreResult<T> {
	let Some(spi) = FOREGROUND.as_ref() else {
		return with_public_foreground(pid, action);
	};
	let mut previous = ProcessSerialNumber::default();

	let previous_known = unsafe { (spi.get_front)(&mut previous) } == 0;
	let Some(target) = process_psn(spi.psn, pid, wid) else {
		return with_public_foreground(pid, action);
	};

	if unsafe { (spi.set_front)(&target, wid, 0x400) } != 0 {
		return with_public_foreground(pid, action);
	}
	thread::sleep(Duration::from_millis(40));
	let result = action();
	thread::sleep(Duration::from_millis(40));
	if previous_known {
		unsafe { (spi.set_front)(&previous, 0, 0x400) };
	}
	result
}

fn with_public_foreground<T>(pid: pid_t, action: impl FnOnce() -> CoreResult<T>) -> CoreResult<T> {
	let workspace = NSWorkspace::sharedWorkspace();
	let previous = workspace.frontmostApplication();
	let target =
		NSRunningApplication::runningApplicationWithProcessIdentifier(pid).ok_or_else(|| {
			DesktopError::window_not_found(format!("application process {pid} is no longer running"))
		})?;
	#[allow(deprecated, reason = "public foreground fallback must override another frontmost app")]
	let options = NSApplicationActivationOptions::ActivateAllWindows
		| NSApplicationActivationOptions::ActivateIgnoringOtherApps;
	if !target.activateWithOptions(options) {
		return Err(DesktopError::input_failed(format!(
			"public foreground activation for process {pid} was rejected"
		)));
	}
	thread::sleep(Duration::from_millis(40));
	let result = action();
	thread::sleep(Duration::from_millis(40));
	if let Some(previous) = previous {
		#[allow(
			deprecated,
			reason = "restoring the prior frontmost app requires the same activation option"
		)]
		let restore_options = NSApplicationActivationOptions::ActivateIgnoringOtherApps;
		let _ = previous.activateWithOptions(restore_options);
	}
	result
}

fn process_psn(lookup: PsnLookup, pid: pid_t, wid: u32) -> Option<ProcessSerialNumber> {
	if let (Some(main_connection), Some(get_window_owner), Some(get_connection_psn)) =
		(lookup.main_connection, lookup.get_window_owner, lookup.get_connection_psn)
	{
		let main_connection = unsafe { main_connection() };
		let mut owner_connection = 0u32;

		if unsafe { get_window_owner(main_connection, wid, &mut owner_connection) } == 0
			&& owner_connection != 0
		{
			let mut psn = ProcessSerialNumber::default();

			if unsafe { get_connection_psn(owner_connection, &mut psn) } == 0 {
				return Some(psn);
			}
		}
	}
	let fallback = lookup.get_process_for_pid?;
	let mut psn = ProcessSerialNumber::default();

	if unsafe { fallback(pid, &mut psn) } == 0 {
		Some(psn)
	} else {
		None
	}
}

fn resolve_authentication() -> Option<AuthenticationSpi> {
	Some(AuthenticationSpi {
		set_message:       symbol(c"SLEventSetAuthenticationMessage")?,
		objc_get_class:    symbol(c"objc_getClass")?,
		sel_register_name: symbol(c"sel_registerName")?,
		class_responds:    symbol(c"class_respondsToSelector")?,
		factory:           symbol(c"objc_msgSend")?,
	})
}

fn attach_keyboard_authentication(pid: pid_t, event: &CGEvent) {
	let Some(spi) = AUTHENTICATION.as_ref() else {
		return;
	};

	let class = unsafe { (spi.objc_get_class)(c"SLSEventAuthenticationMessage".as_ptr()) };

	let selector =
		unsafe { (spi.sel_register_name)(c"messageWithEventRecord:pid:version:".as_ptr()) };
	if class.is_null() || selector.is_null() {
		return;
	}

	if !unsafe { (spi.class_responds)(class, selector) } {
		return;
	}

	let event_raw = event_ptr(event);
	let mut record = ptr::null_mut();
	for offset in [24usize, 32, 16] {
		let candidate =
			unsafe { ptr::read_unaligned(event_raw.cast::<u8>().add(offset).cast::<*mut c_void>()) };
		if !candidate.is_null() {
			record = candidate;
			break;
		}
	}
	if record.is_null() {
		return;
	}

	let message = unsafe { (spi.factory)(class, selector, record, pid, 0) };
	if message.is_null() {
		return;
	}

	unsafe { (spi.set_message)(event_raw, message) };
}
