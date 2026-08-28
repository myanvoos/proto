

use crate::{error, sys, traps};


#[cfg(not(windows))]
#[allow(unnameable_types)]
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Signal {}


#[cfg(windows)]
#[allow(unnameable_types)]
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Signal {

	Terminate,

	Kill,

	Interrupt,
}

impl Signal {

	#[cfg(windows)]
	pub fn iterator() -> impl Iterator<Item = Self> {
		[Self::Terminate, Self::Kill, Self::Interrupt].into_iter()
	}


	#[cfg(not(windows))]
	pub fn iterator() -> impl Iterator<Item = Self> {
		std::iter::empty()
	}


	#[cfg(windows)]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Terminate => "TERM",
			Self::Kill => "KILL",
			Self::Interrupt => "INT",
		}
	}


	#[cfg(not(windows))]
	pub const fn as_str(self) -> &'static str {
		""
	}


	#[cfg(windows)]
	pub fn from_str(s: &str) -> Result<Self, error::Error> {
		match s.to_ascii_uppercase().as_str() {
			"TERM" | "SIGTERM" => Ok(Self::Terminate),
			"KILL" | "SIGKILL" => Ok(Self::Kill),
			"INT" | "SIGINT" => Ok(Self::Interrupt),
			_ => Err(error::ErrorKind::InvalidSignal(s.into()).into()),
		}
	}


	#[cfg(not(windows))]
	pub fn from_str(s: &str) -> Result<Self, error::Error> {
		Err(error::ErrorKind::InvalidSignal(s.into()).into())
	}
}

impl TryFrom<i32> for Signal {
	type Error = error::Error;

	fn try_from(value: i32) -> Result<Self, Self::Error> {
		Err(error::ErrorKind::InvalidSignal(std::format!("{value}")).into())
	}
}

pub(crate) fn continue_process(_pid: sys::process::ProcessId) -> Result<(), error::Error> {
	Err(error::ErrorKind::NotSupportedOnThisPlatform("continuing process").into())
}




pub fn kill_process(
	_pid: sys::process::ProcessId,
	_signal: traps::TrapSignal,
) -> Result<(), error::Error> {
	#[cfg(windows)]
	{
		use windows_sys::Win32::Foundation::CloseHandle;
		use windows_sys::Win32::System::Threading::{
			OpenProcess, PROCESS_TERMINATE, TerminateProcess,
		};

		let pid = u32::try_from(_pid).map_err(|_| error::ErrorKind::FailedToSendSignal)?;


		let handle = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
		if handle.is_null() {
			return Err(error::ErrorKind::FailedToSendSignal.into());
		}


		let ok = unsafe { TerminateProcess(handle, 1) };

		let _close_result = unsafe { CloseHandle(handle) };
		if ok == 0 {
			return Err(error::ErrorKind::FailedToSendSignal.into());
		}

		Ok(())
	}
	#[cfg(not(windows))]
	Err(error::ErrorKind::NotSupportedOnThisPlatform("killing process").into())
}

pub(crate) fn lead_new_process_group() -> Result<(), error::Error> {
	Ok(())
}

pub(crate) struct FakeSignal {}

impl FakeSignal {
	fn new() -> Self {
		Self {}
	}

	pub async fn recv(&self) {
		futures::future::pending::<()>().await;
	}
}

pub(crate) fn tstp_signal_listener() -> Result<FakeSignal, error::Error> {
	Ok(FakeSignal::new())
}

pub(crate) fn chld_signal_listener() -> Result<FakeSignal, error::Error> {
	Ok(FakeSignal::new())
}

pub(crate) async fn await_ctrl_c() -> std::io::Result<()> {
	FakeSignal::new().recv().await;
	Ok(())
}

pub(crate) fn mask_sigttou() -> Result<(), error::Error> {
	Ok(())
}

pub(crate) fn poll_for_stopped_children() -> Result<bool, error::Error> {
	Ok(false)
}
