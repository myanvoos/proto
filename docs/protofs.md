# protofs checkouts

`protofs` is an optional isolated-checkout backend. Instead of cloning a repository for an
isolated worker, proto opens a **protofs checkout**: a copy-on-write view of the repository served
by the `protofs` daemon. A checkout is ready in about a second at any repository size, keeps its
own private git dir, and captures and merges changes through the same isolation pipeline as a
native workspace.

Proto uses protofs only when the binary is installed. Without it, `orchestrator.isolation.mode=auto`
keeps using the native PAL backends (APFS clone, btrfs, ZFS, reflink, overlayfs, or recursive copy).

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `protofs.enabled` | `true` | Use protofs when the binary is found. Turning this off removes the checkout guidance from the system prompt and keeps isolated workers on native backends. |
| `protofs.path` | unset | protofs executable. Unset looks for `protofs` on `PATH`. |

`protofs.enabled` alone is not enough: the executable must resolve on `PATH` (or at
`protofs.path`). When it does not, proto stays on the native backend and does not fail a spawn.

## Isolated workers

When `orchestrator.isolation.mode` is `auto` and protofs is found, an isolated worker's workspace is
a protofs checkout:

1. proto runs `protofs --json start` to make sure the daemon is running and to learn its admin
   socket and mount.
2. The run's task-isolation dir (under `~/.proto/wt`, or `worktree.base`) records the checkout in
   `.protofs-checkout.json` beside the owner marker.
3. proto opens one checkout per run (`new`) over the daemon's Unix socket and runs the worker with
   that checkout as its cwd.
4. Capture, merge, and apply are unchanged: the runner diffs and commits the checkout like a native
   copy. The checkout is removed (`rm`) when the run ends.

A checkout is kept, like a native workspace, when its changes could not be captured. A persistent
kernel, job, or kept-alive session keeps its checkout leased: teardown waits for the deferred
cleanup, so a live process never loses its working directory.

Failures are explicit. Once protofs is selected there is no silent fallback to native isolation; the
error names the daemon failure and tells you to set `orchestrator.isolation.mode` to a native
backend to bypass protofs.

## Recovery and `proto worktree clear`

A crashed run can leave a checkout record. The record is written after the daemon is reachable and
before `new` returns, so a lost reply still names the checkout. It is deleted only after removal is
confirmed:

- A failed removal keeps the record so `proto worktree clear` can retry it.
- Reusing an agent id moves the stale record and owner marker aside instead of deleting them.
- If the record cannot be moved, the slot is refused rather than overwritten.

`proto worktree clear` releases the recorded checkout first and only then removes the isolation dir.
A protofs-backed isolation dir has no native mount, so native teardown is skipped when a record owns
it. `proto worktree list` labels these entries `protofs checkout sandbox`.

## Search offload

`protofs search` can answer `grep` and `glob` from the daemon when the search root lies inside a
protofs mount, avoiding a kernel round trip per file. proto wires this into `proto grep`; any daemon
failure (not running, unknown op, rejected arguments) falls back to the native search with the same
arguments. Abort and timeout propagate to the daemon as a cancellation instead of falling back.

Internal URLs are never checkout paths. `protolens://<tool>`, `mcp://`, and other `scheme://`
resources stay on their protocol handlers and are never sent to the protofs daemon.

## protolens devices

protolens devices dispatched inside a checkout inherit the checkout cwd. `protolens://` itself is
generated content, resolved by the internal URL router before any filesystem or protofs path
resolution, so a device name is never interpreted as a checkout-relative path. Device result
records and tool cards are unchanged.

## Requirements

- A `protofs` binary that speaks admin protocol version 5.
- A Unix-domain admin socket (proto has no Windows support).
- Git repository isolation still requires a git repository: protofs supplies the checkout, while
  capture and merge use the same git helpers as native isolation.
