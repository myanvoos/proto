#![allow(clippy::needless_pass_by_value)]

use std::{borrow::Cow, cell::RefCell};

use cached::Cached;

use crate::error;

thread_local! {
	 static REGEX_CACHE: RefCell<cached::SizedCache<(String, bool, bool), fancy_regex::Regex>> =
		  RefCell::new(cached::SizedCache::with_size(64));
}


#[derive(Clone, Debug)]
pub(crate) enum RegexPiece {

	Pattern(String),

	Literal(String),
}

impl RegexPiece {
	fn to_regex_str(&self) -> Cow<'_, str> {
		match self {
			Self::Pattern(s) => Cow::Borrowed(s.as_str()),
			Self::Literal(s) => escape_literal_regex_piece(s.as_str()),
		}
	}
}

type RegexWord = Vec<RegexPiece>;


#[derive(Clone, Debug)]
pub struct Regex {
	pieces:           RegexWord,
	case_insensitive: bool,
	multiline:        bool,
}

impl From<RegexWord> for Regex {
	fn from(pieces: RegexWord) -> Self {
		Self { pieces, case_insensitive: false, multiline: false }
	}
}

impl Regex {





	pub const fn set_case_insensitive(mut self, value: bool) -> Self {
		self.case_insensitive = value;
		self
	}








	pub const fn set_multiline(mut self, value: bool) -> Self {
		self.multiline = value;
		self
	}






	pub fn matches(&self, value: &str) -> Result<Option<Vec<Option<String>>>, error::Error> {
		let regex_pattern: String = self
			.pieces
			.iter()
			.map(|piece| piece.to_regex_str())
			.collect();

		let re = compile_regex(regex_pattern, self.case_insensitive, self.multiline)?;

		Ok(re.captures(value)?.map(|captures| {
			captures
				.iter()
				.map(|c| c.map(|m| m.as_str().to_owned()))
				.collect()
		}))
	}
}

pub(crate) fn compile_regex(
	regex_str: String,
	case_insensitive: bool,
	multiline: bool,
) -> Result<fancy_regex::Regex, error::Error> {

	let key = (regex_str, case_insensitive, multiline);

	let cached_regex = REGEX_CACHE.with(|cache| cache.borrow_mut().cache_get(&key).cloned());
	if let Some(re) = cached_regex {
		return Ok(re);
	}



	let mut regex_str = add_missing_escape_chars_to_regex(key.0.as_str());


	if multiline {



		let updated_str = std::format!("(?ms){regex_str}");
		regex_str = updated_str.into();
	}

	let mut builder = fancy_regex::RegexBuilder::new(regex_str.as_ref());
	builder.case_insensitive(case_insensitive);

	let re = match builder.build() {
		Ok(re) => re,
		Err(e) => return Err(error::ErrorKind::InvalidRegexError(e, regex_str.to_string()).into()),
	};


	drop(regex_str);

	REGEX_CACHE.with(|cache| {
		cache.borrow_mut().cache_set(key, re.clone());
	});

	Ok(re)
}

fn add_missing_escape_chars_to_regex(s: &str) -> Cow<'_, str> {


	let mut in_escape = false;
	let mut in_brackets = false;
	let mut insertion_positions = vec![];

	let mut peekable = s.char_indices().peekable();
	while let Some((byte_offset, c)) = peekable.next() {
		let next_is_colon = peekable.peek().is_some_and(|(_, c)| *c == ':');

		match c {
			'[' if !in_escape && !in_brackets => {
				in_brackets = true;
			},
			'[' if !in_escape && in_brackets && !next_is_colon => {

				insertion_positions.push(byte_offset);
			},
			']' if !in_escape && in_brackets => {
				in_brackets = false;
			},
			_ => (),
		}

		in_escape = !in_escape && c == '\\';
	}

	if insertion_positions.is_empty() {
		return s.into();
	}

	let mut updated = s.to_owned();
	for pos in insertion_positions.iter().rev() {
		updated.insert(*pos, '\\');
	}

	updated.into()
}

fn escape_literal_regex_piece(s: &str) -> Cow<'_, str> {
	let mut result = String::new();

	for c in s.chars() {
		match c {
			c if regex_char_is_special(c) => {
				result.push('\\');
				result.push(c);
			},
			c => result.push(c),
		}
	}

	result.into()
}

pub(crate) const fn regex_char_is_special(c: char) -> bool {
	matches!(c, '\\' | '^' | '$' | '.' | '|' | '?' | '*' | '+' | '(' | ')' | '[' | ']' | '{' | '}')
}


