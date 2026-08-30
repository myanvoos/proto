Persistent Python kernel — do all work here. State (variables, imports, functions, parsed results, running tasks) survives across calls.

Work incrementally: imports → define → test → use, each its own call. Re-run setup ONLY after `reset` or kernel crash.
Top-level `await` works; `asyncio.run(…)` raises error. Parallelize *within* a call with `parallel(thunks)`.

Do file work from here with Python (`open`, `pathlib`) plus the `write`/`edit`/`replace` helpers; run shell commands through the `bash` tool. `tool.<name>` is for capabilities with no Python equivalent (browser, lsp, github, …).

`files: [{path, content}]` writes files to disk before the code runs — the quoting-safe channel for file creation (content is a raw JSON string; no string-literal nesting, no heredocs). Prefer it over escaping tricks whenever the code itself must produce a file with code-like content.

Session annotations: a comment line starting `#@` (`#@?` marks an open question) is a margin note for the user watching this session — intent, caveats, session context ("retry: BOM stripped this time"). It never executes, never belongs in files you write, and renders as a callout beside the AST preview. Keep them few and load-bearing; regular `#` comments remain for the codebase.

<prelude>
{{> kernel-prelude}}
</prelude>

<critical>
Prior top-level names survive into the next call — reuse; NEVER re-import/re-declare. Re-read only if file changed since last read.
On error, fix and re-run only the failing step.
</critical>

{{#if autoBackgroundEnabled}}Long-running calls may auto-background by the configured threshold and deliver later; the kernel stays busy until the cell finishes.
`timeout: 0` disables the cell deadline; otherwise `timeout` sets it without extending foreground waiting.{{/if}}
