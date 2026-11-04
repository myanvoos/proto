"""PROTO Python runner — subprocess wrapper used by the coding-agent host.

NDJSON protocol over stdin/stdout. Host writes one JSON object per line;
wrapper writes typed frames back.

Host -> wrapper:
  {"id": str, "code": str}
  {"id": str, "code": str, "cwd": str?, "env": dict?}
  # Code requests may include invocation: {"argv": [str, ...], "filename": str?}
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
The control reader owns a private descriptor; fd 0 is a bounded native input pipe.
Ordinary code executes on the main thread outside any host event loop. Coroutine
cells and explicitly retained work use a persistent loop, also on the main thread.
Cell completion drains owned asyncio tasks; retain_task() transfers live tasks
to kernel lifetime. asyncio.run() remains entirely native. Threads and executors
are runtime-lifetime resources: explicit join/shutdown/context managers keep
native meaning. atexit and interpreter/thread finalization run only when the
kernel shuts down, not at cell completion.

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
from collections import deque
import contextvars
import importlib
import importlib.machinery
import inspect
import io
import itertools
import json
import locale
import math
import os
import select
import signal
import sys
import threading
import time
import traceback
import types
import weakref
from typing import Any, Callable


# Lazy in-memory package loader: source/compiled/remote runners carry identical assets.
_PYTHON_PACKAGE_ASSETS = None


class _RuntimePackageFinder:
    def find_spec(self, fullname, path=None, target=None):
        if not (fullname == "proto_harness" or fullname.startswith("proto_harness.")):
            return None
        assets = _PYTHON_PACKAGE_ASSETS
        if assets is None:
            return None
        name = fullname.replace(".", "/")
        package = name + "/__init__.py"
        filename = package if package in assets else name + ".py"
        if filename not in assets:
            return None
        return importlib.machinery.ModuleSpec(fullname, self, is_package=filename == package)

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        name = module.__name__.replace(".", "/")
        filename = name + ("/__init__.py" if hasattr(module, "__path__") else ".py")
        module.__file__ = "<proto-runtime>/" + filename
        exec(compile(_PYTHON_PACKAGE_ASSETS[filename], module.__file__, "exec"), module.__dict__)


if _PYTHON_PACKAGE_ASSETS is not None:
    sys.meta_path.append(_RuntimePackageFinder())



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


def _emit_kernel_note(note: str, *, level: str = "note") -> None:
    """Model-visible harness receipts are sideband, never program bytes."""
    if _current_run_id() is not None:
        _emit_status("note", text=f"<kernel> {level}: {note}\n")


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
        rid = _current_run_id()
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
        rid = _current_run_id()
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
        rid = _current_run_id()
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
        rid = _current_run_id()
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



_STDIN_ENCODING = getattr(sys.__stdin__, "encoding", None) or "utf-8"
_STDIN_ERRORS = getattr(sys.__stdin__, "errors", None) or "strict"


def _open_program_stdin():
    raw = io.FileIO(0, "rb", closefd=False)
    raw.name = "<stdin>"
    return io.TextIOWrapper(io.BufferedReader(raw), encoding=_STDIN_ENCODING, errors=_STDIN_ERRORS)


class _ProgramInput:
    """A native pipe on fd 0, fed with at most one outstanding 64 KiB credit.

    The feeder must not run on the control-reader thread: a child can leave
    stdin unread while the cell waits for a bridge reply or cancellation.
    """

    def __init__(self, rid: str, enabled: bool) -> None:
        self.rid = rid
        self._condition = threading.Condition()
        self._data: bytes | None = None
        self._eof = not enabled
        self._requested = False
        self._closed = False
        self.error: str | None = None
        read_fd, self._write_fd = os.pipe()
        try:
            os.dup2(read_fd, 0)
        finally:
            if read_fd != 0:
                os.close(read_fd)
        os.set_blocking(self._write_fd, False)
        self.stream = _open_program_stdin()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._eof:
            os.close(self._write_fd)
            return
        self._thread = threading.Thread(target=self._pump, name="proto-program-input", daemon=True)
        self._thread.start()

    def _pump(self) -> None:
        try:
            while True:
                with self._condition:
                    if self._closed:
                        return
                    self._requested = True
                    _emit({"type": "stdin_request", "id": self.rid})
                    while self._data is None and not self._eof and not self._closed:
                        self._condition.wait()
                    if self._closed:
                        return
                    data = self._data or b""
                    self._data = None
                    eof = self._eof
                offset = 0
                while offset < len(data):
                    if self._closed:
                        return
                    if not select.select([], [self._write_fd], [], 0.05)[1]:
                        continue
                    try:
                        offset += os.write(self._write_fd, data[offset:])
                    except BlockingIOError:
                        continue
                if eof:
                    return
        except (BrokenPipeError, OSError):
            # The program may close stdin or finish without consuming it.
            pass
        finally:
            os.close(self._write_fd)

    def feed(self, frame: dict) -> None:
        with self._condition:
            if self._closed:
                return
            try:
                encoded = frame.get("data", "")
                if not self._requested or not isinstance(encoded, str) or len(encoded) > 87384:
                    raise ValueError("Invalid stdin credit")
                data = base64.b64decode(encoded, validate=True)
                if len(data) > 65536 or self._data is not None or (not data and not frame.get("eof")):
                    raise ValueError("Invalid stdin chunk")
                self._data = data
                self._eof = bool(frame.get("eof"))
                self._requested = False
            except (ValueError, TypeError) as error:
                self.error = str(error)
                self._eof = True
            self._condition.notify_all()

    def close(self) -> None:
        with self._condition:
            self._closed = True
            self._condition.notify_all()
        if self._thread is not None:
            self._thread.join()
        self.stream.close()

_PROGRAM_INPUTS: dict[str, _ProgramInput] = {}
_BRIDGE_REPLIES: dict[str, tuple[threading.Event, list[dict]]] = {}
_BRIDGE_LOCK = threading.Lock()


def __proto_bridge_call__(name: str, args: dict):
    rid = _current_run_id()
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
               "payload": {"name": name, "args": args, "cwd": os.getcwd()}})
        while not event.wait(0.1):
            helper = sys.modules.get("proto_harness.helpers")
            if helper is not None:
                helper.task_signal().check()
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
        self.user_module = types.ModuleType("__main__")
        self.user_ns = self.user_module.__dict__
        self.filename = "<string>"
        self.loop: asyncio.AbstractEventLoop | None = None
        self.shutting_down: bool = False
        self.active_executions: int = 0
        self.defs: dict[str, int] = {}
        self.request_tasks: set[asyncio.Task] = set()
        self.cell_tasks: dict[asyncio.Task, str] = {}
        self.thread_owners: weakref.WeakKeyDictionary[threading.Thread, str] = weakref.WeakKeyDictionary()
        self.retained: weakref.WeakSet = weakref.WeakSet()
        self.work_changed = asyncio.Event()
        self.pending_request_ids: set[str] = set()
        self.cancelled_request_ids: set[str] = set()
        self.active_request_id: str | None = None
        # The sys.path entries the current cell's cwd and PYTHONPATH put first.
        self.import_path_prefix: list[str] = []


_REQUEST_QUEUE_MAX_COUNT = 128
_REQUEST_QUEUE_MAX_BYTES = 16 * 1024 * 1024
_STATE_REQUEST_MAX_BYTES = 96 * 1024 * 1024


class _BoundedRequestQueue:
    """Thread-safe FIFO with bounded count/bytes and an asyncio wakeup.

    Admission never blocks the control reader: input, bridge responses and
    cancellation must still get through when the execution queue is full.
    """

    def __init__(self) -> None:
        self._queue: deque[tuple[dict, int]] = deque()
        self._bytes = 0
        self._lock = threading.Lock()
        self._ready = asyncio.Event()
        self._closed = False

    def _wake(self) -> None:
        loop = _STATE.loop
        if loop is not None and not loop.is_closed():
            loop.call_soon_threadsafe(self._ready.set)

    def put_nowait(self, request: dict, size: int) -> bool:
        with self._lock:
            limit = _STATE_REQUEST_MAX_BYTES if request.get("type") == "state" else _REQUEST_QUEUE_MAX_BYTES
            if (self._closed or len(self._queue) >= _REQUEST_QUEUE_MAX_COUNT
                    or self._bytes + size > limit):
                return False
            self._queue.append((request, size))
            self._bytes += size
        self._wake()
        return True

    async def get(self) -> tuple[dict, int]:
        while True:
            with self._lock:
                if self._closed:
                    return {"type": "exit"}, 0
                if self._queue:
                    request, size = self._queue.popleft()
                    self._bytes -= size
                    return request, size
                self._ready.clear()
            await self._ready.wait()

    def close(self) -> None:
        with self._lock:
            self._closed = True
        self._wake()

_CURRENT_RID: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "proto_current_rid", default=None
)
_CURRENT_COMPLETION_INVOCATIONS = contextvars.ContextVar("proto_completion_invocations", default=None)
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


def _audit_runner_event(event: str, args: tuple) -> None:
    if event in _CHILD_SPAWN_AUDIT_EVENTS:
        capture = _CAPTURE_STATE
        if capture is not None:
            capture.child_started = True


def _install_runner_audit() -> None:
    sys.addaudithook(_audit_runner_event)


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


def _emit_status(op: str, **data: Any) -> None:
    bundle = {"application/x-proto-status": {"op": op, **data}}
    rid = _current_run_id()
    if rid is None:
        return
    _sync_before_frame(rid)
    _emit({"type": "display", "id": rid, "bundle": bundle})


def _mime_bundle(value: Any) -> dict:
    from proto_harness._display import _mime_bundle as convert, _is_matplotlib_figure
    bundle = convert(value)
    if "image/png" in bundle and _is_matplotlib_figure(value):
        displayed = _CURRENT_DISPLAYED_MATPLOTLIB_FIGURE_IDS.get()
        if displayed is not None:
            displayed.add(id(value))
    return bundle


def _safe_display_json(value: Any) -> Any:
    from proto_harness._display import _safe_display_json as convert
    return convert(value)


def _emit_display(bundle: dict, *, kind: str = "display") -> None:
    rid = _current_run_id()
    if rid is None:
        return
    _sync_before_frame(rid)
    if "application/json" in bundle:
        bundle = {**bundle, "application/json": _safe_display_json(bundle["application/json"])}
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
    for name in sorted(name for name in _STATE.user_ns if type(name) is str):
        value = _STATE.user_ns[name]
        if name.startswith("__"):
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
    live_tasks = asyncio.all_tasks(_STATE.loop) if _STATE.loop is not None else set()
    tasks = []
    for task in sorted(live_tasks, key=id)[:limit]:
        request = task in _STATE.request_tasks
        tasks.append({"id": str(id(task)), "kind": "cell" if request else "asyncio",
                      "state": "running", "cell": _STATE.execution_count if request else None})
    return {"generation": _KERNEL_GENERATION, "target": json.loads(json.dumps(_KERNEL_TARGET)), "language": "python", "interpreter": sys.executable,
            "cwd": os.getcwd(), "executionCount": _STATE.execution_count,
            "active": _STATE.active_executions,
            "queued": max(0, len(_STATE.pending_request_ids) - bool(_STATE.active_request_id)),
            "variables": variables, "totalVariables": total,
            "tasks": tasks, "totalTasks": len(live_tasks), "taskScope": "asyncio"}


def __proto_defs_view() -> dict[str, int]:
    return dict(_STATE.defs)


def _declared_state_request(req):
    # A boundary must reject before teardown, even when the resource is not named.
    if any(not task.done() for task in _STATE.retained):
        raise ValueError("Python namespace cannot cross a boundary with retained resources/tasks")
    if any(thread.is_alive() for thread in list(_STATE.thread_owners)):
        raise ValueError("Python namespace cannot cross a boundary with live user threads/resources")
    from proto_harness import _serialization
    if req.get("action") == "capture":
        plumbing = {"__builtins__": vars(builtins)}
        for name, value in plumbing.items():
            if name in _STATE.user_ns and _STATE.user_ns[name] is not value:
                raise ValueError("Python namespace overrides reserved runtime binding: " + name)
        values = {name: value for name, value in _STATE.user_ns.items() if name not in plumbing}
        return _serialization.dumps(values, namespace=_STATE.user_ns)
    if req.get("action") != "restore":
        raise ValueError("Invalid Python namespace state operation")
    # Deserialize completely before touching live computation; function globals and
    # the restored module dictionary are the very same memoized graph object.
    snapshot = req.get("snapshot")
    if isinstance(snapshot, dict) and snapshot.get("format") != "proto.python-graph":
        raise ValueError("Unsupported Python namespace checkpoint codec; explicitly reset or close this named Python kernel to discard its old namespace. History and JavaScript state remain readable.")
    module = _serialization.loads_namespace(snapshot)
    _STATE.user_module = module
    _STATE.user_ns = module.__dict__
    sys.modules["__main__"] = module
    _install_builtins(_STATE.user_ns)
    _STATE.defs = {name: _STATE.execution_count for name in _STATE.user_ns}
    return None


def _current_run_id() -> str | None:
    return _CURRENT_RID.get() or _STATE.thread_owners.get(threading.current_thread())


def __proto_retain_task(task):
    """Transfer a live top-level-await task from cell to kernel lifetime.

    Tasks owned by asyncio.run retain that loop's native shutdown semantics.
    Threads/executors already have runtime lifetime; use their native join,
    shutdown or context-manager APIs when a cell needs to wait for them.
    """
    if not isinstance(task, asyncio.Task):
        raise TypeError("retain_task expects an asyncio.Task")
    if task.get_loop() is not _STATE.loop or task.done():
        raise ValueError("retain_task requires a live task on the kernel's top-level-await loop")
    _STATE.retained.add(task)
    _STATE.work_changed.set()
    return task

def _create_user_task(loop, coro, **kwargs):
    task = asyncio.Task(coro, loop=loop, **kwargs)
    context = kwargs.get("context")
    rid = context.get(_CURRENT_RID) if context is not None else _current_run_id()
    if rid is not None:
        _STATE.cell_tasks[task] = rid
        if asyncio.current_task(loop) in _STATE.retained:
            _STATE.retained.add(task)
        task.add_done_callback(_task_finished)
    return task


def _retire_cell_task(task: asyncio.Task, *, observed: BaseException | None = None) -> None:
    """Retrieve terminal outcomes before dropping ownership, preserving native diagnostics.

    Awaited failures have already cleared asyncio's unobserved flag. A child
    SystemExit/KeyboardInterrupt that escaped run_until_complete is also observed
    by the owning request, but asyncio has not retrieved that task's exception.
    Other unobserved failures must still be reported, exactly once in this cell.
    """
    _STATE.cell_tasks.pop(task, None)
    if task.cancelled():
        return
    unobserved = getattr(task, "_log_traceback", False)
    error = task.exception()
    if unobserved and error is not None and error is not observed:
        task.get_loop().call_exception_handler({
            "message": "Task exception was never retrieved",
            "exception": error,
            "future": task,
        })


def _task_finished(task: asyncio.Task) -> None:
    if task in _STATE.retained or _STATE.cell_tasks.get(task) != _STATE.active_request_id:
        _STATE.cell_tasks.pop(task, None)
    _STATE.work_changed.set()


_THREAD_START = threading.Thread.start


def _start_user_thread(thread, *args, **kwargs):
    rid = _current_run_id()
    added = rid is not None and thread not in _STATE.thread_owners
    if added:
        _STATE.thread_owners[thread] = rid
    try:
        return _THREAD_START(thread, *args, **kwargs)
    except BaseException:
        if added:
            _STATE.thread_owners.pop(thread, None)
        raise


def _next_completion_invocation() -> str:
    invocations = _CURRENT_COMPLETION_INVOCATIONS.get()
    if invocations is None:
        raise RuntimeError("completion requires a kernel execution context")
    return str(next(invocations))


def _runner_exports() -> dict[str, Any]:
    return {
        "display": __proto_display,
        "defs": __proto_defs_view,
        "kernel_state": __proto_kernel_state,
        "retain_task": __proto_retain_task,
        "next_completion_invocation": _next_completion_invocation,
    }


def _install_builtins(ns: dict) -> None:
    """Keep Python's native builtins without harness globals."""
    ns["__builtins__"] = vars(builtins)


def _bind_runtime() -> None:
    """Bind runtime-local APIs to the explicit package, never user globals."""
    import proto_harness._client as client
    client._runtime = _runner_exports()
    if os.environ.get("PI_KERNEL_STDIO_BRIDGE") == "1":
        client._transport = __proto_bridge_call__
    _install_builtins(_STATE.user_ns)


_TLA_FLAG = getattr(ast, "PyCF_ALLOW_TOP_LEVEL_AWAIT", 0x2000)


async def _await_user(coro):
    # Task._step re-raises SystemExit/KeyboardInterrupt into the event loop.
    # Keep them as user outcomes, so neither can tear down the host loop.
    try:
        return True, await coro
    except BaseException as exc:
        return False, exc


def _await_sync(coro) -> Any:
    loop = _STATE.loop
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        pass
    else:
        coro.close()
        raise RuntimeError("top-level await is not supported from synchronous magic execution")
    if loop is None:
        return asyncio.run(coro)
    task = loop.create_task(_await_user(coro))
    _STATE.request_tasks.add(task)
    try:
        ok, value = loop.run_until_complete(task)
    except BaseException as exc:
        # SIGINT or SystemExit raised by a child task/callback can escape
        # Task._step. Retrieve the already-observed child failure before its
        # traceback cycle is collected under a later cell's output capture.
        for child in _owned_tasks(_current_run_id()):
            if child.done():
                _retire_cell_task(child, observed=exc)
        # Settle the suspended request before admitting a new cell.
        task.cancel()
        loop.run_until_complete(task)
        raise
    finally:
        _STATE.request_tasks.discard(task)
        _STATE.cell_tasks.pop(task, None)
    if not ok:
        raise value
    return value


async def _evaluate_cell_parts(statements, expression, ns: dict) -> None:
    value = eval(statements, ns)
    if statements.co_flags & inspect.CO_COROUTINE:
        await value
    if expression is not None:
        value = eval(expression, ns)
        if expression.co_flags & inspect.CO_COROUTINE:
            value = await value
        if value is not None:
            __proto_display(value, kind="result")


def _compile_source(source: str):
    module = ast.parse(source, _STATE.filename, "exec")
    expression = None
    if module.body and isinstance(module.body[-1], ast.Expr):
        expression = ast.Expression(module.body.pop().value)
    # Compile both parts before mutating user state. No injected function names,
    # altered expressions, or implicit globals are needed for a warm final value.
    statement_code = compile(module, _STATE.filename, "exec", flags=_TLA_FLAG, dont_inherit=True)
    expression_code = None if expression is None else compile(expression, _STATE.filename, "eval", flags=_TLA_FLAG, dont_inherit=True)
    return statement_code, expression_code


def _exec_source(source: str, ns: dict) -> None:
    statements, expression = _compile_source(source)
    flags = statements.co_flags | (expression.co_flags if expression is not None else 0)
    if flags & inspect.CO_COROUTINE:
        # One await scope for the whole cell, including synchronous statements
        # before a final await; child task ordering stays native and deterministic.
        _await_sync(_evaluate_cell_parts(statements, expression, ns))
        return
    eval(statements, ns)
    if expression is not None:
        value = eval(expression, ns)
        if value is not None:
            __proto_display(value, kind="result")


def _owned_tasks(rid: str) -> list[asyncio.Task]:
    return [task for task, owner in list(_STATE.cell_tasks.items())
            if owner == rid and task not in _STATE.retained and task not in _STATE.request_tasks]




def _drain_cell_work(rid: str, *, cancel: bool = False) -> None:
    """Settle owned asyncio work, including work it starts while settling.

    This is not interpreter teardown: native threads/executors, atexit and
    module finalizers keep process lifetime and are never shut down per cell.
    Retire terminal outcomes while this cell still owns output: awaited errors
    stay handled, and unobserved failures retain asyncio's native diagnostics.
    """
    while True:
        tasks = _owned_tasks(rid)
        for task in tasks:
            if task.done():
                _retire_cell_task(task)
        pending = [task for task in tasks if not task.done()]
        if not pending:
            return
        _STATE.work_changed.clear()
        if cancel:
            for task in pending:
                task.cancel()
        # Completion and retain_task both wake the waiter. A task can transfer
        # ownership while the cell is settling without stranding its old cell.
        _await_sync(_STATE.work_changed.wait())

def _install_idle_sigint() -> None:
    try:
        signal.signal(signal.SIGINT, signal.SIG_IGN)
    except (OSError, ValueError):
        pass


def _exec_sigint_handler(_signum: int, frame: Any) -> None:
    """Deliver SIGINT on the main thread, without raising inside loop I/O."""
    loop = _STATE.loop
    if loop is None or not loop.is_running() or asyncio.current_task(loop) is not None:
        raise KeyboardInterrupt
    while frame is not None:
        if frame.f_globals is _STATE.user_ns:
            raise KeyboardInterrupt
        frame = frame.f_back
    for task in list(_STATE.request_tasks):
        if not task.done():
            task.cancel()
    loop.call_soon_threadsafe(_noop)

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
    "PI_PYTHON_HARNESS_URL",
    "PI_PYTHON_HARNESS_TOKEN",
)


def _apply_request_runtime(req: dict) -> None:
    invocation = req.get("invocation") or {"argv": ["-c"]}
    argv = invocation.get("argv")
    if not isinstance(argv, list) or not argv or not all(isinstance(arg, str) for arg in argv):
        raise ValueError("invocation.argv must be a nonempty string list")
    filename = invocation.get("filename")
    if filename is not None and not isinstance(filename, str):
        raise ValueError("invocation.filename must be a string")
    sys.argv = list(argv)
    stdin_code = argv[0] in ("", "-") and filename in (None, "<stdin>")
    _STATE.filename = filename or ("<stdin>" if stdin_code else "<string>")
    ns = _STATE.user_ns
    ns.update({"__name__": "__main__", "__package__": None, "__spec__": None})
    if filename is None or stdin_code:
        if stdin_code:
            ns["__file__"] = "<stdin>"
            ns["__cached__"] = None
        else:
            ns.pop("__file__", None)
            ns.pop("__cached__", None)
        ns["__loader__"] = importlib.machinery.BuiltinImporter
    else:
        ns["__file__"] = filename
        ns["__cached__"] = None
        ns["__loader__"] = importlib.machinery.SourceFileLoader("__main__", filename)
    sys.modules["__main__"] = _STATE.user_module
    cwd = req.get("cwd")
    if isinstance(cwd, str) and cwd:
        os.chdir(cwd)
    _set_import_path_prefix(os.path.dirname(os.path.abspath(filename)) if filename and not stdin_code else os.getcwd())

    env = req.get("env")
    if isinstance(env, dict):
        for key in _MANAGED_ENV_KEYS:
            value = env.get(key)
            if isinstance(value, str):
                os.environ[key] = value
            elif value is None:
                os.environ.pop(key, None)



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


def _track_cell_defs(source: str, execution_count: int) -> None:
    for name in tuple(_STATE.defs):
        if name not in _STATE.user_ns:
            del _STATE.defs[name]
    definitions, bindings = _cell_bound_names(source)
    for name in (*definitions, *bindings):
        if name in _STATE.user_ns:
            _STATE.defs[name] = execution_count


def _handle_request(req: dict) -> dict:
    rid = str(req.get("id"))
    token = _CURRENT_RID.set(rid)
    completion_token = _CURRENT_COMPLETION_INVOCATIONS.set(itertools.count())
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
    saved_stdin, saved_dunder_stdin = sys.stdin, sys.__stdin__
    program_input = _ProgramInput(rid, req.get("stdin") is True)
    _PROGRAM_INPUTS[rid] = program_input
    sys.stdin = sys.__stdin__ = program_input.stream
    program_input.start()
    capture = _begin_fd_capture(rid)
    _STATE.cancel_requested = False
    _STATE.execution_count += 1
    execution_count = _STATE.execution_count
    bindings_before = dict(_STATE.user_ns)

    status: str = "ok"
    cancelled = False
    exit_code: int | None = None

    try:
        try:
            _apply_request_runtime(req)
            transformed = req.get("code", "")
            if not isinstance(transformed, str):
                raise TypeError("code must be a string")
        except asyncio.CancelledError:
            raise
        except BaseException as exc:
            _emit_error(rid, exc)
            return {
                "type": "done", "id": rid, "status": "error",
                "executionCount": execution_count, "cancelled": False,
            }

        if rid in _STATE.cancelled_request_ids:
            return {
                "type": "done", "id": rid, "status": "error",
                "executionCount": execution_count, "cancelled": True,
            }

        _begin_exec_sigint()
        try:
            _emit({"type": "started", "id": rid})
            _emit_status("kernel-state", generation=_KERNEL_GENERATION, language="python", executionCount=execution_count)
            _exec_source(transformed, _STATE.user_ns)
            _drain_cell_work(rid)
            if program_input.error:
                raise OSError(program_input.error)
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
            try:
                _drain_cell_work(rid, cancel=status != "ok" or exit_code is not None)
            except BaseException as exc:
                status = "error"
                cancelled = cancelled or isinstance(exc, (KeyboardInterrupt, asyncio.CancelledError))
                _emit_error(rid, exc)
                # A second interrupt must not make still-running work look
                # completed. The host escalates if cleanup cannot settle.
                _drain_cell_work(rid, cancel=True)
            _end_exec_sigint()
            try:
                _flush_matplotlib_figures()
            except Exception:
                pass

        try:
            for name, value in _STATE.user_ns.items():
                if type(name) is str and not name.startswith("__") and (name not in bindings_before or bindings_before[name] is not value):
                    _STATE.defs[name] = execution_count
            _track_cell_defs(transformed, execution_count)
            _flush_stream_proxies(rid)
        except BaseException as exc:
            status = "error"
            _emit_error(rid, exc)
        if rid in _STATE.cancelled_request_ids:
            cancelled = True
            status = "error"
        done: dict = {
            "type": "done",
            "id": rid,
            "status": status,
            "executionCount": execution_count,
            "cancelled": cancelled,
        }
        if exit_code is not None and not cancelled:
            done["exitCode"] = exit_code
        return done
    finally:
        _flush_stream_proxies(rid)
        _sync_fd_capture(capture)
        _end_fd_capture()
        _flush_stream_proxies(rid)
        _CURRENT_RID.reset(token)
        _CURRENT_COMPLETION_INVOCATIONS.reset(completion_token)
        _CURRENT_DISPLAYED_MATPLOTLIB_FIGURE_IDS.reset(displayed_matplotlib_token)
        _SAVED_MATPLOTLIB_FIGURES.reset(saved_matplotlib_token)
        _CLOSED_MATPLOTLIB_FIGURES.reset(closed_matplotlib_token)
        sys.stdin, sys.__stdin__ = saved_stdin, saved_dunder_stdin
        _PROGRAM_INPUTS.pop(rid, None)
        program_input.close()
        null_fd = os.open(os.devnull, os.O_RDONLY)
        try:
            os.dup2(null_fd, 0)
        finally:
            if null_fd != 0:
                os.close(null_fd)
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
    if isinstance(exc, SyntaxError) and exc.filename == _STATE.filename:
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


def _cancel_request(rid: str) -> None:
    if rid not in _STATE.pending_request_ids:
        return
    _STATE.cancelled_request_ids.add(rid)
    if _STATE.active_request_id == rid and _STATE.active_executions:
        os.kill(os.getpid(), signal.SIGINT)


def _read_control(queue: _BoundedRequestQueue, control) -> None:
    for raw_line in control:
        line = raw_line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            _emit({"type": "error", "id": "", "ename": "ProtocolError",
                   "evalue": f"Invalid JSON request: {exc}", "traceback": []})
            continue
        kind = req.get("type")
        # This thread remains responsive while main-thread code blocks in
        # stdin, a native call, or a bridge request. It never runs user code.
        if kind == "stdin":
            target = _PROGRAM_INPUTS.get(str(req.get("id")))
            if target is not None:
                target.feed(req)
            continue
        if kind == "tool_response":
            with _BRIDGE_LOCK:
                pending = _BRIDGE_REPLIES.get(str(req.get("requestId")))
                if pending is not None:
                    pending[1].append(req.get("reply") or {})
                    pending[0].set()
            continue
        if kind == "cancel":
            _cancel_request(str(req.get("id", "")))
            continue
        if kind == "status":
            _emit({"type": "done", "id": str(req.get("id", "")), "status": "ok",
                   "executionCount": _STATE.execution_count,
                   "busy": len(_STATE.pending_request_ids), "interpreter": sys.executable})
            continue
        if kind == "exit":
            queue.close()
            return
        try:
            size = _request_size(req)
        except (TypeError, ValueError):
            size = _REQUEST_QUEUE_MAX_BYTES + 1
        rid = str(req.get("id"))
        _STATE.pending_request_ids.add(rid)
        if not queue.put_nowait(req, size):
            _STATE.pending_request_ids.discard(rid)
            _emit_queue_limit_error(req)
    for target in list(_PROGRAM_INPUTS.values()):
        target.close()
    with _BRIDGE_LOCK:
        for event, replies in _BRIDGE_REPLIES.values():
            replies.append({"ok": False, "error": {"message": "Host transport closed"}})
            event.set()
    if _REMOTE_TARGET and os.getpgrp() == os.getpid():
        # Only unexpected transport loss revokes the remote process tree.
        # An explicit exit request above still runs native shutdown hooks.
        os.killpg(os.getpid(), signal.SIGKILL)
    queue.close()

def _emit_queue_limit_error(req: dict) -> None:
    if req.get("type") == "state":
        _emit({"type": "state", "id": str(req.get("id", "")),
               "stateError": "Python graph state queue limit exceeded"})
        return
    _emit_error(str(req.get("id", "")), ValueError(
        f"Request queue limit exceeded (max {_REQUEST_QUEUE_MAX_COUNT} queued requests "
        f"and {_REQUEST_QUEUE_MAX_BYTES} bytes)"
    ))




def _cancelled_request_result(req: dict) -> dict:
    _STATE.execution_count += 1
    return {
        "type": "done", "id": str(req.get("id")), "status": "error",
        "executionCount": _STATE.execution_count, "cancelled": True,
    }

async def _shutdown_loop(loop: asyncio.AbstractEventLoop) -> None:
    tasks = asyncio.all_tasks(loop) - {asyncio.current_task(loop)}
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    await loop.shutdown_asyncgens()
    await loop.shutdown_default_executor()


def main() -> None:
    # fd 0 belongs exclusively to program input. The transport is a private,
    # non-inheritable descriptor and cannot be consumed by subprocesses.
    control = os.fdopen(os.dup(0), "r", encoding="utf-8")
    null_fd = os.open(os.devnull, os.O_RDONLY)
    try:
        os.dup2(null_fd, 0)
    finally:
        if null_fd != 0:
            os.close(null_fd)
    sys.stdin = sys.__stdin__ = _open_program_stdin()
    sys.stdout = _StreamProxy("stdout")
    sys.stderr = _StreamProxy("stderr")
    sys.modules["__main__"] = _STATE.user_module
    _install_builtins(_STATE.user_ns)
    _bind_runtime()
    _install_idle_sigint()
    _install_runner_audit()
    _start_parent_watchdog()
    threading.Thread.start = _start_user_thread

    loop = asyncio.new_event_loop()
    loop.set_task_factory(_create_user_task)
    _STATE.loop = loop
    queue = _BoundedRequestQueue()
    reader = threading.Thread(target=_read_control, args=(queue, control),
                              name="proto-control-reader", daemon=True)
    reader.start()
    try:
        while True:
            # Driving the loop while idle keeps explicitly retained work
            # live, but the dispatcher itself is never an asyncio task.
            req, _size = loop.run_until_complete(queue.get())
            if req.get("type") == "exit":
                break
            rid = str(req.get("id"))
            if req.get("type") == "state":
                try:
                    _emit({"type": "state", "id": rid, "value": _declared_state_request(req)})
                except BaseException as exc:
                    _emit({"type": "state", "id": rid, "stateError": str(exc)})
                finally:
                    _STATE.pending_request_ids.discard(rid)
                continue
            _STATE.active_request_id = rid
            try:
                if rid in _STATE.cancelled_request_ids:
                    done = _cancelled_request_result(req)
                else:
                    done = _handle_request(req)
            except BaseException as exc:
                _emit_error(rid, exc)
                done = {
                    "type": "done", "id": rid, "status": "error",
                    "executionCount": _STATE.execution_count,
                    "cancelled": isinstance(exc, (KeyboardInterrupt, asyncio.CancelledError)),
                }
            finally:
                _STATE.active_request_id = None
                _STATE.pending_request_ids.discard(rid)
                _STATE.cancelled_request_ids.discard(rid)
            # Completion is the cleanup/retirement barrier. The control reader
            # may answer status immediately after the host sees this frame.
            _emit(done)
    finally:
        _STATE.shutting_down = True
        loop.run_until_complete(_shutdown_loop(loop))
        loop.close()

if __name__ == "__main__":
    main()
