Persistent Python kernel — do all work here; state (variables, imports, functions, parsed results, running tasks) survives across calls.

Work incrementally: imports → define → test → use, each its own call; re-run setup ONLY after `reset`/kernel crash. Top-level `await` works; `asyncio.run(…)` errors; parallelize within a call via `parallel(thunks)`.

File edits MUST use the kernel helpers (`write`/`edit`/`replace`/`edit_block`), never hand-rolled `pathlib`/`open` writes; shell commands → `bash` tool. `tool.<name>` invokes session tools with no Python equivalent. `files: [{path, content}]` writes files to disk before the code runs — quoting-safe channel for code-like content (raw JSON string; no heredocs/escaping tricks). `#@` (`#@?` = open question) comment lines: margin notes for the user; never execute, never write into files.

<prelude>
{{> kernel-prelude}}
</prelude>

<critical>
Prior top-level names survive into the next call — reuse; NEVER re-import/re-declare. Re-read only if file changed since last read. On error, fix and re-run only the failing step. Don't rebind helper names (`output`, `env`, `log`, `write`, …) as variables; if you did, `del name` restores the helper.
</critical>

{{#if autoBackgroundEnabled}}Long calls may auto-background and deliver later; kernel stays busy until the cell finishes. `timeout: 0` disables the cell deadline.{{/if}}
