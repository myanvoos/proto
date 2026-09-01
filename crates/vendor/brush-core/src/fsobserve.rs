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

	fn of_regular_file(path: &Path) -> Option<Self> {
		let metadata = std::fs::metadata(path).ok()?;
		metadata.is_file().then(|| Self::of(&metadata))
	}
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FsObservation {
	pub path:  PathBuf,
	pub kind:  FsObservationKind,
	pub stamp: Option<FileStamp>,
}

#[derive(Clone, Debug, Default)]
pub struct FsObservationLog(Arc<Mutex<Vec<FsObservation>>>);

impl FsObservationLog {
	pub fn record_read(&self, path: impl Into<PathBuf>) {
		let path = path.into();
		if let Some(stamp) = FileStamp::of_regular_file(&path) {
			self.push(FsObservation { path, kind: FsObservationKind::Read, stamp: Some(stamp) });
		}
	}

	pub fn record_read_of(&self, path: impl Into<PathBuf>, metadata: &Metadata) {
		if metadata.is_file() {
			self.push(FsObservation {
				path:  path.into(),
				kind:  FsObservationKind::Read,
				stamp: Some(FileStamp::of(metadata)),
			});
		}
	}

	pub fn record_write(&self, path: impl Into<PathBuf>) {
		self.push(FsObservation { path: path.into(), kind: FsObservationKind::Write, stamp: None });
	}

	pub fn drain(&self) -> Vec<FsObservation> {
		let recorded = std::mem::take(&mut *self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()));
		let mut latest: BTreeMap<PathBuf, FsObservation> = BTreeMap::new();
		for observation in recorded {
			latest.insert(observation.path.clone(), observation);
		}
		latest
			.into_values()
			.filter_map(|mut observation| {
				if observation.kind == FsObservationKind::Write {
					observation.stamp = match std::fs::metadata(&observation.path) {
						Ok(metadata) if metadata.is_file() => Some(FileStamp::of(&metadata)),
						Ok(_) => return None,
						Err(_) => None,
					};
				}
				Some(observation)
			})
			.collect()
	}

	fn push(&self, observation: FsObservation) {
		self
			.0
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner())
			.push(observation);
	}
}
