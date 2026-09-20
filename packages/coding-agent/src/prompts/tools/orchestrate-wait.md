Blocks until ONE watched worker turn settles, `timeoutMs` elapses, or interruption; re-issue to continue waiting.

`ids`: canonical worker ids (plural list — NEVER `worker`/`id`); omit to watch every in-flight turn. `timeoutMs`: milliseconds, default 900000 (15 min) — NEVER `timeout`/`timeout_seconds`/`timeoutSeconds`.

Settled results return canonical `id` + `label`, turn, job, receipt status. `delivered` = result returned by this wait; `rejected`/`terminal` = cancellation or lost ownership. Route by `id`, NEVER `label`.
