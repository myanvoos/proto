"""Named explicit warm kernels; ordinary Python invocations remain fresh."""
from ._client import request


def _invocation_env():
    import os
    reserved = {"PI_PYTHON_HARNESS_URL", "PI_PYTHON_HARNESS_TOKEN", "PI_PYTHON_HARNESS_PATH"}
    return {key: value for key, value in os.environ.items()
            if key not in reserved and not key.startswith("PI_KERNEL_")}


class Kernel:
    def __init__(self, name="main", *, interpreter=None, cwd=None, target=None):
        if not isinstance(name, str) or not name:
            raise ValueError("kernel name must be a non-empty string")
        self.name = name
        self.options = {key: value for key, value in
                        (("interpreter", interpreter), ("cwd", cwd), ("target", target))
                        if value is not None}

    def _call(self, op, **args):
        if op in ("run", "exec"):
            args["env"] = _invocation_env()
        return request("kernel." + op, {"name": self.name, **self.options, **args})

    def run(self, code):
        return self._call("run", code=code)

    def exec(self, file):
        return self._call("exec", file=str(file))

    def status(self):
        return self._call("status")

    def stop(self):
        return self._call("stop")

    def restart(self):
        return self._call("restart")


def kernel(name="main", *, interpreter=None, cwd=None, target=None):
    return Kernel(name, interpreter=interpreter, cwd=cwd, target=target)


def main():
    import argparse
    import sys
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("name", nargs="?", default="main")
    parser.add_argument("--interpreter")
    parser.add_argument("--cwd")
    parser.add_argument("-c", "--code")
    parser.add_argument("--file")
    args = parser.parse_args()
    from ._client import request_stream
    handle = kernel(args.name, interpreter=args.interpreter, cwd=args.cwd)
    operation = "exec" if args.file else "run"
    payload = {"file": args.file} if args.file else {"code": args.code if args.code is not None else sys.stdin.read()}
    if (args.code is not None or args.file) and not sys.stdin.isatty():
        import base64
        payload["stdin"] = base64.b64encode(sys.stdin.buffer.read()).decode("ascii")
    result = request_stream("kernel." + operation, {"name": handle.name, **handle.options,
                                                 "env": _invocation_env(), **payload})
    status = 124 if result.get("timedOut") else 130 if result.get("cancelled") else result.get("exitCode")
    raise SystemExit(status if status is not None else 1)


if __name__ == "__main__":
    main()
