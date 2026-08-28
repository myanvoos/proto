



use std::io::Write;

use brush_core::{
	ShellExtensions,
	builtins::Registration,
	pathsearch,
	sys,
};
use clap::Parser;

use crate::host::{Host, Utility, util};


#[derive(Parser, Debug)]
#[command(name = "which", about = "Locate a command's executable in the shell's PATH")]
pub(crate) struct WhichCli {

	#[arg(short = 'a', long = "all")]
	all: bool,


	#[arg(short = 's')]
	silent: bool,


	#[arg(value_name = "name")]
	names: Vec<String>,
}

impl Utility for WhichCli {
	const NAME: &'static str = "which";
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {

		if self.names.is_empty() {
			let _ = writeln!(host.stderr, "usage: which [-as] program ...");
			return 1;
		}
		let path_var = host.var("PATH").unwrap_or_default().to_owned();
		let mut all_found = true;

		for name in self.names {
			let matches = if sys::fs::contains_path_separator(&name) {
				let candidate = host.resolve(&name);
				if candidate.is_dir() {
					Vec::new()
				} else {
					sys::fs::resolve_executable(candidate).into_iter().collect()
				}
			} else {
				let dirs = sys::fs::split_paths(&path_var).map(|dir| host.resolve(dir));
				let mut found = pathsearch::search_for_executable(dirs, &name);
				if self.all {
					found.collect()
				} else {
					found.next().into_iter().collect()
				}
			};

			if matches.is_empty() {

				all_found = false;
			}
			if !self.silent {
				for path in matches {
					let _ = writeln!(host.stdout, "{}", path.display());
				}
			}
		}

		i32::from(!all_found)
	}
}


pub(crate) fn which_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<WhichCli, SE>()
}


