# Bash Tool Python Kernel

This document describes the Python execution stack in `packages/coding-agent`.
It covers Bash kernel-cell behavior, runner lifecycle, environment handling, execution semantics, output rendering, supported magics, and operational failure modes. The cross-language cell contract lives in [Bash tool runtime](bash-tool-runtime.md#kernel-cell-reference); this page focuses on Python internals.

The model reaches this runtime through supported `python`/`python3` Bash invocations with code on stdin or through bare `python -c` code. The persistent Python runtime itself remains an internal `eval` backend; it is not a separate model-facing tool.

## Scope and Key Files

- Bash kernel-cell bridge: `src/eval/shell-bridge.ts`
- Kernel-cell detection and source spans: `src/tools/bash-embedded-code.ts`
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

A supported Bash invocation executes one Python cell inside the Python runner subprocess (retained in `session` mode, fresh in `per-call` mode). NDJSON control uses private descriptors, separate from program stdin/stdout/stderr. No Jupyter gateway and no extra pip dependencies are required. The bundled runner uses Python 3.10 syntax (`str | None`), so the effective requirement is Python 3.10+; the local availability probe checks the version unless `PI_PYTHON_SKIP_CHECK` bypasses it, and an older interpreter selected by a Bash command runs that command as a plain process instead. Rich `display()` output (PIL, pandas, Plotly, and Matplotlib figures) works because the wrapper implements MIME-bundle dispatch.

Supported forms include:

```bash
python <<'PY'
from pathlib import Path
print(Path("package.json").read_text())
PY

python -c 'print("one persistent Python cell")'
```

A pipeline can provide the source on stdin, and `python fleet://<name>.py` runs a supported internal fleet script in the kernel. Ordinary script paths, `-m`, unsupported interpreter flags, and calls made without the Bash kernel bridge use a normal external interpreter instead. Supported `-c`, `-`, and fleet-script invocations accept program arguments and expose the native `sys.argv` shape. Bash supplies the language and source through the command; there is no separate `language`, `code`, `title`, `timeout`, or `reset` cell object. The enclosing Bash `timeout` controls the cell's deadline.

Each retained Python runtime executes cells in order; state persists across later Bash kernel-cell invocations in session mode. Ordinary cells run on the main thread without an active event loop, so `asyncio.run()` retains its native meaning. Top-level-await cells drive a retained loop; cell-owned asyncio tasks settle before completion unless explicitly retained with `retain_task(task)`. Python threads/executors and interpreter-shutdown hooks have kernel-process lifetime, not cell lifetime. Put dependent cells in one ordered Bash command rather than relying on parallel Bash-call ordering. The session's enabled backend settings determine whether Python can be routed into the kernel.

## Kernel lifecycle

For a local target, each Python kernel is a single subprocess: `<resolved-python> -u <runner.py>`; container and SSH targets run `<resolved-python> -u -c <embedded runner>` on the target. The runner is bundled with the host binary (Bun text import); local launches stage it in a `proto-python-runner` cache under the OS temp directory once per script hash and reuse it within the host process.

Kernel startup sequence:

1. Local availability check (`checkPythonKernelAvailability`) — verifies that a local Python interpreter resolves and runs; remote targets defer interpreter selection/checking to target startup.
2. Spawn the runner with filtered local or target-safe env and `cwd` (`python -u runner.py` locally; an embedded `python -u -c` bootstrap on container/SSH targets).
3. Send an init request that runs `os.chdir(cwd)`, injects env entries, and puts `cwd` first on `sys.path` (see [Imports](#imports)).
4. Execute `PYTHON_PRELUDE` (idempotent — only initializes once per process). User globals live in a real registered `__main__` module, separate from runner internals, so imports of `__main__` and top-level function/class pickling resolve correctly.

Kernel shutdown:

- Send `{"type": "exit"}` over stdin.
- Wait for process exit with `SHUTDOWN_GRACE_MS` budget.
- Escalate to `SIGTERM` and finally `SIGKILL` if the process does not exit in time.

### Idle reap (Python and JavaScript)

Retained kernels are released after `DEFAULT_KERNEL_IDLE_REAP_MS` (15 minutes) without activity, in `session` mode. Reap candidates are skipped while a cell is executing, while a reset is in flight, and — decisive — while the kernel reports in-flight work:

- Python: the host sends a `{"type": "status"}` control request over stdin; the runner answers with a `done` frame whose `busy` field counts pending request IDs (queued or executing). Backgrounded cells and awaited tool/subagent bridges keep a request pending, so they block the reap. A missing or late answer counts as busy.
- JavaScript: any pending run (including awaited tool/agent bridges) blocks the reap.

Reaping shuts the subprocess/worker down; the next call for that session key starts a fresh kernel and the call's status events include a `kernel-idle-reap` event whose `idleMs` is the configured reap interval. Retained state from before the reap is discarded. Subagents dispose their kernels earlier by design: an idle orchestration worker is parked after `orchestrator.agentIdleTtlMs` (default 60s), and park, kill, and eviction all run `AgentSession.dispose()`, which releases that agent's Python kernel and JS context by owner. The 15-minute reap remains the net for sessions that stay adopted with TTL disabled and for detached main-TUI sessions. Ordinary cell-owned asyncio tasks now settle before completion. Explicit `retain_task` work and runtime-lifetime Python threads do not pin the kernel against idle reap; use the kernel keepalive control when needed. Reset, close, and reap still end retained work.

## Wire protocol (NDJSON, host ↔ runner)

One JSON object per line, UTF-8, `\n` terminated.

Host → runner:

```jsonc
{"id": "<reqId>", "code": "<source>", "silent": false, "storeHistory": true, "cwd": "<optional>", "env": {"<managed-key>": "<value>"}, "shellEnv": {"KEY": "VAL"}, "stdin": true, "invocation": {"argv": ["-c", "arg"], "filename": "<optional>"}}
{"type": "stdin", "id": "<reqId>", "data": "<base64>", "eof": false}
{"type": "tool_response", "requestId": "<requestId>", "reply": {}}
{"type": "cancel", "id": "<reqId>"}
{"type": "status", "id": "<statusId>"}
{"type": "exit"}
```

Runner → host:

```jsonc
{"type": "stdin_request", "id": "<reqId>"}
{"type": "tool_request", "id": "<reqId>", "requestId": "<requestId>", "payload": {}}
{"type": "started",     "id": "<reqId>"}
{"type": "stdout",      "id": "<reqId>", "data": "..."}
{"type": "stdout",      "id": "<reqId>", "encoding": "base64", "data": "...", "text": "..."}
{"type": "stderr",      "id": "<reqId>", "data": "..."}
{"type": "display",     "id": "<reqId>", "bundle": {<mime>: <value>}}
{"type": "result",      "id": "<reqId>", "bundle": {<mime>: <value>}}
{"type": "error",       "id": "<reqId>", "ename": "...", "evalue": "...", "traceback": ["..."]}
{"type": "done",        "id": "<reqId>", "status": "ok"|"error", "executionCount": N, "cancelled": false|true, "exitCode": N?}
```

`env` carries managed kernel variables; `shellEnv` carries per-cell shell variables. `stdin` and `invocation` are optional. `exitCode` is present when the cell raised `SystemExit`, mapped the way CPython maps it at process exit: `None` → 0, an integer → its low byte, anything else → printed to stderr and 1. The cell ends with that status (`status` is `"error"` for a non-zero one) and the kernel keeps its state.

Status events the prelude emits (e.g. `_emit_status("env", count=…)`) ship inside display bundles under `application/x-proto-status` so the existing TUI status renderer keeps working.

## Magics

The runner's source transformer rewrites IPython-style magics to plain Python calls before parsing. Supported set:

| Magic                             | Effect                                                                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `%pip <args>`                     | `sys.executable -m pip <args>` with live streaming output. Newly installed packages are evicted from `sys.modules` so the next `import` picks up the fresh install. |
| `%cd <path>`                      | `os.chdir(path)` (with `~` expansion); emits status event.                                                                                                  |
| `%pwd`                            | Returns `os.getcwd()`.                                                                                                                                      |
| `%ls [path]`                      | Returns `sorted(os.listdir(path))`.                                                                                                                         |
| `%env [KEY[=VAL]]`                | List, read, or set env vars (matches prelude `env()` semantics).                                                                                            |
| `%set_env KEY VALUE`              | Set `os.environ[KEY]`.                                                                                                                                      |
| `%time <expr>` / `%timeit <expr>` | Time the expression; emits status event with elapsed ms.                                                                                                    |
| `%who` / `%whos`                  | List user-namespace names.                                                                                                                                  |
| `%reset`                          | Clear user globals and re-inject prelude.                                                                                                                   |
| `%load <path>`                    | Read a file, display its source, and execute it in the current namespace.                                                                                   |
| `%run <path>`                     | `runpy.run_path` and merge globals back.                                                                                                                    |
| `%%bash`                           | Run the cell body via `bash`.                                                                                                                               |
| `%%capture [name]`                | Run body with stdout/stderr captured into `name`.                                                                                                           |
| `%%timeit`                        | Time the cell body.                                                                                                                                         |
| `%%writefile <path>`              | Write body to file.                                                                                                                                         |
| `!cmd` / `var = !cmd`             | Run command via a subprocess shell; returns a `_ShellResult` with `.n` / `.s` helpers.                                                                      |
| `var = %name args`                | Assignment forms work for line magics and `!cmd`.                                                                                                           |

Unknown magic names raise `NameError: UsageError: ...` inside the cell.

## Session persistence semantics

`python.kernelMode` controls retained kernel reuse:

- `session` (default)
  - Local sessions are keyed by a namespaced session id and normalized cwd; an explicitly selected interpreter contributes its environment identity (resolved binary plus virtual environment). Remote sessions also include the parsed target. Bash picks the interpreter per command as described in [Bash tool runtime](bash-tool-runtime.md#cell-forms-and-api), so one lane can hold a kernel per interpreter.
  - Bash kernel-cell invocations in one session reuse that retained Python kernel; independent orchestrator workers receive distinct session ids and do not share the parent or sibling kernel.
  - Explicit callers may intentionally pass the same kernel session id to preserve shared-state delegation.
  - Parallel Bash calls must not be used for dependent cells; their execution order is not guaranteed.
  - A dead retained subprocess is replaced before execution.
  - If the subprocess dies during execution, completion is uncertain and the cell is not replayed. The next cell starts a new generation and reports state loss; inspect partial effects before retrying.
  - A quiescent kernel is released after 15 idle minutes (see "Idle reap" under Kernel lifecycle); the next cell starts fresh and reports a `kernel-idle-reap` status event.
- `per-call`
  - Spawns a fresh subprocess for each cell.
  - Shuts the subprocess down after the cell.
  - No cross-cell state persistence.

### State across Bash kernel cells

Each recognized interpreter invocation is one cell; a Bash command may contain multiple cells. Later cells reuse the selected retained kernel in `session` mode, while separate Python and JavaScript runtimes never share state. Put dependent cells in one ordered Bash command rather than relying on parallel Bash calls.

If a cell fails, definitions and mutations completed before the error can remain in kernel memory. Python `%reset` clears the user namespace and re-injects the prelude. Bash has no structured per-cell `reset` field; runtime disposal, idle reap, or forced shutdown starts a fresh kernel.

## Imports

A cell stands in for a fresh `python` process, so its imports resolve the way that process would, while variables persist:

- **Search path.** Every cell starts `sys.path` with its invocation working directory, then the `PYTHONPATH` of its own shell environment. The previous cell's entries are replaced, not accumulated; a later cell with a different Bash cwd therefore stops resolving modules from the old directory. An in-cell `%cd`/`os.chdir()` changes the process cwd but does not retroactively rewrite that cell's `sys.path`.
- **Changed source.** Project modules (source loaded from outside the interpreter's stdlib and site-packages) are stamped as their loader executes them. Before each cell, and before the first import after the cell writes a `.py` file, spawns a process, or calls a host tool, the kernel checks those stamps and re-resolves top-level names found on `sys.path`. If any project module changed, was deleted, or now resolves to another file, every reloadable project module is evicted from `sys.modules` (dependents may hold objects from the changed one), and the next `import` re-executes the source.
- **Earlier bindings.** Names bound in earlier cells keep the objects they hold. When an eviction leaves such names pointing at old code, the cell prints `<kernel> note: … names from earlier cells still hold the old code: …`; names the cell rebinds itself are not listed. `importlib.reload(module)` on an evicted module re-executes it in place.
- **Libraries** are never evicted. A rebuilt project C extension cannot be reloaded by CPython; the kernel reports it once and keeps the old build until the kernel is reset.
- Tracebacks omit the runner's own frames, so a failed import reads like plain-interpreter output.

## Environment filtering and runtime resolution

For local launches, the environment is filtered before launching the runner:

- Allowlist includes core vars like `PATH`, `HOME`, locale vars, `VIRTUAL_ENV`, `PYTHONPATH`, etc.
- Allow-prefixes: `LC_`, `XDG_`, `PI_`
- Denylist strips common API keys (OpenAI/Anthropic/Gemini/etc.)

Local runtime selection order (remote targets use their configured target interpreter or `python3` on the target; local discovery is skipped when the `python.interpreter` setting names an explicit executable):

1. Active/located venv (`VIRTUAL_ENV`, then `CONDA_PREFIX`, then `<cwd>/.venv`, `<cwd>/venv`)
2. Managed venv from `getPythonEnvDir()` (normally `~/.proto/python-env`; config/profile/XDG directory settings can change it)
3. `python` or `python3` on PATH

When a venv is selected, its `bin` directory is prepended to `PATH`.

The runner additionally receives `PYTHONUNBUFFERED=1` and `PYTHONIOENCODING=utf-8` so streamed output reaches the host promptly.

## Tool availability and mode selection

The backend settings `eval.py` / `eval.js` default to `true`. Optional boolean environment flags `PI_PY` and `PI_JS` override their corresponding setting independently.

The Bash kernel bridge routes only enabled backends. If Python preflight fails, the invocation follows Bash's normal external-process fallback (with a one-time older-version note when applicable); Bash never substitutes another language. When the bridge is unavailable, the interpreter invocation likewise follows the normal external-process path.

Python prelude helpers include `agent(prompt, *, agent=None, model=None, label=None, schema=None, schema_mode=None, isolated=None, apply=None, merge=None, handle=False)`; the host chooses the effective role when `agent` is omitted. `model` overrides the worker's model and is bank-validated when the effective role has a `modelRoleBank`. It synchronously calls the host bridge and returns final text, or parsed data when `schema` is supplied. `schema_mode` selects permissive or strict structured-output handling; the isolation/apply/merge flags control task worktree behavior. With `handle=True`, it returns a result node dict (`{"text", "output", "handle", "id", "agent"}`) whose handle is the recoverable `agent://<id>` URI; parsed output is also stored under `"data"` when available.

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

Program stdin is a real fd 0 connected to the invocation input stream. `sys.stdin.fileno()`, `os.read(0, ...)`, `input()`, and inherited child stdin use that descriptor; source-on-stdin is consumed as code, not reused as program input. The runner control reader uses its own duplicated descriptor. Input is streamed and backpressured, with EOF when the producer closes. Interactive terminal input is not supported.

## Output capture and rendering

### Captured output classes

From runner frames:

- `stdout` / `stderr` → text chunks, or `encoding: "base64"` frames with a text preview for binary writes
- `display` / `result` → rich display handling (MIME bundle)
- `error` → traceback text
- `application/x-proto-status` MIME inside `display` → structured status events

Display MIME handling:

- `application/x-proto-status` → status events; this is control-plane output.
- `application/json` → JSON tree data; when present, it suppresses the text fallback.
- `image/png` is preferred over `image/jpeg` when both image alternatives are present.
- Otherwise, `text/markdown` is preferred over `text/plain`, followed by `text/html` converted to basic markdown.

Structured image outputs are `image/png` / `image/jpeg`; status events are not persisted as display text.

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

- **Python backend not available** — Check `eval.py`, `PI_PY`, and that `python`/`python3` is on PATH. A failed Python preflight falls back to the shell's normal external interpreter path; it does not select another language.
- **No Python on the local PATH** — Install a system Python 3.10+ or place a compatible venv at the managed path from `getPythonEnvDir()` (normally `~/.proto/python-env`). `proto setup python --check` reports the resolved interpreter.
- **Execution hangs then times out** — Increase `timeout` for legitimate work or set it to `0` to disable the watchdog. For stuck native code, cancellation sends `SIGINT` first and then escalates; session mode recreates the kernel on the next request if it had to be killed.
- **stdin/input prompts in Python code** — Interactive `input()` prompts are not supported; for inline cells, pipe or redirect program input, or pass data programmatically.
- **Working directory errors** — Python starts in the Bash invocation/session cwd. Use Bash `cwd`, `%cd`, or `os.chdir()` for the current cell; each new request reapplies its invocation cwd.

## Relevant environment variables

- `PI_PY` / `PI_JS` — per-backend exposure overrides
- `PI_PYTHON_SKIP_CHECK=1` — bypass Python interpreter availability probes (the runner still starts on demand)
- `PI_PYTHON_IPC_TRACE=1` — debug-log send/receive summaries for NDJSON frames exchanged with the runner subprocess
