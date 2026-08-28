

use std::{
	io::{BufRead, Read, Write},
	path::Path,
};

use chrono::Utc;

use crate::error;


type ItemId = i64;




#[derive(Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct History {
	items:   rpds::VectorSync<ItemId>,
	id_map:  rpds::HashTrieMapSync<ItemId, Item>,
	next_id: ItemId,
}

impl History {









	pub fn import(reader: impl Read) -> Result<Self, error::Error> {
		let mut history = Self::default();

		let buf_reader = std::io::BufReader::new(reader);

		let mut next_timestamp = None;
		for line_result in buf_reader.lines() {
			let line = match line_result {
				Ok(line) => line,



				Err(err) if err.kind() == std::io::ErrorKind::InvalidData => {
					tracing::warn!("unreadable history line; {err}");
					continue;
				},


				Err(err) => {
					return Err(err.into());
				},
			};


			if let Some(comment) = line.strip_prefix("#") {
				if let Ok(seconds_since_epoch) = comment.trim().parse() {
					next_timestamp = ItemTimestamp::from_timestamp(seconds_since_epoch, 0);
				} else {
					next_timestamp = None;
				}

				continue;
			}

			let item = Item {
				id:           history.next_id,
				command_line: line,
				timestamp:    next_timestamp.take(),
				dirty:        false,
			};

			history.add(item)?;
		}

		Ok(history)
	}







	pub fn get_by_id(&self, id: ItemId) -> Result<Option<&Item>, error::Error> {
		Ok(self.id_map.get(&id))
	}








	pub fn update_by_id(&mut self, id: ItemId, item: Item) -> Result<(), error::Error> {
		let existing_item = self
			.id_map
			.get_mut(&id)
			.ok_or(error::ErrorKind::HistoryItemNotFound)?;
		*existing_item = item;
		Ok(())
	}



	pub fn remove_nth_item(&mut self, n: usize) -> bool {
		if let Some(id) = self.items.get(n).copied() {
			self.items = self
				.items
				.into_iter()
				.enumerate()
				.filter_map(|(i, id)| if i != n { Some(id) } else { None })
				.copied()
				.collect();

			self.id_map.remove_mut(&id);

			true
		} else {
			false
		}
	}







	pub fn add(&mut self, mut item: Item) -> Result<ItemId, error::Error> {
		let id = self.next_id;

		item.id = id;
		self.next_id += 1;

		self.items.push_back_mut(item.id);
		self.id_map.insert_mut(item.id, item);

		Ok(id)
	}







	pub fn delete_item_by_id(&mut self, id: ItemId) -> Result<(), error::Error> {
		self.id_map.remove_mut(&id);
		self.items = self
			.items
			.into_iter()
			.filter(|&item_id| *item_id != id)
			.copied()
			.collect();

		Ok(())
	}


	pub fn clear(&mut self) -> Result<(), error::Error> {
		self.id_map = rpds::HashTrieMapSync::new_sync();
		self.items = rpds::VectorSync::new_sync();
		Ok(())
	}










	pub fn flush(
		&mut self,
		history_file_path: impl AsRef<Path>,
		append: bool,
		unsaved_items_only: bool,
		write_timestamps: bool,
	) -> Result<(), error::Error> {

		let mut file_options = std::fs::File::options();

		if append {
			file_options.append(true);
		} else {
			file_options.write(true).truncate(true);
		}

		let mut file = file_options.create(true).open(history_file_path.as_ref())?;

		for item_id in &self.items {
			if let Some(item) = self.id_map.get_mut(item_id) {
				if unsaved_items_only && !item.dirty {
					continue;
				}

				if write_timestamps && let Some(timestamp) = item.timestamp {
					writeln!(file, "#{}", timestamp.timestamp())?;
				}

				writeln!(file, "{}", item.command_line)?;

				if unsaved_items_only {
					item.dirty = false;
				}
			}
		}

		file.flush()?;

		Ok(())
	}






	pub fn search(&self, query: Query) -> Result<impl Iterator<Item = &self::Item>, error::Error> {
		Ok(Search::new(self, query))
	}


	pub fn iter(&self) -> impl Iterator<Item = &self::Item> {
		Search::all(self)
	}








	pub fn get(&self, index: usize) -> Option<&Item> {
		if let Some(id) = self.items.get(index) {
			self.id_map.get(id)
		} else {
			None
		}
	}


	pub fn count(&self) -> usize {
		self.items.len()
	}
}


pub type ItemTimestamp = chrono::DateTime<Utc>;


#[derive(Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Item {

	pub id:           ItemId,

	pub command_line: String,

	pub timestamp:    Option<ItemTimestamp>,


	pub dirty:        bool,
}

impl Item {





	pub fn new(command_line: impl Into<String>) -> Self {
		Self {
			id:           0,
			command_line: command_line.into(),
			timestamp:    Some(chrono::Utc::now()),
			dirty:        true,
		}
	}
}


#[derive(Default)]
pub struct Query {

	pub direction:             Direction,

	pub not_at_or_before_time: Option<ItemTimestamp>,

	pub not_at_or_after_time:  Option<ItemTimestamp>,

	pub not_at_or_before_id:   Option<ItemId>,

	pub not_at_or_after_id:    Option<ItemId>,

	pub max_items:             Option<i64>,

	pub command_line_filter:   Option<CommandLineFilter>,
}

impl Query {





	pub fn includes(&self, item: &Item) -> bool {

		if let Some(not_at_or_before_time) = &self.not_at_or_before_time {
			if item
				.timestamp
				.is_some_and(|ts| ts <= *not_at_or_before_time)
			{
				return false;
			}
		}


		if let Some(not_at_or_after_time) = &self.not_at_or_after_time {
			if item.timestamp.is_some_and(|ts| ts >= *not_at_or_after_time) {
				return false;
			}
		}


		if self
			.not_at_or_before_id
			.is_some_and(|query_id| item.id <= query_id)
		{
			return false;
		}


		if self
			.not_at_or_after_id
			.is_some_and(|query_id| item.id >= query_id)
		{
			return false;
		}


		if let Some(command_line_filter) = &self.command_line_filter {
			match command_line_filter {
				CommandLineFilter::Prefix(prefix) => {
					if !item.command_line.starts_with(prefix) {
						return false;
					}
				},
				CommandLineFilter::Suffix(suffix) => {
					if !item.command_line.ends_with(suffix) {
						return false;
					}
				},
				CommandLineFilter::Contains(contains) => {
					if !item.command_line.contains(contains) {
						return false;
					}
				},
				CommandLineFilter::Exact(exact) => {
					if item.command_line != *exact {
						return false;
					}
				},
			}
		}

		true
	}
}


#[derive(Default)]
pub enum Direction {

	#[default]
	Forward,

	Backward,
}


pub enum CommandLineFilter {

	Prefix(String),

	Suffix(String),

	Contains(String),

	Exact(String),
}


pub struct Search<'a> {

	history:    &'a History,

	query:      Query,

	next_index: Option<usize>,

	count:      usize,
}

impl<'a> Search<'a> {






	pub fn all(history: &'a History) -> Self {
		Self::new(history, Query::default())
	}








	pub fn new(history: &'a History, query: Query) -> Self {
		let next_index = match query.direction {
			Direction::Forward => Some(0),
			Direction::Backward => {
				if history.items.is_empty() {
					None
				} else {
					Some(history.items.len() - 1)
				}
			},
		};

		Self { history, query, next_index, count: 0 }
	}

	const fn increment_next_index(&mut self) {
		if let Some(index) = self.next_index {
			self.next_index = match self.query.direction {
				Direction::Forward => Some(index + 1),
				Direction::Backward => {
					if index == 0 {
						None
					} else {
						Some(index - 1)
					}
				},
			}
		}
	}
}

impl<'a> Iterator for Search<'a> {
	type Item = &'a Item;

	fn next(&mut self) -> Option<Self::Item> {
		loop {
			{
       let index = self.next_index?;

				if index >= self.history.items.len() {
					return None;
				}

				let id = self.history.items[index];
				self.increment_next_index();

				if let Some(item) = self.history.id_map.get(&id) {


					#[expect(clippy::cast_possible_truncation)]
					#[expect(clippy::cast_sign_loss)]
					if self
						.query
						.max_items
						.is_some_and(|max_items| self.count >= max_items as usize)
					{
						return None;
					}



					if self.query.includes(item) {
						self.count += 1;
						return Some(item);
					}
				}
			}
		}
	}
}
