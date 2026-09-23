Agent coordination: peer messaging, background jobs, supervised processes. Main agent id: `Main`; discover peers with `op:"list"` — rows return canonical `id` + `label`. Send shape: `{"to":"<peer id>","message":"…"}`; `op` is optional — a bare `to` + `message` infers send.

All timeout fields use milliseconds: `timeoutMs`, `ready.timeoutMs`. NEVER supply seconds.

Background jobs auto-deliver on finish — NEVER poll. `jobs`/`wait` first observation of a settled job consumes delivery and suppresses duplicate `async-result`. Job rows expire ~5 min after settlement; afterward use agent `id` with `send`, `agent://<id>`, or `history://<id>`.

- Peer `send`: `to` + `message`; `to:"all"` broadcasts; `op:"send"` explicit or inferred. Receipt outcome reports transport only. `effect:"injected"` = no worker turn started. `effect:"wake_requested"` = turn start not confirmed. `revived:true` = session loaded, NOT work started. NEVER infer `turnState=running` from delivery; use `orchestrate_send` for a guaranteed tracked worker turn. Reply: lead with answer, NEVER quote, set `replyTo`. Plain prose ONLY; share content through `local://`/`artifact://` URLs.
- `wait`: ONLY when completely blocked. Returns first incoming message, watched job, elapsed window, or steering interrupt — NOT all jobs. Bare wait watches every running job + incoming messages; NEVER pass every running job id. `from` filters the sender.
- `inbox`: drain queued messages. `cancel`: terminate jobs by `ids`. `jobs`: snapshot; running subagents without job entries still appear — coordinate through peer `send`.
- Peer lifecycle: `live` | `parked` | `terminal`. Turn state: `running` | `idle`. A parked peer is `lifecycle=parked`, `turnState=idle`.

Processes: services/watchers/debuggers/REPLs needing later input MUST use `op:"start"`, not `bash`. Ops `ps`/`logs`/`wait`/`send`/`stop`/`restart`/`describe` address process `name`; agent identifiers remain `id`.

`ps` defaults to this session's process records, including exited; `all:true` lists all records in the project directory.

- Readiness MUST be observed. `ready.log`/`pattern`/`grep`: JS `RegExp`, `u` flag; PCRE inline modifiers such as `(?i)` rejected — use `[Rr]eady`. Multiple conditions ALL pass.
- Process names unique per project directory: completed name MAY restart; live name MUST stop first.
- `stop`: graceful process-tree termination before hard kill; NEVER kill unverified PID through bash. `restart` reuses retained launch spec.
- `logs`: returned `cursor` reads new output only; omit for retained history. Follow timeout NEVER replays older output.
- Broker shutting down? New launches rejected; retry after shutdown.
