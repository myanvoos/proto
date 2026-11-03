use std::io::Cursor;

use icy_sixel::{EncodeOptions, sixel_encode};
use image::{DynamicImage, ImageReader, imageops::FilterType};
use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi(catch_unwind)]
pub fn encode_sixel(
	bytes: Uint8Array,
	target_width_px: u32,
	target_height_px: u32,
	background_rgb: u32,
) -> Result<String> {
	encode_image(bytes.as_ref(), target_width_px, target_height_px, background_rgb)
}

fn encode_image(
	bytes: &[u8],
	target_width_px: u32,
	target_height_px: u32,
	background_rgb: u32,
) -> Result<String> {
	if target_width_px == 0 || target_height_px == 0 {
		return Err(Error::from_reason("Target SIXEL dimensions must be greater than zero"));
	}
	if background_rgb > 0xffffff {
		return Err(Error::from_reason("SIXEL background must be a packed 24-bit RGB color"));
	}

	let source = decode_image_from_bytes(bytes)?;
	let needs_resize = source.width() != target_width_px || source.height() != target_height_px;
	let premultiplied = needs_resize && source.color().has_alpha();
	let mut rgba = if premultiplied {
		// Alpha is coverage: 0 is invisible, 255 is opaque. Stored RGB can still
		// contain colors when alpha is zero. Before averaging neighboring pixels,
		// weight RGB by coverage ("premultiply"): half-visible red becomes
		// (128, 0, 0, 128), not (255, 0, 0, 128). This keeps hidden colors out of
		// visible edges. Reuse RGBA8 storage; leave the background out until
		// later.
		let mut rgba = source.into_rgba8();
		for pixel in rgba.pixels_mut() {
			let alpha = u32::from(pixel[3]);
			if alpha == 255 {
				continue;
			}
			for channel in &mut pixel.0[..3] {
				*channel = ((u32::from(*channel) * alpha + 127) / 255) as u8;
			}
		}
		// Resize coverage-weighted RGB and alpha with the same filter.
		image::imageops::resize(&rgba, target_width_px, target_height_px, FilterType::Lanczos3)
	} else if needs_resize {
		// Opaque formats need neither a full-size RGBA conversion nor
		// premultiplication.
		source
			.resize_exact(target_width_px, target_height_px, FilterType::Lanczos3)
			.into_rgba8()
	} else {
		source.into_rgba8()
	};
	let width = target_width_px as usize;
	let rows = band_rows(target_height_px) as usize;
	let background =
		[(background_rgb >> 16) & 0xff, (background_rgb >> 8) & 0xff, background_rgb & 0xff];
	for pixel in rgba.pixels_mut() {
		let alpha = u32::from(pixel[3]);
		// Keep holes transparent; opaque pixels need no background contribution.
		if alpha == 0 || alpha == 255 {
			continue;
		}
		// SIXEL supports only fully visible or fully transparent pixels. For
		// partial coverage, add the background's uncovered share:
		// RGB * alpha + background * (1 - alpha), with alpha normalized to 0..1.
		// Premultiplied RGB already includes alpha; multiplying it again would
		// darken edges. Only the unscaled, straight-RGB path still needs it.
		for channel in 0..3 {
			let foreground = u32::from(pixel[channel]);
			let covered = if premultiplied {
				// Lanczos can overshoot near sharp edges. A coverage-weighted
				// channel cannot exceed alpha (half-visible white is at most 128).
				foreground.min(alpha) * 255
			} else {
				foreground * alpha
			};
			// Alpha uses 0..255 here; +127 rounds the division to nearest.
			pixel[channel] = ((covered + background[channel] * (255 - alpha) + 127) / 255) as u8;
		}
		pixel[3] = 255;
	}
	let options = EncodeOptions::default();
	sixel_encode(&rgba.as_raw()[..width * rows * 4], width, rows, &options)
		.map_err(|err| Error::from_reason(format!("Failed to encode SIXEL: {err}")))
}

const fn band_rows(height: u32) -> u32 {
	if height < 6 {
		height
	} else {
		height - height % 6
	}
}

fn decode_image_from_bytes(bytes: &[u8]) -> Result<DynamicImage> {
	let reader = ImageReader::new(Cursor::new(bytes))
		.with_guessed_format()
		.map_err(|e| Error::from_reason(format!("Failed to detect image format: {e}")))?;

	reader
		.decode()
		.map_err(|e| Error::from_reason(format!("Failed to decode image: {e}")))
}

#[cfg(test)]
mod encode_regressions {
	use image::{ImageFormat, Rgba, RgbaImage};

	use super::*;
	#[test]
	fn transparent_resize_ignores_hidden_colors_and_stays_inside_cell_box() {
		for hidden in [Rgba([0, 0, 0, 0]), Rgba([255, 0, 0, 0])] {
			let source = RgbaImage::from_fn(2, 220, |x, _| {
				if x == 0 {
					Rgba([255, 255, 255, 255])
				} else {
					hidden
				}
			});
			let mut png = Vec::new();
			DynamicImage::ImageRgba8(source)
				.write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
				.unwrap();
			let encoded = encode_image(&png, 1, 220, 0).unwrap();
			let decoded = icy_sixel::SixelImage::decode(encoded.as_bytes()).unwrap();
			assert_eq!((decoded.width, decoded.height), (1, 216));
			for pixel in decoded.pixels.chunks_exact(4) {
				assert_eq!(pixel[3], 255);
				assert!(pixel[..3].iter().all(|channel| channel.abs_diff(128) <= 2), "{pixel:?}");
			}
		}
	}
}
