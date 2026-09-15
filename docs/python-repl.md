# Bash Tool Python Kernel

This document describes the Python execution stack in `packages/coding-agent`.
It covers Bash kernel-cell behavior, runner lifecycle, environment handling, execution semantics, output rendering, supported magics, and operational failure modes. The cross-language cell contract lives in [Bash tool runtime](bash-tool-runtime.md#kernel-cell-reference); this page focuses on Python internals.

The model reaches this runtime through supported `python`/`python3` Bash invocations with code on stdin or through bare `python -c` code. The persistent Python runtime itself remains an internal `eval` backend; it is not a separate model-facing tool.

## Scope and Key Files

- Bash kernel-cell bridge: `src/eval/shell-bridge.ts`
- Kernel-cell detection and source spans: `src/tools/bash-kernel-cell.ts`
- Session/per-call kernel orchestration: `src/eval/py/executor.ts`
- Subprocess kernel client: `src/eval/py/kernel.ts`
- Python wrapper / NDJSON server: `src/eval/py/runner.py`
- Prelude helpers loaded into every kernel: `src/eval/py/prelude.py`
- Host-side subagent helper bridge: `src/eval/agent-bridge.ts`
- MIME bundle renderer (text + structured outputs): `src/eval/py/display.ts`
- Shared kernel-cell renderer: `src/tools/eval-render.ts`
- Interactive-mode renderer for user-triggered Python runs: `src/modes/components/eval-execution.ts`
- Runtime/env filtering and Python resolution: `src/eval/py/runtime.ts`

## What Bash's Python kernel is

A supported Bash invocation executes one Python cell inside a retained `python` subprocess that speaks NDJSON over stdin/stdout. No Jupyter gateway and no extra pip dependencies are required. The bundled runner uses Python 3.10 syntax (`str | None`), so the effective requirement is Python 3.10+. Rich `display()` output (PIL, pandas, Plotly, and Matplotlib figures) works because the wrapper implements MIME-bundle dispatch.

Supported forms include:

```bash
python <<'PY'
from pathlib import Path
print(Path("package.json").read_text())
PY

python -c 'print("one persistent Python cell")'
```

A pipeline can provide the source on stdin, and `python fleet://<name>.py` runs a supported internal fleet script in the kernel. Script paths, `-m`, unsupported interpreter flags, extra arguments, and calls made without the Bash kernel bridge use a normal external interpreter instead. Bash supplies the language and source through the command; there is no separate `language`, `code`, `title`, `timeout`, or `reset` cell object. The enclosing Bash `timeout` controls the cell's deadline.

Each retained Python runtime can service overlapping cells at await points; state persists across later Bash kernel-cell invocations in session mode. Put dependent cells in one ordered Bash command rather than relying on parallel Bash-call ordering. The session's enabled backend settings determine whether Python can be routed into the kernel.

## Kernel lifecycle

Each Python kernel is a single subprocess: `<resolved-python> -u <runner.py>`. The runner is bundled with the host binary (Bun text import), written to an `proto-python-runner` cache under the OS temp directory once per script hash, and reused by subsequent spawns.

Kernel startup sequence:

1. Availability check (`checkPythonKernelAvailability`) — verifies that a Python interpreter resolves and runs.
2. Spawn `python -u runner.py` with filtered env and `cwd`.
3. Send an init request that runs `os.chdir(cwd)`, injects env entries, and adds `cwd` to `sys.path`.
4. Execute `PYTHON_PRELUDE` (idempotent — only initializes once per process).

Kernel shutdown:

- Send `{"type": "exit"}` over stdin.
- Wait for process exit with `SHUTDOWN_GRACE_MS` budget.
- Escalate to `SIGTERM` and finally `SIGKILL` if the process does not exit in time.

### Idle reap (Python and JavaScript)

Retained kernels are released after `DEFAULT_KERNEL_IDLE_REAP_MS` (15 minutes) without activity, in `session` mode. Reap candidates are skipped while a cell is executing, while a reset/replacement is in flight, and — decisive — while the kernel reports in-flight work:

- Python: the host sends a `{"type": "status"}` control request over stdin; the runner answers with a `done` frame whose `busy` field counts in-flight request tasks. Backgrounded cells, awaited tool/subagent bridges, and monitors all hold a request task, so they block the reap. A missing or late answer counts as busy.
- JavaScript: any pending run (including awaited tool/agent bridges) blocks the reap.

Reaping shuts the subprocess/worker down; the next call for that session key starts a fresh kernel and the call's status events include a `kernel-idle-reap` event with the idle duration. Retained state from before the reap is discarded. Subagents dispose their kernels earlier by design: an idle orchestration worker is parked after `orchestrator.agentIdleTtlMs` (default 60s), and park, kill, and eviction all run `AgentSession.dispose()`, which releases that agent's Python kernel and JS context by owner. The 15-minute reap remains the net for sessions that stay adopted with TTL disabled and for detached main-TUI sessions. Known gap: fire-and-forget tasks a cell created without awaiting (for example a raw `asyncio.create_task`) are not request tasks and do not block the reap. Session disposal by owner (`disposeKernelSessionsByOwner` / `disposeVmContextsByOwner`) and explicit `reset` remain unchanged. A cleanly exited kernel is now always reported as `confirmed` by kernel shutdown; only a shutdown deadline miss escalates to `SIGTERM`/`SIGKILL` and reports `confirmed: false`.

## Wire protocol (NDJSON, host ↔ runner)

One JSON object per line, UTF-8, `\n` terminated.

Host → runner:

```jsonc
{"id": "<reqId>", "code": "<source>", "silent": false, "storeHistory": true, "cwd": "<optional>", "env": {"KEY": "VAL"}}
{"type": "exit"}
```

Runner → host:

```jsonc
{"type": "started",  "id": "<reqId>"}
{"type": "stdout",   "id": "<reqId>", "data": "..."}
{"type": "stderr",   "id": "<reqId>", "data": "..."}
{"type": "display",  "id": "<reqId>", "bundle": {<mime>: <value>}}
{"type": "result",   "id": "<reqId>", "bundle": {<mime>: <value>}}
{"type": "error",    "id": "<reqId>", "ename": "...", "evalue": "...", "traceback": ["..."]}
{"type": "done",     "id": "<reqId>", "status": "ok"|"error", "executionCount": N, "cancelled": false}
```

Status events the prelude emits (e.g. `_emit_status("find", count=…)`) ship inside display bundles under `application/x-proto-status` so the existing TUI status renderer keeps working.

## Magics

The runner's source transformer rewrites IPython-style magics to plain Python calls before parsing. Supported set:

| Magic                             | Effect                                                                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `%pip <args>`                     | `python -m pip <args>` with live streaming output. Newly installed packages are evicted from `sys.modules` so the next `import` picks up the fresh install. |
| `%cd <path>`                      | `os.chdir(path)` (with `~` expansion); emits status event.                                                                                                  |
| `%pwd`                            | Returns `os.getcwd()`.                                                                                                                                      |
| `%ls [path]`                      | Returns `sorted(os.listdir(path))`.                                                                                                                         |
| `%env [KEY[=VAL]]`                | List, read, or set env vars (matches prelude `env()` semantics).                                                                                            |
| `%set_env KEY VALUE`              | Set `os.environ[KEY]`.                                                                                                                                      |
| `%time <expr>` / `%timeit <expr>` | Time the expression; emits status event with elapsed ms.                                                                                                    |
| `%who` / `%whos`                  | List user-namespace names.                                                                                                                                  |
| `%reset`                          | Clear user globals and re-inject prelude.                                                                                                                   |
| `%load <path>`                    | Read a file into a fresh cell and execute.                                                                                                                  |
| `%run <path>`                     | `runpy.run_path` and merge globals back.                                                                                                                    |
| `%%bash` / `%%sh`                 | Run the cell body via `bash`/`sh`.                                                                                                                          |
| `%%capture [name]`                | Run body with stdout/stderr captured into `name`.                                                                                                           |
| `%%timeit`                        | Time the cell body.                                                                                                                                         |
| `%%writefile <path>`              | Write body to file.                                                                                                                                         |
| `!cmd` / `var = !cmd`             | Run command via subprocess shell; returns an SList-style result with `.n` / `.s` helpers.                                                                   |
| `var = %name args`                | Assignment forms work for line magics and `!cmd`.                                                                                                           |

Unknown magic names raise `NameError: UsageError: ...` inside the cell.

## Session persistence semantics

`python.kernelMode` controls retained kernel reuse:

- `session` (default)
  - Reuses kernel sessions keyed by a namespaced session id, normalized cwd, and interpreter.
  - Bash kernel-cell invocations in one session reuse that retained Python kernel; independent orchestrator workers receive distinct session ids and do not share the parent or sibling kernel.
  - Explicit callers may intentionally pass the same kernel session id to preserve shared-state delegation.
  - Parallel Bash calls must not be used for dependent cells; their execution order is not guaranteed.
  - A dead retained subprocess is replaced before execution.
  - If the subprocess dies during execution, it is replaced and the cell is retried once.
  - A quiescent kernel is released after 15 idle minutes (see "Idle reap" under Kernel lifecycle); the next cell starts fresh and reports a `kernel-idle-reap` status event.
- `per-call`
  - Spawns a fresh subprocess for each cell.
  - Shuts the subprocess down after the cell.
  - No cross-cell state persistence.

### State across Bash kernel cells

Each recognized interpreter invocation is one cell; a Bash command may contain multiple cells. Later cells reuse the selected retained kernel in `session` mode, while separate Python and JavaScript runtimes never share state. Put dependent cells in one ordered Bash command rather than relying on parallel Bash calls.

If a cell fails, definitions and mutations completed before the error can remain in kernel memory. Python `%reset` clears the user namespace and re-injects the prelude. Bash has no structured per-cell `reset` field; runtime disposal, idle reap, or forced shutdown starts a fresh kernel.

## Environment filtering and runtime resolution

Environment is filtered before launching the runner:

- Allowlist includes core vars like `PATH`, `HOME`, locale vars, `VIRTUAL_ENV`, `PYTHONPATH`, etc.
- Allow-prefixes: `LC_`, `XDG_`, `PI_`
- Denylist strips common API keys (OpenAI/Anthropic/Gemini/etc.)

Runtime selection order (skipped entirely when the `python.interpreter` setting names an explicit executable):

1. Active/located venv (`VIRTUAL_ENV`, then `CONDA_PREFIX`, then `<cwd>/.venv`, `<cwd>/venv`)
2. Managed venv at `~/.proto/python-env`
3. `python` or `python3` on PATH

When a venv is selected, its bin/Scripts path is prepended to `PATH`.

The runner additionally receives `PYTHONUNBUFFERED=1` and `PYTHONIOENCODING=utf-8` so streamed output reaches the host promptly.

## Tool availability and mode selection

The backend settings `eval.py` / `eval.js` default to `true`. Optional boolean environment flags `PI_PY` and `PI_JS` override their corresponding setting independently.

The Bash kernel bridge routes only enabled backends. If Python preflight fails, a routed Python cell reports a Python-backend availability error; Bash does not substitute another language. When the bridge is unavailable, the interpreter invocation follows Bash's normal external-process path.

Python prelude helpers include `agent(prompt, *, agent="task", model=None, label=None, schema=None, schema_mode=None, isolated=None, apply=None, merge=None, handle=False)`; `model` overrides the worker's model and is bank-validated when the effective role has a `modelRoleBank`. It synchronously calls the host bridge and returns final text, or parsed data when `schema` is supplied. `schema_mode` selects permissive or strict structured-output handling; the isolation/apply/merge flags control task worktree behavior. With `handle=True`, it returns a DAG node dict (`{"text", "output", "handle", "id", "agent"}`) whose handle is the recoverable `agent://<id>` URI; parsed output is also stored under `"data"` when available.

## Execution flow and cancellation/timeout

### Bash cell timeout

The enclosing Bash `timeout` is the only model-facing deadline for a routed Python cell. It defaults to 300 seconds, `timeout: 0` disables the command deadline, and positive values follow Bash's `1..3600` clamp and positive `tools.maxTimeout` ceiling. There is no separate cell timeout field. Agent/completion bridges and ordinary computation remain inside that enclosing command deadline.

### Kernel execution cancellation

On a Bash abort or deadline:

- The bridge aborts the active runner request and the host sends `SIGINT` to the Python subprocess.
- The runner's exec-time signal handler raises `KeyboardInterrupt` inside user code.
- The cell result is marked cancelled; when the interrupt settles, the Python kernel remains reusable. Use Python `%reset` if the namespace or user state appears corrupted.
- Between requests the runner installs `SIG_IGN` for `SIGINT` so a stray cancel does not tear down the kernel.

If the runner does not emit `done` within 5s of the interrupt (`INTERRUPT_ESCALATION_MS` — e.g. stuck in C code holding the GIL), the host shuts the subprocess down (escalating `exit` → `SIGTERM` → `SIGKILL`), the cell is annotated as kernel-killed, and the kernel is recreated on the next call.

### stdin behavior

Interactive stdin is not supported. The runner does not forward `input()` prompts; user code that calls `input()` blocks until cancellation.

## Output capture and rendering

### Captured output classes

From runner frames:

- `stdout` / `stderr` → plain text chunks
- `display` / `result` → rich display handling (MIME bundle)
- `error` → traceback text
- `application/x-proto-status` MIME inside `display` → structured status events

Display MIME precedence:

1. `text/markdown`
2. `text/plain`
3. `text/html` (converted to basic markdown)

Additionally captured as structured outputs:

- `application/json` → JSON tree data
- `image/png` / `image/jpeg` → image payloads
- `application/x-proto-status` → status events

### Matplotlib

The runner sets `MPLBACKEND=Agg` as an environ default so figures render off-screen. After every cell, `pyplot.get_fignums()` is iterated; each figure is saved to PNG, emitted as an `image/png` display, and closed.

### Storage and truncation

Output is streamed through `OutputSink` and may be persisted to artifact storage. Tool results can include truncation metadata and `artifact://<id>` for full output recovery.

### Renderer behavior

- Bash kernel-cell renderer (`eval-render.ts`, shared with the Bash tool):
  - shows code-cell blocks with per-cell status inside the Bash result
  - collapsed preview defaults to 10 lines
  - supports expanded mode for all output retained in the Bash result
- Interactive renderer (`eval-execution.ts`):
  - used for user-triggered Python execution in TUI
  - collapsed preview defaults to 20 lines
  - clamps very long individual lines to 4000 chars for display safety
  - shows cancellation/error/truncation notices

## Operational troubleshooting

- **Python backend not available** — Check `eval.py`, `PI_PY`, and that `python`/`python3` is on PATH. If another backend is enabled, use its advertised language token.
- **No Python on PATH** — Install a system Python 3.10+ or place a compatible venv at `~/.proto/python-env`. `proto setup python --check` reports the resolved interpreter.
- **Execution hangs then times out** — Increase `timeout` for legitimate work or set it to `0` to disable the watchdog. For stuck native code, cancellation sends `SIGINT` first and then escalates; session mode recreates the kernel on the next request if it had to be killed.
- **stdin/input prompts in Python code** — `input()` is not supported; pass data programmatically.
- **Working directory errors** — Python runs in the session cwd. Use `%cd` or `os.chdir()` inside the retained kernel to change it.

## Relevant environment variables

- `PI_PY` / `PI_JS` — per-backend exposure overrides
- `PI_PYTHON_SKIP_CHECK=1` — bypass Python preflight/warm checks
- `PI_PYTHON_INTEGRATION=1` — enable gated integration tests that spawn a real Python
- `PI_PYTHON_IPC_TRACE=1` — log NDJSON frames exchanged with the runner subprocess
