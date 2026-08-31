

use crate::{error, sys, traps};


#[allow(unnameable_types)]
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Signal {}


impl Signal {

		pub fn iterator() -> impl Iterator<Item = Self> {
		std::iter::empty()
	}


		pub const fn as_str(self) -> &'static str {
		""
	}


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
