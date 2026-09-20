# monitor

> Session-scoped event watcher: run a command in the background and get woken when its
> output matches, instead of polling.

## Source
- Entry: `packages/coding-agent/src/tools/monitor.ts`
- Manager: `packages/coding-agent/src/monitor/manager.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/monitor.md`
- Settings: `packages/coding-agent/src/config/settings-schema.ts` (`monitor.*`)

## Model

- `op` is required: `start` (`command`, `label`, optional `match`), `list`, `stop`
  (targets `ids`; omit to stop all).
- **stream** mode (no `every`): one long-running process; one event per matching output
  line (stdout+stderr). Process exit stops the monitor and delivers an `exit` event.
- **poll** mode (`every: N` seconds): re-runs the command; one event per *changed* matching
  output — identical consecutive output is skipped.
- `match` is a JS `RegExp` source (`u` flag; PCRE inline modifiers like `(?i)` are
  rejected). Supplying `match` filters at the source; every event enters the context.
- Defaults: `maxEvents` from settings (50) — the monitor stops itself when reached;
  `timeout` unbounded when omitted; `cwd` the session directory.
- While any monitor runs, incomplete-todo and goal-continuation nudges are suppressed —
  stopping to wait is the expected move.
- Session-scoped: monitors die with the session and are main-agent only.

## Settings

- `monitor.enabled` (default `true`)
- `monitor.maxConcurrent`
- `monitor.maxEvents` (default `50`)

## fleet vs monitor

`fleet op: "start"` supervises a service you later inspect, signal, or feed stdin — you
interact with it. `monitor` watches output and wakes you — you react to it. Need both?
Run the service under `fleet`, then `monitor` a command that observes it.
