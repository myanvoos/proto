Wait for something to happen without burning turns. Each matching event is delivered as a message that wakes you; the command runs in the background meanwhile.

Start a watch: `{"op":"start","command":"tail -F app.log","label":"app","match":"ERROR"}`. The returned ID is a background job; use `fleet` `jobs` / `wait` / `cancel` to inspect, await, or stop it.

Loop: `start` a monitor → do other work, or END THE TURN. The event restarts you. NEVER `bash` sleep/poll loops, retry spins, or repeated `logs` calls to wait for an external condition.

While any monitor runs, incomplete-checklist and goal-continuation nudges are suppressed — stopping to wait IS the expected move, not an abandoned turn.

- stream (`every` omitted): one long-running process; one event per matching output line (stdout+stderr). Process exit stops the monitor and delivers an `exit` event.
- poll (`every: N`): command re-runs every N seconds; one event per CHANGED matching output. Identical consecutive output is skipped — a stable value delivers once, not forever.
- `match`: JS `RegExp` source, `u` flag. PCRE inline modifiers like `(?i)` REJECTED — use `[Rr]eady`. Omitted → every line/change qualifies.
- Every event enters your context. SHOULD supply `match` to filter at the source rather than streaming everything; a chatty command without `match` burns context fast.
- Defaults: `maxEvents` from settings (50) counts matching output events, not terminal status — the monitor stops ITSELF on reaching it; `timeout` unbounded when omitted; `cwd` the session directory. Long or noisy watches SHOULD set `timeout`.
- Also stops on stream process exit, on error, or on `fleet op: "cancel"`. A stopped monitor delivers nothing further; `fleet op: "jobs"` shows monitor status and event counts.
- Output safety: a stream line or one poll stdout/stderr exceeding 1 MiB stops with an error. Filter command output before monitoring; use `bash` for bulk output.
- Owner-scoped: main agents and subagents MAY start monitors; each manages its own jobs. Monitors die when their owning session shuts down.

`fleet` vs `monitor`: `fleet op: "start"` supervises a service you later inspect, signal, or feed stdin — you interact with it. `monitor` watches output and wakes you — you react to it. Need both? Run the service under `fleet`, then `monitor` a command that observes it.
