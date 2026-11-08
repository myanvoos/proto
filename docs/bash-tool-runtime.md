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

The bash tool uses one pre-execution rewrite pass for literal internal URI arguments, environment values, and `cwd`. Each internal URI must resolve to a real filesystem path or fail with a teaching error directing the caller to `read`. This applies equally to the engine's built-in commands (`rg`, `cat`, etc.) and external commands; it is not a per-builtin resolver. URLs constructed later by shell expansion are not reinterpreted.

`harness://` and documentation subdirectories such as `harness://tools/` resolve to real directories. Source checkouts use their existing docs tree without copying files or changing permissions. Embedded documentation and built-in rules are materialized as read-only files in a build-keyed cache. Skills and custom rules retain their original filesystem paths. For example, `rg -n approval harness://` searches the documentation corpus.

A trailing read selector is not part of the resource: `harness://bash.md:1-40` resolves `harness://bash.md` and keeps the selector on the path (`/…/bash.md:1-40`), so `protolens read` and other selector-aware consumers see the same address `read` accepts. Generated agent/history views and mounted-device resources without files are not passed off as local filenames: arguments of a `protolens` command reach the device as typed (`protolens read history://` works like the `read` tool), and anywhere else they fail with the `read` hint. Quoted JSON, embedded script text, and heredoc bodies remain data; their URI strings are not rewritten. External HTTP URLs remain unchanged.

## `protolens` as an engine builtin

When xdev is enabled, model-facing Bash runs use the in-house bash engine and register `protolens` as an engine callout. `protolens <tool> '<json>'` therefore composes with the same shell language as native commands: pipelines, `|&`, redirects, command substitutions, subshells/groups, loops, conditionals, `&&`/`||`, background jobs, and `pipefail` are parsed and executed by one runtime. The callout receives the invocation-local working directory from each shell branch, so `(cd sub; protolens read '{"path":"file"}')` does not mutate the shared tool session; concurrent branches remain isolated.

The bridge maps successful text content to stdout and tool-error text to stderr; tool-execution errors use status `1`, CLI usage errors use `2`, and bridge/serialization failure uses `125`. Non-text content and `xdev` details travel in `protolensDispatches`, a structured side channel consumed by Bash rendering, never through stdout/stderr pipes. Native shell cancellation and deadlines cancel the bridge await; downstream pipe closure returns the shell's broken-pipe status. Bridge input is bounded to 1 MiB of stdin bytes; the builtin decodes those bytes as UTF-8 for dispatch.

`protolens` exists only inside the agent's in-house shell engine. Supervised processes, client terminal/PTY execution, user bang commands without the agent Bash dispatcher, and standalone external `bash` do not inherit it; they must not assume an `protolens` binary exists on `PATH`.

Without positional JSON, `protolens` parses its stdin as the argument object: `printf '%s' '{"path":"src"}' | protolens read`. A single positional JSON object takes precedence over piped stdin; `--json` cannot be combined with positional arguments. For a single-string device, bare stdin may instead be the plain payload. Non-empty text output ends with a newline so a following shell command starts on its own line. Shell settlement aborts outstanding tool dispatches, including deadline cancellation, rather than leaving detached tool work running.

## Native Python processes

Every ordinary `python`/`python3` command starts a real, fresh native process: `-c`, stdin/heredocs, script paths, `-m`, versioned/absolute executable paths, aliases, `env`, shebangs, and Python launched by another program. The shell chooses the executable normally; Proto does not substitute its configured or managed interpreter. Empty `PATH` components search the shell's working directory.

Native `argv`, stdin/stdout/stderr bytes, exit status, signals, `atexit`, imports, threads, and interpreter teardown belong to that process. Names and imports do not persist between commands. There is no Python shell builtin, implicit routing, injected helper namespace, AST rewriting, magic syntax, automatic package installation, or rerun fallback. User `$` Python submissions (`$$` excludes the result from model context) and `AgentSession.executePython()` are fresh too. `!`/`!!` submit shell commands, not Python.

Agent-shell runs add a small `PYTHONPATH` startup hook. It detects CPython inside the interpreter, chains the project's existing `sitecustomize`, and exposes the staged `proto_harness` package without modifying installed Python. Plain startup does not load the tool/model/serialization stack. Native `-I`, `-E`, and `-S` opt out of automatic detection; no fallback interception overrides them.

## Explicit Python harness API

```bash
python <<'PYTHON'
import proto_harness as harness

result = harness.tool.read({"path": "README.md"})
print(result)
PYTHON
```

Capabilities are lazy package attributes, never implicit globals:

- `harness.tool.<name>(args)`, `harness.completion(...)`, `harness.agent(...)`, `harness.parallel(...)`, and `harness.pipeline(...)`: tools, model calls, and orchestration.
- `harness.symbols(...)`, `harness.block_range(...)`, `harness.display(...)`, artifact helpers, `harness.output(...)`, `harness.executions(...)`, progress, budget, and cancellation helpers.
- `harness.fs.read_text/read_bytes/write_text/write_bytes/replace`: atomic, permission-checked host-file edits with cross-tool/process stale-read protection.
- `harness.store`: session-owned rich values across fresh runs. `harness.kernel(name)`: optional named persistent execution.

Ordinary Python `Path`, `open`, and `os` operations remain native and unpatched. Use `harness.fs` for protected edits:

```python
import proto_harness as harness

path = "src/example.py"
text = harness.fs.read_text(path)
old = 'MODE = "old"'
assert text.count(old) == 1
harness.fs.replace(path, old, 'MODE = "new"')
```

A `harness.StaleWriteError` requires a fresh read and a newly derived edit. Every helper call uses host-owned, run/session-bound authority and the normal tool schema, extension approval, permissions, spawn, admission, cancellation, and turn-budget policies. Importing the package is not a permissions bypass. Run authority is bounded and revoked on completion/abort. Do not export transport credentials to detached work; use [explicit delegation](#scoped-access-from-ordinary-scripts).

## Explicit named Python kernels

A named kernel deliberately retains variables, functions, classes, imports, and native module caches. It is not a fresh process: `atexit`, threads, and other process-lifetime resources belong to the warm interpreter. Helpers still require an explicit import:

```bash
python <<'PYTHON'
import proto_harness as harness

analysis = harness.kernel("analysis")
result = analysis.run("import proto_harness as harness; total = 40; print(total)")
assert result["exitCode"] == 0, result
print(result["output"], end="")
PYTHON

python <<'PYTHON'
import proto_harness as harness

result = harness.kernel("analysis").run("total += 2; print(total)")
assert result["exitCode"] == 0, result
print(result["output"], end="")
PYTHON
```

`harness.kernel(name, interpreter=None, cwd=None, target=None)` returns a handle with `run(code)`, `exec(file)`, `status()`, `stop()`, and `restart()`. Execution results include `output`, `exitCode`, and timeout/cancellation fields. `exec` reads the file in the kernel's filesystem. `stop` closes the runtime and forgets configuration; `restart` explicitly discards the namespace and starts the selected environment. Different names can call one another; self/ancestor dependencies are refused rather than deadlocked. Errors never cause automatic replay.

Use the explicit CLI for streaming shell I/O:

```bash
python -m proto_harness.kernel analysis -c 'print("explicit warm call")'
printf 'payload' | python -m proto_harness.kernel io -c 'import sys; sys.stdout.buffer.write(sys.stdin.buffer.read())'
python -m proto_harness.kernel analysis --file /absolute/path/to/report.py
```

Without `-c` or `--file`, stdin supplies code; with either option, piped stdin is program input. The CLI reuses the named environment configuration unless `--interpreter` or `--cwd` explicitly overrides it; it does not substitute the calling process's interpreter. Remote execution uses the configured target cwd, not the host invocation directory. Match interpreter/cwd/target when accessing a kernel from another surface. Configuring a name or lane never reroutes ordinary Python commands.

Warm synchronous code runs on the main thread and supports normal `asyncio.run()`; explicit top-level await uses the warm event loop. Warm-only inspection and retention are explicit: `harness.defs()`, `harness.kernel_state()`, and `harness.retain_task(...)`. Python has no manual selected-data codec adapter; use the rich store or automatic exact-boundary graphs.

### Residency and continuity

Named Python namespaces are captured automatically as one rich graph; no `declare_state` opt-in. Aliases, cycles, functions, closures, classes, and shared references are preserved within a 64 MiB encoded payload limit. Graph serialization is trusted and session-local, not an untrusted pickle import format. Interpreter, format, environment, and imported-module compatibility are checked before restore. Unsupported live files, sockets, threads, tasks, subprocesses, and similar resources refuse capture rather than being dropped or approximated.

Exact immutable manifests bind captures to session-history boundaries before transitions are acknowledged. Historical captures remain with their branches, without a last-N window or nearest-earlier fallback. User forks restore independent graphs; context-only rewind does not roll computation back. External filesystem/process effects are not rolled back. Missing, incompatible, unsafe, or uncertain state is never replaced silently by older or fresh state; reset explicitly chooses to discard it.

`python.kernelMemoryBudgetBytes` defaults to the smaller of 25% of physical RAM and 4 GiB. Idle kernels park least-recently-used first only after safe durable capture; running, unsafe, and unmeasurable kernels are not silently evicted. `python.kernelMaxResidentCount` defaults to 64 as a separate process-count safety limit, not execution concurrency. Private-memory accounting is neither summed RSS nor a global process-memory guarantee; inspect actual residency/refusal reasons.

Supported local POSIX environments use a sterile, single-threaded forkserver per interpreter, with user libraries loaded only in children after fork. Other supported launch environments report their actual mode. This does not claim verified Linux/remote performance.

## JavaScript kernel-cell reference

### Compatibility philosophy

JavaScript retains native language semantics within cells, persistent state between cells, and harness presentation outside program I/O. Node and Bun have separate heaps. Native declaration behavior, lexical scope, temporal dead zones, and interpreter-specific transforms are preserved. Referenced async work settles before completion; `retainTask(resource)` unrefs work intended to survive. Process-lifetime resources belong to the retained runtime. Errors never cause automatic fresh-process replay.

### Reproducing compatibility checks

The source parity suite exercises the actual Bash route. A separately built compiled CLI can exercise the stdio supervisor without claiming actual SSH/container coverage:

```bash
bun test packages/coding-agent/src/tools/bash-interpreter-parity.test.ts
bun run --cwd=packages/coding-agent build
PROTO_COMPILED_KERNEL_TEST_BIN="$PWD/packages/coding-agent/dist/proto" \
  bun test packages/coding-agent/src/tools/bash-compiled-kernel.test.ts
```

The compiled check is opt-in so stale distribution binaries do not affect source tests.

### Cell forms and API

Non-PTY `node`/`nodejs` and `bun` commands with stdin source or `-e CODE` run as retained cells; internal fleet scripts are supported too. Other forms use native processes. Arguments populate `process.argv`; use `--` before arguments beginning with `-`. Inline code reads program input from `process.stdin`; source-on-stdin uses stdin as code. Input and stdout/stderr remain byte-preserving and backpressured through pipes and redirection.

The existing JavaScript prelude remains: `tool`, `completion`, `agent`, `parallel`, `pipeline`, `symbols`, `blockRange`, `display`, `env`, `output`, `defs`, `kernelState`, `declareState`, `saveState`, `loadState`, artifacts, events, progress, and budget. Async helpers use one trailing options object. Top-level await and bare return remain supported. File APIs retain stale-write guards and mutation receipts. The 15-minute idle reap protects active cells, in-flight bridges, resets/replacements, and unsafe declared generations. Safely captured declared data restores before later execution; undeclared bindings do not. Reset discards bindings/declarations; unsafe or uncommitted declared state is never silently replaced after runtime loss.

### Filesystem paths and rich output

Raw file APIs use filesystem paths; embedded source/heredoc bodies do not resolve internal URLs. Use `harness.tool.read` in Python or `tool.read` in JavaScript for internal resources, or pass a Bash-resolved path via `env`. Import native modules explicitly in fresh Python:

```json
{"command":"python -c 'import os; from pathlib import Path; print(Path(os.environ[\"INPUT\"]).read_text())'","env":{"INPUT":"skill://example/notes.md"}}
```

`harness.display(value)` in Python and `display(value)` in JavaScript emit presentation sidebands, not stdout/stderr. Python supports JSON, text/Markdown, HTML-to-Markdown, images, and common PIL/pandas/Plotly/Matplotlib representations. JavaScript object results become structured JSON. JavaScript and explicit warm-Python final-expression values also remain sidebands; fresh Python does not display unprinted expressions. Pipes, redirects, and substitutions receive only program bytes. Model-visible JSON display text is capped at 8,000 characters per value; structured data remains available. Bash capture is text; use files/artifacts for arbitrary binary data.

### Timeouts and cancellation

The enclosing Bash timeout governs the invocation and owned helper work. Fresh Python uses process cancellation. Named Python receives an interrupt and may remain reusable if it settles; otherwise its process shuts down. JavaScript interruption force-kills its VM. Lost/uncertain warm state is never replayed or replaced with an older snapshot. A cancelled/timed-out persistent shell is quarantined too.

## Explicit kernel lifecycle and targets

`protolens context` controls kernels without entering their execution queue:

```bash
protolens context '{"resource":"kernel","op":"list"}'
protolens context '{"resource":"kernel","op":"start","language":"python","lane":"analysis","interpreter":"/work/.venv/bin/python","cwd":"/work"}'
protolens context '{"resource":"kernel","op":"inspect","language":"python","lane":"analysis"}'
protolens context '{"resource":"kernel","op":"keepalive","language":"python","lane":"analysis","ttlMs":600000}'
protolens context '{"resource":"kernel","op":"reset","language":"python","lane":"analysis"}'
protolens context '{"resource":"kernel","op":"close","language":"python","lane":"analysis","force":true}'
```

Python `lane:"analysis"` controls the same owner/name identity as `harness.kernel("analysis")`, under `python:`, when interpreter/cwd/target match. It does not pin or route ordinary Python. Specify `interpreter` to disambiguate environments. JavaScript lanes still select routed Node/Bun cells. Configuration changes require reset; reset retains the environment unless overridden, close forgets it. Busy close requires `force:true`. Inspect/list and forced close remain available during execution. Keepalive is a bounded lease of at most one hour, not immortality; owner disposal still closes owned runtimes.

Python and Bun support local, existing-container, and SSH targets; Node is local-only:

```bash
protolens context '{"resource":"kernel","op":"start","language":"python","lane":"container","target":{"kind":"container","engine":"docker","container":"devbox","cwd":"/work","interpreter":"python3"}}'
protolens context '{"resource":"kernel","op":"start","language":"bun","lane":"remote","target":{"kind":"ssh","host":"builder","cwd":"/work","hostCommand":["proto"]}}'
```

Paths/interpreters must exist. Containers must be running; SSH uses existing noninteractive authentication. Targets require POSIX `sh`, `setsid -w`, and an absolute existing cwd. Bun needs a compatible installed Proto CLI (`hostCommand`) with the parent's Bun version. Proto does not provision environments, install dependencies, forward ambient credentials, or fall back locally. Shutdown cleans up owned target process groups.

**Filesystem boundary:** native file APIs, script paths, interpreter paths, and target cwd address the target. Session tools, `harness.fs`, artifact `path` publication, and Bash-resolved paths address the host. Python `harness.symbols(path)`/`harness.block_range(path, line)` read host files; use absolute host paths from remote code or pass target text to `harness.symbols(code=source, lang="python")`. JavaScript bridge-backed source helpers read target source before host parsing. Internal URLs are not target mounts. Transfer target bytes as artifact values rather than treating host paths as remote paths. The Python API and serializer are staged self-contained with the compiled CLI; target interpreters and user dependencies remain the target's responsibility.

## Live tool and background-job events

Python `harness.start_tool(name, args)` / JavaScript `await startTool(name, args)` returns an owned execution handle without waiting for its final result. Consume `harness.tool_events(handle, cursor=0, limit=128, wait_ms=30000)` or `for await (const event of toolEvents(handle, {cursor, limit, waitMs}))` while work runs:

```python
import proto_harness as harness

job = harness.start_tool("bash", {"command": "printf 'ready\\n'; exit 7", "async": True})
for event in harness.tool_events(job):
    print(event)
harness.dispose_tool(job)
```

Events contain `executionId`, monotonic `sequence`, `kind`, `data`, and `terminal`. Updates and tool `result` are distinct; terminal `complete` follows settlement of owned managed background jobs, so an async Bash launch acknowledgement is not mistaken for completion. The final job result, including nonzero exit status, is available in job settlement data. Bounded retention makes overflow visible through `gap` events; resume using the last consumed sequence as `cursor` rather than assuming a complete transcript. Oversized payloads carry explicit omission metadata; retain bulk data as artifact values instead of treating the event feed as an unbounded result store.

Breaking an iterator does not cancel work. Use `harness.cancel_tool(handle, wait_ms=...)` / `await cancelTool(handle, {waitMs})`; then `harness.dispose_tool(handle)` / `await disposeTool(handle)` after settlement to release retained events. Cancelling the event execution also cancels its owned descendant jobs, not unrelated sibling work. Session disposal cancels owned subscriptions and work. A noncooperative callback is not falsely reported stopped merely because cancellation was requested.

## Immutable artifact values and rich completions

Use `harness.publish_artifact(value, kind="json")` / `await publishArtifact(value, {kind:"json"})` to retain data without copying it into every model-visible result. `kind="text"` stores text; `kind="binary"` accepts native Python bytes or JavaScript `Uint8Array`, or base64 with `encoding="base64"`. `path` snapshots a parent-host file rather than creating a live reference.

The returned reference contains `type`, `version`, `uri`, `owner`, `mimeType`, byte count, and SHA-256. Files use the existing `artifact://` store. Handles are immutable, verified, and session-owned: changing the source file does not change the snapshot; tampered or foreign handles fail. Kernel reset preserves them, but session disposal revokes them. Restoring handle metadata in another session does not grant access.

`harness.read_artifact(ref, offset=0, length=..., encoding="utf8")` / `await readArtifact(ref, {offset,length,encoding})` returns `{ref,offset,bytes,eof,encoding,data}`. Reads are bounded to 1 MiB per page; offsets and lengths are bytes, not text characters. UTF-8 pages end on a character boundary, so `bytes` can be less than `length`; continue at `offset + bytes`. Bytes that are not valid UTF-8 fail with an error; read binary data with `encoding="base64"`. `ref` may also be the bare `artifact://<id>` URI of an artifact this session published. `harness.resolve_artifact(ref)` / `await resolveArtifact(ref)` validates the handle without returning its payload. Use explicit pages for large transfers.

`harness.completion()` / JavaScript `completion()` accepts a string, and now also accepts a reference or an array of text/media parts and references:

```python
from pathlib import Path
import proto_harness as harness

image = harness.publish_artifact(Path("plot.png").read_bytes(), kind="binary", mime_type="image/png")
answer = harness.completion([
    {"type": "text", "text": "Describe the trend and flag uncertainty."},
    image,
])
print(answer)
```

The active/selected model must support every input modality. Explicit media parts are `{type:"image"|"audio"|"video", data:<base64>, mimeType}` or `{type:..., artifact:ref}`; ordinary text is `{type:"text", text}`. MIME/byte consistency, content bounds, provider wire support, and image-detail options are validated before sending. Unsupported modalities fail rather than silently degrading to a text-only request. `system`, model selection, and schema-return behavior remain unchanged.

A tier selector (`tiny`, `smol`, `default`, `slow`) follows the same `retry.fallbackChains` as session recovery: when the tier's model fails or has no credentials, `completion()` tries the chain's fallbacks in order (including a fallback's own chain, honoring `:level` effort suffixes) until one answers, spending at most `retry.maxRetries` attempts; `retry.enabled: false` or `retry.modelFallback: false` keeps it on the tier model. An explicit model id is never substituted. At most 32 `completion()` requests run at once per process; extra calls queue.

## Scoped access from ordinary scripts

Ordinary agent-shell Python scripts can explicitly import `proto_harness` during their authenticated run. Independently managed scripts do not inherit prelude objects or `protolens`. For clients whose lifetime must be managed separately, use delegation: it supplies thin Python/JavaScript clients with a revocable, expiring capability, without exporting private runtime credentials.

```python
import proto_harness as harness

lease = harness.delegate([
    {"tool": "__completion__"},
    {"tool": "__runtime__", "operations": ["artifact_publish", "artifact_read", "artifact_resolve"]},
], ttl_ms=60000, max_concurrent=2, max_requests=20)
harness.launch_delegated(lease, name="report", application="python3", args=["report.py"])
```

In the ordinary `report.py` script:

```python
from proto_session import SessionClient
session = SessionClient.from_env()
result = session.completion("Give a short heading for a test report.")
reference = session.publish_artifact({"heading": result})
print(reference)
```

`harness.delegate` returns a lease snapshot and the packaged client paths. Python uses keyword options; JavaScript uses `{ttlMs,maxConcurrent,maxRequests,expose}`. JavaScript scripts import `SessionClient` from the returned client module and call `await SessionClient.fromEnv()`. Grants name exact tools, optionally exact `args.op` operations; special runtime grants permit artifact operations only, not recursive delegation. Execution, control, and agent tools are not delegable; artifact path publication is also denied. Use explicit data values and the managed launcher instead. Calls use the normal session tool/model policies.

`harness.launch_delegated` / `launchDelegated` runs through the existing managed-process supervisor on the parent host and explicitly supplies that lease. For a manually launched script, request `expose=True` / `expose:true` and pass the returned launch environment; never print the capability file or token. Credentials are not automatically exported to arbitrary commands. `harness.delegations()` lists leases; `harness.revoke_delegation(lease)` / `await revokeDelegation(lease)` revokes future calls, cancels in-flight calls, and stops owned launched processes. Expiry and session disposal do the same. Request/concurrency limits are enforced and calls are never implicitly retried. This scopes bridge authority; it is not an OS/filesystem sandbox for code running as the same user.

## Python rich store

Fresh-process locals and imports disappear at exit. Save deliberate session values in `harness.store`:

```python
import proto_harness as harness

shared = []
with harness.store.transaction() as store:
    store["left"] = shared
    store["right"] = shared
```

In another fresh run with the same compatible environment:

```python
import proto_harness as harness

assert harness.store["left"] is harness.store["right"]
harness.store["left"].append("retained")
harness.store.commit()
```

Assignments/deletions commit automatically; in-place mutations need `commit()`. `transaction()` batches mutations into one commit, not an external side-effect transaction. The whole mapping is one graph so shared references survive. Commits use revision compare-and-swap; a competing writer produces a conflict rather than overwriting its graph. Use `refresh()` and explicitly reapply the intended edit. Store graphs have the same 64 MiB encoded limit and environment/resource restrictions as named warm snapshots.

## Selected data files and JavaScript declared state

JavaScript selected-data files remain distinct from rich Python graphs and automatic history continuity. JavaScript uses `await saveState(path, ["summary", "payload"])` and `await loadState(path, {collision:"reject"})`. Python uses `harness.store` or named-kernel graph snapshots instead; the old Python selected-file codec and its helpers are removed.

The selected-data codec accepts bounded acyclic plain values, bytes, and artifact metadata, not rich graphs or live resources. Files are versioned and atomic with a 16 MiB encoded limit. JavaScript continues to read compatible historical selected-data files, rejecting integers beyond ±(2^53−1) rather than rounding them. Names must be valid non-reserved top-level bindings. Explicit `collision:"overwrite"` may replace mutable JavaScript bindings through live setters; `const`, imports, and reserved names reject the entire restore before mutation.

### Declared session state

Python named namespaces are captured automatically, as described under [residency and continuity](#residency-and-continuity). JavaScript retains its existing explicit data-only declaration:

```javascript
const summary = {passed: 12, failed: 0};
const payload = new Uint8Array([0, 128, 255]);
declareState(["summary", "payload"]);
```

`declareState(names)` replaces the selected-name list; `declareState([])` clears it. Values are validated without custom getter/proxy execution. Unsupported/deleted selected bindings fail capture visibly. Completed model-turn boundaries are durable; arbitrary intermediate cells/messages are not.

JavaScript manifests use the selected-data codec: 16 MiB encoded per kernel, 4,096 names, 100,000 nodes, depth 64. Immutable manifests bind the exact session entry, runtime, lane, cwd, interpreter, and target, using durable blobs outside lossy transcript truncation. All reachable historical manifests remain with branches; there is no recent-turn cutoff or nearest-earlier fallback. Restore requires a matching environment and validates before destructive navigation. Corrupt or missing exact state refuses transition; safe parking retains immutable metadata without reviving the runtime.

JavaScript declaration is data continuity, not heap cloning: shared mutable aliases/cycles, custom objects, retained resources, closures, imports, undeclared bindings, live descendants, and external effects are not restored. Multiple declared physical namespaces colliding on the same lane/environment refuse capture; use distinct lanes. `retainTask` resources prevent a declared boundary. Artifact metadata never grants access by itself. Forked declared data is independent; context-only rewind does not roll computation back.

See [session operations](./session-operations.md#declared-state-at-temporal-boundaries) and [interpreter resource policy](./interactive-memory.md#interpreters-subprocesses-and-provider-state).

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

Python callbacks are zero-argument thunks or single-value stages; call `harness.task_signal().check()` inside cooperative loops. JavaScript thunks receive `(index, signal)` and stages `(value, index, signal)`. Helpers drain work and observers before returning: a noncooperative callback can overrun its deadline, but is not falsely reported stopped while side effects continue. Streaming deadlines cover the whole item across stages; barrier deadlines apply separately to each stage-item. Host concurrency ceilings still apply.

```python
import proto_harness as harness

rows = harness.pipeline([1, 2, 3], lambda n: n * 2, lambda n: {"answer": n + 1},
                streaming=True, settled=True, concurrency=2,
                checkpoint="workflow-checkpoints", key="double-plus-one-v1", resume=True)
harness.display(rows)
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

`kernel.speculation.enabled` prelaunches eligible top-level `harness.completion()` calls after `import proto_harness as harness`, or JavaScript `completion()` calls, with literal arguments as their source becomes complete. Python keyword options and JavaScript literal options objects are supported. For example:

```bash
python <<'PY'
import proto_harness as harness

summary = harness.completion("Summarize the purpose of speculative execution.", model="smol")
title = harness.completion("Give a short title for a document about speculative execution.")
print(summary, title)
PY
```

The finalized Python process or JavaScript cell runs normally. A matching real completion invocation can claim its already-running result rather than make another request. Identical calls remain separate stochastic samples, not one memoized answer. Claiming is scoped to the originating call and runtime invocation, with model/options and finalized input matching; it is not a session-wide arguments-only cache.

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

Non-PTY engine calls queue by session and lane; omitted lane and `main` are identical. Named lanes isolate shell and JavaScript kernel state while allowing independent execution. Ordinary Python remains fresh in every lane; named Python state is selected explicitly by `harness.kernel(name)`. A cancelled queued caller never executes. Managed background jobs use their own shell lane (`async:<jobId>` by default), but JavaScript cells reuse the main or explicit lane's kernel. Nested kernel `tool.bash` calls without a lane receive a fresh bridge lane to avoid self-waiting. Do not request the calling shell lane from a nested call.

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
- locale pinned to `LANG=C.UTF-8`/`LC_ALL=C.UTF-8` (byte-order collation, `C` numbers and messages, UTF-8 text) over any inherited locale, unless the caller or direnv env sets `LANG` or an `LC_*` variable; user `!` commands keep the inherited locale.

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
- [`src/eval/shell-bridge.ts`](../packages/coding-agent/src/eval/shell-bridge.ts) — routes JavaScript cells to retained runtimes and drains structured output; ordinary Python executes natively.
- [`src/session/streaming-output.ts`](../packages/coding-agent/src/session/streaming-output.ts) — `OutputSink`, `TailBuffer`, truncation/artifact spill, and summary metadata.
- [`src/tools/output-meta.ts`](../packages/coding-agent/src/tools/output-meta.ts) — truncation metadata shape + notice injection wrapper.
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts) — session-level `executeBash`, message recording, abort lifecycle.
- [`src/modes/components/bash-execution.ts`](../packages/coding-agent/src/modes/components/bash-execution.ts) — interactive `!` command execution component.
- [`src/modes/controllers/command-controller.ts`](../packages/coding-agent/src/modes/controllers/command-controller.ts) — wiring for interactive `!` command UI stream/update completion.
- [`src/modes/rpc/rpc-mode.ts`](../packages/coding-agent/src/modes/rpc/rpc-mode.ts) — RPC `bash` and `abort_bash` command surface.
- [`src/internal-urls/artifact-protocol.ts`](../packages/coding-agent/src/internal-urls/artifact-protocol.ts) — `artifact://<id>` resolution.
