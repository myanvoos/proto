# Orchestration

Every top-level coding agent is an **Orchestrator**. It keeps its ordinary coding tools and always exposes five parent-owned worker controls:

- `orchestrate_spawn` starts one persistent worker using any discovered agent type. Optional controls include `name`, `effort`, `outputSchema`, `schemaMode`, and `isolated`.
- `orchestrate_send` continues an idle or parked worker in the same transcript, steers a streaming turn, or queues a follow-up.
- `orchestrate_wait` waits for the first snapshotted turn to settle and consumes that delivery exactly once.
- `orchestrate_kill` terminates a worker while retaining its transcript tombstone.
- `orchestrate_list` returns the owned worker roster and live activity.

Normal shared-workspace workers run in the background and stay addressable after each turn. Each spawn returns an immutable opaque worker id; the optional `name` is a display label only and may repeat under different parents. `isolated: true` is a one-turn terminal worker that uses the existing isolation apply/capture policy and an independent eval namespace. Recursive workers receive orchestration controls only while `orchestrator.maxRecursionDepth` permits another level.

The bundled generic agent is `worker` (`@worker` model role); the fast mechanical agent is `lightbot`. Agent discovery and precedence are documented in [worker-agent-discovery.md](./worker-agent-discovery.md).

Both persistent orchestration and structured subagent calls enforce the same parent spawn policy and recursion checks before creating a worker. With a restricted parent policy, omitting `agent` selects its first permitted type; unrestricted parents default to `worker`. A parent that disables spawning cannot bypass that restriction through the orchestration tools.

Worker identity and lifecycle use immutable ids in `AgentRegistry` and `AgentLifecycleManager`; labels never route messages. Send receipts are `accepted`, `queued`, `delivered`, `rejected`, or `terminal`; terminal receipts include the last turn, reason, and `history://` / `agent://` recovery paths. The parent journal stores `orchestrator-worker-lifecycle` spawn, turn, and tombstone events; child conversations live in the parent artifact directory and can be parked and revived from JSONL. Parent session ID, session file, and owner agent ID jointly scope every worker, so session switches suspend process-local turns without leaking their results into another session.

Turn numbers are reserved when a turn is accepted, including while it waits for concurrency capacity. Cancelling a queued turn does not recycle its number. Wait receipts retain the watched turn and job identity even if a queued follow-up starts before delivery; terminal receipts identify the latest accepted turn, not a previous completion.

A worker running a peer-initiated turn remains addressable by its parent. `orchestrate_send` accepts the parent's next turn and waits for the existing streaming turn to settle before starting it; peer activity alone never makes the worker terminal.

If a completed turn cannot persist its lifecycle settlement, the worker becomes terminal rather than remaining falsely active or accepting follow-ups that cannot run. Queued messages are discarded, the storage error is returned with the failed job, and the worker transcript remains available through its recovery paths. Restore scans ignore transcript names with empty, `.` or `..` worker ids, preventing self- and parent-directory recursion.

A child transcript's `.tombstone` is authoritative during restoration, even without a matching terminal event in the parent journal. Both registry scanning and orchestrator rehydration retain that child as an aborted, read-only transcript rather than reviving a killed worker.

## Idle worker memory

Workers remain addressable after a turn, but their live sessions need not stay in memory indefinitely. `orchestrator.agentIdleTtlMs` defaults to **60,000 ms**: after one idle minute the lifecycle manager parks the worker and disposes its live session. A later message revives the worker from its retained state. Explicit timeout overrides are unchanged; **0 disables automatic parking**, rather than parking immediately.

A parked worker keeps only its spawn-time blueprint (parent-owned inputs: model, tools, settings, prompts, injected stream functions, local-protocol callbacks, custom tools) plus the path of its transcript; the disposed session, its context, and the run's monitor state are released. Messaging the worker reopens the transcript and rebuilds the session from that blueprint, so revival is faithful to the original spawn regardless of how the parent was configured. Workers that outlive the process (or whose lifecycle was disposed) are rebuilt from the transcript's init record instead.

If a worker owns its MCP manager rather than sharing the parent's, parking also cancels pending MCP connection attempts. A stalled handshake no longer keeps the disposed session alive until the MCP timeout, even when that timeout is disabled. Shared parent MCP connections remain available to other workers.

`orchestrator.maxConcurrency` remains **32**. Lowering it limits simultaneous running turns, while shortening the idle TTL reduces how long completed workers retain live resources. These address different parts of the memory footprint. Neither setting truncates persisted conversation history, and releasing objects does not guarantee that the allocator immediately returns resident pages to the operating system.

See [memory profiling](./memory-profiling.md) for isolated workloads, process-memory accounting, and measurement limitations.

`fleet` is separate: it handles peer communication plus generic jobs and supervised processes. Use `orchestrate_send` for direct control of a worker owned by the current parent; use `fleet` for peer messaging.
