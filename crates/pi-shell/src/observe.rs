//! File observations: what the shell read, wrote, removed or renamed.
//!
//! The coding agent turns these into write receipts and a stale-write guard
//! (`bash-file-mutations.ts`, `fs-observations.ts`). [`crate::vfs::VfsFs`] is
//! the engine's single filesystem choke point, so every open, unlink, rmdir
//! and rename the shell performs is recorded here, native and provider paths
//! alike.
//!
//! The shape matches the former shell's `fsobserve` extension: reads carry
//! the file's stamp; writes carry a bounded before/after text snapshot when
//! the file is small enough to snapshot, and a write that would clobber a
//! file changed since this shell last saw it is refused with
//! `StaleWriteError` before it is truncated.

use std::{
	collections::BTreeMap,
	fs::Metadata,
	io,
	path::{Path, PathBuf},
	sync::Arc,
};

use parking_lot::Mutex;
use pi_vfs::Metadata as VfsMetadata;

/// A file observation kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FsObservationKind {
	Read,
	Write,
}

/// The content before and after a write.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct FileMutation {
	pub existed: bool,
	pub exists:  bool,
	pub before:  Option<String>,
	pub after:   Option<String>,
}

/// One observed file operation.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct FsObservation {
	pub path:     String,
	pub kind:     FsObservationKind,
	pub mtime_ns: Option<i64>,
	pub size:     Option<u64>,
	pub mutation: Option<FileMutation>,
}

/// A file's modification stamp.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileStamp {
	mtime_ns: i64,
	size:     u64,
}

impl FileStamp {
	#[cfg(unix)]
	fn of(metadata: &Metadata) -> Self {
		use std::os::unix::fs::MetadataExt;
		Self {
			mtime_ns: metadata.mtime().saturating_mul(1_000_000_000) + metadata.mtime_nsec(),
			size:     metadata.size(),
		}
	}

	#[cfg(not(unix))]
	fn of(metadata: &Metadata) -> Self {
		let mtime_ns = metadata
			.modified()
			.ok()
			.and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
			.and_then(|elapsed| i64::try_from(elapsed.as_nanos()).ok())
			.unwrap_or_default();
		Self { mtime_ns, size: metadata.len() }
	}

	fn of_provider(metadata: &VfsMetadata) -> Self {
		let mtime_ns = metadata
			.mtime()
			.map_or(0, |secs| secs.saturating_mul(1_000_000_000))
			.saturating_add(metadata.mtime_nsec().unwrap_or(0));
		Self { mtime_ns, size: metadata.len() }
	}
}

/// Text snapshots are deliberately bounded; binary and large files still carry
/// stamps.
const MAX_SNAPSHOT_BYTES: u64 = 1024 * 1024;

/// A recorded observation plus whether it came from a provider.
#[derive(Debug)]
struct Recorded {
	observation: FsObservation,
	provider:    bool,
}

#[derive(Debug, Default)]
struct ObservationState {
	recorded:       Vec<Recorded>,
	/// Canonical identities make reads through symlinks guard writes through
	/// aliases.
	history:        BTreeMap<PathBuf, Option<FileStamp>>,
	observed_paths: BTreeMap<PathBuf, PathBuf>,
	/// Own writes may change stamps repeatedly before the result is drained.
	writing:        std::collections::BTreeSet<PathBuf>,
}

/// The observation log of one shell session. Cheap to clone; clones share the
/// log.
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
	// A path can be replaced after metadata(): never block on a substituted
	// FIFO/device.
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
	file
		.take(MAX_SNAPSHOT_BYTES + 1)
		.read_to_end(&mut bytes)
		.ok()?;
	if bytes.len() as u64 > MAX_SNAPSHOT_BYTES {
		return None;
	}
	String::from_utf8(bytes).ok()
}

fn stamp_fields(stamp: Option<FileStamp>) -> (Option<i64>, Option<u64>) {
	stamp.map_or((None, None), |stamp| (Some(stamp.mtime_ns), Some(stamp.size)))
}

impl FsObservationLog {
	/// Record a read of a native file, if `path` is a regular file.
	pub fn record_read(&self, path: impl Into<PathBuf>) {
		let path = path.into();
		if let Ok(metadata) = std::fs::metadata(&path) {
			self.record_read_of(path, &metadata);
		}
	}

	/// Record a read of the native file `path` with `metadata`.
	pub fn record_read_of(&self, path: impl Into<PathBuf>, metadata: &Metadata) {
		if !metadata.is_file() {
			return;
		}
		let path = path.into();
		let stamp = Some(FileStamp::of(metadata));
		let mut state = self.0.lock();
		let key = identity(&path);
		state.observed_paths.insert(path.clone(), key.clone());
		state.history.insert(key, stamp);
		let (mtime_ns, size) = stamp_fields(stamp);
		state.recorded.push(Recorded {
			observation: FsObservation {
				path: path.to_string_lossy().into_owned(),
				kind: FsObservationKind::Read,
				mtime_ns,
				size,
				mutation: None,
			},
			provider:    false,
		});
	}

	/// Record a read of a provider file.
	pub fn record_read_provider(&self, path: &Path, metadata: &VfsMetadata) {
		if !metadata.is_file() {
			return;
		}
		let stamp = Some(FileStamp::of_provider(metadata));
		let mut state = self.0.lock();
		let key = identity(path);
		state.observed_paths.insert(path.to_path_buf(), key.clone());
		state.history.insert(key, stamp);
		let (mtime_ns, size) = stamp_fields(stamp);
		state.recorded.push(Recorded {
			observation: FsObservation {
				path: path.to_string_lossy().into_owned(),
				kind: FsObservationKind::Read,
				mtime_ns,
				size,
				mutation: None,
			},
			provider:    true,
		});
	}

	/// Check before opening/truncating a native file. Commit only once the
	/// shell's open succeeds.
	pub fn prepare_write(&self, path: &Path) -> io::Result<Option<FsObservation>> {
		let key = identity(path);
		let metadata = match std::fs::metadata(path) {
			Ok(metadata) => Some(metadata),
			Err(err) if err.kind() == io::ErrorKind::NotFound => None,
			Err(_) => return Ok(None),
		};
		let stamp = metadata.as_ref().filter(|m| m.is_file()).map(FileStamp::of);
		let state = self.0.lock();
		if !state.writing.contains(&key)
			&& !state.writing.contains(path)
			&& (state
				.history
				.get(&key)
				.is_some_and(|previous| *previous != stamp)
				|| state
					.observed_paths
					.get(path)
					.is_some_and(|previous| *previous != key))
		{
			return Err(io::Error::other(
				"StaleWriteError: file changed since this shell last read or wrote it; reread before \
				 redirecting output",
			));
		}
		drop(state);
		if metadata.as_ref().is_some_and(|m| !m.is_file()) {
			return Ok(None);
		}
		Ok(Some(FsObservation {
			path:     path.to_string_lossy().into_owned(),
			kind:     FsObservationKind::Write,
			mtime_ns: None,
			size:     None,
			mutation: Some(FileMutation {
				existed: metadata.is_some(),
				exists:  true,
				before:  snapshot(path),
				after:   None,
			}),
		}))
	}

	/// Commit an observation prepared by [`Self::prepare_write`].
	pub fn commit_write(&self, observation: Option<FsObservation>) {
		if let Some(mut observation) = observation {
			let mut state = self.0.lock();
			let key = identity(Path::new(&observation.path));
			state
				.observed_paths
				.insert(PathBuf::from(&observation.path), key.clone());
			state.writing.insert(key);
			state.writing.insert(PathBuf::from(&observation.path));
			observation.mtime_ns = None;
			observation.size = None;
			state
				.recorded
				.push(Recorded { observation, provider: false });
		}
	}

	/// Commit a provider write observed at `path`.
	pub fn commit_provider_write(&self, path: &Path) {
		let mut state = self.0.lock();
		let key = identity(path);
		state.observed_paths.insert(path.to_path_buf(), key.clone());
		state.writing.insert(key);
		state.writing.insert(path.to_path_buf());
		state.recorded.push(Recorded {
			observation: FsObservation {
				path:     path.to_string_lossy().into_owned(),
				kind:     FsObservationKind::Write,
				mtime_ns: None,
				size:     None,
				mutation: None,
			},
			provider:    true,
		});
	}

	/// Record a native write that mutates no content (a removal or rename).
	pub fn record_write(&self, path: impl Into<PathBuf>) {
		let path = path.into();
		let mut state = self.0.lock();
		let key = identity(&path);
		state.observed_paths.insert(path.clone(), key.clone());
		state.writing.insert(key);
		state.writing.insert(path.clone());
		state.recorded.push(Recorded {
			observation: FsObservation {
				path:     path.to_string_lossy().into_owned(),
				kind:     FsObservationKind::Write,
				mtime_ns: None,
				size:     None,
				mutation: None,
			},
			provider:    false,
		});
	}

	/// Take the observations recorded since the last drain, one per path.
	pub fn drain(&self) -> Vec<FsObservation> {
		let mut state = self.0.lock();
		let recorded = std::mem::take(&mut state.recorded);
		let mut latest: BTreeMap<PathBuf, Recorded> = BTreeMap::new();
		for recorded in recorded {
			let path = PathBuf::from(&recorded.observation.path);
			let key = identity(&path);
			if let Some(previous) = latest.get_mut(&key) {
				// A later read must not erase a write receipt, nor a later write
				// its original before.
				if recorded.observation.kind == FsObservationKind::Write {
					previous.observation.kind = FsObservationKind::Write;
					previous.observation.path = recorded.observation.path;
				}
				if previous.observation.mutation.is_none() {
					previous.observation.mutation = recorded.observation.mutation;
				}
				previous.observation.mtime_ns = recorded.observation.mtime_ns;
				previous.observation.size = recorded.observation.size;
				previous.provider |= recorded.provider;
			} else {
				latest.insert(key, recorded);
			}
		}
		let mut result = Vec::new();
		for (key, mut recorded) in latest {
			if recorded.observation.kind == FsObservationKind::Write && !recorded.provider {
				let path = PathBuf::from(&recorded.observation.path);
				let metadata = std::fs::metadata(&path).ok();
				let stamp = metadata.as_ref().filter(|m| m.is_file()).map(FileStamp::of);
				let (mtime_ns, size) = stamp_fields(stamp);
				recorded.observation.mtime_ns = mtime_ns;
				recorded.observation.size = size;
				state.history.insert(key, stamp);
				if metadata.as_ref().is_some_and(|m| !m.is_file()) {
					continue;
				}
				if let Some(mutation) = recorded.observation.mutation.as_mut() {
					mutation.exists = metadata.is_some();
					mutation.after = snapshot(&path);
				}
			}
			result.push(recorded.observation);
		}
		state.writing.clear();
		result
	}
}
