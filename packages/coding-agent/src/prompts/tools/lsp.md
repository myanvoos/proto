Symbol-aware code intelligence from language servers — navigation, refactors, diagnostics where text tools miss callsites (shadowing, re-exports, cross-file usages).

- Position ops: `file` + `line` + `symbol` (substring; `#N` = Nth match); `line` 1-indexed.
- `rename` applies by default (`apply: false` previews); `rename_file` also rewrites imports/references. Project-aware lookups ERROR without `symbol` — no silent fallback.
- `code_actions`: lists by default; apply ONE with `apply: true` + `query` (title substring or index).
- `diagnostics`: path, glob, or `file: "*"` workspace. `symbols`: `file` lists, `file: "*"` + `query` searches. `reload`: one server or all. `request`: raw `query` = method, `payload` = JSON params.

Symbol-aware work (rename, references, definition, code actions) MUST use `lsp` when a server is available; NEVER cross-file rename via sed/hand edits — text renames silently drop callsites.
