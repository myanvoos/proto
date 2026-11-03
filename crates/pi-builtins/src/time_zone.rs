use jiff::tz::TimeZone;

use crate::host::Host;

pub(crate) fn shell_time_zone(host: &Host) -> TimeZone {
	let Some(value) = host.var("TZ") else {
		return TimeZone::system();
	};
	let value = value.strip_prefix(':').unwrap_or(value);
	if value.is_empty() {
		return TimeZone::UTC;
	}
	TimeZone::get(value)
		.or_else(|_| TimeZone::posix(value))
		.unwrap_or(TimeZone::UTC)
}
