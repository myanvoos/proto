Spawns one persistent coding-agent worker; returns immediately.

Agent type — omit for generic `worker`: `worker` (strong; design, debugging, multi-file, judgment), `lightbot` (fast; mechanical well-specified work), specialists (scout, reviewer, …) when matching.
{{#if agents.length}}
Available agent types:
{{#each agents}}
- `{{name}}`: {{description}}
{{/each}}
{{/if}}
`prompt` is the worker's ONLY context: include files, constraints, acceptance criteria. Results self-deliver on turn completion; direct other workers meanwhile. The worker persists with full memory — follow-ups via `orchestrate_send`, NEVER a second spawn.
