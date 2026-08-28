use std::{
	collections::HashMap,
	sync::{LazyLock, Mutex, MutexGuard, PoisonError},
};

use anyhow::{Result, anyhow};
use ast_grep_core::tree_sitter::LanguageExt;
use tree_sitter::{Parser, Tree};

use crate::language::SupportLang;

const HASH_SEED: u64 = 0x9e37_79b9_7f4a_7c15;

pub const MAX_ENTRY_SOURCE_BYTES: usize = 4 << 20;

pub const MAX_TOTAL_SOURCE_BYTES: usize = 4 << 20;

pub const MAX_ENTRIES: usize = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct Key {
	hash: u64,
	len:  usize,
	lang: SupportLang,
}

fn key_for(code: &str, lang: SupportLang) -> Key {
	Key { hash: xxhash_rust::xxh64::xxh64(code.as_bytes(), HASH_SEED), len: code.len(), lang }
}

struct Entry {
	source: Box<str>,
	tree:   Tree,

	stamp: u64,
}

struct Cache {
	entries:         HashMap<Key, Entry>,
	source_bytes:    usize,
	clock:           u64,
	hits:            u64,
	misses:          u64,
	evictions:       u64,
	max_entries:     usize,
	max_total_bytes: usize,
	max_entry_bytes: usize,
}

impl Cache {
	fn new(max_entries: usize, max_total_bytes: usize, max_entry_bytes: usize) -> Self {
		Self {
			entries: HashMap::new(),
			source_bytes: 0,
			clock: 0,
			hits: 0,
			misses: 0,
			evictions: 0,
			max_entries,
			max_total_bytes,
			max_entry_bytes,
		}
	}

	fn get(&mut self, key: &Key, code: &str) -> Option<Tree> {
		self.clock += 1;
		let stamp = self.clock;
		let tree = match self.entries.get_mut(key) {
			Some(entry) if &*entry.source == code => {
				entry.stamp = stamp;

				entry.tree.clone()
			},
			_ => {
				self.misses += 1;
				return None;
			},
		};
		self.hits += 1;
		Some(tree)
	}

	fn insert(&mut self, key: Key, code: &str, tree: &Tree) {
		if code.len() > self.max_entry_bytes {
			return;
		}
		if let Some(previous) = self.entries.remove(&key) {
			self.source_bytes -= previous.source.len();
		}
		while self.entries.len() >= self.max_entries
			|| self.source_bytes + code.len() > self.max_total_bytes
		{
			if !self.evict_oldest() {
				break;
			}
		}
		self.clock += 1;
		self.source_bytes += code.len();
		self.entries.insert(key, Entry {
			source: Box::from(code),
			tree:   tree.clone(),
			stamp:  self.clock,
		});
	}

	fn evict_oldest(&mut self) -> bool {
		let Some(&oldest) = self
			.entries
			.iter()
			.min_by_key(|(_, entry)| entry.stamp)
			.map(|(key, _)| key)
		else {
			return false;
		};
		if let Some(entry) = self.entries.remove(&oldest) {
			self.source_bytes -= entry.source.len();
			self.evictions += 1;
		}
		true
	}

	fn clear(&mut self) {
		self.entries.clear();
		self.source_bytes = 0;
		self.clock = 0;
		self.hits = 0;
		self.misses = 0;
		self.evictions = 0;
	}
}

static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(|| {
	Mutex::new(Cache::new(MAX_ENTRIES, MAX_TOTAL_SOURCE_BYTES, MAX_ENTRY_SOURCE_BYTES))
});

fn lock() -> MutexGuard<'static, Cache> {
	CACHE.lock().unwrap_or_else(PoisonError::into_inner)
}

pub fn parse_cached(code: &str, lang: SupportLang) -> Result<Option<Tree>> {
	let key = key_for(code, lang);

	let cached = lock().get(&key, code);
	if let Some(tree) = cached {
		return Ok(Some(tree));
	}
	let mut parser = Parser::new();
	parser
		.set_language(&lang.get_ts_language())
		.map_err(|err| anyhow!("Failed to load tree-sitter language: {err}"))?;
	let Some(tree) = parser.parse(code, None) else {
		return Ok(None);
	};
	lock().insert(key, code, &tree);
	Ok(Some(tree))
}

pub fn clear_parse_cache() {
	lock().clear();
}
