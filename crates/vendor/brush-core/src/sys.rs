

#![allow(unused)]

#[cfg(unix)]
pub(crate) mod unix;
#[cfg(unix)]
pub(crate) use unix as platform;

#[cfg(target_family = "wasm")]
pub(crate) mod wasm;
#[cfg(target_family = "wasm")]
pub(crate) use wasm as platform;

#[cfg(not(unix))]
pub(crate) mod stubs;

#[cfg(unix)]
pub(crate) mod hostname;
#[cfg(unix)]
pub mod tokio_process;

pub mod fs;

pub use platform::{
	PlatformError, async_pipe, commands, fd, input, poll, process, resource, signal, terminal,
};
pub(crate) use platform::{env, network, users};
