{{#ifAll py js}}Python: sync, kwargs. JS: async, ONE trailing object literal, never positional.{{else}}{{#if py}}Sync; kwargs.{{/if}}{{#if js}}Async; ONE trailing object literal, never positional.{{/if}}{{/ifAll}}
```
display(value) → None        print(value, ...) → None
{{#ifAll py js}}File edits are plain file APIs (`open`/`Path`/`Bun.write`) — no write/edit helpers. Every mutation is tracked and surfaced as a Status hunk diff; a stale-write guard raises StaleWriteError on any write to a file that changed on disk since your last read (re-read the file to re-arm and redo the change).{{/ifAll}}
{{#if py}}symbols(path?, code?=None, lang?=None) → str    tree-sitter outline, bodies elided; code= outlines an in-memory string (validate structure BEFORE writing; lang= required without a path)
defs() → dict    kernel-defined names → cell number
{{/if}}{{#if py}}proto_path(path) → {...}    resolve a plain, `~/…`, or scheme URL (fleet//local//skill) path to a real filesystem path for the raw file APIs{{/if}}
{{#if js}}protoPath(path) → string    JS twin of proto_path{{/if}}
{{#if py}}block_range(path, line) → (start, end) | None
{{/if}}env(key?=None, value?=None) → str | None | dict
output(*ids, format?="raw", query?=None, offset?=None, limit?=None) → str | dict | list[dict]
tool.<name>(args) → unknown    invoke any session tool; `args` = its parameter object
completion(prompt, model?="default"|"smol"|"slow", system?=None, schema?=None) → str | dict    oneshot, stateless; `schema` → parsed object
{{#if spawns}}agent(prompt, agent?="{{spawnDefaultAgent}}", label?=None, schema?=None, schema{{#if js}}Mode{{else}}_mode{{/if}}?="permissive", isolated?=None, apply?=None, merge?=None, handle?=False) → str | dict
    Subagent → final output; omit `agent` → `{{spawnDefaultAgent}}`.{{#if spawnAllowedAgentsText}} Allowed: {{spawnAllowedAgentsText}}.{{/if}} `isolated` = worktree; `apply`/`merge` control its changes. Background via `local://` files named in the prompt. `handle` → { text, output, handle: "agent://<id>", id, agent }; `schema` overrides agent/session schemas → parsed data.
{{#if js}}    JS: ONE trailing object — agent(prompt, { agent, label, schema, schemaMode, isolated, apply, merge, handle }).{{/if}}
{{/if}}parallel(thunks) → list     pipeline(items, ...stages) → list
log(message) → None         phase(title) → None
budget → {{#if py}}`budget.total` (ceiling or None), `budget.spent()`, `budget.remaining()`{{/if}}{{#if js}}`await budget.total()`, `await budget.spent()`, `await budget.remaining()`{{/if}}{{#if rb}}`budget.total`, `budget.spent`, `budget.remaining`{{/if}}{{#if jl}}`budget.total`, `budget.spent()`, `budget.remaining()`{{/if}}; ceiling `+Nk` advisory, `+Nk!` hard.
```
