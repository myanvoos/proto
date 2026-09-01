Persistent Python kernel — do all work here; state (variables, imports, functions, parsed results, running tasks) survives across calls.

Every file mutation a cell makes — `write()`, plain `open()`, `os.*`, `shutil` — is tracked and shown as a hunk diff in the cell Status, including paths outside the working directory.

Work incrementally: imports → define → test → use, each its own call; re-run setup ONLY after `reset`/kernel crash. Top-level `await` works; `asyncio.run(…)` errors; parallelize within a call via `parallel(thunks)`.

File edits MUST use the kernel helpers: `edit()` for targeted changes (exact-literal anchors, asserted counts, atomic multi-hunk — never hand-roll `assert old in src` + `str.replace` surgery), `write()` for new or wholly-replaced files. Every read arms the stale-write guard that protects both helpers — in-kernel (`Path(p).read_text()`, `open()`), the `read` tool, and shell builtins (`cat`, `rg`, `sed`, `head`, …); only reads made by external programs run from the shell (`python x.py`, `git show`) don't count. Your own writes through any tool re-arm it. `Path`, `os`, `json`, `re`, `math` are pre-imported. `tool.<name>` invokes session tools with no Python equivalent. `files: [{path, content}]` writes files to disk before the code runs — quoting-safe channel for code-like content (raw JSON string; no heredocs/escaping tricks). `#@` (`#@?` = open question) comment lines: margin notes for the user; never execute, never write into files, always include. Exception: `#@embed NAME` … `#@end` binds NAME to the intervening lines verbatim — zero escaping: quotes, backslashes, """, `%`/`!` all stay literal. Use it for big or quote-hostile strings kept in memory (no disk write). MUST for file writes/edits: if the content contains string escapes (`\n`, `\"`, `\\`) or nested brackets/braces, route it through `#@embed NAME` … `#@end` (bind verbatim, then `write()` to persist) or `files: [{path, content}]` — NEVER hand-escape it into a Python string literal. `#@embed NAME until=TOKEN` overrides the terminator:

```
#@embed PROMPT
Say "hi" — \backslash, """ and %d stay literal.
#@end
print(PROMPT)
```

File write with string escapes/nested brackets — hand-escaping (WRONG) vs `#@embed` + `write()` (RIGHT):

```
# WRONG: write("src/routes.py", 'ROUTES = {"api": r"/v1/\\d+"}')  # doubled backslashes, quote collision
#@embed SCRIPT
ROUTES = {"api": r"/v1/\d+"}
BODY = "line1\nline2 \"ok\" {a[0]}"
#@end
write("src/routes.py", SCRIPT)
```

<prelude>
{{> kernel-prelude}}
</prelude>

<critical>
Prior top-level names survive into the next call — reuse; NEVER re-import/re-declare. Re-read only if file changed since last read — `StaleWriteError` from write()/edit() is the signal that it did. Targeted file edits go through `edit(path, old, new)`, never manual `str.replace` surgery. On error, fix and re-run only the failing step. Don't rebind helper names (`output`, `env`, `log`, `write`, …) as variables; if you did, `del name` restores the helper. File write/edit content with string escapes or nested brackets MUST go through `#@embed`/`files` verbatim — never hand-escaped literals.
</critical>

{{#if autoBackgroundEnabled}}Long calls may auto-background and deliver later; kernel stays busy until the cell finishes. `timeout: 0` disables the cell deadline.{{/if}}
