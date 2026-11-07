#[cfg(feature = "wayland-pipewire")]
mod capture;
mod libei;
mod portal;

use std::{cell::OnceCell, os::fd::AsRawFd, path::PathBuf};

use image::RgbaImage;

use crate::desktop::{
	backend::{AxBackend, Backend, DeliveryMode, PointerEvent},
	error::{CoreResult, DesktopError},
	frame::FrameGeometry,
	keys::KeyName,
	linux::ax::{AtSpiAx, resolve_focus},
	types::{
		CaptureCaps, DesktopCapabilities, DesktopDisplay, DesktopWindow, DisplaySelector, Target,
	},
};

pub struct WaylandBackend {
	#[cfg_attr(
		not(feature = "wayland-pipewire"),
		expect(dead_code, reason = "only read by the pipewire capture path")
	)]
	display:           DisplaySelector,
	ax:                Option<AtSpiAx>,
	ax_error:          Option<DesktopError>,
	input:             Option<libei::Libei>,
	input_error:       Option<DesktopError>,
	/// Why native input can never work here, probed once without a prompt;
	/// `None` when it may.
	input_unavailable: OnceCell<Option<String>>,
	displays:          Vec<DesktopDisplay>,
	/// The compositor's PID, whose own AT-SPI frames never count as the
	/// focused application window.
	compositor_pid:    Option<u32>,
}

/// Reads the compositor's PID from the peer credentials of its Wayland socket.
fn compositor_pid() -> Option<u32> {
	let display = PathBuf::from(std::env::var_os("WAYLAND_DISPLAY")?);
	let path = if display.is_absolute() {
		display
	} else {
		PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR")?).join(display)
	};
	let socket = std::os::unix::net::UnixStream::connect(path).ok()?;
	let mut credentials = libc::ucred { pid: 0, uid: 0, gid: 0 };
	let mut length = size_of::<libc::ucred>() as libc::socklen_t;
	// SAFETY: `credentials` and `length` are live, correctly sized out-params
	// for SO_PEERCRED on a connected Unix socket; the kernel keeps no pointer.
	let status = unsafe {
		libc::getsockopt(
			socket.as_raw_fd(),
			libc::SOL_SOCKET,
			libc::SO_PEERCRED,
			(&raw mut credentials).cast(),
			&raw mut length,
		)
	};
	(status == 0 && credentials.pid > 0).then_some(credentials.pid as u32)
}

impl WaylandBackend {
	pub fn new(display: DisplaySelector) -> Self {
		portal::remove_orphaned_remote_desktop_token();
		let (ax, ax_error) = match AtSpiAx::new() {
			Ok(ax) => (Some(ax), None),
			Err(err) => (None, Some(err)),
		};
		Self {
			display,
			ax,
			ax_error,
			input: None,
			input_error: None,
			input_unavailable: OnceCell::new(),
			displays: Vec::new(),
			compositor_pid: compositor_pid(),
		}
	}

	/// Read on every call: a `LIBEI_SOCKET` set later in the session reaches
	/// EIS directly, whatever the cached portal probe found.
	fn input_unavailable(&self) -> Option<&str> {
		if std::env::var_os("LIBEI_SOCKET").is_some() {
			return None;
		}
		self
			.input_unavailable
			.get_or_init(portal::input_unavailable_reason)
			.as_deref()
	}

	fn window_input_error(target: &Target, kind: &str) -> CoreResult<()> {
		if let Target::Window(id) = target {
			return Err(DesktopError::background_unavailable(format!(
				"window {id} wayland-compositor-focus-only: Wayland cannot programmatically activate \
				 a non-focused window for {kind}; only the currently focused surface is reachable; \
				 use ax actions or desktop input"
			)));
		}
		Ok(())
	}

	fn prepare_input(&mut self, target: &Target, kind: &str) -> CoreResult<&mut libei::Libei> {
		Self::window_input_error(target, kind)?;
		if self.input.is_none() && self.input_error.is_none() {
			if let Some(reason) = self.input_unavailable() {
				return Err(DesktopError::permission_denied(reason));
			}
			match libei::Libei::new() {
				Ok(input) => self.input = Some(input),
				Err(err) => self.input_error = Some(err),
			}
		}
		if let Some(input) = self.input.as_mut() {
			return Ok(input);
		}
		Err(self.input_error.clone().unwrap_or_else(|| {
			DesktopError::permission_denied(
				"RemoteDesktop portal or LIBEI_SOCKET is required for Wayland input",
			)
		}))
	}

	#[cfg(feature = "wayland-pipewire")]
	fn synthetic_display(image: &RgbaImage) -> DesktopDisplay {
		DesktopDisplay {
			id:           "wayland-portal-0".to_string(),
			name:         "Wayland portal monitor".to_string(),
			x:            0,
			y:            0,
			width:        image.width(),
			height:       image.height(),
			scale:        1.0,
			pixel_x:      0,
			pixel_y:      0,
			pixel_width:  image.width(),
			pixel_height: image.height(),
			is_primary:   true,
		}
	}

	#[cfg(feature = "wayland-pipewire")]
	fn selected_display_allowed(&self) -> CoreResult<()> {
		match &self.display {
			DisplaySelector::All => Ok(()),
			DisplaySelector::Id(id) if id == "wayland-portal-0" => Ok(()),
			DisplaySelector::Id(id) => Err(DesktopError::invalid_target(format!(
				"Wayland portal display '{id}' is unavailable; use 'all' or 'wayland-portal-0'"
			))),
		}
	}
}

impl Backend for WaylandBackend {
	fn capabilities(&mut self) -> DesktopCapabilities {
		let input_unavailable = self.input.is_none() && self.input_unavailable().is_some();
		let input_permission = if self.input.is_some() {
			"granted"
		} else if input_unavailable || self.input_error.is_some() {
			"unavailable"
		} else {
			"prompt-or-granted"
		};
		DesktopCapabilities {
			backend:        "wayland".to_string(),
			display_server: Some("wayland".to_string()),

			capture: cfg!(feature = "wayland-pipewire"),
			input: self.input_error.is_none() && !input_unavailable,
			ax: self.ax.is_some(),
			background_window_input: false,
			delivery_modes: vec!["background".to_string()],
			capture_permission: if cfg!(feature = "wayland-pipewire") {
				"prompt-or-granted".to_string()
			} else {
				"unavailable".to_string()
			},
			input_permission: input_permission.to_string(),
			ax_permission: if self.ax.is_some() {
				"granted".to_string()
			} else {
				"unavailable".to_string()
			},
			display_count: self.displays.len() as u32,
		}
	}

	fn displays(&mut self) -> CoreResult<Vec<DesktopDisplay>> {
		Ok(self.displays.clone())
	}

	fn windows(&mut self) -> CoreResult<Vec<DesktopWindow>> {
		let ax = self.ax.as_ref().ok_or_else(|| {
			self
				.ax_error
				.clone()
				.unwrap_or_else(DesktopError::ax_unsupported)
		})?;
		let mut windows = ax.windows()?;
		resolve_focus(&mut windows, self.compositor_pid, |window| ax.holds_focus(window));
		Ok(windows)
	}

	fn capture(
		&mut self,
		target: &Target,
		_caps: &CaptureCaps,
	) -> CoreResult<(RgbaImage, FrameGeometry)> {
		#[cfg(not(feature = "wayland-pipewire"))]
		{
			let _ = target;
			Err(DesktopError::capture_failed("Wayland capture requires the wayland-pipewire feature"))
		}
		#[cfg(feature = "wayland-pipewire")]
		{
			self.selected_display_allowed()?;
			let image = capture::capture()?;
			let display = Self::synthetic_display(&image);
			self.displays = vec![display];
			match target {
				Target::Desktop => {
					let geometry = FrameGeometry::for_displays(&self.displays);
					Ok((image, geometry))
				},
				Target::Window(id) => {
					let window = self
						.windows()?
						.into_iter()
						.find(|window| &window.id == id)
						.ok_or_else(|| {
							DesktopError::window_not_found(format!("Wayland window {id} not found"))
						})?;
					if window.x < 0 || window.y < 0 {
						return Err(DesktopError::capture_failed(
							"Wayland portal monitor stream cannot crop a window outside the selected \
							 monitor",
						));
					}
					let x = window.x as u32;
					let y = window.y as u32;
					let width = window.width.min(image.width().saturating_sub(x));
					let height = window.height.min(image.height().saturating_sub(y));
					if width == 0 || height == 0 {
						return Err(DesktopError::capture_failed(format!(
							"Wayland window {id} is outside the selected portal monitor"
						)));
					}
					let cropped = image::imageops::crop_imm(&image, x, y, width, height).to_image();
					let geometry = FrameGeometry::for_window(&window, cropped.width(), cropped.height());
					Ok((cropped, geometry))
				},
			}
		}
	}

	fn pointer(
		&mut self,
		target: &Target,
		ev: PointerEvent,
		_frame: &FrameGeometry,
		_mode: DeliveryMode,
	) -> CoreResult<()> {
		self.prepare_input(target, "pointer input")?.pointer(ev)
	}

	fn type_text(&mut self, target: &Target, text: &str, _mode: DeliveryMode) -> CoreResult<()> {
		self
			.prepare_input(target, "keyboard input")?
			.type_text(text)
	}

	fn key_chord(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		_mode: DeliveryMode,
	) -> CoreResult<()> {
		self
			.prepare_input(target, "keyboard input")?
			.key_chord(keys)
	}

	fn raise_window(&mut self, id: &str) -> CoreResult<()> {
		Err(DesktopError::background_unavailable(format!(
			"window {id} wayland-compositor-focus-only: Wayland cannot programmatically activate a \
			 non-focused window; only the currently focused surface is reachable"
		)))
	}

	fn ax(&mut self) -> Option<&mut dyn AxBackend> {
		self.ax.as_mut().map(|ax| ax as &mut dyn AxBackend)
	}
}
