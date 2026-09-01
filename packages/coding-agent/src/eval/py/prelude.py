from __future__ import annotations

# Public kernel API. The runner executes this file in a private module
# namespace and exports exactly these names into the user namespace, so the
# helpers' own globals (json, os, re, _bridge_call, ...) can't be clobbered
# by user code.
__all__ = [
    "display",
    "env",
    "write",
    "edit",
    "AnchorNotFoundError",
    "AmbiguousAnchorError",
    "StaleWriteError",
    "block_range",
    "symbols",
    "output",
    "tool",
    "completion",
    "agent",
    "parallel",
    "pipeline",
    "log",
    "phase",
    "budget",
    # stdlib conveniences cells have always seen without importing
    "Path",
    "os",
    "json",
    "re",
    "math",
]

if "__proto_prelude_loaded__" not in globals():
    __proto_prelude_loaded__ = True
    from pathlib import Path
    import os, json, math, re, hashlib, stat, sys, threading
    from urllib.parse import unquote

    INTENT_FIELD = "i"

    _proto_display = __proto_display

    _PRESENTABLE_REPRS = (
        "_repr_mimebundle_",
        "_repr_html_",
        "_repr_json_",
        "_repr_markdown_",
        "_repr_png_",
        "_repr_jpeg_",
        "_repr_svg_",
        "_repr_latex_",
    )

    def display(value):
        """Render a value. Falls back to a JSON+text/plain bundle for plain dict/list/tuple."""
        if any(hasattr(value, attr) for attr in _PRESENTABLE_REPRS):
            _proto_display(value)
            return
        if isinstance(value, (dict, list, tuple)):
            try:
                bundle = {"application/json": value, "text/plain": repr(value)}
                _proto_display(bundle, raw=True)
                return
            except Exception:
                pass
        _proto_display(value)

    def _emit_status(op: str, **data):
        """Emit structured status event for TUI rendering."""
        _proto_display({"application/x-proto-status": {"op": op, **data}}, raw=True)

    _MAX_DIFF_CHARS = 32000

    # --- filesystem mutation tracking ----------------------------------------
    # The host diffs cell-time filesystem changes with a walker rooted at the
    # session cwd (eval/cell-file-diff.ts), so mutations made with anything
    # other than the write() helper were invisible outside that root. A
    # CPython audit hook sees every in-process mutation (open() with write
    # flags, os.remove/rename/truncate); the prelude snapshots each touched
    # path's pre-mutation content and flushes per-cell status events carrying
    # the same hunk diffs helper writes emit. Helper events also record the
    # content they already showed a diff for, and the flush diffs from that
    # last-reported content so it never re-prints hunks the cell has seen.
    # State lives on the sys module so a prelude re-exec reuses the
    # already-installed hook's records.
    _FS_DIFF_MAX_BYTES = 8 * 1024 * 1024
    # Aggregate budget for cached helper-write contents kept as flush diff
    # bases; past it the flush falls back to pre-cell snapshots.
    _FS_REPORT_TEXT_BUDGET = 32 * 1024 * 1024
    # Aggregate budget for pre-mutation snapshots kept per cell (mirrors
    # MAX_CAPTURE_CONTENT_BYTES in eval/cell-file-diff.ts); past it
    # _fs_record stores only the content sha — dedupe still works and the
    # flush emits the write without a diff.
    _FS_CAPTURE_TEXT_BUDGET = 16 * 1024 * 1024
    _FS_MAX_EVENTS = 50
    # Cache/build noise by directory-name component; cross-language mirror
    # of PRUNED_DIRS in eval/fs-policy.ts (update in the same change).
    _FS_PRUNED_DIRS = frozenset({
        ".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv",
        ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".cache",
        ".cargo", ".rustup", ".bun", ".npm", ".local", "target", "build",
        "dist", ".next", ".nuxt", ".output", ".turbo", ".parcel-cache",
        "coverage",
    })
    _FS_SKIPPED_SUFFIXES = (".pyc", ".pyo")
    _FS_WRITE_FLAGS = (
        getattr(os, "O_WRONLY", 0)
        | getattr(os, "O_RDWR", 0)
        | getattr(os, "O_CREAT", 0)
        | getattr(os, "O_TRUNC", 0)
        | getattr(os, "O_APPEND", 0)
        | getattr(os, "O_TMPFILE", 0)
    )

    _FS_STATE = getattr(sys, "_proto_fs_state", None)
    if _FS_STATE is None:
        _FS_STATE = {
            "touched": {},
            "reported": {},
            "reported_text_bytes": 0,
            "captured_text_bytes": 0,
            "lock": threading.Lock(),
            "tls": threading.local(),
        }
        sys._proto_fs_state = _FS_STATE
    _FS_STATE.setdefault("reported_text_bytes", 0)
    _FS_STATE.setdefault("captured_text_bytes", 0)
    # Stale-write guard: abspath -> (st_mtime_ns, st_size) at the agent's
    # last observation of the file. Armed by any read-mode open the audit hook
    # sees (`open(p).read()`, `Path(p).read_text()`, imports, ...) and by
    # host-side observations the runner forwards before each cell (shell
    # builtins and redirects, the read tool); re-armed to the post-write state
    # by this process's own writes and by host-side writes (shell, edit/write
    # tools); NEVER cleared between cells — staleness is about what the agent
    # last saw, which spans cells. Only writers outside all of those paths
    # leave a mismatched record behind for write()/edit() to trip on.
    _FS_STATE.setdefault("read_seen", {})
    _FS_READ_SEEN_MAX = 8192

    def _fs_sha_file(ap: str) -> str:
        """Short sha256 of a file streamed in 1 MiB chunks (never loads it whole)."""
        h = hashlib.sha256()
        with open(ap, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()[:16]

    def _fs_record(path) -> None:
        """Snapshot a path's pre-mutation state the first time the cell touches it."""
        tls = _FS_STATE["tls"]
        if getattr(tls, "recording", False):
            return
        try:
            sp = os.fsdecode(path)
        except (TypeError, ValueError):
            return
        if not sp:
            return
        ap = os.path.abspath(sp)
        touched = _FS_STATE["touched"]
        if ap in touched or ap.endswith(_FS_SKIPPED_SUFFIXES):
            return
        if any(part in _FS_PRUNED_DIRS for part in ap.split(os.sep)[:-1]):
            return
        try:
            st = os.stat(ap)
        except OSError:
            # not there yet (O_CREAT pre-create): the flush decides from
            # post-cell state whether anything was actually created
            with _FS_STATE["lock"]:
                touched.setdefault(ap, {"existed": False, "key": None, "before": None, "before_sha": None})
            return
        if not stat.S_ISREG(st.st_mode):
            return
        record = {"existed": True, "key": (st.st_mtime_ns, st.st_size), "before": None, "before_sha": None}
        if st.st_size <= _FS_DIFF_MAX_BYTES:
            with _FS_STATE["lock"]:
                under_budget = _FS_STATE["captured_text_bytes"] < _FS_CAPTURE_TEXT_BUDGET
            tls.recording = True
            try:
                with open(ap, "rb") as fh:
                    data = fh.read()
            except OSError:
                data = None
            finally:
                tls.recording = False
            if data is not None and b"\x00" not in data[:8192]:
                # The sha is kept even past the capture budget so the flush
                # can still dedupe content-identical rewrites; only the text
                # is dropped, and the flush then emits the write with no diff.
                record["before_sha"] = hashlib.sha256(data).hexdigest()[:16]
                if under_budget:
                    record["before"] = data.decode("utf-8", errors="replace")
                    with _FS_STATE["lock"]:
                        _FS_STATE["captured_text_bytes"] += len(record["before"])
        with _FS_STATE["lock"]:
            touched.setdefault(ap, record)

    def _fs_norm_path(path) -> str | None:
        """Decode + absolutize an audit-event path, applying the shared skip filters."""
        try:
            sp = os.fsdecode(path)
        except (TypeError, ValueError):
            return None
        if not sp:
            return None
        ap = os.path.abspath(sp)
        if ap.endswith(_FS_SKIPPED_SUFFIXES):
            return None
        if any(part in _FS_PRUNED_DIRS for part in ap.split(os.sep)[:-1]):
            return None
        return ap

    def _fs_remember_seen(ap: str, key: tuple[int, int]) -> None:
        seen = _FS_STATE["read_seen"]
        with _FS_STATE["lock"]:
            if len(seen) >= _FS_READ_SEEN_MAX and ap not in seen:
                seen.pop(next(iter(seen)), None)
            seen.pop(ap, None)
            seen[ap] = key

    def _fs_note_read(path) -> None:
        """Record the file state the kernel last read (arms the stale-write guard)."""
        ap = _fs_norm_path(path)
        if ap is None:
            return
        try:
            st = os.stat(ap)
        except OSError:
            return
        if not stat.S_ISREG(st.st_mode):
            return
        _fs_remember_seen(ap, (st.st_mtime_ns, st.st_size))

    def _fs_note_observed(observations) -> None:
        """Arm or disarm the stale-write guard from host-side observations
        (shell builtins, redirects, and host tools) of files the agent read or
        wrote outside the kernel. A missing stamp means the file is gone."""
        for entry in observations:
            if not isinstance(entry, dict):
                continue
            ap = _fs_norm_path(entry.get("path"))
            if ap is None:
                continue
            mtime_ns = entry.get("mtimeNs")
            size = entry.get("size")
            if mtime_ns is None or size is None:
                with _FS_STATE["lock"]:
                    _FS_STATE["read_seen"].pop(ap, None)
                continue
            try:
                _fs_remember_seen(ap, (int(mtime_ns), int(size)))
            except (TypeError, ValueError):
                continue

    def _fs_forget_read(path) -> None:
        """Disarm the stale-write guard for a path this process is mutating itself."""
        ap = _fs_norm_path(path)
        if ap is not None:
            _FS_STATE["read_seen"].pop(ap, None)

    def _fs_audit(event, args) -> None:
        if getattr(_FS_STATE["tls"], "recording", False):
            return
        try:
            if event == "open":
                flags = args[2] if len(args) > 2 and isinstance(args[2], int) else 0
                mode = args[1] if len(args) > 1 and isinstance(args[1], str) else ""
                if not (flags & _FS_WRITE_FLAGS or any(c in mode for c in "wax+")):
                    _fs_note_read(args[0])
                    return
                _fs_record(args[0])
                _fs_forget_read(args[0])
            elif event == "os.remove":
                _fs_record(args[0])
                _fs_forget_read(args[0])
            elif event == "os.rename":  # os.replace audits under the same name
                _fs_record(args[0])
                _fs_record(args[1])
                _fs_forget_read(args[0])
                _fs_forget_read(args[1])
            elif event == "os.truncate":
                _fs_record(args[0])
                _fs_forget_read(args[0])
        except Exception:
            pass  # an audit hook must never break the operation it observes

    if not getattr(sys, "_proto_fs_audit_installed", False):
        try:
            sys.addaudithook(_fs_audit)
            sys._proto_fs_audit_installed = True
        except Exception:
            pass

    def _flush_fs_status() -> None:
        """Report filesystem mutations made without a helper API as status
        events (same shape as write()'s). Called by the runner after the
        cell's user code settles, before the done frame."""
        state = _FS_STATE
        with state["lock"]:
            paths = sorted(state["touched"])
            pending = {ap: state["touched"].pop(ap) for ap in paths}
            state["captured_text_bytes"] = 0
        emitted = 0
        processed = 0
        truncated = False
        for ap in paths:
            if emitted >= _FS_MAX_EVENTS:
                truncated = True
                break
            processed += 1
            rec = pending[ap]
            try:
                st = os.stat(ap)
                regular = stat.S_ISREG(st.st_mode)
            except OSError:
                st = None
                regular = False
            if not regular:
                if not rec["existed"]:
                    continue
                data = {"op": "delete", "path": ap}
                if rec["before"] is not None:
                    rows, _ = _capped_numbered_diff(rec["before"], "")
                    if rows:
                        data["diff"] = "\n".join(rows)
                _emit_status(data.pop("op"), **data)
                emitted += 1
                continue
            if rec["key"] is not None and (st.st_mtime_ns, st.st_size) == rec["key"]:
                continue  # opened but never written
            tls = state["tls"]
            tls.recording = True  # machinery read: must not arm the stale-write guard
            try:
                if st.st_size > _FS_DIFF_MAX_BYTES:
                    # Past the diff cap only the sha is needed (walker dedupe);
                    # stream it so a multi-GB write never lands in memory.
                    data = None
                    sha = _fs_sha_file(ap)
                else:
                    with open(ap, "rb") as fh:
                        data = fh.read()
                    sha = hashlib.sha256(data).hexdigest()[:16]
            except OSError:
                continue
            finally:
                tls.recording = False
            reported = state["reported"].get(ap)
            if rec["before_sha"] == sha or (reported is not None and reported["sha"] == sha):
                continue
            if data is not None and len(data) <= _FS_DIFF_MAX_BYTES and b"\x00" not in data[:8192]:
                before = reported["text"] if reported is not None else None
                if before is None:
                    # An existed file whose pre-mutation content was not
                    # captured (over budget, or the snapshot read failed)
                    # gets no diff rather than a fake one diffed against "".
                    before = rec["before"] if rec["before"] is not None else ("" if not rec["existed"] else None)
                _emit_file_status("write", ap, before=before, after=data.decode("utf-8", errors="replace"))
            else:
                _emit_status("write", path=ap, bytes=st.st_size, sha=sha)
            emitted += 1
        if truncated:
            _emit_status("files", count=len(paths) - processed, action="truncated")
        state["reported"].clear()
        state["reported_text_bytes"] = 0

    def _reset_fs_status() -> None:
        """Drop records left by runner machinery between requests so they are
        never attributed to the next cell."""
        _FS_STATE["touched"].clear()
        _FS_STATE["reported"].clear()
        _FS_STATE["reported_text_bytes"] = 0
        _FS_STATE["captured_text_bytes"] = 0

    def _numbered_diff(before: str, after: str, context: int = 2) -> list[str]:
        """Numbered hunk rows ('-12|old', '+12|new', ' 13|ctx') in the edit tool's canonical diff format."""
        import difflib

        old_lines = before.split("\n")
        new_lines = after.split("\n")
        if old_lines and old_lines[-1] == "":
            old_lines.pop()
        if new_lines and new_lines[-1] == "":
            new_lines.pop()
        opcodes = difflib.SequenceMatcher(a=old_lines, b=new_lines, autojunk=False).get_opcodes()
        rows: list[str] = []
        old_no = 1
        new_no = 1
        last_was_change = False
        for index, (tag, i1, i2, j1, j2) in enumerate(opcodes):
            if tag != "equal":
                if tag in ("replace", "delete"):
                    for line in old_lines[i1:i2]:
                        rows.append(f"-{old_no}|{line}")
                        old_no += 1
                if tag in ("replace", "insert"):
                    for line in new_lines[j1:j2]:
                        rows.append(f"+{new_no}|{line}")
                        new_no += 1
                last_was_change = True
                continue
            raw = old_lines[i1:i2]
            next_is_change = index < len(opcodes) - 1 and opcodes[index + 1][0] != "equal"
            if not last_was_change and not next_is_change:
                old_no += len(raw)
                new_no += len(raw)
                continue
            if last_was_change and next_is_change:
                if len(raw) > context * 2:
                    leading = raw[:context]
                    trailing = raw[len(raw) - context :] if context else []
                    middle = len(raw) - context * 2
                else:
                    leading, trailing, middle = raw, [], 0
            elif next_is_change:
                leading = []
                trailing = raw[len(raw) - context :] if context else []
                middle = max(0, len(raw) - context)
            else:
                leading = raw[:context] if context else []
                trailing = []
                middle = max(0, len(raw) - context)
            for line in leading:
                rows.append(f" {old_no}|{line}")
                old_no += 1
                new_no += 1
            old_no += middle
            new_no += middle
            for line in trailing:
                rows.append(f" {old_no}|{line}")
                old_no += 1
                new_no += 1
            last_was_change = False
        return rows

    def _capped_numbered_diff(before: str, after: str) -> tuple[list[str], bool]:
        """Diff rows capped for status events; the cap trims output rows, never skips the diff."""
        rows = _numbered_diff(before, after)
        total = sum(len(row) + 1 for row in rows)
        if total <= _MAX_DIFF_CHARS:
            return rows, False
        kept: list[str] = []
        used = 0
        for row in rows:
            if used + len(row) + 1 > _MAX_DIFF_CHARS:
                break
            kept.append(row)
            used += len(row) + 1
        return kept, True

    def _emit_file_status(op: str, path, *, before: str | None, after: str) -> None:
        """Emit a file-op status event, attaching a capped hunk diff when content changed."""
        data: dict = {
            "path": str(path),
            "chars": len(after),
            "sha": hashlib.sha256(after.encode()).hexdigest()[:16],
        }
        state = getattr(sys, "_proto_fs_state", None)
        if state is not None:
            entry = {"sha": data["sha"], "text": None}
            if len(after) <= _FS_DIFF_MAX_BYTES and state["reported_text_bytes"] <= _FS_REPORT_TEXT_BUDGET:
                entry["text"] = after
                state["reported_text_bytes"] += len(after)
            state["reported"][str(path)] = entry
        if before is not None and before != after:
            rows, truncated = _capped_numbered_diff(before, after)
            if rows:
                data["diff"] = "\n".join(rows)
                if truncated:
                    data["diffTruncated"] = True
        _emit_status(op, **data)

    def env(key: str | None = None, value: str | None = None):
        """Get/set environment variables."""
        if key is None:
            items = dict(sorted(os.environ.items()))
            _emit_status("env", count=len(items), keys=list(items.keys())[:20])
            return items
        if value is not None:
            os.environ[key] = value
            _emit_status("env", key=key, value=value, action="set")
            return value
        val = os.environ.get(key)
        _emit_status("env", key=key, value=val, action="get")
        return val

    _PROTO_INTERNAL_URL_RE = re.compile(r"^([a-z][a-z0-9+.-]*)://(.*)$", re.IGNORECASE)

    def _resolve_proto_path(path: str | Path) -> Path:
        """Map a helper path to a real filesystem Path.

        A `scheme://…` whose scheme has an injected on-disk root (e.g.
        `local://`, via PI_EVAL_LOCAL_ROOTS) is rewritten under that root so it
        lands where `read local://…` resolves — not a literal `local:/`
        directory under the cwd (which `Path("local://x")` collapses to). Plain
        paths are made absolute against the kernel cwd so the status events
        helpers emit can be matched against filesystem snapshots by the host
        (relative paths there would defeat its already-reported dedupe and
        duplicate every write as a walker event); any other `scheme://` is
        rejected."""
        if not isinstance(path, str):
            return Path(os.path.abspath(path))
        match = _PROTO_INTERNAL_URL_RE.match(path)
        if not match:
            return Path(os.path.abspath(path))
        scheme = match.group(1).lower()
        try:
            roots = json.loads(os.environ.get("PI_EVAL_LOCAL_ROOTS") or "{}")
        except (ValueError, TypeError):
            roots = {}
        root = roots.get(scheme) if isinstance(roots, dict) else None
        if not root:
            raise ValueError(f"Protocol paths are not supported by this helper: {path}")
        relative = unquote(match.group(2).replace("\\", "/"))
        root_path = os.path.abspath(root)
        if relative == "":
            return Path(root_path)
        rel_path = Path(relative)
        if rel_path.is_absolute() or ".." in rel_path.parts:
            raise ValueError(f"Unsafe {scheme}:// path (absolute or traversal): {path}")
        resolved = os.path.abspath(os.path.join(root_path, relative))
        if resolved != root_path and not resolved.startswith(root_path + os.sep):
            raise ValueError(f"{scheme}:// path escapes its root: {path}")
        return Path(resolved)

    class EditError(RuntimeError):
        """Base for edit()/write() anchor and staleness failures."""

    class AnchorNotFoundError(EditError):
        """edit() anchor matched fewer occurrences than expected."""

    class AmbiguousAnchorError(EditError):
        """edit() anchor matched more occurrences than expected."""

    class StaleWriteError(RuntimeError):
        """The file changed on disk after the kernel's last read of it."""

    def _format_mtime(mtime_ns: int) -> str:
        import datetime

        return datetime.datetime.fromtimestamp(mtime_ns / 1e9).strftime("%H:%M:%S.%f")

    def _check_stale(p: Path, guard: bool, op: str) -> None:
        """Raise StaleWriteError if `p` changed on disk since the kernel's last read.

        Only guards paths with a tracked read (see _fs_note_read); new files and
        never-read paths pass untouched. Call BEFORE any helper-internal read of
        the file — those reads refresh the tracker via the audit hook."""
        if not guard:
            return
        rec = _FS_STATE["read_seen"].get(str(p))
        if rec is None:
            return
        try:
            st = os.stat(p)
        except OSError:
            return  # deleted/moved externally; the write itself will surface it
        if (st.st_mtime_ns, st.st_size) == rec:
            return
        raise StaleWriteError(
            f"{op}({p}): file changed on disk since the kernel last read it "
            f"(read at mtime {_format_mtime(rec[0])}, {rec[1]} bytes; now mtime "
            f"{_format_mtime(st.st_mtime_ns)}, {st.st_size} bytes). "
            f"Re-read the file and redo the change, or pass guard=False to overwrite anyway."
        )

    def _rearm_read_guard(p: Path) -> None:
        """Refresh the read tracker after a helper write so the kernel's own writes never trip the guard."""
        try:
            st = os.stat(p)
        except OSError:
            return
        _FS_STATE["read_seen"][str(p)] = (st.st_mtime_ns, st.st_size)

    def write(path: str | Path, content: str, *, guard: bool = True) -> Path:
        """Create or wholly replace a file with content (parents auto-created).

        For a targeted change to an existing file prefer edit(). Raises
        StaleWriteError if the file changed on disk since the kernel last read
        it (guard=False bypasses).
        """
        p = _resolve_proto_path(path)
        before: str | None = ""
        if p.exists():
            _check_stale(p, guard, "write")
            try:
                before = p.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError, ValueError):
                before = None
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        _rearm_read_guard(p)
        _emit_file_status("write", p, before=before, after=content)
        return p

    def _anchor_label(anchor: str) -> str:
        """First line of an anchor, repr-quoted and truncated for error messages."""
        first = anchor.split("\n", 1)[0]
        label = repr(first[:80])
        if len(first) > 80 or "\n" in anchor:
            label += "…"
        return label

    def _find_anchor(text: str, old: str) -> list[int]:
        """Byte offsets of every non-overlapping occurrence of `old` in `text`."""
        hits: list[int] = []
        idx = text.find(old)
        while idx >= 0:
            hits.append(idx)
            idx = text.find(old, idx + len(old))
        return hits

    def _offset_line(text: str, offset: int) -> int:
        return text.count("\n", 0, offset) + 1

    def edit(path, old, new=None, *, count: int | None = 1, guard: bool = True) -> dict:
        """Anchor-asserted in-place file edit; every anchor is an exact literal substring.

        Two forms:
          edit(path, old, new, count=1)   — `old` must occur exactly `count`
              times (count=None → any number >= 1); all occurrences replaced.
          edit(path, replacements)        — replacements is a sequence of
              (old, new) pairs or a mapping {old: new}; each anchor must occur
              exactly once. ATOMIC: all anchors resolve against the original
              text or nothing is written.

        Fewer matches than expected → AnchorNotFoundError; more →
        AmbiguousAnchorError listing match line numbers. The file is re-read
        fresh, and StaleWriteError raises first if it changed on disk since the
        kernel's last read (guard=False bypasses).
        """
        p = _resolve_proto_path(path)
        if not p.exists():
            raise FileNotFoundError(f"edit({p}): file does not exist")

        if isinstance(old, str):
            if not isinstance(new, str):
                raise TypeError(f"edit({p}): new must be a str when old is a str, got {type(new).__name__}")
            if count is not None and (not isinstance(count, int) or isinstance(count, bool) or count < 1):
                raise ValueError(f"edit({p}): count must be an integer >= 1 or None (replace all), got {count!r}")
            pairs = [(old, new)]
            single = True
        else:
            if new is not None:
                raise TypeError(f"edit({p}): pass replacements as ONE sequence/mapping argument, without `new`")
            if count != 1:
                raise ValueError(f"edit({p}): count applies to the single-anchor form only")
            items = old.items() if hasattr(old, "items") else old
            pairs = [(o, n) for o, n in items]
            if not pairs:
                raise ValueError(f"edit({p}): empty replacements")
            single = False
        for o, n in pairs:
            if not isinstance(o, str) or not isinstance(n, str):
                raise TypeError(f"edit({p}): anchors and replacements must be str")
            if o == "":
                raise ValueError(f"edit({p}): empty anchor")
            if o == n:
                raise ValueError(f"edit({p}): anchor and replacement are identical: {_anchor_label(o)}")

        _check_stale(p, guard, "edit")
        text = p.read_text(encoding="utf-8")

        # Locate every hunk on the ORIGINAL text; nothing is written unless all resolve.
        expected = count if single else 1
        splices: list[tuple[int, int, str, str]] = []  # (start, end, new, anchor)
        for o, n in pairs:
            hits = _find_anchor(text, o)
            found = len(hits)
            lines = ", ".join(str(_offset_line(text, h)) for h in hits)
            if found == 0:
                raise AnchorNotFoundError(
                    f"edit({p}): anchor not found: {_anchor_label(o)}"
                    + (f" (expected {expected} occurrence(s))" if expected not in (None, 1) else "")
                    + "; re-read the file — the anchor must match the current content exactly, whitespace included"
                )
            if expected is not None and found < expected:
                raise AnchorNotFoundError(
                    f"edit({p}): anchor {_anchor_label(o)} found {found} time(s) at line(s) {lines}, "
                    f"expected {expected}"
                )
            if expected is not None and found > expected:
                raise AmbiguousAnchorError(
                    f"edit({p}): anchor {_anchor_label(o)} matches {found} times at lines {lines}, "
                    f"expected {expected}; enlarge the anchor to make it unique, or pass count={found} "
                    f"(or count=None) to replace every occurrence"
                )
            for h in hits:
                splices.append((h, h + len(o), n, o))

        splices.sort(key=lambda s: s[0])
        for (a_start, a_end, _, a_old), (b_start, _, _, b_old) in zip(splices, splices[1:]):
            if b_start < a_end:
                raise ValueError(
                    f"edit({p}): overlapping anchors {_anchor_label(a_old)} (line "
                    f"{_offset_line(text, a_start)}) and {_anchor_label(b_old)} (line "
                    f"{_offset_line(text, b_start)})"
                )

        hunks = []
        parts: list[str] = []
        cursor = 0
        for s_start, s_end, s_new, s_old in splices:
            parts.append(text[cursor:s_start])
            parts.append(s_new)
            cursor = s_end
            hunks.append({"line": _offset_line(text, s_start), "anchor": _anchor_label(s_old)})
        parts.append(text[cursor:])
        result = "".join(parts)

        p.write_text(result, encoding="utf-8")
        _rearm_read_guard(p)
        _emit_file_status("write", p, before=text, after=result)
        return {
            "path": str(p),
            "replacements": len(splices),
            "hunks": hunks,
            "chars_before": len(text),
            "chars_after": len(result),
        }

    def _block_range_on(path_str: str, code: str, line: int):
        """Resolve a syntactic block extent via the host ast bridge (1-based lines)."""
        if not isinstance(line, int) or isinstance(line, bool) or line < 1:
            raise ValueError(f"block line must be an integer >= 1, got {line!r}")
        result = _bridge_call("__ast__", {"op": "block_range", "path": path_str, "code": code, "line": line})
        if result is None:
            return None
        if isinstance(result, dict) and "start" in result and "end" in result:
            return (int(result["start"]), int(result["end"]))
        raise RuntimeError(f"unexpected block_range result: {result!r}")

    def block_range(path: str | Path, line: int) -> tuple[int, int] | None:
        """Syntactic block extent (start, end) containing 1-based `line`, resolved by tree-sitter."""
        p = _resolve_proto_path(path)
        return _block_range_on(str(p), p.read_text(encoding="utf-8"), line)

    def symbols(path: str | Path | None = None, *, code: str | None = None, lang: str | None = None) -> str:
        """Structural outline (declarations, bodies elided) of a file or a code string.

        symbols(path)                 — outline a file on disk.
        symbols(code=src, lang="py")  — outline an in-memory string, e.g. to
            validate structure BEFORE write(); lang ("py", "ts", ...) is
            required when there's no path to infer it from.
        """
        if (path is None) == (code is None):
            raise ValueError("symbols() takes exactly one of `path` or `code=`")
        args: dict = {"op": "symbols"}
        if path is not None:
            p = _resolve_proto_path(path)
            args["path"] = str(p)
            args["code"] = p.read_text(encoding="utf-8")
            label = str(p)
        else:
            if not isinstance(code, str):
                raise TypeError(f"symbols() code must be a str, got {type(code).__name__}")
            args["code"] = code
            label = f"<code lang={lang}>" if lang else "<code>"
        if lang is not None:
            args["lang"] = lang
        result = _bridge_call("__ast__", args)
        segments = result.get("segments") if isinstance(result, dict) else None
        if not segments:
            hint = "" if path is not None or lang is not None else ' (pass lang=, e.g. lang="python")'
            return f"<no symbols parsed for {label}{hint}>"
        lines = []
        for seg in segments:
            text = (seg.get("text") or "").strip()
            seg_label = text if text else f"<{seg.get('kind', 'segment')}>"
            lines.append(f"{seg.get('startLine')}-{seg.get('endLine')}: {seg_label}")
        return "\n".join(lines)

    def output(
        *ids: str,
        format: str = "raw",
        query: str | None = None,
        offset: int | None = None,
        limit: int | None = None,
    ) -> str | dict | list[dict]:
        """Read task/agent output by ID. Returns text or JSON depending on format.

        Args:
            *ids: Output IDs to read (e.g., 'scout_0', 'reviewer_1')
            format: 'raw' (default), 'json' (dict with metadata), 'stripped' (no ANSI)
            query: jq-like query for JSON outputs (e.g., '.endpoints[0].file')
            offset: Line number to start reading from (1-indexed)
            limit: Maximum number of lines to read

        Returns:
            Single ID: str (format='raw'/'stripped') or dict (format='json')
            Multiple IDs: list of dict with 'id' and 'content'/'data' keys

        Examples:
            output('scout_0')  # Read as raw text
            output('reviewer_0', format='json')  # Read with metadata
            output('scout_0', query='.files[0]')  # Extract JSON field
            output('scout_0', offset=10, limit=20)  # Lines 10-29
            output('scout_0', 'reviewer_1')  # Read multiple outputs
        """
        artifacts_dir = os.environ.get("PI_ARTIFACTS_DIR")
        if not artifacts_dir:
            session_file = os.environ.get("PI_SESSION_FILE")
            if not session_file:
                _emit_status("output", error="No session file available")
                raise RuntimeError("No session - output artifacts unavailable")
            artifacts_dir = session_file.rsplit(".", 1)[0]
        if not Path(artifacts_dir).exists():
            _emit_status(
                "output", error="Artifacts directory not found", path=artifacts_dir
            )
            raise RuntimeError(f"No artifacts directory found: {artifacts_dir}")

        if not ids:
            _emit_status("output", error="No IDs provided")
            raise ValueError("At least one output ID is required")

        if query and (offset is not None or limit is not None):
            _emit_status("output", error="query cannot be combined with offset/limit")
            raise ValueError("query cannot be combined with offset/limit")

        results: list[dict] = []
        not_found: list[str] = []

        for output_id in ids:
            output_path = Path(artifacts_dir) / f"{output_id}.md"
            if not output_path.exists():
                not_found.append(output_id)
                continue

            raw_content = output_path.read_text(encoding="utf-8")
            raw_lines = raw_content.splitlines()
            total_lines = len(raw_lines)

            selected_content = raw_content
            range_info: dict | None = None

            if query:
                try:
                    json_value = json.loads(raw_content)
                except json.JSONDecodeError as e:
                    _emit_status("output", id=output_id, error=f"Not valid JSON: {e}")
                    raise ValueError(f"Output {output_id} is not valid JSON: {e}")

                result_value = _apply_query(json_value, query)
                try:
                    selected_content = (
                        json.dumps(result_value, indent=2)
                        if result_value is not None
                        else "null"
                    )
                except (TypeError, ValueError):
                    selected_content = str(result_value)

            elif offset is not None or limit is not None:
                start_line = max(1, offset or 1)
                if start_line > total_lines:
                    _emit_status(
                        "output",
                        id=output_id,
                        error=f"Offset {start_line} beyond end ({total_lines} lines)",
                    )
                    raise ValueError(
                        f"Offset {start_line} is beyond end of output ({total_lines} lines) for {output_id}"
                    )

                effective_limit = (
                    limit if limit is not None else total_lines - start_line + 1
                )
                end_line = min(total_lines, start_line + effective_limit - 1)
                selected_lines = raw_lines[start_line - 1 : end_line]
                selected_content = "\n".join(selected_lines)
                range_info = {
                    "start_line": start_line,
                    "end_line": end_line,
                    "total_lines": total_lines,
                }

            if format == "stripped":
                selected_content = re.sub(r"\x1b\[[0-9;]*m", "", selected_content)

            if format == "json":
                result_data = {
                    "id": output_id,
                    "path": str(output_path),
                    "line_count": total_lines
                    if not query
                    else len(selected_content.splitlines()),
                    "char_count": len(raw_content)
                    if not query
                    else len(selected_content),
                    "content": selected_content,
                }
                if range_info:
                    result_data["range"] = range_info
                if query:
                    result_data["query"] = query
                results.append(result_data)
            else:
                results.append({"id": output_id, "content": selected_content})

        if not_found:
            available = sorted([f.stem for f in Path(artifacts_dir).glob("*.md")])
            error_msg = f"Output not found: {', '.join(not_found)}"
            if available:
                error_msg += f"\n\nAvailable outputs: {', '.join(available[:20])}"
                if len(available) > 20:
                    error_msg += f" (and {len(available) - 20} more)"
            _emit_status("output", not_found=not_found, available_count=len(available))
            raise FileNotFoundError(error_msg)

        if len(ids) == 1:
            if format == "json":
                _emit_status("output", id=ids[0], chars=results[0]["char_count"])
                return results[0]
            _emit_status("output", id=ids[0], chars=len(results[0]["content"]))
            return results[0]["content"]

        if format == "json":
            total_chars = sum(r["char_count"] for r in results)
            _emit_status("output", count=len(results), total_chars=total_chars)
            return results

        combined_output: list[dict] = []
        for r in results:
            combined_output.append({"id": r["id"], "content": r["content"]})
        total_chars = sum(len(r["content"]) for r in combined_output)
        _emit_status("output", count=len(combined_output), total_chars=total_chars)
        return combined_output

    def _apply_query(data: object, query: str) -> object:
        """Apply jq-like query to data. Supports .key, [index], and chaining."""
        if not query:
            return data

        query = query.strip()
        if query.startswith("."):
            query = query[1:]
        if not query:
            return data

        tokens = []
        current_token = ""
        i = 0
        while i < len(query):
            ch = query[i]
            if ch == ".":
                if current_token:
                    tokens.append(("key", current_token))
                    current_token = ""
            elif ch == "[":
                if current_token:
                    tokens.append(("key", current_token))
                    current_token = ""
                j = i + 1
                while j < len(query) and query[j] != "]":
                    j += 1
                bracket_content = query[i + 1 : j]
                if bracket_content.startswith('"') and bracket_content.endswith('"'):
                    tokens.append(("key", bracket_content[1:-1]))
                else:
                    tokens.append(("index", int(bracket_content)))
                i = j
            else:
                current_token += ch
            i += 1
        if current_token:
            tokens.append(("key", current_token))

        current = data
        for token_type, value in tokens:
            if token_type == "index":
                if not isinstance(current, list) or value >= len(current):
                    return None
                current = current[value]
            elif token_type == "key":
                if not isinstance(current, dict) or value not in current:
                    return None
                current = current[value]

        return current

    def _tool_proxy_from_env() -> tuple[str, str, str]:
        base = os.environ.get("PI_TOOL_BRIDGE_URL")
        token = os.environ.get("PI_TOOL_BRIDGE_TOKEN")
        session = os.environ.get("PI_TOOL_BRIDGE_SESSION")
        if not base or not token or not session:
            raise RuntimeError("tool bridge is unavailable in this kernel")
        return (base.rstrip("/"), token, session)

    import urllib.error, urllib.request

    _BRIDGE_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def _bridge_call(name: str, args: dict):
        """POST one request to the host tool bridge and return its `value`."""
        base, token, session = _tool_proxy_from_env()
        _run_id_getter = globals().get("__proto_current_run_id__")
        _run_id = (
            _run_id_getter()
            if callable(_run_id_getter)
            else globals().get("__proto_run_id__")
        )
        payload = json.dumps(
            {"session": session, "run": _run_id, "name": name, "args": args}
        ).encode("utf-8")
        req = urllib.request.Request(
            f"{base}/v1/tool",
            data=payload,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {token}",
            },
        )
        try:
            with _BRIDGE_OPENER.open(req) as resp:
                body = resp.read()
        except urllib.error.HTTPError as exc:
            body = exc.read()
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            raise RuntimeError(
                f"bridge call {name!r}: non-JSON response: {body[:200]!r}"
            ) from None
        if not isinstance(data, dict) or not data.get("ok"):
            msg = (data or {}).get("error") if isinstance(data, dict) else None
            raise RuntimeError(msg or f"bridge call {name!r} failed")
        return data.get("value")

    class _ToolCallable:
        """Invokes one host-side tool via the loopback HTTP bridge."""

        __slots__ = ("_name",)

        def __init__(self, name: str):
            self._name = name

        def __repr__(self) -> str:
            return f"<tool.{self._name}>"

        def __call__(self, args=None, /, **kwargs):
            if args is None:
                merged: dict = {}
            elif isinstance(args, dict):
                merged = dict(args)
            else:
                raise TypeError(
                    f"tool.{self._name}(...) expects a dict of arguments (got {type(args).__name__})"
                )
            merged.update(kwargs)
            if INTENT_FIELD not in merged:
                merged[INTENT_FIELD] = "py prelude"
            return _bridge_call(self._name, merged)

    class _ToolProxy:
        """`tool.<name>(args)` proxy mirroring the JS runtime bridge."""

        __slots__ = ()

        def __getattr__(self, name: str) -> _ToolCallable:
            if name.startswith("_"):
                raise AttributeError(name)
            return _ToolCallable(name)

        def __getitem__(self, name: str) -> _ToolCallable:
            return _ToolCallable(name)

        def __repr__(self) -> str:
            session = os.environ.get("PI_TOOL_BRIDGE_SESSION")
            return (
                f"<tool proxy session={session}>"
                if session
                else "<tool proxy unavailable>"
            )

    tool = _ToolProxy()

    def completion(prompt, *, model="default", system=None, schema=None):
        """Oneshot, stateless completion against a model tier.

        `model` selects a tier: "smol", "default" (the session's active model),
        or "slow". Pass `system` for a system prompt. Pass a JSON-Schema dict
        as `schema` to force a structured response; the parsed object is then
        returned instead of the completion text.
        """
        args = {"prompt": prompt, "model": model}
        if system is not None:
            args["system"] = system
        if schema is not None:
            args["schema"] = schema
        res = _bridge_call("__completion__", args)
        text = res.get("text") if isinstance(res, dict) else res
        return json.loads(text) if schema is not None else text

    def agent(
        prompt,
        *,
        agent=None,
        label=None,
        schema=None,
        schema_mode=None,
        isolated=None,
        apply=None,
        merge=None,
        handle=False,
    ):
        """Run a subagent and return its final output or structured data.

        `schema` overrides agent and session schemas. `schema_mode` is
        `"permissive"` or `"strict"`. `handle=True` returns the child output
        reference and metadata, with parsed data under `"data"` when available.
        """
        args = {"prompt": prompt}
        if agent is not None:
            args["agent"] = agent
        if label is not None:
            args["label"] = label
        if schema is not None:
            args["schema"] = schema
        if schema_mode is not None:
            args["schemaMode"] = schema_mode
        if isolated is not None:
            args["isolated"] = bool(isolated)
        if apply is not None:
            args["apply"] = bool(apply)
        if merge is not None:
            args["merge"] = bool(merge)
        if handle:
            args["handle"] = True
        res = _bridge_call("__agent__", args)
        text = res.get("text") if isinstance(res, dict) else res
        has_data = isinstance(res, dict) and "data" in res
        parsed = res["data"] if has_data else json.loads(text) if schema is not None else text
        if not handle:
            return parsed
        details = res.get("details") if isinstance(res, dict) else None
        if not isinstance(details, dict) or details.get("id") is None:
            return {
                "text": text,
                "output": text,
                "handle": None,
                "id": None,
                "agent": None,
            }
        node = {
            "text": text,
            "output": text,
            "handle": f"agent://{details['id']}",
            "id": details["id"],
            "agent": details.get("agent"),
        }
        if has_data or schema is not None:
            node["data"] = parsed
        for src_key, dst_key in (
            ("isolated", "isolated"),
            ("patchPath", "patch_path"),
            ("branchName", "branch_name"),
            ("nestedPatches", "nested_patches"),
            ("changesApplied", "changes_applied"),
            ("isolationSummary", "isolation_summary"),
        ):
            if src_key in details:
                node[dst_key] = details[src_key]
        return node

    def _concurrency_limit():
        """Worker-pool ceiling from the host ``orchestrator.maxConcurrency`` setting.

        An eval fan-out runs as wide as a ``task`` batch would. Returns ``0`` for
        unbounded (run every item at once); falls back to ``0`` if the host
        bridge is unreachable.
        """
        try:
            snap = _bridge_call("__concurrency__", {}) or {}
            n = int(snap.get("limit") or 0)
        except Exception:
            return 0
        return n if n > 0 else 0

    class _AwaitableList(list):
        """Completed list result accepted by both sync and ``await`` syntax."""

        def __await__(self):
            yield from ()
            return self


    def _pool_map(items, fn):
        """Run ``fn`` over ``items`` through a bounded thread pool.

        Preserves input order, barriers until every task settles, and raises the
        lowest-index exception if any task failed. Each task runs inside a copy
        of the submitting thread's context so the ``_CURRENT_RID`` ContextVar
        propagates and bridge calls (agent(), tool.*, etc.) keep working. The
        pool width tracks ``orchestrator.maxConcurrency`` (0 = run every item at once).
        """
        import concurrent.futures, contextvars

        items = list(items)
        if not items:
            return _AwaitableList()
        limit = _concurrency_limit()
        workers = min(limit, len(items)) if limit > 0 else len(items)
        results = _AwaitableList(None for _ in items)
        errors = {}
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=workers)
        try:
            futures = {}
            for i, item in enumerate(items):
                ctx = contextvars.copy_context()
                futures[pool.submit(ctx.run, fn, item)] = i
            for fut in concurrent.futures.as_completed(futures):
                i = futures[fut]
                try:
                    results[i] = fut.result()
                except BaseException as exc:
                    errors[i] = exc
        except BaseException:
            # Interrupted (cell timeout / abort) while waiting. A `with` block
            # would join every worker first — threads blocked in a bridge call
            # can't be interrupted, so the cell would hang past the host's
            # escalation deadline and the whole kernel would be killed. Let
            # the workers drain in the background instead.
            pool.shutdown(wait=False, cancel_futures=True)
            raise
        pool.shutdown(wait=True)
        if errors:
            raise errors[min(errors)]
        return results

    def parallel(thunks):
        """Run zero-arg callables through a bounded pool, preserving input order.

        Barriers until all finish; re-raises the lowest-index exception if any
        thunk raised. Pool width tracks the task tool's ``orchestrator.maxConcurrency``.
        """
        thunks = list(thunks)
        for t in thunks:
            if not callable(t):
                raise TypeError("parallel() expects an iterable of zero-arg callables")
        return _pool_map(thunks, lambda t: t())

    def pipeline(items, *stages):
        """Map items left-to-right through one-arg stage callables.

        Every item clears stage N before any item enters stage N+1 (barrier per
        stage). Stage 1 receives the original item; later stages receive the
        previous stage's result. Pool width tracks ``orchestrator.maxConcurrency``.
        """
        current = _AwaitableList(items)
        for stage in stages:
            if not callable(stage):
                raise TypeError("pipeline() stages must be callables")
            current = _pool_map(current, stage)
        return current

    def log(message):
        """Emit a status ``log`` event for TUI rendering."""
        _emit_status("log", message=str(message))
        return None

    def phase(title):
        """Record the current readable phase and emit a status ``phase`` event."""
        globals()["__proto_current_phase__"] = str(title)
        _emit_status("phase", title=str(title))
        return None

    class _Budget:
        """Live view of the host Goal Mode token budget via the host bridge."""

        @property
        def total(self):
            snap = _bridge_call("__budget__", {})
            return (snap or {}).get("total")

        @property
        def hard(self):
            snap = _bridge_call("__budget__", {})
            return bool((snap or {}).get("hard"))

        def spent(self):
            snap = _bridge_call("__budget__", {})
            return int((snap or {}).get("spent") or 0)

        def remaining(self):
            snap = _bridge_call("__budget__", {}) or {}
            total = snap.get("total")
            if total is None:
                return math.inf
            return max(0, total - int(snap.get("spent") or 0))

        def __repr__(self):
            try:
                snap = _bridge_call("__budget__", {}) or {}
                return f"<budget total={snap.get('total')} spent={snap.get('spent')}>"
            except Exception:
                return "<budget unavailable>"

    budget = _Budget()
