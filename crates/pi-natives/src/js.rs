use std::{
	cell::{Cell, UnsafeCell},
	fmt,
	ops::{Deref, Range},
	ptr::{self, NonNull},
	slice, str,
};

use napi::{
	Error, JsString, JsValue, Result, Status,
	bindgen_prelude::{FromNapiValue, ToNapiValue, TypeName, ValidateNapiValue},
	sys,
};

const SCRATCH_LEN: usize = 64 * 1024;

struct Arena {
	buf: UnsafeCell<[u16; SCRATCH_LEN / 2]>,

	offset: Cell<usize>,

	live: Cell<usize>,
}

thread_local! {
	static ARENA: Arena = const {
		Arena {
			buf:    UnsafeCell::new([0; SCRATCH_LEN / 2]),
			offset: Cell::new(0),
			live:   Cell::new(0),
		}
	};
}

impl Arena {
	const fn base(&self) -> *mut u8 {
		self.buf.get().cast()
	}

	const fn tail(&self, align: usize) -> (usize, usize) {
		let start = (self.offset.get() + align - 1) & !(align - 1);
		(start, SCRATCH_LEN.saturating_sub(start))
	}

	fn commit(&self, start: usize, len: usize) {
		self.offset.set(start + len);
		self.live.set(self.live.get() + 1);
	}

	fn release(&self, start: usize, end: usize) {
		let live = self.live.get() - 1;
		self.live.set(live);
		if live == 0 {
			self.offset.set(0);
		} else if self.offset.get() == end {
			self.offset.set(start);
		}
	}
}

enum TextRepr<T> {
	Scratch { ptr: NonNull<T>, len: usize },

	Owned(Vec<T>),
}

impl<T> TextRepr<T> {
	#[inline]
	fn as_slice(&self) -> &[T] {
		match self {
			Self::Scratch { ptr, len } => unsafe { slice::from_raw_parts(ptr.as_ptr(), *len) },
			Self::Owned(vec) => vec,
		}
	}
}

impl<T> Drop for TextRepr<T> {
	fn drop(&mut self) {
		if let Self::Scratch { ptr, len } = *self {
			ARENA.with(|arena| {
				let start = ptr.as_ptr().addr() - arena.base().addr();
				arena.release(start, start + len * size_of::<T>());
			});
		}
	}
}

pub struct Utf16(TextRepr<u16>);

impl Deref for Utf16 {
	type Target = [u16];

	#[inline]
	fn deref(&self) -> &[u16] {
		self.0.as_slice()
	}
}

pub struct Utf8(TextRepr<u8>);

impl Deref for Utf8 {
	type Target = str;

	#[inline]
	fn deref(&self) -> &str {
		unsafe { str::from_utf8_unchecked(self.0.as_slice()) }
	}
}

#[inline]
pub fn utf16(value: JsString<'_>) -> Result<Utf16> {
	let raw = value.value();
	ARENA.with(|arena| {
		let (start, avail_bytes) = arena.tail(2);
		let avail = avail_bytes / 2;
		if avail >= 2 {
			let ptr = unsafe { arena.base().add(start) }.cast::<u16>();
			let mut written = 0;

			let status = unsafe {
				sys::napi_get_value_string_utf16(raw.env, raw.value, ptr, avail, &mut written)
			};
			napi::check_status!(status, "Failed to read JavaScript string")?;
			if written < avail - 1 {
				arena.commit(start, written * 2);
				return Ok(Utf16(TextRepr::Scratch { ptr: NonNull::new(ptr).unwrap(), len: written }));
			}
		}

		let mut len = 0;

		let status = unsafe {
			sys::napi_get_value_string_utf16(raw.env, raw.value, ptr::null_mut(), 0, &mut len)
		};
		napi::check_status!(status, "Failed to measure JavaScript string")?;
		let mut buf: Vec<u16> = Vec::with_capacity(len + 1);
		let mut written = 0;

		let status = unsafe {
			sys::napi_get_value_string_utf16(
				raw.env,
				raw.value,
				buf.as_mut_ptr(),
				len + 1,
				&mut written,
			)
		};
		napi::check_status!(status, "Failed to read JavaScript string")?;

		unsafe { buf.set_len(written) };
		Ok(Utf16(TextRepr::Owned(buf)))
	})
}

#[inline]
pub fn utf8(value: JsString<'_>) -> Result<Utf8> {
	let raw = value.value();
	ARENA.with(|arena| {
		let (start, avail) = arena.tail(1);
		if avail >= 2 {
			let ptr = unsafe { arena.base().add(start) };
			let mut written = 0;

			let status = unsafe {
				sys::napi_get_value_string_utf8(raw.env, raw.value, ptr.cast(), avail, &mut written)
			};
			napi::check_status!(status, "Failed to read JavaScript string")?;
			if written < avail - 1 {
				let bytes = unsafe { slice::from_raw_parts(ptr, written) };
				if let Err(error) = str::from_utf8(bytes) {
					return Err(Error::new(Status::InvalidArg, error.to_string()));
				}
				arena.commit(start, written);
				return Ok(Utf8(TextRepr::Scratch { ptr: NonNull::new(ptr).unwrap(), len: written }));
			}
		}

		let mut len = 0;

		let status = unsafe {
			sys::napi_get_value_string_utf8(raw.env, raw.value, ptr::null_mut(), 0, &mut len)
		};
		napi::check_status!(status, "Failed to measure JavaScript string")?;
		let mut buf: Vec<u8> = Vec::with_capacity(len + 1);
		let mut written = 0;

		let status = unsafe {
			sys::napi_get_value_string_utf8(
				raw.env,
				raw.value,
				buf.as_mut_ptr().cast(),
				len + 1,
				&mut written,
			)
		};
		napi::check_status!(status, "Failed to read JavaScript string")?;

		unsafe { buf.set_len(written) };
		if let Err(error) = str::from_utf8(&buf) {
			return Err(Error::new(Status::InvalidArg, error.to_string()));
		}
		Ok(Utf8(TextRepr::Owned(buf)))
	})
}

pub fn utf16_append(value: JsString<'_>, out: &mut Vec<u16>) -> Result<Range<usize>> {
	let raw = value.value();
	let start = out.len();

	let mut len = 0;

	let status =
		unsafe { sys::napi_get_value_string_utf16(raw.env, raw.value, ptr::null_mut(), 0, &mut len) };
	napi::check_status!(status, "Failed to measure JavaScript string")?;

	out.resize(start + len + 1, 0);
	let mut written = 0;

	let status = unsafe {
		sys::napi_get_value_string_utf16(
			raw.env,
			raw.value,
			out[start..].as_mut_ptr(),
			len + 1,
			&mut written,
		)
	};
	napi::check_status!(status, "Failed to read JavaScript string")?;
	out.truncate(start + written);
	Ok(start..out.len())
}

pub fn into_string(value: JsString<'_>) -> Result<String> {
	let raw = value.value();

	unsafe { String::from_napi_value(raw.env, raw.value) }
}

#[derive(Clone)]
pub struct InlineStr<const N: usize>(heapless::Vec<u8, N, u8>);

impl<const N: usize> InlineStr<N> {
	pub const CAPACITY: usize = N - 1;

	pub fn new(text: &str) -> Result<Self> {
		if text.len() > Self::CAPACITY {
			return Err(too_long(text.len(), Self::CAPACITY));
		}
		heapless::Vec::from_slice(text.as_bytes())
			.map(Self)
			.map_err(|_| too_long(text.len(), Self::CAPACITY))
	}
}

fn too_long(len: usize, capacity: usize) -> Error {
	Error::new(Status::InvalidArg, format!("string is {len} bytes, expected at most {capacity}"))
}

impl<const N: usize> Deref for InlineStr<N> {
	type Target = str;

	fn deref(&self) -> &str {
		unsafe { str::from_utf8_unchecked(&self.0) }
	}
}

impl<const N: usize> fmt::Debug for InlineStr<N> {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		fmt::Debug::fmt(&**self, f)
	}
}

impl<const N: usize> TypeName for InlineStr<N> {
	fn type_name() -> &'static str {
		"String"
	}

	fn value_type() -> napi::ValueType {
		napi::ValueType::String
	}
}

impl<const N: usize> ValidateNapiValue for InlineStr<N> {}

impl<const N: usize> FromNapiValue for InlineStr<N> {
	unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
		let mut len = 0;

		let status =
			unsafe { sys::napi_get_value_string_utf8(env, napi_val, ptr::null_mut(), 0, &mut len) };
		napi::check_status!(status, "Failed to measure JavaScript string")?;
		if len > Self::CAPACITY {
			return Err(too_long(len, Self::CAPACITY));
		}

		let mut buf: heapless::Vec<u8, N, u8> = heapless::Vec::new();
		buf.resize_default(N)
			.map_err(|_| too_long(len, Self::CAPACITY))?;
		let mut written = 0;

		let status = unsafe {
			sys::napi_get_value_string_utf8(env, napi_val, buf.as_mut_ptr().cast(), N, &mut written)
		};
		napi::check_status!(status, "Failed to read JavaScript string")?;
		buf.truncate(written);
		if let Err(error) = str::from_utf8(&buf) {
			return Err(Error::new(Status::InvalidArg, error.to_string()));
		}
		Ok(Self(buf))
	}
}

impl<const N: usize> ToNapiValue for InlineStr<N> {
	unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
		unsafe { ToNapiValue::to_napi_value(env, &*val) }
	}
}
