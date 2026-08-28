use std::{
	future::Future,
	panic::{AssertUnwindSafe, catch_unwind},
};

use napi::{Env, Error, Result, Status, Task, bindgen_prelude::*};
use pi_shell::cancel as core_cancel;

use crate::prof::profile_region;

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
		if let Some(signal) = signal.and_then(|value| AbortSignal::from_unknown(value).ok()) {
			let abort_token = result.emplace_abort_token();
			signal.on_abort(move || abort_token.abort(AbortReason::Signal));
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

	pub fn into_core(self) -> core_cancel::CancelToken {
		self.core
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
	type Output = T;

	fn compute(&mut self) -> Result<Self::Output> {
		let _guard = profile_region(self.tag);
		let work = self
			.work
			.take()
			.ok_or_else(|| Error::from_reason("BlockingTask: work already consumed"))?;
		let cancel_token = self.cancel_token.clone();
		let tag = self.tag;

		match catch_unwind(AssertUnwindSafe(move || {
			crate::crash_handler::blocking_task_panic_scope(move || work(cancel_token))
		})) {
			Ok(result) => result,
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

	fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
		Ok(output)
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
