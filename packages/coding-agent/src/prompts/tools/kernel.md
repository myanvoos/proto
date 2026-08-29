Persistent Python kernel — do all work here. State (variables, imports, functions, parsed results, running tasks) survives across calls.

Work incrementally: imports → define → test → use, each its own call. Re-run setup ONLY after `reset` or kernel crash.
Top-level `await` works; `asyncio.run(…)` raises error. Parallelize *within* a call with `parallel(thunks)`.

Read/edit files and run project commands from here: Python (`open`, `pathlib`) and `bash()` are the default; `tool.<name>` is for capabilities with no Python equivalent (browser, lsp, github, …).

<prelude>
{{> kernel-prelude}}
</prelude>

<critical>
Prior top-level names survive into the next call — reuse; NEVER re-import/re-declare. Re-read only if file changed since last read.
On error, fix and re-run only the failing step.
`bash()` is not a sandbox: it runs with session permissions and interrupts kill its whole process group.
</critical>

{{#if autoBackgroundEnabled}}Long-running calls may auto-background by the configured threshold and deliver later; the kernel stays busy until the cell finishes.
`timeout: 0` disables the cell deadline; otherwise `timeout` sets it without extending foreground waiting.{{/if}}
