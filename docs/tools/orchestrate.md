# orchestrate

> Five model-facing tools that manage persistent coding-agent workers:
> `orchestrate_spawn`, `orchestrate_send`, `orchestrate_wait`, `orchestrate_kill`,
> `orchestrate_list`.

## Source
- Entry: `packages/coding-agent/src/tools/orchestrate.ts`
- Runtime: `packages/coding-agent/src/orchestrator/runtime.ts` (worker lifecycle, park/revive, tombstones)
- Model-facing prompts: `packages/coding-agent/src/prompts/tools/orchestrate-{spawn,send,wait,kill,list}.md`
- Settings: `packages/coding-agent/src/config/settings-schema.ts` (`orchestrator.*`)
- Docs: [orchestration](../orchestration.md), [worker agent discovery](../worker-agent-discovery.md)

## Model

- `orchestrate_spawn` starts a persistent worker from a first instruction (`message` — the
  worker's only initial context) and returns canonical `id` + `label`. Optional `label`
  (`[A-Za-z0-9_-]{1,48}`, never rewritten), `agent` type (bundled `worker`/`designer`/
  `librarian` plus user/project `.proto/agents`), `model` (role alias or id, validated
  against the role's model bank), `schema`/`effort`, and `isolated` (worktree with
  `apply`/`merge` controls).
- Results **self-deliver** on completion as a message that wakes the caller; workers keep
  running between turns (park/revive) and are continued with `orchestrate_send` by `id`.
  Labels may repeat; ids never do.
- `orchestrate_wait` blocks on in-flight turns (all workers or explicit ids) with a
  `timeoutMs` window; `orchestrate_kill` stops workers by `id`; `orchestrate_list` shows
  the roster with status.
- Isolated workers are terminal after completion and run an independent eval kernel;
  persistent workers are the default for follow-up work.
- Recovery: completed/killed workers leave tombstones and their transcripts stay reachable
  through `history://<id>`; outputs through `agent://<id>`.

## Settings

`orchestrator.*` — recursion/concurrency limits (`maxConcurrency`, `maxRecursionDepth`,
`maxRuntimeMs`, `agentIdleTtlMs`), soft request budgets, worktree isolation defaults
(`isolation.mode/apply/merge/commits`), per-agent model overrides, prewalk and advisor
controls, and `disabledAgents`.

## fleet vs orchestrate

`fleet` is peer messaging, background jobs, and process supervision between agents that
already exist. `orchestrate_*` creates and manages delegated coding-agent workers with
their own sessions and models.
