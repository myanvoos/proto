//! Argv routing for the kernel-cell builtins (`python`, `python3`, `node`,
//! `nodejs`, `bun`). The builtins decide at run time from this table whether an
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
pub(crate) fn route_argv(spec: &KernelArgv, argv: &[Option<&str>]) -> ArgvRoute {
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
			// Python stops parsing options at -c. Node/Bun still parse options
			// until -- or the first positional argument; leave those to native.
			if spec.code_flag == "-e"
				&& argv
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

/// The kernel argv grammar a command word dispatches to in this build: the
/// names `factory` registers the kernel builtins under, plus their aliases.
pub(crate) fn kernel_builtin_argv(name: &str) -> Option<&'static KernelArgv> {
	match kernel_builtin_alias(name).unwrap_or(name) {
		"python" | "python3" if cfg!(all(feature = "util.python", unix)) => Some(&PYTHON_ARGV),
		"node" | "nodejs" | "bun" if cfg!(all(feature = "util.node", unix)) => Some(&JS_ARGV),
		_ => None,
	}
}

/// The kernel builtin serving an explicitly chosen Python 3 interpreter: one
/// invoked by path (`.venv/bin/python`) or by version (`python3.13`). Bare
/// `python`/`python3` are builtins in their own right, not aliases.
pub fn kernel_builtin_alias(command_name: &str) -> Option<&'static str> {
	if !cfg!(all(feature = "util.python", unix)) || matches!(command_name, "python" | "python3") {
		return None;
	}
	let base = command_name.rsplit('/').next().unwrap_or(command_name);
	is_python3_name(base).then_some("python")
}

/// `python`, `python3`, `python3.13`, `python3.13t`.
fn is_python3_name(name: &str) -> bool {
	let Some(rest) = name.strip_prefix("python") else {
		return false;
	};
	if rest.is_empty() || rest == "3" {
		return true;
	}
	let Some(minor) = rest.strip_prefix("3.") else {
		return false;
	};
	let minor = minor.strip_suffix('t').unwrap_or(minor);
	!minor.is_empty() && minor.bytes().all(|byte| byte.is_ascii_digit())
}

#[cfg(all(test, unix, feature = "util.python"))]
mod tests {
	use super::{ArgvRoute, JS_ARGV, PYTHON_ARGV, kernel_builtin_alias, route_argv};

	#[test]
	fn program_arguments_do_not_change_kernel_routing() {
		for (spec, args, expected) in [
			(&PYTHON_ARGV, vec!["-c", "code", "--flag", "value"], ArgvRoute::Code(1)),
			(&PYTHON_ARGV, vec!["-u", "-c", "code", "arg"], ArgvRoute::Code(2)),
			(&PYTHON_ARGV, vec!["-", "arg"], ArgvRoute::Stdin),
			(&JS_ARGV, vec!["-e", "code", "arg", "--flag"], ArgvRoute::Code(1)),
			(&JS_ARGV, vec!["-e", "code", "--", "--flag"], ArgvRoute::Code(1)),
			(&JS_ARGV, vec!["-", "arg"], ArgvRoute::Stdin),
			(&JS_ARGV, vec!["-e", "code", "--input-type=module"], ArgvRoute::External),
			(&PYTHON_ARGV, vec!["-I", "-c", "code"], ArgvRoute::External),
		] {
			let argv = args.iter().copied().map(Some).collect::<Vec<_>>();
			assert_eq!(route_argv(spec, &argv), expected, "{args:?}");
		}
		assert_eq!(route_argv(&PYTHON_ARGV, &[Some("-c"), Some("code"), None]), ArgvRoute::External);
	}

	#[test]
	fn explicit_python3_interpreters_alias_the_python_builtin() {
		for word in [
			".venv/bin/python",
			"/usr/bin/python3",
			"python3.13",
			"./python3.13t",
			"/opt/py/bin/python3.9",
		] {
			assert_eq!(kernel_builtin_alias(word), Some("python"), "{word}");
		}
	}

	#[test]
	fn builtin_names_and_other_programs_do_not_alias() {
		for word in [
			"python",
			"python3",
			"python2",
			"python2.7",
			"pypy3",
			"python3.",
			"python-config",
			"bin/",
			"ipython",
		] {
			assert_eq!(kernel_builtin_alias(word), None, "{word}");
		}
	}
}
