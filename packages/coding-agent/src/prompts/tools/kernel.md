Persistent Python kernel — do all work here; state (variables, imports, functions, parsed results, running tasks) survives across calls. Bash `python` with code on stdin or `-c` runs in this same kernel; `python fleet://<name>.py` executes a saved script here too (the default for `agent()`/`parallel()`/`pipeline()` orchestration: write the script to `fleet://`, run it from bash).

Every file mutation a cell makes — plain `open()`, `Path`, `os.*`, `shutil` — is tracked and shown as a hunk diff in the cell Status, including paths outside the working directory.

Work incrementally: imports → define → test → use, each its own call; re-run setup ONLY after `reset`/kernel crash. Top-level `await` works; `asyncio.run(…)` errors; parallelize within a call via `parallel(thunks)`.

File edits use plain file APIs — `open`, `Path`, `os.*`; there are no write/edit helpers. The environment tracks and diffs every mutation, and a stale-write guard aborts any write (before truncation) to a file that changed on disk since your last read — that is `StaleWriteError`; re-read the file and redo the change. Every read arms the guard — in-kernel (`Path(p).read_text()`, `open()`), the `read` tool, and shell builtins (`cat`, `rg`, `sed`, `head`, …); only reads made by external programs run from the shell (`python x.py`, `git show`) don't count. Your own writes through any tool re-arm it. `proto_path("fleet//x.py")` resolves kernel scheme URLs for the raw file APIs. `Path`, `os`, `json`, `re`, `math` are pre-imported. `tool.<name>` invokes session tools with no Python equivalent. `files: [{path, content}]` writes files to disk before the code runs — quoting-safe channel for code-like content (raw JSON string; no heredocs/escaping tricks). `#@` (`#@?` = open question) comment lines: margin notes for the user; never execute, never write into files, always include. Exception: `#@embed NAME` … `#@end` binds NAME to the intervening lines verbatim — zero escaping: quotes, backslashes, """, `%`/`!` all stay literal. Use it for big or quote-hostile strings kept in memory (no disk write). MUST for file writes/edits: if the content contains string escapes (`\n`, `\"`, `\\`) or nested brackets/braces, route it through `#@embed NAME` … `#@end` (bind verbatim, then `write()` to persist) or `files: [{path, content}]` — NEVER hand-escape it into a Python string literal. `#@embed NAME until=TOKEN` overrides the terminator:

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
open("src/routes.py", "w").write(SCRIPT)
```

<prelude>
{{> kernel-prelude}}
</prelude>

<critical>
Prior top-level names survive into the next call — reuse; NEVER re-import/re-declare. Re-read only if file changed since last read — `StaleWriteError` is the signal that it did. On error, fix and re-run only the failing step. Don't rebind helper names (`output`, `env`, `log`, `proto_path`, …) as variables; if you did, `del name` restores the helper. File write/edit content with string escapes or nested brackets MUST go through `#@embed`/`files` verbatim — never hand-escaped literals.
</critical>

{{#if autoBackgroundEnabled}}Long calls may auto-background and deliver later; kernel stays busy until the cell finishes. `timeout: 0` disables the cell deadline.{{/if}}
