{{#ifAll py js}}Python: sync, kwargs. JS: async, ONE trailing object literal, never positional.{{else}}{{#if py}}Sync; kwargs.{{/if}}{{#if js}}Async; ONE trailing object literal, never positional.{{/if}}{{/ifAll}}
```
display(value) → None        print(value, ...) → None
{{#if py}}edit(path, old, new, count?=1, expect?=None, span?=(start,end)) → Path    refuses unless file holds exactly `count` occurrences of `old` (count=None: all); `expect` pins whole file too; whole-file update = pass full content as `old`; `span`=(start,end) replaces that 0-based char range instead of matching `old` (old=None → blind replace; old given → stale guard on range; no count)
symbols(path) → str    tree-sitter outline, bodies elided
defs() → dict    kernel-defined names → cell number
{{/if}}{{#if py}}write(path, content, overwrite?=False) → Path    refuses an existing file unless overwrite=True; updates go through edit{{/if}}{{#if js}}write(path, content) → str{{/if}}
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
