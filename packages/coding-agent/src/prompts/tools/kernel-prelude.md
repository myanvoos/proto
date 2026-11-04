{{#if py}}Python imports `proto_harness as harness`; all names below require the `harness.` prefix. Helpers are synchronous with keyword options. No implicit globals.

- `harness.store` is a session-owned mapping for rich Python values; concurrent commits reject stale revisions.
- `harness.kernel(name, interpreter=None, cwd=None, target=None)` exposes `.run(code)`, `.exec(file)`, `.status()`, `.stop()`, `.restart()`.
- `harness.fs.read_text(path)`, `.read_bytes(path)`, `.replace(path, old, new, count=1)`, `.write_text(path, text)` and `.write_bytes(path, data)` use host tool admission, atomic edits and cross-process stale-read checks.
{{else}}Preloaded JavaScript globals, described below in Python-style notation.{{/if}}
{{#if js}}JS cells: same helpers in camelCase, `await`ed, options in ONE trailing object — Renamed options: `timeout` (s) → `timeoutMs`, `cancel` → `signal` (thunks receive an `AbortSignal`), `on_result` → `onResult`; `budget.total` → `await budget.total()`.
{{/if}}

### Files and code

File APIs and path-taking helpers use filesystem paths. Internal resources → `tool.read({"path": "skill://name"})` or bash URI arguments. To pass a resolved path into a local cell, set bash `env: {"INPUT": "skill://name/file.md"}`; read it with `os.environ["INPUT"]` / `env("INPUT")`. Cell source and heredoc bodies are not URI-rewritten.

```
symbols(path=None, code=None, lang=None) → str    declarations outline; bodies ≥4 lines and block comments ≥6 lines fold to `N-M: <elided>`; `code=` outlines an unwritten string (`lang` required) to check structure BEFORE writing
block_range(path, line) → (start, end) | None    1-based inclusive lines of the syntactic block containing `line`
```

### Tools, models, agents

```
tool.<name>(args) → {text, details}    call any session tool: tool.read({"path": "src/a.ts:1-40"})
completion(prompt, model="default", system=None, schema=None) → str | dict
{{#if spawns}}agent(prompt, agent="{{spawnDefaultAgent}}", schema=None, schema_mode="permissive", isolated=None, apply=None, merge=None, label=None, model=None, handle=False) → str | dict
{{/if}}parallel(thunks, **opts) → list
pipeline(items, *stages, streaming=False, **opts) → list
output(*ids, format="raw"|"json"|"stripped", query=None, offset=None, limit=None) → subagent/task output by id ("scout_0"); `query` (jq path) excludes `offset`/`limit`
log(message); phase(title)    progress lines in the TUI
budget.total (None = no ceiling); budget.spent(); budget.remaining()    ceiling `+Nk` advisory, `+Nk!` hard (spawns refused past it)
```

- `completion`: one-shot, stateless, no tools — cheap classify/extract/score. `model` = `"tiny"`/`"smol"`/`"default"`/`"slow"` (configured online roles) or a pool model id (`provider/id` when ambiguous). `schema` → parsed dict. `prompt` = text, an artifact ref, or parts `[{type:"text",text}, {type:"image"|"audio"|"video",data:<base64>,mimeType}]`; the model MUST support every part.
{{#if spawns}}- `agent`: blocking subagent run → final text, or parsed data with `schema`.{{#if spawnAllowedAgentsText}} Allowed: {{spawnAllowedAgentsText}}.{{/if}} Subagents see only `prompt`: share large context as `local://` files named in it. `isolated=True` → own worktree; `apply`/`merge` control landing its changes. `label` names the run; `model` overrides its model. `handle=True` → `{text, output, handle: "agent://<id>", id, agent}`.
{{/if}}- `parallel`: zero-argument callables; results keep input order; bind loop variables (`lambda d=d: …`). `pipeline`: each stage maps value → value; a stage waits for every item unless `streaming=True`.
- Opts: `concurrency=N`. Failure raises `BatchError` (`.results` keeps every row); `settled=True` returns rows `{status, index, stage, value|error}` instead. `timeout` (s per item), `cancel` (Event), `on_result` (callback). Deadlines are cooperative: long loops call `task_signal().check()`.
- Checkpoints: `checkpoint=dir` + `key=str` save each successful JSON result; `resume=True` reuses them; change `key` when the code changes. Checkpointed `parallel` also needs `keys=[unique str per item]`. No automatic retries.

### State, history, artifacts

```
executions(id=None, limit=20) → {records, evicted}
publish_artifact(value, kind="json"|"text"|"binary", path=None) → ref {uri: "artifact://N", mimeType, bytes, sha256, …}
read_artifact(ref, offset=0, length=None, encoding="utf8"|"base64"|"json") → {data, offset, bytes, eof}
display(value)    images (PIL, matplotlib), DataFrames, JSON render in the TUI; never program stdout/stderr
env(key=None, value=None) → str | None | dict
```

{{#if py}}- Inside an explicit warm Python kernel only: `harness.defs()` reports binding cells; `harness.kernel_state(limit=200)` reports generation, variables and tasks; `harness.retain_task(task)` retains work beyond its cell. Live resources prevent safe snapshots. Fresh processes use `harness.kernel(name).status()` for lifecycle metadata.
- Python persistence uses `harness.store` or automatic supported-graph snapshots of named kernels. No manual selected-data save/load adapter exists.
{{/if}}{{#if js}}- JavaScript `defs()` / `kernelState()` inspect the current kernel. `saveState(path, names)` / `loadState(path, {collision:"reject"|"overwrite"})` remain a data-only file codec for named plain values, bytes and artifact references. They do not clone arbitrary objects/resources. Overwrite restores mutable live bindings; `const` and imports reject the whole restore before mutation.
{{/if}}
- `executions`: recent bash calls with status and captured streams; post-process earlier output without re-running. Capture is bounded: check `evicted` and each stream's `truncated`.
- `read_artifact` reads only artifacts this kernel published. Bash/tool output artifacts → `tool.read({"path": "artifact://N"})`.
- Remote kernels: ordinary Python `open`/`Path` and JavaScript file APIs address the target. Python `harness.fs`, tools and artifact paths address this host under session policy. Host paths are not remote paths. Transfer target bytes through the artifact API; NEVER forward local capability tokens to a target.

### Rare: live tool events, delegation

```
start_tool(name, args) → handle; tool_events(handle, cursor=0, wait_ms=30000) → events
cancel_tool(handle); dispose_tool(handle)
delegate([{tool, operations}], ttl_ms=…, max_requests=…) → lease; launch_delegated(lease, name=…, application=…, args=[]); revoke_delegation(lease)
```

- `tool_events` yields `{sequence, kind, data, terminal}`; `gap` = evicted history. Leaving the loop does NOT stop the tool: `cancel_tool`, then `dispose_tool` once it settles.
- `delegate` leases scoped, expiring tool access to external processes; it is not a sandbox. Launch its clients with `launch_delegated`; `expose=True` only for manual launches. NEVER print capability files or tokens.
