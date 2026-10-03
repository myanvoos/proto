# fleet

> Agent identity, tracked worker turns, and peer messages. Shell jobs, process
> supervision, watches, and blocking waits belong to [`jobs`](jobs.md).

## Source
- Entry: `packages/coding-agent/src/tools/fleet/index.ts` — flat wire schema, strict per-op validation, per-op authorization, `FleetTool`, `fleetToolRenderer`
- Worker ops and worker cards: `packages/coding-agent/src/tools/fleet/workers.ts`
- Peer messaging and message cards: `packages/coding-agent/src/tools/fleet/messaging.ts`
- Result types: `packages/coding-agent/src/tools/fleet/types.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/fleet.md`
- Collaborators:
  - `packages/coding-agent/src/orchestrator/runtime.ts` — worker records, one `worker` job per turn (`<worker-id>-t<turn>`), queue/steer admission, park/revive, tombstones, `withWaitPermit`.
  - `packages/coding-agent/src/registry/agent-registry.ts`, `agent-lifecycle.ts` — agent directory, visibility, parking and revival.
  - `packages/coding-agent/src/irc/bus.ts` — process-global, fleet-root-scoped mailboxes for peer messages.
  - `packages/coding-agent/src/async/job-manager.ts` — the turn jobs `jobs` observes, waits on, and cancels.

## Inputs

`op` is required. Fields outside the chosen op's set are rejected before any side effect.

| `op` | Required | Optional |
| --- | --- | --- |
| `spawn` | `message` | `agent`, `label`, `model`, `effort` (`lo`\|`med`\|`hi`), `outputSchema`, `schemaMode` (`permissive`\|`strict`), `isolated` |
| `send` | `id`, `message` | `model` |
| `message` | `to`, `message` | `replyTo` |
| `list` | — | `scope` (`owned` default \| `visible`) |
| `inspect` | `id` | — |
| `inbox` | — | `peek` |
| `terminate` | `id` | — |

`id` always names a worker the caller owns; `to` names a peer agent id or `"all"`.
Labels (`[A-Za-z0-9_-]{1,48}`, rejected rather than rewritten) are display text and never route.

## Worker control (tracked)
- `spawn` resolves agent type, spawn policy, recursion depth, disabled agents, model/role
  (including the role's model bank) and output schema before a worker id or job is allocated;
  an explicitly unresolvable `model` request allocates nothing. Normal tracked spawns
  return a turn receipt for turn 1.
- `send` addresses an owned worker by id:
  - streaming worker → steered into the running turn (`mode: "steered"`, same job);
  - idle or parked worker → a new turn job (`mode: "turn"`), reviving a parked worker;
  - busy, non-streaming worker → a queued turn registered immediately as its own queued job
    (`mode: "queued"`), started when the current turn settles.
  Full steering or turn queues are rejected with a `rejected` receipt and nothing is enqueued.
  `model` changes the worker's next model request and persists for later turns; it is
  validated like spawn.
- Turn receipts are `{ workerId, label, turn, job: { kind: "job", id }, status, mode }`.
  `status` is `accepted` or `queued` for accepted tracked inputs; refused inputs carry
  `rejected` or `terminal` receipts. A live worker's settled result is delivered by the job with
  its own `delivered` marker; terminal results carry `terminal`. Waiting uses `jobs` `wait` on
  `receipt.job`; fleet has no blocking wait.
- Cancelling a turn job through `jobs` ends that turn only; a cancelled queued turn is removed
  from the worker's queue and keeps its turn number. The worker stays addressable.
- `terminate` tombstones the worker, cancels its in-flight turn and every queued turn job, and
  reports `history://<id>` / `agent://<id>` recovery refs; it cannot route new turns or peer
  messages afterward.
- `isolated: true` runs once synchronously in an isolated workspace copy (requires
  `orchestrator.isolation.mode` other than `none`), applies successful changes back by default
  (`orchestrator.isolation.apply=false` retains patch/branch artifacts), and leaves no
  addressable worker. If patch capture or persistence fails, the error names the retained workspace
  containing the uncaptured changes. Recover those changes before running `proto worktree clear`
  after the owning session exits. Clear uses native teardown for retained overlays and Btrfs snapshots;
  missing or corrupt retention metadata and teardown failures leave the workspace intact. Retained
  ZFS datasets require manual teardown. If a workspace cannot be moved out of its agent's slot,
  another run with that id refuses to overwrite it until it has been recovered and cleared.
- `list` (owned) and `inspect` report lifecycle (`live`/`parked`/`terminal`) and turn state
  (`starting`/`running`/`idle`) separately, plus model, turn count, current, last and queued
  turn job ids, usage, and terminal recovery refs.

## Peer messaging (delivery-only)
- `message` delivers to one peer or broadcasts to visible peers. Receipts report transport
  only: `effect: "injected"` (no turn started), `effect: "wake_requested"` (turn start not
  confirmed), `revived` (session loaded). A peer message never returns a turn receipt.
- `inbox` drains queued bus and session messages; `peek: true` leaves both queues in place.
- `list` with `scope: "visible"` lists peers in the caller's fleet with unread counts.
- Blocking for a reply uses `jobs` `wait` with a mailbox selector.

## Authorization
Checked in the handler for every call, independent of tool registration:
- `spawn`/`send` require an enabled spawn policy (`getSessionSpawns`) and a task depth within
  `orchestrator.maxRecursionDepth`. They do not require peer messaging.
- `message`, `inbox`, and `list` with `scope: "visible"` require peer messaging (agent
  registry, caller agent id, `enableIrc !== false`). Recursion limits do not affect them.
- `inspect`, `terminate`, and owned `list` resolve only workers owned by the caller's scope
  (agent id, parent session id and file).

## Outputs
Single text block plus `details: FleetDetails` —
`{ op, senderId?, scope?, screens?, spawned?, receipt?, rejected?, terminated?, to?, receipts?, inbox?, peers? }`.
Runtime refusals are `isError` results; a refused tracked input carries its receipt in `rejected`.

## Rendering
`fleetToolRenderer` draws worker composer frames for `spawn`/`send` (tracked calls include
the receipt's turn and job), worker TV cards for owned `list`/`inspect`, and message/inbox/peer
cards for peer ops.
Transcripts written before fleet became agents-only are rendered as history: legacy peer
`send` calls keep message cards, and process/job results retain their cards through
render-only adapters. Removed tool names use the historical fallback. None of these
historical paths makes a retired operation executable.
