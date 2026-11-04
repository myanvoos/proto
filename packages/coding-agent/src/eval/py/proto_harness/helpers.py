"""Canonical explicit harness helpers; no user-global installation or file hooks."""
from __future__ import annotations

from pathlib import Path
import os, json, math, re, hashlib, time, base64, itertools
from . import fs

INTENT_FIELD = "i"
_completion_invocations = itertools.count()


def _emit_status(op, **data):
    return _bridge_call("status", {"op": op, **data})


def display(value):
    from . import _client
    from ._display import _mime_bundle, _safe_display_json
    native = getattr(_client, "_runtime", {}).get("display")
    if isinstance(value, str):
        bundle = {"text/plain": value}
    elif isinstance(value, (dict, list, tuple)) and not any(
        hasattr(value, attr) for attr in ("_repr_mimebundle_", "_repr_html_", "_repr_json_", "_repr_png_")
    ):
        bundle = {"application/json": value, "text/plain": repr(value)}
    else:
        if native is not None:
            return native(value)
        bundle = _mime_bundle(value)
    if native is not None:
        return native(bundle, raw=True)
    if "application/json" in bundle:
        bundle["application/json"] = _safe_display_json(bundle["application/json"])
    return _client.request("display", {"bundle": bundle})


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

def _filesystem_path(path: str | Path) -> Path:
    if isinstance(path, str) and re.match(r"^[a-z][a-z0-9+.-]*://", path, re.IGNORECASE):
        raise ValueError("Expected a filesystem path; use tool.read for internal resources or pass a bash-resolved path through env.")
    return Path(os.path.abspath(os.path.expanduser(path)))

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
    p = _filesystem_path(path)
    return _block_range_on(str(p), fs.read_text(p), line)

def symbols(path: str | Path | None = None, *, code: str | None = None, lang: str | None = None) -> str:
    """Structural outline (declarations, bodies elided) of a file or a code string.

    symbols(path)                 — outline a file on disk.
    symbols(code=src, lang="py")  — outline an in-memory string, e.g. to
        validate structure BEFORE writing; lang ("py", "ts", ...) is
        required when there's no path to infer it from.
    """
    if (path is None) == (code is None):
        raise ValueError("symbols() takes exactly one of `path` or `code=`")
    args: dict = {"op": "symbols"}
    if path is not None:
        p = _filesystem_path(path)
        args["path"] = str(p)
        args["code"] = fs.read_text(p)
        label = str(p)
    else:
        if not isinstance(code, str):
            raise TypeError(f"symbols() code must be a str, got {type(code).__name__}")
        args["code"] = code
        label = f"<code lang={lang}>" if lang else "<code>"
    if lang is not None:
        args["lang"] = lang
    result = _bridge_call("__ast__", args)
    # An unparsed result (no lang, unknown lang, unsupported file type) carries the source
    # verbatim as one segment; that is not an outline.
    segments = result.get("segments") if isinstance(result, dict) and result.get("parsed") is True else None
    if not segments:
        hint = "" if path is not None or lang is not None else ' (pass lang=, e.g. lang="python")'
        return f"<no symbols parsed for {label}{hint}>"
    lines = []
    for seg in segments:
        text = (seg.get("text") or "").rstrip()
        seg_label = text if text else f"<{seg.get('kind', 'segment')}>"
        lines.append(f"{seg.get('startLine')}-{seg.get('endLine')}: {seg_label}")
    return "\n".join(lines)

def _bridge_call(name: str, args: dict, completion_invocation_id=None):
    from ._client import request
    task_signal().check()
    if completion_invocation_id is not None:
        args = {**args, "_completionInvocationId": completion_invocation_id}
    return request(name, args)


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
            merged[INTENT_FIELD] = "Python harness"
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
        return "<proto_harness.tool>"

tool = _ToolProxy()

def completion(prompt, *, model="default", system=None, schema=None):
    """Oneshot, stateless completion against a model tier or a named model.

    `model` takes a tier — "smol", "default" (the session's active model),
    or "slow" — or a model id from the session's pool. A bare id resolves
    only when a single provider offers it; when several do, qualify it as
    "provider/id". Pass `system` for a system prompt. Pass a JSON-Schema
    dict as `schema` to force a structured response; the parsed object is
    then returned instead of the completion text.
    """
    args = {"prompt": prompt, "model": model}
    if system is not None:
        args["system"] = system
    if schema is not None:
        args["schema"] = schema
    from . import _client
    next_invocation = getattr(_client, "_runtime", {}).get("next_completion_invocation")
    invocation = next_invocation() if next_invocation is not None else str(next(_completion_invocations))
    res = _bridge_call("__completion__", args, invocation)
    text = res.get("text") if isinstance(res, dict) else res
    return json.loads(text) if schema is not None else text

def agent(
    prompt,
    *,
    agent=None,
    model=None,
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
    `"permissive"` or `"strict"`. `model` overrides the worker's model
    (role alias like `@worker` or concrete id); it is validated against
    the effective role's model bank when one is configured. `handle=True` returns the child output
    reference and metadata, with parsed data under `"data"` when available.
    """
    args = {"prompt": prompt}
    if agent is not None:
        args["agent"] = agent
    if model is not None:
        args["model"] = model
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
        ("nestedPatchPaths", "nested_patch_paths"),
        ("changesApplied", "changes_applied"),
        ("isolationSummary", "isolation_summary"),
    ):
        if src_key in details:
            node[dst_key] = details[src_key]
    return node

def _concurrency_limit():
    """Worker-pool ceiling from the host ``orchestrator.maxConcurrency`` setting.

    An eval fan-out runs as wide as a ``task`` batch would. Returns ``0`` for
    unbounded (run every item at once). Admission or transport failures surface
    rather than silently enabling unbounded work.
    """
    snap = _bridge_call("__concurrency__", {}) or {}
    n = int(snap.get("limit") or 0)
    return n if n > 0 else 0

class _AwaitableList(list):
    """Completed list result accepted by both sync and ``await`` syntax."""

    def __await__(self):
        yield from ()
        return self


import concurrent.futures, contextvars

_ITEM_SIGNAL = contextvars.ContextVar("proto_item_signal", default=None)

class _ItemSignal:
    def __init__(self, parent=None, timeout=None):
        self.parent = parent
        self.deadline = time.monotonic() + timeout if timeout is not None else None

    def is_set(self):
        return bool(self.parent and self.parent.is_set()) or self.expired()

    def expired(self):
        return self.deadline is not None and time.monotonic() >= self.deadline

    def check(self):
        if self.parent and self.parent.is_set():
            raise concurrent.futures.CancelledError("Workflow item cancelled")
        if self.expired():
            raise TimeoutError("Workflow item deadline exceeded; cancellation is cooperative")

    def remaining(self):
        return max(0.001, self.deadline - time.monotonic()) if self.deadline is not None else None

def task_signal():
    """Cooperative current-item cancellation/deadline; call .check() in loops."""
    return _ITEM_SIGNAL.get() or _ItemSignal()

def _workflow_error(error):
    import traceback
    return {"name": type(error).__name__, "message": str(error),
            "stack": "".join(traceback.format_exception(type(error), error, error.__traceback__))}

class BatchError(RuntimeError):
    def __init__(self, results, callback_errors=None):
        self.results = results
        self.callback_errors = callback_errors or []
        failures = [row for row in results if row["status"] != "fulfilled"]
        super().__init__((failures or self.callback_errors)[0]["error"]["message"])

def _checkpoint_json(value):
    # JSON round trips must preserve types/keys, not coerce tuples or dict keys.
    active = set()
    def visit(item):
        if item is None or type(item) in (str, bool):
            return
        if type(item) is int:
            if abs(item) > 9007199254740991:
                raise TypeError("Checkpoint integers must be exactly representable by the JSON bridge")
            return
        if type(item) is float and math.isfinite(item):
            return
        if type(item) not in (list, dict) or id(item) in active:
            raise TypeError("Checkpoint results must be acyclic JSON values")
        active.add(id(item))
        try:
            if isinstance(item, dict):
                if any(type(key) is not str for key in item):
                    raise TypeError("Checkpoint object keys must be strings")
                children = item.values()
            else:
                children = item
            for child in children:
                visit(child)
        finally:
            active.remove(id(item))
    visit(value)
    return json.dumps(value, sort_keys=True, allow_nan=False, separators=(",", ":"))

def _checkpoint(path, key, value=None, *, save=False):
    if save:
        _checkpoint_json(value)
    return _bridge_call("__runtime__", {"op": "checkpoint_save" if save else "checkpoint_load",
        "path": str(_filesystem_path(path)), "key": key, **({"value": value} if save else {})})

def _workflow_options(items, *, concurrency=None, timeout=None, checkpoint=None, key=None,
                      keys=None, resume=False, **unused):
    if concurrency is not None and (type(concurrency) is not int or concurrency < 1):
        raise ValueError("concurrency must be a positive integer")
    if timeout is not None and (type(timeout) not in (int, float) or not math.isfinite(timeout) or timeout <= 0):
        raise ValueError("timeout must be positive finite seconds")
    if checkpoint is not None and (not isinstance(key, str) or not key):
        raise ValueError("checkpoint requires a non-empty workflow key; change it when code changes")
    if resume and checkpoint is None:
        raise ValueError("resume requires checkpoint")
    if keys is not None and (not isinstance(keys, (list, tuple)) or len(keys) != len(items)
                            or any(not isinstance(key, str) for key in keys) or len(set(keys)) != len(keys)):
        raise ValueError("keys must contain one unique string per item")

def _pool_map(items, fn, *, settled=False, concurrency=None, timeout=None, cancel=None,
              checkpoint=None, key=None, keys=None, resume=False, on_result=None, stage=0):
    """Drain running callbacks before return; deadlines require cooperative work."""
    items = list(items)
    _workflow_options(items, concurrency=concurrency, timeout=timeout, checkpoint=checkpoint,
                      key=key, keys=keys, resume=resume)
    if not items:
        return _AwaitableList()
    ceiling = _concurrency_limit()
    width = min(concurrency or len(items), ceiling or len(items), len(items))
    results = _AwaitableList(None for _ in items)
    parent = cancel if cancel is not None else _ITEM_SIGNAL.get()

    def invoke(index, item):
        signal = _ItemSignal(parent, timeout)
        token = _ITEM_SIGNAL.set(signal)
        state = {"stage": stage}
        identity = json.dumps([key, keys[index] if keys is not None else index, stage], separators=(",", ":"))
        try:
            signal.check()
            cached = _checkpoint(checkpoint, identity) if checkpoint is not None and resume else {"found": False}
            if cached["found"]:
                value = cached["value"]
                state["resumed"] = True
            else:
                value = fn(item, index, state)
                signal.check()
                if checkpoint is not None:
                    _checkpoint(checkpoint, identity, value, save=True)
            signal.check()
            result = {"status": "fulfilled", "value": value, "index": index, **state}
        except BaseException as error:
            try:
                signal.check()
            except (TimeoutError, concurrent.futures.CancelledError) as reason:
                error = reason
            status = "timed_out" if isinstance(error, TimeoutError) else "cancelled" if isinstance(error, concurrent.futures.CancelledError) else "rejected"
            result = {"status": status, "error": _workflow_error(error), "index": index, "stage": state["stage"]}
        finally:
            _ITEM_SIGNAL.reset(token)
        return result

    callback_errors = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=width) as pool:
        futures = {pool.submit(contextvars.copy_context().run, invoke, index, item): index for index, item in enumerate(items)}
        for future in concurrent.futures.as_completed(futures):
            index = futures[future]
            result = results[index] = future.result()
            if on_result is not None:
                try:
                    on_result(result)
                except BaseException as error:
                    callback_errors.append({"index": index, "stage": result["stage"], "error": _workflow_error(error)})
    if callback_errors or (not settled and any(row["status"] != "fulfilled" for row in results)):
        raise BatchError(results, callback_errors)
    return results if settled else _AwaitableList(row["value"] for row in results)

def parallel(thunks, **options):
    """Run zero-argument callables concurrently; results keep input order.

    Options (shared with pipeline): concurrency=N caps workers; settled=True
    returns {status, index, stage, value|error} rows instead of raising
    BatchError (whose .results keeps every row); timeout=seconds per item;
    cancel=threading.Event; on_result=callback(row). Deadlines are
    cooperative: long loops call task_signal().check(). checkpoint=dir +
    key=str save each successful JSON result, resume=True reuses them, and
    keys=[unique str per item] is required with checkpoint. No retries.
    """
    thunks = list(thunks)
    if any(not callable(thunk) for thunk in thunks):
        raise TypeError("parallel expects zero-argument callables")
    if options.get("checkpoint") is not None and options.get("keys") is None:
        raise ValueError("checkpointed parallel requires stable per-item keys")
    return _pool_map(thunks, lambda thunk, index, state: thunk(), **options)

def pipeline(items, *stages, streaming=False, **options):
    """Map items through stages (value -> value), keeping input order.

    Each stage waits for every item before the next starts; streaming=True
    advances each item independently. Options match parallel(); with
    checkpoint, keys default to a hash of each item.
    """
    if any(not callable(stage) for stage in stages):
        raise TypeError("pipeline stages must be callables")
    items = list(items)
    _workflow_options(items, **options)
    keys = options.pop("keys", None)
    if options.get("checkpoint") is not None and keys is None:
        keys = [hashlib.sha256(_checkpoint_json([index, item]).encode()).hexdigest() for index, item in enumerate(items)]
    settled = options.pop("settled", False)
    if streaming:
        def run_item(item, index, state):
            value = item
            for stage_index, stage_fn in enumerate(stages):
                state["stage"] = stage_index
                state.pop("resumed", None)
                task_signal().check()
                identity = json.dumps([options.get("key"), keys[index] if keys is not None else index, stage_index], separators=(",", ":"))
                root = options.get("checkpoint")
                cached = _checkpoint(root, identity) if root is not None and options.get("resume") else {"found": False}
                if cached["found"]:
                    value = cached["value"]
                    state["resumed"] = True
                else:
                    value = stage_fn(value)
                    task_signal().check()
                    if root is not None:
                        _checkpoint(root, identity, value, save=True)
            return value
        # Per-stage checkpoints, shared with barrier mode.
        inner = {name: value for name, value in options.items() if name not in ("checkpoint", "key", "resume")}
        return _pool_map(items, run_item, settled=settled, keys=keys, **inner)
    on_result = options.pop("on_result", None)
    callback_errors = []
    outcomes = [{"status": "fulfilled", "value": item, "index": index} for index, item in enumerate(items)]
    for stage_index, stage_fn in enumerate(stages):
        live = [row for row in outcomes if row["status"] == "fulfilled"]
        indices = [row["index"] for row in live]
        def notify(row):
            mapped = {**row, "index": indices[row["index"]]}
            if on_result is not None:
                try:
                    on_result(mapped)
                except BaseException as error:
                    callback_errors.append({"index": mapped["index"], "stage": stage_index, "error": _workflow_error(error)})
        batch = _pool_map([row["value"] for row in live], lambda value, index, state: stage_fn(value), settled=True,
                         keys=[keys[index] for index in indices] if keys is not None else None,
                         on_result=notify, stage=stage_index, **options)
        for index, row in zip(indices, batch):
            outcomes[index] = {**row, "index": index}
    if callback_errors or (not settled and any(row["status"] != "fulfilled" for row in outcomes)):
        raise BatchError(outcomes, callback_errors)
    return _AwaitableList(outcomes if settled else (row["value"] for row in outcomes))

def executions(id=None, *, limit=20):
    """Recent bash calls of this session: command, lane, timing, status, and
    per-stage captured streams. Captures are bounded: check `evicted`,
    `omittedAfter`, and each stream's `truncated`/`complete`. Stream
    artifacts hold captured previews; result artifacts hold the full output.
    """
    return _bridge_call("__runtime__", {"op": "executions", "limit": limit, **({"id": id} if id is not None else {})})

def _tool_execution_id(execution):
    identifier = execution.get("id") if isinstance(execution, dict) else execution
    if not isinstance(identifier, str) or not identifier:
        raise TypeError("execution must be a non-empty id or a start_tool handle")
    return identifier

def start_tool(name, args=None):
    """Start an owned tool execution without waiting for its result."""
    return _bridge_call("__runtime__", {"op": "events_start", "tool": name,
                                       "args": {} if args is None else args})

def tool_events(execution, *, cursor=0, limit=128, wait_ms=30000):
    """Yield {executionId, sequence, kind, data, terminal} events from `cursor`.

    A `gap` event marks evicted history; bounded payloads carry `omitted`.
    `result` holds the tool output; the terminal event ends iteration.
    Breaking out does not stop the tool: cancel_tool(), then dispose_tool().
    """
    identifier = _tool_execution_id(execution)
    while True:
        batch = _bridge_call("__runtime__", {"op": "events_read", "id": identifier,
                            "cursor": cursor, "limit": limit, "waitMs": wait_ms})
        gap = batch.get("gap")
        if gap is not None:
            yield {"executionId": identifier, "sequence": gap["to"], "kind": "gap",
                   "data": gap, "terminal": False}
        yield from batch["events"]
        cursor = batch["cursor"]
        if batch["done"]:
            return

def cancel_tool(execution, *, wait_ms=30000):
    """Cancel a start_tool() execution, waiting up to wait_ms for it to settle."""
    return _bridge_call("__runtime__", {"op": "events_cancel", "id": _tool_execution_id(execution),
                                       "waitMs": wait_ms})

def dispose_tool(execution):
    """Release a settled start_tool() execution and its retained events."""
    return _bridge_call("__runtime__", {"op": "events_dispose", "id": _tool_execution_id(execution)})

def _delegation_id(delegation):
    if isinstance(delegation, dict):
        delegation = delegation.get("lease", delegation)
        identifier = delegation.get("id") if isinstance(delegation, dict) else None
    else:
        identifier = delegation
    if not isinstance(identifier, str) or not identifier:
        raise TypeError("delegation must be a non-empty id or a delegate handle")
    return identifier

def delegate(grants, *, ttl_ms=None, max_concurrent=None, max_requests=None, expose=False):
    """Create a bounded, explicitly scoped lease for external clients.

    grants = [{"tool": name, "operations": [exact op values]}]; omit
    operations to grant every op. Not a sandbox. Launch the returned clients
    with launch_delegated(); expose=True only for manual launches. Never
    print capability files or tokens.
    """
    args = {"op": "delegation_create", "grants": grants, "expose": expose}
    for key, value in (("ttlMs", ttl_ms), ("maxConcurrent", max_concurrent), ("maxRequests", max_requests)):
        if value is not None:
            args[key] = value
    return _bridge_call("__runtime__", args)

def delegations():
    return _bridge_call("__runtime__", {"op": "delegation_list"})

def revoke_delegation(delegation):
    return _bridge_call("__runtime__", {"op": "delegation_revoke", "id": _delegation_id(delegation)})

def launch_delegated(delegation, *, name, application, args=None, cwd=None, env=None):
    """Start a supervised process that receives only this lease's capability."""
    request = {"op": "delegation_launch", "id": _delegation_id(delegation),
               "name": name, "application": application}
    for key, value in (("args", args), ("cwd", cwd), ("env", env)):
        if value is not None:
            request[key] = value
    return _bridge_call("__runtime__", request)

_ARTIFACT_VALUE_MISSING = object()

def publish_artifact(value=_ARTIFACT_VALUE_MISSING, *, kind="json", path=None, mime_type=None, encoding=None):
    """Publish immutable data; returns a ref dict
    {type, version, uri: "artifact://N", owner, mimeType, bytes, sha256}.

    kind: "json" (default), "text", or "binary" (required for bytes).
    `path` publishes a host file (not a remote kernel target's file).
    Handles survive kernel resets; session disposal revokes them.
    """
    request = {"op": "artifact_publish", "kind": kind}
    if value is not _ARTIFACT_VALUE_MISSING:
        if isinstance(value, (bytes, bytearray, memoryview)):
            if kind != "binary" or encoding not in (None, "base64"):
                raise TypeError("native bytes require kind='binary' and base64 encoding")
            value = base64.b64encode(value).decode("ascii")
            encoding = "base64"
        request["value"] = value
    for key, item in (("path", path), ("mimeType", mime_type), ("encoding", encoding)):
        if item is not None:
            request[key] = str(item) if key == "path" else item
    return _bridge_call("__runtime__", request)

def read_artifact(ref, *, offset=0, length=None, encoding=None):
    """Page an artifact this kernel published: {data, offset, bytes, eof, encoding, ref}.

    utf8 pages end on a character boundary; continue at offset + bytes.
    Non-UTF-8 content needs encoding="base64"; encoding="json" parses it.
    Bash/tool output artifacts: tool.read({"path": "artifact://N"}).
    """
    request = {"op": "artifact_read", "ref": ref, "offset": offset}
    if length is not None:
        request["length"] = length
    if encoding is not None:
        request["encoding"] = encoding
    return _bridge_call("__runtime__", request)

def resolve_artifact(ref):
    """Validate an artifact ref this session published and return it."""
    return _bridge_call("__runtime__", {"op": "artifact_resolve", "ref": ref})

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
