Run one step of code in a persistent kernel. State persists across calls and workers.
{{#if spawns}}Eval `agent()` children use independent kernels.{{/if}}

Work incrementally: imports → define → test → use, each its own cell; re-run setup ONLY after `reset`/crash. Parallelize within a cell via `parallel(thunks)`, not by batching. On error, fix and re-run only the failing step.

{{#if py}}Top-level `await` works; `asyncio.run(…)` errors.{{/if}}
{{#if js}}JS runs under **Bun**: globals (`Bun.file`, `Bun.write`, `Bun.$`, `fetch`, `Buffer`) available; top-level `await`/`return` work.{{/if}}

<prelude>
{{> kernel-prelude}}
</prelude>
{{#if spawns}}
<dag>
Acyclic waves via `agent(…, handle=true)` + `pipeline`/`parallel`: name nodes (capture `handle` + `output`), wire edges (upstream handles in downstream prompts; bulk via `write("local://<name>.md", …)`). `pipeline` = staged waves with barriers; `parallel` = one wave. Wrap risky nodes in try/except. Acyclic only.
</dag>
{{/if}}

<critical>
Prior top-level names survive into the next cell — reuse; NEVER re-import/re-declare. Re-read only if file changed since last read.
</critical>

{{#if autoBackgroundEnabled}}Long cells may auto-background and deliver later; kernel stays busy until the cell finishes. `timeout: 0` disables the cell deadline.{{/if}}
