# Orchestration

Every top-level coding agent is an **Orchestrator**. It keeps its ordinary coding tools and always exposes five parent-owned worker controls:

- `orchestrate_spawn` starts one persistent worker using any discovered agent type. Optional controls include `name`, `effort`, `outputSchema`, `schemaMode`, and `isolated`.
- `orchestrate_send` continues an idle or parked worker in the same transcript, steers a streaming turn, or queues a follow-up.
- `orchestrate_wait` waits for the first snapshotted turn to settle and consumes that delivery exactly once.
- `orchestrate_kill` terminates a worker while retaining its transcript tombstone.
- `orchestrate_list` returns the owned worker roster and live activity.

Normal shared-workspace workers run in the background and stay addressable after each turn. `isolated: true` is a one-turn terminal worker that uses the existing isolation apply/capture policy. Recursive workers receive orchestration controls only while `orchestrator.maxRecursionDepth` permits another level.

The bundled generic agent is `worker` (`@worker` model role); the fast mechanical agent is `lightbot`. Agent discovery and precedence are documented in [worker-agent-discovery.md](./worker-agent-discovery.md).

Worker identity and lifecycle use `AgentRegistry` and `AgentLifecycleManager`. The parent journal stores `orchestrator-worker-lifecycle` spawn, turn, and tombstone events; child conversations live in the parent artifact directory and can be parked and revived from JSONL. Parent session ID, session file, and owner agent ID jointly scope every worker, so session switches suspend process-local turns without leaking their results into another session.

`fleet` is separate: it handles peer communication plus generic jobs and supervised processes. Use `orchestrate_send` for direct control of a worker owned by the current parent; use `fleet` for peer messaging.
