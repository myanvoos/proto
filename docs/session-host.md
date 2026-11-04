# Session host (detachable sessions)

A **session host** is the daemon-broker-supervised owner of a session tree. Normal persisted full-TUI launches select this backend before constructing the agent runtime: the host runs the real `InteractiveMode`, and the terminal process relays its PTY. The renderer, tools, kernels, and typed node operations use the same owned session; children do not get a host process of their own. Direct SDK/test embeddings use the same typed node-operation contract in-process. `--no-session` remains an in-process interface because it has no durable session to host.

The existing daemon broker (`proto ps`) supervises the CLI session-host re-entry with an on-failure restart policy. A crash resumes durable session records; this does **not** promise survival of in-flight model requests, arbitrary Python heaps, or external process resources. Declared durable state follows its own compatibility and restoration contract.

## Full TUI: launch, attach, detach

```sh
proto                            # normal persisted full TUI, hosted automatically
proto attach                     # most recent session in this project
proto attach <session-id>        # id, file-name prefix, or .jsonl path
proto attach --dir ~/other/project
```

When the selected host runs the full TUI, terminal attach relays that interface rather than constructing another `AgentSession` or translating editor actions into slash text. Focus, context, compaction, history/tree selection, independent forks, extensions, and keyboard controls run in the host. A new terminal attachment replaces the previous controlling terminal; stale attachment identities cannot send input or resize the replacement.

**`Ctrl+]` detaches without aborting the turn or stopping the tree.** Closing the terminal or losing the connection also releases only the terminal attachment. Reattach with `proto attach <session-id>`; accepted work continues while detached. The ordinary TUI's Escape/Ctrl-C actions retain their interrupt/exit behavior—they are not the relay's detach chord.

Terminal input and output are bounded. Output uses the broker's byte cursor/ring; a cursor gap requests a fresh redraw instead of treating a partial old screen as authoritative. Attachment and resize request the actual terminal geometry and explicitly signal `SIGWINCH`, including same-size reconnects. The host requests a full redraw on that signal. Wire geometry accepts 1–1000 columns/rows; the native PTY currently clamps the effective geometry to 20–400 columns and 5–200 rows.

A scripted, line-oriented `proto attach` to an **existing full-TUI host** fails with an explicit node-protocol-3 interface error and leaves that host running. Use a terminal attachment or the typed `RpcNodeBackend` for programmatic control; a v2 compatibility probe must not stop a healthy v3 owner.

Stop a host explicitly:

```sh
proto attach --stop <session-id>
```

Detach is not shutdown. Stopping the host ends that process and its owned runtime resources; the durable session remains resumable. Normal tree shutdown and node/subtree termination are separate operations with their own cleanup and reservation semantics.

## Typed node control and bounded observation

The interactive host exposes [node protocol 3](./rpc.md#interactive-host-node-protocol-3) on its Unix socket, alongside—not through—the terminal byte stream. It does not accept implicit-root v2 command aliases.

- Negotiate version 3 to obtain the authoritative root snapshot and latest-wins controller lease. Mutations carry an explicit immutable `{ nodeId, generation, revision }`; unknown nodes, stale selectors, obsolete controller leases, and mutations of abandoned/stopped generations fail rather than targeting root.
- `DirectNodeBackend` and `RpcNodeBackend` expose `snapshot`, typed `execute`, per-node `subscribe`, and `close`. Closing the backend connection detaches observation; it does not dispose the owner session.
- Results are correlated replies, never entries in a lossy progress/replay log. A disconnected request can have committed: reconnect and read authoritative state rather than blindly retrying it.
- At most 64 node requests are outstanding and 32 nodes are subscribed per attachment. Coalesced `node_changed` hints contain node identity/generation only; clients fetch the authoritative snapshot/history they need.
- History pages hydrate only the selected bounded semantic window (up to 512 messages, 1,536 KiB; an oversized indivisible group becomes an explicit history-window notice). Opaque cursors pin a historical head and generation, so newer appends do not shift older pages. Navigation/rewrite generation changes require a fresh cursor.
- Tree metadata is paged separately, without hydrating transcript payloads. Parent/children breadcrumbs use explicit durable ownership identities at every depth. Reading a parked or abandoned node uses a read-only history lease, not runtime revival.
- Committed metadata/history mutations force durable storage and flush before success. Fork creates a fresh independent root; failed/stale foreground adoption releases only the new runtime, never the source tree.

Socket writes use connection-local byte queues: short writes resume their unwritten suffix on drain, and replacement drops only the old connection's pending bytes. Queue overflow closes/fails that connection visibly. The readiness marker is emitted only after the command consumer is serving, not merely when its socket starts listening.

## RPC-only hosts and line-oriented attach

`proto --mode rpc` and the SDK `RpcClient` retain their documented stdio v1/v2 contract. An RPC-only session host re-enters the same CLI with `--resume <file> --mode rpc`, routing those frames over its socket. This is a distinct negotiated interface, not a fallback command lane on an interactive v3 host.

For an RPC-only host, `proto attach --messages 30` replays recent messages, and the line-oriented commands remain:

| Command | Effect |
| --- | --- |
| `/bash <cmd>` | Run a shell command in the session. |
| `/abort` | Abort the running turn. |
| `/stop` | Stop the host. |
| `/detach` | Disconnect without stopping it. |
| `/help` | List line-oriented commands. |

In that interface, Escape aborts and detaches; Ctrl-C aborts, twice within three seconds detaches. Piped input is supported, for example `printf '/bash uname -a\n/detach\n' | proto attach <session-id>`. If an empty scripted attach itself started an RPC-only host, it takes back that new host and exits nonzero; it never reclaims an existing owner.

## Ownership and limits

A host's deterministic daemon name/socket derives from its **initial** root file. Every adopted root receives a durable `.host.json` locator; a fsynced, generation-fenced ownership record commits the foreground root and retained root membership. New/resume/clear/fork adoption waits for this handoff before acknowledgement. Looking up a fork's new filename finds the same actual host rather than hashing that filename into a second writer. Restart resumes the committed foreground—even when the original broker command still names the source file. Restart arguments are captured after extension-flag discovery and committed before serving: configuration, trusted extensions, and runtime behavior survive, while startup provider/model/thinking selectors, positional prompts, `@files`, and separator-tail input are not replayed. Durable model/history state, not the original launch arguments, governs recovery. A missing/corrupt committed foreground fails visibly, never silently reopens the source. Selecting a retained source/child that is not the foreground is refused with explicit selection guidance; locating its host does not implicitly switch roots.

The host installs broker-backed execution admission before accepting turns, bound to its actual supervising broker runtime. Multiple hosts using the same project broker share its runnable reservations. This is not a cross-broker, machine-wide memory/RSS ceiling. Accepted work, runnable concurrency, kernel residency, and retained results remain distinct budgets.

Unix sockets live in the daemon runtime directory with mode `0600`. The host runs with your user's permissions and is not a sandbox. Hosting does not add heartbeats, cron schedules, or autonomous continuation.
