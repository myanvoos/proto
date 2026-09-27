# Bash tool runtime

This document describes the **`bash` tool** runtime path used by agent tool calls, from command normalization to execution, truncation/artifacts, and rendering.

It also calls out where behavior diverges in interactive TUI, print mode, RPC mode, and user-initiated bang (`!`) shell execution.

## Scope and runtime surfaces

There are two different bash execution surfaces in coding-agent:

1. **Tool-call surface** (`toolName: "bash"`): used when the model calls the bash tool.
   - Entry point: `BashTool.execute()`.
   - Parameters include `command`, optional `env`, `timeout`, `cwd`, `lane`, `pty`, and, when `async.enabled` is true, `async`.
2. **User bang-command surface** (`!cmd` from interactive input or RPC `bash` command): session-level helper path.
   - Entry point: `AgentSession.executeBash()`.

Both eventually use `executeBash()` in `src/exec/bash-executor.ts` for non-PTY execution, but only the tool-call path runs normalization/interception, optional managed background-job handling, and tool renderer logic.

Set `bash.enabled: false` in settings to remove the model-facing `bash` tool from the active tool registry. This does not disable user-initiated bang commands or RPC `bash` requests.

An explicit `cwd: "/"` selects the filesystem root. Relative `cwd` values resolve against the session directory; `~` selects the home directory. A leading `cd` remains a shell command, evaluated from that initial working directory; it preserves `OLDPWD`, shell expansion, and failure/short-circuit behavior.

## Internal URI arguments

The bash tool uses one pre-execution rewrite pass for literal internal URI arguments, environment values, and `cwd`. Each internal URI must resolve to a real filesystem path or fail with a teaching error directing the caller to `read`. This applies equally to Brush builtins (`rg`, `cat`, etc.) and external commands; it is not a per-builtin resolver. URLs constructed later by shell expansion are not reinterpreted.

`harness://` and documentation subdirectories such as `harness://tools/` resolve to real directories. Source checkouts use their existing docs tree without copying files or changing permissions. Embedded documentation and built-in rules are materialized as read-only files in a build-keyed cache. Skills and custom rules retain their original filesystem paths. For example, `rg -n approval harness://` searches the documentation corpus.

A trailing read selector is not part of the resource: `harness://bash.md:1-40` resolves `harness://bash.md` and keeps the selector on the path (`/…/bash.md:1-40`), so `protolens read` and other selector-aware consumers see the same address `read` accepts. Generated agent/history views and mounted-device resources without files are not passed off as local filenames: arguments of a `protolens` command reach the device as typed (`protolens read history://` works like the `read` tool), and anywhere else they fail with the `read` hint. Quoted JSON, embedded script text, and heredoc bodies remain data; their URI strings are not rewritten. External HTTP URLs remain unchanged.

## `protolens` as a Brush builtin

When xdev is enabled, model-facing Bash runs use the Brush shell parser and register `protolens` as a builtin. `protolens <tool> '<json>'` therefore composes with the same shell language as native commands: pipelines, `|&`, redirects, command substitutions, subshells/groups, loops, conditionals, `&&`/`||`, background jobs, and `pipefail` are parsed and executed by one runtime. The builtin receives the invocation-local working directory from each shell branch, so `(cd sub; protolens read '{"path":"file"}')` does not mutate the shared tool session; concurrent branches remain isolated.

The bridge maps successful text content to stdout and tool-error text to stderr; tool-execution errors use status `1`, CLI usage errors use `2`, and bridge/serialization failure uses `125`. Non-text content and `xdev` details travel in `protolensDispatches`, a structured side channel consumed by Bash rendering, never through stdout/stderr pipes. Native shell cancellation and deadlines cancel the bridge await; downstream pipe closure returns the shell's broken-pipe status. Bridge input is bounded to 1 MiB of stdin bytes; the builtin decodes those bytes as UTF-8 for dispatch.

`protolens` exists only inside the agent's Brush shell. Supervised processes, client terminal/PTY execution, user bang commands without the agent Bash dispatcher, and standalone external `bash` do not inherit it; they must not assume an `protolens` binary exists on `PATH`.

Without positional JSON, `protolens` parses its stdin as the argument object: `printf '%s' '{"path":"src"}' | protolens read`. A single positional JSON object takes precedence over piped stdin; `--json` cannot be combined with positional arguments. For a single-string device, bare stdin may instead be the plain payload. Non-empty text output ends with a newline so a following shell command starts on its own line. Shell settlement aborts outstanding tool dispatches, including deadline cancellation, rather than leaving detached tool work running.

## Persistent interpreter cells

The kernel bridge handles supported `python`/`python3`, `node`, and `bun` stdin and inline-code invocations as Bash kernel cells; see [Kernel-cell reference](#kernel-cell-reference) for the exact forms, API, and fallback rules. External fallback preserves stdin bytes even when the source is not UTF-8, leaving decoding and syntax errors to the interpreter. Empty `PATH` components search the shell's working directory, just as they do for other shell commands.

A bridge request belongs to its shell run from the start of backend availability checks. Cancellation or run disposal during those checks returns exit status `130` rather than launching a late cell or falling through to an external interpreter. Disposing one run does not stop the bridge for other live runs; disconnected clients cancel their own pending cell.

Inline-code invocations stream program stdin while the cell is running: the producer need not close before the consumer starts, and total input is not capped at 1 MiB. Transport chunks and in-flight buffers are bounded and backpressured. Python `sys.stdin.buffer` / `sys.stdout.buffer` and JavaScript `process.stdin` / `process.stdout` preserve arbitrary bytes through pipes and file redirection, including invalid UTF-8 and NUL. Text APIs still perform their normal encoding/decoding. Final-expression values, explicit displays, and harness notes remain visible as presentation sidebands but never enter stdout or stderr. Ordinary unassigned binary writes are safe in pipes and redirects without suppressing their return values. Model-visible Bash capture is text; use pipes, redirection, or artifact values to retain arbitrary bytes. Stdin-only interpreter invocations consume stdin as source code; `-c` / `-e` keeps source separate from program data.

Kernel stdout, stderr, and the final exit frame share one framed response stream; stdout/stderr frames preserve their destination through native redirection. Binary output uses byte-preserving frames; rich display metadata remains a separate channel, never binary pipeline payload. The bridge retains unwritten UTF-8 bytes across socket backpressure and closes only after the final frame is written, so slow readers do not receive truncated JSON or lose the command's exit status. The native reader scans incoming bytes incrementally rather than rescanning a growing frame, keeping large kernel output practical in shell pipelines.

## Kernel-cell reference

### Compatibility philosophy

**Native semantics within a cell. Persistent state between cells. Harness presentation outside program I/O.**

The kernel is an additive interpreter, not a notebook dialect. Ordinary programs keep their language semantics, argument vectors, byte streams, and exit statuses. Python `asyncio.run()` and main-module pickling work in ordinary synchronous cells; JavaScript declarations keep the selected interpreter's native binding behavior rather than being demoted to persistent assignments. Node lexical scope and temporal dead zones are preserved; Bun follows its own native source transforms, including its optimization-dependent class hoisting. Persistence, top-level await, tool calls, and rich displays add capabilities without requiring source workarounds. Differential regressions compare real interpreters with cells through the actual Bash route, including redirected bytes, file effects, and exit status; separate tests defend the additive features.

A persistent interpreter is deliberately **not a fresh OS process**. Bindings and explicitly retained async resources survive cells; `atexit` and Python thread/executor lifetimes belong to the kernel process rather than to each invocation. Python cells run synchronously without a host event loop unless they use top-level await. Ordinary cell-owned asyncio work settles before completion; `retain_task(task)` opts into background lifetime. JavaScript completion waits for referenced work; `retainTask(resource)` unrefs a resource to retain it across cells. Use a real subprocess when process isolation or interpreter teardown is itself the contract. Runtime errors never cause automatic replay through a fresh process: side effects may already have happened.

When the kernel bridge is available, Bash routes supported interpreter invocations to the retained language runtimes instead of spawning a fresh interpreter. Each recognized interpreter invocation is one cell; a single Bash command may contain several cells alongside ordinary shell syntax. The former structured cell fields (`language`, `code`, `title`, `timeout`, and `reset`) are not Bash parameters: the interpreter command supplies the language and source, and the enclosing Bash call supplies the timeout.

### Reproducing compatibility checks

From the repository root, compare native interpreters with the real Bash/kernel route, then exercise the compiled worker and its native addon in an isolated home:

```bash
bun test packages/coding-agent/src/tools/bash-interpreter-parity.test.ts
bun run --cwd=packages/coding-agent build
PROTO_COMPILED_KERNEL_TEST_BIN="$PWD/packages/coding-agent/dist/proto" \
  bun test packages/coding-agent/src/tools/bash-compiled-kernel.test.ts
```

The compiled test is opt-in so a stale `dist` binary cannot affect normal source tests. It checks exact program bytes, native self-spawn through `process.execPath`, callback completion, sideband display, and state reuse through the same stdio supervisor used for remote kernels. It does not provision or test an actual SSH/container target.

### Cell forms and API

Recognized cell forms are:

- `python`/`python3` with source on stdin, normally a quoted heredoc or a pipeline.
- `python -c '...' [args...]`, `node -e '...' [args...]`, or `bun -e '...' [args...]`. Program arguments stay in the kernel and populate native `sys.argv` / `process.argv`; JS `--` separates arguments from interpreter options.
- `python fleet://<name>.py` for a script staged under the internal `fleet://` URL.
- Ordinary script paths, `-m`, unsupported interpreter flags, and calls made without a bridge use an external interpreter. Supported stdin (`-`) and internal fleet scripts also accept program arguments.

A Python cell runs on the interpreter the shell itself would run for the command word. A Python 3 named by version (`python3.13`) or path (`.venv/bin/python`) dispatches to the same kernel builtin with that interpreter; one that does not exist fails exactly as the shell reports it. Bare `python`/`python3` follows the cell's own `PATH`, such as an activated venv or an exported `PATH`, when it selects a different interpreter than the host's `PATH`. An untouched shell, or a lane pinned with `protolens context --resource kernel --op start/reset --interpreter`, keeps the lane default: the pinned or `python.interpreter` setting, then project `.venv`/`venv`, then the managed environment, then `PATH`. A lane holds one Python kernel per interpreter, identified by the resolved binary plus its virtual environment, since a venv's `bin/python` symlinks to its base interpreter. An interpreter that is the default kernel's own maps to that kernel. An interpreter older than Python 3.10 cannot host the runner: the command runs as a plain process, and the session is told why once per interpreter.

For example:

```bash
python <<'PY'
from pathlib import Path
print(Path("package.json").read_text())
PY

node -e 'console.log("one persistent JavaScript cell")'
```

Every enabled runtime receives the cell prelude. Python helpers are synchronous and use keyword options; JavaScript bridge helpers are asynchronous where applicable and use one trailing options object. The shared API is:

- `display(value)` and `print(...)` for ordinary and rich output.
- `env(...)`, `output(...)`, and `tool.<name>(args)` for environment, agent/task-output, and normal session-tool access. `output()` reads agent/task outputs; use `read artifact://...` for Bash artifacts.
- Python `symbols(path?, code?=None, lang?=None)`, `defs()`, and `block_range(path, line)` for bounded source inspection. Both runtimes expose `defs()` and `kernel_state()` / `kernelState()` for binding provenance and safe runtime inspection.
- `completion(...)` for a stateless tool-free model call; `agent(...)` for a policy-checked subagent; and `parallel(...)`/`pipeline(...)` for bounded fan-out.
- `log(message)`, `phase(title)`, and `budget` for progress and the live turn budget.

`agent()` availability follows the current spawn policy, and `parallel()`/`pipeline()` width follows `orchestrator.maxConcurrency` (`0` means unbounded). Ordinary Python cells support `asyncio.run()` without an active host loop; top-level-`await` cells use the retained event loop and follow Python's normal restrictions on nested loop runners; JavaScript supports top-level `await` and bare `return`. The prelude also includes the stale-write guard and filesystem mutation/status tracking used by kernel edits; read before localized replacement and let the guard reject stale writes. The guard covers every destructive operation in both kernels — write-mode opens, `os.replace`/`rename`, `os.truncate` and `os.remove`/`unlink` — so the atomic write idiom is refused just like a direct overwrite when the file changed since the kernel read it. It is armed by the kernel's own reads; host-side observations (shell builtins and redirects, the read tool) only extend it to paths the kernel has never read and never refresh an existing record, because the kernel still holds the content it read. Each net-mutated path also prints one compact `<kernel> note:` line in the cell's own output, in Python and JavaScript alike.

### Filesystem paths in cells

Raw Python/JavaScript file APIs and path-taking kernel helpers use ordinary filesystem paths. Read internal resources with `tool.read`, or let bash resolve literal URI arguments and `env` values before execution. Cell source and heredoc bodies are not rewritten.

For a local Python cell, this bash input passes a resolved skill file without embedding its host path in code:

```json
{"command":"python -c 'print(Path(os.environ[\"INPUT\"]).read_text())'","env":{"INPUT":"skill://example/notes.md"}}
```

JavaScript cells can consume the same resolved environment value with `env("INPUT")`. In remote kernels, raw file APIs address the target while tool calls and bash-resolved paths address the host; transfer content explicitly instead of treating host paths as remote paths.

### Rich output

`display()` accepts JSON-compatible values, Markdown/text, and image values. Python MIME bundles support `application/json`, `text/markdown`, `text/plain`, HTML-to-Markdown conversion, PNG/JPEG images, and structured status events; common PIL, pandas, Plotly, and Matplotlib displays therefore remain available. Matplotlib figures render off-screen through the `Agg` backend. JavaScript object results become structured JSON and image records become image content.

Only program stdout/stderr enter Bash byte streams. Display text, final-expression values, JSON, images, filesystem receipts, and kernel status events stay on a separate presentation channel for rendering and replay, including with `2>&1`, pipes, redirects, and command substitutions. JSON display text included in the model-visible stream is capped at 8,000 characters per value; the structured result retains the value. Output truncation and artifact spill follow the Bash `OutputSink` rules described below.

### State and reset

- Python `python.kernelMode: session` (the default) reuses a kernel by session, normalized working directory, and interpreter; `per-call` starts and shuts down a fresh Python kernel for every cell. JavaScript uses a retained session-scoped VM. Python and JavaScript state are isolated from each other.
- Variables, imports, definitions, and explicitly retained async work survive later cells in the same retained runtime. Work completed before a cell error may remain. Separate workers have separate runtime ownership and namespaces even though they use the same Bash/kernel-cell surface.
- Python `%reset` clears the user namespace and re-injects the prelude for that Python kernel. Bash has no structured per-cell `reset` field; owner/session disposal, idle reaping, or a forced runtime shutdown starts a fresh kernel/VM. The discoverable `context` tool provides explicit kernel start, inspect, reset, close, and keepalive operations, plus whole-lane inspection and reset, from outside the executing cell.
- Retained runtimes are reaped after 15 minutes without activity when in session mode; active cells, resets/replacements, and in-flight bridges prevent reaping. The next cell starts fresh and reports a `kernel-idle-reap` status event. A dead retained runtime is replaced before execution; death during execution leaves completion uncertain and does not replay the cell. Check partial side effects before retrying. The next cell reports the changed generation and lost state.

Interactive terminal input is not supported by routed cells. For inline-code invocations, pipe or redirect program data and read `sys.stdin` / `process.stdin`; stdin-only invocations still interpret their stdin as code. Shell exports, inline assignments and tool `env` overrides reach the cell, and stderr remains redirectable separately.

### Timeouts and cancellation

The enclosing Bash `timeout` (see [CWD validation and timeout resolution](#3-cwd-validation-and-timeout-resolution)) is the only model-facing deadline for a kernel cell; a cell has no separate structured timeout field. If the command deadline or caller abort interrupts a Python cell, the runner receives `SIGINT` and normally remains reusable; if it cannot settle, the kernel is shut down and recreated. Interrupting JavaScript force-kills its VM, so variables from earlier cells are lost. The Bash shell session is likewise quarantined after a cancelled or timed-out run.

## Explicit kernel lifecycle and targets

Use `protolens context` from the Brush shell (or call the discoverable `context` tool directly) to manage a named language/lane without entering that kernel's execution queue:

```bash
protolens context '{"resource":"kernel","op":"list"}'
protolens context '{"resource":"kernel","op":"start","language":"python","lane":"analysis","interpreter":"/work/.venv/bin/python","cwd":"/work"}'
protolens context '{"resource":"kernel","op":"inspect","language":"python","lane":"analysis"}'
protolens context '{"resource":"kernel","op":"keepalive","language":"python","lane":"analysis","ttlMs":600000}'
protolens context '{"resource":"kernel","op":"reset","language":"python","lane":"analysis"}'
protolens context '{"resource":"kernel","op":"close","language":"python","lane":"analysis","force":true}'
```

The paths above must already exist. Execute subsequent interpreter cells with the matching Bash `lane`. Configuration belongs to the owner session and language/lane; changing an existing configuration requires `reset`, not silent replacement. Reset discards variables but retains the selected environment unless explicitly overridden. Close releases the runtime and forgets its lane configuration; subsequent implicit cells use local defaults, so explicitly start/configure a remote lane again before reuse. Closing busy work requires explicit `force:true`, which cancels it. Inspect/list and forced close remain available during an executing cell. Keepalive is a bounded lease (at most one hour), not an immortal kernel; owner disposal still closes owned runtimes.

Python and Bun kernels support local, existing-container, and SSH targets; Node kernels run on the local host only (use `bun` or `python` for SSH/container targets):

```bash
protolens context '{"resource":"kernel","op":"start","language":"python","lane":"container","target":{"kind":"container","engine":"docker","container":"devbox","cwd":"/work","interpreter":"python3"}}'
protolens context '{"resource":"kernel","op":"start","language":"bun","lane":"remote","target":{"kind":"ssh","host":"builder","cwd":"/work","hostCommand":["proto"]}}'
```

Containers must already be running under Docker or Podman. SSH uses existing noninteractive authentication/host configuration. Both target kinds require POSIX `sh`, `setsid -w`, and an absolute existing target working directory. The target needs its Python interpreter; Bun kernels need an installed compatible Proto CLI (`hostCommand`) using the same Bun version as the parent. The transport does not provision machines, install packages, silently run locally on failure, or forward ambient parent credentials. Target work retains persistent cells, binary streams, parent-session tool callbacks, and cancellation; shutdown cleans up owned target process groups.

**Filesystem boundary:** kernel file APIs, interpreter paths, and target `cwd` address the target. Brush commands around that cell and parent-session tools still run on the parent host. Artifact publication's `path` also addresses the parent. To upload a target file, read its bytes in the target kernel and publish the value; to download, read artifact pages and write the decoded bytes on the target. Bridge-backed `symbols(path)` and `block_range` read source through the target runtime, then send its text to the parent AST parser; target paths are not parent paths. Pass target source as `symbols(code=...)` when it is already in memory. Internal filesystem URLs such as `local://` are not mapped into remote kernels; use target-local paths. Nothing implicitly synchronizes workspaces.

## Live tool and background-job events

Python `start_tool(name, args)` / JavaScript `await startTool(name, args)` returns an owned execution handle without waiting for its final result. Consume `tool_events(handle, cursor=0, limit=128, wait_ms=30000)` or `for await (const event of toolEvents(handle, {cursor, limit, waitMs}))` while work runs:

```python
job = start_tool("bash", {"command": "printf 'ready\\n'; exit 7", "async": True})
for event in tool_events(job):
    print(event)
dispose_tool(job)
```

Events contain `executionId`, monotonic `sequence`, `kind`, `data`, and `terminal`. Updates and tool `result` are distinct; terminal `complete` follows settlement of owned managed background jobs, so an async Bash launch acknowledgement is not mistaken for completion. The final job result, including nonzero exit status, is available in job settlement data. Bounded retention makes overflow visible through `gap` events; resume using the last consumed sequence as `cursor` rather than assuming a complete transcript. Oversized payloads carry explicit omission metadata; retain bulk data as artifact values instead of treating the event feed as an unbounded result store.

Breaking an iterator does not cancel work. Use `cancel_tool(handle, wait_ms=...)` / `await cancelTool(handle, {waitMs})`; then `dispose_tool(handle)` / `await disposeTool(handle)` after settlement to release retained events. Cancelling the event execution also cancels its owned descendant jobs, not unrelated sibling work. Session disposal cancels owned subscriptions and work. A noncooperative callback is not falsely reported stopped merely because cancellation was requested.

## Immutable artifact values and rich completions

Use `publish_artifact(value, kind="json")` / `await publishArtifact(value, {kind:"json"})` to retain data without copying it into every model-visible result. `kind="text"` stores text; `kind="binary"` accepts native Python bytes or JavaScript `Uint8Array`, or base64 with `encoding="base64"`. `path` snapshots a parent-host file rather than creating a live reference.

The returned reference contains `type`, `version`, `uri`, `owner`, `mimeType`, byte count, and SHA-256. Files use the existing `artifact://` store. Handles are immutable, verified, and session-owned: changing the source file does not change the snapshot; tampered or foreign handles fail. Kernel reset preserves them, but session disposal revokes them. Restoring handle metadata in another session does not grant access.

`read_artifact(ref, offset=0, length=..., encoding="utf8")` / `await readArtifact(ref, {offset,length,encoding})` returns `{ref,offset,bytes,eof,encoding,data}`. Reads are bounded to 1 MiB per page; offsets and lengths are bytes, not text characters. UTF-8 pages end on a character boundary, so `bytes` can be less than `length`; continue at `offset + bytes`. Bytes that are not valid UTF-8 fail with an error; read binary data with `encoding="base64"`. `ref` may also be the bare `artifact://<id>` URI of an artifact this session published. `resolve_artifact(ref)` / `await resolveArtifact(ref)` validates the handle without returning its payload. Use explicit pages for large transfers.

`completion()` still accepts a string, and now also accepts a reference or an array of text/media parts and references:

```python
image = publish_artifact(Path("plot.png").read_bytes(), kind="binary", mime_type="image/png")
answer = completion([
    {"type": "text", "text": "Describe the trend and flag uncertainty."},
    image,
])
print(answer)
```

The active/selected model must support every input modality. Explicit media parts are `{type:"image"|"audio"|"video", data:<base64>, mimeType}` or `{type:..., artifact:ref}`; ordinary text is `{type:"text", text}`. MIME/byte consistency, content bounds, provider wire support, and image-detail options are validated before sending. Unsupported modalities fail rather than silently degrading to a text-only request. `system`, model selection, and schema-return behavior remain unchanged.

## Scoped access from ordinary scripts

External interpreters do not automatically receive prelude objects or `protolens`. Use explicit delegation rather than relying on private kernel transport credentials: it supplies thin Python/JavaScript clients with a revocable, expiring capability.

```python
lease = delegate([
    {"tool": "__completion__"},
    {"tool": "__runtime__", "operations": ["artifact_publish", "artifact_read", "artifact_resolve"]},
], ttl_ms=60000, max_concurrent=2, max_requests=20)
launch_delegated(lease, name="report", application="python3", args=["report.py"])
```

In the ordinary `report.py` script:

```python
from proto_session import SessionClient
session = SessionClient.from_env()
result = session.completion("Give a short heading for a test report.")
reference = session.publish_artifact({"heading": result})
print(reference)
```

`delegate` returns a lease snapshot and the packaged client paths. Python uses keyword options; JavaScript uses `{ttlMs,maxConcurrent,maxRequests,expose}`. JavaScript scripts import `SessionClient` from the returned client module and call `await SessionClient.fromEnv()`. Grants name exact tools, optionally exact `args.op` operations; special runtime grants permit artifact operations only, not recursive delegation. Execution, control, and agent tools are not delegable; artifact path publication is also denied. Use explicit data values and the managed launcher instead. Calls use the normal session tool/model policies.

`launch_delegated` / `launchDelegated` runs through the existing managed-process supervisor on the parent host and explicitly supplies that lease. For a manually launched script, request `expose=True` / `expose:true` and pass the returned launch environment; never print the capability file or token. Credentials are not automatically exported to arbitrary commands. `delegations()` lists leases; `revoke_delegation(lease)` / `await revokeDelegation(lease)` revokes future calls, cancels in-flight calls, and stops owned launched processes. Expiry and session disposal do the same. Request/concurrency limits are enforced and calls are never implicitly retried. This scopes bridge authority; it is not an OS/filesystem sandbox for code running as the same user.

## Selected data persistence

Save only explicit bindings, then restore them into a later Python, Node, or Bun kernel:

```python
summary = {"passed": 12, "failed": 0}
payload = b"\x00\x80\xff"
save_state("report-state.json", ["summary", "payload"])
```

After an explicit kernel reset, in a later cell:

```python
load_state("report-state.json")
```

JavaScript equivalents are `await saveState(path, ["summary", "payload"])` and `await loadState(path, {collision:"reject"})`. Python uses `load_state(path, collision="reject")`; explicit `"overwrite"` permits replacing colliding mutable user bindings. JavaScript restores through live binding setters so existing closures observe the restored value; `const`, imports, and prelude/reserved bindings cannot be overwritten. Read-only collisions reject the entire restore before any binding changes.

Snapshots are versioned, atomic files containing bounded acyclic plain data, bytes, and artifact-reference metadata; the recorded language and interpreter are provenance only. Python, Node, and Bun kernels restore each other's snapshots. Within a language every byte type round-trips; across languages Python `bytes`/`bytearray` restore as a JavaScript `Buffer`, and `Buffer`/`Uint8Array`/`ArrayBuffer` restore as Python `bytes`. Python integers beyond ±(2^53−1) restore exactly in Python and fail to load in JavaScript instead of rounding. Binding names must be valid, non-reserved identifiers in the loading language. Selection addresses published top-level kernel bindings, including JavaScript lexical bindings; it cannot address variables local to user-defined functions. Restore validates the entire snapshot and every collision before changing any binding. Unsupported objects, functions, getters/proxies, cycles, nonfinite values, resources, and malformed metadata fail explicitly; they are not pickled or reconstructed by executing code. Saving a replacement that fails validation preserves the previous snapshot. Snapshots do not retain closures, running tasks, open handles, the interpreter heap, or exactly-once side effects. A snapshot path is on the kernel target; artifact ownership still belongs to the parent session.

## Kernel orchestration helpers

### Settled and streaming orchestration

`parallel(thunks, ...)` and `pipeline(items, ...stages, ...)` accept Python keyword options or one trailing JavaScript options object:

| Contract | Python | JavaScript |
| --- | --- | --- |
| Return each outcome | `settled=True` | `settled:true` |
| Concurrency ceiling | `concurrency=N` | `concurrency:N` |
| Cooperative deadline | `timeout=seconds` | `timeoutMs:milliseconds` |
| Cancellation | `cancel=threading.Event()` | `signal:AbortSignal` |
| Observe completion | `on_result=callback` | `onResult:callback` |
| Advance items without barriers | `streaming=True` on pipeline | `streaming:true` on pipeline |
| Save successful JSON results | `checkpoint=directory, key=workflow_version` | `checkpoint:directory, key:workflowVersion` |
| Reuse saved results explicitly | `resume=True` | `resume:true` |

Settled rows retain input ordering and contain `status`, `index`, actual `stage`, and either `value` or `error` (`name`, `message`, `stack`). Status is `fulfilled`, `rejected`, `timed_out`, or `cancelled`. Without `settled`, failure throws `BatchError` with all `.results`; observer failures are retained in `.callback_errors` / `.callbackErrors`. Successful sibling results are not discarded.

Python callbacks are zero-argument thunks or single-value stages; call `task_signal().check()` inside cooperative loops. JavaScript thunks receive `(index, signal)` and stages `(value, index, signal)`. Helpers drain work and observers before returning: a noncooperative callback can overrun its deadline, but is not falsely reported stopped while side effects continue. Streaming deadlines cover the whole item across stages; barrier deadlines apply separately to each stage-item. Host concurrency ceilings still apply.

```python
rows = pipeline([1, 2, 3], lambda n: n * 2, lambda n: {"answer": n + 1},
                streaming=True, settled=True, concurrency=2,
                checkpoint="workflow-checkpoints", key="double-plus-one-v1", resume=True)
display(rows)
```

Checkpoints contain only completed, strictly JSON-compatible results, not interpreter heaps, closures, open resources, errors, or running callbacks. Checkpointed `parallel` requires unique stable string `keys`; `pipeline` can derive keys from canonical JSON input. Change the workflow `key` when code or semantics change. Failed stages rerun only on an explicitly requested subsequent invocation; there is no automatic retry. Resume survives kernel restarts, but is not an exactly-once side-effect transaction. Each item/stage checkpoint uses atomic file replacement and a versioned identity envelope; corrupt or oversized checkpoints produce errors.

## Streamed kernel preflight and speculation

Two independent, default-on settings can overlap work with model generation:

```yaml
kernel:
  speculation:
    enabled: true
  assertPreflight:
    enabled: true
```

These settings apply to model-generated `bash` calls containing a standalone, quoted Python/JavaScript heredoc. They do not execute partial shell commands or partial cells in the live kernel, and do not apply to user bang commands. Normal finalized calls still pass through validation, extension approval, bash interception, and the normal execution path. Streaming observation is disabled while secret obfuscation has active secrets.

**Both options permit preflight effects before final tool approval by default; set either to `false` to opt out.** Completion requests may already have been sent and billed when a call is blocked, changed, or cancelled. Assertion preflight may already have read local files. Cancellation cannot undo those effects.

### Completion speculation

`kernel.speculation.enabled` prelaunches eligible top-level `completion()` calls with literal arguments as their source becomes complete. Python keyword options and JavaScript literal options objects are supported. For example:

```bash
python <<'PY'
summary = completion("Summarize the purpose of speculative execution.", model="smol")
title = completion("Give a short title for a document about speculative execution.")
print(summary, title)
PY
```

The completed cell runs normally. A matching real completion invocation can claim its already-running result rather than make another request. Identical calls remain separate stochastic samples, not one memoized answer. Claiming is scoped to the originating call and runtime invocation, with model/options and finalized input matching; it is not a session-wide arguments-only cache.

At most two speculative requests launch per outer bash call, including invalidated attempts; normal execution can make additional requests for calls without a reusable result. Changes to relevant input fields or candidates invalidate pending work; changing `cwd`, `env`, `pty`, or `async` does not silently reuse an incompatible result. Unclaimed work is cancelled when the call/turn is retired or the session is aborted/disposed; work already claimed by normal execution follows its runtime lifetime.

This is deliberately not general shell speculation or a shadow REPL. Dynamic completion arguments, control-flow calls, and arbitrary `agent()`/tool calls are excluded. Unquoted heredocs, shell chains, and ambiguous invocations are not speculative execution surfaces. Unsupported code follows normal finalized execution.

### Assertion preflight

`kernel.assertPreflight.enabled` checks a restricted source-local subset against bounded, read-only file snapshots. It can detect the first failing anchor assertion while a later replacement literal is still being generated:

```bash
python <<'PY'
from pathlib import Path
p = Path("/absolute/path/to/source.py")
text = p.read_text()
old = "expected original text"
assert text.count(old) == 1
new = "replacement text"
text = text.replace(old, new)
p.write_text(text)
PY
```

If the count assertion fails, generation is interrupted before the rest of the cell is needed. The partial assistant turn is discarded from active context, a diagnostic identifies the failing line and observed/expected count, and the agent continues to correct the assumption. Neither `str.replace()` nor `write_text()` is executed by preflight. A successful check does not commit anything or bypass the assertion during normal execution.

Supported Python inputs include source-local `from pathlib import Path` / `import pathlib`, literal path construction, `read_text()` with UTF-8, explicit `builtins.open` imports for read-only `.read()`, string/integer assignments, and `assert text.count(old) == expected`. JavaScript supports explicit `node:fs` reads with UTF-8 and the corresponding `text.split(old).length - 1` check through `console.assert` or an explicitly imported `node:assert` function. These are source-local checks, not inspection of arbitrary retained kernel objects.

Safety boundaries:

- Prior-cell variables, inherited bare `Path`/`open` bindings, dynamic paths, unknown calls/imports, control flow, and mutations are not evaluated. Unsupported dependencies stop downstream checking rather than guess their values.
- Relative literal paths require an explicit absolute tool/session working directory; preflight never guesses from the host process working directory. Cached observations are isolated by session, call, source, and working directory.
- Only regular, bounded UTF-8 files are read. Symlink file targets, devices/FIFOs, binary content, and changed snapshots are skipped; failed observations are revalidated before being reported.
- Limits: 1 MiB source, 8 MiB file, 64 KiB literal, 4,096 statements, and 16 MiB cumulative count work. Partial JSON scanning is capped at 4 MiB.
- An incomplete string/assertion cannot itself be evaluated. An unfinished later literal does not hide an earlier complete failing assertion.
- Late results cannot interrupt a completed call, a new prompt generation, or a disposed session. A preceding sibling tool call prevents assertion interruption because it could change the file before the checked cell would run.

Preflight reports a check against the current file snapshot and supported language subset; it is not a proof of the eventual cell's behavior under arbitrary imports, monkeypatches, or concurrent filesystem changes. Keep normal assertions and stale-write protection in place.

## End-to-end tool-call pipeline

## 1) Input handling and parameter merge

`BashTool.execute()` currently handles input as follows:

- validates optional `env` names against shell-variable syntax,
- preserves leading `cd` commands for shell evaluation rather than rewriting them into `cwd`,
- rejects `async: true` when `async.enabled` is false,
- defaults `timeout` to 300 seconds; `0` explicitly disables the command deadline.

There are no structured `head` or `tail` parameters. Before execution, internal URLs in the command and environment values are expanded to backing filesystem paths; an internal URL used as `cwd` is also resolved. Expansion can create parent directories for writable `local://` paths. The configured direnv/devenv preflight can then merge project environment changes, with explicit `env` values taking precedence.

## 2) Optional interception (blocked-command path)

If `bashInterceptor.enabled` is true, `BashTool` loads rules from settings (`getBashInterceptorRules()`) and runs `checkBashInterception()` against the original command. Rule syntax is unchanged: each rule checks the complete input first, then raw flat command fragments separated by unquoted/unescaped `&&`, `||`, `;`, `|`, `|&`, `&`, or newlines, then those fragments with leading `NAME=value` assignments removed. Fragments that receive piped stdin from `|` or `|&` are excluded from the fragment candidates, including across blank/comment continuation lines, because a stdin-consuming stage cannot be replaced by a path-based dedicated tool.

Interception behavior:

- command is blocked **only** when:
  - regex rule matches, and
  - the suggested tool is present in `ctx.toolNames`.
- invalid regex rules are silently skipped.
- on block, `BashTool` throws `ToolError` with message:
  - `Blocked: ...`
  - original command included.
- heredocs, parameter expansion, command substitutions, backticks, grouping, and malformed quoting do not produce extra fragments; they retain only the complete-input check. Interception is best-effort routing to dedicated tools, not a shell-security policy.

Default rule patterns (defined in code) target common misuses:

- file readers (`cat`, `head`, `tail`, `less`, `more`) -> `read`
- background launches (`nohup`, trailing `&`) -> `fleet`
- long-running services, watchers, and debuggers (`bun`/`npm`/`pnpm`/`yarn` dev or start commands, `vite`, `next dev`, `nuxt dev`, `nodemon`, `lldb`, `gdb`, `tail -f`, and non-detached `docker compose up`) -> `fleet`
- watch-mode commands with `--watch` or `-w` -> `fleet`

### Caveat

`InterceptionResult` includes `suggestedTool`, but `BashTool` currently surfaces only the message text (no structured suggested-tool field in `details`).

## 3) CWD validation and timeout resolution

`cwd` is expanded (including internal URLs), then resolved with the session cwd (`path.resolve(session.cwd, expandPath(cwd))`) and validated via `stat`:

- missing path -> `ToolError("Working directory does not exist: ...")`
- non-directory -> `ToolError("Working directory is not a directory: ...")`

The default timeout is 300 seconds. `timeout: 0` disables the deadline. Other values are clamped to `[1, 3600]` seconds and by a positive `tools.maxTimeout` ceiling; a clamp notice and both requested/resolved values are recorded when they differ.

## 4) Artifact allocation

Before local PTY or non-PTY execution, the tool allocates an artifact path/id (best-effort) for truncated output storage.

- artifact allocation failure is non-fatal (execution continues without artifact spill file),
- artifact id/path are passed into the local execution path for full-output persistence on truncation,
- client-bridge terminal execution bypasses this allocation; if its final inline cap fires, result shaping may allocate a `bash-original` artifact instead.

## 5) PTY vs non-PTY execution selection

PTY eligibility is decided by `canUseInteractiveBashPty(pty, ctx)` (`src/tools/bash-pty-selection.ts`); the local PTY overlay runs only when all are true:

- tool input `pty === true`
- `PI_NO_PTY !== "1"`
- tool context has UI (`ctx.hasUI === true` and `ctx.ui` set)

If `pty` is requested but unavailable, the call falls back to non-PTY and appends a `pty requested but unavailable …` notice.

Before the local PTY/non-PTY choice, a foreground (`async: false`) call can route to a managed background job (auto-backgrounding; see below) or — when the session's client advertises a terminal capability (`clientBridge.capabilities.terminal` + `createTerminal`, with `pty` false) — to a **client-bridge editor terminal** that runs the command remotely (when no `protolens` bridge is active; streaming `terminalId` updates, killing on timeout, mapping a signal kill to exit code `137`). Otherwise it uses non-interactive `executeBash()`.

That means print mode and non-UI RPC/tool contexts never use the local PTY overlay.

## Non-interactive execution engine (`executeBash`)

## Shell session reuse model

`executeBash()` caches native `Shell` instances in a process-global map keyed by:

- shell path,
- configured command prefix,
- snapshot path,
- serialized shell env,
- optional agent session key,
- minimizer configuration.

Session-level bang-command executions pass the captured session id as `sessionKey` (`target.sessionId` in `BashRunner`).

Tool-call executions pass `sessionKey: this.session.getSessionId?.()`, when available. In both surfaces, a session key isolates shell reuse per session; without one, reuse falls back to shell config/snapshot/env.
Non-PTY Brush calls queue by session and lane; omitted lane and `main` are identical. Overlap no longer silently switches to a fresh shell. Named lanes isolate shell and Python/JavaScript state while allowing independent execution. A cancelled queued caller never executes its command. Managed background jobs default to `async:<jobId>`; explicit lanes are respected. Kernel `tool.bash` calls without a lane receive a fresh bridge lane to avoid waiting on their own calling cell. Do not request the calling lane from a nested tool call.

## Bundled `jq` compatibility

Unless `PI_DISABLE_UUTILS_BUILTINS` is truthy, the non-PTY native shell registers a bundled `jq` command backed by vendored [jaq](https://github.com/01mf02/jaq), not the system `jq`. Setting that flag disables the in-process uutils command set and falls back to system binaries. The bundled jaq errors when chained access indexes through a null or missing intermediate: `.a.b` over `{}` exits 5, whereas jq returns `null`.

Guard the access with `[.a.b?][0]` when the parent may be null or absent. The `?` suppresses jaq's traversal error (jq never raises it), and `[…][0]` maps the suppressed empty output to `null` while preserving a legitimate `false` or `null` value:

```jq
{"c": [.a.b?][0]}
```

Avoid the naive `.a.b? // null`: `//` treats a legitimate `false` (and `null`) as absent, so it silently rewrites boolean data to the fallback. It also diverges on parse — `{"c": .a.b? // null}` is accepted by jaq but is a syntax error in jq (the value needs parentheses: `{"c": (.a.b? // null)}`).

## Shell config, direnv, and snapshot behavior

At each call, the executor loads settings shell config (`shell`, `env`, optional `prefix`) and runs `applyDirenvPreflight()`.

Unless `bash.direnv` is `"off"`, preflight attempts to load the cwd's direnv/devenv changes within `bash.direnvLoadTimeoutMs`, additionally bounded by a positive command timeout. Direnv-provided variables are merged below explicit caller `env`; safe variables removed by direnv are prepended as `unset -v ...`. ACP-terminal and PTY routes run the same preflight before their backend; the non-PTY executor runs it internally.

If the selected shell includes `bash`, it attempts `getOrCreateSnapshot()`:

- snapshot captures aliases/functions/options from user rc,
- snapshot creation is best-effort,
- failure falls back to no snapshot.

If `prefix` is configured, it wraps the command after any direnv unset prefix.

The per-command child environment is then built by `buildNonInteractiveEnv()` (`src/exec/non-interactive-env.ts`), which layers non-interactive hardening defaults **under** the caller and direnv overrides:

- pagers disabled (`PAGER=cat`, `GIT_PAGER=cat`, … and `LESS=FRX`),
- editor prompts disabled (`GIT_EDITOR=true`, `EDITOR=true`, `VISUAL=true`),
- terminal/credential prompts reduced (`TERM=dumb`, `GIT_TERMINAL_PROMPT=0`, `SSH_ASKPASS=/usr/bin/false`, `NO_COLOR=1`, `CI=true` unless `PI_BASH_NO_CI`/`CLAUDE_BASH_NO_CI` is set),
- package-manager/tooling automation flags for non-interactive behavior (npm/pnpm/yarn/pip/cargo/terraform/gh, …),

## Streaming and cancellation

`Shell.run()` streams chunks to `OutputSink` and optional `onChunk` callback.

Cancellation:

- aborted signal triggers `shellSession.abort(...)`,
- timeout from native result is mapped to `cancelled: true` + annotation text,
- explicit cancellation similarly returns `cancelled: true` + annotation.

No exception is thrown inside executor for timeout/cancel; it returns structured `BashResult` and lets caller map error semantics.

## Interactive PTY path (`runInteractiveBashPty`)

When PTY is enabled, tool runs `runInteractiveBashPty()` which opens an overlay console component and drives a native `PtySession`.

Behavior highlights:

- xterm-headless virtual terminal renders viewport in overlay,
- keyboard input is normalized (including Kitty sequences and application cursor mode handling),
- `esc` while running kills the PTY session,
- terminal resize propagates to PTY (`session.resize(cols, rows)`).

Unlike the non-PTY engine, the interactive PTY path does **not** apply the non-interactive hardening. It inherits the user's environment and sets a real `TERM=xterm-256color` (applied as an override on the Rust side) so editors, pagers, and TUIs behave like a normal terminal.

PTY output is normalized (`CRLF`/`CR` to `LF`, `sanitizeText`) and written into `OutputSink`, including artifact spill support.

On PTY startup/runtime error, sink receives `PTY error: ...` line and command finalizes with undefined exit code.

## Output handling: streaming, truncation, artifact spill

Local PTY and native non-PTY paths use `OutputSink`; the client-bridge terminal path collects output through its terminal handle and applies final inline-cap shaping instead.

## OutputSink semantics

The bash executor builds the sink with `headBytes` and `maxColumns` from settings (`resolveOutputSinkHeadBytes` / `resolveOutputMaxColumns`).

- keeps a UTF-8-safe rolling **tail** window (`spillThreshold`, `DEFAULT_MAX_BYTES`, currently 50KB); on overflow it trims to the tail (UTF-8 boundary safe) and marks `truncated`,
- when `headBytes > 0` (`tools.artifactHeadBytes`, default 20KB) it also retains a **head** window and elides the middle, splicing an elision marker between head and tail in `dump()`,
- per-line column cap: when `maxColumns > 0` (`tools.outputMaxColumns`, default 768 bytes) over-wide lines are ellipsis-truncated at write time and the rest of the line is dropped,
- tracks total bytes/lines seen,
- mirrors the **pre-column-cap** stream to the artifact file when output overflows, a column cap dropped bytes, or the file is already active (the artifact itself is capped at 4 MiB by default),
- marks `truncated` on tail overflow, middle elision, column-cap drops, or file spill.

`dump()` returns:

- `output` (possibly annotated prefix),
- `truncated`,
- `totalLines/totalBytes`,
- `outputLines/outputBytes`,
- `elidedBytes/elidedLines` when the middle was elided,
- `columnDroppedBytes/columnTruncatedLines` when the per-line cap fired,
- `artifactId` if artifact file was active.

### Long-output caveat

Runtime truncation is byte-threshold based in `OutputSink` (50KB tail window by default, plus an optional head window for middle elision). It does not enforce a hard line-count cap in this code path.

### Shell output minimizer

Native non-PTY execution also passes shell-minimizer settings into the native `Shell` session. When the minimizer rewrites verbose output, the executor replaces the sink's visible text with the minimized text and, when possible, saves the raw original capture as a separate `bash-original` artifact referenced by a `[raw output: artifact://<id>]` footer.

## Live tool updates and async jobs

For native non-PTY foreground execution, `BashTool` uses a separate `TailBuffer` for partial updates and emits `onUpdate` snapshots while the command is running.

For PTY execution, live rendering is handled by custom UI overlay, not by `onUpdate` text chunks.

When `async.enabled` is true and the call passes `async: true`, `BashTool` starts a managed bash job immediately, returns a running result with a job id, and stores completion through the session job manager. Auto-backgrounding can also use this path after `bash.autoBackground.thresholdMs`; it is skipped for PTY and client-bridge terminal routes and falls back to foreground execution when the job manager is at capacity. A queued steering message can background a still-running auto-background candidate early.

## Result shaping, metadata, and error mapping

After execution:

1. A cancellation or missing exit status throws a tool error. The client-bridge
   terminal route also throws `ToolError` for timeout before structured result
   shaping.
2. Local non-PTY and interactive-PTY timeouts return an error result with
   `details.timedOut = true` so the renderer can distinguish them from an
   ordinary failure.
3. Empty output becomes `(no output)`.
4. A final inline byte cap protects routes that bypass `OutputSink`; it reuses the sink artifact when available or saves a `bash-original` artifact.
5. Truncation metadata is attached from the sink summary.
6. A hard nonzero exit returns an error result with `details.exitCode`. Plain-shell exit code 1 is a soft exit (for example, grep/rg no-match); kernel-routed exit 1 remains a hard failure. Zero returns success.

Result details can also include resolved/requested timeout, `timeoutDisabled`, client `terminalId`, wall time, async job state, and truncation metadata. Truncation includes direction/reason, total and shown line/byte counts, shown range, and `artifactId` when persistence succeeded.

Built-in tool wrapping appends the model-facing recovery notice automatically, for example `Read artifact://<id> for full output`.


### Structured execution metadata

`details.execution` is authoritative and is rendered before command output. It is independent of output wording:

- `state` is `running`, `exited`, or `unknown`.
- `exitCode`, `signal`, and `elapsedMs` are included only when observed; timeout/cancellation never fabricates an exit code or signal.
- `softExit` marks a plain-shell exit code 1 that is not treated as a tool failure; kernel-routed exit code 1 does not set it.
- `timeout` records `cause`, `scope`, and requested/effective milliseconds when known. Bash deadlines use `cause: "deadline"`, `scope: "command"`.
- `collector` records output collection separately (`running`, `complete`, `failed`, or `unavailable`), including a collector error without changing process state.
- `output` distinguishes `complete`, `truncated`, `summarized`, and `unavailable`; truncation carries counts and an artifact id when persistence succeeded.

A line such as `timeout: 60` or `all checks passed` is data, not lifecycle evidence. Consumers MUST use structured execution metadata and MUST NOT infer success, failure, or timeout from stdout/stderr text. Raw captured output remains in the artifact when spill succeeds; replayed bash/python execution messages retain the execution metadata alongside the output.
## Rendering paths

## Tool-call renderer (`bashToolRenderer`)

`bashToolRenderer` is used for tool-call messages (`toolCall` / `toolResult`):

- collapsed mode shows visual-line-truncated preview,
- expanded mode shows all currently available output text,
- warning line includes truncation reason and `artifact://<id>` when truncated,
- timeout values are retained in result details (`timeoutSeconds`, `requestedTimeoutSeconds`, or `timeoutDisabled`); the current renderer does not add a separate timeout footer line.

### Caveat: full artifact expansion

`BashRenderContext` has `isFullOutput`, but current renderer context builder does not set it for bash tool results. Expanded view still uses the text already in result content (tail/truncated output) unless another caller provides full artifact content.

## User bang-command component (`BashExecutionComponent`)

`BashExecutionComponent` is for user `!` commands in interactive mode (not model tool calls):

- streams chunks live,
- collapsed preview keeps last 20 logical lines,
- line clamp at 4000 visible columns per line,
- shows truncation + artifact warnings when metadata is present,
- marks cancelled/error/exit state separately.

This component is wired by `CommandController.handleBashCommand()` and fed from `AgentSession.executeBash()`.

## Mode-specific behavior differences

| Surface                        | Entry path                                            | PTY eligible                                          | Live output UX                                                           | Error surfacing                                  |
| ------------------------------ | ----------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------ |
| Interactive tool call          | `BashTool.execute`                                    | Yes, when `pty=true` and UI exists and `PI_NO_PTY!=1` | PTY overlay (interactive) or streamed tail updates                       | Tool errors become `toolResult.isError`          |
| Print mode tool call           | `BashTool.execute`                                    | No (no UI context)                                    | No TUI overlay; output appears in event stream/final assistant text flow | Same tool error mapping                          |
| RPC tool call (agent tooling)  | `BashTool.execute`                                    | Usually no UI -> non-PTY                              | Structured tool events/results                                           | Same tool error mapping                          |
| Interactive bang command (`!`) | `AgentSession.executeBash` + `BashExecutionComponent` | No (uses executor directly)                           | Dedicated bash execution component                                       | Controller catches exceptions and shows UI error |
| RPC `bash` command             | `rpc-mode` -> `session.executeBash`                   | No                                                    | Returns `BashResult` directly                                            | Consumer handles returned fields                 |

## Operational caveats

- Interceptor only blocks commands when suggested tool is currently available in context.
- If artifact allocation fails, truncation still occurs but no `artifact://` back-reference is available.
- Shell session cache has no explicit eviction in this module; lifetime is process-scoped.
- Timeout shaping is backend-specific: local non-PTY and interactive-PTY timeouts return error results with `details.timedOut`; the client-bridge terminal creation/execution timeout paths throw `ToolError`. Non-timeout cancellations throw across these tool-call routes.

## Implementation files

- [`src/tools/bash.ts`](../packages/coding-agent/src/tools/bash.ts) — tool entrypoint, input handling/interception, async and PTY/non-PTY selection, result/error mapping, bash tool renderer.
- [`src/tools/bash-pty-selection.ts`](../packages/coding-agent/src/tools/bash-pty-selection.ts) — `canUseInteractiveBashPty` predicate for choosing the local PTY overlay.
- [`src/tools/bash-interceptor.ts`](../packages/coding-agent/src/tools/bash-interceptor.ts) — interceptor rule matching and blocked-command messages.
- [`src/tools/bash-skill-urls.ts`](../packages/coding-agent/src/tools/bash-skill-urls.ts) — internal-URL expansion for commands, env values, and cwd.
- [`src/exec/bash-executor.ts`](../packages/coding-agent/src/exec/bash-executor.ts) — non-PTY executor, shell session reuse, cancellation wiring, output sink integration.
- [`src/exec/non-interactive-env.ts`](../packages/coding-agent/src/exec/non-interactive-env.ts) — non-interactive child-process env defaults (`buildNonInteractiveEnv`) used by the non-PTY executor.
- [`src/exec/direnv.ts`](../packages/coding-agent/src/exec/direnv.ts) — direnv/devenv environment loading used by executor preflight.
- [`src/tools/bash-interactive.ts`](../packages/coding-agent/src/tools/bash-interactive.ts) — PTY runtime, overlay UI, input normalization, and interactive `TERM` setup.
- [`src/tools/bash-embedded-code.ts`](../packages/coding-agent/src/tools/bash-embedded-code.ts) — recognizes embedded Python/JavaScript cell forms and source spans.
- [`src/eval/shell-bridge.ts`](../packages/coding-agent/src/eval/shell-bridge.ts) — routes Bash cells to the retained Python/JavaScript runtimes and drains structured output.
- [`src/session/streaming-output.ts`](../packages/coding-agent/src/session/streaming-output.ts) — `OutputSink`, `TailBuffer`, truncation/artifact spill, and summary metadata.
- [`src/tools/output-meta.ts`](../packages/coding-agent/src/tools/output-meta.ts) — truncation metadata shape + notice injection wrapper.
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts) — session-level `executeBash`, message recording, abort lifecycle.
- [`src/modes/components/bash-execution.ts`](../packages/coding-agent/src/modes/components/bash-execution.ts) — interactive `!` command execution component.
- [`src/modes/controllers/command-controller.ts`](../packages/coding-agent/src/modes/controllers/command-controller.ts) — wiring for interactive `!` command UI stream/update completion.
- [`src/modes/rpc/rpc-mode.ts`](../packages/coding-agent/src/modes/rpc/rpc-mode.ts) — RPC `bash` and `abort_bash` command surface.
- [`src/internal-urls/artifact-protocol.ts`](../packages/coding-agent/src/internal-urls/artifact-protocol.ts) — `artifact://<id>` resolution.
