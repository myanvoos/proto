Spawns one persistent coding-agent worker; returns canonical `id` + `label` fields. Shape: `{"message":"<first instruction>","label":"…"}`.

`message`: worker's ONLY initial context; include files, constraints, acceptance criteria. `label`: optional display text matching `[A-Za-z0-9_-]{1,48}`; invalid labels are rejected, NEVER rewritten. Omitted label → generated label.

Omitted `agent`: first parent-permitted type; unrestricted → `worker`. Choose `worker` for design/debugging/multi-file judgment, `lightbot` for mechanical well-specified work, specialists (scout, reviewer, …) when matching. Parent spawn restrictions and recursion limits apply.
{{#if agents.length}}
Available agent types:
{{#each agents}}
- `{{name}}`: {{description}}
{{/each}}
{{/if}}
`model`: role alias (`@worker`) or concrete model id; MUST resolve at spawn time — unknown role or unmatched id rejected, no worker started. Effective role with configured model bank → selection MUST be in-bank; role default always allowed; role alias switches effective role. Selection persists across park/revive; a later `orchestrate_send` with `model=` switches it.

Results self-deliver on completion; direct other workers meanwhile. Normal completion preserves the worker: continue with `orchestrate_send` passing the returned `id` as `to`. Labels may repeat.

Isolated workers are terminal after completion and use an independent eval kernel; spawn a persistent worker for follow-up turns.
