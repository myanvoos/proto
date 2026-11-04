"""Trusted session-local graph codec. Never load graphs from an untrusted peer."""
import base64
import importlib
import io
import os
import sys
import types

FORMAT = "proto.python-graph"
VERSION = 1
MAX_PAYLOAD_CHARS = 64 * 1024 * 1024


def environment():
    return {"implementation": sys.implementation.name,
            "version": list(sys.version_info[:3]), "executable": os.path.abspath(sys.executable),
            "prefix": os.path.realpath(sys.prefix), "cwd": os.getcwd()}


_NAMESPACES = {}


def _new_namespace():
    module = types.ModuleType("__main__")
    _NAMESPACES[id(module.__dict__)] = module
    return module.__dict__


class _Namespace(dict):
    # Memoize the future namespace before serializing functions that refer to it.
    def __reduce_ex__(self, protocol):
        return _new_namespace, (), None, None, iter(self.items())


def dumps(value, *, namespace=None):
    # Plain Python startup never imports cloudpickle or its heavy dependencies.
    from ._vendor import cloudpickle
    import asyncio
    import socket
    import subprocess
    import threading
    resource_types = (io.IOBase, types.GeneratorType, types.CoroutineType,
                      types.AsyncGeneratorType, memoryview, asyncio.Future,
                      asyncio.AbstractEventLoop, asyncio.Lock, asyncio.Event,
                      asyncio.Condition, asyncio.Semaphore, socket.socket,
                      subprocess.Popen, threading.Thread)
    modules = {}
    root = _Namespace(value) if namespace is not None else value

    class GraphPickler(cloudpickle.Pickler):
        def _function_getnewargs(self, func):
            args = super()._function_getnewargs(func)
            if namespace is not None and func.__globals__ is namespace:
                return args[0], root, *args[2:]
            return args

        def reducer_override(self, obj):
            # Cloudpickle otherwise snapshots open text streams as in-memory files.
            # A successful capture must not silently turn a live resource into data.
            if isinstance(obj, resource_types):
                raise TypeError("Python graph contains unsupported live resources: " + type(obj).__name__)
            module = obj if isinstance(obj, types.ModuleType) else None
            if isinstance(obj, (types.FunctionType, type)):
                module = sys.modules.get(getattr(obj, "__module__", ""))
            if module is not None:
                name = module.__name__
                if name != "__main__" and not (name == "proto_harness" or name.startswith("proto_harness.")):
                    modules[name] = {"file": getattr(module, "__file__", None),
                                     "version": str(getattr(module, "__version__", ""))}
            return super().reducer_override(obj)

    output = io.BytesIO()
    try:
        GraphPickler(output, protocol=5).dump(root)
        if output.tell() > MAX_PAYLOAD_CHARS // 4 * 3:
            raise ValueError("Python graph exceeds the 64 MiB encoded payload limit")
    except Exception as exc:
        raise TypeError("Python graph cannot preserve all bindings/resources: " + str(exc)) from exc
    return {"format": FORMAT, "version": VERSION, "metadata": environment(),
            "modules": modules, "payload": base64.b64encode(output.getvalue()).decode("ascii")}


def validate(graph):
    if not isinstance(graph, dict) or graph.get("format") != FORMAT or graph.get("version") != VERSION:
        raise ValueError("Unsupported Python graph format/version")
    declared = graph.get("metadata")
    if not isinstance(declared, dict) or not isinstance(declared.get("executable"), str):
        raise ValueError("Python graph interpreter/environment is incompatible")
    # Capture the launcher for restore (a venv symlink must not become its base
    # interpreter), but compare binary identity together with the exact prefix.
    declared = dict(declared)
    actual = environment()
    declared["executable"] = os.path.realpath(declared["executable"])
    actual["executable"] = os.path.realpath(actual["executable"])
    if declared != actual:
        raise ValueError("Python graph interpreter/environment is incompatible")
    for name, declared in graph.get("modules", {}).items():
        module = importlib.import_module(name)
        actual = {"file": getattr(module, "__file__", None),
                  "version": str(getattr(module, "__version__", ""))}
        if actual != declared:
            raise ValueError("Python graph imported module environment is incompatible: " + name)
    if not isinstance(graph.get("payload"), str) or len(graph["payload"]) > MAX_PAYLOAD_CHARS:
        raise ValueError("Corrupt or oversized Python graph payload")


def loads(graph):
    validate(graph)
    from ._vendor import cloudpickle
    return cloudpickle.loads(base64.b64decode(graph["payload"], validate=True))


def loads_namespace(graph):
    namespace = loads(graph)
    module = _NAMESPACES.pop(id(namespace), None)
    if module is None:
        raise ValueError("Python graph is not a full namespace")
    return module
