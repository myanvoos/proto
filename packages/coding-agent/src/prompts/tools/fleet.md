Agent fleet: persistent workers you own and peer agents you can message. `op` is REQUIRED; fields not accepted by the chosen op are rejected before anything happens. Route ONLY by canonical `id`; `label` is display text and NEVER an address. Main agent id: `Main`.

Tracked worker control — every accepted input returns a turn receipt `{workerId, turn, job, status}`; `job` is the worker-turn execution (`{"kind":"job","id":"…"}`). Turn results self-deliver when the turn settles; to block on one, use `jobs` op `wait` with that `job` reference. NEVER poll with `list`/`inspect`.
- `spawn`: `message` (REQUIRED; the worker's ONLY initial context — include files, constraints, acceptance criteria), optional `agent`, `label` (`[A-Za-z0-9_-]{1,48}`, rejected NEVER rewritten; generated when omitted), `model`, `effort` (`lo`|`med`|`hi`), `outputSchema`, `schemaMode` (`permissive` default | `strict`), `isolated`.
  - Omitted `agent`: first parent-permitted type; unrestricted → `worker`. Choose `worker` for design/debugging/multi-file judgment, `lightbot` for mechanical well-specified work, specialists when matching. Parent spawn restrictions and recursion limits apply.
{{#if agents.length}}
  - Available agent types:
{{#each agents}}
    - `{{name}}`: {{description}}
{{/each}}
{{/if}}
  - `model`: role alias (`@worker`) or concrete model id; MUST resolve at spawn time — unknown role or unmatched id is rejected and no worker is allocated; requested model unavailable → stop and report, NEVER substitute another. Effective role with a configured model bank → selection MUST be in-bank. The selection persists across park/revive.
  - `isolated:true`: runs once in an isolated workspace copy, applies successful changes back, blocks until done, and the worker is terminal afterward.
- `send`: `id` (owned worker) + `message`, optional `model`. Streaming worker → steered into its running turn (`accepted`, same job). Idle/parked worker → new turn (`accepted`, new job; parked workers revive). Busy non-streaming worker → distinct queued turn (`queued`, its own job starts after the current turn). Full steering/turn queue → `rejected` with retry guidance, nothing enqueued. `model` switches this and all later turns; validated like spawn.
- `terminate`: `id`. Tombstones the worker, cancels its in-flight turn, discards queued inputs; the id is no longer addressable. To stop only one turn, cancel its job with `jobs` op `cancel`: the worker stays addressable for another `send`.
- `list`: `scope` `owned` (default; your workers with lifecycle, turn state, current/queued jobs, model) | `visible` (peers you can message).
- `inspect`: `id` (owned worker): lifecycle and turn state, model, current/last/queued turn jobs, usage, recovery refs (`history://<id>`, `agent://<id>`).

Lifecycle: `live` | `parked` | `terminal`. Turn state: `starting` | `running` | `idle`. A parked worker is `lifecycle=parked`, `turnState=idle`; NEVER collapse the axes. Normal turn completion keeps a worker addressable; terminal errors name the reason, last turn, and recovery refs.

Peer messaging — untracked communication:
- `message`: `to` (peer id, or `"all"` to broadcast) + `message`, optional `replyTo` (id of the message you answer). Receipts report transport only: `effect:"injected"` = no turn started; `effect:"wake_requested"` = turn start unconfirmed; `revived:true` = session loaded, NOT work started. NEVER infer a running turn from delivery; use `send` for tracked worker work. Replies: lead with the answer, NEVER quote, set `replyTo`. Plain prose only; share content through `local://`/`artifact://` URLs.
- `inbox`: drain queued messages; `peek:true` lists without consuming. To block for a reply, use `jobs` op `wait` with a mailbox selector.
