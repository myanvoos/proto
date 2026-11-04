"""Atomic host filesystem operations with session-wide stale-read protection."""
from ._client import request


class StaleWriteError(RuntimeError):
    """The path changed since its last harness/tool read; re-read before editing."""


def _call(op, path, **args):
    try:
        return request("fs." + op, {"path": str(path), **args})
    except RuntimeError as error:
        if "StaleWriteError" in str(error):
            raise StaleWriteError(str(error)) from error
        raise


def read_text(path, *, encoding="utf-8"):
    return read_bytes(path).decode(encoding)


def read_bytes(path):
    import base64
    return base64.b64decode(_call("read", path)["data"])


def write_text(path, content, *, encoding="utf-8"):
    return write_bytes(path, content.encode(encoding))


def write_bytes(path, content):
    import base64
    return _call("write", path, data=base64.b64encode(content).decode("ascii"))


def replace(path, old, new, *, count=1, encoding="utf-8"):
    """Replace exactly count literal anchors atomically; reject mismatched counts."""
    return _call("replace", path, old=old, new=new, count=count, encoding=encoding)
