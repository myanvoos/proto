

use std::{
	collections::VecDeque,
	fmt::Display,
	sync::atomic::{AtomicI32, Ordering},
	time::Duration,
};

use futures::FutureExt;

use crate::{ExecutionResult, error, processes, sys, trace_categories, traps};

pub(crate) type JobJoinHandle = tokio::task::JoinHandle<Result<ExecutionResult, error::Error>>;
pub(crate) type JobResult = (Job, Result<ExecutionResult, error::Error>);

const WAIT_NEXT_POLL_INTERVAL: Duration = Duration::from_millis(10);

/// Jobs that run entirely inside the shell process (builtins, functions,
/// subshells, compound commands) have no OS process, but `$!`, `jobs -l`,
/// `wait PID` and `kill PID` still need a PID to name them. Real PIDs stay below
/// Linux's `PID_MAX_LIMIT` (2^22) and macOS's 99999, so IDs allocated from here
/// never name, and can never signal, a real process.
const FIRST_SYNTHETIC_PID: sys::process::ProcessId = 1 << 22;
static NEXT_SYNTHETIC_PID: AtomicI32 = AtomicI32::new(FIRST_SYNTHETIC_PID);

fn allocate_synthetic_pid() -> sys::process::ProcessId {
	NEXT_SYNTHETIC_PID.fetch_add(1, Ordering::Relaxed)
}


#[derive(Clone, Copy)]
pub enum JobSelector {

	JobId(usize),

	ProcessId(i32),
}


pub struct WaitedJob {

	pub id: usize,

	pub identifier: String,

	pub command_line: String,

	pub result: ExecutionResult,
}

impl WaitedJob {
	fn from_job(job: Job, result: ExecutionResult, identifier: String) -> Self {
		Self { id: job.id, identifier, command_line: job.command_line, result }
	}
}


#[derive(Default)]
pub struct JobManager {

	pub jobs: Vec<Job>,
}


pub enum JobTask {

	External(processes::ChildProcess),

	Internal(JobJoinHandle),
}


pub enum JobTaskWaitResult {

	Completed(ExecutionResult),

	Stopped,
}

impl JobTask {

	pub const fn is_external(&self) -> bool {
		matches!(self, Self::External(_))
	}

	fn is_finished(&self) -> bool {
		match self {
			Self::External(_) => false,
			Self::Internal(handle) => handle.is_finished(),
		}
	}


	pub async fn wait(
		&mut self,
		wait_for_terminate: bool,
	) -> Result<JobTaskWaitResult, error::Error> {
		match self {
			Self::External(process) => loop {
				let wait_result = process.wait(None).await?;
				match wait_result {
					processes::ProcessWaitResult::Completed(output) => {
						break Ok(JobTaskWaitResult::Completed(output.into()));
					},
					processes::ProcessWaitResult::Stopped if wait_for_terminate => {},
					processes::ProcessWaitResult::Stopped => break Ok(JobTaskWaitResult::Stopped),
					processes::ProcessWaitResult::Cancelled => {
						break Ok(JobTaskWaitResult::Completed(ExecutionResult::new(130)));
					},
				}
			},
			Self::Internal(handle) => Ok(JobTaskWaitResult::Completed(handle.await??)),
		}
	}


	fn poll(&mut self) -> Option<Result<ExecutionResult, error::Error>> {
		match self {
			Self::External(process) => {
				let check_result = process.poll();
				check_result.map(|polled_result| polled_result.map(|output| output.into()))
			},
			Self::Internal(handle) => {
				let checkable_handle = handle;
				checkable_handle.now_or_never().and_then(|r| r.ok())
			},
		}
	}
}

impl JobManager {

	pub fn new() -> Self {
		Self::default()
	}


	#[allow(clippy::missing_panics_doc, reason = "push() guarantees the vector length is >= 1")]
	pub fn add_as_current(&mut self, mut job: Job) -> &Job {
		for j in &mut self.jobs {
			if matches!(j.annotation, JobAnnotation::Current) {
				j.annotation = JobAnnotation::Previous;
				break;
			}
		}

		let id = self.jobs.len() + 1;
		job.id = id;
		job.annotation = JobAnnotation::Current;
		self.jobs.push(job);

		#[allow(clippy::unwrap_used, reason = "we just pushed an element")]
		self.jobs.last().unwrap()
	}


	pub fn current_job(&self) -> Option<&Job> {
		self
			.jobs
			.iter()
			.find(|j| matches!(j.annotation, JobAnnotation::Current))
	}


	pub fn current_job_mut(&mut self) -> Option<&mut Job> {
		self
			.jobs
			.iter_mut()
			.find(|j| matches!(j.annotation, JobAnnotation::Current))
	}


	pub fn prev_job(&self) -> Option<&Job> {
		self
			.jobs
			.iter()
			.find(|j| matches!(j.annotation, JobAnnotation::Previous))
	}


	pub fn prev_job_mut(&mut self) -> Option<&mut Job> {
		self
			.jobs
			.iter_mut()
			.find(|j| matches!(j.annotation, JobAnnotation::Previous))
	}


	pub fn resolve_job_spec(&mut self, job_spec: &str) -> Option<&mut Job> {
		let remainder = job_spec.strip_prefix('%')?;

		match remainder {
			"%" | "+" => self.current_job_mut(),
			"-" => self.prev_job_mut(),
			s if s.chars().all(char::is_numeric) => {
				let id = s.parse::<usize>().ok()?;
				self.jobs.iter_mut().find(|j| j.id == id)
			},
			_ => {
				tracing::warn!(target: trace_categories::UNIMPLEMENTED, "unimplemented: job spec naming command: '{job_spec}'");
				None
			},
		}
	}


	pub fn resolve_job_spec_selector(&self, job_spec: &str) -> Option<JobSelector> {
		let remainder = job_spec.strip_prefix('%')?;

		match remainder {
			"%" | "+" => self.current_job().map(|job| JobSelector::JobId(job.id)),
			"-" => self.prev_job().map(|job| JobSelector::JobId(job.id)),
			s if s.chars().all(char::is_numeric) => {
				let id = s.parse::<usize>().ok()?;
				self
					.jobs
					.iter()
					.any(|job| job.id == id)
					.then_some(JobSelector::JobId(id))
			},
			_ => {
				tracing::warn!(target: trace_categories::UNIMPLEMENTED, "unimplemented: job spec naming command: '{job_spec}'");
				None
			},
		}
	}


	pub fn contains_process_id(&self, pid: i32) -> bool {
		self.jobs.iter().any(|job| job.contains_process_id(pid))
	}


	pub fn resolve_process_id(&mut self, pid: i32) -> Option<&mut Job> {
		self.jobs.iter_mut().find(|job| job.contains_process_id(pid))
	}


	pub async fn wait_all(&mut self) -> Result<Vec<Job>, error::Error> {
		self.wait_all_with_policy(false).await
	}


	pub async fn wait_all_for_termination(&mut self) -> Result<Vec<Job>, error::Error> {
		self.wait_all_with_policy(true).await
	}

	async fn wait_all_with_policy(
		&mut self,
		wait_for_terminate: bool,
	) -> Result<Vec<Job>, error::Error> {
		for job in &mut self.jobs {
			job.wait_with_policy(wait_for_terminate).await?;
		}

		Ok(self.sweep_completed_jobs())
	}


	pub async fn wait_next(
		&mut self,
		selectors: &[JobSelector],
	) -> Result<Option<WaitedJob>, error::Error> {
		loop {
			let mut found_candidate = false;
			let mut i = 0;
			while i != self.jobs.len() {
				if !selectors.is_empty()
					&& !selectors
						.iter()
						.any(|selector| self.jobs[i].matches_selector(*selector))
				{
					i += 1;
					continue;
				}

				found_candidate = true;
				let identifier = self.jobs[i].wait_identifier();
				if let Some(result) = self.jobs[i].poll_done()? {
					let job = self.jobs.remove(i);
					return result.map(|result| Some(WaitedJob::from_job(job, result, identifier)));
				}
				if matches!(self.jobs[i].state, JobState::Done) {
					let job = self.jobs.remove(i);
					return Ok(Some(WaitedJob::from_job(
						job,
						ExecutionResult::success(),
						identifier,
					)));
				}
				i += 1;
			}

			if !found_candidate {
				return Ok(None);
			}

			tokio::time::sleep(WAIT_NEXT_POLL_INTERVAL).await;
		}
	}


	pub fn poll(&mut self) -> Result<Vec<JobResult>, error::Error> {
		let mut results = vec![];

		let mut i = 0;
		while i != self.jobs.len() {
			if let Some(result) = self.jobs[i].poll_done()? {
				let job = self.jobs.remove(i);
				results.push((job, result));
			} else if matches!(self.jobs[i].state, JobState::Done) {


				results.push((self.jobs.remove(i), Ok(ExecutionResult::success())));
			} else {
				i += 1;
			}
		}

		Ok(results)
	}

	fn sweep_completed_jobs(&mut self) -> Vec<Job> {
		let mut completed_jobs = vec![];

		let mut i = 0;
		while i != self.jobs.len() {
			if self.jobs[i].tasks.is_empty() {
				completed_jobs.push(self.jobs.remove(i));
			} else {
				i += 1;
			}
		}

		completed_jobs
	}
}


#[derive(Clone)]
pub enum JobState {

	Unknown,

	Running,

	Stopped,

	Done,
}

impl Display for JobState {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Unknown => write!(f, "Unknown"),
			Self::Running => write!(f, "Running"),
			Self::Stopped => write!(f, "Stopped"),
			Self::Done => write!(f, "Done"),
		}
	}
}


#[derive(Clone)]
pub enum JobAnnotation {

	None,

	Current,

	Previous,
}

impl Display for JobAnnotation {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::None => write!(f, ""),
			Self::Current => write!(f, "+"),
			Self::Previous => write!(f, "-"),
		}
	}
}


pub struct Job {

	tasks: VecDeque<JobTask>,


	pgid: Option<sys::process::ProcessId>,

	/// Stands in for the PID of a job with no external process; see
	/// [`FIRST_SYNTHETIC_PID`].
	synthetic_pid: Option<sys::process::ProcessId>,

	/// Signal that terminated an in-shell job via [`Job::signal_in_shell`].
	terminated_by_signal: Option<i32>,

	annotation: JobAnnotation,


	pub id: usize,


	pub command_line: String,


	pub state: JobState,
}

impl Display for Job {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		write!(
			f,
			"[{}]{:3}{}\t{}",
			self.id,
			self.annotation.to_string(),
			self.state,
			self.command_line
		)
	}
}

impl Job {


	pub(crate) fn new<I>(tasks: I, command_line: String, state: JobState) -> Self
	where
		I: IntoIterator<Item = JobTask>,
	{
		let tasks: VecDeque<JobTask> = tasks.into_iter().collect();
		let synthetic_pid =
			(!tasks.iter().any(JobTask::is_external)).then(allocate_synthetic_pid);
		Self {
			id: 0,
			tasks,
			pgid: None,
			synthetic_pid,
			terminated_by_signal: None,
			annotation: JobAnnotation::None,
			command_line,
			state,
		}
	}


	pub fn to_pid_style_string(&self) -> String {
		let display_pid = self
			.representative_pid()
			.map_or_else(|| String::from("<pid unknown>"), |pid| pid.to_string());
		std::format!("[{}]{}\t{}", self.id, self.annotation, display_pid)
	}


	pub fn annotation(&self) -> JobAnnotation {
		self.annotation.clone()
	}


	pub fn command_name(&self) -> &str {
		self
			.command_line
			.split_ascii_whitespace()
			.next()
			.unwrap_or_default()
	}


	pub const fn is_current(&self) -> bool {
		matches!(self.annotation, JobAnnotation::Current)
	}


	pub const fn is_prev(&self) -> bool {
		matches!(self.annotation, JobAnnotation::Previous)
	}


	pub fn poll_done(
		&mut self,
	) -> Result<Option<Result<ExecutionResult, error::Error>>, error::Error> {
		let mut result: Option<Result<ExecutionResult, error::Error>> = None;

		tracing::debug!(target: trace_categories::JOBS, "Polling job {} for completion...", self.id);

		while !self.tasks.is_empty() {
			let task = &mut self.tasks[0];
			match task.poll() {
				Some(r) => {
					self.tasks.remove(0);
					result = Some(r);
				},
				None => {
					return Ok(None);
				},
			}
		}

		tracing::debug!(target: trace_categories::JOBS, "Job {} has completed.", self.id);

		self.state = JobState::Done;

		Ok(result.or_else(|| self.signal_termination_result().map(Ok)))
	}


	pub async fn wait(&mut self) -> Result<ExecutionResult, error::Error> {
		self.wait_with_policy(false).await
	}


	pub async fn wait_for_termination(&mut self) -> Result<ExecutionResult, error::Error> {
		self.wait_with_policy(true).await
	}

	async fn wait_with_policy(
		&mut self,
		wait_for_terminate: bool,
	) -> Result<ExecutionResult, error::Error> {
		let mut result = self.signal_termination_result().unwrap_or_else(ExecutionResult::success);

		while let Some(task) = self.tasks.back_mut() {
			match task.wait(wait_for_terminate).await? {
				JobTaskWaitResult::Completed(execution_result) => {
					result = execution_result;
					self.tasks.pop_back();
				},
				JobTaskWaitResult::Stopped => {
					self.state = JobState::Stopped;
					return Ok(ExecutionResult::stopped());
				},
			}
		}

		self.state = JobState::Done;

		Ok(result)
	}


	pub fn move_to_background(&mut self) -> Result<(), error::Error> {
		match &self.state {
			JobState::Stopped => {
				let pgid = self
					.process_group_id()
					.ok_or(error::ErrorKind::FailedToSendSignal)?;
				sys::signal::continue_process(pgid)?;
				self.state = JobState::Running;
				Ok(())
			},
			JobState::Running => Ok(()),
			JobState::Unknown | JobState::Done => Err(error::ErrorKind::FailedToSendSignal.into()),
		}
	}


	pub fn move_to_foreground(&mut self) -> Result<(), error::Error> {
		if matches!(self.state, JobState::Stopped) {
			if let Some(pgid) = self.process_group_id() {
				sys::signal::continue_process(pgid)?;
				self.state = JobState::Running;
			} else {
				return Err(error::ErrorKind::FailedToSendSignal.into());
			}
		}

		if let Some(pgid) = self.process_group_id() {
			sys::terminal::move_to_foreground(pgid)?;
		}

		Ok(())
	}


	pub fn kill(&self, signal: traps::TrapSignal) -> Result<(), error::Error> {
		if let Some(pid) = self.process_group_id() {
			sys::signal::kill_process(pid, signal)
		} else {
			Err(error::ErrorKind::FailedToSendSignal.into())
		}
	}


	/// Delivers `signal` to a job that has a synthetic PID. There is no OS process
	/// to signal, so the signal's default action is applied to the job itself:
	/// terminating signals abort its in-shell tasks (dropping them kills any
	/// external children they spawned) and `wait` then reports `128 + signal`;
	/// ignored signals are no-ops; stop signals fail because in-shell work
	/// cannot be suspended.
	pub fn signal_in_shell(&mut self, signal: traps::TrapSignal) -> Result<(), error::Error> {
		let traps::TrapSignal::Signal(os_signal) = signal else {
			return Err(error::ErrorKind::InvalidSignal(signal.to_string()).into());
		};
		if self.synthetic_pid.is_none() || self.tasks.is_empty() {
			return Err(error::ErrorKind::FailedToSendSignal.into());
		}
		match sys::signal::default_disposition(os_signal) {
			sys::signal::DefaultDisposition::Ignore => Ok(()),
			sys::signal::DefaultDisposition::Stop => Err(error::ErrorKind::FailedToSendSignal.into()),
			sys::signal::DefaultDisposition::Terminate { signal_number } => {
				if self.tasks.iter().any(|task| !task.is_finished()) {
					self.terminated_by_signal = Some(signal_number);
					self.abort_internal_tasks();
				}
				Ok(())
			},
		}
	}

	fn signal_termination_result(&self) -> Option<ExecutionResult> {
		let signal_number = u8::try_from(self.terminated_by_signal?).unwrap_or(u8::MAX);
		Some(ExecutionResult::new(128_u8.saturating_add(signal_number)))
	}

	pub fn abort_internal_tasks(&mut self) {
		let mut aborted = false;
		self.tasks.retain_mut(|task| {
			if let JobTask::Internal(handle) = task {
				handle.abort();
				aborted = true;
				return false;
			}
			true
		});
		if aborted && self.tasks.is_empty() {
			self.state = JobState::Done;
		}
	}

	fn matches_selector(&self, selector: JobSelector) -> bool {
		match selector {
			JobSelector::JobId(id) => self.id == id,
			JobSelector::ProcessId(pid) => self.contains_process_id(pid),
		}
	}

	fn contains_process_id(&self, pid: i32) -> bool {
		self.synthetic_pid == Some(pid)
			|| self.tasks.iter().any(|task| match task {
				JobTask::External(process) => process.pid().is_some_and(|process_pid| process_pid == pid),
				JobTask::Internal(_) => false,
			})
	}

	fn wait_identifier(&self) -> String {
		self
			.representative_pid()
			.map_or_else(|| self.id.to_string(), |pid| pid.to_string())
	}

	pub fn external_process_count(&self) -> usize {
		self.tasks.iter().filter(|task| task.is_external()).count()
	}


	pub fn process_ids(&self) -> impl Iterator<Item = sys::process::ProcessId> + '_ {
		self.tasks.iter().filter_map(|task| match task {
			JobTask::External(process) => process.pid(),
			JobTask::Internal(_) => None,
		})
	}


	/// PID reported for the job (`$!`, `jobs -l`, `wait PID`): its first external
	/// process, or its synthetic PID when it runs inside the shell.
	pub fn representative_pid(&self) -> Option<sys::process::ProcessId> {
		self.external_pid().or(self.synthetic_pid)
	}

	/// The job's synthetic PID when it runs inside the shell and so names no OS
	/// process. Signal such jobs with [`Job::signal_in_shell`].
	pub const fn synthetic_pid(&self) -> Option<sys::process::ProcessId> {
		self.synthetic_pid
	}

	fn external_pid(&self) -> Option<sys::process::ProcessId> {
		for task in &self.tasks {
			match task {
				JobTask::External(p) => {
					if let Some(pid) = p.pid() {
						return Some(pid);
					}
				},
				JobTask::Internal(_) => (),
			}
		}
		None
	}


	pub fn process_group_id(&self) -> Option<sys::process::ProcessId> {

		self.pgid.or_else(|| self.external_pid())
	}


}
