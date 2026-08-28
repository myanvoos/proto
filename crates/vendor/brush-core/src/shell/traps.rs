

use crate::{ExecutionParameters, ExecutionResult, ProcessGroupPolicy, error, traps::TrapSignal};

impl<SE: crate::extensions::ShellExtensions> crate::Shell<SE> {



	pub async fn on_exit(&mut self) -> Result<(), error::Error> {
		if self.traps.handles(TrapSignal::Exit) {
			self
				.invoke_trap_handler(TrapSignal::Exit, &self.default_exec_params())
				.await?;
		}

		Ok(())
	}























	pub(crate) async fn invoke_trap_handler(
		&mut self,
		signal: TrapSignal,
		params: &ExecutionParameters,
	) -> Result<ExecutionResult, error::Error> {



		if self.call_stack().is_trap_signal_active(signal) {
			return Ok(ExecutionResult::success());
		}



		if self.call_stack().is_trap_delivery_suppressed() {
			return Ok(ExecutionResult::success());
		}



		if (self.in_function() || self.is_subshell())
			&& !self.is_trap_inherited_in_current_scope(signal)
		{
			return Ok(ExecutionResult::success());
		}

		let Some(handler) = self.traps.get_handler(signal).cloned() else {
			return Ok(ExecutionResult::success());
		};

		let mut params = params.clone();
		params.process_group_policy = ProcessGroupPolicy::SameProcessGroup;



		let orig_last_exit_status = self.last_exit_status;





		self.enter_trap_handler(signal, Some(&handler));

		let result = self
			.run_string(&handler.command, &handler.source_info, &params)
			.await;

		self.leave_trap_handler();
		self.last_exit_status = orig_last_exit_status;

		result
	}



	fn is_trap_inherited_in_current_scope(&self, signal: TrapSignal) -> bool {
		match signal {
			TrapSignal::Err => self.options().shell_functions_inherit_err_trap,
			TrapSignal::Debug | TrapSignal::Return => {
				self
					.options()
					.shell_functions_inherit_debug_and_return_traps
			},



			TrapSignal::Exit | TrapSignal::Signal(_) => true,
		}
	}
}
