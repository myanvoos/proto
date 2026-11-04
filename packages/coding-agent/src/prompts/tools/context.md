Inspect and control this session's execution context. `bash` executes commands and cells; use this tool to see or change lanes and kernels without entering their queues. `resource` and `op` are required; fields irrelevant to the resource/op are rejected.

**`resource:"lane"`** — a bash lane: its FIFO command queue, persistent shell, and the kernels its cells use. Ops: `list`, `inspect`, `reset`, `close`. Only this session's lanes are visible.
- `list`/`inspect` report queue/activity state (`activeSince`, `queued`), shell state, attached kernel summaries, and retained kernel environments (`configured`). Never heap values, environment values, or command text.
- `reset` cancels the running command and every command queued before it (queued ones never run), discards the shell and releases the lane's kernels, keeps the selected kernel environments (cwd/interpreter/target). The next command reports `<shell> state lost`; the next cell starts a new kernel generation and reports `<kernel> state lost`.
- `close` does the same teardown but forgets the lane's kernel environments; later cells use local defaults. It refuses a busy lane (running/queued commands or busy kernel) unless `force:true`.
- Commands issued after a reset/close wait until teardown finishes, then run on the fresh lane.
- A command cannot reset/close its own lane: issue the control from a separate bash lane (e.g. `lane:"control"`) or a direct tool call. That lane stays responsive while the target is busy.

**`resource:"kernel"`** — one named persistent kernel (`python`, `node`, `bun`). Ops: `list`, `start`, `inspect`, `keepalive`, `reset`, `close`.
- `language` names the runtime; required except for `list`. Lane defaults to `main`. Python lanes are explicit names used by `proto_harness.kernel(name)` or `python -m proto_harness.kernel NAME`; ordinary Python commands remain fresh native processes. `interpreter` selects the named kernel environment; `start`/`reset` configure its default, never replace the shell's Python. JavaScript `node` and `bun` retain separate heaps in each lane.
- `list`/`inspect` report host-owned lifecycle metadata, not heap contents. Inside a named Python kernel use `harness.kernel_state()`; from fresh Python use `harness.kernel(name).status()` for lifecycle metadata. JavaScript uses `kernelState()`.
- `close` refuses busy work unless `force:true` and forgets the kernel's lane configuration; later implicit cells use local defaults. Start/configure a remote lane again before reuse. `reset` cancels the kernel's running cell and discards bindings but retains the selected environment unless overridden; it does not touch the lane's shell or command queue. Export selected bindings first when needed.
- Idle reap begins after {{idleReapMinutes}} minutes; `keepalive` extends that idle lease, not lifetime indefinitely. Python can park only safely captured namespaces and restore their exact supported graph lazily; busy, dirty or unknown state is not silently evicted. Memory pressure also bounds Python residency. JavaScript restores supported declared data when captured. Lost uncommitted state refuses execution until an explicit reset, never silently falls back to an older or empty namespace.
- Remote/container targets require an existing reachable environment and compatible runtime. Paths and dependencies belong to that target; no automatic provisioning or local fallback. `node` kernels are local-only; use `bun` (with `hostCommand`) or `python` on a remote target.
- A cell cannot reset/close the kernel it runs in; use a shell command (`protolens context …`) instead.

Explicit reset/close discards that kernel's bindings. Temporal session forks/navigation instead restore exact compatible captured state: Python uses one supported object graph, JavaScript selected data. Live resources cannot be cloned; unsupported state refuses unsafe transitions. `harness.store` is session-owned durable data, not a kernel reset alias. Context compression with `rewind(report)` does not undo computation.

Examples:
```json
{"resource":"lane","op":"list"}
{"resource":"lane","op":"inspect","lane":"analysis"}
{"resource":"lane","op":"reset","lane":"analysis"}
{"resource":"lane","op":"close","lane":"analysis","force":true}
{"resource":"kernel","op":"list"}
{"resource":"kernel","op":"start","language":"python","lane":"analysis"}
{"resource":"kernel","op":"start","language":"node","lane":"analysis","interpreter":"/usr/local/bin/node"}
{"resource":"kernel","op":"reset","language":"bun","lane":"analysis"}
{"resource":"kernel","op":"keepalive","language":"python","lane":"analysis","ttlMs":300000}
{"resource":"kernel","op":"close","language":"python","lane":"analysis"}
```
