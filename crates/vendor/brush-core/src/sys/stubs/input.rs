

use crate::{error, interfaces};






pub fn try_get_key_from_key_code(key_code: &[u8]) -> Option<interfaces::Key> {
	if key_code.len() == 1 && !key_code[0].is_ascii_control() {
		Some(interfaces::Key::Character(key_code[0] as char))
	} else {
		None
	}
}
