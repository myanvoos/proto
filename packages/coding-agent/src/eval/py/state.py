"""Selected, data-only kernel bindings. No pickle, constructors, or replay."""

from __future__ import annotations

import base64
import binascii
import json
import keyword
import math
import os
import sys
import tempfile

FORMAT = "proto.kernel-state"
VERSION = 1
MAX_BYTES = 16 * 1024 * 1024
MAX_NODES = 100_000
MAX_DEPTH = 64
MAX_BINDINGS = 4096


def _interpreter():
    return {"implementation": sys.implementation.name,
            "version": ".".join(str(part) for part in sys.version_info[:3]),
            "executable": sys.executable}


def _name(value, reserved):
    if (type(value) is not str or not value.isidentifier() or keyword.iskeyword(value)
            or value.startswith("__") or value in reserved):
        raise ValueError("state binding name must be a non-reserved identifier")
    return value


def _names(values, reserved):
    if type(values) is not list and type(values) is not tuple:
        raise ValueError("state names must be an explicit list or tuple of identifiers")
    if not 1 <= len(values) <= MAX_BINDINGS:
        raise ValueError("state names must contain 1 to 4096 identifiers")
    result = [_name(value, reserved) for value in values]
    if len(set(result)) != len(result):
        raise ValueError("state names must not contain duplicates")
    return result


class _Budget:
    def __init__(self):
        self.nodes = 0
        self.bytes = 0

    def visit(self, depth, size=0):
        self.nodes += 1
        self.bytes += size
        if depth > MAX_DEPTH or self.nodes > MAX_NODES or self.bytes > MAX_BYTES:
            raise ValueError("state exceeds the depth, item, or 16 MiB size limit")


def _encode(value, active, budget, depth=0):
    # Exact type identity is intentional: subclasses and metaclasses can run code.
    kind = type(value)
    budget.visit(depth)
    if value is None or kind is bool:
        return value
    if kind is str:
        budget.visit(depth, len(value))
        return value
    if kind is int:
        if value.bit_length() > MAX_BYTES * 8:
            raise ValueError("state integer exceeds the size limit")
        return value
    if kind is float:
        if not math.isfinite(value):
            raise ValueError("state numbers must be finite")
        return value
    if kind is bytes or kind is bytearray:
        budget.visit(depth, len(value) * 4 // 3 + 4)
        return {"type": "bytes", "kind": "bytes" if kind is bytes else "bytearray",
                "value": base64.b64encode(value).decode("ascii")}
    if kind is not list and kind is not dict:
        raise ValueError("state supports only plain JSON values and bytes; objects and resources are unsupported")
    identity = id(value)
    if identity in active:
        raise ValueError("state cannot contain cycles")
    active.add(identity)
    try:
        if kind is list:
            return {"type": "array", "value": [_encode(item, active, budget, depth + 1) for item in value]}
        entries = []
        for key, item in value.items():
            if type(key) is not str:
                raise ValueError("state object keys must be plain strings")
            budget.visit(depth + 1, len(key))
            entries.append([key, _encode(item, active, budget, depth + 1)])
        return {"type": "object", "value": entries}
    finally:
        active.remove(identity)


def _fields(value, expected):
    if type(value) is not dict or set(value) != set(expected):
        raise ValueError("invalid state snapshot fields")


def _decode(value, budget, depth=0):
    kind = type(value)
    budget.visit(depth)
    if value is None or kind is bool or kind is int:
        return value
    if kind is str:
        budget.visit(depth, len(value))
        return value
    if kind is float:
        if not math.isfinite(value):
            raise ValueError("state numbers must be finite")
        return value
    if kind is not dict:
        raise ValueError("invalid encoded state value")
    tag = value.get("type")
    if tag == "bytes":
        _fields(value, ("type", "kind", "value"))
        data = value["value"]
        if value["kind"] not in ("bytes", "bytearray") or type(data) is not str:
            raise ValueError("invalid state bytes")
        budget.visit(depth, len(data))
        try:
            decoded = base64.b64decode(data, validate=True)
        except (ValueError, binascii.Error):
            raise ValueError("invalid state bytes encoding") from None
        if base64.b64encode(decoded).decode("ascii") != data:
            raise ValueError("invalid state bytes encoding")
        return decoded if value["kind"] == "bytes" else bytearray(decoded)
    _fields(value, ("type", "value"))
    entries = value["value"]
    if type(entries) is not list:
        raise ValueError("invalid encoded state container")
    if tag == "array":
        return [_decode(item, budget, depth + 1) for item in entries]
    if tag == "object":
        result = {}
        for pair in entries:
            if type(pair) is not list or len(pair) != 2 or type(pair[0]) is not str or pair[0] in result:
                raise ValueError("invalid or duplicate state object key")
            budget.visit(depth + 1, len(pair[0]))
            result[pair[0]] = _decode(pair[1], budget, depth + 1)
        return result
    raise ValueError("unknown encoded state value type")


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate state snapshot field")
        result[key] = value
    return result


def _invalid_constant(_value):
    raise ValueError("state numbers must be finite")


def _validate(snapshot, reserved):
    _fields(snapshot, ("format", "version", "language", "interpreter", "bindings"))
    if snapshot["format"] != FORMAT:
        raise ValueError("invalid state snapshot format")
    if type(snapshot["version"]) is not int or snapshot["version"] != VERSION:
        raise ValueError("unsupported state snapshot version")
    if snapshot["language"] != "python":
        raise ValueError("state snapshot language mismatch: expected python")
    interpreter = snapshot["interpreter"]
    _fields(interpreter, ("implementation", "version", "executable"))
    if any(type(value) is not str or not value for value in interpreter.values()):
        raise ValueError("invalid state interpreter metadata")
    parts = interpreter["version"].split(".")
    if len(parts) != 3 or any(not part.isascii() or not part.isdecimal() for part in parts):
        raise ValueError("invalid state interpreter version")
    # Plain data is portable across executable paths and minor/patch releases.
    current = _interpreter()
    if interpreter["implementation"] != current["implementation"] or parts[0] != current["version"].split(".")[0]:
        raise ValueError("state interpreter implementation or major version mismatch")
    bindings = snapshot["bindings"]
    if type(bindings) is not list or not 1 <= len(bindings) <= MAX_BINDINGS:
        raise ValueError("invalid state bindings")
    budget = _Budget()
    restored = {}
    for binding in bindings:
        _fields(binding, ("name", "value"))
        name = _name(binding["name"], reserved)
        if name in restored:
            raise ValueError("duplicate state binding")
        restored[name] = _decode(binding["value"], budget)
    return restored


def _summary(path, snapshot):
    return {"path": path, "names": [binding["name"] for binding in snapshot["bindings"]],
            "version": VERSION, "language": "python", "interpreter": snapshot["interpreter"]}


def save_state(path, names, namespace, reserved):
    selected = _names(names, reserved)
    budget = _Budget()
    bindings = []
    for name in selected:
        if name not in namespace:
            raise ValueError("selected state binding does not exist: " + name)
        bindings.append({"name": name, "value": _encode(namespace[name], set(), budget)})
    snapshot = {"format": FORMAT, "version": VERSION, "language": "python",
                "interpreter": _interpreter(), "bindings": bindings}
    try:
        encoded = (json.dumps(snapshot, ensure_ascii=True, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")
    except (ValueError, OverflowError):
        raise ValueError("state cannot be represented within JSON limits") from None
    if len(encoded) > MAX_BYTES:
        raise ValueError("state snapshot exceeds the 16 MiB size limit")
    target = os.path.realpath(path)
    directory = os.path.dirname(target)
    fd, temporary = tempfile.mkstemp(prefix=".proto-state-", dir=directory)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
        if hasattr(os, "O_DIRECTORY"):
            directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return _summary(target, snapshot)


def load_state(path, namespace, reserved, *, collision="reject"):
    if type(collision) is not str or collision not in ("reject", "overwrite"):
        raise ValueError('state collision must be "reject" or "overwrite"')
    with open(path, "rb") as stream:
        encoded = stream.read(MAX_BYTES + 1)
    if len(encoded) > MAX_BYTES:
        raise ValueError("state snapshot exceeds the 16 MiB size limit")
    try:
        snapshot = json.loads(encoded, object_pairs_hook=_unique_object, parse_constant=_invalid_constant)
    except (ValueError, UnicodeError, RecursionError):
        raise ValueError("invalid state snapshot JSON") from None
    restored = _validate(snapshot, reserved)
    if collision == "reject":
        for name in restored:
            if name in namespace:
                raise ValueError("state binding collision: " + name)
    # All validation and collision checks precede the sole namespace mutation.
    namespace.update(restored)
    return _summary(os.path.realpath(path), snapshot)
