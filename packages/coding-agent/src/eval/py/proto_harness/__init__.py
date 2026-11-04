"""Explicit, session-authenticated Python harness API (loaded on demand)."""
_HELPERS = frozenset(("display", "env", "block_range", "symbols", "tool", "completion",
    "agent", "parallel", "pipeline", "BatchError", "task_signal", "executions", "start_tool",
    "tool_events", "cancel_tool", "dispose_tool", "delegate", "delegations", "revoke_delegation",
    "launch_delegated", "publish_artifact", "read_artifact", "resolve_artifact", "log", "phase", "budget"))


def kernel(name="main", *, interpreter=None, cwd=None, target=None):
    from .kernel import Kernel
    # Importing the child module must not replace this callable package API.
    globals()["kernel"] = _kernel_factory
    return Kernel(name, interpreter=interpreter, cwd=cwd, target=target)


_kernel_factory = kernel


def __getattr__(name):
    if name in _HELPERS:
        from . import helpers
        value = getattr(helpers, name)
    elif name == "output":
        from .output import output
        value = output
    elif name in ("fs", "StaleWriteError"):
        from importlib import import_module
        module = import_module(".fs", __name__)
        value = module if name == "fs" else module.StaleWriteError
    elif name == "store":
        from .store import store
        value = store
    elif name in ("defs", "kernel_state", "retain_task"):
        from importlib import import_module
        client = import_module("._client", __name__)
        runtime = getattr(client, "_runtime", {})
        if name not in runtime:
            raise AttributeError(name)
        value = runtime[name]
    else:
        raise AttributeError(name)
    globals()[name] = value
    return value
