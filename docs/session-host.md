# Session host (detachable sessions)

A **session host** runs an agent session in a daemon-supervised worker so the session outlives the terminal that started it. Model turns, the eval kernels, and orchestrator subagents keep running while no client is attached; closing the terminal or losing the connection never stops the session.

The host reuses the standard [RPC](./rpc.md) protocol over a per-session Unix socket instead of stdio. The daemon broker (the same one behind `proto ps`) supervises the host worker with an on-failure restart policy, so a crashed worker is restarted and the session is resumed from its JSONL file.

## Attach and detach

```sh
proto attach                      # most recent session for the current project
proto attach <session-id>         # by id, file-name prefix, or .jsonl path
proto attach --dir ~/other/project
proto attach --messages 30        # replay more history on connect
```

While attached you see live session events and can type prompts. Slash commands:

| Command | Effect |
| --- | --- |
| `/bash <cmd>` | Run a shell command in the session (no model needed). |
| `/abort` | Abort the running agent turn. |
| `/stop` | Stop the session host worker for this session. |
| `/detach` | Disconnect; the session keeps running daemon-side. |
| `/help` | List the commands. |

`Escape` aborts the current turn and detaches in one press (mirroring the interactive interrupt chord). `Ctrl-C` aborts; press it again within three seconds to detach. Closing the terminal (stdin EOF) detaches too.

Reattach at any time — the latest client wins, and the last messages are replayed from session state:

```sh
proto attach
```

Stop the host explicitly when you are done with a session:

```sh
proto attach --stop <session-id>
```

## How it works

- Each hosted session gets a deterministic daemon name and socket path derived from the session file, so every `proto attach` converges on the same worker.
- The worker re-enters the CLI in RPC mode (`--resume <file> --mode rpc`); RPC frames are multiplexed to the attached client. The transport never closes the RPC input on client disconnect — that is what keeps the session alive.
- Kernels and orchestrator subagents are children of the host worker (the eval runner is owned by the session), so they stay alive across attach/detach and are rebuilt on demand after a worker restart.
- Socket permissions are `0600`; sockets live in the daemon runtime directory and stale sockets are cleaned up on listen.

> [!NOTE]
> The session host is a convenience/continuity feature, not a security boundary: the worker runs with your user's permissions. Sandbox untrusted work separately.

## Scope

Session hosts deliberately do **not** include heartbeats, cron schedules, or autonomous continuation. Prompts enter a hosted session only from an attached client or from agent-to-agent messaging.
