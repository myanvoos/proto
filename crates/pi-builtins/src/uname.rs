



use std::{
	ffi::{OsStr, OsString},
	io::Write,
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};
use platform_info::{PlatformInfo, PlatformInfoAPI, UNameAPI};
use uucore::display::Quotable;

use crate::host::{Host, Utility, format_usage, matches_parser, os_bytes, util};

mod options {
	pub(super) const ALL: &str = "all";
	pub(super) const KERNEL_NAME: &str = "kernel-name";
	pub(super) const NODENAME: &str = "nodename";
	pub(super) const KERNEL_VERSION: &str = "kernel-version";
	pub(super) const KERNEL_RELEASE: &str = "kernel-release";
	pub(super) const MACHINE: &str = "machine";
	pub(super) const PROCESSOR: &str = "processor";
	pub(super) const HARDWARE_PLATFORM: &str = "hardware-platform";
	pub(super) const OS: &str = "operating-system";
}

struct UNameOutput {
	kernel_name:       Option<OsString>,
	nodename:          Option<OsString>,
	kernel_release:    Option<OsString>,
	kernel_version:    Option<OsString>,
	machine:           Option<OsString>,
	os:                Option<OsString>,
	processor:         Option<OsString>,
	hardware_platform: Option<OsString>,
}

impl UNameOutput {
	fn display(&self) -> OsString {
		[
			self.kernel_name.as_ref(),
			self.nodename.as_ref(),
			self.kernel_release.as_ref(),
			self.kernel_version.as_ref(),
			self.machine.as_ref(),
			self.processor.as_ref(),
			self.hardware_platform.as_ref(),
			self.os.as_ref(),
		]
		.into_iter()
		.flatten()
		.map(OsString::as_os_str)
		.collect::<Vec<_>>()
		.join(OsStr::new(" "))
	}

	fn new(opts: &Options) -> Result<Self, &'static str> {
		let uname = PlatformInfo::new().map_err(|_| "cannot get system name")?;
		let none = !(opts.all
			|| opts.kernel_name
			|| opts.nodename
			|| opts.kernel_release
			|| opts.kernel_version
			|| opts.machine
			|| opts.os
			|| opts.processor
			|| opts.hardware_platform);

		let kernel_name = (opts.kernel_name || opts.all || none).then(|| uname.sysname().to_owned());
		let nodename = (opts.nodename || opts.all).then(|| uname.nodename().to_owned());
		let kernel_release = (opts.kernel_release || opts.all).then(|| uname.release().to_owned());
		let kernel_version = (opts.kernel_version || opts.all).then(|| uname.version().to_owned());
		let machine = (opts.machine || opts.all).then(|| uname.machine().to_owned());
		let os = (opts.os || opts.all).then(|| uname.osname().to_owned());



		let processor = opts.processor.then(|| "unknown".into());



		let hardware_platform = opts.hardware_platform.then(|| "unknown".into());

		Ok(Self {
			kernel_name,
			nodename,
			kernel_release,
			kernel_version,
			machine,
			os,
			processor,
			hardware_platform,
		})
	}
}

struct Options {
	all:               bool,
	kernel_name:       bool,
	nodename:          bool,
	kernel_version:    bool,
	kernel_release:    bool,
	machine:           bool,
	processor:         bool,
	hardware_platform: bool,
	os:                bool,
}


pub(crate) struct Uname {
	matches: ArgMatches,
}

matches_parser!(Uname, uu_app);

impl Utility for Uname {
	const NAME: &'static str = "uname";

	fn run(self, host: &mut Host) -> i32 {
		let options = Options {
			all:               self.matches.get_flag(options::ALL),
			kernel_name:       self.matches.get_flag(options::KERNEL_NAME),
			nodename:          self.matches.get_flag(options::NODENAME),
			kernel_release:    self.matches.get_flag(options::KERNEL_RELEASE),
			kernel_version:    self.matches.get_flag(options::KERNEL_VERSION),
			machine:           self.matches.get_flag(options::MACHINE),
			processor:         self.matches.get_flag(options::PROCESSOR),
			hardware_platform: self.matches.get_flag(options::HARDWARE_PLATFORM),
			os:                self.matches.get_flag(options::OS),
		};
		let output = match UNameOutput::new(&options) {
			Ok(output) => output,
			Err(message) => {
				host.error(message, 1);
				return 1;
			},
		};
		let display = output.display();
		let Some(bytes) = os_bytes(display.as_os_str()) else {
			let lossy = display.to_string_lossy();
			host.error(
				format!(
					"invalid UTF-8 input {} encountered when converting to bytes on a platform that doesn't expose byte arguments",
					lossy.quote()
				),
				1,
			);
			return 1;
		};
		if let Err(error) = host
			.stdout
			.write_all(bytes)
			.and_then(|()| host.stdout.write_all(b"\n"))
			.and_then(|()| host.stdout.flush())
		{
			host.error(error, 1);
			return 1;
		}
		0
	}
}

fn uu_app() -> Command {
	Command::new("uname")
		.version("0.8.0")
		.about("Print certain system information.\nWith no OPTION, same as -s.")
		.override_usage(format_usage("uname [OPTION]..."))
		.infer_long_args(true)
		.arg(
			Arg::new(options::ALL)
				.short('a')
				.long(options::ALL)
				.help("Behave as though all of the options -mnrsvo were specified.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::KERNEL_NAME)
				.short('s')
				.long(options::KERNEL_NAME)
				.alias("sysname")
				.help("print the kernel name.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::NODENAME)
				.short('n')
				.long(options::NODENAME)
				.help(
					"print the nodename (the nodename may be a name that the system is known by to a \
					 communications network).",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::KERNEL_RELEASE)
				.short('r')
				.long(options::KERNEL_RELEASE)
				.alias("release")
				.help("print the operating system release.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::KERNEL_VERSION)
				.short('v')
				.long(options::KERNEL_VERSION)
				.help("print the operating system version.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::MACHINE)
				.short('m')
				.long(options::MACHINE)
				.help("print the machine hardware name.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::OS)
				.short('o')
				.long(options::OS)
				.help("print the operating system name.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::PROCESSOR)
				.short('p')
				.long(options::PROCESSOR)
				.help("print the processor type (non-portable)")
				.action(ArgAction::SetTrue)
				.hide(true),
		)
		.arg(
			Arg::new(options::HARDWARE_PLATFORM)
				.short('i')
				.long(options::HARDWARE_PLATFORM)
				.help("print the hardware platform (non-portable)")
				.action(ArgAction::SetTrue)
				.hide(true),
		)
}


pub(crate) fn uname_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Uname, SE>()
}


