//! The `protolens` device bridge: the callout contract the coding agent
//! implements over its tool registry, and the `protolens://` filesystem
//! provider the shell reads devices through.
//!
//! The bridge is per run: [`Shell::run`](crate::Shell::run) hands it the
//! agent's dispatcher and call id, the [`protolens`](crate::tools) callout
//! dispatches through it, and the run collects the opaque records it appends.
//! The provider resolves `protolens://<device>` and `protolens://` (the
//! device listing) before any pi-vfs provider or host path: it is generated
//! content, never a filesystem path.

use std::{
	fmt,
	future::Future,
	io,
	path::{Path, PathBuf},
	pin::Pin,
	sync::Arc,
};

use async_trait::async_trait;
use parking_lot::Mutex;
use pi_vfs::{
	DirEntry, File, FileHandle, FileKind, FileSystem, FileTime, Metadata, OpenOptions, Permissions,
	ReadDir, SymlinkKind, read_only_filesystem,
};

/// Request delivered to the agent's dispatcher.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtolensDispatchRequest {
	pub name:            Option<String>,
	pub args:            Vec<String>,
	pub stdin:           String,
	pub stdin_truncated: bool,
	pub stage_index:     Option<usize>,
	pub cwd:             String,
	pub call_id:         Option<String>,
}

/// Text streams and metadata returned by the agent's dispatcher.
#[derive(Debug, Clone, Default)]
pub struct ProtolensDispatchResponse {
	pub stdout:    String,
	pub stderr:    String,
	pub exit_code: i32,
	/// Opaque JSON record retained outside shell stdout/stderr pipes.
	pub record:    Option<String>,
}

/// The dispatcher's future.
pub type ProtolensDispatchFuture =
	Pin<Box<dyn Future<Output = anyhow::Result<ProtolensDispatchResponse>> + Send>>;

/// The agent side of `protolens`: one dispatch per device call.
pub trait ProtolensDispatcher: Send + Sync {
	fn dispatch(&self, request: ProtolensDispatchRequest) -> ProtolensDispatchFuture;
}

#[derive(Default)]
struct BridgeState {
	dispatcher: Option<Arc<dyn ProtolensDispatcher>>,
	call_id:    Option<String>,
	records:    Vec<String>,
}

/// The per-run dispatcher, call id and opaque dispatch records. Cheap to
/// clone; clones share the state.
#[derive(Clone, Default)]
pub struct ProtolensBridge(Arc<Mutex<BridgeState>>);

impl fmt::Debug for ProtolensBridge {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		let state = self.0.lock();
		f.debug_struct("ProtolensBridge")
			.field("attached", &state.dispatcher.is_some())
			.field("call_id", &state.call_id)
			.field("records", &state.records.len())
			.finish()
	}
}

impl ProtolensBridge {
	/// An unattached bridge.
	pub fn new() -> Self {
		Self::default()
	}

	/// Attach `dispatcher` for the next run; clears the previous records.
	pub fn set(&self, dispatcher: Option<Arc<dyn ProtolensDispatcher>>, call_id: Option<String>) {
		let mut state = self.0.lock();
		state.dispatcher = dispatcher;
		state.call_id = call_id;
		state.records.clear();
	}

	/// The attached dispatcher, if any.
	pub fn dispatcher(&self) -> Option<Arc<dyn ProtolensDispatcher>> {
		self.0.lock().dispatcher.clone()
	}

	/// The call id of the run in flight.
	pub fn call_id(&self) -> Option<String> {
		self.0.lock().call_id.clone()
	}

	/// Append an opaque record from a successful dispatch.
	pub fn push_record(&self, record: String) {
		self.0.lock().records.push(record);
	}

	/// Take the records of the run that just ended.
	pub fn take_records(&self) -> Vec<String> {
		std::mem::take(&mut self.0.lock().records)
	}
}

/// The current working directory the provider reports to a dispatch.
#[derive(Clone, Debug, Default)]
pub struct ProtolensCwd(Arc<Mutex<String>>);

impl ProtolensCwd {
	/// The directory `read`/`cat` requests name.
	pub fn set(&self, cwd: impl Into<String>) {
		*self.0.lock() = cwd.into();
	}

	/// The current directory (the process's until a run sets one).
	pub fn get(&self) -> String {
		let cwd = self.0.lock();
		if cwd.is_empty() {
			std::env::current_dir()
				.map_or_else(|_| "/".to_owned(), |cwd| cwd.to_string_lossy().into_owned())
		} else {
			cwd.clone()
		}
	}
}

/// `protolens://` over an existing pi-vfs filesystem.
///
/// Everything that is not a `protolens://` path delegates to `inner`, so the
/// session's own providers (and native fast paths) keep working.
pub struct ProtolensProvider {
	inner:  pi_vfs::Fs,
	bridge: ProtolensBridge,
	cwd:    ProtolensCwd,
}

impl fmt::Debug for ProtolensProvider {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("ProtolensProvider")
			.field("inner", &self.inner)
			.finish()
	}
}

impl ProtolensProvider {
	/// Serve `protolens://` through `bridge`, delegating everything else to
	/// `inner`.
	pub const fn new(inner: pi_vfs::Fs, bridge: ProtolensBridge, cwd: ProtolensCwd) -> Self {
		Self { inner, bridge, cwd }
	}

	/// Dispatch one device (or the listing when `name` is `None`).
	async fn dispatch(
		&self,
		name: Option<String>,
		args: Vec<String>,
		stdin: String,
		stdin_truncated: bool,
		stage_index: Option<usize>,
	) -> io::Result<ProtolensDispatchResponse> {
		let Some(dispatcher) = self.bridge.dispatcher() else {
			return Err(io::Error::new(
				io::ErrorKind::NotFound,
				"protolens: no agent dispatcher is attached",
			));
		};
		let request = ProtolensDispatchRequest {
			name,
			args,
			stdin,
			stdin_truncated,
			stage_index,
			cwd: self.cwd.get(),
			call_id: self.bridge.call_id(),
		};
		let response = dispatcher
			.dispatch(request)
			.await
			.map_err(|error| io::Error::other(format!("protolens: dispatcher failed: {error}")))?;
		if response.exit_code != 0 {
			let message = if response.stderr.is_empty() {
				format!("protolens: dispatch exited {}", response.exit_code)
			} else {
				response.stderr.trim_end().to_owned()
			};
			return Err(io::Error::other(message));
		}
		Ok(response)
	}

	async fn device(&self, path: &Path) -> io::Result<ProtolensDispatchResponse> {
		let name = device_name(path).ok_or_else(|| {
			io::Error::new(
				io::ErrorKind::NotFound,
				format!("{}: not a protolens device", path.display()),
			)
		})?;
		self
			.dispatch(name, Vec::new(), String::new(), false, None)
			.await
	}
}

/// Whether `path` is a `protolens://` URL.
pub fn is_protolens_path(path: &Path) -> bool {
	path
		.to_str()
		.is_some_and(|text| text.starts_with("protolens://"))
}

/// The device a `protolens://` path names (`None` for the listing root).
#[allow(
	clippy::option_option,
	reason = "the outer `None` means the path is not a protolens path; `Some(None)` is the listing \
	          root"
)]
fn device_name(path: &Path) -> Option<Option<String>> {
	let text = path.to_str()?;
	let rest = text.strip_prefix("protolens://")?;
	if rest.is_empty() || rest == "/" {
		return Some(None);
	}
	if rest.contains(['/', '?', '#']) {
		return None;
	}
	Some(Some(rest.to_owned()))
}

/// The devices a listing record names.
fn listing_devices(record: Option<&str>) -> Vec<(String, Option<String>)> {
	let Some(record) = record else {
		return Vec::new();
	};
	let Ok(value) = serde_json::from_str::<serde_json::Value>(record) else {
		return Vec::new();
	};
	let Some(devices) = value
		.get("xdev")
		.and_then(|xdev| xdev.get("devices"))
		.and_then(|d| d.as_array())
	else {
		return Vec::new();
	};
	devices
		.iter()
		.filter_map(|device| {
			let name = device.get("name")?.as_str()?.to_owned();
			let summary = device
				.get("summary")
				.and_then(|s| s.as_str())
				.map(str::to_owned);
			Some((name, summary))
		})
		.collect()
}

#[async_trait]
impl FileSystem for ProtolensProvider {
	fn is_native_local(&self, path: &Path) -> bool {
		!is_protolens_path(path) && self.inner.is_native_local(path)
	}

	async fn backing_path(&self, path: &Path) -> io::Result<Option<PathBuf>> {
		if is_protolens_path(path) {
			return Ok(None);
		}
		self.inner.backing_path(path).await
	}

	async fn open(&self, path: &Path, options: &OpenOptions) -> io::Result<File> {
		if !is_protolens_path(path) {
			return self.inner.open_with(path, options).await;
		}
		if options.is_write() || options.is_append() || options.is_truncate() || options.is_create() {
			return Err(read_only_filesystem());
		}
		let response = self.device(path).await?;
		Ok(File::from_handle(MemoryFile::new(response.stdout.into_bytes())))
	}

	async fn metadata(&self, path: &Path) -> io::Result<Metadata> {
		if !is_protolens_path(path) {
			return self.inner.metadata(path).await;
		}
		if device_name(path).is_none() {
			return Err(io::Error::new(io::ErrorKind::NotFound, "not a protolens device"));
		}
		if matches!(device_name(path), Some(None)) {
			return Ok(Metadata::new(
				pi_vfs::FileType::from_kind(FileKind::Dir),
				0,
				Permissions::from_mode(0o555),
			));
		}
		let response = self.device(path).await?;
		Ok(Metadata::new(
			pi_vfs::FileType::from_kind(FileKind::File),
			response.stdout.len() as u64,
			Permissions::from_mode(0o444),
		))
	}

	async fn symlink_metadata(&self, path: &Path) -> io::Result<Metadata> {
		if is_protolens_path(path) {
			return self.metadata(path).await;
		}
		self.inner.symlink_metadata(path).await
	}

	async fn read_dir(&self, path: &Path) -> io::Result<ReadDir> {
		if !is_protolens_path(path) {
			return self.inner.read_dir(path).await;
		}
		if !matches!(device_name(path), Some(None)) {
			return Err(io::Error::new(io::ErrorKind::NotADirectory, "not a protolens listing"));
		}
		let response = self
			.dispatch(None, Vec::new(), String::new(), false, None)
			.await?;
		let entries = listing_devices(response.record.as_deref())
			.into_iter()
			.map(|(name, _)| {
				let entry = PathBuf::from(format!("protolens://{name}"));
				Ok(DirEntry::new(entry, name.into(), Some(pi_vfs::FileType::from_kind(FileKind::File))))
			})
			.collect::<Vec<_>>();
		Ok(ReadDir::from_entries(entries))
	}

	async fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
		if !is_protolens_path(path) {
			return self.inner.read(path).await;
		}
		Ok(self.device(path).await?.stdout.into_bytes())
	}

	async fn access(&self, path: &Path, read: bool, write: bool, execute: bool) -> io::Result<()> {
		if is_protolens_path(path) {
			if write {
				return Err(read_only_filesystem());
			}
			device_name(path)
				.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "not a protolens device"))?;
			return Ok(());
		}
		self.inner.access(path, read, write, execute).await
	}

	async fn canonicalize(
		&self,
		path: &Path,
		options: &pi_vfs::CanonicalizeOptions,
	) -> io::Result<PathBuf> {
		if is_protolens_path(path) {
			return Ok(path.to_path_buf());
		}
		self.inner.canonicalize_with(path, options).await
	}

	async fn create_dir(&self, path: &Path, mode: Option<u32>) -> io::Result<()> {
		if is_protolens_path(path) {
			return Err(read_only_filesystem());
		}
		self.inner.create_dir_with(path, &mode_options(mode)).await
	}

	async fn remove_file(&self, path: &Path) -> io::Result<()> {
		if is_protolens_path(path) {
			return Err(read_only_filesystem());
		}
		self.inner.remove_file(path).await
	}

	async fn remove_dir(&self, path: &Path) -> io::Result<()> {
		if is_protolens_path(path) {
			return Err(read_only_filesystem());
		}
		self.inner.remove_dir(path).await
	}

	async fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
		if is_protolens_path(from) || is_protolens_path(to) {
			return Err(read_only_filesystem());
		}
		self.inner.rename(from, to).await
	}

	async fn copy(&self, from: &Path, to: &Path) -> io::Result<u64> {
		if is_protolens_path(from) || is_protolens_path(to) {
			return Err(read_only_filesystem());
		}
		self.inner.copy(from, to).await
	}

	async fn hard_link(&self, original: &Path, link: &Path) -> io::Result<()> {
		if is_protolens_path(original) || is_protolens_path(link) {
			return Err(read_only_filesystem());
		}
		self.inner.hard_link(original, link).await
	}

	async fn symlink(&self, target: &Path, link: &Path, kind: SymlinkKind) -> io::Result<()> {
		if is_protolens_path(target) || is_protolens_path(link) {
			return Err(read_only_filesystem());
		}
		self.inner.symlink_with(target, link, kind).await
	}

	async fn set_permissions(&self, path: &Path, permissions: Permissions) -> io::Result<()> {
		if is_protolens_path(path) {
			return Err(read_only_filesystem());
		}
		self.inner.set_permissions(path, permissions).await
	}

	async fn set_times(
		&self,
		path: &Path,
		accessed: FileTime,
		modified: FileTime,
		follow: bool,
	) -> io::Result<()> {
		if is_protolens_path(path) {
			return Err(read_only_filesystem());
		}
		self.inner.set_times(path, accessed, modified, follow).await
	}

	async fn chown(
		&self,
		path: &Path,
		uid: Option<u32>,
		gid: Option<u32>,
		follow: bool,
	) -> io::Result<()> {
		if is_protolens_path(path) {
			return Err(read_only_filesystem());
		}
		self.inner.chown(path, uid, gid, follow).await
	}
}

const fn mode_options(mode: Option<u32>) -> pi_vfs::DirOptions {
	let mut options = pi_vfs::DirOptions::new();
	if let Some(mode) = mode {
		options = options.mode(mode);
	}
	options
}

/// An in-memory read-only file.
#[derive(Debug)]
struct MemoryFile {
	data: Vec<u8>,
	pos:  Mutex<u64>,
}

impl MemoryFile {
	const fn new(data: Vec<u8>) -> Self {
		Self { data, pos: Mutex::new(0) }
	}
}

#[async_trait]
impl FileHandle for MemoryFile {
	async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
		let mut pos = self.pos.lock();
		let start = usize::try_from(*pos).unwrap_or(usize::MAX);
		if start >= self.data.len() {
			return Ok(0);
		}
		let n = buf.len().min(self.data.len() - start);
		buf[..n].copy_from_slice(&self.data[start..start + n]);
		*pos += n as u64;
		Ok(n)
	}

	async fn write(&self, _buf: &[u8]) -> io::Result<usize> {
		Err(read_only_filesystem())
	}

	async fn seek(&self, pos: std::io::SeekFrom) -> io::Result<u64> {
		use std::io::SeekFrom;
		let mut current = self.pos.lock();
		let len = self.data.len() as u64;
		let next = match pos {
			SeekFrom::Start(to) => to,
			SeekFrom::Current(by) => current.saturating_add_signed(by),
			SeekFrom::End(by) => len.saturating_add_signed(by),
		};
		*current = next;
		Ok(next)
	}

	async fn metadata(&self) -> io::Result<Metadata> {
		Ok(Metadata::new(
			pi_vfs::FileType::from_kind(FileKind::File),
			self.data.len() as u64,
			Permissions::from_mode(0o444),
		))
	}
}
