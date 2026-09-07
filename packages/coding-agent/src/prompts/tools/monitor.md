Wait for something to happen without burning turns. Each matching event is delivered as a message that wakes you; the command runs in the background meanwhile.

Loop: `start` a monitor → do other work, or END THE TURN. The event restarts you. NEVER `bash` sleep/poll loops, retry spins, or repeated `logs` calls to wait for an external condition.

While any monitor runs, incomplete-todo and goal-continuation nudges are suppressed — stopping to wait IS the expected move, not an abandoned turn.

- stream (`every` omitted): one long-running process; one event per matching output line (stdout+stderr). Process exit stops the monitor and delivers an `exit` event.
- poll (`every: N`): command re-runs every N seconds; one event per CHANGED matching output. Identical consecutive output is skipped — a stable value delivers once, not forever.
- `match`: JS `RegExp` source, `u` flag. PCRE inline modifiers like `(?i)` REJECTED — use `[Rr]eady`. Omitted → every line/change qualifies.
- Every event enters your context. SHOULD supply `match` to filter at the source rather than streaming everything; a chatty command without `match` burns context fast.
- Defaults: `maxEvents` from settings (50) — the monitor stops ITSELF on reaching it; `timeout` unbounded when omitted; `cwd` the session directory. Long or noisy watches SHOULD set `timeout`.
- Also stops on process exit, on error, and on `op: "stop"` (omit `ids` → stop all). A stopped monitor delivers nothing further; `list` shows status, mode, events delivered, and stop reason.
- Session-scoped: monitors die with the session and are main-agent only.

`fleet` vs `monitor`: `fleet op: "start"` supervises a service you later inspect, signal, or feed stdin — you interact with it. `monitor` watches output and wakes you — you react to it. Need both? Run the service under `fleet`, then `monitor` a command that observes it.
