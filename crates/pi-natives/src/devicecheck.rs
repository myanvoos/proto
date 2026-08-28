use napi_derive::napi;

use crate::task;

#[napi(object)]
pub struct DeviceCheckTokenResult {
	pub supported: bool,

	pub token_base64: Option<String>,

	pub error: Option<String>,

	pub latency_ms: f64,
}

#[napi]
pub fn device_check_generate_token() -> task::Promise<DeviceCheckTokenResult> {
	task::blocking("devicecheck.generate_token", (), move |_| Ok(platform::generate_token()))
}

#[cfg(target_os = "macos")]
mod platform {
	use std::{
		ffi::{CStr, c_char, c_void},
		panic::{AssertUnwindSafe, catch_unwind},
		ptr,
		sync::mpsc::{self, SyncSender},
		time::{Duration, Instant},
	};

	use super::DeviceCheckTokenResult;

	const TOKEN_TIMEOUT: Duration = Duration::from_secs(1);

	type Id = *mut c_void;
	type Sel = *mut c_void;

	#[allow(
		clashing_extern_declarations,
		reason = "objc_msgSend is an assembly trampoline that forwards to the method IMP; each \
		          alias types the same symbol for a distinct call signature"
	)]
	#[link(name = "objc")]
	unsafe extern "C" {
		fn objc_getClass(name: *const c_char) -> Id;
		fn sel_registerName(name: *const c_char) -> Sel;
		fn objc_retain(obj: Id) -> Id;
		fn objc_release(obj: Id);
		fn objc_autoreleasePoolPush() -> *mut c_void;
		fn objc_autoreleasePoolPop(pool: *mut c_void);

		#[link_name = "objc_msgSend"]
		fn msg_send_noarg(receiver: Id, selector: Sel) -> Id;
		#[link_name = "objc_msgSend"]
		fn msg_send_bool(receiver: Id, selector: Sel) -> u8;
		#[link_name = "objc_msgSend"]
		fn msg_send_u64(receiver: Id, selector: Sel, options: u64) -> Id;
		#[link_name = "objc_msgSend"]
		fn msg_send_block(receiver: Id, selector: Sel, block: *const c_void);
	}

	#[link(name = "DeviceCheck", kind = "framework")]
	unsafe extern "C" {}

	unsafe extern "C" {

		static _NSConcreteStackBlock: *const c_void;
	}

	#[link(name = "Security", kind = "framework")]
	unsafe extern "C" {
		fn SessionGetInfo(session: u32, session_id: *mut u32, attributes: *mut u32) -> i32;
	}

	const CALLER_SECURITY_SESSION: u32 = u32::MAX;

	const SESSION_HAS_GRAPHIC_ACCESS: u32 = 0x0010;

	fn session_has_graphic_access() -> bool {
		let mut attributes: u32 = 0;

		let status =
			unsafe { SessionGetInfo(CALLER_SECURITY_SESSION, ptr::null_mut(), &mut attributes) };
		status == 0 && attributes & SESSION_HAS_GRAPHIC_ACCESS != 0
	}

	enum Completion {
		Token(String),
		Error(String),
	}

	#[repr(C)]
	struct CompletionBlock {
		isa:        *const c_void,
		flags:      i32,
		reserved:   i32,
		invoke:     unsafe extern "C" fn(*mut Self, Id, Id),
		descriptor: *const CompletionBlockDescriptor,
		sender:     *const SyncSender<Completion>,
	}

	#[repr(C)]
	struct CompletionBlockDescriptor {
		reserved:  usize,
		size:      usize,
		signature: *const c_char,
	}

	const BLOCK_HAS_SIGNATURE: i32 = 1 << 30;

	const BLOCK_SIGNATURE: &CStr = c"v24@?0@8@16";

	unsafe impl Sync for CompletionBlockDescriptor {}

	static COMPLETION_DESCRIPTOR: CompletionBlockDescriptor = CompletionBlockDescriptor {
		reserved:  0,
		size:      size_of::<CompletionBlock>(),
		signature: BLOCK_SIGNATURE.as_ptr(),
	};

	unsafe fn selector(name: &CStr) -> Sel {
		unsafe { sel_registerName(name.as_ptr()) }
	}

	unsafe fn copy_c_string(ptr: *const c_char) -> String {
		if ptr.is_null() {
			return String::new();
		}

		unsafe { CStr::from_ptr(ptr) }
			.to_string_lossy()
			.into_owned()
	}

	unsafe fn ns_string(string: Id) -> String {
		unsafe { copy_c_string(msg_send_noarg(string, selector(c"UTF8String")).cast()) }
	}

	unsafe extern "C" fn completion_invoke(block: *mut CompletionBlock, token: Id, error: Id) {
		let completion = catch_unwind(AssertUnwindSafe(|| {
			if !token.is_null() {
				let encoded =
					unsafe { msg_send_u64(token, selector(c"base64EncodedStringWithOptions:"), 0) };
				if encoded.is_null() {
					return Completion::Error("DeviceCheck returned no token".to_owned());
				}

				return Completion::Token(unsafe { ns_string(encoded) });
			}
			if !error.is_null() {
				let description = unsafe { msg_send_noarg(error, selector(c"localizedDescription")) };
				if description.is_null() {
					return Completion::Error("DeviceCheck token request failed".to_owned());
				}

				return Completion::Error(unsafe { ns_string(description) });
			}
			Completion::Error("DeviceCheck returned no token".to_owned())
		}));
		let completion = match completion {
			Ok(completion) => completion,
			Err(payload) => {
				std::mem::forget(payload);
				Completion::Error("DeviceCheck completion panicked".to_owned())
			},
		};

		unsafe {
			_ = (*(*block).sender).try_send(completion);
		}
	}

	unsafe fn run_token_request(device: Id) -> DeviceCheckTokenResult {
		let (sender, receiver) = mpsc::sync_channel::<Completion>(1);
		let sender = Box::into_raw(Box::new(sender));
		let block = CompletionBlock {
			isa: ptr::addr_of!(_NSConcreteStackBlock).cast::<c_void>(),
			flags: BLOCK_HAS_SIGNATURE,
			reserved: 0,
			invoke: completion_invoke,
			descriptor: &raw const COMPLETION_DESCRIPTOR,
			sender,
		};

		unsafe {
			msg_send_block(
				device,
				selector(c"generateTokenWithCompletionHandler:"),
				(&raw const block).cast(),
			);
		}

		let mut result = DeviceCheckTokenResult {
			supported:    true,
			token_base64: None,
			error:        None,
			latency_ms:   0.0,
		};
		match receiver.recv_timeout(TOKEN_TIMEOUT) {
			Ok(Completion::Token(token)) => {
				result.token_base64 = Some(token);

				drop(unsafe { Box::from_raw(sender) });
			},
			Ok(Completion::Error(message)) => {
				result.error = Some(message);

				drop(unsafe { Box::from_raw(sender) });
			},
			Err(_) => {
				result.error = Some("timed out waiting for DeviceCheck token".to_owned());
			},
		}
		result
	}

	fn generate_token_inner() -> DeviceCheckTokenResult {
		let mut result = DeviceCheckTokenResult {
			supported:    false,
			token_base64: None,
			error:        None,
			latency_ms:   0.0,
		};
		if !session_has_graphic_access() {
			result.error = Some("DeviceCheck unavailable without a GUI login session".to_owned());
			return result;
		}

		let class = unsafe { objc_getClass(c"DCDevice".as_ptr()) };
		if class.is_null() {
			result.error = Some("DeviceCheck framework unavailable".to_owned());
			return result;
		}

		let device = unsafe { msg_send_noarg(class, selector(c"currentDevice")) };
		if device.is_null() {
			result.error = Some("DeviceCheck currentDevice unavailable".to_owned());
			return result;
		}

		let device = unsafe { objc_retain(device) };

		let supported = unsafe { msg_send_bool(device, selector(c"isSupported")) } != 0;
		if supported {
			return unsafe {
				let mut token_result = run_token_request(device);
				objc_release(device);
				token_result.supported = true;
				token_result
			};
		}

		unsafe { objc_release(device) };
		result
	}

	pub fn generate_token() -> DeviceCheckTokenResult {
		let start = Instant::now();

		let pool = unsafe { objc_autoreleasePoolPush() };
		let mut result = generate_token_inner();
		result.latency_ms = start.elapsed().as_secs_f64() * 1000.0;

		unsafe { objc_autoreleasePoolPop(pool) };
		result
	}
}

#[cfg(not(target_os = "macos"))]
mod platform {
	use super::DeviceCheckTokenResult;

	pub const fn generate_token() -> DeviceCheckTokenResult {
		DeviceCheckTokenResult {
			supported:    false,
			token_base64: None,
			error:        None,
			latency_ms:   0.0,
		}
	}
}
