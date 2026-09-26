"""PROTO Python runner — subprocess wrapper used by the coding-agent host.

NDJSON protocol over stdin/stdout. Host writes one JSON object per line;
wrapper writes typed frames back.

Host -> wrapper:
  {"id": str, "code": str, "silent": bool?, "storeHistory": bool?}
  {"id": str, "code": str, "silent": bool?, "storeHistory": bool?, "cwd": str?, "env": dict?}
  {"type": "stdin", "id": str, "data": base64, "eof": bool}  # one <=64 KiB credit
  {"type": "tool_response", "requestId": str, "reply": dict}  # remote bridge only
  {"type": "cancel", "id": str}                  # cancel active/queued cell
  {"type": "status", "id": str}                  # concurrent liveness probe
  {"type": "exit"}                                # graceful shutdown

Wrapper -> host:
  {"type": "stdin_request", "id": ...}           # pull one program-input chunk
  {"type": "tool_request", "id": ..., "requestId": str, "payload": dict}
  {"type": "started",     "id": ...}
  {"type": "stdout",      "id": ..., "data": str}
  {"type": "stderr",      "id": ..., "data": str}
  {"type": "display",     "id": ..., "bundle": {<mime>: <value>}}
  {"type": "result",      "id": ..., "bundle": {<mime>: <value>}}
  {"type": "error",       "id": ..., "ename": str, "evalue": str, "traceback": [str]}
  {"type": "done",        "id": ..., "status": "ok"|"error",
                              "executionCount": int, "cancelled": bool,
                              "exitCode": int?}          # set when the cell raised SystemExit

Binary stdout/stderr frames use encoding:"base64", data:<base64>, text:<preview>.
Code requests set stdin:true to enable program input, independent of this control pipe.
Input replies bypass the asyncio execution queue so synchronous reads can progress.

The runner is intentionally self-contained: no third-party imports, no IPython.
Magics are translated by a small line-scanner before AST parsing; rich display
falls back through `_repr_*_` methods so pandas/PIL/plotly etc. still render
when installed.
"""

from __future__ import annotations

import ast
import asyncio
import base64
import builtins
import codecs
import contextvars
import importlib
import importlib.machinery
import inspect
import io
import json
import locale
import math
import os
import re
import runpy
import shlex
import select
import signal
import site
import subprocess
import sys
import sysconfig
import threading
import time
import tokenize
import traceback
import types
import weakref
from pathlib import Path
from typing import Any, Callable


# The host embeds this asset when staging a standalone runner (including remote targets).
_PERSISTENCE_SOURCE = None
_persistence = types.ModuleType("_proto_kernel_state")
exec(compile(_PERSISTENCE_SOURCE if _PERSISTENCE_SOURCE is not None
             else Path(__file__).with_name("state.py").read_text(encoding="utf-8"),
             "<kernel-state>", "exec"), _persistence.__dict__)


try:
    _FRAME_FD = os.dup(sys.__stdout__.fileno())
    _RAW_STDOUT = os.fdopen(_FRAME_FD, "w", encoding="utf-8", errors="backslashreplace")
    _RAW_STDERR = os.fdopen(
        os.dup(sys.__stderr__.fileno()), "w", encoding="utf-8", errors="backslashreplace"
    )
    _DEVNULL_FD = os.open(os.devnull, os.O_WRONLY)
    _CAPTURE_SUPPORTED = True
except (AttributeError, OSError, ValueError, io.UnsupportedOperation):
    _RAW_STDOUT = sys.__stdout__
    _RAW_STDERR = sys.__stderr__
    _DEVNULL_FD = None
    _CAPTURE_SUPPORTED = False
_OUT_LOCK = threading.Lock()
_CAPTURE_RID: str | None = None
_CAPTURE_STATE: "_FdCapture | None" = None
_CAPTURE_LOCK = threading.Lock()


def _json_default(o: Any) -> Any:
    try:
        return repr(o)
    except Exception:
        return f"<unrepr {type(o).__name__}>"


def _json_finite(value: Any) -> Any:
    """Replace non-finite floats (NaN/inf) with their repr so the frame stays strict JSON.

    Python's encoder emits bare ``NaN``/``Infinity`` tokens by default; the
    host parses frames with ``JSON.parse`` which rejects them, silently
    dropping the whole frame (a ``display`` of a dict holding one NaN would
    vanish without a trace).
    """
    if isinstance(value, float):
        return value if math.isfinite(value) else repr(value)
    if isinstance(value, dict):
        return {k: _json_finite(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_finite(v) for v in value]
    return value


def _dump_frame(frame: dict) -> str:
    try:
        return json.dumps(frame, ensure_ascii=False, allow_nan=False, default=_json_default)
    except ValueError:
        return json.dumps(_json_finite(frame), ensure_ascii=False, allow_nan=False, default=_json_default)


def _emit(frame: dict) -> None:
    """Serialize a frame and write it to the host as a single NDJSON line."""
    line = _dump_frame(frame) + "\n"
    with _OUT_LOCK:
        _RAW_STDOUT.write(line)
        _RAW_STDOUT.flush()


def _emit_kernel_note(note: str) -> None:
    """Send one model-visible note through the current cell's stderr stream."""
    rid = _CURRENT_RID.get()
    if rid is None:
        return
    _emit({"type": "stderr", "id": rid, "data": f"<kernel> note: {note}\n"})


class _StreamProxy(io.TextIOBase):
    """Emit cell ``write`` data as typed frames tied to the current request.

    Writes are coalesced per request: a frame is emitted once the buffer holds
    a complete line (everything up to the last newline goes out together) or
    grows past ``_MAX_BUFFER`` bytes, so the common ``print()`` pair of
    ``write(text)`` + ``write("\\n")`` costs one frame instead of two. Partial
    lines are bounded by ``flush()`` and the end-of-request flush.
    """

    _MAX_BUFFER = 8192
    _MAX_RID_BUFFERS = 64

    def __init__(self, kind: str) -> None:
        super().__init__()
        self._kind = kind
        self._fd = 1 if kind == "stdout" else 2
        self._lock = threading.Lock()
        self._buffers: dict[str, str] = {}
        self._buffer_proxy: "_BinaryStreamProxy | None" = None

    def writable(self) -> bool:
        return True

    def isatty(self) -> bool:
        return False

    @property
    def encoding(self) -> str:
        return "utf-8"

    @property
    def errors(self) -> str:
        return "backslashreplace"

    @property
    def line_buffering(self) -> bool:
        return True

    @property
    def buffer(self) -> "_BinaryStreamProxy":
        """The binary layer, as on a real ``sys.stdout``.

        Code that writes bytes (``sys.stdout.buffer.write``, ``shutil``,
        anything handing a stream to a C extension) must not crash with an
        ``AttributeError`` just because output is being captured.
        """
        proxy = self._buffer_proxy
        if proxy is None:
            proxy = _BinaryStreamProxy(self)
            self._buffer_proxy = proxy
        return proxy

    def fileno(self) -> int:
        """The captured fd for the running request, as a real stream would.

        While this request owns fd 1/2 its capture pipe *is* this stream, so
        handing the number to ``subprocess``/``os.write`` keeps that output in
        this cell. Without capture the number would be the runner's own frame
        channel, so the unsupported-operation error stands.
        """
        rid = _CURRENT_RID.get()
        if rid is not None and self._routed_fd(rid) is not None:
            return self._fd
        raise io.UnsupportedOperation("fileno")

    def _routed_fd(self, rid: str) -> int | None:
        """This stream's captured fd for ``rid``, or ``None`` without capture."""
        if not _CAPTURE_SUPPORTED or rid != _CAPTURE_RID:
            return None
        return self._fd

    def _deliver(self, rid: str, text: str) -> None:
        """Emit ``text`` as a typed frame, behind any output already captured."""
        if not text:
            return
        _drain_capture_before_frame(rid)
        for offset in range(0, len(text), 16384):
            _emit({"type": self._kind, "id": rid, "data": text[offset:offset + 16384]})

    def _deliver_bytes(self, rid: str, data: bytes) -> None:
        """Emit raw bytes, ordered behind buffered text and captured output.

        Bytes remain separate from the human preview throughout the protocol.
        """
        if not data:
            return
        self.flush_rid(rid)
        _drain_capture_before_frame(rid)
        for offset in range(0, len(data), 65536):
            chunk = data[offset:offset + 65536]
            _emit({"type": self._kind, "id": rid, "encoding": "base64",
                   "data": base64.b64encode(chunk).decode("ascii"),
                   "text": chunk.decode("utf-8", "backslashreplace")})

    def write(self, data: Any) -> int:
        if not isinstance(data, str):
            data = str(data)
        if not data:
            return 0
        rid = _CURRENT_RID.get()
        if rid is None:
            _RAW_STDERR.write(data)
            _RAW_STDERR.flush()
            return len(data)
        emit_text = None
        evicted: tuple[str, str] | None = None
        with self._lock:
            buf = self._buffers.pop(rid, "") + data
            rest = ""
            if len(buf) >= self._MAX_BUFFER:
                emit_text = buf
            else:
                nl = buf.rfind("\n")
                if nl >= 0:
                    emit_text = buf[: nl + 1]
                    rest = buf[nl + 1 :]
                else:
                    rest = buf
            if rest:
                if len(self._buffers) >= self._MAX_RID_BUFFERS:
                    oldest_rid = next(iter(self._buffers))
                    evicted = (oldest_rid, self._buffers.pop(oldest_rid))
                self._buffers[rid] = rest
        if evicted is not None:
            evicted_rid, evicted_text = evicted
            self._deliver(evicted_rid, evicted_text)
        if emit_text:
            self._deliver(rid, emit_text)
        return len(data)

    def flush(self) -> None:
        rid = _CURRENT_RID.get()
        if rid is not None:
            self.flush_rid(rid)
        return None

    def flush_rid(self, rid: str) -> None:
        """Flush any buffered partial line for ``rid``."""
        with self._lock:
            buf = self._buffers.pop(rid, None)
        if buf:
            self._deliver(rid, buf)


class _BinaryStreamProxy(io.RawIOBase):
    """The ``.buffer`` of a captured text stream.

    Bytes travel losslessly as bounded base64 frames, with a separate text preview.
    """

    def __init__(self, text: "_StreamProxy") -> None:
        super().__init__()
        self._text = text

    def writable(self) -> bool:
        return True

    def readable(self) -> bool:
        return False

    def seekable(self) -> bool:
        return False

    def isatty(self) -> bool:
        return False

    def fileno(self) -> int:
        return self._text.fileno()

    @property
    def raw(self) -> "_BinaryStreamProxy":
        return self

    @property
    def name(self) -> str:
        return f"<{self._text._kind}>"

    def write(self, data: Any) -> int:
        if isinstance(data, memoryview):
            payload = data.tobytes()
        elif isinstance(data, (bytes, bytearray)):
            payload = bytes(data)
        else:
            raise TypeError(f"a bytes-like object is required, not '{type(data).__name__}'")
        if not payload:
            return 0
        rid = _CURRENT_RID.get()
        if rid is None:
            _RAW_STDERR.write(payload.decode("utf-8", "backslashreplace"))
            _RAW_STDERR.flush()
            return len(payload)
        self._text._deliver_bytes(rid, payload)
        return len(payload)

    def writelines(self, lines: Any) -> None:
        for line in lines:
            self.write(line)

    def flush(self) -> None:
        self._text.flush()


def _flush_stream_proxies(rid: str) -> None:
    """Drain buffered proxy output for ``rid`` (called before its done frame)."""
    for stream in (sys.stdout, sys.stderr):
        if isinstance(stream, _StreamProxy):
            stream.flush_rid(rid)



class _ProgramInput(io.RawIOBase):
    """Blocking Python I/O backed by one 64 KiB protocol credit at a time."""

    def __init__(self, rid: str, enabled: bool) -> None:
        super().__init__()
        self.rid = rid
        self._condition = threading.Condition()
        self._data = b""
        self._eof = not enabled
        self._requested = False
        self._error: str | None = None

    def readable(self) -> bool:
        return True

    def readinto(self, buffer) -> int:
        with self._condition:
            while not self._data and not self._eof:
                if not self._requested:
                    self._requested = True
                    _emit({"type": "stdin_request", "id": self.rid})
                self._condition.wait()
            if self._error:
                raise OSError(self._error)
            size = min(len(buffer), len(self._data))
            buffer[:size] = self._data[:size]
            self._data = self._data[size:]
            return size

    def feed(self, frame: dict) -> None:
        with self._condition:
            try:
                encoded = frame.get("data", "")
                if not self._requested or not isinstance(encoded, str) or len(encoded) > 87384:
                    raise ValueError("Invalid stdin credit")
                data = base64.b64decode(encoded, validate=True)
                if len(data) > 65536 or self._data or (not data and not frame.get("eof")):
                    raise ValueError("Invalid stdin chunk")
                self._data = data
                self._eof = bool(frame.get("eof"))
                self._requested = False
            except (ValueError, TypeError) as error:
                self._error = str(error)
                self._eof = True
            self._condition.notify_all()

    def close(self) -> None:
        with self._condition:
            self._eof = True
            self._data = b""
            self._condition.notify_all()
        super().close()


_PROGRAM_INPUTS: dict[str, _ProgramInput] = {}
_BRIDGE_REPLIES: dict[str, tuple[threading.Event, list[dict]]] = {}
_BRIDGE_LOCK = threading.Lock()


def __proto_bridge_call__(name: str, args: dict, completion_invocation_id=None):
    rid = _CURRENT_RID.get()
    if rid is None:
        raise RuntimeError("Tool bridge called outside an active cell")
    request_id = os.urandom(16).hex()
    event = threading.Event()
    replies: list[dict] = []
    with _BRIDGE_LOCK:
        if len(_BRIDGE_REPLIES) >= 256:
            raise RuntimeError("Too many outstanding tool bridge requests")
        _BRIDGE_REPLIES[request_id] = (event, replies)
    try:
        _emit({"type": "tool_request", "id": rid, "requestId": request_id,
               "payload": {"name": name, "args": args, "completionInvocationId": completion_invocation_id}})
        while not event.wait(0.1):
            check = _prelude_fn("task_signal")
            if check is not None:
                check().check()
        reply = replies[0]
        if not reply.get("ok"):
            error = reply.get("error") or {}
            raise RuntimeError(error.get("message", "Tool bridge request failed"))
        return reply.get("value")
    finally:
        with _BRIDGE_LOCK:
            _BRIDGE_REPLIES.pop(request_id, None)


class _RunnerState:
    def __init__(self) -> None:
        self.execution_count: int = 0
        self.cancel_requested: bool = False
        self.user_ns: dict[str, Any] = {
            "__name__": "__main__",
            "__doc__": None,
            "__builtins__": builtins,
        }
        self.last_install_marker: int = 0
        self.loop: asyncio.AbstractEventLoop | None = None
        self.shutting_down: bool = False
        self.active_executions: int = 0
        self.defs: dict[str, int] = {}
        self.prelude_names: set[str] | None = None
        self.prelude_ns: dict[str, Any] | None = None
        self.prelude_exports: dict[str, Any] = {}
        self.shadow_warned: set[str] = set()
        self.request_tasks: set[asyncio.Task] = set()
        self.pending_request_ids: set[str] = set()
        self.cancelled_request_ids: set[str] = set()
        self.active_request_id: str | None = None
        # Set when something may have rewritten project source mid-cell; the
        # next import re-checks loaded project modules.
        self.sources_dirty: bool = False
        # The sys.path entries the current cell's cwd and PYTHONPATH put first.
        self.import_path_prefix: list[str] = []
        # Names the executing cell binds itself; not reported as stale.
        self.cell_bindings: frozenset[str] = frozenset()


_REQUEST_QUEUE_MAX_COUNT = 128
_REQUEST_QUEUE_MAX_BYTES = 16 * 1024 * 1024


class _BoundedRequestQueue:
    """Async request queue bounded by both entry count and serialized bytes."""

    def __init__(self) -> None:
        self._queue: asyncio.Queue[tuple[dict, int]] = asyncio.Queue(
            maxsize=_REQUEST_QUEUE_MAX_COUNT
        )
        self._bytes = 0
        self._reserved_count = 0
        self._reserved_bytes = 0
        self._condition = threading.Condition()

    def reserve(self, size: int) -> bool:
        """Reserve bounded capacity before scheduling a callback from stdin."""
        if size > _REQUEST_QUEUE_MAX_BYTES:
            return False
        with self._condition:
            while (
                self._reserved_count >= _REQUEST_QUEUE_MAX_COUNT
                or self._reserved_bytes + size > _REQUEST_QUEUE_MAX_BYTES
            ):
                self._condition.wait()
            self._reserved_count += 1
            self._reserved_bytes += size
        return True

    def put_reserved(self, request: dict, size: int) -> None:
        self._queue.put_nowait((request, size))
        self._bytes += size

    def put_nowait(self, request: dict, size: int) -> bool:
        if size > _REQUEST_QUEUE_MAX_BYTES:
            return False
        with self._condition:
            if (
                self._reserved_count >= _REQUEST_QUEUE_MAX_COUNT
                or self._reserved_bytes + size > _REQUEST_QUEUE_MAX_BYTES
            ):
                return False
            self._reserved_count += 1
            self._reserved_bytes += size
        self.put_reserved(request, size)
        return True

    async def get(self) -> tuple[dict, int]:
        request, size = await self._queue.get()
        self._bytes -= size
        with self._condition:
            self._reserved_count -= 1
            self._reserved_bytes -= size
            self._condition.notify()
        return request, size

    def qsize(self) -> int:
        return self._queue.qsize()

    def task_done(self) -> None:
        self._queue.task_done()


_CURRENT_RID: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "proto_current_rid", default=None
)
_CURRENT_COMPLETION_COUNT: contextvars.ContextVar[list[int] | None] = contextvars.ContextVar(
    "proto_completion_count", default=None
)
_CURRENT_DISPLAYED_MATPLOTLIB_FIGURE_IDS: contextvars.ContextVar[set[int] | None] = (
    contextvars.ContextVar(
        "proto_displayed_matplotlib_figure_ids",
        default=None,
    )
)

_SAVED_MATPLOTLIB_FIGURES: contextvars.ContextVar[list["weakref.Reference"] | None] = (
    contextvars.ContextVar(
        "proto_saved_matplotlib_figures",
        default=None,
    )
)

# Strong refs: pyplot drops a figure on close, and ``plt.close(plt.gcf())``
# leaves no user reference, so a weakref would lose it before cell end.
_CLOSED_MATPLOTLIB_FIGURES: contextvars.ContextVar[list[Any] | None] = contextvars.ContextVar(
    "proto_closed_matplotlib_figures",
    default=None,
)
# One past the host's 8-image display cap, so a cell closing more figures still
# surfaces the host's truncation notice without retaining every figure.
_MAX_CLOSED_MATPLOTLIB_FIGURES = 9


_STATE = _RunnerState()


class _FdCapture:
    """Per-request fd capture inherited by child processes from that request."""

    def __init__(self) -> None:
        self.marker = b"\x00proto-sync:" + os.urandom(24) + b"\x00"
        self.stdout_synced = threading.Event()
        self.stderr_synced = threading.Event()
        self.stdout_closed = threading.Event()
        self.stderr_closed = threading.Event()
        self.read_fds: dict[str, int] = {}
        self.child_started = False

    def pending_streams(self) -> list[int]:
        """Capture fds holding child output that has not been emitted yet."""
        live = [
            fd
            for kind, fd in self.read_fds.items()
            if not (self.stdout_closed if kind == "stdout" else self.stderr_closed).is_set()
        ]
        if not live:
            return []
        try:
            readable, _, _ = select.select(live, [], [], 0)
        except (OSError, ValueError):
            return []
        return list(readable)


def _emit_captured_bytes(
    rid: str, kind: str, decoder: codecs.IncrementalDecoder, data: bytes, *, final: bool = False
) -> None:
    text = decoder.decode(data, final=final)
    if data or text:
        _emit({"type": kind, "id": rid, "encoding": "base64",
               "data": base64.b64encode(data).decode("ascii"), "text": text})


def _drain_capture_fd(
    read_fd: int,
    rid: str,
    kind: str,
    marker: bytes,
    synced: threading.Event,
    closed: threading.Event,
) -> None:
    decoder = codecs.getincrementaldecoder("utf-8")("backslashreplace")
    pending = b""
    try:
        while True:
            try:
                chunk = os.read(read_fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            pending += chunk
            while True:
                marker_at = pending.find(marker)
                if marker_at >= 0:
                    _emit_captured_bytes(rid, kind, decoder, pending[:marker_at])
                    pending = pending[marker_at + len(marker) :]
                    synced.set()
                    continue
                safe_length = len(pending) - len(marker) + 1
                if safe_length > 0:
                    _emit_captured_bytes(rid, kind, decoder, pending[:safe_length])
                    pending = pending[safe_length:]
                break
        _emit_captured_bytes(rid, kind, decoder, pending, final=True)
    finally:
        closed.set()
        synced.set()
        try:
            os.close(read_fd)
        except OSError:
            pass


def _begin_fd_capture(rid: str) -> _FdCapture | None:
    if not _CAPTURE_SUPPORTED:
        return None
    capture = _FdCapture()
    streams = (
        (1, "stdout", capture.stdout_synced, capture.stdout_closed),
        (2, "stderr", capture.stderr_synced, capture.stderr_closed),
    )
    for target_fd, kind, synced, closed in streams:
        read_fd, write_fd = os.pipe()
        os.dup2(write_fd, target_fd)
        os.close(write_fd)
        capture.read_fds[kind] = read_fd
        threading.Thread(
            target=_drain_capture_fd,
            args=(read_fd, rid, kind, capture.marker, synced, closed),
            name=f"proto-{kind}-capture-{rid}",
            daemon=True,
        ).start()
    global _CAPTURE_RID, _CAPTURE_STATE
    with _CAPTURE_LOCK:
        _CAPTURE_RID = rid
        _CAPTURE_STATE = capture
    return capture


def _sync_fd_capture(capture: _FdCapture | None) -> None:
    """Block until everything already written to the capture fds has been emitted."""
    if capture is None:
        return
    streams = (
        (1, capture.stdout_synced, capture.stdout_closed),
        (2, capture.stderr_synced, capture.stderr_closed),
    )
    for target_fd, synced, closed in streams:
        if closed.is_set():
            continue
        synced.clear()
        try:
            os.write(target_fd, capture.marker)
        except OSError:
            synced.set()
    for _target_fd, synced, closed in streams:
        if closed.is_set():
            continue
        synced.wait(timeout=1.0)


_CHILD_SPAWN_AUDIT_EVENTS = frozenset(
    {
        "subprocess.Popen",
        "os.system",
        "os.exec",
        "os.posix_spawn",
        "os.spawn",
        "os.fork",
        "os.forkpty",
        "pty.spawn",
    }
)


_OPEN_WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC
_MODULE_FILE_SUFFIXES = tuple(
    importlib.machinery.SOURCE_SUFFIXES + importlib.machinery.EXTENSION_SUFFIXES
)


def _is_module_file(path: Any) -> bool:
    if isinstance(path, int):
        return False
    try:
        return os.fsdecode(path).endswith(_MODULE_FILE_SUFFIXES)
    except TypeError:
        return False


def _audit_runner_event(event: str, args: tuple) -> None:
    if event in _CHILD_SPAWN_AUDIT_EVENTS:
        # A child can rewrite project source before the cell's next import.
        _STATE.sources_dirty = True
        capture = _CAPTURE_STATE
        if capture is not None:
            capture.child_started = True
    elif event == "open":
        if (
            len(args) > 2
            and isinstance(args[2], int)
            and args[2] & _OPEN_WRITE_FLAGS
            and _is_module_file(args[0])
        ):
            _STATE.sources_dirty = True
    elif event in ("os.rename", "os.remove", "os.truncate"):  # os.replace audits as os.rename
        if any(_is_module_file(arg) for arg in args[:2]):
            _STATE.sources_dirty = True


def _install_runner_audit() -> None:
    try:
        sys.addaudithook(_audit_runner_event)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Import freshness
#
# A cell stands in for a fresh `python` process, so an import must see project
# source as it is on disk now, not as an earlier cell loaded it. Project
# modules are those loaded from outside the interpreter's stdlib and
# site-packages: the code being edited. Library modules are never evicted;
# C extensions and global registries rarely survive re-execution.
# ---------------------------------------------------------------------------


def _library_roots() -> tuple[str, ...]:
    roots: set[str] = set()
    for key in ("stdlib", "platstdlib", "purelib", "platlib"):
        try:
            roots.add(sysconfig.get_path(key))
        except KeyError:
            pass
    try:
        roots.update(site.getsitepackages())
        roots.add(site.getusersitepackages())
    except AttributeError:  # site.py of an old virtualenv
        pass
    # Raw and resolved forms: origins arrive unresolved; resolving each one is not free.
    forms = {form for root in roots if root for form in (root, os.path.realpath(root))}
    return tuple(os.path.join(form, "") for form in forms)


_LIBRARY_ROOTS = _library_roots()
_LIBRARY_DIR_NAMES = frozenset({"site-packages", "dist-packages"})


def _is_project_file(path: str) -> bool:
    return not path.startswith(_LIBRARY_ROOTS) and _LIBRARY_DIR_NAMES.isdisjoint(path.split(os.sep))


class _ProjectModule:
    """A loaded project module: its file's stamp at load time, and whether a
    plain ``import name`` found it on ``sys.path`` (so a cwd or PYTHONPATH
    change can make the same name resolve to a different file)."""

    __slots__ = ("module", "path", "stamp", "native", "by_name")

    def __init__(
        self,
        module: types.ModuleType,
        path: str,
        stamp: tuple[int, int],
        native: bool,
        by_name: bool,
    ) -> None:
        self.module = weakref.ref(module)
        self.path = path
        self.stamp: tuple[int, int] | None = stamp
        self.native = native
        self.by_name = by_name


_PROJECT_MODULES: dict[str, _ProjectModule] = {}
_PROJECT_MODULES_LOCK = threading.RLock()
_EVICTED_MODULES: "weakref.WeakSet[types.ModuleType]" = weakref.WeakSet()


def _file_stamp(path: str) -> tuple[int, int] | None:
    try:
        st = os.stat(path)
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size)


def _track_module_load(module: types.ModuleType, native: bool) -> None:
    spec = getattr(module, "__spec__", None)
    origin = getattr(spec, "origin", None)
    if not isinstance(origin, str) or not getattr(spec, "has_location", False):
        return
    if not _is_project_file(origin):
        return
    path = os.path.realpath(origin)
    stamp = _file_stamp(path)
    if stamp is None or not _is_project_file(path):
        return
    by_name = False
    if "." not in spec.name:
        home = os.path.dirname(path)
        if spec.submodule_search_locations is not None:
            home = os.path.dirname(home)
        by_name = any(
            isinstance(entry, str) and os.path.realpath(entry or os.curdir) == home
            for entry in sys.path
        )
    with _PROJECT_MODULES_LOCK:
        _PROJECT_MODULES[spec.name] = _ProjectModule(module, path, stamp, native, by_name)


def _install_module_load_tracking() -> None:
    """Stamp every module as its loader executes it: the stamp must describe
    the source that was loaded, not the file as a later check finds it."""
    for loader_class, native in (
        (importlib.machinery.SourceFileLoader, False),
        (importlib.machinery.ExtensionFileLoader, True),
    ):
        load = loader_class.exec_module

        def exec_module(self, module, _load=load, _native=native):
            try:
                _track_module_load(module, _native)
            except Exception:
                pass
            return _load(self, module)

        loader_class.exec_module = exec_module


def _project_module_changed(name: str, entry: _ProjectModule) -> bool:
    if _file_stamp(entry.path) != entry.stamp:
        return True
    if not entry.by_name:
        return False
    spec = importlib.machinery.PathFinder.find_spec(name)
    origin = getattr(spec, "origin", None)
    return not isinstance(origin, str) or os.path.realpath(origin) != entry.path


def _name_list(names: list[str]) -> str:
    names = sorted(names)
    shown = ", ".join(names[:4])
    return f"{shown} +{len(names) - 4} more" if len(names) > 4 else shown


def _stale_bindings(evicted: set[str]) -> list[str]:
    """Kernel names bound by earlier cells that still hold evicted code."""
    stale = []
    for name, value in list(_STATE.user_ns.items()):
        if name.startswith("__") or name in _STATE.cell_bindings:
            continue
        try:
            if isinstance(value, types.ModuleType):
                owner = value.__name__
            else:
                owner = getattr(value, "__module__", None)
                if not isinstance(owner, str):
                    owner = type(value).__module__
        except Exception:
            continue
        if owner in evicted:
            stale.append(name)
    return stale


def _refresh_project_modules() -> None:
    """Evict project modules whose source changed, or whose name now resolves
    to another file, since they were loaded; the next import re-reads them as
    a fresh interpreter would."""
    _STATE.sources_dirty = False
    changed: list[str] = []
    rebuilt: list[str] = []
    evicted: set[str] = set()
    with _PROJECT_MODULES_LOCK:
        for name, entry in list(_PROJECT_MODULES.items()):
            module = entry.module()
            if module is None or sys.modules.get(name) is not module:
                del _PROJECT_MODULES[name]
                continue
            try:
                if not _project_module_changed(name, entry):
                    continue
            except Exception:
                continue
            if entry.native:
                # CPython cannot re-initialize an extension in place; report each build once.
                rebuilt.append(name)
                entry.stamp = _file_stamp(entry.path)
                entry.by_name = False
            else:
                changed.append(name)
        if changed:
            # Unchanged modules can hold objects from changed ones (`from m import f`)
            # and nothing records who imported whom, so every project module goes.
            for name, entry in list(_PROJECT_MODULES.items()):
                if entry.native:
                    continue
                module = entry.module()
                if module is not None and sys.modules.get(name) is module:
                    del sys.modules[name]
                    _EVICTED_MODULES.add(module)
                    evicted.add(name)
                del _PROJECT_MODULES[name]
            importlib.invalidate_caches()
    if changed:
        stale = _stale_bindings(evicted)
        if stale:
            _emit_kernel_note(
                f"{_name_list(changed)} changed on disk; imports load the new source, but "
                f"names from earlier cells still hold the old code: {_name_list(stale)}"
            )
    if rebuilt:
        _emit_kernel_note(
            f"native module {_name_list(rebuilt)} changed on disk; CPython cannot reload an "
            "extension in place, so this kernel keeps the old build until it is reset"
        )


def _mark_sources_dirty() -> None:
    _STATE.sources_dirty = True


_BUILTIN_IMPORT = builtins.__import__
_IMPORTLIB_RELOAD = importlib.reload


def _import_with_fresh_sources(name, globals=None, locals=None, fromlist=(), level=0):
    if _STATE.sources_dirty:
        _refresh_project_modules()
    return _BUILTIN_IMPORT(name, globals, locals, fromlist, level)


def _reload_in_place(module):
    """``importlib.reload`` of a module the kernel evicted re-executes it in
    place, exactly as if the kernel had kept it in ``sys.modules``."""
    if module in _EVICTED_MODULES:
        spec = getattr(module, "__spec__", None)
        name = getattr(spec, "name", None) or getattr(module, "__name__", None)
        if isinstance(name, str) and sys.modules.get(name) is not module:
            sys.modules[name] = module
    return _IMPORTLIB_RELOAD(module)


def _set_import_path_prefix(cwd: str) -> None:
    """Start ``sys.path`` the way a fresh ``python -c`` here would: the
    working directory, then PYTHONPATH. The previous cell's entries are
    replaced, not accumulated, so modules from an old cwd stop resolving."""
    pythonpath = os.environ.get("PYTHONPATH", "")
    extra = [os.path.abspath(entry) for entry in pythonpath.split(os.pathsep) if entry]
    entries = list(dict.fromkeys([cwd, *extra]))
    for entry in (*_STATE.import_path_prefix, *entries):
        try:
            sys.path.remove(entry)
        except ValueError:
            pass
    sys.path[0:0] = entries
    _STATE.import_path_prefix = entries


def _install_import_freshness() -> None:
    _install_module_load_tracking()
    builtins.__import__ = _import_with_fresh_sources
    importlib.reload = _reload_in_place
    # `python runner.py` put the runner's own directory first; the first cell's cwd replaces it.
    runner_dir = os.path.dirname(os.path.realpath(__file__))
    if sys.path and os.path.realpath(sys.path[0] or os.curdir) == runner_dir:
        _STATE.import_path_prefix = [sys.path[0]]


def _drain_capture_before_frame(rid: str | None) -> None:
    """Let output a child already wrote reach the host before the next frame.

    The drain threads only run when the executing cell gives up the GIL, so a
    line a subprocess printed can sit unread in the pipe while the cell keeps
    printing — the host then shows it after output that came later. Checking
    the pipe costs one non-blocking ``select``; only when it actually holds
    bytes (or a child has just been spawned) is the blocking marker sync worth
    paying for.
    """
    if rid is None or rid != _CAPTURE_RID:
        return
    capture = _CAPTURE_STATE
    if capture is None:
        return
    if not capture.child_started and not capture.pending_streams():
        return
    _sync_fd_capture(capture)
    capture.child_started = False


def _sync_before_frame(rid: str | None) -> None:
    """Order a non-text frame (``display``, an error) behind cell output."""
    if rid is None or rid != _CAPTURE_RID:
        return
    _flush_stream_proxies(rid)
    _drain_capture_before_frame(rid)


def _end_fd_capture() -> None:
    global _CAPTURE_RID, _CAPTURE_STATE
    with _CAPTURE_LOCK:
        _CAPTURE_RID = None
        _CAPTURE_STATE = None
        if _DEVNULL_FD is None:
            return
        try:
            os.dup2(_DEVNULL_FD, 1)
            os.dup2(_DEVNULL_FD, 2)
        except OSError:
            pass


_HEREDOC_OPEN_RE = re.compile(
    r"(?P<indent>[ \t]*)(?P<name>[A-Za-z_][A-Za-z_0-9]*)[ \t]*"
    r"=[ \t]*<<[ \t]*(?P<delimiter>[A-Za-z_][A-Za-z_0-9]*)[ \t]*\r?$"
)


class _HeredocBlock:
    """A source-range heredoc assignment found by the literal-aware scanner."""

    __slots__ = ("start", "end", "indent", "name", "delimiter")

    def __init__(
        self,
        start: int,
        end: int,
        indent: str,
        name: str,
        delimiter: str,
    ) -> None:
        self.start = start
        self.end = end
        self.indent = indent
        self.name = name
        self.delimiter = delimiter


_CURLY_DOUBLE_RE = re.compile("[\u201c\u201d]")
_CURLY_SINGLE_RE = re.compile("[\u2018\u2019]")
_NBSP_RE = re.compile("\u00a0")
_ZERO_WIDTH_RE = re.compile("[\u200b\u200c\u200d\ufeff]")

_FENCE_LINE_RE = re.compile(r"```[A-Za-z0-9_+\-.#]*\s*")

_INVALID_CHAR_HINTS = {
    "\u201c": "curly double quote",
    "\u201d": "curly double quote",
    "\u2018": "curly single quote / apostrophe",
    "\u2019": "curly single quote / apostrophe",
    "\u2014": "em dash",
    "\u2013": "en dash",
    "\u00a0": "non-breaking space",
    "\u2026": "ellipsis",
}


class PreparedCell:
    """Pre-processed cell ready for compilation.

    ``source`` is what will execute. ``notes`` disclose behavior the model
    did not explicitly request (heredoc bindings, accepted repairs); ``hints``
    carry diagnostics for a cell that will fail to compile regardless.
    """

    __slots__ = ("source", "notes", "hints")

    def __init__(self, source: str, notes: list[str], hints: list[str]) -> None:
        self.source = source
        self.notes = notes
        self.hints = hints


def _compiles(source: str) -> bool:
    try:
        compile(source, "<cell>", "exec", flags=ast.PyCF_ONLY_AST | _TLA_FLAG)
    except (SyntaxError, ValueError):
        return False
    return True


def _heredoc_indent(line: str) -> str:
    """Return the exact heredoc indentation prefix (spaces/tabs only)."""
    return line[: len(line) - len(line.lstrip(" \t"))]


def _raw_string_body_lines(source: str) -> set[int]:
    """1-based physical lines that begin inside Python multiline strings."""
    protected: set[int] = set()
    fstring_start = getattr(tokenize, "FSTRING_START", None)
    fstring_end = getattr(tokenize, "FSTRING_END", None)
    depth = 0
    outer_start = 0
    try:
        for tok in tokenize.generate_tokens(io.StringIO(source).readline):
            if tok.type == tokenize.STRING:
                if tok.end[0] > tok.start[0]:
                    protected.update(range(tok.start[0] + 1, tok.end[0] + 1))
            elif fstring_start is not None and tok.type == fstring_start:
                if depth == 0:
                    outer_start = tok.start[0]
                depth += 1
            elif fstring_end is not None and tok.type == fstring_end:
                depth = max(0, depth - 1)
                if depth == 0 and tok.end[0] > outer_start:
                    protected.update(range(outer_start + 1, tok.end[0] + 1))
    except (tokenize.TokenError, SyntaxError, ValueError):
        pass
    return protected


def _nested_python_lines(source: str) -> set[int]:
    """Physical lines whose first tokens are inside (), [], or {}."""
    nested: set[int] = set()
    depth = 0
    ignored = {
        tokenize.ENCODING,
        tokenize.INDENT,
        tokenize.DEDENT,
        tokenize.NEWLINE,
        tokenize.NL,
    }
    try:
        for tok in tokenize.generate_tokens(io.StringIO(source).readline):
            if depth > 0 and tok.type not in ignored:
                nested.add(tok.start[0])
            if tok.type != tokenize.OP:
                continue
            if tok.string in "([{":
                depth += 1
            elif tok.string in ")]}":
                depth = max(0, depth - 1)
    except (tokenize.TokenError, SyntaxError, ValueError):
        pass
    return nested


def _masked_verbatim_source(source: str, ranges: list[tuple[int, int]]) -> str:
    """Blank payload characters while preserving every physical newline."""
    if not ranges:
        return source
    lines = source.split("\n")
    for start, end in ranges:
        for index in range(start, min(end, len(lines))):
            lines[index] = "".join("\r" if char == "\r" else " " for char in lines[index])
    return "\n".join(lines)


def _inside_verbatim(index: int, ranges: list[tuple[int, int]]) -> bool:
    return any(start <= index < end for start, end in ranges)


def _heredoc_line_text(line: str) -> str:
    """Drop the CR belonging to a CRLF physical line."""
    return line[:-1] if line.endswith("\r") else line


def _find_heredoc_end(
    lines: list[str], start: int, indent: str, delimiter: str
) -> int | None:
    terminator = re.compile(re.escape(delimiter) + r"[ \t]*\r?$")
    for index in range(start + 1, len(lines)):
        line = lines[index]
        if _heredoc_indent(line) != indent:
            continue
        if terminator.fullmatch(line[len(indent) :]) is not None:
            return index
    return None


def _collect_heredoc_blocks(source: str) -> tuple[list[_HeredocBlock], set[int]]:
    """Find heredocs incrementally, re-tokenizing after every masked payload.

    A hostile unmatched quote in one payload can stop Python tokenization before
    a later real string. Discovering only the first eligible heredoc per pass
    ensures its body is masked before any later header-looking line is judged.
    """
    lines = source.split("\n")
    ranges: list[tuple[int, int]] = []
    blocks: list[_HeredocBlock] = []
    starts: set[int] = set()
    protected: set[int] = set()

    for _ in range(max(1, len(lines) + 1)):
        masked = _masked_verbatim_source(source, ranges)
        protected = _raw_string_body_lines(masked)
        nested = _nested_python_lines(masked)
        discovered = False
        for index, line in enumerate(lines):
            if (
                index in starts
                or index + 1 in protected
                or index + 1 in nested
                or _inside_verbatim(index, ranges)
            ):
                continue
            match = _HEREDOC_OPEN_RE.fullmatch(line)
            if match is None:
                continue
            indent = match.group("indent")
            delimiter = match.group("delimiter")
            end = _find_heredoc_end(lines, index, indent, delimiter)
            if end is None:
                return blocks, protected
            block = _HeredocBlock(
                index,
                end,
                indent,
                match.group("name"),
                delimiter,
            )
            starts.add(index)
            blocks.append(block)
            ranges.append((index + 1, end))
            discovered = True
            break
        if not discovered:
            break

    blocks.sort(key=lambda block: block.start)
    return blocks, protected


def _extract_heredocs(source: str) -> tuple[str, list[str]]:
    """Expand assignment heredocs into verbatim string assignments.

    Consumed rows are replaced with blank lines to keep subsequent source line
    numbers aligned.
    """
    lines = source.split("\n")
    blocks, protected = _collect_heredoc_blocks(source)
    by_start = {block.start: block for block in blocks}
    notes: list[str] = []
    out: list[str] = []
    i = 0
    while i < len(lines):
        block = by_start.get(i)
        if block is None:
            line = lines[i]
            if i + 1 not in protected:
                match = _HEREDOC_OPEN_RE.fullmatch(line)
                if match is not None:
                    indent = match.group("indent")
                    delimiter = match.group("delimiter")
                    if _find_heredoc_end(lines, i, indent, delimiter) is None:
                        name = match.group("name")
                        raise SyntaxError(
                            f"heredoc {name!r} (line {i + 1}) is never closed: "
                            f"expected {delimiter!r} alone at the opening indentation",
                            ("<cell>", i + 1, 1, line),
                        )
            out.append(line)
            i += 1
            continue

        content = "\n".join(
            _heredoc_line_text(line) for line in lines[block.start + 1 : block.end]
        )
        out.append(f"{block.indent}{block.name} = {json.dumps(content, ensure_ascii=True)}")
        out.extend("" for _ in range(block.end - block.start))
        notes.append(
            f"heredoc {block.name}: bound {len(content)} chars "
            f"({block.end - block.start - 1} lines) verbatim"
        )
        i = block.end + 1
    return "\n".join(out), notes


def _unicode_repairs(source: str) -> tuple[str, list[str]]:
    """Replace typography homoglyphs that are never valid code.

    Only applied when the cell fails to compile, and every substitution is
    disclosed: string contents can legitimately hold these characters, so
    the unmodified source always gets first refusal.
    """
    notes: list[str] = []
    repaired = _ZERO_WIDTH_RE.sub("", source)
    repaired = _NBSP_RE.sub(" ", repaired)
    curly_double = len(_CURLY_DOUBLE_RE.findall(repaired))
    curly_single = len(_CURLY_SINGLE_RE.findall(repaired))
    if curly_double:
        repaired = _CURLY_DOUBLE_RE.sub('"', repaired)
        notes.append(f"normalized {curly_double} curly double quote(s) to ASCII")
    if curly_single:
        repaired = _CURLY_SINGLE_RE.sub("'", repaired)
        notes.append(f"normalized {curly_single} curly single quote(s) to ASCII")
    return repaired, notes


def _strip_markdown_fences(source: str) -> str | None:
    """Strip a wrapping ``` fence pair (```` ```python ... ``` ````) when the
    whole cell is fenced. Returns ``None`` when the shape does not match;
    the caller must recompile before trusting the result."""
    lines = source.split("\n")
    first = next((k for k, l in enumerate(lines) if l.strip()), None)
    last = next((k for k in range(len(lines) - 1, -1, -1) if lines[k].strip()), None)
    if first is None or last is None or last <= first:
        return None
    open_line = lines[first].strip()
    if not _FENCE_LINE_RE.fullmatch(open_line):
        return None
    if lines[last].strip() != "```":
        return None
    inner = lines[first + 1 : last]
    if not any(l.strip() for l in inner):
        return None
    return "\n".join(inner)


def _quote_style_at(source: str, pos: tuple[int, ...] | None) -> str:
    """Best-effort description of the string literal opened at ``pos``."""
    if not pos or len(pos) < 2:
        return "string literal"
    row, col = pos[0], max(0, pos[1] - 1)
    lines = source.split("\n")
    if not (1 <= row <= len(lines)):
        return "string literal"
    m = re.search(r'([A-Za-z]{0,2})("""|\'\'\'|"|\')', lines[row - 1][col:])
    if not m:
        return "string literal"
    prefix, quote = m.group(1), m.group(2)
    return f"string literal {prefix}{quote}" if prefix else f"string literal {quote}"


def _syntax_hints(source: str) -> list[str]:
    """Diagnostics for a cell that failed every compile attempt.

    The caret traceback still comes from the ordinary error path; hints add
    the context that caret cannot show (where an unterminated string opened,
    which character is a homoglyph, why a path literal exploded).
    """
    hints: list[str] = []
    try:
        for _ in tokenize.generate_tokens(io.StringIO(source).readline):
            pass
    except tokenize.TokenError as exc:
        message = exc.args[0] if exc.args else ""
        pos = exc.args[1] if len(exc.args) > 1 else None
        if "multi-line string" in message and pos:
            hints.append(
                f"{_quote_style_at(source, pos)} opened at line {pos[0]} is never closed — "
                "count the quote runs; text containing triple quotes is the usual cause "
                "(an assignment heredoc avoids quoting entirely)"
            )
        elif pos:
            hints.append(
                f"string literal on line {pos[0]} is not closed before the end of the line"
            )
    except (SyntaxError, ValueError, IndentationError):
        pass
    try:
        compile(source, "<cell>", "exec", flags=ast.PyCF_ONLY_AST | _TLA_FLAG)
    except SyntaxError as exc:
        message = exc.msg or ""
        lineno = exc.lineno or 0
        if "invalid character" in message:
            m = re.search(r"\(U\+([0-9A-Fa-f]+)\)", message)
            glyph = ""
            if m:
                try:
                    glyph = chr(int(m.group(1), 16))
                except ValueError:
                    glyph = ""
            name = _INVALID_CHAR_HINTS.get(glyph, "non-ASCII character")
            if glyph:
                hints.append(
                    f"line {lineno}: {name} ({glyph!r}) used as code — "
                    "typography homoglyphs are not Python syntax"
                )
            else:
                hints.append(f"line {lineno}: {message}")
        elif "unicodeescape" in message:
            hints.append(
                f"line {lineno}: backslash escape in a normal string literal "
                "— use a raw string r'...' or forward slashes"
            )
    if _strip_markdown_fences(source) is not None:
        hints.append(
            "cell is wrapped in ``` markdown fences — stripping them did not fix the parse"
        )
    return hints


def prepare_cell(code: str) -> PreparedCell:
    """Full pre-processing pipeline for a user cell.

    Order matters: heredocs are extracted first (their content is data, immune
    to magic rewriting and repairs), then magics are translated, then
    a repair ladder runs only if the result still fails to compile. Every
    accepted repair is disclosed in ``notes``; ``hints`` are populated only
    when no repair compiles.
    """
    source, heredoc_notes = _extract_heredocs(code)
    transformed = transform_cell(source)
    if _compiles(transformed):
        return PreparedCell(transformed, heredoc_notes, [])
    fenced = _strip_markdown_fences(transformed)
    cleaned, repair_notes = _unicode_repairs(transformed)
    candidates: list[tuple[str, list[str]]] = []
    if fenced is not None:
        candidates.append((fenced, ["stripped wrapping markdown code fence"]))
    if repair_notes:
        candidates.append((cleaned, repair_notes))
    if fenced is not None and repair_notes:
        both = _strip_markdown_fences(cleaned)
        if both is not None:
            candidates.append(
                (both, ["stripped wrapping markdown code fence", *repair_notes])
            )
    for candidate, applied in candidates:
        if _compiles(candidate):
            return PreparedCell(
                candidate,
                heredoc_notes + [f"executed repaired cell: {'; '.join(applied)}"],
                [],
            )
    return PreparedCell(transformed, heredoc_notes, _syntax_hints(transformed))


def _emit_cell_prep(rid: str, prepared: PreparedCell) -> None:
    for note in prepared.notes:
        _emit({"type": "stderr", "id": rid, "data": f"<kernel> note: {note}\n"})
    for hint in prepared.hints:
        _emit({"type": "stderr", "id": rid, "data": f"<kernel> hint: {hint}\n"})


_MAGIC_LINE_RE = re.compile(
    r"^(?P<indent>[ \t]*)(?P<name>[A-Za-z_][A-Za-z_0-9]*)(?:[ \t]+(?P<args>.*))?$"
)
_ASSIGN_LINE_RE = re.compile(
    r"^(?P<indent>[ \t]*)(?P<lhs>[A-Za-z_][A-Za-z_0-9.\[\], ]*?)\s*=\s*(?P<rhs>.+)$"
)


def _fold_continuations(lines: list[str], start: int) -> tuple[str, int]:
    """Fold trailing backslash continuations starting at ``start``. Returns
    ``(folded_text, lines_consumed)``."""
    parts: list[str] = []
    i = start
    while i < len(lines):
        line = lines[i]
        if line.endswith("\\"):
            parts.append(line[:-1])
            i += 1
            continue
        parts.append(line)
        i += 1
        break
    return ("".join(parts), i - start)


def _quote_arg(text: str) -> str:
    """Return a Python string literal that round-trips ``text`` exactly."""
    return json.dumps(text, ensure_ascii=False)


def transform_cell(source: str) -> str:
    """Translate IPython-style magics + shell escapes into plain Python.

    Rules
    -----
    * ``%name args``              -> ``__proto_magic("name", "args")``
    * ``var = %name args``        -> ``var = __proto_magic("name", "args")``
    * ``!cmd``                    -> ``__proto_shell("cmd")``
    * ``var = !cmd``              -> ``var = __proto_shell("cmd")``
    * ``%%name args\\n<body>``    -> ``__proto_magic_cell("name", "args", "<body>")``
      (cell magic must be the first non-whitespace token of a top-level line and
      consumes the remainder of the cell)

    A bare ``%name`` / ``!cmd`` line is never valid Python, so a cell that
    parses cleanly contains no magics and is returned untouched — this is what
    keeps ``!``/``%`` lines inside triple-quoted strings (markdown badges,
    ``%d`` templates, ``!important``) from being rewritten. Cells that do not
    parse are scanned line by line, skipping physical lines that begin inside
    a multi-line string literal.
    """

    if "%" not in source and "!" not in source:
        return source
    try:
        compile(source, "<cell>", "exec", flags=ast.PyCF_ONLY_AST | _TLA_FLAG)
        return source
    except SyntaxError:
        pass

    protected = _string_body_lines(source)
    lines = source.splitlines()
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if (i + 1) in protected:
            out.append(line)
            i += 1
            continue
        stripped = line.lstrip()
        indent = line[: len(line) - len(stripped)]

        if stripped.startswith("%%"):
            head, _ = _split_magic_head(stripped[2:])
            name, args = head
            body_lines = lines[i + 1 :]
            body = "\n".join(body_lines)
            out.append(
                f"{indent}__proto_magic_cell({_quote_arg(name)}, {_quote_arg(args)}, {_quote_arg(body)})"
            )
            return "\n".join(out)

        if stripped.startswith("%") and not stripped.startswith("%%"):
            folded, consumed = _fold_continuations(lines, i)
            stripped_folded = folded.lstrip()
            indent = folded[: len(folded) - len(stripped_folded)]
            head, _ = _split_magic_head(stripped_folded[1:])
            name, args = head
            out.append(f"{indent}__proto_magic({_quote_arg(name)}, {_quote_arg(args)})")
            i += consumed
            continue

        if stripped.startswith("!"):
            folded, consumed = _fold_continuations(lines, i)
            stripped_folded = folded.lstrip()
            indent = folded[: len(folded) - len(stripped_folded)]
            cmd = stripped_folded[1:].strip()
            out.append(f"{indent}__proto_shell({_quote_arg(cmd)})")
            i += consumed
            continue

        m = _ASSIGN_LINE_RE.match(line)
        if m:
            rhs = m.group("rhs").strip()
            if rhs.startswith("!"):
                cmd = rhs[1:].strip()
                out.append(
                    f"{m.group('indent')}{m.group('lhs').rstrip()} = __proto_shell({_quote_arg(cmd)})"
                )
                i += 1
                continue
            if rhs.startswith("%") and not rhs.startswith("%%"):
                head, _ = _split_magic_head(rhs[1:])
                name, args = head
                out.append(
                    f"{m.group('indent')}{m.group('lhs').rstrip()} = __proto_magic({_quote_arg(name)}, {_quote_arg(args)})"
                )
                i += 1
                continue

        out.append(line)
        i += 1

    return "\n".join(out)


def _string_body_lines(source: str) -> set[int]:
    """Return literal-protected lines using the shared heredoc scanner."""
    _, protected = _collect_heredoc_blocks(source)
    return protected


def _split_magic_head(text: str) -> tuple[tuple[str, str], str]:
    """Split ``"name rest"`` into ``("name", "rest")``."""
    text = text.lstrip()
    if not text:
        return ("", ""), ""
    m = re.match(r"([A-Za-z_][A-Za-z_0-9]*)(?:\s+(.*))?$", text)
    if not m:
        return ("", text), ""
    return (m.group(1), (m.group(2) or "").rstrip()), ""


_LINE_MAGICS: dict[str, Callable[[str], Any]] = {}
_CELL_MAGICS: dict[str, Callable[[str, str], Any]] = {}


def line_magic(name: str) -> Callable[[Callable[[str], Any]], Callable[[str], Any]]:
    def decorator(fn: Callable[[str], Any]) -> Callable[[str], Any]:
        _LINE_MAGICS[name] = fn
        return fn

    return decorator


def cell_magic(
    name: str,
) -> Callable[[Callable[[str, str], Any]], Callable[[str, str], Any]]:
    def decorator(fn: Callable[[str, str], Any]) -> Callable[[str, str], Any]:
        _CELL_MAGICS[name] = fn
        return fn

    return decorator


def _emit_status(op: str, **data: Any) -> None:
    bundle = {"application/x-proto-status": {"op": op, **data}}
    rid = _CURRENT_RID.get()
    if rid is None:
        return
    _sync_before_frame(rid)
    _emit({"type": "display", "id": rid, "bundle": bundle})


_SHELL_READ_CHUNK_BYTES = 8192
_SHELL_OUTPUT_MAX_BYTES = 1024 * 1024
_SHELL_OUTPUT_MAX_LINES = 3000
_SHELL_RESULT_CAPTURE_BYTES = _SHELL_OUTPUT_MAX_BYTES
_PIP_LINE_SCAN_CHARS = 64 * 1024
_SHELL_TRUNCATION_NOTICE = (
    f"[output truncated: shell helper exceeded {_SHELL_OUTPUT_MAX_BYTES} bytes "
    f"or {_SHELL_OUTPUT_MAX_LINES} lines; remaining output discarded]\n"
)


def _process_output_encoding() -> str:
    return locale.getpreferredencoding(False) or "utf-8"


def _process_output_decoder(encoding: str) -> codecs.IncrementalDecoder:
    return codecs.getincrementaldecoder(encoding)(errors="replace")


def _take_prefix_by_lines(text: str, max_lines: int) -> str:
    if max_lines <= 0:
        return ""
    cursor = 0
    for _ in range(max_lines):
        newline = text.find("\n", cursor)
        if newline < 0:
            return text
        cursor = newline + 1
    return text[:cursor]


def _take_prefix_by_encoded_bytes(text: str, max_bytes: int, encoding: str) -> str:
    if max_bytes <= 0:
        return ""
    if len(text.encode(encoding, errors="strict")) <= max_bytes:
        return text
    lo = 0
    hi = len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if len(text[:mid].encode(encoding, errors="strict")) <= max_bytes:
            lo = mid
        else:
            hi = mid - 1
    return text[:lo]


class _ShellOutputLimiter:
    def __init__(self, *, max_bytes: int, max_lines: int, encoding: str) -> None:
        self._remaining_bytes = max_bytes
        self._remaining_lines = max_lines
        self._encoding = encoding
        self._truncated = False
        self._at_line_start = True

    def write(self, text: str) -> None:
        if not text or self._truncated:
            return
        limited = _take_prefix_by_lines(text, self._remaining_lines)
        truncated = limited != text
        byte_limited = _take_prefix_by_encoded_bytes(
            limited, self._remaining_bytes, self._encoding
        )
        truncated = truncated or byte_limited != limited
        if byte_limited:
            sys.stdout.write(byte_limited)
            sys.stdout.flush()
            self._remaining_bytes -= len(
                byte_limited.encode(self._encoding, errors="strict")
            )
            self._remaining_lines -= byte_limited.count("\n")
            self._at_line_start = byte_limited.endswith("\n")
        if truncated:
            self._emit_truncation_notice()

    def _emit_truncation_notice(self) -> None:
        if self._truncated:
            return
        prefix = "" if self._at_line_start else "\n"
        sys.stdout.write(prefix + _SHELL_TRUNCATION_NOTICE)
        sys.stdout.flush()
        self._truncated = True


def _stream_process_output(
    proc: subprocess.Popen, on_text: Callable[[str], None] | None = None
) -> None:
    assert proc.stdout is not None
    encoding = _process_output_encoding()
    decoder = _process_output_decoder(encoding)
    limiter = _ShellOutputLimiter(
        max_bytes=_SHELL_OUTPUT_MAX_BYTES,
        max_lines=_SHELL_OUTPUT_MAX_LINES,
        encoding=encoding,
    )
    while True:
        chunk = os.read(proc.stdout.fileno(), _SHELL_READ_CHUNK_BYTES)
        if not chunk:
            break
        text = decoder.decode(chunk)
        if text:
            limiter.write(text)
            if on_text is not None:
                on_text(text)
    tail = decoder.decode(b"", final=True)
    if tail:
        limiter.write(tail)
        if on_text is not None:
            on_text(tail)


class _BoundedTextCapture:
    def __init__(self, max_bytes: int, max_lines: int, encoding: str) -> None:
        self._remaining_bytes = max_bytes
        self._remaining_lines = max_lines
        self._encoding = encoding
        self._parts: list[str] = []

    def add(self, text: str) -> None:
        if self._remaining_bytes <= 0 or self._remaining_lines <= 0:
            return
        line_limited = _take_prefix_by_lines(text, self._remaining_lines)
        part = _take_prefix_by_encoded_bytes(
            line_limited, self._remaining_bytes, self._encoding
        )
        if not part:
            return
        self._parts.append(part)
        self._remaining_bytes -= len(part.encode(self._encoding, errors="strict"))
        self._remaining_lines -= part.count("\n")

    def text(self) -> str:
        return "".join(self._parts)


class _BoundedLineScanner:
    def __init__(self, max_chars: int, on_line: Callable[[str], None]) -> None:
        self._max_chars = max_chars
        self._on_line = on_line
        self._partial = ""

    def add(self, text: str) -> None:
        data = self._partial + text
        lines = data.splitlines(keepends=True)
        if not lines:
            return
        if lines[-1].endswith(("\n", "\r")):
            self._partial = ""
        else:
            self._partial = lines.pop()
        for line in lines:
            self._on_line(line)
        if len(self._partial) > self._max_chars:
            self._partial = self._partial[-self._max_chars :]

    def finish(self) -> None:
        if self._partial:
            self._on_line(self._partial)
            self._partial = ""


@line_magic("pip")
def _magic_pip(args: str) -> None:
    argv = shlex.split(args) if args else ["--help"]
    cmd = [sys.executable, "-m", "pip", *argv]
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    installed_packages: list[str] = []

    def scan_pip_line(raw_line: str) -> None:
        m = re.search(r"Successfully installed\s+(.+)$", raw_line)
        if m:
            for token in m.group(1).split():
                pkg = token.rsplit("-", 1)[0]
                installed_packages.append(pkg.replace("_", "-"))

    scanner = _BoundedLineScanner(_PIP_LINE_SCAN_CHARS, scan_pip_line)
    _stream_process_output(proc, scanner.add)
    scanner.finish()
    proc.wait()
    if installed_packages:
        import importlib

        importlib.invalidate_caches()
        prefixes = {pkg.lower().replace("-", "_") for pkg in installed_packages}
        for mod_name in list(sys.modules):
            head = mod_name.split(".", 1)[0].lower()
            if head in prefixes:
                sys.modules.pop(mod_name, None)
    _emit_status(
        "pip", args=args, installed=installed_packages, exit_code=proc.returncode
    )


@line_magic("cd")
def _magic_cd(args: str) -> str:
    path = os.path.expanduser(args.strip()) or os.path.expanduser("~")
    os.chdir(path)
    cwd = os.getcwd()
    _emit_status("cd", path=cwd)
    return cwd


@line_magic("pwd")
def _magic_pwd(_args: str) -> str:
    cwd = os.getcwd()
    _emit_status("pwd", path=cwd)
    return cwd


@line_magic("ls")
def _magic_ls(args: str) -> list[str]:
    target = os.path.expanduser(args.strip()) or "."
    entries = sorted(os.listdir(target))
    _emit_status("ls", path=os.path.abspath(target), count=len(entries))
    return entries


@line_magic("env")
def _magic_env(args: str) -> Any:
    args = args.strip()
    if not args:
        return dict(sorted(os.environ.items()))
    if "=" in args:
        key, value = args.split("=", 1)
        os.environ[key.strip()] = value.strip()
        return value.strip()
    return os.environ.get(args)


@line_magic("set_env")
def _magic_set_env(args: str) -> str:
    parts = args.split(None, 1)
    if len(parts) != 2:
        raise ValueError("Usage: %set_env KEY VALUE")
    key, value = parts
    os.environ[key] = value
    return value


@line_magic("time")
def _magic_time(args: str) -> Any:
    start = time.perf_counter()
    result = eval(args, _STATE.user_ns)
    elapsed = time.perf_counter() - start
    sys.stdout.write(f"Wall time: {elapsed * 1000:.2f} ms\n")
    _emit_status("time", elapsed_ms=round(elapsed * 1000, 3))
    return result


@line_magic("timeit")
def _magic_timeit(args: str) -> None:
    import timeit as _timeit

    timer = _timeit.Timer(stmt=args, globals=_STATE.user_ns)
    iters, total = timer.autorange()
    per = total / iters
    sys.stdout.write(f"{iters} loops, best of 1: {per * 1e6:.2f} us per loop\n")
    _emit_status("timeit", loops=iters, total_ms=round(total * 1000, 3))


@line_magic("who")
def _magic_who(_args: str) -> list[str]:
    names = sorted(
        name
        for name, value in _STATE.user_ns.items()
        if not name.startswith("_")
        and not callable(value)
        or hasattr(value, "__class__")
    )
    return [n for n in names if not n.startswith("__")]


@line_magic("whos")
def _magic_whos(_args: str) -> list[tuple[str, str]]:
    rows = []
    for name in sorted(_STATE.user_ns):
        if name.startswith("__"):
            continue
        value = _STATE.user_ns[name]
        rows.append((name, type(value).__name__))
    return rows


@line_magic("reset")
def _magic_reset(_args: str) -> None:
    _STATE.user_ns.clear()
    _STATE.user_ns.update({"__name__": "__main__", "__doc__": None})
    _install_builtins(_STATE.user_ns)
    _STATE.defs.clear()
    _STATE.shadow_warned.clear()
    _emit_status("reset")


@line_magic("load")
def _magic_load(args: str) -> None:
    path = Path(os.path.expanduser(args.strip()))
    source = path.read_text(encoding="utf-8")
    _sync_before_frame(_CURRENT_RID.get())
    _emit(
        {"type": "display", "id": _CURRENT_RID.get(), "bundle": {"text/plain": source}}
    )
    _exec_source(source, _STATE.user_ns)


@line_magic("run")
def _magic_run(args: str) -> None:
    parts = shlex.split(args) if args else []
    if not parts:
        raise ValueError("Usage: %run <path>")
    target = os.path.expanduser(parts[0])
    saved_argv = sys.argv
    try:
        sys.argv = [target, *parts[1:]]
        result_ns = runpy.run_path(target, run_name="__main__")
    finally:
        sys.argv = saved_argv
    for name, value in result_ns.items():
        if name.startswith("__"):
            continue
        _STATE.user_ns[name] = value


@cell_magic("bash")
def _magic_cell_bash(args: str, body: str) -> int:
    return _run_shell_body(body, shell_arg="/bin/bash")


_CAPTURE_TRUNCATION_NOTICE = (
    f"[output truncated: capture exceeded {_SHELL_OUTPUT_MAX_BYTES} bytes "
    f"or {_SHELL_OUTPUT_MAX_LINES} lines; remaining output discarded]\n"
)


class _BoundedCapture(io.StringIO):
    """String stream retaining at most the shell helper byte/line limits."""

    def __init__(self) -> None:
        super().__init__()
        self._bytes = 0
        self._lines = 0
        self._truncated = False

    def write(self, value: str) -> int:
        if not isinstance(value, str):
            raise TypeError(f"write() argument must be str, not {type(value).__name__}")
        original_length = len(value)
        if self._truncated or not value:
            return original_length
        remaining = _SHELL_OUTPUT_MAX_BYTES - self._bytes
        prefix = value[:remaining]
        encoded = prefix.encode("utf-8", "replace")
        if len(encoded) > remaining:
            prefix = encoded[:remaining].decode("utf-8", "ignore")
            encoded = prefix.encode("utf-8")
        allowed_lines = _SHELL_OUTPUT_MAX_LINES - self._lines
        if allowed_lines <= 0:
            prefix = ""
        else:
            cursor = 0
            for _ in range(allowed_lines):
                newline = prefix.find("\n", cursor)
                if newline < 0:
                    break
                cursor = newline + 1
            else:
                prefix = prefix[:cursor]
        if prefix:
            super().write(prefix)
            self._bytes += len(prefix.encode("utf-8"))
            self._lines += prefix.count("\n")
        if len(prefix) < len(value):
            self._truncated = True
        return original_length

    def getvalue(self) -> str:
        text = super().getvalue()
        return text + (_CAPTURE_TRUNCATION_NOTICE if self._truncated else "")


@cell_magic("capture")
def _magic_cell_capture(args: str, body: str) -> str:
    """Capture stdout/stderr of body; bind to ``args`` (a name) if provided."""
    captured = _BoundedCapture()
    saved_stdout, saved_stderr = sys.stdout, sys.stderr
    sys.stdout = sys.stderr = captured
    try:
        _exec_source(body, _STATE.user_ns)
    finally:
        sys.stdout, sys.stderr = saved_stdout, saved_stderr
    text = captured.getvalue()
    name = args.strip()
    if name:
        _STATE.user_ns[name] = text
    return text


@cell_magic("timeit")
def _magic_cell_timeit(args: str, body: str) -> None:
    import timeit as _timeit

    timer = _timeit.Timer(stmt=body, globals=_STATE.user_ns)
    iters, total = timer.autorange()
    per = total / iters
    sys.stdout.write(f"{iters} loops, best of 1: {per * 1e6:.2f} us per loop\n")
    _emit_status("timeit", loops=iters, total_ms=round(total * 1000, 3))


@cell_magic("writefile")
def _magic_cell_writefile(args: str, body: str) -> str:
    path = Path(os.path.expanduser(args.strip()))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    _emit_status("writefile", path=str(path), bytes=len(body))
    return str(path)


def _run_shell_body(body: str, *, shell_arg: str) -> int:
    proc = subprocess.Popen(
        [shell_arg, "-c", body],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    _stream_process_output(proc)
    proc.wait()
    return proc.returncode


def __proto_magic(name: str, args: str) -> Any:
    fn = _LINE_MAGICS.get(name)
    if fn is None:
        raise NameError(f"UsageError: Line magic function '%{name}' not found.")
    return fn(args)


def __proto_magic_cell(name: str, args: str, body: str) -> Any:
    fn = _CELL_MAGICS.get(name)
    if fn is None:
        raise NameError(f"UsageError: Cell magic function '%%{name}' not found.")
    return fn(args, body)


class _ShellResult(list):
    """Result of ``!cmd`` — list of stripped output lines."""

    def __init__(self, lines: list[str], returncode: int) -> None:
        super().__init__(lines)
        self.returncode = returncode

    @property
    def n(self) -> str:
        return "\n".join(self)

    @property
    def s(self) -> str:
        return " ".join(self)


def __proto_shell(cmd: str) -> _ShellResult:
    proc = subprocess.Popen(
        cmd,
        shell=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    capture = _BoundedTextCapture(
        _SHELL_RESULT_CAPTURE_BYTES, _SHELL_OUTPUT_MAX_LINES, _process_output_encoding()
    )
    _stream_process_output(proc, capture.add)
    proc.wait()
    lines = [line for line in capture.text().splitlines()]
    return _ShellResult(lines, proc.returncode)


_REPR_MIMES = [
    ("_repr_html_", "text/html"),
    ("_repr_markdown_", "text/markdown"),
    ("_repr_svg_", "image/svg+xml"),
    ("_repr_png_", "image/png"),
    ("_repr_jpeg_", "image/jpeg"),
    ("_repr_json_", "application/json"),
    ("_repr_latex_", "text/latex"),
]


def _is_matplotlib_figure(value: Any) -> bool:
    figure_module = sys.modules.get("matplotlib.figure")
    figure_cls = getattr(figure_module, "Figure", None)
    if isinstance(figure_cls, type) and isinstance(value, figure_cls):
        return True

    value_type = type(value)
    return (
        value_type.__module__ == "matplotlib.figure" and value_type.__name__ == "Figure"
    )


def _matplotlib_figure_png(value: Any) -> str | None:
    if not _is_matplotlib_figure(value):
        return None

    savefig = getattr(value, "savefig", None)
    if not callable(savefig):
        return None

    try:
        buf = io.BytesIO()
        savefig(buf, format="png", bbox_inches="tight")
    except Exception:
        return None

    displayed_ids = _CURRENT_DISPLAYED_MATPLOTLIB_FIGURE_IDS.get()
    if displayed_ids is not None:
        displayed_ids.add(id(value))
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _coerce_image_bytes(value: Any) -> str:
    if isinstance(value, (bytes, bytearray)):
        return base64.b64encode(bytes(value)).decode("ascii")
    if isinstance(value, str):
        return value
    return base64.b64encode(repr(value).encode("utf-8")).decode("ascii")


def _mime_bundle(value: Any) -> dict:
    """Build a Jupyter-style MIME bundle for ``value``.

    Honors ``_repr_mimebundle_`` first, falls back to individual ``_repr_*_``
    accessors, and always provides ``text/plain``.
    """
    bundle: dict[str, Any] = {}
    matplotlib_png = _matplotlib_figure_png(value)
    if matplotlib_png is not None:
        bundle["image/png"] = matplotlib_png

    mimebundle = getattr(value, "_repr_mimebundle_", None)
    if callable(mimebundle):
        try:
            data = mimebundle()
        except Exception:
            data = None
        if isinstance(data, tuple):
            data = data[0]
        if isinstance(data, dict):
            for key, mime_value in data.items():
                key_str = str(key)
                if key_str in ("image/png", "image/jpeg"):
                    bundle[key_str] = _coerce_image_bytes(mime_value)
                else:
                    bundle[key_str] = mime_value

    for attr, mime in _REPR_MIMES:
        if mime in bundle:
            continue
        repr_fn = getattr(value, attr, None)
        if not callable(repr_fn):
            continue
        try:
            data = repr_fn()
        except Exception:
            continue
        if data is None:
            continue
        if mime in ("image/png", "image/jpeg"):
            bundle[mime] = _coerce_image_bytes(data)
        else:
            bundle[mime] = data

    if "text/plain" not in bundle:
        try:
            bundle["text/plain"] = repr(value)
        except Exception:
            bundle["text/plain"] = f"<unrepr {type(value).__name__}>"

    return bundle


def _emit_display(bundle: dict, *, kind: str = "display") -> None:
    rid = _CURRENT_RID.get()
    if rid is None:
        return
    _sync_before_frame(rid)
    _emit({"type": kind, "id": rid, "bundle": bundle})


def __proto_display(value: Any, *, raw: bool = False, kind: str = "display") -> None:
    if raw:
        if not isinstance(value, dict):
            raise TypeError("display(..., raw=True) requires a MIME bundle dict")
        bundle = {str(k): v for k, v in value.items()}
        if "text/plain" not in bundle:
            bundle["text/plain"] = ""
        _emit_display(bundle, kind=kind)
        return
    _emit_display(_mime_bundle(value), kind=kind)


def _prelude_fn(name: str):
    """Fetch a private prelude helper by name (prelude ns first, then the
    legacy user-ns layout)."""
    fn = None
    if _STATE.prelude_ns is not None:
        fn = _STATE.prelude_ns.get(name)
    if fn is None:
        fn = _STATE.user_ns.get(name)
    return fn if callable(fn) else None


def _flush_fs_status() -> None:
    """Emit status events for filesystem mutations made without a helper API."""
    fn = _prelude_fn("_flush_fs_status")
    if fn is not None:
        fn()


def _reset_fs_status() -> None:
    """Drop mutation records left by runner machinery between requests."""
    fn = _prelude_fn("_reset_fs_status")
    if fn is not None:
        fn()


def _ensure_matplotlib_saved_hook() -> None:
    """Patch Figure.savefig and pyplot.close to remember figures for end-of-cell display.

    pyplot drops closed figures, so without these hooks the dominant agent
    patterns -- ``fig.savefig(path); plt.close(fig)`` or ``plt.close("all")``
    -- never display.
    Installs lazily via an import hook so sessions that never import
    matplotlib pay nothing.
    """
    if "matplotlib.pyplot" in sys.modules:
        _patch_pyplot(sys.modules["matplotlib.pyplot"])
        return
    if _PYLOT_IMPORT_HOOK in sys.meta_path:
        return
    sys.meta_path.insert(0, _PYLOT_IMPORT_HOOK)


class _PyplotLoaderWrap:
    def __init__(self, loader: Any, on_load: Callable[[Any], None]) -> None:
        self._loader = loader
        self._on_load = on_load

    def create_module(self, spec: Any) -> Any:
        return self._loader.create_module(spec)

    def exec_module(self, module: Any) -> None:
        self._loader.exec_module(module)
        self._on_load(module)


class _PyplotImportHook:
    def find_spec(self, fullname: str, path: Any = None, target: Any = None) -> Any:
        if fullname != "matplotlib.pyplot":
            return None
        sys.meta_path.remove(self)
        try:
            spec = importlib.util.find_spec(fullname)
        finally:
            sys.meta_path.insert(0, self)
        if spec is None or spec.loader is None:
            return spec
        spec.loader = _PyplotLoaderWrap(spec.loader, _patch_pyplot)
        return spec


_PYLOT_IMPORT_HOOK = _PyplotImportHook()


def _patch_pyplot(plt: Any) -> None:
    if getattr(plt, "_proto_saved_hook_installed", False):
        return
    plt._proto_saved_hook_installed = True
    figure_cls = getattr(sys.modules.get("matplotlib.figure"), "Figure", None)
    if figure_cls is None:
        return
    orig_savefig = figure_cls.savefig

    def savefig(self: Any, *args: Any, **kwargs: Any) -> Any:
        saved = _SAVED_MATPLOTLIB_FIGURES.get()
        if saved is not None:
            try:
                saved.append(weakref.ref(self))
            except TypeError:
                pass
        return orig_savefig(self, *args, **kwargs)

    figure_cls.savefig = savefig

    orig_close = plt.close

    def close(fig: Any = None) -> Any:
        closed = _CLOSED_MATPLOTLIB_FIGURES.get()
        before = _open_matplotlib_figures() if closed is not None else []
        result = orig_close(fig)
        if closed is None or not before:
            return result
        displayed = _CURRENT_DISPLAYED_MATPLOTLIB_FIGURE_IDS.get() or set()
        still_open = {id(figure) for figure in _open_matplotlib_figures()}
        for figure in before:
            if len(closed) >= _MAX_CLOSED_MATPLOTLIB_FIGURES:
                break
            if id(figure) in still_open or id(figure) in displayed:
                continue
            if all(figure is not kept for kept in closed):
                closed.append(figure)
        return result

    close.__doc__ = orig_close.__doc__
    close.__wrapped__ = orig_close
    plt.close = close


def _open_matplotlib_figures() -> list[Any]:
    helpers = sys.modules.get("matplotlib._pylab_helpers")
    gcf = getattr(helpers, "Gcf", None)
    if gcf is None:
        return []
    try:
        return [manager.canvas.figure for manager in gcf.get_all_fig_managers()]
    except Exception:
        return []


def _emit_figure_png(fig: Any, label: str) -> None:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight")
    data = base64.b64encode(buf.getvalue()).decode("ascii")
    _emit_display({"image/png": data, "text/plain": label})


def _flush_matplotlib_figures() -> None:
    displayed = _CURRENT_DISPLAYED_MATPLOTLIB_FIGURE_IDS.get() or set()
    emitted: set[int] = set()
    closed = _CLOSED_MATPLOTLIB_FIGURES.get()
    if closed:
        # Closed before cell end, so they precede figures still open.
        pending = list(closed)
        closed.clear()
        for fig in pending:
            if id(fig) in displayed or id(fig) in emitted:
                continue
            try:
                _emit_figure_png(fig, "<Figure>")
                emitted.add(id(fig))
            except Exception:
                continue
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is not None:
        try:
            fignums = list(plt.get_fignums())
        except Exception:
            fignums = []
        for num in fignums:
            try:
                fig = plt.figure(num)
                if id(fig) in displayed or id(fig) in emitted:
                    plt.close(fig)
                    continue
                _emit_figure_png(fig, f"<Figure {num}>")
                emitted.add(id(fig))
                plt.close(fig)
            except Exception:
                continue
    saved = _SAVED_MATPLOTLIB_FIGURES.get()
    if saved:
        remaining: list[Any] = []
        for ref in saved:
            fig = ref()
            if fig is None or id(fig) in displayed or id(fig) in emitted:
                continue
            try:
                _emit_figure_png(fig, "<Figure>")
                emitted.add(id(fig))
            except Exception:
                remaining.append(ref)
        saved[:] = remaining


os.environ.setdefault("MPLBACKEND", "Agg")


_KERNEL_GENERATION = os.environ.get("PI_KERNEL_GENERATION") or os.urandom(16).hex()
# Capture launch configuration once, not mutable cell environment or user namespace getters.
_KERNEL_TARGET = json.loads(os.environ.get("PI_KERNEL_TARGET", '{"kind":"local"}'))
_REMOTE_TARGET = os.environ.get("PI_KERNEL_REMOTE") == "1"


def __proto_kernel_state(*, limit: int = 200) -> dict:
    if type(limit) is not int or not 0 <= limit <= 1000:
        raise ValueError("kernel_state limit must be an integer from 0 to 1000")
    variables = []
    total = 0
    hidden = set(_runner_exports()) | set(_STATE.prelude_exports)
    for name in sorted(name for name in _STATE.user_ns if type(name) is str):
        value = _STATE.user_ns[name]
        if name.startswith("__") or (name in hidden and name not in _STATE.defs):
            continue
        total += 1
        if len(variables) >= limit:
            continue
        kind = type(value)
        # Bypass custom metaclass attributes as well as value repr/iteration.
        kind_name = type.__dict__["__name__"].__get__(kind)[:160]
        if kind is str:
            preview = repr(value[:160])[:200]
        elif any(kind is builtin for builtin in (int, float, bool, type(None))):
            preview = str(value)[:160] if kind is not int or value.bit_length() < 512 else "<large integer>"
        elif any(kind is builtin for builtin in (list, tuple, dict, set, frozenset, bytes, bytearray)):
            preview = f"<{kind_name}: {len(value)} items>"
        else:
            preview = f"<{kind_name}>"
        variables.append({"name": name[:200], "nameTruncated": len(name) > 200,
                          "type": kind_name, "preview": preview,
                          "cell": _STATE.defs.get(name, _STATE.execution_count), "provenance": "cell"})
    # asyncio owns these tasks; do not call user task repr, names or coroutine getters.
    live_tasks = asyncio.all_tasks()
    tasks = []
    for task in sorted(live_tasks, key=id)[:limit]:
        request = task in _STATE.request_tasks
        tasks.append({"id": str(id(task)), "kind": "cell" if request else "asyncio",
                      "state": "running", "cell": _STATE.execution_count if request else None})
    return {"generation": _KERNEL_GENERATION, "target": json.loads(json.dumps(_KERNEL_TARGET)), "language": "python", "interpreter": sys.executable,
            "cwd": os.getcwd(), "executionCount": _STATE.execution_count,
            "active": _STATE.active_executions,
            "queued": max(0, len(_STATE.pending_request_ids) - len(_STATE.request_tasks)),
            "variables": variables, "totalVariables": total,
            "tasks": tasks, "totalTasks": len(live_tasks), "taskScope": "asyncio"}


def __proto_defs_view() -> dict[str, int]:
    return dict(_STATE.defs)


def _state_path(path):
    resolver = _prelude_fn("proto_path")
    return str(resolver(path) if resolver else Path(path).expanduser())


def __proto_save_state(path, names) -> dict:
    reserved = set(_runner_exports()) | set(_STATE.prelude_exports)
    return _persistence.save_state(_state_path(path), names, _STATE.user_ns, reserved)


def __proto_load_state(path, *, collision="reject") -> dict:
    reserved = set(_runner_exports()) | set(_STATE.prelude_exports)
    result = _persistence.load_state(_state_path(path), _STATE.user_ns, reserved, collision=collision)
    for name in result["names"]:
        _STATE.defs[name] = _STATE.execution_count
    return result


def _current_run_id() -> str | None:
    return _CURRENT_RID.get()


def _next_completion_invocation_id() -> str:
    counter = _CURRENT_COMPLETION_COUNT.get()
    if counter is None:
        counter = [0]
        _CURRENT_COMPLETION_COUNT.set(counter)
    value = counter[0]
    counter[0] += 1
    return str(value)


def _runner_exports() -> dict[str, Any]:
    return {
        "display": __proto_display,
        "defs": __proto_defs_view,
        "kernel_state": __proto_kernel_state,
        "save_state": __proto_save_state,
        "load_state": __proto_load_state,
    }


def _install_builtins(ns: dict) -> None:
    """(Re)install runner + prelude helpers into a user namespace.

    Helpers are bound twice: as globals (visible to ``dir()``/``%who``) and
    in a private copy of ``builtins`` that backs the namespace, so a cell
    that rebinds ``output = ...`` can ``del output`` to get the helper back
    instead of losing it for the life of the kernel.
    """
    ns["__proto_display"] = __proto_display
    ns["__proto_magic"] = __proto_magic
    ns["__proto_magic_cell"] = __proto_magic_cell
    ns["__proto_shell"] = __proto_shell
    ns["__proto_current_run_id__"] = _current_run_id
    exports = {**_runner_exports(), **_STATE.prelude_exports}
    ns.update(exports)
    ns["__builtins__"] = {**vars(builtins), **exports}


def _load_prelude(source: str) -> None:
    """Execute the host prelude in an isolated module namespace and export its API.

    Only ``__all__`` (or, failing that, public non-module names) is copied
    into ``user_ns``; the helpers' own globals (``json``, ``os``, private
    ``_bridge_call``…) stay out of reach of user rebindings.
    """
    ns: dict[str, Any] = {
        "__name__": "__proto_prelude__",
        "__builtins__": builtins,
        "__proto_display": __proto_display,
        "__proto_kernel_note": _emit_kernel_note,
        "__proto_sources_may_have_changed": _mark_sources_dirty,
        "__proto_current_run_id__": _current_run_id,
        "__proto_next_completion_invocation__": _next_completion_invocation_id,
    }
    if os.environ.get("PI_KERNEL_STDIO_BRIDGE") == "1":
        ns["__proto_bridge_call__"] = __proto_bridge_call__
    exec(compile(source, "<prelude>", "exec"), ns)
    declared = ns.get("__all__")
    if isinstance(declared, (list, tuple)):
        names = [n for n in declared if isinstance(n, str) and n in ns]
    else:
        names = [
            n
            for n, v in ns.items()
            if not n.startswith("_") and not isinstance(v, types.ModuleType)
        ]
    _STATE.prelude_ns = ns
    _STATE.prelude_exports = {n: ns[n] for n in names}
    _install_builtins(_STATE.user_ns)
    _STATE.prelude_names = set(_runner_exports()) | {
        n for n, v in _STATE.prelude_exports.items() if not isinstance(v, (types.ModuleType, type))
    }
    _STATE.defs.clear()
    _STATE.shadow_warned.clear()


_install_builtins(_STATE.user_ns)


_TLA_FLAG = getattr(ast, "PyCF_ALLOW_TOP_LEVEL_AWAIT", 0x2000)


def _await_sync(coro) -> Any:
    try:
        running_loop = asyncio.get_running_loop()
    except RuntimeError:
        running_loop = None
    if running_loop is not None and running_loop.is_running():
        raise RuntimeError(
            "top-level await is not supported from synchronous magic execution"
        )
    return asyncio.run(coro)


def _run_compiled_sync(code, ns: dict, *, want_value: bool) -> Any:
    """Synchronous execution path used by nested magic helpers."""
    if code.co_flags & inspect.CO_COROUTINE:
        result = _await_sync(eval(code, ns))
        return result if want_value else None
    if want_value:
        return eval(code, ns)
    exec(code, ns)
    return None


async def _run_compiled_async(code, ns: dict, *, want_value: bool) -> Any:
    """Execute a code object in the persistent event loop.

    Coroutine code is awaited in the FIFO execution task. Plain
    statement/expression code runs on the main runner thread so SIGINT can
    interrupt it reliably.
    """
    if code.co_flags & inspect.CO_COROUTINE:
        result = await eval(code, ns)
        return result if want_value else None
    if want_value:
        return eval(code, ns)
    exec(code, ns)
    return None


_USER_EXEC_CODES: set[Any] = {_run_compiled_sync.__code__, _run_compiled_async.__code__}


def _compile_source(source: str) -> tuple[Any, Any | None, bool]:
    module = ast.parse(source, "<cell>", "exec")
    if not module.body:
        return None, None, False

    last = module.body[-1]
    if isinstance(last, ast.Expr):
        body_module = ast.Module(body=module.body[:-1], type_ignores=[])
        expr_module = ast.Expression(body=last.value)
        ast.copy_location(expr_module, last)
        body_code = compile(body_module, "<cell>", "exec", flags=_TLA_FLAG)
        expr_code = compile(expr_module, "<cell>", "eval", flags=_TLA_FLAG)
        return body_code, expr_code, True

    return compile(module, "<cell>", "exec", flags=_TLA_FLAG), None, False


def _exec_source(source: str, ns: dict) -> None:
    """Synchronous source execution for legacy magic helpers."""
    body_code, expr_code, has_expr = _compile_source(source)
    if body_code is None:
        return
    _run_compiled_sync(body_code, ns, want_value=False)
    if has_expr and expr_code is not None:
        value = _run_compiled_sync(expr_code, ns, want_value=True)
        if value is not None:
            __proto_display(value, kind="result")


async def _exec_source_async(source: str, ns: dict) -> None:
    """Compile + execute ``source``; if the last node is an expression, route
    its value through ``__proto_display`` so dataframes/figures render rich.
    Top-level ``await`` / ``async for`` / ``async with`` is permitted; awaited
    regions yield to other requests in the runner's persistent event loop."""
    body_code, expr_code, has_expr = _compile_source(source)
    if body_code is None:
        return
    await _run_compiled_async(body_code, ns, want_value=False)
    if has_expr and expr_code is not None:
        value = await _run_compiled_async(expr_code, ns, want_value=True)
        if value is not None:
            __proto_display(value, kind="result")


def _install_idle_sigint() -> None:
    try:
        signal.signal(signal.SIGINT, signal.SIG_IGN)
    except (OSError, ValueError):
        pass


def _user_code_on_stack(frame: Any) -> bool:
    while frame is not None:
        if frame.f_code in _USER_EXEC_CODES:
            return True
        frame = frame.f_back
    return False


def _exec_sigint_handler(_signum: int, frame: Any) -> None:
    """Interrupt the running cell without taking the runner down with it.

    Python-level signal handlers always run on the main thread. If user code
    is on the stack (sync code, or a sync section of a coroutine) raising
    ``KeyboardInterrupt`` unwinds it like a REPL would. If the main thread is
    instead parked in the event loop — the cell is at a top-level ``await`` —
    raising there would propagate out of ``selector.select`` and kill the
    whole runner (all kernel state lost); cancel the request task instead so
    the ``await`` raises ``CancelledError`` inside the cell.
    """
    if _user_code_on_stack(frame):
        raise KeyboardInterrupt
    cancelled = False
    for task in list(_STATE.request_tasks):
        if not task.done():
            task.cancel()
            cancelled = True
    loop = _STATE.loop
    if cancelled and loop is not None:
        try:
            loop.call_soon_threadsafe(_noop)
        except RuntimeError:
            pass


def _noop() -> None:
    return None


def _install_exec_sigint() -> None:
    try:
        signal.signal(signal.SIGINT, _exec_sigint_handler)
    except (OSError, ValueError):
        pass


def _begin_exec_sigint() -> None:
    _STATE.active_executions += 1
    _install_exec_sigint()


def _end_exec_sigint() -> None:
    if _STATE.active_executions > 0:
        _STATE.active_executions -= 1
    if _STATE.active_executions == 0:
        _install_idle_sigint()


_MANAGED_ENV_KEYS = (
    "PI_SESSION_FILE",
    "PI_ARTIFACTS_DIR",
    "PI_TOOL_BRIDGE_URL",
    "PI_TOOL_BRIDGE_TOKEN",
    "PI_TOOL_BRIDGE_SESSION",
    "PI_EVAL_LOCAL_ROOTS",
)


def _apply_request_runtime(req: dict) -> None:
    cwd = req.get("cwd")
    if isinstance(cwd, str) and cwd:
        os.chdir(cwd)
    _set_import_path_prefix(os.getcwd())

    env = req.get("env")
    if isinstance(env, dict):
        for key in _MANAGED_ENV_KEYS:
            value = env.get(key)
            if isinstance(value, str):
                os.environ[key] = value
            elif value is None:
                os.environ.pop(key, None)

    observations = req.get("fsObservations")
    if isinstance(observations, list) and observations:
        note_observed = _prelude_fn("_fs_note_observed")
        if note_observed is not None:
            note_observed(observations)


def _start_parent_watchdog() -> None:
    """Self-terminate when the host process dies.

    The main loop only exits when stdin EOFs, which only happens once user
    code finishes and the next ``readline`` call returns. If the host gets
    SIGKILL mid-execution (or any way that skips graceful shutdown) the
    runner would otherwise outlive its parent and keep holding kernel
    state. Poll ``os.getppid()`` instead and ``os._exit`` the moment we get
    reparented \u2014 covers POSIX hosts. Windows has no reliable ppid
    equivalent; there we still bail out on the next stdin read.
    """
    if os.name != "posix":
        return
    original_ppid = os.getppid()
    if original_ppid <= 1:
        return

    def watch() -> None:
        while True:
            try:
                if os.getppid() != original_ppid:
                    os._exit(0)
            except Exception:
                return
            time.sleep(10)

    thread = threading.Thread(target=watch, name="proto-parent-watchdog", daemon=True)
    thread.start()


def _cell_bound_names(source: str) -> tuple[list[str], list[str]]:
    """Top-level names a cell defines: ``(def/class names, every bound name)``.

    The second list also covers assignments, loop/with targets and imports —
    ``output = tool.bash(...)`` shadows the ``output()`` helper just as
    surely as ``def output`` does.
    """
    try:
        tree = compile(source, "<cell>", "exec", flags=ast.PyCF_ONLY_AST | _TLA_FLAG)
    except SyntaxError:
        return [], []
    defs: list[str] = []
    bound: list[str] = []

    def add_target(target: ast.AST) -> None:
        if isinstance(target, ast.Name):
            bound.append(target.id)
        elif isinstance(target, (ast.Tuple, ast.List)):
            for elt in target.elts:
                add_target(elt)
        elif isinstance(target, ast.Starred):
            add_target(target.value)

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            defs.append(node.name)
            bound.append(node.name)
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                add_target(target)
        elif isinstance(node, ast.AnnAssign):
            add_target(node.target)
        elif isinstance(node, (ast.For, ast.AsyncFor)):
            add_target(node.target)
        elif isinstance(node, (ast.With, ast.AsyncWith)):
            for item in node.items:
                if item.optional_vars is not None:
                    add_target(item.optional_vars)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                bound.append(alias.asname or alias.name.split(".", 1)[0])
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name != "*":
                    bound.append(alias.asname or alias.name)
    return defs, bound


def _track_cell_defs(source: str, rid: str, execution_count: int) -> None:
    if _STATE.prelude_names is None and _STATE.user_ns.get("__proto_prelude_loaded__"):
        _STATE.prelude_names = set(_STATE.user_ns)
        _STATE.defs.clear()
        return
    live_names = _STATE.user_ns.keys()
    for name in tuple(_STATE.defs):
        if name not in live_names:
            del _STATE.defs[name]
    _STATE.shadow_warned.intersection_update(live_names)
    defs, bound = _cell_bound_names(source)
    for name in (*defs, *bound):
        if name in _STATE.user_ns:
            _STATE.defs[name] = execution_count
    if _STATE.prelude_names is None:
        return
    for name in bound:
        if name not in _STATE.prelude_names or name in _STATE.shadow_warned:
            continue
        _STATE.shadow_warned.add(name)
        _emit(
            {
                "type": "stderr",
                "id": rid,
                "data": (
                    f"<kernel> warning: {name!r} now shadows the kernel helper of the same name; "
                    f"later cells see your value. `del {name}` restores the helper.\n"
                ),
            }
        )


async def _handle_request_async(req: dict) -> None:
    rid = str(req.get("id"))
    token = _CURRENT_RID.set(rid)
    completion_token = _CURRENT_COMPLETION_COUNT.set([0])
    displayed_matplotlib_token = _CURRENT_DISPLAYED_MATPLOTLIB_FIGURE_IDS.set(set())
    saved_matplotlib_token = _SAVED_MATPLOTLIB_FIGURES.set([])
    closed_matplotlib_token = _CLOSED_MATPLOTLIB_FIGURES.set([])
    try:
        _ensure_matplotlib_saved_hook()
    except Exception:
        pass
    shell_env = req.get("shellEnv")
    scoped_env = {key: value for key, value in (shell_env or {}).items()
                  if key not in _MANAGED_ENV_KEYS and not key.startswith("PI_KERNEL_")}
    saved_env = {key: os.environ.get(key) for key in scoped_env}
    os.environ.update(scoped_env)
    saved_stdin = sys.stdin
    program_input = _ProgramInput(rid, req.get("stdin") is True)
    _PROGRAM_INPUTS[rid] = program_input
    cell_stdin = io.TextIOWrapper(io.BufferedReader(program_input), encoding="utf-8")
    sys.stdin = cell_stdin
    capture = _begin_fd_capture(rid)
    _STATE.user_ns["__proto_run_id__"] = rid
    _STATE.cancel_requested = False
    _STATE.execution_count += 1
    try:
        _reset_fs_status()
    except Exception:
        pass
    execution_count = _STATE.execution_count
    bindings_before = dict(_STATE.user_ns)

    status: str = "ok"
    cancelled = False
    exit_code: int | None = None
    is_prelude = bool(req.get("prelude"))

    try:
        try:
            _apply_request_runtime(req)
            code = req.get("code", "")
            if is_prelude:
                transformed = code
            else:
                prepared = prepare_cell(code)
                transformed = prepared.source
                _emit_cell_prep(rid, prepared)
        except SyntaxError as exc:
            _emit_error(rid, exc)
            _sync_fd_capture(capture)
            _emit(
                {
                    "type": "done",
                    "id": rid,
                    "status": "error",
                    "executionCount": execution_count,
                    "cancelled": False,
                }
            )
            return
        except asyncio.CancelledError:
            raise
        except BaseException as exc:
            _emit_error(rid, exc)
            _sync_fd_capture(capture)
            _emit(
                {
                    "type": "done",
                    "id": rid,
                    "status": "error",
                    "executionCount": execution_count,
                    "cancelled": False,
                }
            )
            return

        if rid in _STATE.cancelled_request_ids:
            _sync_fd_capture(capture)
            _emit(
                {
                    "type": "done",
                    "id": rid,
                    "status": "error",
                    "executionCount": execution_count,
                    "cancelled": True,
                }
            )
            return

        _begin_exec_sigint()
        try:
            _emit({"type": "started", "id": rid})
            if not is_prelude:
                _emit_status("kernel-state", generation=_KERNEL_GENERATION, language="python", executionCount=execution_count)
            if is_prelude:
                _load_prelude(transformed)
            else:
                _STATE.cell_bindings = frozenset(_cell_bound_names(transformed)[1])
                _refresh_project_modules()
                await _exec_source_async(transformed, _STATE.user_ns)
        except KeyboardInterrupt:
            cancelled = True
            status = "error"
            _emit_error(rid, KeyboardInterrupt("Execution interrupted"))
        except asyncio.CancelledError:
            if _STATE.shutting_down:
                raise
            cancelled = True
            status = "error"
            _emit_error(rid, KeyboardInterrupt("Execution interrupted"))
            current = asyncio.current_task()
            uncancel = getattr(current, "uncancel", None)
            if callable(uncancel):
                uncancel()
        except SystemExit as exc:
            exit_code, message = _system_exit_outcome(exc)
            if message is not None:
                _sync_before_frame(rid)
                _emit({"type": "stderr", "id": rid, "data": f"{message}\n"})
            if exit_code != 0:
                status = "error"
        except BaseException as exc:
            status = "error"
            _emit_error(rid, exc)
        finally:
            _end_exec_sigint()
            try:
                _flush_fs_status()
            except Exception:
                pass
            try:
                _flush_matplotlib_figures()
            except Exception:
                pass

        try:
            if not is_prelude:
                for name, value in _STATE.user_ns.items():
                    if type(name) is str and not name.startswith("__") and (name not in bindings_before or bindings_before[name] is not value):
                        _STATE.defs[name] = execution_count
                _track_cell_defs(transformed, rid, execution_count)
            _flush_stream_proxies(rid)
        except BaseException as exc:
            status = "error"
            _emit_error(rid, exc)
        if rid in _STATE.cancelled_request_ids:
            cancelled = True
            status = "error"
        _sync_fd_capture(capture)
        done: dict = {
            "type": "done",
            "id": rid,
            "status": status,
            "executionCount": execution_count,
            "cancelled": cancelled,
        }
        if exit_code is not None and not cancelled:
            done["exitCode"] = exit_code
        _emit(done)
    finally:
        _flush_stream_proxies(rid)
        _sync_fd_capture(capture)
        _end_fd_capture()
        _flush_stream_proxies(rid)
        _CURRENT_RID.reset(token)
        _CURRENT_COMPLETION_COUNT.reset(completion_token)
        _CURRENT_DISPLAYED_MATPLOTLIB_FIGURE_IDS.reset(displayed_matplotlib_token)
        _SAVED_MATPLOTLIB_FIGURES.reset(saved_matplotlib_token)
        _CLOSED_MATPLOTLIB_FIGURES.reset(closed_matplotlib_token)
        sys.stdin = saved_stdin
        _PROGRAM_INPUTS.pop(rid, None)
        cell_stdin.close()
        for key, value in saved_env.items():
            if os.environ.get(key) != scoped_env[key]:
                continue  # Intentional user changes remain kernel-local.
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def _system_exit_outcome(exc: SystemExit) -> tuple[int, str | None]:
    """Map SystemExit the way the CPython interpreter does at process exit:
    None -> 0, an int -> its low 8 bits, anything else -> printed to stderr, 1."""
    code = exc.code
    if code is None:
        return 0, None
    if isinstance(code, int):
        return code & 0xFF, None
    return 1, str(code)


def _drop_runner_frames(report: traceback.TracebackException) -> None:
    """Hide the runner's own frames (cell execution, import hooks) so a cell's
    traceback reads like the same code run by a plain interpreter. A traceback
    made only of runner frames is a runner bug and keeps them."""
    pending = [report]
    seen: set[int] = set()
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        user_frames = [frame for frame in current.stack if frame.filename != __file__]
        if user_frames:
            current.stack = traceback.StackSummary.from_list(user_frames)
        pending.extend(chained for chained in (current.__cause__, current.__context__) if chained is not None)
        pending.extend(getattr(current, "exceptions", None) or ())


def _emit_error(rid: str, exc: BaseException) -> None:
    _sync_before_frame(rid)
    if isinstance(exc, SyntaxError) and exc.filename == "<cell>":
        tb_lines = traceback.format_exception_only(type(exc), exc)
    else:
        report = traceback.TracebackException(type(exc), exc, exc.__traceback__, compact=True)
        _drop_runner_frames(report)
        tb_lines = list(report.format())
    _emit(
        {
            "type": "error",
            "id": rid,
            "ename": type(exc).__name__,
            "evalue": str(exc),
            "traceback": [line.rstrip("\n") for line in tb_lines],
        }
    )


def _request_size(req: dict) -> int:
    return len(json.dumps(req, ensure_ascii=False, default=_json_default).encode("utf-8"))


def _read_stdin(loop: asyncio.AbstractEventLoop, queue: _BoundedRequestQueue, stdin) -> None:
    for raw_line in stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            _emit(
                {
                    "type": "error",
                    "id": "",
                    "ename": "ProtocolError",
                    "evalue": f"Invalid JSON request: {exc}",
                    "traceback": [],
                }
            )
            continue
        # Control input must bypass the asyncio execution queue: synchronous
        # user code can be blocked inside readline() or a bridged tool call.
        if req.get("type") == "stdin":
            target = _PROGRAM_INPUTS.get(str(req.get("id")))
            if target is not None:
                target.feed(req)
            continue
        if req.get("type") == "tool_response":
            with _BRIDGE_LOCK:
                pending = _BRIDGE_REPLIES.get(str(req.get("requestId")))
                if pending is not None:
                    pending[1].append(req.get("reply") or {})
                    pending[0].set()
            continue
        try:
            size = _request_size(req)
        except (TypeError, ValueError):
            size = _REQUEST_QUEUE_MAX_BYTES + 1
        if not queue.reserve(size):
            loop.call_soon_threadsafe(_emit_queue_limit_error, req)
            continue
        loop.call_soon_threadsafe(queue.put_reserved, req, size)
    for target in list(_PROGRAM_INPUTS.values()):
        target.close()
    with _BRIDGE_LOCK:
        for event, replies in _BRIDGE_REPLIES.values():
            replies.append({"ok": False, "error": {"message": "Host transport closed"}})
            event.set()
    if _REMOTE_TARGET and os.getpgrp() == os.getpid():
        # The pipe is the capability lifetime. A vanished parent cannot reap a remote tree.
        os.killpg(os.getpid(), signal.SIGKILL)
    loop.call_soon_threadsafe(_enqueue_exit, queue)


def _emit_queue_limit_error(req: dict) -> None:
    _emit_error(str(req.get("id", "")), ValueError(
        f"Request queue limit exceeded (max {_REQUEST_QUEUE_MAX_COUNT} queued requests "
        f"and {_REQUEST_QUEUE_MAX_BYTES} bytes)"
    ))


def _enqueue_exit(queue: _BoundedRequestQueue) -> None:
    request = {"type": "exit"}
    if not queue.put_nowait(request, _request_size(request)):
        asyncio.create_task(queue._queue.put((request, _request_size(request))))


def _emit_cancelled_request(req: dict) -> None:
    rid = str(req.get("id"))
    _STATE.execution_count += 1
    _emit(
        {
            "type": "done",
            "id": rid,
            "status": "error",
            "executionCount": _STATE.execution_count,
            "cancelled": True,
        }
    )


async def _execution_worker(queue: _BoundedRequestQueue) -> None:
    """Run user requests one at a time in stdin arrival order."""
    tasks = _STATE.request_tasks
    while True:
        req, _size = await queue.get()
        rid = str(req.get("id"))
        if rid in _STATE.cancelled_request_ids:
            _emit_cancelled_request(req)
            _STATE.pending_request_ids.discard(rid)
            _STATE.cancelled_request_ids.discard(rid)
            queue.task_done()
            continue
        current = asyncio.current_task()
        if current is None:
            raise RuntimeError("Python execution worker has no asyncio task")
        tasks.add(current)
        _STATE.active_request_id = rid
        try:
            if rid in _STATE.cancelled_request_ids:
                _emit_cancelled_request(req)
            else:
                await _handle_request_async(req)
        except asyncio.CancelledError:
            raise
        except BaseException as exc:
            _emit_error("", exc)
        finally:
            _STATE.active_request_id = None
            _STATE.pending_request_ids.discard(rid)
            _STATE.cancelled_request_ids.discard(rid)
            tasks.discard(current)
            queue.task_done()


async def _main_async() -> None:
    sys.stdout = _StreamProxy("stdout")
    sys.stderr = _StreamProxy("stderr")
    _install_idle_sigint()
    _install_runner_audit()
    _install_import_freshness()
    _start_parent_watchdog()

    stdin = sys.__stdin__
    if stdin is None:
        return

    loop = asyncio.get_running_loop()
    _STATE.loop = loop
    queue = _BoundedRequestQueue()
    execution_queue = _BoundedRequestQueue()
    reader = threading.Thread(
        target=_read_stdin,
        args=(loop, queue, stdin),
        name="proto-stdin-reader",
        daemon=True,
    )
    reader.start()
    execution_worker = asyncio.create_task(_execution_worker(execution_queue))

    try:
        while True:
            req, size = await queue.get()
            if req.get("type") == "exit":
                break
            if req.get("type") == "cancel":
                rid = str(req.get("id", ""))
                if rid not in _STATE.pending_request_ids:
                    continue
                _STATE.cancelled_request_ids.add(rid)
                if _STATE.active_request_id == rid and _STATE.active_executions > 0:
                    for task in list(_STATE.request_tasks):
                        if not task.done():
                            task.cancel()
                continue
            if req.get("type") == "status":
                _emit(
                    {
                        "type": "done",
                        "id": str(req.get("id", "")),
                        "status": "ok",
                        "executionCount": _STATE.execution_count,
                        "busy": len(_STATE.request_tasks) + execution_queue.qsize(),
                        "interpreter": sys.executable,
                    }
                )
                continue
            rid = str(req.get("id"))
            if rid in _STATE.cancelled_request_ids:
                _emit_cancelled_request(req)
                continue
            if not execution_queue.put_nowait(req, size):
                _emit_error(rid, ValueError(
                    f"Execution queue limit exceeded (max {_REQUEST_QUEUE_MAX_COUNT} queued requests "
                    f"and {_REQUEST_QUEUE_MAX_BYTES} bytes)"
                ))
                continue
            _STATE.pending_request_ids.add(rid)
    finally:
        _STATE.shutting_down = True
        execution_worker.cancel()
        await asyncio.gather(execution_worker, return_exceptions=True)

def main() -> None:
    asyncio.run(_main_async())


if __name__ == "__main__":
    main()
