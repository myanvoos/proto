//! Argv routing for the kernel-cell builtins (`python`, `python3`, `node`,
//! `bun`). The builtins decide at run time from this table whether an
//! invocation executes as a kernel cell or falls through to a real
//! interpreter; the static code scanner asks the same question of a command
//! it has only parsed, so both answers come from one rule.

/// The argv grammar a kernel-cell builtin accepts before it falls through.
pub(crate) struct KernelArgv {
	/// Flag whose following argument is the program text (`-c`, `-e`).
	pub code_flag:   &'static str,
	/// Interpreter flags the kernel honors implicitly and skips over.
	pub passthrough: &'static [&'static str],
}

pub(crate) const PYTHON_ARGV: KernelArgv = KernelArgv { code_flag: "-c", passthrough: &["-u"] };

pub(crate) const JS_ARGV: KernelArgv = KernelArgv { code_flag: "-e", passthrough: &[] };

/// Where a kernel-cell builtin takes its program from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(
	not(all(unix, any(feature = "util.python", feature = "util.node"))),
	allow(dead_code, reason = "the script index is read by the unix kernel builtins")
)]
pub(crate) enum ArgvRoute {
	/// `-c CODE` / `-e CODE` as the final argument; the index is CODE's.
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
pub(crate) fn route_argv(spec: &KernelArgv, argv: &[Option<&str>]) -> ArgvRoute {
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
			return match argv.get(index + 1) {
				Some(Some(_)) if index + 2 == argv.len() => ArgvRoute::Code(index + 1),
				_ => ArgvRoute::External,
			};
		}
		if arg == "-" {
			if index + 1 < argv.len() {
				return ArgvRoute::External;
			}
		} else if arg.starts_with('-') {
			return ArgvRoute::External;
		} else {
			return ArgvRoute::Script(index);
		}
		index += 1;
	}
	ArgvRoute::Stdin
}

/// The kernel argv grammar a bare command name dispatches to in this build,
/// matching the names `factory` registers the kernel builtins under.
pub(crate) fn kernel_builtin_argv(name: &str) -> Option<&'static KernelArgv> {
	match name {
		"python" | "python3" if cfg!(all(feature = "util.python", unix)) => Some(&PYTHON_ARGV),
		"node" | "bun" if cfg!(all(feature = "util.node", unix)) => Some(&JS_ARGV),
		_ => None,
	}
}
