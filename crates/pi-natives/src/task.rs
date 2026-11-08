use std::{
	future::Future,
	panic::{AssertUnwindSafe, catch_unwind},
};

use napi::{Env, Error, Result, Status, Task, bindgen_prelude::*};
use pi_shell::cancel as core_cancel;

use crate::{
	memory::{Settled, native_work},
	prof::profile_region,
};

// ─────────────────────────────────────────────────────────────────────────────
// Cancellation
// ─────────────────────────────────────────────────────────────────────────────

/// Reason for task abortion.
#[derive(Debug, Clone, Copy)]
pub enum AbortReason {
	Unknown,
	Timeout,
	Signal,
	User,
}

impl From<core_cancel::AbortReason> for AbortReason {
	fn from(value: core_cancel::AbortReason) -> Self {
		match value {
			core_cancel::AbortReason::Unknown => Self::Unknown,
			core_cancel::AbortReason::Timeout => Self::Timeout,
			core_cancel::AbortReason::Signal => Self::Signal,
			core_cancel::AbortReason::User => Self::User,
		}
	}
}

impl From<AbortReason> for core_cancel::AbortReason {
	fn from(value: AbortReason) -> Self {
		match value {
			AbortReason::Unknown => Self::Unknown,
			AbortReason::Timeout => Self::Timeout,
			AbortReason::Signal => Self::Signal,
			AbortReason::User => Self::User,
		}
	}
}

#[derive(Clone, Default)]
pub struct CancelToken {
	core: core_cancel::CancelToken,
}

impl From<()> for CancelToken {
	fn from((): ()) -> Self {
		Self::default()
	}
}

impl CancelToken {
	pub fn new(timeout_ms: Option<u32>, signal: Option<Unknown>) -> Self {
		let mut result = Self { core: core_cancel::CancelToken::new(timeout_ms) };
		if let Some(raw_signal) = signal {
			let aborted = raw_signal
				.coerce_to_object()
				.and_then(|object| object.get_named_property::<bool>("aborted"))
				.unwrap_or(false);
			if aborted {
				result.emplace_abort_token().abort(AbortReason::Signal);
			} else if let Ok(signal) = AbortSignal::from_unknown(raw_signal) {
				let abort_token = result.emplace_abort_token();
				signal.on_abort(move || abort_token.abort(AbortReason::Signal));
			}
		}
		result
	}

	pub fn heartbeat(&self) -> Result<()> {
		self
			.core
			.heartbeat()
			.map_err(|err| Error::from_reason(err.to_string()))
	}

	pub async fn wait(&self) -> AbortReason {
		self.core.wait().await.into()
	}

	pub fn abort_token(&self) -> AbortToken {
		AbortToken(self.core.abort_token())
	}

	pub fn emplace_abort_token(&mut self) -> AbortToken {
		AbortToken(self.core.emplace_abort_token())
	}

	pub fn aborted(&self) -> bool {
		self.core.aborted()
	}

	/// A token cancelled once this one aborts or times out (for synchronous
	/// `walk::tree`/search callers); the waiter ends with the returned guard.
	pub fn cancellation(&self) -> Cancellation {
		let token = tokio_util::sync::CancellationToken::new();
		let waiter = {
			let this = self.clone();
			let token = token.clone();
			napi::bindgen_prelude::spawn(async move {
				this.wait().await;
				token.cancel();
			})
		};
		Cancellation { token, waiter }
	}

	pub fn into_core(self) -> core_cancel::CancelToken {
		self.core
	}
}

/// A [`tokio_util::sync::CancellationToken`] fired by a [`CancelToken`]; aborts
/// its waiter task on drop.
pub struct Cancellation {
	token:  tokio_util::sync::CancellationToken,
	waiter: napi::tokio::task::JoinHandle<()>,
}

impl Cancellation {
	/// The token cancelled when the originating [`CancelToken`] aborts or
	/// times out.
	pub const fn token(&self) -> &tokio_util::sync::CancellationToken {
		&self.token
	}
}

impl Drop for Cancellation {
	fn drop(&mut self) {
		self.waiter.abort();
	}
}

#[derive(Clone, Default)]
pub struct AbortToken(core_cancel::AbortToken);

impl AbortToken {
	pub fn abort(&self, reason: AbortReason) {
		self.0.abort(reason.into());
	}
}

pub struct Blocking<T>
where
	T: Send + 'static,
{
	tag:          &'static str,
	cancel_token: CancelToken,
	work:         Option<Box<dyn FnOnce(CancelToken) -> Result<T> + Send>>,
}

impl<T> Task for Blocking<T>
where
	T: ToNapiValue + Send + 'static + TypeName,
{
	type JsValue = T;
	type Output = Settled<T>;

	fn compute(&mut self) -> Result<Self::Output> {
		let _guard = profile_region(self.tag);
		let _work = native_work();
		let work = self
			.work
			.take()
			.ok_or_else(|| Error::from_reason("BlockingTask: work already consumed"))?;
		let cancel_token = self.cancel_token.clone();
		let tag = self.tag;

		match catch_unwind(AssertUnwindSafe(move || {
			crate::crash_handler::blocking_task_panic_scope(move || work(cancel_token))
		})) {
			Ok(result) => result.map(Settled::new),
			Err(payload) => {
				let message = crate::crash_handler::panic_payload(&*payload);
				dispose_panic_payload(payload);
				Err(Error::new(
					Status::GenericFailure,
					format!("native task `{tag}` panicked: {message}"),
				))
			},
		}
	}

	fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
		if let Some(reason) = self.cancel_token.core.abort_reason() {
			let message = format!("Aborted: {reason:?}");
			let built: Result<Error> = (|| {
				let mut error = env.create_error(Error::new(Status::Cancelled, message.clone()))?;
				error.set_named_property("name", "AbortError")?;
				Ok(Error::from(error.to_unknown()))
			})();
			return Err(built.unwrap_or_else(|_| Error::new(Status::Cancelled, message)));
		}
		Ok(output.into_inner())
	}
}

fn dispose_panic_payload(payload: Box<dyn std::any::Any + Send>) {
	if let Err(secondary) = catch_unwind(AssertUnwindSafe(|| {
		crate::crash_handler::blocking_task_panic_scope(|| drop(payload));
	})) {
		std::mem::forget(secondary);
	}
}

pub type Promise<T> = AsyncTask<Blocking<T>>;

pub fn blocking<T, F>(
	tag: &'static str,
	cancel_token: impl Into<CancelToken>,
	work: F,
) -> AsyncTask<Blocking<T>>
where
	F: FnOnce(CancelToken) -> Result<T> + Send + 'static,
	T: ToNapiValue + TypeName + Send + 'static,
{
	AsyncTask::new(Blocking { tag, cancel_token: cancel_token.into(), work: Some(Box::new(work)) })
}

// ─────────────────────────────────────────────────────────────────────────────
// Async Task - Tokio runtime integration
// ─────────────────────────────────────────────────────────────────────────────

/// Run an async task on Tokio's runtime with profiling.
///
/// Use this for operations that need to `.await` (async I/O, `select!`, etc.).
/// For CPU-bound blocking work, use [`blocking_task`] instead.
///
/// # Arguments
/// - `env`: N-API environment (needed for `spawn_future`)
/// - `tag`: Profiling tag for this work
/// - `work`: Async closure that performs the work
///
/// # Example
/// ```ignore
/// #[napi]
/// fn run_async_io<'e>(env: &'e Env) -> Result<PromiseRaw<'e, String>> {
///     async_task(env, "async_io", async move {
///         let data = fetch_data().await?;
///         Ok(data)
///     })
/// }
/// ```
pub fn future<'env, T, Fut>(
	env: &'env Env,
	tag: &'static str,
	work: Fut,
) -> Result<PromiseRaw<'env, T>>
where
	Fut: Future<Output = Result<T>> + Send + 'static,
	T: ToNapiValue + Send + 'static,
{
	env.spawn_future(async move {
		let _guard = profile_region(tag);
		work.await
	})
}

/// Run `work` until it settles or `cancel_token` aborts or times out.
///
/// Dropping `work` on cancellation cancels the walker/search tasks it spawned,
/// which is how `pi_walker` futures stop. The rejection matches [`Blocking`]'s
/// settlement contract: a timeout rejects with `Aborted: Timeout`, other
/// aborts with an `AbortError`.
pub fn cancellable_future<'env, T, Fut>(
	env: &'env Env,
	tag: &'static str,
	cancel_token: CancelToken,
	work: Fut,
) -> Result<PromiseRaw<'env, T>>
where
	Fut: Future<Output = Result<T>> + Send + 'static,
	T: ToNapiValue + Send + 'static,
{
	future(env, tag, async move {
		tokio::select! {
			biased;
			result = work => result,
			reason = cancel_token.wait() => Err(abort_error(reason)),
		}
	})
}

/// The error a cancelled native task rejects with.
pub fn abort_error(reason: AbortReason) -> Error {
	let message = match reason {
		AbortReason::Timeout => "Aborted: Timeout".to_string(),
		other => format!("Aborted: {other:?}"),
	};
	Error::new(Status::Cancelled, message)
}

/// Map a walker root failure to the message the natives report.
pub fn walk_failure(err: pi_walker::walk::WalkError) -> Error {
	let pi_walker::walk::WalkError::Root { path, error } = err;
	Error::from_reason(format!("Native directory scan failed for {}: {error}", path.display()))
}
