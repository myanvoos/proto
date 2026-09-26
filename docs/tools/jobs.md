# jobs

> Observe and control executions: finite background jobs, supervised processes, watches and
> waits. Finite commands still enter through `bash`; worker turns enter through `fleet`.

## Source

- Entry: `packages/coding-agent/src/tools/jobs/index.ts` (`JobsTool`, `jobsToolRenderer`)
- Jobs and receipts: `packages/coding-agent/src/tools/jobs/jobs.ts`, `types.ts`
- Wait coordinator: `packages/coding-agent/src/tools/jobs/wait.ts` over `src/jobs/wait.ts` (`withJobWait`)
- Process control and completion sinks: `packages/coding-agent/src/tools/jobs/launch.ts`
- Watch sources: `packages/coding-agent/src/tools/jobs/watch.ts`; runner `src/monitor/runner.ts`
- Backends: `src/async/job-manager.ts` (jobs, watches, delivery), `src/launch/{broker,client,protocol}.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/jobs.md`
- Shared references: `packages/coding-agent/src/jobs/contracts.ts`

## References

Every reference is discriminated and immutable; no id parser guesses its kind.

| Kind | Shape | Authority | Owner key |
| --- | --- | --- | --- |
| `job` | `{kind:"job",id}` | `AsyncJobManager` (bash jobs, worker turns `<workerId>-t<turn>`) | `getAsyncJobOwnerId` |
| `watch` | `{kind:"watch",id}` | `AsyncJobManager` job of type `monitor` | `getAsyncJobOwnerId` |
| `process` | `{kind:"process",id,name}` | project daemon broker record | project-scoped; `list` defaults to `getSessionId` |

A job or watch owned by another agent is reported exactly like an expired one. Processes are
project resources (detached services outlive the session that started them), so control
requires the immutable incarnation `id`, obtainable from `start`, `restart` or `list`
(`scope:"project"` to see other sessions' records).

## Operations

The wire schema is flat so proto CLI flags map directly; each op accepts only its own fields and
rejects the rest before any side effect.

| Op | Fields | Behavior |
| --- | --- | --- |
| `list` | `kind?`, `scope?` | Jobs, watches and processes. Never acknowledges: a settled job listed here is still auto-delivered. |
| `inspect` | `target`, `afterEvent?` | Job/watch snapshot, or broker `describe` pinned to the process id. Watches page retained events by event sequence and report expired sequences as a gap. |
| `start` | `name`, `application`, `args?`, `env?`, `cwd?`, `pty?`, `ready?`, `restart?`, `persist?`, `detached?` | Supervised process; waits for readiness. Returns a process ref. |
| `logs` | `target`, `lines?`, `head?`, `grep?`, `follow?`, `cursor?`, `timeoutMs?` | Output with a log byte cursor. |
| `input` | `target`, `text?`, `enter?`, `keys?` | Stdin/PTY input. |
| `signal` | `target`, `signal` | Process-tree signal. |
| `restart` | `target` | Relaunch from the retained spec as a new incarnation; returns the new ref. |
| `cancel` | `target`, `timeoutMs?` | Job: abort, then wait up to the grace (default 5 s, max 30 s) for settlement. Process: bounded graceful stop. Receipt `settled`, `requested` or `already_settled`. A worker turn is cancelled; the agent stays addressable. Watches are rejected (use `unwatch`). |
| `watch` | `source` xor `command`; `everyMs?`, `match?`, `maxEvents?`, `label?`, `cwd?`, `cursor?`, `timeoutMs?` | Independent subscription; see below. Returns a watch ref. |
| `unwatch` | `target`, `timeoutMs?` | Stops observation. Sources keep running; command probes are reaped. |
| `wait` | `targets?`, `mailbox?`, `timeoutMs?` | First wakeup; see below. |

## Process incarnations and the broker handshake

Broker protocol 2 (`DAEMON_PROTOCOL_VERSION`) pins every name-addressed operation to an
`expectedId`. A mismatch fails with error code `stale-reference`; it never retargets a
replacement. An explicit `restart` mints a new id. Supervised restarts under the `restart`
policy stay within one incarnation.

Older brokers silently ignore unknown fields, so the client pings once per connection and
requires the `process-identity` capability before sending any pinned request (and before any
`start`). An incompatible running broker produces an actionable error; its services are left
running and nothing falls back to name-only control.

## Watches

- **Process source**: reads the broker's in-memory output ring (`read` operation, 1 MiB per
  record) by log byte cursor, starting at the current end or the supplied `cursor`. No helper
  process is spawned. Output the ring no longer holds, or a cursor space that restarted, is
  reported as a `gap` event. Exit ends the watch with an `exit` event; an explicit restart ends
  it with a `replaced` event — watch the new reference to continue.
- **Job source**: subscribes to the job's progress through `AsyncJobManager.subscribe`; the
  job's own completion delivery is untouched. Settlement ends the watch.
- **Command probe**: stream mode follows one long-running helper; poll mode (`everyMs` ≥ 1000)
  re-runs it and reports only changed output. The helper belongs to the watch and is reaped on
  stop. A line or poll output over 1 MiB stops the watch with an error.
- `match` is a JS `RegExp` (`u` flag). `maxEvents` (default `monitor.maxEvents`) counts matching
  output only. `timeoutMs` ≥ 1000 bounds the lifetime.
- Events carry watch id, sequence, kind (`output`, `gap`, `exit`, `replaced`, `limit`,
  `timeout`, `error`), timestamp and text capped at 1 200 characters. The manager retains the
  last 64 events / 64 KiB per watch for `inspect`; event sequences are distinct from log byte
  cursors.

## Wait

- Bare `wait`: the caller's running jobs and watches, plus its mailbox when messaging is
  available.
- Explicit `targets` (≤ 32 job/watch/process refs) and `mailbox` (`{from?}`) never add other
  sources. Unknown, foreign or stale targets fail before waiting.
- The wait holds a lease on its job ids (`withJobWait`), so automatic delivery skips them; the
  winning result is consumed and acknowledged inside the lease. Leases are counted, so
  overlapping waits keep suppression until the last ends. A job that settled during the lease
  but was not consumed (a message won, or the wait was interrupted) is re-queued for automatic
  delivery when the lease ends.
- Process targets wait for exit of that incarnation. The completion is claimed once per
  session: either this wait or the automatic launch-completion message reports it.
- Worker callers lend their runnable permit through
  `OrchestratorRuntime.withWaitPermit`, so a parent waiting on its own children cannot starve
  them at `orchestrator.maxConcurrency`.
- `timeoutMs` omitted: `async.pollWaitDuration` (smart ladder by default) for executions, or
  `irc.timeoutMs` for mailbox-only waits. `0` waits until woken or interrupted.

## Settings

- `launch.enabled` gates process ops; `monitor.enabled`, `monitor.maxConcurrent`,
  `monitor.maxEvents` govern watches; `async.pollWaitDuration` sets the default wait window.
