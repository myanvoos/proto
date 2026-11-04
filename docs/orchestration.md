# Orchestration

Every coding-agent node permitted to spawn can act as an **Orchestrator**, including a nested worker. It keeps its ordinary coding tools and controls workers through `fleet`, whose operations are `spawn`, `send`, `message`, `list`, `inspect`, `inbox`, and `terminate`:

- `spawn` starts a worker using a discovered, permitted agent type; it is persistent unless `isolated: true`. Optional controls include `label`, `model`, `effort`, `outputSchema`, `schemaMode`, and `isolated`. `model` selects the worker's model (role alias like `@worker` or concrete model id). It is resolved before the worker exists: an unknown role alias or a pattern no available model matches is refused with the known roles or available models, and an explicit `model=` request for a role with a `modelRoleBank` must match that bank or the role's primary model. The selection persists across park/revive.
- `send` continues an idle or parked worker in the same transcript, steers a streaming turn, or queues a follow-up. Every tracked receipt carries the turn's job reference, including a queued turn.
- `jobs` `op:"wait"` on a receipt's job reference waits for that turn to settle and consumes the delivery exactly once. Cancelling the job cancels the turn; the worker stays addressable.
- `terminate` tombstones a worker and its ownership subtree, cancels their work, and discards queued inputs; siblings and other roots are not terminated.
- `list` returns the owned worker roster and live activity; `scope:"visible"` lists reachable peers instead.

Worker tool availability follows the agent definition: when `bash` is enabled, delegated agents use the same `bash` interface and persistent Python/JavaScript kernel-cell surface as the main agent; each worker still owns a separate session and kernel namespace. The bundled generic `worker` has full capabilities, while specialized/read-only agents may omit `bash`. `isolated: true` is a one-turn terminal worker that uses the existing isolation apply/capture policy and an independent kernel namespace. Recursion caps gate worker-control operations (`spawn`/`send`), not peer messaging or job control.

The bundled generic agent is `worker` (`@worker` model role); the fast mechanical agent is `lightbot`. Agent discovery and precedence are documented in [worker-agent-discovery.md](./worker-agent-discovery.md).

Both persistent orchestration and structured subagent calls enforce the same parent spawn policy and recursion checks before creating a worker. With a restricted parent policy, omitting `agent` selects its first permitted type; unrestricted parents default to `worker`. A parent that disables spawning cannot bypass that restriction through the orchestration tools.

## Durable ownership and turn identity

`AgentRegistry` and `AgentLifecycleManager` separate a durable node from its leased `AgentSession` runtime. Node metadata records an immutable node ID, parent node ID, root ID, spawn-anchor entry ID, and generation/state. Worker IDs and existing history/artifact paths stay stable; the display label `Main` is not a durable root identity. Conversation-entry parents describe history branches, not ownership edges.

The parent journal stores `orchestrator-worker-lifecycle` spawn, turn, and tombstone events. A rebuildable index reads explicit session topology and journals, rejecting duplicate identities, cycles, missing parents, and inconsistent terminal ancestry. Legacy layouts are imported once into adjacent `.node.json` metadata receipts; normal ancestry reads do not climb directory names. Transcript and artifact files are not mass-moved.

Send receipts are `accepted`, `queued`, `delivered`, `rejected`, or `terminal`; terminal receipts include the last turn, reason, and `history://` / `agent://` recovery paths. Parent session ID, session file, and owner identity scope each turn. Actual session switches reconcile that ownership scope; changing focus or attaching/detaching an observer does not stop a turn or reparent workers.

A user fork creates a fresh root with separate ownership and admission scope. Fork provenance records its source without making it a child of that source. Historical lifecycle receipts are readable history, not instructions to adopt the original workers; source descendants and previously delivered parent results remain unchanged.

Turn numbers are reserved when a turn is accepted, including while it waits for concurrency capacity. Cancelling a queued turn does not recycle its number. Wait receipts retain the watched turn and job identity even if a queued follow-up starts before delivery; terminal receipts identify the latest started turn, and accepted-but-not-started queued inputs are discarded.

When a worker is running a peer-initiated turn, it remains addressable by its parent. `fleet` `send` steers that running turn or queues the next parent-owned turn until it settles; peer activity alone never makes the worker terminal.

If a completed turn cannot persist its lifecycle settlement, the worker becomes terminal rather than remaining falsely active or accepting follow-ups that cannot run. Queued messages are discarded, the storage error is returned with the failed job, and the worker transcript remains available through its recovery paths. Restore scans ignore transcript names with empty, `.` or `..` worker ids, preventing self- and parent-directory recursion.

A child transcript's `.tombstone` is authoritative during restoration, even without a matching terminal event in the parent journal. Both registry scanning and orchestrator rehydration retain that child as an aborted, read-only transcript rather than reviving a killed worker.

## Runtime leases and idle worker memory

The lifecycle operations have different scopes:

- **Release a runtime:** park an idle node after safe declared-state capture; keep its durable identity, descendants, pending results, and resumability. A running grandchild is not suspended because its parent's runtime is evicted.
- **Stop a turn:** cancel that execution without tombstoning its node.
- **Terminate a subtree:** freeze admissions, stop the addressed node and descendants, and retain their stopped history.
- **Close a tree:** perform the same cleanup from its root. Bounded cleanup failures are surfaced and retain resource reservations until actual cleanup succeeds; a timeout is not evidence that resources were freed.

`orchestrator.agentIdleTtlMs` defaults to **60,000 ms**. An idle worker without active monitors may release its runtime after one minute; focus and pending wakes can hold the runtime live. **0 disables automatic parking**, rather than parking immediately. Busy, unknown-busy, or unsafely snapshotted declared state refuses eviction before the runtime is detached.

The durable node, not the disposed executor frame, owns child results. A canonical journal remains available for descendant usage and completion receipts while the parent runtime is absent. These metadata commits carry the node's exact immutable declared-state manifest forward; revival reuses that journal rather than creating a competing writer. Already delivered parent transcript results are immutable. Stopped or abandoned generations cannot be revived by a stale in-flight request.

A parked worker retains its spawn/revival contract and history, not the original live session graph. Local revival preserves the spawn-time model, tools, settings, prompts, injected stream functions, local-protocol callbacks, and custom tools. After restart the durable init record supplies the revival contract, with the same ownership and authority checks. Declared Python/JavaScript data snapshots are not arbitrary heap or resource snapshots; unsupported state refuses the transition rather than silently restoring an older approximation.

If a worker owns its MCP manager rather than sharing the parent's, parking also cancels pending MCP connection attempts. A stalled handshake no longer keeps the disposed session alive until the MCP timeout, even when that timeout is disabled. Shared parent MCP connections remain available to other workers.

## Admission and execution limits

All turn entrypoints share node exclusivity and applicable execution admission: persistent fleet turns, structured/isolated calls, Python/JavaScript `agent()`, focused submissions, and wake turns. `orchestrator.maxConcurrency` defaults to **32** (`0` disables the local runnable cap). Runnable capacity is fair across trees within one host process. Blocking dependencies—including explicit job waits, automatic child barriers, and structured/eval calls—lend runnable permits and reacquire them before resuming; they never lend the node's exclusive turn identity.

Admitted nodes and accepted work are separate budgets:

| Budget | Default | Meaning |
| --- | --- | --- |
| `orchestrator.maxChildrenPerNode` | 256 | Admitted child nodes owned by one node; `0` disables this count limit. |
| `orchestrator.maxNodesPerTree` | 4,096 | Admitted worker nodes in one ownership tree; `0` disables this count limit. |
| Async accepted-work bytes | 64 MiB total, 16 MiB per owner | Retained accepted inputs, separate from runnable capacity and result retention. |

Persistent idle/parked nodes still count until termination actually settles. Structured ephemeral nodes release their reservations after cleanup. SDK async job capacity derives from `async.maxJobs` (capped at 100); the default total accepted-job limit is four times that manager's running-job limit. Direct, structured, and wake submissions do not bypass count/byte admission.

Hosted sessions additionally acquire a broker-wide runnable lease: **32 turns across hosts sharing the same project broker**, with a bounded accepted-lease queue of 4,096. Grants are persisted before acknowledgment; settled releases are retired durably, dead hosts are reaped, and broker restart recovers leases held by live hosts. This is not an all-system limit, an all-broker limit, or a memory ceiling. Direct SDK embeddings without that hosted adapter retain process-local scheduling.

`orchestrator.maxRecursionDepth` remains **2**: it counts worker-to-worker levels, not the initial main-to-worker edge. The default already permits main → worker → worker → worker, with workers three levels below main. Spawn authority comes from the parent and agent definition and is checked on every creation/revival path; changing an entrypoint does not widen it.

Concurrency, node counts, accepted bytes, and idle TTL address different resources. None truncates persisted history, and releasing objects does not guarantee that the allocator immediately returns resident pages to the operating system.

See [interactive memory and resource limits](./interactive-memory.md) for retention bounds, process-memory accounting, and measurement limitations.

`fleet` `message` is peer communication rather than worker control: delivery is not evidence that a turn started, and it never returns a turn receipt. Executions, supervised processes, and watches belong to [`jobs`](./tools/jobs.md); lanes and interpreters belong to [`context`](./tools/context.md).
