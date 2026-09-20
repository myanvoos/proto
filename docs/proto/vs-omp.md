# What proto adds over omp upstream

Proto forked [omp](https://github.com/can1357/oh-my-pi) (oh-my-pi) and evolved in its own
direction: fewer built-in tools, one powerful execution surface, persistent multi-agent
orchestration, and harness-level continuity features. This document enumerates, domain by
domain, every capability proto has that omp upstream does not. Its companion,
[removed.md](./removed.md), lists everything omp has that proto deliberately dropped.

> **Fairness note.** omp upstream moves fast and is newer than proto in some subsystems
> (SnapCompact vision compaction, tiny-inference MLX/socket workers, some RPC verbs, several
> slash commands). This doc claims only what is verifiably absent from the omp tree today —
> mostly by path (file/dir absent upstream) and registry diff.

## Model-facing tool surface

- **`inspect_media` builtin tool** — the model can point at any file, `Image #N` label, or
  `attachment://` URI and get a compact *text* analysis of image/audio/video content from a
  vision/audio-capable side model (or the active model when it has the modality inline).
  Evidence-first output with explicit uncertainty. Upstream has no inspect-media path.
- **`orchestrate_*` persistent worker lifecycle** (`orchestrate_spawn` / `_send` / `_wait` /
  `_kill` / `_list`) — replaces upstream's one-shot `task` tool with addressable, persistent
  coding-agent workers: canonical immutable ids vs labels, steering and queued turns, exact
  delivery receipts, wait with timeout/progress, worktree isolation with apply/merge controls,
  tombstones and recovery history. Runtime in `src/orchestrator/`, docs in
  [orchestration.md](../orchestration.md) and [worker-agent-discovery.md](../worker-agent-discovery.md).
- **`fleet` tool** — one model-facing surface for peer agent messaging (IRC-style channels,
  broadcast, wake/effect reporting), background jobs, and supervised daemon/process ops
  (start/ps/logs/wait/stop/restart, PTY, readiness, detached persistence). Subsumes upstream's
  `hub`. Docs: [agent-fleet.md](../agent-fleet.md), `docs/tools/fleet.md`.
- **`monitor` tool** — session-scoped event watcher: stream or poll a command, filter by
  regex/change, bounded events, and *wake the model* on match instead of burning turns on
  polling. Settings: `monitor.enabled/maxConcurrent/maxEvents`.
- **`xd` devices over bash** — discoverable auxiliary tools (browser, recall, tailnetssh,
  MCP passthrough, extension devices, …) are dispatched as `xd <tool> '<json>'` shell
  invocations rather than upstream's `read/write xd://` transport. Adds argument
  normalization with repair notes (see below), on-demand schemas (`xd <tool> ?`), heredoc
  stdin for quote-hostile payloads, and docs modes (`catalog`/`builtins`/`inline`).
- **Cross-harness argument normalization** — `xd` device calls written in another harness's
  vocabulary are normalized to canonical args (fleet send without `op`, `to`/`target` → `id`,
  `prompt`/`worker`/`workerId` on orchestrate, `timeout_seconds` → `timeoutMs`, …), and every
  repair is surfaced as a `note:` on the tool result so the model self-corrects. Unknown keys
  get did-you-mean suggestions from the live schema. (`src/tools/xdev-normalize.ts`)
- **Persistent Python/JS kernel cells inside bash** — `python`/`node`/`bun` invocations with
  `-c`/`-e` or stdin code are recognized as *kernel cells* and executed in a persistent
  per-session Python/JS executor (`src/eval/{js,py}/`) instead of a fresh interpreter:
  state survives across cells, and cells expose a harness API (`agent()`, `parallel()`,
  `pipeline()`, `tool.<name>()`, `completion()`, `symbols()`, `budget`, `output()` …).
  Rust side: `crates/pi-builtins/src/{python,node,kernel_cell}.rs` bridge via
  `PI_KERNEL_BRIDGE_ADDR`. Upstream keeps eval as a separate builtin tool; proto embeds it.
- **AST outlines for the kernel** — tree-sitter structural outlines (`symbols()`, elided
  bodies, recovery ranges) via `crates/pi-ast/src/outline.rs` and the
  `code_outline` N-API export in `crates/pi-natives`. Reads return structural summaries with
  line-range recovery instead of full-file dumps.
- **Speculative execution + assertion preflight** — streamed bash JSON/heredocs and literal
  `completion(...)` calls are parsed and speculatively executed (`eval/speculation.ts`);
  safe text-count/file assertions are pre-evaluated fail-open so obviously failed edits are
  reported before the full kernel run (`kernel.assertPreflight.enabled`).
- **Upstream tools not present here** are covered in [removed.md](./removed.md) — the short
  version: proto's builtin registry is 18 tools (+3 hidden) versus upstream's 27, by design.

## Slash commands & trajectory

- **`/trajectory`** — turn/step/token/cost/error ledger for the session, with a fullscreen
  view and OTLP JSON export (default `.proto/exports/trajectory-<id>.otlp.json`).
  (`src/session/trajectory/`, `src/slash-commands/builtin-trajectory.ts`)
- **`/side`** — two proto-native interactions: a side-question panel (ephemeral no-tools
  turn answered in an anchored panel without polluting the main transcript, with
  branch-into-session) and `/side --agent <work>` (fork the persisted session into an
  asynchronous background agent that inherits model/context/tools and reports back later).
- **Magic keywords** — standalone prose `ultrathink` / `workflowz` are boundary-aware
  (not inside code/URLs/identifiers), gradient-highlighted in the composer, and inject
  hidden system notices: max automatic thinking, or deterministic multi-subagent fanout via
  the kernel/fleet. Settings: `magicKeywords.*`.
- **`/help`** (alias `/?`) — built-in command listing pointing at keyboard shortcuts,
  settings, and tool help.

## CLI

- **`proto attach`** — attach to a daemon-supervised session: the RPC session runs in a
  session-host worker, `attach` connects over a per-session Unix socket (latest client wins),
  watches live, sends prompts, and detaches without stopping the session; reattach replays
  recent messages; `--stop <session>` tears the host down. Survives terminal close and broker
  restart. (`src/session-host/`, docs: [session-host.md](../session-host.md))
- **Map-reduce commit analysis** — `proto commit` on large diffs (≥4 files or any file
  >50k tokens) runs a small model concurrently per file (truncation/retries/timeouts, up to
  five observations per file) and a reduce phase over the observations for the final
  conventional analysis. Settings: `commit.mapReduce*`. (`src/commit/map-reduce/`)
- **`proto ttsr`** — inspect/test/scan Triggered Stream Rules (see TTSR below).
- CLI commands upstream has that proto dropped (`cleanse`, `collab`, `git`, `if-bench`,
  `join`, `say`, `share`, `stats`, `stream`) are listed in [removed.md](./removed.md).

## Modes, session & continuity

- **Session host / durable sessions** — see `proto attach` above; the host worker is
  supervised by the daemon broker and outlives its clients.
- **Detached main sessions** — switching TUI sessions parks the previous live session
  (still thinking in background) and reattaches the same in-memory session later; LRU-bounded
  (`session.detachedMainSessions`, default on). (`src/session/detached-session-holder.ts`)
- **Agent Fleet TUI** (`Alt+A` / `Ctrl+S`) — live roster/tree of workers with inspector,
  transcript tail paging, steer/revive/kill. Plus agents view, trajectory view,
  side-question panel, advisor panel, scheduled queue view. (`src/modes/components/…`,
  docs: [agent-fleet.md](../agent-fleet.md))
- **Setup wizard** — multi-scene first-run overlay: provider sign-in (OAuth/manual,
  credential save), model search/default assignment, live theme preview, web-search provider
  ordering. (`src/modes/setup-wizard/`)
- **`/queue` timed delivery** — `/queue 3h run the benchmarks` schedules a message with an
  independent wall-clock deadline; live countdown above the editor; `/queue --cancel`.
- **TTSR (Triggered Stream Rules)** — rules match regex/AST/region/scope/path/tool/history
  conditions (boolean any/all/not, gated `llm:` model judgments) over text/thinking/tool
  streams and inject reminders or interrupt the turn per context/interrupt mode; once/after-gap
  repeat policies; `/proto ttsr list|test|scan` CLI. (`src/export/ttsr-*.ts`, `src/session/ttsr-*.ts`)
- **`proto://` internal docs** — bundled documentation exposed as an internal URL scheme,
  path-resolved safely under `docs/`. Extended internal-URL surface includes `history://`,
  `agent://`, `artifact://`, `local://`, `skill://`, `rule://`, `ssh://`, `xd://`.
  (`src/internal-urls/proto-protocol.ts`)
- **Bundled worker agents** — `@worker` (hyperfocused delegated worker), `@designer`
  (UI/UX specialist with anti-slop guidance), `@librarian` (strict-JSON research librarian
  with source excerpts) ship as model-facing prompts; orchestrate spawn discovers these plus
  user/project `.proto/agents`. (`src/prompts/agents/`)

## Compaction & context

- **Compaction self-summary** — on every compaction the session model appends a private note
  (reasoning, ruled-out paths, unfinished state) so post-compaction turns keep the thread;
  prompts `compaction-self-summary.md`/`self-summary-section.md`, setting
  `compaction.selfSummary`. (`packages/agent/src/compaction/`)
- **Observational memory instead of a memory database** — context management runs through the
  observational-memory extension (vendored `pi-blackhole`), with remote/provider-native
  compaction as fallback; upstream's persistent memory stack (mnemopi/hindsight/retain/recall/
  reflect) is gone by design. See [removed.md](./removed.md) and
  [compaction.md](../compaction.md).
- **Goal mode with budgets** — proto's goals runtime extends the base goal machinery with
  cache-write/output token accounting (serialized queue), wall-clock accounting, completion
  budget reports, pause-on-interrupt, and strict hidden continuation prompts with a guided
  interview. (`src/goals/`, `src/prompts/goals/`)

## TUI & rendering

- **Code cells & structured output blocks** — `src/tui/code-cell.ts` (language/status/duration,
  syntax-highlighted line-numbered code, bounded/tail/expand hints), `output-block.ts`
  (width-aware bordered multi-section blocks, sixel rows, state colors), `json-tree` capped
  tree rendering for structured payloads.
- **Safe OSC-8 hyperlinks** — `src/tui/hyperlink.ts` emits file/URL/internal links respecting
  settings/TTY and rejecting C0/C1 injection.
- **Range selection component** — `packages/tui/src/components/list-selection.ts`:
  anchor-based contiguous selection with remapping across filtered/reordered lists.
- **`proto` theme** — built-in Nord-inspired dark theme registered in the theme picker.
- **Extension control center** — `/extensions` dashboard (per-provider toggles, metadata
  preview, native/project MCP entries, persisted `disabledExtensions`) and plugin settings
  editing manifest-defined options. (`src/modes/components/extensions/`)
- **Central ANSI constants** — `packages/tui/src/ansi.ts` centralizes ESC/CSI/OSC/SGR parsing.

## Providers, catalog & config

- **Expanded provider registry** — `packages/ai/src/registry/registry-lazy.ts` statically
  wires ~75 lazily-loaded providers (aiand, aimlapi, baseten, cerebras, coreweave, cursor,
  devin, exa, firepass, gmi-cloud, huggingface, kagi, kimi-code, litellm, llama.cpp,
  lm-studio, meta, nanogpt, novita, nvidia, ollama-cloud, OpenAI Codex, opencode Go/Zen,
  Parallel, Perplexity, Qianfan, Sakana, SiliconFlow, Synthetic, Tavily, Together, Umans,
  Venice, Vercel AI gateway, vLLM, Wafer, xAI, Xiaomi, ZAI, ZenMux, Zhipu, …) with OAuth
  variants; `packages/catalog` adds model JSON, identity/family classification, and pricing.
- **Codex client attestation** — `config/codex-attestation.ts` generates OpenAI Codex
  client-attestation tokens on macOS arm64 (native `deviceCheckGenerateToken`, CBOR signals)
  and wires them into `openai-codex-responses` requests.
- **`.proto` extension roots** — project/user `.proto/` roots for extensions and plugins
  (skills, slash commands, rules, prompts, hooks, tools, MCP, agents), with host virtual
  modules keeping omp-style extension code loading. (`src/discovery/proto-*-roots.ts`,
  `src/extensibility/plugins/host-module-compat.ts`)
- **Settings keys proto adds** — `monitor.*`,
  `orchestrator.{isolation,maxConcurrency,maxRecursionDepth,maxRuntimeMs,agentIdleTtlMs,softRequestBudget,agentPrewalk,agentAdvisor,…}`,
  `inspect_media.*`, `compaction.selfSummary`, `kernel.speculation.enabled`,
  `kernel.assertPreflight.enabled`, `commit.mapReduce*`, `magicKeywords.*`, `ttsr.*`, `goal.*`
  extensions, `statusLine.*`, `tools.xdev*`, `session.detachedMainSessions`.

## Infra, SDK & repo

- **`python/proto-rpc`** — separately installable typed Python client for `proto --mode rpc`:
  v2 negotiation, JSONL request correlation, frame reassembly, pagination, typed state/events,
  prompt-and-wait helpers, custom JSON-Schema tool registration, virtual URI read/write.
- **Rust kernel bridge & shell builtins** — `python`/`node`/`kernel_cell` builtins in
  `crates/pi-builtins`, fsobserve support in vendored brush-core.
- **Bench suite** — `bench/` harness benchmarking startup, session turn scale, TUI render,
  read tool, subagent output, event controller, agent telemetry.
- **Biome instead of oxlint, no Bazel/Nix/Docker** — repo-level tooling simplification
  (see [removed.md](./removed.md)).
- **Bundled skills** — `.proto/skills/{semantic-compression,system-prompts,tool-prompt-optimization}`
  ship with the harness (renamed from upstream's `.omp/skills` — capability preserved).

## Evolved, not new (do not over-claim)

These exist upstream too; proto evolved them and they are *not* proto-only: base goal mode,
compaction pruning/shake/remote-v2, blob broker & image publishing, web search providers,
tiny local inference, RPC mode, the base slash registry, provider OAuth basics.
