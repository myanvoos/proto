use std::{
	collections::BTreeMap,
	fs::Metadata,
	path::{Path, PathBuf},
	sync::{Arc, Mutex},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FsObservationKind {
	Read,
	Write,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileStamp {
	pub mtime_ns: i64,
	pub size:     u64,
}

impl FileStamp {
	#[cfg(unix)]
	pub fn of(metadata: &Metadata) -> Self {
		use std::os::unix::fs::MetadataExt;
		Self {
			mtime_ns: metadata.mtime() * 1_000_000_000 + metadata.mtime_nsec(),
			size:     metadata.size(),
		}
	}

	#[cfg(not(unix))]
	pub fn of(metadata: &Metadata) -> Self {
		let mtime_ns = metadata
			.modified()
			.ok()
			.and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
			.and_then(|elapsed| i64::try_from(elapsed.as_nanos()).ok())
			.unwrap_or_default();
		Self { mtime_ns, size: metadata.len() }
	}
}

/// Text snapshots are deliberately bounded; binary and large files still carry stamps.
const MAX_SNAPSHOT_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileMutation {
	pub existed: bool,
	pub exists: bool,
	pub before: Option<String>,
	pub after: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FsObservation {
	pub path: PathBuf,
	pub kind: FsObservationKind,
	pub stamp: Option<FileStamp>,
	pub mutation: Option<FileMutation>,
}

#[derive(Debug, Default)]
struct ObservationState {
	recorded: Vec<FsObservation>,
	/// Canonical identities make reads through symlinks guard writes through aliases.
	history: BTreeMap<PathBuf, Option<FileStamp>>,
	observed_paths: BTreeMap<PathBuf, PathBuf>,
	/// Own writes may change stamps repeatedly before the result is drained.
	writing: std::collections::BTreeSet<PathBuf>,
}

#[derive(Clone, Debug, Default)]
pub struct FsObservationLog(Arc<Mutex<ObservationState>>);

fn identity(path: &Path) -> PathBuf {
	std::fs::canonicalize(path).unwrap_or_else(|_| {
		match (path.parent().and_then(|p| std::fs::canonicalize(p).ok()), path.file_name()) {
			(Some(parent), Some(name)) => parent.join(name),
			_ => path.to_path_buf(),
		}
	})
}

fn snapshot(path: &Path) -> Option<String> {
	use std::io::Read;
	let metadata = std::fs::metadata(path).ok()?;
	if !metadata.is_file() || metadata.len() > MAX_SNAPSHOT_BYTES {
		return None;
	}
	let mut options = std::fs::OpenOptions::new();
	options.read(true);
	// A path can be replaced after metadata(): never block on a substituted FIFO/device.
	#[cfg(unix)]
	{
		use std::os::unix::fs::OpenOptionsExt;
		options.custom_flags(libc::O_NONBLOCK | libc::O_NOCTTY);
	}
	let file = options.open(path).ok()?;
	let metadata = file.metadata().ok()?;
	if !metadata.is_file() || metadata.len() > MAX_SNAPSHOT_BYTES {
		return None;
	}
	let mut bytes = Vec::new();
	file.take(MAX_SNAPSHOT_BYTES + 1).read_to_end(&mut bytes).ok()?;
	if bytes.len() as u64 > MAX_SNAPSHOT_BYTES {
		return None;
	}
	String::from_utf8(bytes).ok()
}

impl FsObservationLog {
	pub fn record_read(&self, path: impl Into<PathBuf>) {
		let path = path.into();
		if let Ok(metadata) = std::fs::metadata(&path) {
			self.record_read_of(path, &metadata);
		}
	}

	pub fn record_read_of(&self, path: impl Into<PathBuf>, metadata: &Metadata) {
		if metadata.is_file() {
			let path = path.into();
			let stamp = Some(FileStamp::of(metadata));
			let mut state = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
			let key = identity(&path);
			state.observed_paths.insert(path.clone(), key.clone());
			state.history.insert(key, stamp);
			state.recorded.push(FsObservation {
				path, kind: FsObservationKind::Read, stamp, mutation: None,
			});
		}
	}

	/// Check before opening/truncating. Commit only once the shell's open succeeds.
	pub fn prepare_write(&self, path: &Path) -> std::io::Result<Option<FsObservation>> {
		let key = identity(path);
		let metadata = match std::fs::metadata(path) {
			Ok(metadata) => Some(metadata),
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
			Err(_) => return Ok(None),
		};
		let stamp = metadata.as_ref().filter(|m| m.is_file()).map(FileStamp::of);
		let state = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
		if !state.writing.contains(&key) && !state.writing.contains(path)
			&& (state.history.get(&key).is_some_and(|previous| *previous != stamp)
				|| state.observed_paths.get(path).is_some_and(|previous| *previous != key))
		{
			return Err(std::io::Error::other(
				"StaleWriteError: file changed since this shell last read or wrote it; reread before redirecting output",
			));
		}
		drop(state);
		if metadata.as_ref().is_some_and(|m| !m.is_file()) {
			return Ok(None);
		}
		Ok(Some(FsObservation {
			path: path.to_path_buf(), kind: FsObservationKind::Write, stamp: None,
			mutation: Some(FileMutation {
				existed: metadata.is_some(), exists: true, before: snapshot(path), after: None,
			}),
		}))
	}

	pub fn commit_write(&self, observation: Option<FsObservation>) {
		if let Some(observation) = observation {
			let mut state = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
			let key = identity(&observation.path);
			state.observed_paths.insert(observation.path.clone(), key.clone());
			state.writing.insert(key);
			state.writing.insert(observation.path.clone());
			state.recorded.push(observation);
		}
	}

	pub fn record_write(&self, path: impl Into<PathBuf>) {
		self.commit_write(Some(FsObservation {
			path: path.into(), kind: FsObservationKind::Write, stamp: None, mutation: None,
		}));
	}

	pub fn drain(&self) -> Vec<FsObservation> {
		let mut state = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
		let recorded = std::mem::take(&mut state.recorded);
		let mut latest: BTreeMap<PathBuf, FsObservation> = BTreeMap::new();
		for observation in recorded {
			let key = identity(&observation.path);
			if let Some(previous) = latest.get_mut(&key) {
				// A later read must not erase a write receipt, nor a later write its original before.
				if observation.kind == FsObservationKind::Write {
					previous.kind = FsObservationKind::Write;
					previous.path = observation.path;
				}
				if previous.mutation.is_none() {
					previous.mutation = observation.mutation;
				}
				previous.stamp = observation.stamp;
			} else {
				latest.insert(key, observation);
			}
		}
		let mut result = Vec::new();
		for (key, mut observation) in latest {
			if observation.kind == FsObservationKind::Write {
				let metadata = std::fs::metadata(&observation.path).ok();
				observation.stamp = metadata.as_ref().filter(|m| m.is_file()).map(FileStamp::of);
				state.history.insert(key, observation.stamp);
				if metadata.as_ref().is_some_and(|m| !m.is_file()) {
					continue;
				}
				if let Some(mutation) = observation.mutation.as_mut() {
					mutation.exists = metadata.is_some();
					mutation.after = snapshot(&observation.path);
				}
			}
			result.push(observation);
		}
		state.writing.clear();
		result
	}
}