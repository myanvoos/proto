# proto

A terminal-first agent harness for long-running, multi-agent work. It provides one deep execution
surface, persistent sessions that outlive your terminal, and orchestration as native tooling. As a fork of OMP, it supports role-based routing across 60+ model providers.

This harness bets on codemode, REPL-as-execution-surface, and letting agents write Turing-complete programs over their own context and environment.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/myanvoos/proto/main/scripts/install.sh | sh
```

Downloads a prebuilt binary (macOS / Linux, glibc and musl) from GitHub Releases into
`~/.local/bin`. Pass `--source` to build and install from source with Bun instead.

## Highlights

- **One execution surface, deeply tooled:** the main tool an agent uses is bash with an embedded shell (Rust `brush` fork), which contains in-process `rg`/`fd`/PTY builtins. We keep the always-loaded tool registry deliberately small. 
- **Code as a first-class surface:** persistent Python/JS kernel cells inside the bash
  tool, with host callbacks: `agent()` spawns workers, `parallel()` fans out,
  `tool.<name>()` calls any tool. Programmatic tool calling and sub-agent orchestration are implemented here as ordinary code an agent can write in persistent kernels.
- **Sessions that survive your terminal:** `proto attach` connects to a
  daemon-supervised session host, and parked sessions keep thinking in the background.
- **Orchestration as native tooling:** inherited from OMP's great subagent building blocks, orchestration here is implemented in the form of persistent addressable workers
  (`orchestrate_spawn/send/wait/kill/list`), peer messaging + job + process supervision in one `fleet` tool, and a `monitor` that wakes the model on matching events.
- **Programmatic context control:** the harness is an RLM. Compaction in `proto` borrows from the `pi-blackhole` / `pi-observational-memory` extensions. Additionally, it allows agents to programmatically invoke subagents on its own context, maintain compaction checkpoints, and automatically rewind throughout a single session. 

## Build from source

Fresh clones need workspace dependencies and the local Rust/N-API addon before the
source CLI can start:

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

[`docs/`](docs) holds per-subsystem references (providers, MCP, extensions, TUI, RPC,
orchestration, session host, …) and per-tool contracts in
[`docs/tools/`](docs/tools). Development rules live in [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE). Vendored code, including `crates/vendor/brush-core`, keeps its upstream
license — see `THIRD-PARTY-NOTICES.txt`.
