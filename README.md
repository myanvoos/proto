# proto

An experimental agent harness with the IDE wired in — forked from [OMP](https://github.com/can1357/oh-my-pi) (oh-my-pi). A terminal-first coding agent: a real debugger on every write, native in-process tools, subagents, and role-based routing across 60+ model providers.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/can1357/proto/main/scripts/install.sh | sh
```

Downloads a prebuilt binary (macOS / Linux, glibc and musl) from GitHub Releases into `~/.local/bin`. Pass `--source` to build and install from source with Bun instead.

## Highlights

- **30 built-in tools** — files, hashline/AST edits, bash plus persistent Python/JS eval, grep, DAP debugging, browser, desktop control, web search.
- **In-process Rust core** — embedded bash with sessions, ripgrep-style search, tree-sitter AST, PTY, image and clipboard: no fork/exec on the hot path.
- **60+ providers, role-based routing** — ten model roles (`default`, `smol`, `slow`, …), fallback chains, custom OpenAI-compatible providers via `~/.proto/agent/models.yml`.
- **Subagents and extensibility** — parallel workers with typed results, extensions and skills, sessions with branching and checkpoints.
- **Five entry points** — interactive TUI, one-shot (`-p`), Node SDK, RPC, and ACP for editors.

## Build from source

Fresh clones need workspace dependencies and the local Rust/N-API addon before the source CLI can start:

```sh
bun setup
bun dev
```

`bun setup` installs Bun workspaces and builds `@oh-my-pi/pi-natives`. Re-run `bun run build:native` after changing Rust crates or `packages/natives`. Non-interactive smoke check: `bun dev -- --version`.

## Monorepo

| Package                                          | Description                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| **[@oh-my-pi/pi-ai](packages/ai)**               | Multi-provider LLM client with streaming and model/provider integration     |
| **[@oh-my-pi/pi-catalog](packages/catalog)**     | Model catalog: bundled model database, provider descriptors, and identity   |
| **[@oh-my-pi/pi-agent-core](packages/agent)**    | Agent runtime with tool calling and state management                        |
| **[@oh-my-pi/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI and SDK                                  |
| **[@oh-my-pi/pi-tui](packages/tui)**             | Terminal UI library with differential rendering                             |
| **[@oh-my-pi/pi-natives](packages/natives)**     | N-API bindings for grep, shell, image, text, syntax highlighting, and more  |
| **[@oh-my-pi/omptype](packages/omptype)**        | ArkType-compatible schema validation with lazy JIT compilation              |
| **[@oh-my-pi/pi-utils](packages/utils)**         | Shared utilities (logging, streams, dirs/env/process helpers)               |
| **[@oh-my-pi/hashline](packages/hashline)**      | Line-anchored patch language and applier behind the `edit` tool             |
| **[@oh-my-pi/browser-relay](packages/browser-relay)** | Chrome extension that lets the browser tool drive your existing tabs   |

### Rust crates

| Crate                                      | Description                                                                                         |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| **[pi-natives](crates/pi-natives)**        | Core Rust native addon (N-API `cdylib`) used by `@oh-my-pi/pi-natives`; aggregates the crates below |
| **[pi-shell](crates/pi-shell)**            | Embedded shell / PTY / process management split out of `pi-natives` (wraps `brush-*`)               |
| **[pi-ast](crates/pi-ast)**                | tree-sitter-based code summarizer and AST utilities (50+ language grammars)                         |
| **[pi-iso](crates/pi-iso)**                | Worker isolation backend resolver: APFS clones, btrfs/zfs reflinks, overlayfs, projfs, rcopy        |
| **[pi-walker](crates/pi-walker)**          | Parallel ignore-aware filesystem walker with the scan cache shared by grep, glob, and workspace     |
| **[brush-core](crates/vendor/brush-core)** | Vendored fork of [brush-shell](https://github.com/reubeno/brush) for embedded bash execution        |
| **[pi-builtins](crates/pi-builtins)**      | Bash builtins (cd, echo, test, printf, read, export, …) plus 67 in-process command-line utilities   |

## Documentation

[`packages/coding-agent/DEVELOPMENT.md`](packages/coding-agent/DEVELOPMENT.md) covers architecture and development. [`docs/`](docs) holds per-subsystem references (providers, MCP, extensions, TUI, RPC, …).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Vendored code, including `crates/vendor/brush-core`, keeps its upstream license — see `THIRD-PARTY-NOTICES.txt`.
