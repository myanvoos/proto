use napi::JsString;
use napi_derive::napi;

use crate::js;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(all(unix, not(target_os = "linux")))]
mod unix;

#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(all(unix, not(target_os = "linux")))]
use unix as platform;

#[cfg(not(unix))]
compile_error!("pi-natives file locks require Unix");

#[cfg(target_os = "linux")]
fn memory_lock_name(path: &str) -> String {
	const HIGH_SEED: u64 = 0x4f4d_502d_4c4f_434b;
	const LOW_SEED: u64 = 0x5049_2d46_494c_454c;
	let bytes = path.as_bytes();
	let high = xxhash_rust::xxh64::xxh64(bytes, HIGH_SEED);
	let low = xxhash_rust::xxh64::xxh64(bytes, LOW_SEED);
	format!("proto-file-lock-{high:016x}{low:016x}")
}

#[napi(js_name = "FileLock")]
pub struct FileLock {
	inner: Option<platform::PlatformFileLock>,
}

#[napi]
impl FileLock {
	#[napi(factory)]
	pub fn try_acquire(path: JsString) -> napi::Result<Self> {
		let path = js::utf8(path)?;
		let inner = platform::try_acquire(&path).map_err(|error| {
			napi::Error::from_reason(format!(
				"Failed to acquire native file lock for {}: {error}",
				&*path
			))
		})?;
		Ok(Self { inner })
	}

	#[napi(getter)]
	#[allow(clippy::missing_const_for_fn, reason = "napi method signature")]
	pub fn acquired(&self) -> bool {
		self.inner.is_some()
	}

	#[napi]
	pub fn release(&mut self) -> napi::Result<()> {
		let Some(mut inner) = self.inner.take() else {
			return Ok(());
		};
		if let Err(error) = inner.release() {
			self.inner = Some(inner);
			return Err(napi::Error::from_reason(format!(
				"Failed to release native file lock: {error}"
			)));
		}
		Ok(())
	}
}

impl Drop for FileLock {
	fn drop(&mut self) {
		if let Some(inner) = self.inner.as_mut() {
			let _ = inner.release();
		}
	}
}
