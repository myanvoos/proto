# context

> Inspect and control this session's bash lanes and named Python, Node.js, and Bun kernels without entering their execution queues.

## Source
- Entry: `packages/coding-agent/src/tools/context.ts` (`ContextTool`, `handleContextControl`)
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/context.md`
- Key collaborators:
  - `packages/coding-agent/src/exec/bash-executor.ts` — lane FIFO (`reserveBashLane`), lane snapshots (`listBashLanes`), destructive lane control barrier (`beginBashLaneControl`), persistent shells.
  - `packages/coding-agent/src/eval/kernel-control.ts` — kernel lifecycle (`handleKernelControl`) and lane-scoped kernel release (`reserveLaneKernelRelease`).
  - `packages/coding-agent/src/eval/kernel-environment.ts` — retained per-lane kernel environments (cwd, interpreter, target).
  - `packages/coding-agent/src/eval/kernel-session-registry.ts` — kernel sessions, busy state, idle reaping.
  - `packages/coding-agent/src/jobs/origin.ts` — execution origin used to reject self-targeted control.

The tool is essential (`loadMode: "essential"`) and loads as a native tool on every request. The shell bridge still accepts `protolens context …` invocations from scripts.

## Inputs

The wire schema is flat so proto can derive CLI flags; each resource/op validates its own fields and rejects the rest before any side effect.

| Field | Type | Resource | Description |
| --- | --- | --- | --- |
| `resource` | `"lane" \| "kernel"` | both, required | What to control. |
| `op` | see below | both, required | Lane: `list`, `inspect`, `reset`, `close`. Kernel: `list`, `start`, `inspect`, `keepalive`, `reset`, `close`. |
| `lane` | `string` (1–128, no NUL/newline) | both | Lane: required for `inspect`/`reset`/`close`, rejected for `list`. Kernel: defaults to `main`; `list` without it reports every lane. |
| `force` | `boolean` | both, `close` only | Cancel running/queued work instead of refusing a busy target. |
| `language` | `"python" \| "node" \| "bun"` | kernel | Required except for `list`. |
| `interpreter` | `string` | kernel | `start`/`reset`: lane default interpreter. Other ops: select that interpreter's kernel when a lane holds several Python kernels. Invalid for `list`. |
| `cwd` | `string` | kernel `start`/`reset` | Lane working directory. |
| `target` | `{kind:"local"} \| {kind:"container",…} \| {kind:"ssh",…}` | kernel `start`/`reset` | Execution host. `node` is local-only. |
| `ttlMs` | integer `1..3600000` | kernel `start`/`reset`/`keepalive` | Keepalive lease; required for `keepalive`. |

## Lane resource

A lane is a bash `lane` value: its FIFO command queue, its persistent shell, and the kernels its cells run in. Shell lanes are keyed by the session id (`getSessionId`), kernels by the eval kernel owner; a caller only sees and controls its own.

- `list` / `inspect` return `LaneSnapshot`s: `state` (`idle`, `busy`, `controlling`), `activeSince`, `queued`, `shell` (`live`, `quarantined`, `retained`, `none`), `stateLossPending`, `kernels` (kernel lifecycle summaries) and `configured` (languages with a retained environment, including after idle reaping). No heap values, process environment variables or command text; kernel summaries include configured cwd/target metadata. Inspecting, resetting or closing an unknown lane is an error.
- `reset`:
  1. puts up an admission barrier — commands issued from now wait until teardown finishes;
  2. cancels every reservation accepted before the barrier: the admitted command is aborted, queued ones are removed and never run (their result is `cancelled` with `Command cancelled: lane <lane> was reset by context control`);
  3. force-closes the lane's kernels (cause `reset`, so an interrupted cell reports `was reset`) while keeping their environments;
  4. waits, bounded, for the cancelled command to hand back its slot, then discards the lane's live, quarantined and retained shells;
  5. lifts the barrier. If a shell was discarded, its next command reports `<shell> state lost: lane <lane> was reset by context control`; for each released kernel, the next cell starts a new generation and reports `<kernel> state lost` once a previous generation was observed.

  Result: `cancelled: {active, queued}`, `shellsDiscarded`, `kernelsReleased`, `retained`.
- `close` performs the same teardown but also forgets the lane's kernel environments (`forgotten`), and it refuses a lane with running/queued commands or a busy kernel unless `force: true`. The refusal happens before cancellation or teardown.
- Lane control reserves each lane kernel's lifecycle slot: an in-flight kernel `reset`/`close` rejects the lane control before side effects, while an in-flight `start` is interrupted.

### Self-control

Control never queues behind the target lane. A lane `reset`/`close` issued by a command or cell running in the target lane (execution origin lane equals the target) is rejected before side effects; issue it from a separate bash lane or as a direct tool call. A separate lane stays responsive while the target is busy.

## Kernel resource

Unchanged lifecycle of named kernels, formerly the `kernel` tool:

- `start` creates or confirms a kernel with the requested environment; an existing kernel with a different environment requires `reset`.
- `reset` cancels the kernel's running cell and starts a new generation, retaining the environment unless overridden. It does not touch the lane's shell or queue.
- `close` refuses busy kernels unless `force: true` and forgets the kernel's lane configuration.
- `keepalive` defers idle reaping for a bounded lease. Idle kernels are released after the idle-reap period; their environment is kept and the next cell starts a fresh generation, reporting state loss when a previous generation was observed.
- `list`/`inspect` report lifecycle metadata (`generation`, `interpreter`, `environment`, `state`, timestamps, `keepAliveUntil`), never heap contents.
- A kernel `reset`/`close` issued from a cell running in that same lane and language is rejected; a shell command on the same lane may control it.
- Language/interpreter disambiguation, remote/container restrictions and backend enablement checks apply as before. There is no heap fork/save/restore.

## Examples

```sh
protolens context --resource lane --op list
protolens context --resource lane --op inspect --lane analysis
protolens context --resource lane --op reset --lane analysis
protolens context --resource lane --op close --lane analysis --force
protolens context --resource kernel --op start --language python --lane analysis --interpreter /work/.venv/bin/python
protolens context --resource kernel --op keepalive --language python --lane analysis --ttlMs 300000
```

## Outputs

`content[0].text` is the JSON-serialized result; `details` carries the same object with `resource` set to `lane` or `kernel`.
