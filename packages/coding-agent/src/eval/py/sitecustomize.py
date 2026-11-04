"""Agent-shell-only detection. Never inject user globals or alter Python execution."""
import os as _os
import sys as _sys


def _chain_sitecustomize():
    import importlib.machinery
    import importlib.util

    own = _os.path.realpath(_os.path.dirname(__file__))
    paths = [entry for entry in _sys.path if _os.path.realpath(entry or _os.getcwd()) != own]
    spec = importlib.machinery.PathFinder.find_spec("sitecustomize", paths)
    if spec is None or spec.loader is None:
        return
    module = importlib.util.module_from_spec(spec)
    _sys.modules["sitecustomize"] = module
    spec.loader.exec_module(module)


def _detect():
    # -E/-I ignore PYTHONPATH; -S bypasses site entirely. No fallback hooks.
    if getattr(getattr(_sys, "implementation", None), "name", None) != "cpython" or _sys.flags.ignore_environment:
        return
    if not _os.environ.get("PI_PYTHON_HARNESS_TOKEN"):
        return
    try:
        from proto_harness._client import detect
        detect({"pid": _os.getpid(), "argv": _sys.argv,
                "cwd": _os.getcwd(), "executable": _sys.executable})
    except Exception:
        # Revoked/stale env cannot change an otherwise ordinary Python program.
        pass


try:
    _detect()
finally:
    _chain_sitecustomize()
