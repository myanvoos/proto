Spawns one persistent coding-agent worker; returns an immutable worker id and a display label.

Agent type — omit for generic `worker`: `worker` (strong; design, debugging, multi-file, judgment), `lightbot` (fast; mechanical well-specified work), specialists (scout, reviewer, …) when matching.
{{#if agents.length}}
Available agent types:
{{#each agents}}
- `{{name}}`: {{description}}
{{/each}}
{{/if}}
`prompt` is the worker's ONLY context; include files, constraints, acceptance criteria. Results self-deliver on completion; direct other workers meanwhile. The worker persists after normal turn completion — continue with orchestrate_send using the returned immutable id, NEVER the display label. Labels may repeat across parent sessions.

Isolated workers are terminal after completion and use an independent eval kernel; spawn a persistent worker when you need follow-up turns.