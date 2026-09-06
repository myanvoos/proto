Agent coordination: peer messaging, background-job control, supervised long-running processes. Main agent is `Main`; subagents inherit task ID. Discover peers: `op: "list"`.

Background jobs auto-deliver on finish — NEVER poll. `jobs`/`wait` observing a settled job first consumes the delivery and suppresses duplicate `async-result`. Job rows are process-local, expire ~5 min after settlement; afterward use the agent ID with `send`, `agent://<id>`, or `history://<id>`.

- `send` (`to`): fire-and-forget; wakes `idle`/`parked` peers. Receipts immediate; `failed` → peer gone; NEVER retry. Answering: lead with the answer, NEVER quote, set `replyTo`. Format: plain prose ONLY — share content via `local://`/`artifact://` URLs, not pastes.
- `wait`: ONLY when completely blocked with no other work. Returns on the first event (incoming message, watched job, window elapsing, steering interrupt) — NOT when all jobs finish; re-issue. Bare `wait` watches every running job AND incoming messages; NEVER pass an array of every running ID.
- `inbox`: drain queued messages without blocking. `cancel`: kill hung/stalled/unneeded jobs by `ids`. `jobs`: snapshot without waiting; also names running subagents with no job entry — coordinate via `send`.

Processes: a service, watcher, debugger, REPL, or process needing later input MUST use `op: "start"`, not `bash`. Ops `ps`/`logs`/`wait`/`send`/`stop`/`restart`/`describe` address the stable `name`.

- Readiness MUST be observed — process creation alone is not readiness. `ready.log`/`pattern`/`grep` are JS `RegExp` (`u` flag; PCRE inline modifiers like `(?i)` REJECTED — use `[Rr]eady`); multiple conditions ALL must pass.
- Names unique per project dir: completed name MAY restart, live name MUST be stopped first.
- `stop`: graceful process-tree termination before hard-kill; NEVER kill an unverified PID through bash. `restart` reuses the retained launch spec.
- `logs`: supply the returned `cursor` for new output only; omit it for retained history. Follow timeouts do not replay older output.
- Broker shutting down? New launches are rejected; retry after shutdown completes.
