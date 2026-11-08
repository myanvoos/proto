# protofs checkouts

`protofs` is an optional isolated-checkout backend, vendored from the OVN filesystem daemon
(see `protofs/UPSTREAM.md`) and built by proto's own build step. `bun run build:protofs` produces
both a `libprotofs` shared library and a `protofs` executable. proto prefers the library, which runs
the daemon inside its own process, and falls back to the executable when the library is absent
(source installs, musl targets, unsupported platforms). Release installs place both beside `proto`.

Instead of cloning a repository for an isolated worker, proto opens a **protofs checkout**: a
copy-on-write view of the repository served by the `protofs` daemon. A checkout is ready in about a
second at any repository size, keeps its own private git dir, and captures and merges changes
through the same isolation pipeline as a native workspace.

Proto uses protofs only when a binary is available. Without one,
`orchestrator.isolation.mode=auto` keeps using the native PAL backends (APFS clone, btrfs, ZFS,
reflink, overlayfs, or recursive copy).

## Building

```sh
bun run build:protofs                                  # host target: executable + library
bun scripts/build-protofs.ts --target linux-x64        # one target
bun scripts/build-protofs.ts --target darwin-arm64 --out /tmp/protofs
bun scripts/build-protofs.ts --no-library              # executable only
```

Targets: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `linux-musl-x64`,
`linux-musl-arm64`. The default executable output is
`packages/coding-agent/binaries/protofs-<target>`; the library is
`packages/coding-agent/binaries/libprotofs-<target>.dylib` on macOS and `.so` on Linux. The
executable builds use `CGO_ENABLED=0`, `-trimpath`, and `-ldflags "-s -w"`. The library builds with
cgo (`-buildmode=c-shared`), so it is only produced for the host target and never for musl; every
other target keeps the executable fallback. Go 1.27.3 or newer is required.

## Daemon resolution

`protofs.enabled` defaults to on. With `protofs.embedded` on (the default), proto first tries to load
`libprotofs`:

1. explicit `protofs.library`;
2. `PROTOFS_LIBRARY`;
3. `libprotofs-<platform>-<arch>.<dylib|so>`, then `libprotofs.<dylib|so>`, beside the running
   `proto` binary;
4. the development build `packages/coding-agent/binaries/libprotofs-<target>.<ext>`, then
   `protofs/build/libprotofs-<target>.<ext>` from the repository.

When no library loads, proto falls back to the `protofs` executable, resolved in this order:

1. explicit `protofs.path`;
2. `protofs-<platform>-<arch>` beside the running `proto` binary, then `protofs` beside it;
3. the development build `packages/coding-agent/binaries/protofs-<platform>-<arch>`, then
   `protofs/protofs` from the repository;
4. `protofs` on `PATH`.

Setting `protofs.embedded=false` skips the library entirely and always uses the executable.

Release installs download `libprotofs-<target>.<ext>` and `protofs-<target>` beside `proto`. `proto
update` refreshes both siblings best effort, and Homebrew installs both from the same formula. Musl
targets publish only the executable, so they always use the fallback; a release without a library
warns during install instead of failing.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `protofs.enabled` | `true` | Use protofs when a daemon candidate is found. Turning this off removes the checkout guidance from the system prompt and keeps isolated workers on native backends. |
| `protofs.embedded` | `true` | Run the daemon in-process through `libprotofs` when it loads; `false` spawns the `protofs` executable instead. |
| `protofs.path` | unset | Explicit protofs executable, overriding every bundled or PATH candidate. |
| `protofs.library` | unset | Explicit `libprotofs` path, overriding the sibling, development, and source candidates. |

`protofs.enabled` alone is not enough: a library or executable candidate must exist. When none
does, proto stays on the native backend and does not fail a spawn.

## Isolated workers

When `orchestrator.isolation.mode` is `auto` and protofs is found, an isolated worker's workspace is
a protofs checkout:

1. proto starts the daemon in-process through `libprotofs` (or runs `protofs --json start` when the
   executable is the fallback) to learn its admin socket and mount.
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

- Go 1.27.3 or newer to build the vendored daemon (`brew install go` locally; CI uses
  `actions/setup-go` with `protofs/go.mod`).
- A Unix-domain admin socket (proto has no Windows support).
- Git repository isolation still requires a git repository: protofs supplies the checkout, while
  capture and merge use the same git helpers as native isolation.
- On Linux, checkouts use FUSE (`fusermount3`, the `fuse3` package). On macOS they use NFSv3 and
  need no kernel extension or root.

## State and configuration

The daemon keeps state in `~/.local/state/protofs` (or `$XDG_STATE_HOME/protofs`) and checkouts in
`~/checkouts` unless the user manifest overrides them. The per-folder manifest is
`.proto/protofs.yml`; the user manifest is `~/.proto/protofs.yml`. `PROTOFS_STATE`, `PROTOFS_MOUNT`,
`PROTOFS_MEMORY`, `PROTOFS_BLOB_CACHE`, and the relay variables mirror the upstream `OVNFS_*`
variables.
