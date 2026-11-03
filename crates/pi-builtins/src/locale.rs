use crate::host::Host;

pub(crate) fn shell_locale<'h>(host: &'h Host, category: &str) -> Option<&'h str> {
	["LC_ALL", category, "LANG"]
		.into_iter()
		.find_map(|key| host.var(key).filter(|value| !value.is_empty()))
}

pub(crate) fn codeset_is_utf8(name: &str) -> bool {
	name.split(['.', '@']).nth(1).is_some_and(|codeset| {
		codeset.eq_ignore_ascii_case("utf-8") || codeset.eq_ignore_ascii_case("utf8")
	})
}

pub(crate) fn ctype_is_utf8(host: &Host) -> bool {
	let Some(name) = shell_locale(host, "LC_CTYPE") else {
		return false;
	};
	#[cfg(unix)]
	if !locale_loadable(name, libc::LC_CTYPE_MASK) {
		return false;
	}
	codeset_is_utf8(name)
}

#[cfg(unix)]
pub(crate) fn locale_loadable(locale: &str, mask: libc::c_int) -> bool {
	let Ok(locale) = std::ffi::CString::new(locale) else {
		return false;
	};
	// SAFETY: `locale` is a valid NUL-terminated string; a non-null result is
	// a fresh locale object owned here and freed immediately.
	unsafe {
		let handle = libc::newlocale(mask, locale.as_ptr(), std::ptr::null_mut());
		if handle.is_null() {
			return false;
		}
		libc::freelocale(handle);
	}
	true
}
