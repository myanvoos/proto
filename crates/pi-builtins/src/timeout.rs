

use std::{
	io::Write,
	sync::{Arc, Mutex},
	time::Duration,
};

use brush_core::{
	ExecutionContext, ExecutionExitCode, ExecutionResult, ProcessGroupPolicy, SourceInfo,
	SpawnObserver, builtins, sys, traps::TrapSignal,
};
use clap::Parser;
use tokio::time;
use tokio_util::sync::CancellationToken;

use crate::host::{parse_duration, quote_arg};


const EXIT_TIMEOUT_FAILURE: u8 = 125;

const EXIT_TIMED_OUT: u8 = 124;

const EXIT_KILLED: u8 = 137;


#[derive(Parser)]
#[command(disable_help_flag = true)]
struct TimeoutArgs {


	#[arg(short = 's', long = "signal", value_name = "SIGNAL")]
	signal: Option<String>,


	#[arg(short = 'k', long = "kill-after", value_name = "DURATION")]
	kill_after: Option<String>,

	#[arg(long)]
	preserve_status: bool,


	#[arg(long)]
	foreground: bool,

	#[arg(short = 'v', long)]
	verbose: bool,



	#[arg(required = true, allow_hyphen_values = true)]
	duration: String,

	#[arg(required = true, num_args = 1.., trailing_var_arg = true, allow_hyphen_values = true)]
	command: Vec<String>,
}




pub(crate) struct TimeoutCommand {
	argv: Vec<String>,
}

impl clap::FromArgMatches for TimeoutCommand {
	fn from_arg_matches(_matches: &clap::ArgMatches) -> Result<Self, clap::Error> {
		Ok(Self { argv: Vec::new() })
	}

	fn update_from_arg_matches(&mut self, _matches: &clap::ArgMatches) -> Result<(), clap::Error> {
		Ok(())
	}
}

impl clap::CommandFactory for TimeoutCommand {
	fn command() -> clap::Command {
		<TimeoutArgs as clap::CommandFactory>::command()
	}

	fn command_for_update() -> clap::Command {
		<TimeoutArgs as clap::CommandFactory>::command_for_update()
	}
}

impl clap::Parser for TimeoutCommand {}







#[derive(Default)]
struct SpawnRecorder(Mutex<Vec<(i32, Option<i32>)>>);

impl SpawnObserver for SpawnRecorder {
	fn on_spawn(&self, pid: i32, pgid: Option<i32>) {
		if let Ok(mut spawns) = self.0.lock() {
			spawns.push((pid, pgid));
		}
	}
}

impl SpawnRecorder {


	fn signal(&self, signal: TrapSignal, group: bool) -> bool {
		let spawns = match self.0.lock() {
			Ok(spawns) => spawns.clone(),
			Err(_) => return false,
		};
		let mut sent = false;
		for (pid, pgid) in spawns {
			let target = match pgid {
				Some(pgid) if group => -pgid,
				_ => pid,
			};
			if sys::signal::kill_process(target, signal).is_ok() {
				sent = true;
			}
		}
		sent
	}
}



fn parse_signal(spec: &str) -> Option<TrapSignal> {
	let parsed = if let Ok(number) = spec.trim().parse::<i32>() {
		TrapSignal::try_from(number).ok()?
	} else {
		TrapSignal::try_from(spec).ok()?
	};

	matches!(parsed, TrapSignal::Signal(_)).then_some(parsed)
}


fn signal_display(signal: TrapSignal) -> &'static str {
	let name = signal.as_str();
	name.strip_prefix("SIG").unwrap_or(name)
}

impl builtins::Command for TimeoutCommand {
	type Error = brush_core::Error;

	fn new<I>(args: I) -> Result<Self, clap::Error>
	where
		I: IntoIterator<Item = String>,
	{
		Ok(Self { argv: args.into_iter().collect() })
	}

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> std::result::Result<ExecutionResult, brush_core::Error> {
		if context.is_cancelled() {
			return Ok(ExecutionExitCode::Interrupted.into());
		}
		let args = match TimeoutArgs::try_parse_from(&self.argv) {
			Ok(args) => args,
			Err(err) => {


				let rendered = err.to_string();
				if err.use_stderr() {
					let _ = write!(context.stderr(), "{rendered}");
					return Ok(ExecutionResult::new(EXIT_TIMEOUT_FAILURE));
				}
				let _ = write!(context.stdout(), "{rendered}");
				return Ok(ExecutionResult::success());
			},
		};
		let Some(limit) = parse_duration(&args.duration) else {
			let _ = writeln!(
				context.stderr(),
				"timeout: invalid time interval '{}'",
				args.duration
			);
			return Ok(ExecutionResult::new(EXIT_TIMEOUT_FAILURE));
		};
		let kill_after = match &args.kill_after {
			Some(spec) => match parse_duration(spec) {
				Some(duration) => Some(duration),
				None => {
					let _ =
						writeln!(context.stderr(), "timeout: invalid time interval '{spec}'");
					return Ok(ExecutionResult::new(EXIT_TIMEOUT_FAILURE));
				},
			},
			None => None,
		};
		let signal = match &args.signal {
			Some(spec) => match parse_signal(spec) {
				Some(signal) => signal,
				None => {
					let _ = writeln!(context.stderr(), "timeout: '{spec}': invalid signal");
					return Ok(ExecutionResult::new(EXIT_TIMEOUT_FAILURE));
				},
			},
			None => TrapSignal::try_from("TERM").expect("SIGTERM must be a known signal"),
		};

		let child_cancel = CancellationToken::new();
		let spawns = Arc::new(SpawnRecorder::default());
		let mut params = context.params.clone();



		params.process_group_policy = if args.foreground {
			ProcessGroupPolicy::SameProcessGroup
		} else {
			ProcessGroupPolicy::NewProcessGroup
		};
		params.set_cancel_token(child_cancel.clone());
		params.set_spawn_observer(Arc::clone(&spawns) as Arc<dyn SpawnObserver>);

		let mut command_line = String::new();
		for (idx, arg) in args.command.iter().enumerate() {
			if idx > 0 {
				command_line.push(' ');
			}
			command_line.push_str(&quote_arg(arg));
		}



		let mut stderr = context.stderr();
		let outer_cancel = context.cancel_token();
		let source_info = SourceInfo::from("pi-natives:timeout");
		let run_future = context.shell.run_string(command_line, &source_info, &params);
		tokio::pin!(run_future);

		let outer_cancelled = async {
			match &outer_cancel {
				Some(token) => token.cancelled().await,
				None => std::future::pending().await,
			}
		};
		tokio::pin!(outer_cancelled);


		let deadline = async {
			if limit.is_zero() {
				std::future::pending::<()>().await;
			} else {
				time::sleep(limit).await;
			}
		};
		tokio::pin!(deadline);

		tokio::select! {
			result = &mut run_future => return result,
			() = &mut outer_cancelled => {
				child_cancel.cancel();
				return Ok(ExecutionExitCode::Interrupted.into());
			},
			() = &mut deadline => {},
		}


		if args.verbose {
			let _ = writeln!(
				stderr,
				"timeout: sending signal {} to command '{}'",
				signal_display(signal),
				args.command[0]
			);
		}
		let signalled = spawns.signal(signal, !args.foreground);
		if !signalled {



			child_cancel.cancel();
		}
		let mut killed = signal.as_str() == "SIGKILL";







		let reap = |result: Result<ExecutionResult, brush_core::Error>| match result {
			Ok(result) => Ok(Some(result)),
			Err(err) if !signalled && matches!(err.kind(), brush_core::ErrorKind::Interrupted) => {
				Ok(None)
			},
			Err(err) => Err(err),
		};
		let kill_deadline = async {
			match kill_after {
				Some(duration) => time::sleep(duration).await,
				None => std::future::pending().await,
			}
		};
		tokio::pin!(kill_deadline);

		let child_result = tokio::select! {
			result = &mut run_future => reap(result)?,
			() = &mut outer_cancelled => {
				child_cancel.cancel();
				return Ok(ExecutionExitCode::Interrupted.into());
			},
			() = &mut kill_deadline => {
				if args.verbose {
					let _ = writeln!(
						stderr,
						"timeout: sending signal KILL to command '{}'",
						args.command[0]
					);
				}
				killed = true;
				let kill = TrapSignal::try_from("KILL").expect("SIGKILL must be a known signal");
				spawns.signal(kill, !args.foreground);
				child_cancel.cancel();


				match time::timeout(Duration::from_secs(2), &mut run_future).await {
					Ok(result) => reap(result)?,
					Err(_) => None,
				}
			},
		};



		if args.preserve_status {
			if signalled {
				return Ok(child_result.unwrap_or_else(|| ExecutionResult::new(EXIT_KILLED)));
			}





			let number = i32::try_from(signal).unwrap_or(15);
			let code = if killed {
				EXIT_KILLED
			} else {
				128_u8.wrapping_add(number as u8)
			};
			return Ok(ExecutionResult::new(code));
		}
		if killed {
			return Ok(ExecutionResult::new(EXIT_KILLED));
		}
		Ok(ExecutionResult::new(EXIT_TIMED_OUT))
	}
}


