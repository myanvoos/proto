use atspi::{CoordType, ObjectRefOwned, Role, State, proxy::accessible::ObjectRefExt};
use tokio::runtime::{Builder, Runtime};

use crate::desktop::{
	ax::{AxBounds, AxHandle, AxProps, normalize_role_atspi},
	backend::AxBackend,
	error::{CoreResult, DesktopError},
	types::DesktopWindow,
};

pub struct AtSpiAx {
	rt:         Runtime,
	connection: atspi::AccessibilityConnection,
}

/// Leaves `focused` set on at most one window.
///
/// Shell surfaces report the Active state at all times: the compositor's own
/// frames (gnome-shell's "Main stage") and untitled frames (plasma-keyboard's).
/// When several windows are active, the compositor's frames drop out first,
/// then untitled ones, until one is left; a shell frame alone keeps focus, as
/// in the GNOME overview. When only untitled frames are left (an untitled app
/// beside plasma-keyboard), the one that `holds_focus` (contains the
/// keyboard-focused element) wins. Two active titled application windows leave
/// none focused, rather than naming one at random.
pub(crate) fn resolve_focus(
	windows: &mut [DesktopWindow],
	compositor_pid: Option<u32>,
	mut holds_focus: impl FnMut(&DesktopWindow) -> bool,
) {
	let mut active: Vec<usize> = (0..windows.len())
		.filter(|&index| windows[index].focused)
		.collect();
	if active.len() < 2 {
		return;
	}
	if let Some(pid) = compositor_pid {
		active.retain(|&index| windows[index].pid != Some(pid));
	}
	if active.len() > 1 {
		let titled: Vec<usize> = active
			.iter()
			.copied()
			.filter(|&index| !windows[index].title.trim().is_empty())
			.collect();
		active = if titled.is_empty() {
			active
				.into_iter()
				.filter(|&index| holds_focus(&windows[index]))
				.collect()
		} else {
			titled
		};
	}
	let focused = match active.as_slice() {
		[only] => Some(*only),
		_ => None,
	};
	for (index, window) in windows.iter_mut().enumerate() {
		if window.focused {
			window.focused = Some(index) == focused;
		}
	}
}

/// The id [`AtSpiAx::windows`] gives a frame, so a listed window can be
/// matched back to its AT-SPI object.
fn window_id(frame: &ObjectRefOwned) -> String {
	let name = frame.name().map_or_default(ToString::to_string);
	format!("atspi:{name}:{}", frame.path())
}

/// Generic press means activation, not action zero (GTK4 text views put
/// `buffer.delete-line` there). Explicit advertised actions remain available.
fn action_index<'a>(
	mut actions: impl Iterator<Item = &'a str> + Clone,
	requested: &str,
) -> Option<usize> {
	actions
		.clone()
		.position(|name| name.eq_ignore_ascii_case(requested))
		.or_else(|| {
			requested
				.eq_ignore_ascii_case("press")
				.then(|| {
					actions.position(|name| {
						[
							"click",
							"clickAncestor",
							"activate",
							"invoke",
							"toggle",
							"open",
							"jump",
							"do default",
							"do-default",
						]
						.iter()
						.any(|safe| name.eq_ignore_ascii_case(safe))
					})
				})
				.flatten()
		})
}

/// The most actions read of one element: the count comes from the app.
const MAX_ACTIONS: i32 = 256;

/// The machine names of an element's actions, by index (`press`, `click`,
/// `activate`): what libatspi's `atspi_action_get_action_name` reads.
/// `GetActions` returns localized names instead: Firefox reports each as `;;`,
/// Chromium, Electron and the GTK3 build of `LibreOffice` as empty strings, and
/// every toolkit translates them under a non-English locale.
async fn action_names(
	proxy: &atspi::proxy::action::ActionProxy<'_>,
) -> atspi::zbus::Result<Vec<String>> {
	let count = proxy.n_actions().await?.clamp(0, MAX_ACTIONS);
	futures::future::try_join_all((0..count).map(|index| proxy.get_name(index))).await
}

/// The index of `action` among `proxy`'s actions, matched by machine name. A
/// generic press of a checkbox, radio button or toggle button falls back on
/// `check` or `uncheck`, the only activation Chromium and Electron give them.
async fn resolve_action(
	proxy: &atspi::proxy::action::ActionProxy<'_>,
	accessible: &atspi::proxy::accessible::AccessibleProxy<'_>,
	action: &str,
) -> CoreResult<i32> {
	let names = action_names(proxy)
		.await
		.map_err(|err| DesktopError::ax_failed(format!("AT-SPI actions: {err}")))?;
	let names = || names.iter().map(String::as_str);
	let mut index = action_index(names(), action);
	if index.is_none()
		&& action.eq_ignore_ascii_case("press")
		&& matches!(
			accessible.get_role().await,
			Ok(Role::CheckBox
				| Role::CheckMenuItem
				| Role::RadioButton
				| Role::RadioMenuItem
				| Role::ToggleButton)
		) {
		index = names().position(|name| {
			name.eq_ignore_ascii_case("check") || name.eq_ignore_ascii_case("uncheck")
		});
	}
	let index = index
		.ok_or_else(|| DesktopError::ax_failed(format!("AT-SPI action '{action}' is unavailable")))?;
	i32::try_from(index).map_err(|err| DesktopError::ax_failed(err.to_string()))
}

impl AtSpiAx {
	pub(crate) fn new() -> CoreResult<Self> {
		let rt = Builder::new_current_thread()
			.enable_all()
			.build()
			.map_err(|err| DesktopError::ax_failed(format!("AT-SPI runtime: {err}")))?;
		let connection = rt
			.block_on(atspi::AccessibilityConnection::new())
			.map_err(|err| DesktopError::ax_failed(format!("AT-SPI connection: {err}")))?;
		Ok(Self { rt, connection })
	}

	const fn object(h: &AxHandle) -> &ObjectRefOwned {
		match h {
			AxHandle::AtSpi(object) => object,
		}
	}

	pub(crate) fn windows(&self) -> CoreResult<Vec<DesktopWindow>> {
		self.rt.block_on(async {
			let mut windows = Vec::new();
			for app in Self::apps(&self.connection)
				.await
				.map_err(DesktopError::ax_failed)?
			{
				let app_proxy = app
					.as_accessible_proxy(self.connection.connection())
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI application: {err}")))?;
				let app_name = app_proxy.name().await.unwrap_or_default();
				let pid = if let Some(bus_name) = app.name() {
					let dbus = atspi::zbus::fdo::DBusProxy::new(self.connection.connection())
						.await
						.ok();
					if let Some(dbus) = dbus {
						dbus
							.get_connection_unix_process_id(bus_name.clone().into())
							.await
							.ok()
					} else {
						None
					}
				} else {
					None
				};
				for frame in Self::frames(&self.connection, &app)
					.await
					.unwrap_or_default()
				{
					let frame_proxy = frame
						.as_accessible_proxy(self.connection.connection())
						.await
						.map_err(|err| DesktopError::ax_failed(format!("AT-SPI frame: {err}")))?;
					let title = frame_proxy.name().await.unwrap_or_default();
					let state = frame_proxy.get_state().await.ok();
					let Ok(component) = Self::component(&self.connection, &frame).await else {
						continue;
					};
					let Ok((x, y, width, height)) = component.get_extents(CoordType::Screen).await
					else {
						continue;
					};
					if width < 16 || height < 16 {
						continue;
					}
					let id = window_id(&frame);
					windows.push(DesktopWindow {
						id,
						title,
						app: app_name.clone(),
						pid,
						x,
						y,
						width: width as u32,
						height: height as u32,
						focused: state.as_ref().is_some_and(|states| {
							states.contains(State::Focused) || states.contains(State::Active)
						}),
					});
					if windows.len() == 48 {
						return Ok(windows);
					}
				}
			}
			Ok(windows)
		})
	}

	/// Whether the window's frame contains the keyboard-focused element. A
	/// lookup that fails counts as not holding focus.
	pub(crate) fn holds_focus(&self, window: &DesktopWindow) -> bool {
		self.rt.block_on(async {
			let Ok(app) = Self::app_for_window(&self.connection, window).await else {
				return false;
			};
			let Ok(frames) = Self::frames(&self.connection, &app).await else {
				return false;
			};
			for frame in frames {
				if window_id(&frame) == window.id {
					return Self::find_focused(self.connection.connection(), frame, 0)
						.await
						.is_ok_and(|found| found.is_some());
				}
			}
			false
		})
	}

	async fn apps(
		connection: &atspi::AccessibilityConnection,
	) -> Result<Vec<ObjectRefOwned>, String> {
		let root = connection
			.root_accessible_on_registry()
			.await
			.map_err(|err| err.to_string())?;
		root.get_children().await.map_err(|err| err.to_string())
	}

	async fn app_for_window(
		connection: &atspi::AccessibilityConnection,
		win: &DesktopWindow,
	) -> Result<ObjectRefOwned, String> {
		let apps = Self::apps(connection).await?;
		let mut name_match = None;
		for app in apps {
			let proxy = app
				.as_accessible_proxy(connection.connection())
				.await
				.map_err(|err| err.to_string())?;
			let name = proxy.name().await.unwrap_or_default();
			if name.eq_ignore_ascii_case(&win.app) || (!name.is_empty() && win.title.contains(&name)) {
				name_match = Some(app.clone());
			}
			if let Some(pid) = win.pid {
				let Some(bus_name) = app.name() else {
					continue;
				};
				let dbus = atspi::zbus::fdo::DBusProxy::new(connection.connection())
					.await
					.map_err(|err| err.to_string())?;
				if dbus
					.get_connection_unix_process_id(bus_name.clone().into())
					.await
					.ok()
					== Some(pid)
				{
					return Ok(app);
				}
			}
		}
		name_match.ok_or_else(|| format!("application '{}' (pid {:?}) not found", win.app, win.pid))
	}

	async fn frames(
		connection: &atspi::AccessibilityConnection,
		app: &ObjectRefOwned,
	) -> Result<Vec<ObjectRefOwned>, String> {
		let proxy = app
			.as_accessible_proxy(connection.connection())
			.await
			.map_err(|err| err.to_string())?;
		let children = proxy.get_children().await.map_err(|err| err.to_string())?;
		let mut frames = Vec::new();
		for child in children {
			let child_proxy = child
				.as_accessible_proxy(connection.connection())
				.await
				.map_err(|err| err.to_string())?;
			// `FileChooser` counts only here, as a child of the application:
			// GTK3 gives its Open and Save dialogs that role and gives it to the
			// file chooser widget inside them too. Inside a window it stays a
			// widget.
			if matches!(
				child_proxy.get_role().await,
				Ok(Role::Frame | Role::Dialog | Role::Window | Role::FileChooser)
			) {
				frames.push(child);
			}
		}
		Ok(frames)
	}

	async fn component<'a>(
		connection: &'a atspi::AccessibilityConnection,
		object: &'a ObjectRefOwned,
	) -> Result<atspi::proxy::component::ComponentProxy<'a>, String> {
		let name = object
			.name()
			.ok_or_else(|| "AT-SPI object has no bus name".to_string())?
			.clone();
		atspi::proxy::component::ComponentProxy::builder(connection.connection())
			.destination(name)
			.map_err(|err| err.to_string())?
			.path(object.path().clone())
			.map_err(|err| err.to_string())?
			.build()
			.await
			.map_err(|err| err.to_string())
	}

	async fn action<'a>(
		connection: &'a atspi::AccessibilityConnection,
		object: &'a ObjectRefOwned,
	) -> Result<atspi::proxy::action::ActionProxy<'a>, String> {
		let name = object
			.name()
			.ok_or_else(|| "AT-SPI object has no bus name".to_string())?
			.clone();
		atspi::proxy::action::ActionProxy::builder(connection.connection())
			.destination(name)
			.map_err(|err| err.to_string())?
			.path(object.path().clone())
			.map_err(|err| err.to_string())?
			// The property cache reads `GetAll`, which Qt refuses, so `NActions`
			// would fail on every Qt element.
			.cache_properties(atspi::zbus::proxy::CacheProperties::No)
			.build()
			.await
			.map_err(|err| err.to_string())
	}

	async fn find_focused(
		connection: &atspi::zbus::Connection,
		root: ObjectRefOwned,
		depth: u8,
	) -> Result<Option<ObjectRefOwned>, String> {
		if depth > 40 || root.is_null() {
			return Ok(None);
		}
		let proxy = root
			.as_accessible_proxy(connection)
			.await
			.map_err(|err| err.to_string())?;
		if proxy
			.get_state()
			.await
			.is_ok_and(|state| state.contains(State::Focused))
		{
			return Ok(Some(root));
		}
		for child in proxy.get_children().await.unwrap_or_default() {
			if let Some(found) = Box::pin(Self::find_focused(connection, child, depth + 1)).await? {
				return Ok(Some(found));
			}
		}
		Ok(None)
	}
}

impl AxBackend for AtSpiAx {
	fn window_root(&mut self, win: &DesktopWindow) -> CoreResult<AxHandle> {
		let result = self.rt.block_on(async {
			let app = Self::app_for_window(&self.connection, win).await?;
			let frames = Self::frames(&self.connection, &app).await?;
			let mut first = None;
			for frame in frames {
				if first.is_none() {
					first = Some(frame.clone());
				}
				let proxy = frame
					.as_accessible_proxy(self.connection.connection())
					.await
					.map_err(|err| err.to_string())?;
				if proxy.name().await.unwrap_or_default() == win.title {
					return Ok(frame);
				}
			}
			first.ok_or_else(|| format!("no frame or dialog found for '{}'", win.title))
		});
		result
			.map(AxHandle::AtSpi)
			.map_err(|err: String| DesktopError::ax_failed(format!("AT-SPI window root: {err}")))
	}

	fn props(&mut self, h: &AxHandle) -> CoreResult<AxProps> {
		let object = Self::object(h).clone();
		self.rt.block_on(async {
			let proxy = object
				.as_accessible_proxy(self.connection.connection())
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI accessible: {err}")))?;
			let title = proxy.name().await.ok().filter(|s| !s.is_empty());
			let description = proxy.description().await.ok().filter(|s| !s.is_empty());
			let native_role = match proxy.get_role_name().await {
				Ok(role) => role,
				Err(_) => proxy
					.get_localized_role_name()
					.await
					.unwrap_or_else(|_| "unknown".to_string()),
			};
			let state = proxy.get_state().await.ok();
			let multiline = state
				.as_ref()
				.is_some_and(|states| states.contains(State::MultiLine));
			let value = if let Some(name) = object.name().cloned() {
				let builder = atspi::proxy::text::TextProxy::builder(self.connection.connection())
					.destination(name)
					.and_then(|builder| builder.path(object.path().clone()));
				if let Ok(builder) = builder {
					if let Ok(text) = builder.build().await {
						let count = text.character_count().await.unwrap_or(0).min(16_384);
						text.get_text(0, count).await.ok().filter(|s| !s.is_empty())
					} else {
						None
					}
				} else {
					None
				}
			} else {
				None
			};
			let bounds = if let Ok(component) = Self::component(&self.connection, &object).await {
				component
					.get_extents(CoordType::Screen)
					.await
					.ok()
					.and_then(|(x, y, width, height)| {
						(width >= 0 && height >= 0).then_some(AxBounds {
							x:      f64::from(x),
							y:      f64::from(y),
							width:  f64::from(width),
							height: f64::from(height),
						})
					})
			} else {
				None
			};
			let actions = match Self::action(&self.connection, &object).await {
				Ok(action) => action_names(&action).await.unwrap_or_default(),
				Err(_) => Vec::new(),
			};
			let child_count = proxy.child_count().await.unwrap_or(0).max(0) as u32;
			Ok(AxProps {
				role: normalize_role_atspi(&native_role, multiline),
				native_role,
				title,
				value,
				description,
				enabled: state
					.as_ref()
					.is_some_and(|states| states.contains(State::Enabled)),
				focused: state
					.as_ref()
					.is_some_and(|states| states.contains(State::Focused)),
				bounds,
				actions,
				child_count,
			})
		})
	}

	fn children(&mut self, h: &AxHandle) -> CoreResult<Vec<AxHandle>> {
		let object = Self::object(h).clone();
		self.rt.block_on(async {
			let proxy = object
				.as_accessible_proxy(self.connection.connection())
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI children: {err}")))?;
			proxy
				.get_children()
				.await
				.map(|items| {
					items
						.into_iter()
						.filter(|item| !item.is_null())
						.map(AxHandle::AtSpi)
						.collect()
				})
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI children: {err}")))
		})
	}

	fn parent(&mut self, h: &AxHandle) -> CoreResult<Option<AxHandle>> {
		let object = Self::object(h).clone();
		self.rt.block_on(async {
			let proxy = object
				.as_accessible_proxy(self.connection.connection())
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI parent: {err}")))?;
			let parent = proxy
				.parent()
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI parent: {err}")))?;
			Ok((!parent.is_null()).then_some(AxHandle::AtSpi(parent)))
		})
	}

	fn perform(&mut self, h: &AxHandle, action: &str) -> CoreResult<()> {
		let object = Self::object(h).clone();
		self.rt.block_on(async {
			let proxy = Self::action(&self.connection, &object)
				.await
				.map_err(DesktopError::ax_failed)?;
			let accessible = object
				.as_accessible_proxy(self.connection.connection())
				.await
				.map_err(|err| DesktopError::ax_failed(err.to_string()))?;
			let index = resolve_action(&proxy, &accessible, action).await?;
			if proxy
				.do_action(index)
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI action: {err}")))?
			{
				Ok(())
			} else {
				Err(DesktopError::ax_failed(format!("AT-SPI action '{action}' failed")))
			}
		})
	}

	fn set_value(&mut self, h: &AxHandle, value: &str) -> CoreResult<()> {
		let object = Self::object(h).clone();
		self.rt.block_on(async {
			let name = object
				.name()
				.ok_or_else(|| DesktopError::ax_failed("AT-SPI object has no bus name"))?
				.clone();
			let editable =
				atspi::proxy::editable_text::EditableTextProxy::builder(self.connection.connection())
					.destination(name.clone())
					.and_then(|b| b.path(object.path().clone()))
					.map_err(|err| DesktopError::ax_failed(err.to_string()))?
					.build()
					.await;
			if let Ok(editable) = editable
				&& editable
					.set_text_contents(value)
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI text value: {err}")))?
			{
				return Ok(());
			}
			let numeric = value.parse::<f64>().map_err(|_| {
				DesktopError::ax_failed("AT-SPI value is not editable text or a number")
			})?;
			let proxy = atspi::proxy::value::ValueProxy::builder(self.connection.connection())
				.destination(name)
				.and_then(|b| b.path(object.path().clone()))
				.map_err(|err| DesktopError::ax_failed(err.to_string()))?
				.build()
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI value: {err}")))?;
			proxy
				.set_current_value(numeric)
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI value: {err}")))
		})
	}

	fn focus(&mut self, h: &AxHandle) -> CoreResult<()> {
		let object = Self::object(h).clone();
		self.rt.block_on(async {
			let component = Self::component(&self.connection, &object)
				.await
				.map_err(DesktopError::ax_failed)?;
			if component
				.grab_focus()
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI focus: {err}")))?
			{
				Ok(())
			} else {
				Err(DesktopError::ax_failed("AT-SPI focus request was rejected"))
			}
		})
	}

	fn element_at(&mut self, x: f64, y: f64) -> CoreResult<Option<AxHandle>> {
		let x = x.round() as i32;
		let y = y.round() as i32;
		self.rt.block_on(async {
			for app in Self::apps(&self.connection)
				.await
				.map_err(DesktopError::ax_failed)?
			{
				for frame in Self::frames(&self.connection, &app)
					.await
					.unwrap_or_default()
				{
					let Ok(component) = Self::component(&self.connection, &frame).await else {
						continue;
					};
					if !component
						.contains(x, y, CoordType::Screen)
						.await
						.unwrap_or(false)
					{
						continue;
					}
					let found = component
						.get_accessible_at_point(x, y, CoordType::Screen)
						.await
						.map_err(|err| {
							DesktopError::ax_failed(format!("AT-SPI element at point: {err}"))
						})?;
					return Ok((!found.is_null()).then_some(AxHandle::AtSpi(found)));
				}
			}
			Ok(None)
		})
	}

	fn focused_element(&mut self) -> CoreResult<Option<AxHandle>> {
		self.rt.block_on(async {
			for app in Self::apps(&self.connection)
				.await
				.map_err(DesktopError::ax_failed)?
			{
				if let Some(found) = Self::find_focused(self.connection.connection(), app, 0)
					.await
					.map_err(DesktopError::ax_failed)?
				{
					return Ok(Some(AxHandle::AtSpi(found)));
				}
			}
			Ok(None)
		})
	}

	fn attributes(&mut self, h: &AxHandle) -> CoreResult<Vec<(String, String)>> {
		let object = Self::object(h).clone();
		self.rt.block_on(async {
			let proxy = object
				.as_accessible_proxy(self.connection.connection())
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI attributes: {err}")))?;
			let mut attrs: Vec<_> = proxy
				.get_attributes()
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI attributes: {err}")))?
				.into_iter()
				.map(|(key, mut value)| {
					value.truncate(200);
					(key, value)
				})
				.collect();
			attrs.sort_by(|a, b| a.0.cmp(&b.0));
			Ok(attrs)
		})
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// `computer.focusedWindow()` must name the user's application, not the
	/// compositor's always-active shell frame or a keyboard helper's untitled
	/// frame: the host picks the first window reporting focus.
	#[test]
	fn shell_frames_yield_focus_to_the_active_application_window() {
		let frame = |title: &str, pid: u32, focused: bool| DesktopWindow {
			id: format!("{title}-{pid}"),
			pid: Some(pid),
			title: title.into(),
			app: "app".into(),
			x: 0,
			y: 0,
			width: 100,
			height: 100,
			focused,
		};
		let focused_ids = |windows: &[DesktopWindow]| -> Vec<String> {
			windows
				.iter()
				.filter(|window| window.focused)
				.map(|window| window.id.clone())
				.collect()
		};
		let no_lookup = |_: &DesktopWindow| -> bool { panic!("focus lookup was not needed") };

		// GNOME: gnome-shell (the compositor, pid 1) keeps its "Main stage"
		// active.
		let mut gnome = vec![frame("Main stage", 1, true), frame("notes.txt - gedit", 7, true)];
		resolve_focus(&mut gnome, Some(1), no_lookup);
		assert_eq!(focused_ids(&gnome), ["notes.txt - gedit-7"]);

		// KDE: plasma-keyboard's untitled frame stays active.
		let mut kde = vec![frame("", 5, true), frame("notes.txt — Kate", 8, true)];
		resolve_focus(&mut kde, None, no_lookup);
		assert_eq!(focused_ids(&kde), ["notes.txt — Kate-8"]);

		// The GNOME overview: only the shell is active, and it keeps focus.
		let mut overview = vec![frame("Main stage", 1, true), frame("notes.txt - gedit", 7, false)];
		resolve_focus(&mut overview, Some(1), no_lookup);
		assert_eq!(focused_ids(&overview), ["Main stage-1"]);

		// Two active application windows: none is named.
		let mut two = vec![frame("Main stage", 1, true), frame("A", 7, true), frame("B", 9, true)];
		resolve_focus(&mut two, Some(1), no_lookup);
		assert!(focused_ids(&two).is_empty());

		// KDE with an untitled app beside plasma-keyboard: the frame holding
		// keyboard focus wins.
		let mut kde_untitled = vec![frame("", 5, true), frame("", 8, true)];
		resolve_focus(&mut kde_untitled, None, |window| window.pid == Some(8));
		assert_eq!(focused_ids(&kde_untitled), ["-8"]);
	}

	#[test]
	fn focused_search_skips_null_child_refs() {
		use atspi::zbus::{
			self, connection::Builder as ConnectionBuilder, interface, zvariant::OwnedObjectPath,
		};

		/// Minimal `org.a11y.atspi.Accessible` node: a state set plus `(name,
		/// path)` children.
		struct Node {
			state:    Vec<u32>,
			children: Vec<(String, OwnedObjectPath)>,
		}

		#[interface(name = "org.a11y.atspi.Accessible", crate = "atspi::zbus")]
		impl Node {
			fn get_state(&self) -> Vec<u32> {
				self.state.clone()
			}

			fn get_children(&self) -> Vec<(String, OwnedObjectPath)> {
				self.children.clone()
			}
		}

		const PEER: &str = ":1.7";
		let path = |p: &str| OwnedObjectPath::try_from(p).unwrap();
		let focused = State::Focused as u64;
		let rt = Builder::new_current_thread().enable_all().build().unwrap();
		let found = rt.block_on(async {
			let (client, server) = tokio::net::UnixStream::pair().unwrap();
			let root = Node {
				state:    vec![0, 0],
				// Chromium frames report children that are all the AT-SPI null object.
				children: vec![
					(PEER.to_owned(), path("/org/a11y/atspi/null")),
					(PEER.to_owned(), path("/focus")),
				],
			};
			let leaf =
				Node { state: vec![focused as u32, (focused >> 32) as u32], children: Vec::new() };
			let guid = atspi::zbus::Guid::generate();
			let server = ConnectionBuilder::unix_stream(server)
				.server(guid)
				.unwrap()
				.p2p()
				.serve_at("/root", root)
				.unwrap()
				.serve_at("/focus", leaf)
				.unwrap()
				.build();
			let client = ConnectionBuilder::unix_stream(client).p2p().build();
			let (server, client) = tokio::try_join!(server, client).unwrap();
			let root = ObjectRefOwned::from_static_str_unchecked(PEER, "/root");
			let found = AtSpiAx::find_focused(&client, root, 0).await;
			drop(server);
			found
		});
		let found = found.expect("null child refs must not fail the focused search");
		assert_eq!(
			found
				.map(|object| object.path_as_str().to_owned())
				.as_deref(),
			Some("/focus")
		);
	}
}
