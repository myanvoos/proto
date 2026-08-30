{{#ifAll py js}}Python: sync, kwargs. JS: async, ONE trailing object literal, never positional.{{else}}{{#if py}}Sync; kwargs.{{/if}}{{#if js}}Async; ONE trailing object literal, never positional.{{/if}}{{/ifAll}}{{#if rb}} Ruby: sync, kwargs.{{/if}}{{#if jl}} Julia: sync, kwargs.{{/if}}
```
display(value) → None        print(value, ...) → None
{{#if py}}replace(path, old, new, count?=1, expect?=None) → Path
    Count-checked replacement; refuses unless the file holds exactly `count` occurrences of `old` (count=None: all).
symbols(path) → str
    Structural outline of a code file: declarations with bodies elided (tree-sitter).
defs() → dict
    Functions/classes defined in kernel cells, name → cell number. Reuse before redefining; re-defining shadows prelude primitives warns.
{{/if}}write(path, content) → str
{{#if py}}edit(path, expect?=None, new?=None, transform?=None) → Path
    Guarded write: `edit(path, new=…)` is create-only; `edit(path, expect, …)` writes only if current content equals `expect` byte-for-byte.
block_range(path, line) → (start, end) | None
    Tree-sitter syntactic block extent containing 1-based `line`.
edit_block(path, line, body, expect) → Path
    Replace the syntactic block containing `line` with `body`; refuses unless `expect` equals current content.{{/if}}
env(key?=None, value?=None) → str | None | dict
output(*ids, format?="raw", query?=None, offset?=None, limit?=None) → str | dict | list[dict]
tool.<name>(args) → unknown
    Invoke any session tool; `args` = its parameter object.
completion(prompt, model?="default"|"smol"|"slow", system?=None, schema?=None) → str | dict
    Oneshot, stateless (no history/tools). `model`: "smol" fast | "default" session | "slow" most capable. `schema` (JSON-Schema) → parsed object.
{{#if spawns}}agent(prompt, agent?="{{spawnDefaultAgent}}", label?=None, schema?=None, schema{{#if js}}Mode{{else}}_mode{{/if}}?="permissive", isolated?=None, apply?=None, merge?=None, handle?=False) → str | dict
    Run a subagent → final output. `agent` selects a discovered agent; omit it to use `{{spawnDefaultAgent}}`.{{#if spawnAllowedAgentsText}} Allowed agents: {{spawnAllowedAgentsText}}.{{/if}} `schema` overrides agent/session schemas; `schemaMode`/`schema_mode`: "permissive" | "strict". Effective schemas return parsed data. `isolated` requests a worktree; `apply`/`merge` control its changes. Background via `local://` files named in the prompt. `handle` → { text, output, handle: "agent://<id>", id, agent }, parsed `data` when structured.
{{#if js}}    JS: ONE trailing object — agent(prompt, { agent, label, schema, schemaMode, isolated, apply, merge, handle }).{{/if}}
{{/if}}parallel(thunks) → list     pipeline(items, ...stages) → list
log(message) → None         phase(title) → None
budget → {{#if py}}`budget.total` (ceiling or None), `budget.spent()`, `budget.remaining()`{{/if}}{{#if js}}`await budget.total()`, `await budget.spent()`, `await budget.remaining()`{{/if}}{{#if rb}}`budget.total`, `budget.spent`, `budget.remaining`{{/if}}{{#if jl}}`budget.total`, `budget.spent()`, `budget.remaining()`{{/if}}; ceiling `+Nk` advisory, `+Nk!` hard.
```
