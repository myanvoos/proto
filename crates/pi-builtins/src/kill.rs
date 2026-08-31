

use std::io::Write;

use brush_core::{
	ExecutionExitCode, ExecutionResult, builtins, sys, traps::TrapSignal, ExecutionContext,
};
use clap::Parser;

use crate::proc_snapshot::HostProcesses;

#[cfg(not(unix))]
use crate::proc_snapshot::{ProcInfo, ProcessStatus};


#[derive(Parser)]
pub(crate) struct KillCommand {

	#[arg(short = 's', value_name = "SIG_NAME")]
	signal_name:      Option<String>,

	#[arg(short = 'n', value_name = "SIG_NUM")]
	signal_number:    Option<usize>,

	#[arg(short = 'l', short_alias = 'L')]
	list_signals:     bool,

	#[arg(allow_hyphen_values = true)]
	args:             Vec<String>,



	#[arg(last = true, allow_hyphen_values = true)]
	post_marker_args: Vec<String>,
}

impl builtins::Command for KillCommand {
	type Error = brush_core::Error;

	fn new<I>(args: I) -> std::result::Result<Self, clap::Error>
	where
		I: IntoIterator<Item = String>,
	{
		Self::try_parse_from(rewrite_attached_short_options(args))
	}

	#[allow(unknown_lints, reason = "unused_async_trait_impl is unknown to the pinned CI nightly")]
	#[allow(
		clippy::unused_async_trait_impl,
		reason = "the builtin Command trait declares execute as async"
	)]
	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> std::result::Result<ExecutionResult, Self::Error> {
		let default_signal = if let Some(signal_name) = &self.signal_name {
			if let Ok(signal) = KillSignal::parse(signal_name) {
				signal
			} else {
				writeln!(
					context.stderr(),
					"{}: invalid signal name: {}",
					context.command_name,
					signal_name
				)?;
				return Ok(ExecutionExitCode::InvalidUsage.into());
			}
		} else {
			KillSignal::parse("TERM")?
		};
		let mut signal = match self.signal_number {
			Some(signal_number) => {
				let Ok(signal_number) = i32::try_from(signal_number) else {
					writeln!(
						context.stderr(),
						"{}: invalid signal number: {}",
						context.command_name,
						signal_number
					)?;
					return Ok(ExecutionExitCode::InvalidUsage.into());
				};
				if let Ok(signal) = KillSignal::parse(&signal_number.to_string()) {
					signal
				} else {
					writeln!(
						context.stderr(),
						"{}: invalid signal number: {}",
						context.command_name,
						signal_number
					)?;
					return Ok(ExecutionExitCode::InvalidUsage.into());
				}
			},
			None => default_signal,
		};




		let mut operands: Vec<&String> = Vec::new();
		let mut options_done = self.signal_name.is_some() || self.signal_number.is_some();
		let mut consumed_marker = false;
		for arg in &self.args {
			if !consumed_marker && arg == "--" {
				consumed_marker = true;
				options_done = true;
				continue;
			}
			if !options_done && let Some(spec) = arg.strip_prefix('-').filter(|spec| !spec.is_empty())
			{
				signal = if let Ok(signal) = KillSignal::parse(spec) {
					signal
				} else {
					writeln!(context.stderr(), "{}: invalid signal name", context.command_name)?;
					return Ok(ExecutionExitCode::InvalidUsage.into());
				};
				options_done = true;
				continue;
			}
			options_done = true;
			operands.push(arg);
		}
		operands.extend(&self.post_marker_args);

		if self.list_signals {
			return print_kill_signals(&context, operands);
		}
		if operands.is_empty() {
			writeln!(context.stderr(), "{}: invalid usage", context.command_name)?;
			return Ok(ExecutionExitCode::InvalidUsage.into());
		}




		let host = signal.sends_signal().then(HostProcesses::resolve);
		let blocks = |target: i32| host.as_ref().is_some_and(|host| blocks_target(host, target));





		#[cfg(not(unix))]
		let running: Vec<i32> = if signal.sends_signal() {
			Vec::new()
		} else {
			ProcInfo::all()
				.into_iter()
				.filter(|process| process.status() == ProcessStatus::Running)
				.map(|process| process.pid())
				.collect()
		};
		#[cfg(unix)]
		let exists = |target: i32| {

			unsafe { libc::kill(target, 0) == 0 }
		};
		#[cfg(not(unix))]
		let exists = |target: i32| target > 0 && running.contains(&target);

		let mut had_failure = false;
		for operand in operands {
			if context.is_cancelled() {
				return Ok(ExecutionExitCode::Interrupted.into());
			}
			if operand.starts_with('%') {
				let Some(job) = context.shell.jobs_mut().resolve_job_spec(operand) else {
					writeln!(context.stderr(), "{}: {}: no such job", context.command_name, operand)?;
					had_failure = true;
					continue;
				};
				#[cfg(unix)]
				{
					let mut targets: Vec<i32> = job
						.process_ids()
						.filter_map(|pid| {

							let pgid = unsafe { libc::getpgid(pid) };
							(pgid > 0).then_some(-pgid)
						})
						.collect();
					if targets.is_empty()
						&& let Some(pgid) = job.process_group_id()
					{
						targets.push(-pgid);
					}
					targets.sort_unstable();
					targets.dedup();
					if targets.iter().copied().any(&blocks) {
						writeln!(
							context.stderr(),
							"{}: {}: refusing to signal the shell process",
							context.command_name,
							operand
						)?;
						had_failure = true;
						continue;
					}
					let succeeded = match signal {
						KillSignal::Probe => targets.iter().copied().any(&exists),
						KillSignal::Signal(signal) => {
							let mut succeeded = false;
							for target in targets {
								if sys::signal::kill_process(target, signal).is_ok() {
									succeeded = true;
								}
							}
							succeeded
						},
					};
					if !succeeded {
						writeln!(
							context.stderr(),
							"{}: {}: failed to send signal",
							context.command_name,
							operand
						)?;
						had_failure = true;
					}
				}
				continue;
			}

			let pid = match brush_core::int_utils::parse(operand, 10) {
				Ok(pid) => pid,
				Err(err) => {
					writeln!(context.stderr(), "{}: {}: {}", context.command_name, operand, err)?;
					had_failure = true;
					continue;
				},
			};
			if blocks(pid) {
				writeln!(
					context.stderr(),
					"{}: {}: refusing to signal the shell process",
					context.command_name,
					operand
				)?;
				had_failure = true;
				continue;
			}
			match signal {
				KillSignal::Probe => {
					if !exists(pid) {
						writeln!(
							context.stderr(),
							"{}: {}: failed to send signal",
							context.command_name,
							operand
						)?;
						had_failure = true;
					}
				},
				KillSignal::Signal(signal) => {
					if let Err(err) = sys::signal::kill_process(pid, signal) {
						writeln!(context.stderr(), "{}: {}: {}", context.command_name, operand, err)?;
						had_failure = true;
					}
				},
			}
		}

		if had_failure {
			Ok(ExecutionResult::general_error())
		} else {
			Ok(ExecutionResult::success())
		}
	}
}








fn rewrite_attached_short_options(args: impl IntoIterator<Item = String>) -> Vec<String> {
	let mut out: Vec<String> = Vec::new();
	let mut args = args.into_iter();

	out.extend(args.next());
	let mut skip_value = false;
	for arg in &mut args {
		if skip_value {
			skip_value = false;
			out.push(arg);
			continue;
		}
		if arg == "--" {
			out.push(arg);
			break;
		}
		if arg == "-s" || arg == "-n" {
			skip_value = true;
			out.push(arg);
			continue;
		}
		if arg == "-l" || arg == "-L" {
			out.push(arg);
			continue;
		}
		if let Some((option, value)) = split_attached(&arg) {
			out.push(option);
			out.push(value);
			continue;
		}
		out.push(arg);
		break;
	}
	out.extend(args);
	out
}



fn split_attached(arg: &str) -> Option<(String, String)> {
	let rest = arg.get(2..).filter(|rest| !rest.is_empty())?;
	let split = match arg.get(..2)? {
		"-l" | "-L" => true,
		"-s" => KillSignal::parse(&arg[1..]).is_err(),
		"-n" => rest.bytes().all(|byte| byte.is_ascii_digit()),
		_ => false,
	};
	split.then(|| (arg[..2].to_string(), rest.to_string()))
}










fn blocks_target(host: &HostProcesses, target: i32) -> bool {
	if target == -1 || target == 0 {
		return true;
	}
	match target.checked_neg() {
		Some(pgid) if pgid > 0 => host.pgids.contains(&pgid),
		_ => host.pids.contains(&target),
	}
}

fn print_kill_signals<'a>(
	context: &ExecutionContext<'_, impl brush_core::ShellExtensions>,
	signals: impl IntoIterator<Item = &'a String>,
) -> std::result::Result<ExecutionResult, brush_core::Error> {
	let mut result = ExecutionResult::success();
	let mut signals = signals.into_iter().peekable();
	if signals.peek().is_none() {
		return brush_core::traps::format_signals(
			context.stdout(),
			TrapSignal::iterator().filter(|signal| !matches!(signal, TrapSignal::Exit)),
		)
		.map(|()| ExecutionResult::success());
	}
	for value in signals {
		match printed_signal(value) {
			Ok(PrintedSignal::Name(name)) => writeln!(context.stdout(), "{name}")?,
			Ok(PrintedSignal::Number(number)) => writeln!(context.stdout(), "{number}")?,
			Err(err) => {
				writeln!(context.stderr(), "{err}")?;
				result = ExecutionResult::general_error();
			},
		}
	}
	Ok(result)
}



enum PrintedSignal {
	Name(&'static str),
	Number(i32),
}

fn printed_signal(value: &str) -> std::result::Result<PrintedSignal, brush_core::Error> {
	if let Ok(number) = value.parse::<i32>() {



		let signal = TrapSignal::try_from(number).or_else(|err| {
			if number > 128 {
				TrapSignal::try_from(number - 128).map_err(|_| err)
			} else {
				Err(err)
			}
		})?;
		Ok(PrintedSignal::Name(
			signal.as_str().strip_prefix("SIG").unwrap_or(signal.as_str()),
		))
	} else {
		let signal = TrapSignal::try_from(value)?;
		Ok(i32::try_from(signal).map_or(PrintedSignal::Name(signal.as_str()), PrintedSignal::Number))
	}
}







#[derive(Clone, Copy)]
enum KillSignal {
	Probe,
	Signal(TrapSignal),
}

impl KillSignal {
	fn parse(value: &str) -> std::result::Result<Self, brush_core::Error> {
		if let Ok(number) = value.parse::<i32>() {
			if number == 0 {
				Ok(Self::Probe)
			} else {
				TrapSignal::try_from(number).map(Self::Signal)
			}
		} else {
			TrapSignal::try_from(value).map(Self::Signal)
		}
	}

	const fn sends_signal(self) -> bool {
		matches!(self, Self::Signal(_))
	}
}





#[allow(
	dead_code,
	reason = "shared with optional process-match builtins that may be feature-disabled"
)]
pub(crate) fn signal_number(value: &str) -> Option<i32> {
	let value = value
		.strip_prefix("SIG")
		.or_else(|| value.strip_prefix("sig"))
		.unwrap_or(value);
	if let Ok(number) = value.parse::<i32>() {
		#[cfg(target_os = "linux")]
		return (0..=libc::SIGRTMAX()).contains(&number).then_some(number);
		#[cfg(target_os = "macos")]
		return (0..=31).contains(&number).then_some(number);
		#[cfg(not(unix))]
		return (0..=64).contains(&number).then_some(number);
	}
	match KillSignal::parse(value).ok()? {
		KillSignal::Probe => Some(0),
		KillSignal::Signal(signal) => i32::try_from(signal).ok(),
	}
}
