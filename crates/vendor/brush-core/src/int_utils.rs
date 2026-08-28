

use crate::error;


pub trait ParseIntRadix: Sized {

	fn from_str_radix(s: &str, radix: u32) -> Result<Self, std::num::ParseIntError>;


	fn type_name() -> &'static str;
}

macro_rules! impl_parse_int_radix {
	($t:ty) => {
		impl ParseIntRadix for $t {
			fn from_str_radix(s: &str, radix: u32) -> Result<Self, std::num::ParseIntError> {
				Self::from_str_radix(s, radix)
			}

			fn type_name() -> &'static str {
				stringify!($t)
			}
		}
	};
}

impl_parse_int_radix!(u8);
impl_parse_int_radix!(u16);
impl_parse_int_radix!(i32);
impl_parse_int_radix!(u32);
impl_parse_int_radix!(usize);
























pub fn parse<T: ParseIntRadix>(s: &str, radix: u32) -> Result<T, error::Error> {
	T::from_str_radix(s, radix).map_err(|inner| {
		error::ErrorKind::IntParseError {
			s: s.to_owned(),
			int_type_name: T::type_name(),
			radix,
			inner,
		}
		.into()
	})
}
