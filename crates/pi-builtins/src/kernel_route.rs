//! Argv routing for the JavaScript kernel-cell builtins (`node`, `nodejs`,
//! `bun`). The builtins decide at run time from this table whether an
//! invocation executes as a kernel cell or falls through to a real
//! interpreter; the static code scanner (`pi-natives`) asks the same question
//! of a command it has only parsed, so both answers come from one rule.

/// The argv grammar a kernel-cell builtin accepts before it falls through.
pub struct KernelArgv {
	/// Flag whose following argument is the program text (`-c`, `-e`).
	pub code_flag:   &'static str,
	/// Interpreter flags the kernel honors implicitly and skips over.
	pub passthrough: &'static [&'static str],
}

/// Node's and Bun's program flag.
pub const JS_ARGV: KernelArgv = KernelArgv { code_flag: "-e", passthrough: &[] };

/// Where a kernel-cell builtin takes its program from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(
	not(all(unix, feature = "util.node")),
	allow(dead_code, reason = "the script index is read by the unix kernel builtins")
)]
pub enum ArgvRoute {
	/// `-c CODE` / `-e CODE` followed by program arguments; the index is CODE's.
	Code(usize),
	/// No program argument: the program is read from stdin.
	Stdin,
	/// A script path at this index.
	Script(usize),
	/// Anything the kernel does not model; a real interpreter runs it.
	External,
}

/// Classify an argv (program name excluded). `None` marks an argument whose
/// text is unknown (non-UTF-8 at run time), which only a real interpreter can
/// take.
pub fn route_argv(spec: &KernelArgv, argv: &[Option<&str>]) -> ArgvRoute {
	if argv.iter().any(Option::is_none) {
		return ArgvRoute::External;
	}
	let mut index = 0;
	while index < argv.len() {
		let Some(arg) = argv[index] else {
			return ArgvRoute::External;
		};
		if spec.passthrough.contains(&arg) {
			index += 1;
			continue;
		}
		if arg == spec.code_flag {
			if argv.get(index + 1).is_none() {
				return ArgvRoute::External;
			}
			// Node/Bun still parse options until -- or the first positional argument.
			// Leave unsupported options to the native interpreter.
			if argv
				.get(index + 2)
				.and_then(|arg| *arg)
				.is_some_and(|arg| arg.starts_with('-') && arg != "--")
			{
				return ArgvRoute::External;
			}
			return ArgvRoute::Code(index + 1);
		}
		if arg == "-" {
			return ArgvRoute::Stdin;
		} else if arg.starts_with('-') {
			return ArgvRoute::External;
		} else {
			return ArgvRoute::Script(index);
		}
	}
	ArgvRoute::Stdin
}

/// Only JavaScript runtimes have implicit persistent-cell routing.
pub fn kernel_builtin_argv(name: &str) -> Option<&'static KernelArgv> {
	match name {
		"node" | "nodejs" | "bun" if cfg!(all(feature = "util.node", unix)) => Some(&JS_ARGV),
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn argv(words: &[&'static str]) -> Vec<Option<&'static str>> {
		words.iter().copied().map(Some).collect()
	}

	#[test]
	fn code_scripts_and_stdin_route_distinctly() {
		assert_eq!(route_argv(&JS_ARGV, &argv(&["-e", "x"])), ArgvRoute::Code(1));
		assert_eq!(route_argv(&JS_ARGV, &argv(&["-e", "x", "a"])), ArgvRoute::Code(1));
		assert_eq!(route_argv(&JS_ARGV, &argv(&["prog.js"])), ArgvRoute::Script(0));
		assert_eq!(route_argv(&JS_ARGV, &argv(&[])), ArgvRoute::Stdin);
		assert_eq!(route_argv(&JS_ARGV, &argv(&["-"])), ArgvRoute::Stdin);
	}

	#[test]
	fn unsupported_options_and_unknown_text_fall_through() {
		assert_eq!(route_argv(&JS_ARGV, &argv(&["--version"])), ArgvRoute::External);
		assert_eq!(route_argv(&JS_ARGV, &argv(&["-e", "x", "-p"])), ArgvRoute::External);
		assert_eq!(route_argv(&JS_ARGV, &[None]), ArgvRoute::External);
	}
}
