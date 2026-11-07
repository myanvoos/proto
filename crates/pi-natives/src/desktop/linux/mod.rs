pub mod ax;
pub mod wayland;
pub mod x11;

use std::{thread, time::Duration};

use super::{
	backend::Backend,
	error::{CoreResult, DesktopError},
	types::DisplaySelector,
};

/// How long each click's button stays down.
pub(super) const CLICK_DELAY: Duration = Duration::from_millis(12);
/// Release → next press of a multi-click. Chromium synthesizes `dblclick` only
/// when the first pair reached it before the second, and Qt apps on KDE Plasma
/// saw libei presses a few microseconds apart as separate single clicks.
pub(super) const MULTI_CLICK_GAP: Duration = Duration::from_millis(50);

/// Sends `count` clicks through `send(pressed)` for the X11 `XTest` and libei
/// routes, holding each press for [`CLICK_DELAY`] and spacing the clicks
/// [`MULTI_CLICK_GAP`] apart. Every press attempt is released, even a failed
/// one.
pub(super) fn pace_clicks(
	count: u32,
	mut send: impl FnMut(bool) -> CoreResult<()>,
) -> CoreResult<()> {
	for index in 0..count.max(1) {
		if index > 0 {
			thread::sleep(MULTI_CLICK_GAP);
		}
		let pressed = send(true);
		thread::sleep(CLICK_DELAY);
		let released = send(false);
		pressed.and(released)?;
	}
	Ok(())
}

pub fn new_backend(display: DisplaySelector) -> CoreResult<Box<dyn Backend>> {
	if std::env::var_os("WAYLAND_DISPLAY").is_some() {
		return Ok(Box::new(wayland::WaylandBackend::new(display)));
	}
	if std::env::var_os("DISPLAY").is_some() {
		return Ok(Box::new(x11::X11Backend::new(display)?));
	}
	Err(DesktopError::capture_failed(
		"no display server (neither WAYLAND_DISPLAY nor DISPLAY is set)",
	))
}

#[cfg(test)]
mod tests {
	use std::time::Instant;

	use super::*;

	/// Qt apps on KDE Plasma read a press released microseconds later as a
	/// single click, so the hold and the release → next press gap are the
	/// whole fix: a regression here makes double clicks land as one.
	#[test]
	fn multi_click_presses_are_held_and_spaced_for_event_consumers() {
		let mut sent: Vec<(bool, Instant)> = Vec::new();
		pace_clicks(2, |pressed| {
			sent.push((pressed, Instant::now()));
			Ok(())
		})
		.unwrap();
		let order: Vec<bool> = sent.iter().map(|&(pressed, _)| pressed).collect();
		assert_eq!(order, [true, false, true, false]);
		assert!(sent[1].1.duration_since(sent[0].1) >= CLICK_DELAY, "first press must be held");
		assert!(
			sent[2].1.duration_since(sent[1].1) >= MULTI_CLICK_GAP,
			"second click must follow the first by a multi-click gap"
		);
		assert!(sent[3].1.duration_since(sent[2].1) >= CLICK_DELAY, "second press must be held");
	}

	/// A failed press must still release the button, or the target keeps the
	/// button held after the call reports failure.
	#[test]
	fn a_failed_press_is_still_released_and_stops_the_gesture() {
		let mut sent = Vec::new();
		let result = pace_clicks(2, |pressed| {
			sent.push(pressed);
			if pressed {
				Err(DesktopError::input_failed("press flush failed"))
			} else {
				Ok(())
			}
		});
		assert!(result.is_err());
		assert_eq!(sent, [true, false]);
	}
}
