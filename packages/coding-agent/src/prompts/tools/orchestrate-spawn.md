Spawns one persistent coding-agent worker (edit, bash, grep, everything) and returns immediately.

Agent type per task (any discovered type; omit for the generic `worker`):
- `worker`: strong model; hard work (design, debugging, multi-file changes, judgment calls).
- `lightbot`: fast low-latency model; mechanical, well-specified work (renames, boilerplate, running tests, data collection).
- Specialists (scout, reviewer, …): when a discovered type matches the work.
{{#if agents.length}}
Available agent types:
{{#each agents}}
- `{{name}}`: {{description}}
{{/each}}
{{/if}}

`prompt`: first instruction. Worker starts with NO context beyond it; include files, constraints, acceptance criteria.
`name`: optional label; otherwise generated. `effort`: optional thinking-effort hint (`lo`/`med`/`hi`). `outputSchema` optionally validates each turn's response; `schemaMode` chooses permissive or strict enforcement.

Returns worker id + job id immediately; parallel orchestrate_spawn calls run workers concurrently. On turn completion the result—activity trace + worker response—delivers automatically. Do not wait unless blocked; direct other workers meanwhile.

The worker persists after its turn and remembers the whole conversation: same-workstream follow-ups go through `orchestrate_send`, NEVER a second spawn.
With `isolated: true` the worker runs once in an isolated copy of the workspace and is terminal afterward; successful changes are applied back automatically.
