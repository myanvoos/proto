{{#ifAll py js}}Python: sync, kwargs. JS: async, ONE trailing object literal, never positional.{{else}}{{#if py}}Sync; kwargs.{{/if}}{{#if js}}Async; ONE trailing object literal, never positional.{{/if}}{{/ifAll}}
```
display(value) → None        print(value, ...) → None    # images render inline in the TUI: display(PIL.Image) or display(pandas.DataFrame); open matplotlib figures auto-display at cell end even after plt.close()
{{#if py}}symbols(path?, code?=None, lang?=None) → str{{/if}}{{#ifAll py js}}; {{/ifAll}}{{#if js}}symbols(path?, {code?, lang?}?) → string{{/if}}    tree-sitter summary: declarations stay; bodies ≥4 lines and comments ≥6 lines fold to `N-M: <elided>` (first/last lines kept); code outlines an in-memory string (validate structure BEFORE writing; lang required without a path)
{{#if py}}defs() → dict    kernel-defined names → cell number
{{/if}}{{#if py}}proto_path(path) → Path    resolve a plain, `~/…`, or scheme URL (fleet//local//skill) path to a real filesystem path for the raw file APIs{{/if}}
{{#if js}}protoPath(path) → string    {{#if py}}JS twin of proto_path{{else}}resolve a plain, `~/…`, or scheme URL (fleet//local//skill) path to a real filesystem path for the raw file APIs{{/if}}{{/if}}
{{#if py}}block_range(path, line) → (start, end) | None{{#unless js}}    syntactic block containing the 1-based line{{/unless}}
{{/if}}{{#if js}}blockRange(path, line) → [start, end] | null    syntactic block containing the 1-based line
{{/if}}env(key?=None, value?=None) → str | None | dict
output(*ids, format?="raw"|"json"|"stripped", query?=<jq path>, offset?, limit?) → reads agent/task outputs by id (e.g. "scout_0"); `query` is exclusive with `offset`/`limit`; bash artifacts are read with `read artifact://N:A-B`, not `output()`.
tool.<name>(args) → unknown    invoke any session tool; `args` = its parameter object
completion(prompt, model?="default"|"smol"|"slow"|<pool model id>, system?=None, schema?=None) → str | dict    oneshot, stateless; `schema` → parsed object; bare model id resolves only when one provider offers it, else `provider/id`; prompt = text, artifact ref, or content parts [{type:"text",text}, ref, {type:"image"|"audio"|"video",data:<base64>,mimeType}]; selected model MUST support every part
{{#if spawns}}agent(prompt, agent?="{{spawnDefaultAgent}}", model?=None, label?=None, schema?=None, schema{{#if js}}Mode{{else}}_mode{{/if}}?="permissive", isolated?=None, apply?=None, merge?=None, handle?=False) → str | dict
    Subagent → final output; omit `agent` → `{{spawnDefaultAgent}}`.{{#if spawnAllowedAgentsText}} Allowed: {{spawnAllowedAgentsText}}.{{/if}} `isolated` = worktree; `apply`/`merge` control its changes. Background via `local://` files named in the prompt. `handle` → { text, output, handle: "agent://<id>", id, agent }; `schema` overrides agent/session schemas → parsed data; `model` overrides the worker's model (bank-validated).
{{#if js}}    JS: ONE trailing object — agent(prompt, { agent, model, label, schema, schemaMode, isolated, apply, merge, handle }).{{/if}}
{{/if}}parallel(thunks, options) → list     pipeline(items, ...stages, options) → list
executions(id?, limit?=20) → {records, evicted}    recent Bash results, per-stage status/streams, structured deviceResults; JS executions(id, {limit})
{{#if py}}start_tool(name, args?={}) → handle; tool_events(handle, cursor?=0, limit?=128, wait_ms?=30000) → iterator
cancel_tool(handle, wait_ms?=30000); dispose_tool(handle)    cancel work; dispose only after settlement
publish_artifact(value?, kind?="json"|"text"|"binary", path?, mime_type?, encoding?="base64") → immutable ref; native bytes require kind="binary"
read_artifact(ref, offset?=0, length?, encoding?="utf8"|"base64"|"json") → {data,offset,bytes,eof,encoding,ref}; resolve_artifact(ref) → validated ref; ref may be a bare "artifact://N" this session published. utf8 pages end on a character boundary (continue at offset+bytes); non-UTF-8 bytes error → encoding="base64"
save_state(path, names); load_state(path, collision?="reject"|"overwrite") → selected data bindings, not heap snapshots
{{/if}}{{#if js}}startTool(name, args?) → handle; toolEvents(handle, {cursor:0,limit:128,waitMs:30000}?) → async iterator
cancelTool(handle, {waitMs:30000}?); disposeTool(handle)
publishArtifact(value?, {kind:"json"|"text"|"binary",path?,mimeType?,encoding?:"base64"}?) → ref; readArtifact(ref, {offset?,length?,encoding?:"utf8"}?) → read page; resolveArtifact(ref) → validated ref; ref may be a bare "artifact://N" this session published
saveState(path, names); loadState(path, {collision:"reject"|"overwrite"}?)
{{/if}}delegate(grants, options) → lease handle    grants=[{tool,operations?:[exact op values]}]; Python ttl_ms/max_concurrent/max_requests/expose kwargs; JS ttlMs/maxConcurrent/maxRequests/expose object
{{#if py}}delegations(); revoke_delegation(handle); launch_delegated(handle, name=..., application=..., args?=[], cwd?, env?)
{{/if}}{{#if js}}delegations(); revokeDelegation(handle); launchDelegated(handle, {name,application,args?,cwd?,env?})
{{/if}}
{{#if py}}kernel_state(limit?=200) → dict    generation, language/interpreter/cwd, `variables` [{name,type,preview,cell,provenance}], tasks; no heap snapshot
edit_batch(changes, apply?=False) → dict    [{path,before,after}]; before=None requires new file; preview by default
{{/if}}{{#if js}}defs() → object    kernel-defined names → cell number
kernelState({limit:200}) → object    JS state inspection; queued=null means unavailable
editBatch(changes, {apply:false}) → object    [{path,before,after}]; before=null requires new file; preview by default
{{/if}}
log(message) → None         phase(title) → None
budget → {{#if py}}`budget.total` (ceiling or None), `budget.spent()`, `budget.remaining()`{{/if}}{{#if js}}`await budget.total()`, `await budget.spent()`, `await budget.remaining()`{{/if}}{{#if rb}}`budget.total`, `budget.spent`, `budget.remaining`{{/if}}{{#if jl}}`budget.total`, `budget.spent()`, `budget.remaining()`{{/if}}; ceiling `+Nk` advisory, `+Nk!` hard.
```

Orchestration options: Python kwargs; JS trailing object. `settled` → ordered `{status,index,stage,value|error}` rows (`fulfilled|rejected|timed_out|cancelled`); otherwise failure throws `BatchError` retaining `.results`. `concurrency` caps work; pipeline `streaming` advances each item without a batch barrier.
- Python `timeout` seconds, `cancel` event, `on_result`; cooperative loops call `task_signal().check()`. JS `timeoutMs`, `signal`, `onResult`; callbacks receive an `AbortSignal`. Helpers drain callbacks before returning; noncooperative work can exceed its deadline.
- `checkpoint` directory + workflow `key` save successful JSON results. `resume` REQUIRED to reuse them; change `key` when code changes. Checkpointed `parallel` also requires unique stable string `keys`. No implicit retries; no heap/closure snapshots.
- Checked batches validate every `before` first; any stale snapshot returns `state:"conflict"` with `conflicts` [{path, reason: stale|exists|missing}] and writes nothing. `apply` commits each file atomically; batch failure attempts rollback, reports `partial` conflicts (`changed`/`rollback-failed`), NEVER guarantees cross-file atomicity. Inspect returned `state`, `error`, `conflicts` before continuing. Applied files emit `<kernel> note:` lines and re-arm the stale-write guard like kernel writes.
- Execution history and stage captures bounded; check `evicted`, `omittedAfter`, stream `truncated`/`complete`. Stream artifacts contain captured previews; result output artifacts retain normal Bash output. History-query results are omitted from history to prevent recursive retention.
- Live events: `{executionId,sequence,kind,data,terminal}`; `gap` marks evicted history; check `omitted` on bounded payloads; `result` holds tool output, terminal `complete` follows owned background-job settlement. Iteration ending/breaking does NOT cancel; cancel explicitly, then dispose.
- Artifacts are session-owned snapshots, not mutable paths; kernel reset preserves handles, session disposal revokes them. Remote kernel file APIs address the target; tools, bridge-backed path helpers, artifact `path`, and delegated launches address the parent host. Remote internal filesystem URLs are unavailable; use target paths. Transfer target bytes with `publish_artifact`/`publishArtifact`, not a target path.
- State saves require explicit binding names; only acyclic plain data/bytes/artifact refs. Restores validate before mutation; collisions reject unless overwrite requested. No resources, closures, replay, or cross-language heap conversion.
- Delegation is explicit, expiring, revocable tool access—not an OS sandbox. Use packaged clients returned by `delegate`; managed launch passes only the scoped capability. Manual launch requires `expose=True`/`expose:true`; NEVER print capability files or tokens.

{{#if py}}
Python heredoc assignments: quote-hostile literal payloads without interpolation. Custom kernel syntax only; invalid in standalone Python.
- `NAME = <<DELIMITER` on its own line binds the body to `NAME`; both names MUST match `[A-Za-z_][A-Za-z0-9_]*`. Whitespace around `=` and after `<<` optional.
- Close with `DELIMITER` alone at the assignment's indentation; trailing spaces/tabs allowed.
- Body content, including indentation, stays verbatim. Lines join with `\n`; delimiter-boundary newline excluded. Add a blank body row for a trailing newline.

```python
SCRIPT = <<END_SCRIPT
PATTERN = r"/v1/\d+"

END_SCRIPT
path = Path("route.py")
path.write_text(SCRIPT)

source = path.read_text()
old = r'PATTERN = r"/v1/\d+"'
new = r'PATTERN = r"/v2/\d+"'
assert source.count(old) == 1
path.write_text(source.replace(old, new))
```
{{/if}}
