{{#ifAll py js}}Python: sync, kwargs. JS: async, ONE trailing object literal, never positional.{{else}}{{#if py}}Sync; kwargs.{{/if}}{{#if js}}Async; ONE trailing object literal, never positional.{{/if}}{{/ifAll}}
```
display(value) → None        print(value, ...) → None
{{#if py}}apply_patch(path, patch_text) → None    Python only; exact context hunks against an existing UTF-8 file; all hunks validate before writing
symbols(path?, code?=None, lang?=None) → str    tree-sitter outline, bodies elided; code= outlines an in-memory string (validate structure BEFORE writing; lang= required without a path)
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
Python verbatim blocks: quotes, backslashes, `%`/`!` stay literal; no interpolation. Both execute at their position in the cell.
- `#@embed NAME` … `#@end`: bind text to NAME; no file write. Body lines joined with `\n`; delimiter-boundary newline excluded. Add a blank body line for a trailing newline.
- `#@patch PATH` … `#@end`: apply context hunks to one existing file. PATH is literal, not a Python expression; spaces allowed. Computed path/body? Use `apply_patch(path, patch_text)`.
- Either header accepts `until=TOKEN`; close with TOKEN instead of `#@end` when the body contains the default terminator.
- Patch body: bare `@@` starts each hunk; ` ` context, `-` delete, `+` add. MUST supply exact, unique old context; hunks ordered and nonoverlapping. Missing/ambiguous context or malformed hunk → error, file unchanged. NEVER add file envelopes, line counts, or fuzzy anchors.
- Indented patch: indent every body row and terminator by the header's indentation; only that prefix is removed. Embed body remains verbatim.
- Patch preserves untouched line endings and terminal-newline presence; added lines inherit local newline style. New files/full replacement? Use `#@embed` + plain file APIs.

```python
#@embed SCRIPT
PATTERN = r"/v1/\d+"

#@end
Path("route.py").write_text(SCRIPT)

#@patch route.py
@@
-PATTERN = r"/v1/\d+"
+PATTERN = r"/v2/\d+"
#@end
```
{{/if}}
