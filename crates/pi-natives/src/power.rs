use napi_derive::napi;

#[napi(object, js_name = "MacOSPowerAssertionOptions")]
pub struct MacOSPowerAssertionOptions {
	pub reason: Option<String>,

	pub idle: Option<bool>,

	pub system: Option<bool>,

	pub user: Option<bool>,

	pub display: Option<bool>,
}

#[cfg(target_os = "macos")]
mod platform {
	use std::{
		ffi::{CString, c_char, c_void},
		ptr,
	};

	use napi::{Error, Result};

	const UTF8_ENCODING: u32 = 0x0800_0100;
	const ASSERTION_LEVEL_ON: u32 = 255;
	const ASSERTION_ID_NONE: u32 = 0;
	const PREVENT_USER_IDLE_SYSTEM_SLEEP: &str = "PreventUserIdleSystemSleep";
	const PREVENT_SYSTEM_SLEEP: &str = "PreventSystemSleep";
	const PREVENT_USER_IDLE_DISPLAY_SLEEP: &str = "PreventUserIdleDisplaySleep";
	const USER_IS_ACTIVE: &str = "UserIsActive";

	#[derive(Clone, Copy, Debug, PartialEq, Eq)]
	pub enum AssertionKind {
		PreventIdleSystemSleep,
		PreventSystemSleep,
		DeclareUserActive,
		PreventDisplaySleep,
	}

	impl AssertionKind {
		const fn iokit_name(self) -> &'static str {
			match self {
				Self::PreventIdleSystemSleep => PREVENT_USER_IDLE_SYSTEM_SLEEP,
				Self::PreventSystemSleep => PREVENT_SYSTEM_SLEEP,
				Self::DeclareUserActive => USER_IS_ACTIVE,
				Self::PreventDisplaySleep => PREVENT_USER_IDLE_DISPLAY_SLEEP,
			}
		}
	}

	type CFStringRef = *const c_void;
	type CFTypeRef = *const c_void;
	type IOPMAssertionID = u32;
	type IOPMAssertionLevel = u32;
	type IOReturn = i32;

	#[link(name = "CoreFoundation", kind = "framework")]
	unsafe extern "C" {
		fn CFStringCreateWithCString(
			alloc: *const c_void,
			c_str: *const c_char,
			encoding: u32,
		) -> CFStringRef;
		fn CFRelease(value: CFTypeRef);
	}

	#[link(name = "IOKit", kind = "framework")]
	unsafe extern "C" {
		fn IOPMAssertionCreateWithName(
			assertion_type: CFStringRef,
			assertion_level: IOPMAssertionLevel,
			assertion_name: CFStringRef,
			assertion_id: *mut IOPMAssertionID,
		) -> IOReturn;
		fn IOPMAssertionRelease(assertion_id: IOPMAssertionID) -> IOReturn;
	}

	struct CfString(CFStringRef);

	impl CfString {
		fn new(value: &str) -> Result<Self> {
			let c_string = CString::new(value).map_err(|_| {
				Error::from_reason("Power assertion strings must not contain NUL bytes")
			})?;

			let string_ref =
				unsafe { CFStringCreateWithCString(ptr::null(), c_string.as_ptr(), UTF8_ENCODING) };
			if string_ref.is_null() {
				return Err(Error::from_reason(
					"Failed to allocate CoreFoundation string for power assertion",
				));
			}
			Ok(Self(string_ref))
		}

		const fn as_ptr(&self) -> CFStringRef {
			self.0
		}
	}

	impl Drop for CfString {
		fn drop(&mut self) {
			if self.0.is_null() {
				return;
			}

			unsafe { CFRelease(self.0) };
		}
	}

	pub struct AssertionInner {
		assertion_id: IOPMAssertionID,
	}

	impl AssertionInner {
		pub fn start(kind: AssertionKind, reason: &str) -> Result<Self> {
			let assertion_type = CfString::new(kind.iokit_name())?;
			let assertion_reason = CfString::new(reason)?;
			let mut assertion_id = ASSERTION_ID_NONE;

			let status = unsafe {
				IOPMAssertionCreateWithName(
					assertion_type.as_ptr(),
					ASSERTION_LEVEL_ON,
					assertion_reason.as_ptr(),
					&raw mut assertion_id,
				)
			};
			if status != 0 {
				return Err(Error::from_reason(format!(
					"Failed to acquire macOS power assertion {kind:?} (IOReturn={status})"
				)));
			}
			Ok(Self { assertion_id })
		}

		pub fn stop(&mut self) -> Result<()> {
			if self.assertion_id == ASSERTION_ID_NONE {
				return Ok(());
			}
			let assertion_id = self.assertion_id;
			self.assertion_id = ASSERTION_ID_NONE;

			let status = unsafe { IOPMAssertionRelease(assertion_id) };
			if status != 0 {
				return Err(Error::from_reason(format!(
					"Failed to release macOS power assertion (IOReturn={status})"
				)));
			}
			Ok(())
		}
	}

	impl Drop for AssertionInner {
		fn drop(&mut self) {
			let _ = self.stop();
		}
	}
}

#[napi(js_name = "MacOSPowerAssertion")]
pub struct MacOSPowerAssertion {
	#[cfg(target_os = "macos")]
	inners: Vec<platform::AssertionInner>,
}

#[napi]
impl MacOSPowerAssertion {
	#[napi(factory)]
	pub fn start(options: Option<MacOSPowerAssertionOptions>) -> napi::Result<Self> {
		let reason = options
			.as_ref()
			.and_then(|value| value.reason.as_deref())
			.filter(|value| !value.trim().is_empty())
			.unwrap_or("Proto agent session");
		let idle = options.as_ref().and_then(|v| v.idle).unwrap_or(false);
		let system = options.as_ref().and_then(|v| v.system).unwrap_or(false);
		let user = options.as_ref().and_then(|v| v.user).unwrap_or(false);
		let display = options.as_ref().and_then(|v| v.display).unwrap_or(false);

		let effective_idle = idle || !(system || user || display);

		#[cfg(target_os = "macos")]
		{
			let mut kinds: Vec<platform::AssertionKind> = Vec::new();
			if effective_idle {
				kinds.push(platform::AssertionKind::PreventIdleSystemSleep);
			}
			if system {
				kinds.push(platform::AssertionKind::PreventSystemSleep);
			}
			if user {
				kinds.push(platform::AssertionKind::DeclareUserActive);
			}
			if display {
				kinds.push(platform::AssertionKind::PreventDisplaySleep);
			}
			let mut inners: Vec<platform::AssertionInner> = Vec::with_capacity(kinds.len());
			for kind in kinds {
				inners.push(platform::AssertionInner::start(kind, reason)?);
			}
			Ok(Self { inners })
		}
		#[cfg(not(target_os = "macos"))]
		{
			let _ = (reason, effective_idle, system, user, display);
			Ok(Self {})
		}
	}

	#[napi]
	#[allow(clippy::missing_const_for_fn, reason = "not const on macOS")]
	pub fn stop(&mut self) -> napi::Result<()> {
		#[cfg(target_os = "macos")]
		{
			let mut first_err: Option<napi::Error> = None;
			for mut inner in self.inners.drain(..) {
				if let Err(err) = inner.stop()
					&& first_err.is_none()
				{
					first_err = Some(err);
				}
			}
			if let Some(err) = first_err {
				return Err(err);
			}
		}
		Ok(())
	}
}
