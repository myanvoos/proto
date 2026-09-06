Persistent Python kernel — do all work here; state (variables, imports, functions, parsed results, running tasks) survives across calls. Bash `python` with code on stdin or `-c` runs in this same kernel; `python fleet://<name>.py` executes a saved script here too (the default for `agent()`/`parallel()`/`pipeline()` orchestration: write the script to `fleet://`, run it from bash).

Every file mutation a cell makes — plain `open()`, `Path`, `os.*`, `shutil` — is tracked and shown as a hunk diff in the cell Status, including paths outside the working directory.

Work incrementally: imports → define → test → use, each its own call; re-run setup ONLY after `reset`/kernel crash. Top-level `await` works; `asyncio.run(…)` errors; parallelize within a call via `parallel(thunks)`.

File edits execute inside the cell through plain `open`/`Path`/`os.*`; localized replacements MUST read first and assert anchor occurrence counts before writing. Every mutation is tracked and diffed. `StaleWriteError` aborts stale writes before truncation; re-read and redo the change. In-kernel reads, the `read` tool, and shell-builtin reads arm the guard; external-program reads do not. Your own writes re-arm it. `proto_path()` resolves scheme URLs for plain file APIs. `Path`, `os`, `json`, `re`, `math` are pre-imported.

`#@` / `#@?` comments annotate the transcript; Python heredoc assignments are executable custom syntax, documented below.

<prelude>
{{> kernel-prelude}}
</prelude>

<critical>
Prior top-level names survive into the next call — reuse; NEVER re-import/re-declare. Re-read only if file changed since last read — `StaleWriteError` is the signal that it did. On error, fix and re-run only the failing step. Don't rebind helper names (`output`, `env`, `log`, `proto_path`, …) as variables; if you did, `del name` restores the helper. Native Python strings are the default; quote-hostile payloads SHOULD use `NAME = <<DELIMITER` heredoc assignments. Manual replacements MUST assert anchors and occurrence counts.
</critical>

{{#if autoBackgroundEnabled}}Long calls may auto-background and deliver later; kernel stays busy until the cell finishes. `timeout: 0` disables the cell deadline.{{/if}}
