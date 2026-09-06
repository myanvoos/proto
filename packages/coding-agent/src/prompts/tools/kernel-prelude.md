{{#ifAll py js}}Python: sync, kwargs. JS: async, ONE trailing object literal, never positional.{{else}}{{#if py}}Sync; kwargs.{{/if}}{{#if js}}Async; ONE trailing object literal, never positional.{{/if}}{{/ifAll}}
```
display(value) → None        print(value, ...) → None
{{#if py}}symbols(path?, code?=None, lang?=None) → str    tree-sitter outline, bodies elided; code= outlines an in-memory string (validate structure BEFORE writing; lang= required without a path)
defs() → dict    kernel-defined names → cell number
{{/if}}{{#if py}}proto_path(path) → Path    resolve a plain, `~/…`, or scheme URL (fleet//local//skill) path to a real filesystem path for the raw file APIs{{/if}}
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
