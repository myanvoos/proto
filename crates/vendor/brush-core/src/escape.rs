

use std::borrow::Cow;

use itertools::Itertools;

use crate::{error, int_utils};


#[derive(Clone, Copy)]
pub enum EscapeExpansionMode {

	EchoBuiltin,

	AnsiCQuotes,
}







#[expect(clippy::too_many_lines)]
pub fn expand_backslash_escapes(
	s: &str,
	mode: EscapeExpansionMode,
) -> Result<(Vec<u8>, bool), error::Error> {
	let mut result: Vec<u8> = Vec::with_capacity(s.len());
	let mut it = s.chars();
	while let Some(c) = it.next() {
		if c != '\\' {

			result.append(c.to_string().into_bytes().as_mut());
			continue;
		}

		let Some(escape_cmd) = it.next() else {

			result.push(b'\\');
			continue;
		};

		match escape_cmd {
			'a' => result.push(b'\x07'),
			'b' => result.push(b'\x08'),
			'c' => {
				match mode {
					EscapeExpansionMode::EchoBuiltin => {

						return Ok((result, false));
					},
					EscapeExpansionMode::AnsiCQuotes => {
						if let Some(char_value) = it.next() {




							if char_value == '\\' {
								let orig_it = it.clone();
								if !matches!(it.next(), Some('\\')) {

									it = orig_it;
								}
							}

							let mut bytes: Vec<u8> = if char_value.is_ascii_lowercase() {
								char_value
									.to_ascii_uppercase()
									.to_string()
									.bytes()
									.collect()
							} else {
								char_value.to_string().bytes().collect()
							};

							if !bytes.is_empty() {
								if bytes[0] == b'?' {

									bytes[0] = 0x7f;
								} else {
									bytes[0] &= 0x1f;
								}
							}

							result.append(bytes.as_mut());
						} else {
							result.push(b'\\');
							result.push(b'c');
						}
					},
				}
			},
			'e' | 'E' => result.push(b'\x1b'),
			'f' => result.push(b'\x0c'),
			'n' => result.push(b'\n'),
			'r' => result.push(b'\r'),
			't' => result.push(b'\t'),
			'v' => result.push(b'\x0b'),
			'\\' => result.push(b'\\'),
			'\'' if matches!(mode, EscapeExpansionMode::AnsiCQuotes) => result.push(b'\''),
			'\"' if matches!(mode, EscapeExpansionMode::AnsiCQuotes) => result.push(b'\"'),
			'?' if matches!(mode, EscapeExpansionMode::AnsiCQuotes) => result.push(b'?'),
			'0' => {

				let mut taken_so_far = 0;
				let mut octal_chars: String = it
					.take_while_ref(|c| {
						if taken_so_far < 3 && matches!(*c, '0'..='7') {
							taken_so_far += 1;
							true
						} else {
							false
						}
					})
					.collect();

				if octal_chars.is_empty() {
					octal_chars.push('0');
				}

				let value = int_utils::parse::<u8>(octal_chars.as_str(), 8)?;
				result.push(value);
			},
			'x' => {

				let mut hex_chars = String::new();
				let mut invalid_prefix = false;
				let mut hexits_consumed = 0;
				let mut start_brace_consumed = false;

				loop {

					let orig_it = it.clone();

					let Some(next_c) = it.next() else {
						break;
					};

					if matches!(mode, EscapeExpansionMode::AnsiCQuotes)
						&& !start_brace_consumed
						&& next_c == '{'
					{
						start_brace_consumed = true;
					} else if start_brace_consumed && next_c == '}' {
						break;
					} else if ((start_brace_consumed && !invalid_prefix)
						|| (!start_brace_consumed && hexits_consumed < 2))
						&& next_c.is_ascii_hexdigit()
					{
						hex_chars.push(next_c);
						hexits_consumed += 1;
					} else if start_brace_consumed && hexits_consumed == 0 {
						invalid_prefix = true;
					} else {

						it = orig_it;
						break;
					}
				}

				if hex_chars.is_empty() {
					if start_brace_consumed {
						result.push(0);
					} else {
						result.push(b'\\');
						result.append(escape_cmd.to_string().into_bytes().as_mut());
					}
				} else {
					let value32 = int_utils::parse::<u32>(hex_chars.as_str(), 16)?;
					let value8: u8 = (value32 & 0xff) as u8;
					result.push(value8);
				}
			},
			'u' => {

				let mut taken_so_far = 0;
				let hex_chars: String = it
					.take_while_ref(|next_c| {
						if taken_so_far < 4 && next_c.is_ascii_hexdigit() {
							taken_so_far += 1;
							true
						} else {
							false
						}
					})
					.collect();

				if hex_chars.is_empty() {
					result.push(b'\\');
					result.append(escape_cmd.to_string().into_bytes().as_mut());
				} else {
					let value = int_utils::parse::<u16>(hex_chars.as_str(), 16)?;
					if let Some(decoded) = char::from_u32(u32::from(value)) {
						result.append(decoded.to_string().into_bytes().as_mut());
					} else {
						result.push(b'\\');
						result.append(escape_cmd.to_string().into_bytes().as_mut());
					}
				}
			},
			'U' => {

				let mut taken_so_far = 0;
				let hex_chars: String = it
					.take_while_ref(|next_c| {
						if taken_so_far < 8 && next_c.is_ascii_hexdigit() {
							taken_so_far += 1;
							true
						} else {
							false
						}
					})
					.collect();

				if hex_chars.is_empty() {
					result.push(b'\\');
					result.append(escape_cmd.to_string().into_bytes().as_mut());
				} else {
					let value = int_utils::parse::<u32>(hex_chars.as_str(), 16)?;
					if let Some(decoded) = char::from_u32(value) {
						result.append(decoded.to_string().into_bytes().as_mut());
					} else {
						result.push(b'\\');
						result.append(escape_cmd.to_string().into_bytes().as_mut());
					}
				}
			},
			first_octal @ '1'..='7' if matches!(mode, EscapeExpansionMode::AnsiCQuotes) => {

				let mut octal_chars = String::new();
				octal_chars.push(first_octal);


				let mut taken_so_far = 1;
				for next_c in it.take_while_ref(|next_c| {
					if taken_so_far < 3 && matches!(next_c, '0'..='7') {
						taken_so_far += 1;
						true
					} else {
						false
					}
				}) {
					octal_chars.push(next_c);
				}

				let value = int_utils::parse::<u8>(octal_chars.as_str(), 8)?;
				result.push(value);
			},
			unknown => {

				result.push(b'\\');
				result.append(unknown.to_string().into_bytes().as_mut());
			},
		}
	}


	if matches!(mode, EscapeExpansionMode::AnsiCQuotes) {
		if let Some(nul_index) = result.iter().position(|&b| b == 0) {
			result.truncate(nul_index);
		}
	}

	Ok((result, true))
}


#[derive(Clone, Copy, Default)]
pub enum QuoteMode {

	#[default]
	SingleQuote,

	DoubleQuote,

	BackslashEscape,
}


#[derive(Default)]
pub(crate) struct QuoteOptions {



	pub always_quote:                 bool,


	pub preferred_mode:               QuoteMode,



	pub avoid_ansi_c_quoting_newline: bool,
}

pub(crate) fn quote<'a>(s: &'a str, options: &QuoteOptions) -> Cow<'a, str> {
	let use_ansi_c_quotes = s.contains(|c| {
		needs_ansi_c_quoting(c) && (!options.avoid_ansi_c_quoting_newline || c != '\n')
	});

	if use_ansi_c_quotes {
		return ansi_c_quote(s).into();
	}

	let use_default_quotes =
		!use_ansi_c_quotes && (options.always_quote || s.is_empty() || s.contains(needs_escaping));

	if !use_default_quotes {
		return s.into();
	}

	match options.preferred_mode {
		QuoteMode::BackslashEscape => backslash_escape(s),
		QuoteMode::SingleQuote => single_quote(s),
		QuoteMode::DoubleQuote => double_quote(s).into(),
	}
}







pub fn force_quote(s: &str, mode: QuoteMode) -> String {
	let options = QuoteOptions { always_quote: true, preferred_mode: mode, ..Default::default() };

	quote(s, &options).to_string()
}








pub fn quote_if_needed(s: &str, mode: QuoteMode) -> Cow<'_, str> {
	let options = QuoteOptions { always_quote: false, preferred_mode: mode, ..Default::default() };

	quote(s, &options)
}

fn backslash_escape(s: &str) -> Cow<'_, str> {
	if s.is_empty() {

		Cow::Owned("''".to_string())
	} else if !s.chars().any(needs_escaping) {
		Cow::Borrowed(s)
	} else {
		let mut output = String::with_capacity(s.len());
		for c in s.chars() {
			if needs_escaping(c) {
				output.push('\\');
			}
			output.push(c);
		}
		Cow::Owned(output)
	}
}

fn single_quote(s: &str) -> Cow<'_, str> {

	if s.is_empty() {
		return Cow::Borrowed("''");
	}

	let mut result = String::with_capacity(s.len());




	let mut first = true;
	for part in s.split('\'') {
		if !first {
			result.push('\\');
			result.push('\'');
		} else {
			first = false;
		}

		if !part.is_empty() {
			result.push('\'');
			result.push_str(part);
			result.push('\'');
		}
	}

	Cow::Owned(result)
}

fn double_quote(s: &str) -> String {
	let mut result = String::with_capacity(s.len());

	result.push('"');

	for c in s.chars() {
		if matches!(c, '$' | '`' | '"' | '\\') {
			result.push('\\');
		}

		result.push(c);
	}

	result.push('"');

	result
}

fn ansi_c_quote(s: &str) -> String {
	let mut result = String::with_capacity(s.len());
	result.push_str("$'");

	for c in s.chars() {
		match c {
			'\x07' => result.push_str("\\a"),
			'\x08' => result.push_str("\\b"),
			'\x1b' => result.push_str("\\E"),
			'\x0c' => result.push_str("\\f"),
			'\n' => result.push_str("\\n"),
			'\r' => result.push_str("\\r"),
			'\t' => result.push_str("\\t"),
			'\x0b' => result.push_str("\\v"),
			'\\' => result.push_str("\\\\"),
			'\'' => result.push_str("\\'"),
			c if needs_ansi_c_quoting(c) => {
				result.push_str(std::format!("\\{:03o}", c as u8).as_str());
			},
			_ => result.push(c),
		}
	}

	result.push('\'');

	result
}



const fn needs_escaping(c: char) -> bool {
	matches!(
		c,
		'(' | ')'
			| '[' | ']'
			| '{' | '}'
			| '$' | '*'
			| '?' | '|'
			| '&' | ';'
			| '<' | '>'
			| '`' | '\\'
			| '"' | '!'
			| '^' | ','
			| ' ' | '\''
	)
}

const fn needs_ansi_c_quoting(c: char) -> bool {
	c.is_ascii_control()
}


