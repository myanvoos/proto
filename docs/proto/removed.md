# What proto removed from omp upstream

Proto forked omp and subtracted deliberately: narrow tools fold into bash and the kernel,
experimental subsystems that never paid their way are gone, and the tool registry shrinks
from upstream's 27 builtins to 18 (+3 hidden). This document enumerates what is gone and,
where applicable, what replaced it. Companion: [vs-omp.md](./vs-omp.md).

## Removed packages & crates

| Removed | What it was | Replacement |
|---|---|---|
| `packages/mnemopi` | Local SQLite Mnemosyne-port memory engine (remember/recall/stats/sleep, BeamMemory, embeddings, MCP, CLI) | Dropped — observational-memory compaction instead of a persistent memory DB |
| `packages/snapcompact` | Bitmap PNG pixel-font vision context compaction | Dropped — token-based compaction only |
| `packages/stats` | Local JSONL→SQLite usage observability dashboard/CLI | Partial — `/trajectory` ledger + OTLP export, no dashboard |
| `packages/collab-web` + `packages/wire` | Browser guest SPA + WS relay for encrypted live shared sessions | Dropped — `fleet` covers peer messaging, not spectator sharing |
| `packages/metaharness` | Unified benchmark manager (Harbor/TS-edit/SnapCompact) with SQLite+REST+dashboard, OCI/KVM runners | Partial — `bench/` suite for local benchmarks |
| `packages/typescript-edit-benchmark` | AST TypeScript mutation edit benchmark | Dropped |
| `crates/pi-edit` | Rust edit engine (apply_patch/hashline/sloppy/replace/notebook) | Dropped — file mutation via bash + kernel helpers |
| `crates/pi-diff` | jsdiff-compatible Myers O(ND) diff primitive | Partial — TypeScript diff helpers in `src/utils/diff.ts` and commit pipeline |
| `crates/pi-vcs` | In-process git+Jujutsu VCS abstraction (gitoxide/jj-lib) | Dropped — shell git via `src/utils/git.ts` |
| `crates/pi-voice` | Opus/WebRTC audio capture/playback backends | Dropped — no TTS/STT/voice |

## Removed tools (registry diff)

Upstream builtins with **no proto equivalent**: `edit`, `write`, `glob`, `grep`,
`ast_grep`, `ast_edit`, `eval`, `lsp`, `debug` (DAP client), `github`, `security_scan`,
`context_notes`, `new_context`, `memory_edit`, `retain`, `recall`, `reflect`, `learn`,
`task`, `hub`.

| Upstream tool | Proto replacement |
|---|---|
| `edit` / `write` / `glob` / `grep` / `ast_grep` | Bash is the mutation and search surface (rg/fd built into the shell); `read` gained selectors, structural outlines, and recovery ranges; kernel helpers edit with anchor/occurrence assertions |
| `eval` | Persistent Python/JS kernel cells inside bash (`python -c`/`node -e` become stateful cells) |
| `task` | `orchestrate_spawn/send/wait/kill/list` — persistent addressable workers |
| `hub` | `fleet` — peer messaging + jobs + process supervision in one tool |
| `lsp` / `debug` (DAP) | Dropped entirely (no LSP/DAP runtime; the stale `docs/tools/debug.md` leftover was removed) |
| `github` | Dropped — gh CLI via bash, web search, MCP |
| `security_scan` | Dropped |
| `memory_edit` / `retain` / `recall` / `reflect` / `learn` / `context_notes` / `new_context` | Dropped — observational-memory compaction; `manage_skill` + `autolearn` still mint managed skills |
| `ast_edit` | Dropped — kernel/bash edits |

Proto keeps: `read`, `bash`, `ask`, `inspect_media` (new), `browser`, `computer`,
`checkpoint`, `rewind`, `orchestrate_*` (new), `fleet` (new), `monitor` (new), `todo`,
`web_search`, `manage_skill`; hidden: `yield`, `goal`, `think`.

## Removed docs

Upstream-only docs deleted (no proto counterpart): `agent-hub.md`, `approval-mode.md`,
`collab.md`, `handoff-generation-pipeline.md`, `lsp-config.md`, `memory.md`,
`mnemosyne-memory-backend.md`, `session-operations-export-share-fork-resume.md`,
`stream.md`, `task-agent-discovery.md`, `vibe-mode.md`, proto's own leftover `tools/ast-grep.md` + `tools/debug.md` (describing tools that no longer exist), and `docs/tools/{ast-edit,
context-notes,edit,eval,github,glob,grep,hub,learn,lsp,memory_edit,new-context,recall,
reflect,retain,security_scan,task,tts,write}.md`.

Renamed/replaced docs: `task-agent-discovery.md` → `worker-agent-discovery.md`;
`agent-hub.md` → `agent-fleet.md` + `orchestration.md`; handoff pipeline → self-summary
notes in `compaction.md`; session export/share/fork → `session-operations.md` (fork/resume
kept; export/share/dump dropped).

## Removed CLI commands

Upstream-only `proto <command>` entries: `cleanse` (weighted parallel diagnostics
subagents), `collab`/`join` (live shared sessions), `git` (fullscreen staging/diff/commit
UI), `if-bench` (instruction-following glyph benchmark), `say` (local TTS), `share`
(encrypted session links/gists), `stats` (usage dashboard), `stream` (public live channel).

## Removed slash commands

Upstream-only: `/btw`, `/changelog`, `/cleanse`, `/collab`, `/debug`, `/delete`, `/dump`,
`/export`, `/force`, `/fresh`*, `/git`, `/guided-goal`, `/handoff`, `/hub`, `/join`,
`/leave`, `/live`, `/memory` (+ its subcommands), `/omfg`, `/open`, `/pin`, `/plan`,
`/plan-review`, `/restart`, `/retry`, `/security`, `/shake`, `/share`, `/skillful`,
`/stats`, `/switch`, `/tan`, `/trace`, `/vibe`, `/wt` (`/worktree`; the `proto worktree`
CLI remains). (\*proto carries a `/fresh` doc; verify before relying on it.)

## Removed internal subsystems

Upstream `src/` trees with no proto counterpart: `activity`, `auto-thinking`, `autoresearch`,
`cleanse`, `collab`, `dap`, `edit`, `hindsight`, `if-bench`, `jsonrpc`, `judgment`, `live`,
`lsp`, `memories`, `memory-backend`, `mnemopi`, `plan-mode`, `security`, `sharpshooter`,
`speculation` (proto has its own `eval/speculation.ts`), `stats`, `stream`, `stt`, `tts`,
`vibe`. Grouped: code intelligence (lsp/jsonrpc/dap/edit), memory
(hindsight/memories/sharpshooter/memory-backend/mnemopi), voice (stt/tts/live),
planning & approval (plan-mode, approval-mode), social/streaming (collab/live/stream),
research & benchmarks (autoresearch/if-bench), routing experiments (auto-thinking/judgment).

## Removed infra

Bazel (BUILD/MODULE files, toolchains, remote cache, cache-warm workflow), Nix flake +
workflow, Dockerfiles (incl. robomp image), oxlint/oxfmt config (proto uses Biome),
`python/robomp` (GitHub issue/PR triage/release worker queue + dashboard), `.omp/commands`
repo workflows (cleanup, fix-issues, release, review-prs, triage — none carried over),
`.omp/tools` Bun TUI utility.

## Kept under a different name (not removals)

`.omp/skills` → `.proto/skills` (semantic-compression, system-prompts,
tool-prompt-optimization — identical capabilities), `.omp` project dir → `.proto`,
`@oh-my-pi/*` package names → unchanged (npm scope, kept for install compatibility),
`task-agent-discovery` → worker-agent discovery, TTS/voice unrelated to proto's TTSR.
