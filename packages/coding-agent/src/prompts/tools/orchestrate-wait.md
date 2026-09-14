Blocks until ONE watched worker finishes its current turn, times out, or is interrupted — re-issue to continue waiting.

Parameter names: use `workers` and `timeout` (seconds), not `ids`/`timeoutMs`.

Settled results carry immutable worker id, display label, turn, job, and receipt status. `delivered` means the result was returned by this wait; `rejected`/`terminal` identify cancellation or lost ownership. Use immutable worker id; NEVER label.
