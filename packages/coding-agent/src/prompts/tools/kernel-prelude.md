{{#ifAll py js}}Python: sync, kwargs. JS: async, ONE trailing object literal, never positional.{{else}}{{#if py}}Sync; kwargs.{{/if}}{{#if js}}Async; ONE trailing object literal, never positional.{{/if}}{{/ifAll}}
```
display(value) → None        print(value, ...) → None
{{#if py}}symbols(path?, code?=None, lang?=None) → str    tree-sitter outline, bodies elided; code= outlines an in-memory string (validate structure BEFORE write; lang= required without a path)
defs() → dict    kernel-defined names → cell number
{{/if}}{{#if py}}read_text(path, start?=1, end?=None, numbered?=False) → str    tracked read (arms the stale-write guard); start/end = 1-indexed inclusive line slice; numbered → "N|line" rows for edit anchors (views only — never write a slice back)
write(path, content, overwrite?=False, guard?=True) → Path    the written file's path, not content; refuses an existing file unless overwrite=True; StaleWriteError if the file changed on disk since your last read (guard=False overrides)
edit(path, old, new, count?=1, guard?=True) → dict    anchored in-place edit: old is an EXACT literal substring, count = required occurrence count (None = replace all); mismatch → AnchorNotFoundError/AmbiguousAnchorError with line numbers, nothing written. edit(path, [(old, new), …]) = multi-hunk, atomic (all anchors resolve on the original text or nothing is written){{/if}}{{#if js}}write(path, content) → str{{/if}}
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
