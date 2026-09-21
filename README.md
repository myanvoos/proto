# proto

A terminal-first agent harness for long-running, multi-agent work. One deep execution
surface, persistent sessions that outlive your terminal, orchestration as native tooling,
and role-based routing across 60+ model providers.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/myanvoos/proto/main/scripts/install.sh | sh
```

Downloads a prebuilt binary (macOS / Linux, glibc and musl) from GitHub Releases into
`~/.local/bin`. Pass `--source` to build and install from source with Bun instead.

## Highlights

- **One execution surface, deeply tooled** — bash with in-process `rg`/`fd`/PTY builtins,
  persistent Python/JS kernel cells that can call back into the harness (`agent()`,
  `parallel()`, `tool.<name>()`), and `xd` device dispatch for auxiliary tools. The builtin
  registry is deliberately small: `read`, `bash`, `ask`, `inspect_media`, `browser`,
  `computer`, `checkpoint`, `rewind`, the `orchestrate_*` family, `fleet`, `monitor`,
  `checklist`, `web_search`, `manage_skill`.
- **Sessions that survive your terminal** — `proto attach` connects to a
  daemon-supervised session host (latest client wins, reattach replays recent messages,
  detach keeps the session running); parked sessions keep thinking in the background;
  goals hold objectives with token and wall-clock budgets.
- **Orchestration as native tooling** — persistent addressable workers
  (`orchestrate_spawn/send/wait/kill/list`), peer messaging + job + process supervision in
  one `fleet` tool, and a `monitor` that wakes the model on matching events. The Agent
  Fleet view (`Alt+A`) shows the live roster.
- **60+ providers, role-based routing** — nine model roles (`default`, `smol`, `slow`, `vision`, `designer`, `commit`, `tiny`, `worker`, `advisor`),
  fallback chains, custom OpenAI-compatible providers via `~/.proto/agent/models.yml`.
- **Teachable contracts** — tool docs lead with exact call shapes, argument normalization
  repairs cross-harness vocabulary with visible notes, outputs are bounded with explicit
  escape hatches (`artifact://`, paging, drill-down).
- **Five entry points** — interactive TUI, one-shot (`-p`), Node SDK, RPC (with a typed
  Python client), and ACP for editors.

## Philosophy

Proto converges the model's world onto a few deep surfaces instead of many narrow tools,
keeps work alive after the terminal closes, and treats every error message as part of the
API. The full statement — including what proto added over and removed from its omp
lineage — lives in [`docs/proto/`](docs/proto/README.md).

## Build from source

Fresh clones need workspace dependencies and the local Rust/N-API addon before the source
CLI can start:

```sh
bun setup
bun dev
```

`bun setup` installs Bun workspaces and builds the natives addon. Re-run
`bun run build:native` after changing Rust crates or `packages/natives`. Non-interactive
smoke check: `bun dev -- --version`.

## Monorepo

| Package (directory)                  | Description                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------- |
| **[pi-ai](packages/ai)**             | Multi-provider LLM client with streaming and model/provider integration     |
| **[pi-catalog](packages/catalog)**   | Model catalog: bundled model database, provider descriptors, and identity   |
| **[pi-agent-core](packages/agent)**  | Agent runtime with tool calling and state management                        |
| **[pi-coding-agent](packages/coding-agent)** | The interactive coding agent CLI and SDK                             |
| **[pi-tui](packages/tui)**           | Terminal UI library with differential rendering                             |
| **[pi-natives](packages/natives)**   | N-API bindings for grep, shell, image, text, syntax highlighting, and more  |
| **[omptype](packages/omptype)**      | ArkType-compatible schema validation with lazy JIT compilation              |
| **[pi-utils](packages/utils)**       | Shared utilities (logging, streams, dirs/env/process helpers)               |
| **[browser-relay](packages/browser-relay)** | Chrome extension that lets the browser tool drive your existing tabs |

Package directories publish under the `@oh-my-pi/*` npm scope (historical; used for
install compatibility).

### Rust crates

| Crate                                      | Description                                                                                         |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| **[pi-natives](crates/pi-natives)**        | Core Rust native addon (N-API `cdylib`) used by `pi-natives`; aggregates the crates below |
| **[pi-shell](crates/pi-shell)**            | Embedded shell / PTY / process management (wraps `brush-*`)                                          |
| **[pi-ast](crates/pi-ast)**                | tree-sitter-based code outlines and AST utilities (50+ language grammars)                            |
| **[pi-iso](crates/pi-iso)**                | Worker isolation backend resolver: APFS clones, btrfs/zfs reflinks, overlayfs, projfs, rcopy         |
| **[pi-walker](crates/pi-walker)**          | Parallel ignore-aware filesystem walker with the scan cache shared by grep, glob, and workspace      |
| **[brush-core](crates/vendor/brush-core)** | Vendored fork of [brush-shell](https://github.com/reubeno/brush) for embedded bash execution          |
| **[pi-builtins](crates/pi-builtins)**      | Bash builtins (cd, echo, test, printf, read, export, …), 67 in-process CLI utilities, and the kernel bridge |

## Documentation

[`packages/coding-agent/DEVELOPMENT.md`](packages/coding-agent/DEVELOPMENT.md) covers
architecture and development. [`docs/`](docs) holds per-subsystem references (providers,
MCP, extensions, TUI, RPC, orchestration, session host, …), and
[`docs/proto/`](docs/proto/README.md) defines what makes proto its own harness.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Vendored code, including `crates/vendor/brush-core`, keeps its upstream
license — see `THIRD-PARTY-NOTICES.txt`.
