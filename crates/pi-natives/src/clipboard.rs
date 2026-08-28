use std::io::Cursor;

use arboard::{Clipboard, Error as ClipboardError, ImageData};
use image::{DynamicImage, ImageFormat, RgbaImage};
use napi::{JsString, bindgen_prelude::*};
use napi_derive::napi;

use crate::{js, task};

#[napi(object)]
pub struct ClipboardImage {
	pub data: Uint8Array,

	pub mime_type: String,
}

fn encode_png(image: ImageData<'_>) -> Result<Vec<u8>> {
	let width = u32::try_from(image.width)
		.map_err(|_| Error::from_reason("Clipboard image width overflow"))?;
	let height = u32::try_from(image.height)
		.map_err(|_| Error::from_reason("Clipboard image height overflow"))?;
	let bytes = image.bytes.into_owned();
	let buffer = RgbaImage::from_raw(width, height, bytes)
		.ok_or_else(|| Error::from_reason("Clipboard image buffer size mismatch"))?;
	rgba_to_png(buffer)
}

fn rgba_to_png(buffer: RgbaImage) -> Result<Vec<u8>> {
	let capacity = (buffer
		.width()
		.saturating_mul(buffer.height())
		.saturating_mul(4)) as usize;
	let mut output = Vec::with_capacity(capacity);
	DynamicImage::ImageRgba8(buffer)
		.write_to(&mut Cursor::new(&mut output), ImageFormat::Png)
		.map_err(|err| Error::from_reason(format!("Failed to encode clipboard image: {err}")))?;
	Ok(output)
}

#[napi]
pub fn copy_to_clipboard(text: JsString) -> Result<()> {
	set_clipboard_text(&js::utf8(text)?)
}

#[cfg(target_os = "linux")]
fn set_clipboard_text(text: &str) -> Result<()> {
	use std::sync::OnceLock;

	use parking_lot::Mutex;

	static CLIPBOARD: OnceLock<Mutex<Option<Clipboard>>> = OnceLock::new();
	let cell = CLIPBOARD.get_or_init(|| Mutex::new(None));
	let mut guard = cell.lock();
	if guard.is_none() {
		*guard = Some(
			Clipboard::new()
				.map_err(|err| Error::from_reason(format!("Failed to access clipboard: {err}")))?,
		);
	}
	guard
		.as_mut()
		.expect("clipboard initialized above")
		.set_text(text)
		.map_err(|err| Error::from_reason(format!("Failed to copy to clipboard: {err}")))?;
	Ok(())
}

#[cfg(not(target_os = "linux"))]
fn set_clipboard_text(text: &str) -> Result<()> {
	let mut clipboard = Clipboard::new()
		.map_err(|err| Error::from_reason(format!("Failed to access clipboard: {err}")))?;
	clipboard
		.set_text(text)
		.map_err(|err| Error::from_reason(format!("Failed to copy to clipboard: {err}")))?;
	Ok(())
}

#[napi]
pub fn read_image_from_clipboard() -> task::Promise<Option<ClipboardImage>> {
	task::blocking("clipboard.read_image", (), move |_| -> Result<Option<ClipboardImage>> {
		let mut clipboard = Clipboard::new()
			.map_err(|err| Error::from_reason(format!("Failed to access clipboard: {err}")))?;
		match clipboard.get_image() {
			Ok(image) => {
				let bytes = encode_png(image)?;
				Ok(Some(ClipboardImage {
					data:      Uint8Array::from(bytes),
					mime_type: "image/png".to_string(),
				}))
			},
			Err(ClipboardError::ContentNotAvailable) => Ok(None),
			Err(err) => Err(Error::from_reason(format!("Failed to read clipboard image: {err}"))),
		}
	})
}
