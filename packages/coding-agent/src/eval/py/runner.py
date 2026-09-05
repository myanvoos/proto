"""PROTO Python runner — subprocess wrapper used by the coding-agent host.

NDJSON protocol over stdin/stdout. Host writes one JSON object per line;
wrapper writes typed frames back.

Host -> wrapper:
  {"id": str, "code": str, "silent": bool?, "storeHistory": bool?}
  {"id": str, "code": str, "silent": bool?, "storeHistory": bool?, "cwd": str?, "env": dict?}
  {"type": "exit"}                                # graceful shutdown

Wrapper -> host:
  {"type": "started",     "id": ...}
  {"type": "stdout",      "id": ..., "data": str}
  {"type": "stderr",      "id": ..., "data": str}
  {"type": "display",     "id": ..., "bundle": {<mime>: <value>}}
  {"type": "result",      "id": ..., "bundle": {<mime>: <value>}}
  {"type": "error",       "id": ..., "ename": str, "evalue": str, "traceback": [str]}
  {"type": "done",        "id": ..., "status": "ok"|"error",
                              "executionCount": int, "cancelled": bool}

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
import inspect
import io
import json
import locale
import math
import os
import re
import runpy
import shlex
import signal
import subprocess
import sys
import threading
import time
import tokenize
import traceback
import types
from pathlib import Path
from typing import Any, Callable

# ---------------------------------------------------------------------------
# Frame writer
# ---------------------------------------------------------------------------

# Frames travel on a private dup of the original stdout. fd 1 itself is then
# repointed at a capture pipe: child processes spawned by user code without
# stdout=PIPE inherit fd 1, and their output is forwarded to the host as
# regular stdout frames by a drain thread instead of being written raw into
# the NDJSON channel (where it would be dropped as invalid JSON — or worse,
# spoof a frame). The wire protocol is unchanged: the host still reads NDJSON
# frames from the subprocess stdout.
_RAW_STDERR = sys.__stderr__
try:
    _FRAME_FD = os.dup(sys.__stdout__.fileno())
    _RAW_STDOUT = os.fdopen(_FRAME_FD, "w", encoding="utf-8", errors="backslashreplace")
    _CAPTURE_READ_FD, _capture_write_fd = os.pipe()
    os.dup2(_capture_write_fd, sys.__stdout__.fileno())
    os.close(_capture_write_fd)
except (AttributeError, OSError, ValueError, io.UnsupportedOperation):
    _RAW_STDOUT = sys.__stdout__
    _CAPTURE_READ_FD = None
_OUT_LOCK = threading.Lock()


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


# ---------------------------------------------------------------------------
# User stdout/stderr proxies
# ---------------------------------------------------------------------------


class _StreamProxy(io.TextIOBase):
    """Emit cell ``write`` data as typed frames tied to the current request.

    Writes are coalesced per request: a frame is emitted once the buffer holds
    a complete line (everything up to the last newline goes out together) or
    grows past ``_MAX_BUFFER`` bytes, so the common ``print()`` pair of
    ``write(text)`` + ``write("\\n")`` costs one frame instead of two. Partial
    lines are bounded by ``flush()`` and the end-of-request flush.
    """

    _MAX_BUFFER = 8192

    def __init__(self, kind: str) -> None:
        super().__init__()
        self._kind = kind
        self._lock = threading.Lock()
        self._buffers: dict[str, str] = {}

    def writable(self) -> bool:  # noqa: D401 - protocol method
        return True

    def isatty(self) -> bool:  # noqa: D401 - protocol method
        return False

    def write(self, data: Any) -> int:  # type: ignore[override]
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
        with self._lock:
            buf = self._buffers.pop(rid, "") + data
            if len(buf) >= self._MAX_BUFFER:
                emit_text = buf
            else:
                nl = buf.rfind("\n")
                if nl >= 0:
                    emit_text = buf[: nl + 1]
                    rest = buf[nl + 1 :]
                    if rest:
                        self._buffers[rid] = rest
                else:
                    self._buffers[rid] = buf
        if emit_text:
            _emit({"type": self._kind, "id": rid, "data": emit_text})
        return len(data)

    def flush(self) -> None:  # noqa: D401 - protocol method
        rid = _CURRENT_RID.get()
        if rid is not None:
            self.flush_rid(rid)
        return None

    def flush_rid(self, rid: str) -> None:
        """Flush any buffered partial line for ``rid`` as its own frame."""
        with self._lock:
            buf = self._buffers.pop(rid, None)
        if buf:
            _emit({"type": self._kind, "id": rid, "data": buf})


def _flush_stream_proxies(rid: str) -> None:
    """Drain buffered proxy output for ``rid`` (called before its done frame)."""
    for stream in (sys.stdout, sys.stderr):
        if isinstance(stream, _StreamProxy):
            stream.flush_rid(rid)


# ---------------------------------------------------------------------------
# Runner state
# ---------------------------------------------------------------------------


class _RunnerState:
    def __init__(self) -> None:
        self.execution_count: int = 0
        self.cancel_requested: bool = False
        # User globals — kept across requests when running in session mode.
        self.user_ns: dict[str, Any] = {
            "__name__": "__main__",
            "__doc__": None,
            "__builtins__": builtins,
        }
        self.last_install_marker: int = 0
        self.loop: asyncio.AbstractEventLoop | None = None
        self.active_executions: int = 0
        # Best-effort attribution target for captured fd-1 bytes (child
        # processes inheriting stdout). With overlapping requests the most
        # recently started one wins — strictly better than dropping the bytes.
        self.capture_rid: str | None = None
        self.defs: dict[str, int] = {}
        self.prelude_names: set[str] | None = None
        # Prelude helpers live in their own module namespace so user
        # rebindings (``json = ...``, ``output = ...``) cannot break them;
        # only the public API is exported into ``user_ns``.
        self.prelude_ns: dict[str, Any] | None = None
        self.prelude_exports: dict[str, Any] = {}
        self.shadow_warned: set[str] = set()
        # In-flight request tasks; SIGINT while parked in the event loop
        # cancels these instead of unwinding the loop itself.
        self.request_tasks: set[asyncio.Task] = set()


_CURRENT_RID: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "proto_current_rid", default=None
)
_CURRENT_DISPLAYED_MATPLOTLIB_FIGURE_IDS: contextvars.ContextVar[set[int] | None] = (
    contextvars.ContextVar(
        "proto_displayed_matplotlib_figure_ids",
        default=None,
    )
)


_STATE = _RunnerState()


def _drain_captured_stdout() -> None:
    """Forward bytes written to the captured fd 1 as stdout frames.

    Runs on a daemon thread for the life of the process. Child processes that
    inherit fd 1 (any ``subprocess`` call without ``stdout=PIPE``) land here.
    """
    if _CAPTURE_READ_FD is None:
        return
    import codecs

    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    while True:
        try:
            chunk = os.read(_CAPTURE_READ_FD, 65536)
        except OSError:
            return
        if not chunk:
            return
        text = decoder.decode(chunk)
        if not text:
            continue
        rid = _STATE.capture_rid
        if rid is None:
            _RAW_STDERR.write(text)
            _RAW_STDERR.flush()
        else:
            _emit({"type": "stdout", "id": rid, "data": text})


def _start_capture_drain() -> None:
    if _CAPTURE_READ_FD is None:
        return
    thread = threading.Thread(
        target=_drain_captured_stdout, name="proto-fd1-capture", daemon=True
    )
    thread.start()


# ---------------------------------------------------------------------------
# Cell pre-processing: verbatim embed blocks + tolerant repair ladder
# ---------------------------------------------------------------------------

_EMBED_OPEN_RE = re.compile(
    r"#@embed\s+(?P<name>[A-Za-z_][A-Za-z_0-9]*)(?:\s+until=(?P<until>\S+))?\s*$"
)
_PATCH_PREFIX = "#@patch"
_DEFAULT_EMBED_END = "#@end"


class _DirectiveBlock:
    """A source-range directive found by the shared literal-aware scanner."""

    __slots__ = ("kind", "start", "end", "indent", "name", "path", "marker")

    def __init__(
        self,
        kind: str,
        start: int,
        end: int,
        indent: str,
        *,
        name: str | None = None,
        path: str | None = None,
        marker: str = _DEFAULT_EMBED_END,
    ) -> None:
        self.kind = kind
        self.start = start
        self.end = end
        self.indent = indent
        self.name = name
        self.path = path
        self.marker = marker


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
    did not explicitly request (embed bindings, accepted repairs); ``hints``
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


def _directive_indent(line: str) -> str:
    """Return the exact Python indentation prefix (spaces/tabs only)."""
    return line[: len(line) - len(line.lstrip(" \t"))]


def _patch_header_error(message: str, line: str, line_no: int) -> SyntaxError:
    return SyntaxError(message, ("<cell>", line_no, 1, line))


def _split_patch_until(rest: str) -> tuple[str, str]:
    """Split a final ``until=TOKEN`` clause from a patch header.

    A quoted path is opaque text, not a Python expression: quote characters
    only delimit the optional surrounding pair and backslashes are retained
    byte-for-byte. Looking for the suffix after that pair prevents a path
    such as ``"name until=marker"`` from accidentally selecting a marker.
    """
    marker_match = re.search(r"[ \t]+until[ \t]*=[ \t]*(\S+)[ \t]*$", rest)
    if marker_match is None:
        if re.search(r"[ \t]+until[ \t]*=[ \t]*$", rest) is not None:
            raise ValueError("until= requires a non-empty token")
        return rest, _DEFAULT_EMBED_END

    candidate_path = rest[: marker_match.start()].rstrip(" \t")
    if not candidate_path:
        raise ValueError("missing patch path before until=")

    # If the path starts with a quote, only recognize the suffix when the
    # matching closing quote occurs immediately before it. This is deliberately
    # a wrapper check, never string-literal decoding or interpolation.
    if candidate_path[0] in "\"'":
        quote = candidate_path[0]
        if len(candidate_path) < 2 or candidate_path[-1] != quote:
            return rest, _DEFAULT_EMBED_END
    return candidate_path, marker_match.group(1)


def _unwrap_patch_path(path: str, line: str, line_no: int) -> str:
    """Remove one surrounding matching quote pair without decoding its body."""
    path = path.strip(" \t")
    if len(path) >= 2 and path[0] in "\"'" and path[-1] == path[0]:
        path = path[1:-1]
    if not path:
        raise _patch_header_error(
            "malformed #@patch directive: missing patch path",
            line,
            line_no,
        )
    return path


def _parse_patch_header(line: str, line_no: int) -> tuple[str, str]:
    """Parse a patch header into a literal path and terminator.

    The path is deliberately *not* a Python expression: after the directive
    marker it is the literal remainder, including spaces. A final,
    whitespace-delimited ``until=TOKEN`` (with optional spaces around ``=``)
    is reserved for selecting a marker. Matching surrounding single/double
    quotes are wrappers only; their contents, including backslashes, remain
    literal path bytes.
    """
    stripped = line.strip()
    suffix = stripped[len(_PATCH_PREFIX) :]
    if not stripped.startswith(_PATCH_PREFIX) or (suffix and not suffix[0].isspace()):
        raise _patch_header_error(
            "malformed #@patch directive: expected '#@patch PATH [until=TOKEN]'",
            line,
            line_no,
        )
    rest = suffix.strip()
    if not rest:
        raise _patch_header_error(
            "malformed #@patch directive: missing patch path",
            line,
            line_no,
        )

    try:
        path, marker = _split_patch_until(rest)
    except ValueError as exc:
        raise _patch_header_error(
            f"malformed #@patch directive: {exc}",
            line,
            line_no,
        ) from None
    return _unwrap_patch_path(path, line, line_no), marker


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


def _masked_verbatim_source(source: str, ranges: list[tuple[int, int]]) -> str:
    """Blank payload characters while preserving every physical newline."""
    if not ranges:
        return source
    lines = source.split("\n")
    for start, end in ranges:
        for index in range(start, min(end, len(lines))):
            # Keep a possible CR so CRLF remains a line ending for tokenize.
            lines[index] = "".join("\r" if char == "\r" else " " for char in lines[index])
    return "\n".join(lines)


def _inside_verbatim(index: int, ranges: list[tuple[int, int]]) -> bool:
    return any(start <= index < end for start, end in ranges)


def _patch_terminator(line: str, indent: str, marker: str) -> bool:
    """Patch terminators must have exactly the opening indentation prefix."""
    leading = _directive_indent(line)
    return leading == indent and line[len(indent) :].strip() == marker


def _find_directive_end(
    lines: list[str], start: int, kind: str, indent: str, marker: str
) -> int | None:
    for index in range(start + 1, len(lines)):
        if kind == "embed":
            # Preserve embed's historical marker semantics: indentation and
            # trailing whitespace around the marker are ignored.
            if lines[index].strip() == marker:
                return index
        elif _patch_terminator(lines[index], indent, marker):
            return index
    return None


def _collect_directive_blocks(source: str) -> tuple[list[_DirectiveBlock], set[int]]:
    """Find embed/patch ranges while masking verbatim payloads between passes.

    Tokenizing the raw cell alone is insufficient: a quote in an embed or
    patch payload can make tokenize believe later directives are part of a
    Python string. Each discovered payload is therefore blanked and tokenized
    again until the literal protection map stabilizes. This keeps actual
    multiline strings protected while making verbatim payloads opaque.
    """
    lines = source.split("\n")
    protected = _raw_string_body_lines(source)
    ranges: list[tuple[int, int]] = []
    blocks: list[_DirectiveBlock] = []
    starts: set[int] = set()

    for _ in range(max(1, len(lines) + 1)):
        discovered = False
        for index, line in enumerate(lines):
            if index in starts or index + 1 in protected or _inside_verbatim(index, ranges):
                continue
            stripped = line.strip()
            indent = _directive_indent(line)

            if stripped.startswith("#@embed"):
                match = _EMBED_OPEN_RE.fullmatch(stripped)
                if match is None:
                    continue
                marker = match.group("until") or _DEFAULT_EMBED_END
                end = _find_directive_end(lines, index, "embed", indent, marker)
                if end is None:
                    continue
                block = _DirectiveBlock(
                    "embed",
                    index,
                    end,
                    indent,
                    name=match.group("name"),
                    marker=marker,
                )
            elif stripped.startswith(_PATCH_PREFIX):
                try:
                    path, marker = _parse_patch_header(line, index + 1)
                except SyntaxError:
                    # Defer malformed-header diagnostics to extraction. A
                    # malformed line cannot safely identify a payload range.
                    continue
                end = _find_directive_end(lines, index, "patch", indent, marker)
                if end is None:
                    continue
                block = _DirectiveBlock(
                    "patch",
                    index,
                    end,
                    indent,
                    path=path,
                    marker=marker,
                )
            else:
                continue

            starts.add(index)
            blocks.append(block)
            ranges.append((index + 1, end))
            discovered = True

        new_protected = _raw_string_body_lines(_masked_verbatim_source(source, ranges))
        if not discovered and new_protected == protected:
            break
        protected = new_protected

    blocks.sort(key=lambda block: block.start)
    return blocks, protected


def _leading_whitespace_len(line: str) -> int:
    """Count presentation indentation without treating patch text as code."""
    index = 0
    while index < len(line) and line[index] in " \t":
        index += 1
    return index


def _patch_body_lines(lines: list[str], block: _DirectiveBlock, path: str) -> list[str]:
    """Normalize pasted patch indentation while retaining hunk prefixes.

    The opening Python indentation is structural and is removed first. A
    second, common presentation indent is removed from non-blank rows; this
    handles a body pasted one level deeper than its directive without removing
    the leading space that marks a context hunk row. Blank rows may omit the
    opening indentation. A non-blank row that crosses out of the opening
    indentation is rejected so unrelated Python code cannot be consumed.
    """
    rows: list[str] = []
    for row_index in range(block.start + 1, block.end):
        row = lines[row_index]
        is_blank = not row.strip(" \t\r\n")
        if not is_blank and block.indent and not row.startswith(block.indent):
            raise SyntaxError(
                f"#@patch {path!r} (line {block.start + 1}) body line "
                f"{row_index + 1} must begin with the opening indentation prefix",
                ("<cell>", row_index + 1, 1, row),
            )
        rows.append(row[len(block.indent) :] if row.startswith(block.indent) else row)

    non_blank = [row for row in rows if row.strip(" \t\r\n")]
    presentation_indent = min((_leading_whitespace_len(row) for row in non_blank), default=0)
    body: list[str] = []
    for row in rows:
        leading = _leading_whitespace_len(row)
        if not row.strip(" \t\r\n"):
            # A single semantic context-space survives after presentation
            # indentation; otherwise blank padding is normalized to empty.
            body.append(row[presentation_indent:] if leading > presentation_indent else "")
        else:
            body.append(row[presentation_indent:])
    return body


def _extract_embeds(source: str) -> tuple[str, list[str]]:
    """Expand ``#@embed`` and runtime ``#@patch`` blocks.

    Embed payloads remain verbatim string assignments. Patch payloads become
    ``apply_patch(<literal path>, <literal hunk text>)`` at the opening line,
    so Python's ordinary control flow determines whether/when the filesystem
    mutation happens. Consumed rows are replaced with blank lines to keep
    subsequent source line numbers aligned.
    """
    lines = source.split("\n")
    blocks, protected = _collect_directive_blocks(source)
    by_start = {block.start: block for block in blocks}
    notes: list[str] = []
    out: list[str] = []
    i = 0
    while i < len(lines):
        block = by_start.get(i)
        if block is None:
            line = lines[i]
            stripped = line.strip()
            if i + 1 not in protected and stripped.startswith("#@embed"):
                match = _EMBED_OPEN_RE.fullmatch(stripped)
                if match is not None:
                    marker = match.group("until") or _DEFAULT_EMBED_END
                    if _find_directive_end(lines, i, "embed", _directive_indent(line), marker) is None:
                        name = match.group("name")
                        raise SyntaxError(
                            f"#@embed {name!r} (line {i + 1}) is never closed: "
                            f"expected a line reading {marker!r}",
                            ("<cell>", i + 1, 1, line),
                        )
            elif i + 1 not in protected and stripped.startswith(_PATCH_PREFIX):
                # Valid headers with a missing marker and malformed headers
                # both fail loudly instead of silently remaining comments.
                path, marker = _parse_patch_header(line, i + 1)
                if _find_directive_end(lines, i, "patch", _directive_indent(line), marker) is None:
                    raise SyntaxError(
                        f"#@patch (line {i + 1}) is never closed: expected a line reading {marker!r}",
                        ("<cell>", i + 1, 1, line),
                    )
            out.append(line)
            i += 1
            continue

        if block.kind == "embed":
            content = "\n".join(lines[block.start + 1 : block.end])
            name = block.name or ""
            out.append(f"{block.indent}{name} = {json.dumps(content, ensure_ascii=True)}")
            out.extend("" for _ in range(block.end - block.start))
            notes.append(
                f"#@embed {name}: bound {len(content)} chars "
                f"({block.end - block.start - 1} lines) verbatim"
            )
        else:
            path = block.path or ""
            body = _patch_body_lines(lines, block, path)
            out.append(
                f"{block.indent}apply_patch({_quote_arg(path)}, {_quote_arg(chr(10).join(body))})"
            )
            out.extend("" for _ in range(block.end - block.start))
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
                "(a #@embed block avoids quoting entirely)"
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

    Order matters: embed blocks are extracted first (their content is data,
    immune to magic rewriting and repairs), then magics are translated, then
    a repair ladder runs only if the result still fails to compile. Every
    accepted repair is disclosed in ``notes``; ``hints`` are populated only
    when no repair compiles.
    """
    source, embed_notes = _extract_embeds(code)
    transformed = transform_cell(source)
    if _compiles(transformed):
        return PreparedCell(transformed, embed_notes, [])
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
                embed_notes + [f"executed repaired cell: {'; '.join(applied)}"],
                [],
            )
    return PreparedCell(transformed, embed_notes, _syntax_hints(transformed))


def _emit_cell_prep(rid: str, prepared: PreparedCell) -> None:
    for note in prepared.notes:
        _emit({"type": "stderr", "id": rid, "data": f"<kernel> note: {note}\n"})
    for hint in prepared.hints:
        _emit({"type": "stderr", "id": rid, "data": f"<kernel> hint: {hint}\n"})


# ---------------------------------------------------------------------------
# Magic source transformer
# ---------------------------------------------------------------------------


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

        # Cell magic — consumes from here to EOF.
        if stripped.startswith("%%"):
            head, _ = _split_magic_head(stripped[2:])
            name, args = head
            body_lines = lines[i + 1 :]
            body = "\n".join(body_lines)
            out.append(
                f"{indent}__proto_magic_cell({_quote_arg(name)}, {_quote_arg(args)}, {_quote_arg(body)})"
            )
            return "\n".join(out)

        # Line magic / shell at start of line.
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

        # Assignment forms: var = %magic / var = !cmd
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
    """Return literal-protected lines using the shared directive scanner."""
    _, protected = _collect_directive_blocks(source)
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


# ---------------------------------------------------------------------------
# Magic registry
# ---------------------------------------------------------------------------


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
    # errors="replace": child output is not guaranteed to be valid text in the
    # locale encoding (e.g. `cat` of a latin-1 file); a decode error here would
    # crash the streaming thread and lose the rest of the output.
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
    # stdin=DEVNULL: see _run_shell_body.
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
                # Token is name-version; drop the version suffix.
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


@cell_magic("capture")
def _magic_cell_capture(args: str, body: str) -> str:
    """Capture stdout/stderr of body; bind to ``args`` (a name) if provided."""
    captured = io.StringIO()
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
    # stdin=DEVNULL: children must not inherit the runner's stdin, which is
    # the host's NDJSON control channel (a reading child would steal frames,
    # and inheriting the pipe deadlocks nested interpreters on Windows).
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
    def n(self) -> str:  # IPython compat
        return "\n".join(self)

    @property
    def s(self) -> str:  # IPython compat
        return " ".join(self)


def __proto_shell(cmd: str) -> _ShellResult:
    # stdin=DEVNULL: see _run_shell_body.
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


# ---------------------------------------------------------------------------
# Display dispatch
# ---------------------------------------------------------------------------


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
            bundle.update({str(k): v for k, v in data.items()})

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


# ---------------------------------------------------------------------------
# Matplotlib post-cell flush
# ---------------------------------------------------------------------------


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


def _flush_matplotlib_figures() -> None:
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return
    try:
        fignums = list(plt.get_fignums())
    except Exception:
        return
    for num in fignums:
        try:
            fig = plt.figure(num)
            if id(fig) in (_CURRENT_DISPLAYED_MATPLOTLIB_FIGURE_IDS.get() or set()):
                plt.close(fig)
                continue
            buf = io.BytesIO()
            fig.savefig(buf, format="png", bbox_inches="tight")
            data = base64.b64encode(buf.getvalue()).decode("ascii")
            _emit_display({"image/png": data, "text/plain": f"<Figure {num}>"})
            plt.close(fig)
        except Exception:
            continue


# Force a non-interactive backend before user code imports matplotlib. Set as
# environ default so the user can still override it explicitly.
os.environ.setdefault("MPLBACKEND", "Agg")


# ---------------------------------------------------------------------------
# Builtin injection
# ---------------------------------------------------------------------------


def __proto_defs_view() -> dict[str, int]:
    return dict(_STATE.defs)


def _current_run_id() -> str | None:
    return _CURRENT_RID.get()


def _runner_exports() -> dict[str, Any]:
    return {
        "display": __proto_display,
        "defs": __proto_defs_view,
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
        "__proto_current_run_id__": _current_run_id,
    }
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
    # Shadow warnings cover the helper API only: re-importing a convenience
    # module (``import json``) or class (``Path``) is normal, not a mistake.
    _STATE.prelude_names = set(_runner_exports()) | {
        n for n, v in _STATE.prelude_exports.items() if not isinstance(v, (types.ModuleType, type))
    }
    _STATE.defs.clear()
    _STATE.shadow_warned.clear()


_install_builtins(_STATE.user_ns)


# ---------------------------------------------------------------------------
# Source execution (split last expression for rich display)
# ---------------------------------------------------------------------------


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

    Coroutine code is awaited in this task so top-level ``await`` interleaves
    with sibling requests. Plain statement/expression code runs on the main
    runner thread so SIGINT can interrupt it reliably.
    """
    if code.co_flags & inspect.CO_COROUTINE:
        result = await eval(code, ns)
        return result if want_value else None
    if want_value:
        return eval(code, ns)
    exec(code, ns)
    return None


# Code objects that mark "user cell code is executing on the main thread";
# consulted by the SIGINT handler to choose between raising KeyboardInterrupt
# and cancelling the request task.
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


# ---------------------------------------------------------------------------
# Signal handling
# ---------------------------------------------------------------------------


def _install_idle_sigint() -> None:
    try:
        signal.signal(signal.SIGINT, signal.SIG_IGN)
    except (OSError, ValueError):
        # Some platforms (Windows in non-console mode) reject this; fine.
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
        # This handler runs *inside* the interrupted selector poll, which is
        # retried with its remaining timeout once we return. ``cancel()`` only
        # queued the wake-up via ``call_soon``; write to the loop's self-pipe
        # so the poll returns now instead of when the original timer fires.
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
        try:
            sys.path.remove(cwd)
        except ValueError:
            pass
        sys.path.insert(0, cwd)

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


# ---------------------------------------------------------------------------
# Request dispatch
# ---------------------------------------------------------------------------


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
        # Legacy host that ran the prelude as a plain cell in user_ns.
        _STATE.prelude_names = set(_STATE.user_ns)
        _STATE.defs.clear()
        return
    defs, bound = _cell_bound_names(source)
    for name in defs:
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
    displayed_matplotlib_token = _CURRENT_DISPLAYED_MATPLOTLIB_FIGURE_IDS.set(set())
    _STATE.capture_rid = rid
    _STATE.user_ns["__proto_run_id__"] = rid
    _STATE.cancel_requested = False
    _STATE.execution_count += 1
    try:
        _reset_fs_status()
    except Exception:
        pass
    execution_count = _STATE.execution_count
    _emit({"type": "started", "id": rid})

    status: str = "ok"
    cancelled = False
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
        except BaseException as exc:  # noqa: BLE001 - runtime setup errors must settle the request
            _emit_error(rid, exc)
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

        _begin_exec_sigint()
        try:
            if is_prelude:
                _load_prelude(transformed)
            else:
                await _exec_source_async(transformed, _STATE.user_ns)
        except KeyboardInterrupt:
            cancelled = True
            status = "error"
            _emit_error(rid, KeyboardInterrupt("Execution interrupted"))
        except asyncio.CancelledError:
            # SIGINT arrived while the cell was parked at an await; the
            # handler cancelled this task instead of unwinding the loop.
            cancelled = True
            status = "error"
            _emit_error(rid, KeyboardInterrupt("Execution interrupted"))
            current = asyncio.current_task()
            uncancel = getattr(current, "uncancel", None)
            if callable(uncancel):
                uncancel()
        except SystemExit as exc:
            status = "error"
            _emit_error(rid, exc)
        except BaseException as exc:  # noqa: BLE001 - we want to surface every user error
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
                _track_cell_defs(transformed, rid, execution_count)
            _flush_stream_proxies(rid)
        except BaseException as exc:  # noqa: BLE001 - the host needs a done frame to settle the request
            status = "error"
            _emit_error(rid, exc)
        _emit(
            {
                "type": "done",
                "id": rid,
                "status": status,
                "executionCount": execution_count,
                "cancelled": cancelled,
            }
        )
    finally:
        if _STATE.capture_rid == rid:
            _STATE.capture_rid = None
        _flush_stream_proxies(rid)
        _CURRENT_RID.reset(token)
        _CURRENT_DISPLAYED_MATPLOTLIB_FIGURE_IDS.reset(displayed_matplotlib_token)


def _emit_error(rid: str, exc: BaseException) -> None:
    if isinstance(exc, SyntaxError) and exc.filename == "<cell>":
        # Syntax error in the cell source itself: every stack frame is runner
        # machinery, so emit only the caret display, like a REPL.
        tb_lines = traceback.format_exception_only(type(exc), exc)
    else:
        # Drop the leading runner-internal frames (_handle_request_async ->
        # _exec_source_async -> _run_compiled_*) so tracebacks start at user
        # code. If the exception never reached user code it is a runner bug;
        # keep the full traceback because those frames are the diagnosis.
        tb = exc.__traceback__
        while tb is not None and tb.tb_frame.f_code.co_filename == __file__:
            tb = tb.tb_next
        tb_lines = traceback.format_exception(
            type(exc), exc, tb if tb is not None else exc.__traceback__
        )
    _emit(
        {
            "type": "error",
            "id": rid,
            "ename": type(exc).__name__,
            "evalue": str(exc),
            "traceback": [line.rstrip("\n") for line in tb_lines],
        }
    )


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------


def _read_stdin(loop: asyncio.AbstractEventLoop, queue: asyncio.Queue, stdin) -> None:
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
        loop.call_soon_threadsafe(queue.put_nowait, req)
    loop.call_soon_threadsafe(queue.put_nowait, {"type": "exit"})


async def _main_async() -> None:
    sys.stdout = _StreamProxy("stdout")
    sys.stderr = _StreamProxy("stderr")
    _install_idle_sigint()
    _start_parent_watchdog()
    _start_capture_drain()

    stdin = sys.__stdin__
    if stdin is None:
        return

    loop = asyncio.get_running_loop()
    _STATE.loop = loop
    queue: asyncio.Queue = asyncio.Queue()
    reader = threading.Thread(
        target=_read_stdin,
        args=(loop, queue, stdin),
        name="proto-stdin-reader",
        daemon=True,
    )
    reader.start()

    tasks = _STATE.request_tasks

    def _task_done(task: asyncio.Task) -> None:
        tasks.discard(task)
        try:
            exc = task.exception()
        except asyncio.CancelledError:
            return
        if exc is not None:
            _emit_error("", exc)

    try:
        while True:
            req = await queue.get()
            if req.get("type") == "exit":
                break
            task = asyncio.create_task(_handle_request_async(req))
            tasks.add(task)
            task.add_done_callback(_task_done)
    finally:
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


def main() -> None:
    asyncio.run(_main_async())


if __name__ == "__main__":
    main()
