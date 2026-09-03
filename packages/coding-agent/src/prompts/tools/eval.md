Run one step of code in a persistent kernel. State persists across calls and workers; bash `python`/`node` with code on stdin or `-c`/`-e` run in these same kernels.
{{#if spawns}}Eval `agent()` children use independent kernels.{{/if}}

Work incrementally: imports → define → test → use, each its own cell; re-run setup ONLY after `reset`/crash. Parallelize within a cell via `parallel(thunks)`, not by batching. On error, fix and re-run only the failing step.

{{#if py}}Top-level `await` works; `asyncio.run(…)` errors.

File edits use plain file APIs — `open`, `Path`, `os.*`; there are no write/edit helpers. The environment tracks and diffs every mutation, and a stale-write guard aborts any write (before truncation) to a file that changed on disk since your last read — that is `StaleWriteError`; re-read the file and redo the change. Every read — in-kernel, the `read` tool, or shell builtins (`cat`, `rg`, `sed`, …) — arms the guard; only reads by external programs run from the shell don't.{{/if}}
{{#if js}}JS runs under **Bun**: globals (`Bun.file`, `Bun.write`, `Bun.$`, `fetch`, `Buffer`) available; top-level `await`/`return` work.{{/if}}

<prelude>
{{> kernel-prelude}}
</prelude>
{{#if spawns}}
<dag>
Acyclic waves via `agent(…, handle=true)` + `pipeline`/`parallel`: name nodes (capture `handle` + `output`), wire edges (upstream handles in downstream prompts; bulk via `write("local://<name>.md", …)`). `pipeline` = staged waves with barriers; `parallel` = one wave. Wrap risky nodes in try/except. Acyclic only. Default flow: author the orchestration as a script at `fleet://<name>.py`, then run `python fleet://<name>.py` in bash — fleet scripts execute in this same kernel.
</dag>
{{/if}}

<critical>
Prior top-level names survive into the next cell — reuse; NEVER re-import/re-declare. Re-read only if file changed since last read{{#if py}} — `StaleWriteError` is the signal that it did{{/if}}.
</critical>

{{#if autoBackgroundEnabled}}Long cells may auto-background and deliver later; kernel stays busy until the cell finishes. `timeout: 0` disables the cell deadline.{{/if}}
