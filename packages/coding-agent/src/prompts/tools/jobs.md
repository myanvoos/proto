Observe and control executions you started: background jobs (async `bash` commands, worker turns from `fleet`), supervised processes, and watches. Explicit `op` is required; each op rejects fields it does not use.

References are typed and immutable — pass them back exactly as returned, never guess a kind:
- `{"kind":"job","id":…}` — async bash job or worker turn (`<workerId>-t<turn>`).
- `{"kind":"process","id":…,"name":…}` — one incarnation of a supervised process.
- `{"kind":"watch","id":…}` — a watch subscription.

Process references use the session project broker across shell calls, kernel tools, and delegated launches. A cell or process `cwd` changes its working directory, not its process namespace.

Ops:
- `list`: snapshot your jobs, watches and this session's processes (`scope:"project"` for every process in the project; `kind` filters). Observation only — it never marks results as seen; unread results still arrive automatically.
- `inspect` `target`: one reference in detail. For a watch, `afterEvent` pages retained events by event sequence; expired sequences are reported as a gap. Never consumes.
- `start`: supervise a service, watcher, debugger or REPL you will later inspect, feed or stop. `name` + `application` + `args` (argv, no shell). `ready` (`log` regex and/or `port`) MUST be used when later steps depend on readiness. `persist` survives proto exit; `detached` survives the broker too (no PTY). Returns a process reference.
- `logs` `target`: output tail; the returned `cursor` (a log byte cursor) with `follow` reads only newer output.
- `input` `target`: `text` (Enter appended unless `enter:false`) and/or `keys` (`Enter`, `Tab`, `Escape`, arrows, `C-c`, `C-d`, …).
- `signal` `target`: process-tree signal.
- `restart` `target`: relaunch from the retained spec. Returns a NEW reference; the old one becomes stale and cannot control the replacement.
- `cancel` `target`: cancel a job, or stop a process with bounded graceful teardown. Cancelling a worker turn does not terminate the agent (use `fleet` terminate). The receipt says whether teardown settled or was only requested.
- `watch`: wake on output instead of polling. Either `source` (an existing process — read through the broker, no helper — or job) or `command` (a helper probe the watch owns: streams one long-running command, or re-runs every `everyMs` and reports only changed output). `match` is a JS `RegExp` (`u` flag; `(?i)` rejected — use `[Ee]rror`); SHOULD be set so noise stays out of context. Stops after `maxEvents` matches, `timeoutMs`, source end/restart, or `unwatch`.
- `unwatch` `target`: stop observing. A source keeps running; a helper probe is reaped.
- `wait`: block ONLY when you cannot proceed. Returns the first wakeup: a job settling, a watch event, a process target exiting, or (with `mailbox`) a peer message. Bare `wait` covers all your running jobs and watches plus your mailbox. Explicit `targets` never add other sources. The returned result is consumed exactly once; everything else keeps arriving automatically.

Background results and watch events wake you on their own. NEVER poll with repeated `list`, `logs`, `wait`, or `bash` sleep loops; end the turn instead.
