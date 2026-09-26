Manage named persistent kernels (`python`, `node`, `bun`): inspect resources, select environments, release capacity, or explicitly reset state. Use `bash` to execute cells; use this tool to control a busy kernel without entering its queue.

- `language` names the cell runtime: `python`, `node` (Node.js), or `bun`. Lane defaults to `main`, matching Bash. Each language in one lane is a separate kernel; `node` and `bun` never share a heap. A lane holds one Python kernel per interpreter a `python` command ran on (`.venv/bin/python`, an activated venv); `interpreter` picks one for `inspect`/`close`/`keepalive`, while `start`/`reset` make it the lane's default for bare `python`.
- `list`/`inspect` report host-owned lifecycle metadata, not a heap snapshot. Inspect bindings inside a cell with `kernel_state()` / `kernelState()`.
- `close` refuses busy work unless `force:true` and forgets the lane configuration; later implicit cells use local defaults. Start/configure a remote lane again before reuse. `reset` cancels work and discards bindings but retains the selected environment unless overridden. Export selected bindings first when needed.
- A kernel idle for {{idleReapMinutes}} minutes is released; the next cell starts a fresh one and prints a `<kernel> state lost` notice. `keepalive` defers that release for a bounded lease, not immortality. Session disposal still releases resources.
- Remote/container targets require an existing reachable environment and compatible runtime. Paths and dependencies belong to that target; no automatic provisioning or local fallback. `node` kernels are local-only; use `bun` (with `hostCommand`) or `python` on a remote target.

Examples:
```json
{"op":"list"}
{"op":"start","language":"python","lane":"analysis"}
{"op":"start","language":"node","lane":"analysis","interpreter":"/usr/local/bin/node"}
{"op":"reset","language":"bun","lane":"analysis"}
{"op":"inspect","language":"python","lane":"analysis"}
{"op":"keepalive","language":"python","lane":"analysis","ttlMs":300000}
{"op":"close","language":"python","lane":"analysis"}
```

Control the calling kernel through direct `xd kernel`, not a nested cell waiting on itself. After reset/restart, check the generation and rebuild or explicitly restore selected state; never assume old variables survived.
