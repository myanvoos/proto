Send a worker a message by id from `orchestrate_spawn`/`orchestrate_list`. The worker retains full conversation history; refer naturally ("now do the same for the other module").

Returns immediately with an ack:
- `turn`: worker idle → new turn; result self-delivers when done.
- `steered`: worker mid-turn → message injected into the running turn as live steering.
- `queued`: worker mid-turn and not currently steerable → message runs automatically as next turn.

Use for follow-ups, corrections, scope changes, review requests. NEVER re-explain prior context; the worker already has it.
