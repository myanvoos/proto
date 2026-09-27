# Worker Agent Discovery and Selection

This document describes how the worker subsystem discovers agent definitions, merges multiple sources, and resolves a requested agent at execution time.

It covers runtime behavior as implemented today, including precedence, invalid-definition handling, and spawn/depth constraints that can make an agent effectively unavailable.

## Implementation files

- [`src/task/discovery.ts`](../packages/coding-agent/src/task/discovery.ts)
- [`src/task/agents.ts`](../packages/coding-agent/src/task/agents.ts)
- [`src/task/types.ts`](../packages/coding-agent/src/task/types.ts)
- [`src/task/index.ts`](../packages/coding-agent/src/task/index.ts)
- [`src/task/structured-subagent.ts`](../packages/coding-agent/src/task/structured-subagent.ts)
- [`src/task/spawn-policy.ts`](../packages/coding-agent/src/task/spawn-policy.ts)
- [`src/task/commands.ts`](../packages/coding-agent/src/task/commands.ts)
- [`src/prompts/agents/worker.md`](../packages/coding-agent/src/prompts/agents/worker.md)
- [`src/prompts/tools/fleet.md`](../packages/coding-agent/src/prompts/tools/fleet.md)
- [`src/discovery/helpers.ts`](../packages/coding-agent/src/discovery/helpers.ts)
- [`src/discovery/proto-extension-roots.ts`](../packages/coding-agent/src/discovery/proto-extension-roots.ts)
- [`src/config.ts`](../packages/coding-agent/src/config.ts)
- [`src/task/executor.ts`](../packages/coding-agent/src/task/executor.ts)

---

## Agent definition shape

Worker agents normalize into `AgentDefinition` (`src/task/types.ts`):

- required `name`, `description`, and `systemPrompt`
- optional `tools`, `spawns`, prioritized `model` list, `thinkingLevel`, `output`, `autoloadSkills`, `readSummarize`, `prewalk`, `advisor`
- `source`: `"bundled" | "user" | "project"` (extension agents are tagged with their extension root's project/user level)
- optional `filePath`

Parsing comes from frontmatter via `parseAgentFields()` (`src/discovery/helpers.ts`):

- missing `name` or `description` => invalid (`null`), caller treats as parse failure
- `tools` accepts CSV or array; if provided, `yield` is auto-added
- `spawns` accepts `*`, CSV, or array
- `output` is passed through as opaque schema data
- `read-summarize: false` (normalized to `readSummarize`) forces the subagent's `read` tool to return verbatim file content instead of structural summaries — `runSubprocess` applies it as a `read.summarize.enabled: false` override on the subagent's isolated settings (`src/task/executor.ts`). `scout` and `librarian` ship with it disabled. Defaults to enabled when the field is absent.
- `model` accepts one selector, CSV, or an array. Entries are tried in order after role aliases are expanded.
- `thinking-level` / `thinking` selects the agent's configured effort. A `fleet` `spawn` call's optional `effort` (`lo`, `med`, `hi`) takes precedence at launch. PROTO maps that hint to the selected model's lowest, middle, or highest supported effort, then clamps it to `orchestrator.maxEffort` (default `max`). The ceiling is carried across retry-fallback model switches. If the selected model has no supported effort at or below the ceiling, the spawn fails; models without a controllable effort surface instead fall back to their normal selector.
- `autoloadSkills` names skills from the parent session to inject before the first child prompt; unknown names are ignored
- `prewalk: true` starts the subagent on its resolved model and hands off to the default prewalk target (the `smol` role) at its first edit/write, exactly like the session-level `--prewalk`; a string value (e.g. `prewalk: "@smol"` or `prewalk: "openai/gpt-5-mini"`) picks a custom target. The `orchestrator.agentPrewalk` settings record (agent name → `"on"` / `"off"` / pattern, configured per agent from the `/agents` browser via its prewalk strip) overrides the frontmatter. Resolution happens in `runSubprocess` (`src/task/executor.ts`). An unavailable target is skipped instead of failing the spawn. A resolved target is skipped only when both its model identity and its effective thinking mode/level match the starting selection after model clamping; a same-model effort downgrade is a real hand-off and still arms and switches at the first edit/write.
- `advisor: true` pairs spawned sessions of the agent with an advisor running the model resolved for the `advisor` role; a string value (e.g. `advisor: "deepseek/deepseek-v4-flash"` or `advisor: "@smol:high"`) sets an explicit advisor model pattern (optional `:level` suffix), applied as the spawned session's `modelRoles.advisor`. The `orchestrator.agentAdvisor` settings record (agent name → `"on"` / `"off"` / pattern, configured per agent from the `/agents` browser via its advisor strip) overrides the frontmatter. Resolution happens in `runSubprocess` (`src/task/executor.ts`); subagents default to no advisor, and the effective opt-in is persisted in `session_init` so cold revival restores it.

## Role-backed custom agents

By default, PROTO discovers user agents from `~/.proto/agent/agents/*.md` (or the active agent directory's `agents/` subdirectory) and project agents from `.proto/agents/*.md`.

Give the agent a role alias in frontmatter, then dispatch it by name. `fleet` `spawn` accepts an optional `model` selector (role alias or concrete model); when omitted, normal agent/settings/parent fallback applies:

`~/.proto/agent/agents/reviewer.md`:

```md
---
name: reviewer
description: Review a change for correctness.
model: "@review"
---

Review the assigned change and report concrete findings.
```

Set the role mapping in the active agent directory's `config.yml` (by default `~/.proto/agent/config.yml`):

```yaml
modelRoles:
  review: openai/gpt-5.4:high
```

`@review` resolves through `modelRoles.review`. Each `modelRoles.<role>` value stores a concrete model selector and may append a thinking suffix such as `:high` (`src/config/model-resolver.ts`). Changing that mapping affects subsequent worker resolutions without editing agent definitions. Worker/eval preflight reloads the current global, project, and explicit overlay settings before rediscovering agents, so agent files and their role aliases added during a live session resolve from one refreshed configuration state.

For a dispatch, set the agent name and message:

```json
{
  "op": "spawn",
  "agent": "reviewer",
  "model": "@review",
  "message": "Report concrete correctness findings."
}
```

`/model`'s Roles view can assign and persist custom role mappings such as `review`, `fast`, and `good`. Changing only the active or default session selection does not remap those roles.

## Watch running agents

After dispatch, press `Alt+A` to open [Agent Fleet](./agent-fleet.md). Its live roster shows each worker agent's status, current activity, model, age, and usage. Select an agent to read its transcript and steer it directly; parked agents can be revived from the same view.

## Bundled agents

Bundled agents are embedded at build time (`src/task/agents.ts`) using text imports.

`EMBEDDED_AGENT_DEFS` defines:

- `scout`, `designer`, `reviewer`, and `librarian` from prompt files
- `worker` and `lightbot` from the shared `worker.md` body plus injected frontmatter; no bundled agent sets `prewalk` — the generic `worker` agent's hand-off is armed by the `orchestrator.prewalk` setting (default off), or per agent via `/agents` / `orchestrator.agentPrewalk` / user agent frontmatter

Loading path:

1. `loadBundledAgents()` parses embedded markdown with `parseAgent(..., "bundled")`; the parser default level is `"fatal"`
2. results are cached in-memory (`bundledAgentsCache`)

Because bundled parsing uses the default `level: "fatal"`, malformed bundled frontmatter throws and can fail discovery entirely.

## Filesystem and plugin discovery

`discoverAgents(cwd, home)` (`src/task/discovery.ts`) merges agents from PROTO-native roots, PROTO extension packages, and Claude marketplace plugin roots before appending bundled definitions. Direct cross-harness roots such as `.claude/agents`, `.codex/agents`, and `.gemini/agents` are intentionally skipped — their frontmatter schema is not the PROTO worker-agent contract (`AGENT_CONFIG_SOURCE = ".proto"` filters the native config-dir lists).

### Discovery inputs and precedence

1. Nearest project `.proto/agents` dir from `findAllNearestProjectConfigDirs("agents", cwd)` (first `.proto` hit only)
2. User `.proto/agents` dir from `getConfigDirs("agents", { project: false })` (first `.proto` hit only)
3. `<extension-root>/agents` for every enabled PROTO extension package returned by `listOmpExtensionRoots(...)`, in this order:
   - CLI `--extension` roots
   - project `extensions:` settings
   - user `extensions:` settings
   - installed npm/link plugins
4. Claude marketplace plugin roots (`listClaudePluginRoots(home, cwd)`) with `agents/` subdirs — only when `isProviderEnabled("claude-plugins")`; project-scope plugins sort before user-scope
5. Bundled agents (`loadBundledAgents()`)

The PROTO extension-package surface is disabled when the `proto-plugins` capability provider is disabled. Installed Claude marketplace roots are filtered out of the installed-plugin portion of `listOmpExtensionRoots`; marketplace agents enter through the separately gated Claude-plugin path.

## Merge and collision rules

Discovery uses first-wins dedup by exact `agent.name`:

- A `Set<string>` tracks seen names.
- Loaded agents are flattened in directory order and kept only if name unseen.
- Bundled agents are filtered against the same set and only added if still unseen.

Implications:

- Project `.proto` overrides user `.proto`.
- Earlier extension roots override later extension roots, Claude marketplace plugins, and bundled agents.
- Non-bundled agents override bundled agents with the same name.
- Name matching is case-sensitive (`Task` and `task` are distinct).
- Within one directory, markdown files are read in locale-aware lexicographic filename order (`localeCompare`) before dedup.

## Invalid/missing agent file behavior

Per directory (`loadAgentsFromDir`):

- unreadable/missing directory: treated as empty (`readdir(...).catch(() => [])`)
- file read or parse failure: warning logged, file skipped
- parse path uses `parseAgent(..., level: "warn")`

Frontmatter failure behavior comes from `parseFrontmatter`:

- parse error at `warn` level logs warning
- parser falls back to a simple `key: value` line parser
- if required fields are still missing, `parseAgentFields` fails, then `AgentParsingError` is thrown and caught by caller (file skipped)

Net effect: one bad custom agent file does not abort discovery of other files.

## Agent lookup and selection

Lookup is exact-name linear search:

- `getAgent(agents, name)` => `agents.find(a => a.name === name)`
- unrestricted sessions default an omitted `agent` field to `worker`
- a restricted parent `spawns` list defaults an omitted `agent` field to the first listed agent

`resolveEffectiveSubagentPolicy()` is shared by worker and eval-backed subagent launches. Before allocating artifacts it:

1. atomically reloads the live session's persisted global, project, and explicit overlay settings while preserving runtime overrides
2. resolves the omitted or explicit agent name from the parent spawn policy
3. enforces depth, blocked-self-recursion, and parent spawn-policy guards
4. rediscovers agents with `discoverAgents(session.cwd)` and performs exact lookup
5. checks `orchestrator.disabledAgents`
6. resolves output schema, model policy, and isolation policy

A missing name fails preflight with `Unknown agent "...". Available: ...`; no subprocess runs.

### Description vs execution-time discovery

`FleetTool.create()` calls `discoverAgents(session.cwd)` when building the model-facing tool description. Execution rediscovers agents during runtime preflight, so the runtime set can differ from the earlier description if agent or extension files changed mid-session. Spawn availability is determined after policy resolution rather than from a stale description-time agent object.

## Model and structured-output precedence

For worker dispatch, model precedence is:

1. the caller's explicit `model` (`fleet` `spawn` or eval `agent()`)
2. `orchestrator.agentModelOverrides[agentName]`
3. the agent frontmatter's prioritized `model` list
4. the parent's active model, then its configured/default model fallback

Role aliases in these selectors are expanded through `modelRoles`. `fleet` `spawn`/`send` and the eval bridge can supply an invocation-local model override ahead of the settings override.

Runtime output schema precedence is:

1. the caller's explicit output schema
2. agent frontmatter `output`
3. parent session `outputSchema`

The caller's optional `schemaMode` overrides the parent session mode; the default is `permissive`.

The model-facing prompt (`src/prompts/tools/fleet.md`) supplies discovered agent names/descriptions and recommends `worker` for design/debugging/multi-file judgment and `lightbot` for mechanical, well-specified work.

## Command discovery interaction

`src/task/commands.ts` is parallel infrastructure for workflow commands (not agent definitions), but it follows the same overall pattern:

- load command items from capability providers
- parse and deduplicate by name with first-wins
- exact-name lookup via `getCommand`

In `src/task/index.ts`, command helpers are re-exported with agent discovery helpers. Agent discovery itself does not depend on command discovery at runtime.

## Availability constraints beyond discovery

An agent can be discoverable but still unavailable to run because of execution guardrails.

### Disabled-agent settings

`resolveEffectiveSubagentPolicy()` checks `orchestrator.disabledAgents` after resolving the agent. A disabled name fails preflight and lists enabled alternatives when available.

### Parent spawn policy

The resolver checks `session.getSessionSpawns()`:

- `"*"` (also `true`, `null`, or absent) => allow any; omitted `agent` defaults to `worker`
- `""` or `false` => deny all
- CSV list => allow only listed names; omitted `agent` defaults to its first name

If denied: `Cannot spawn '...'. Allowed: ...`.

### Blocked self-recursion env guard

`PI_BLOCKED_AGENT` (or the internal request override) rejects an attempt to spawn the same blocked agent before discovery.

### Recursion-depth gating

`orchestrator.maxRecursionDepth` defaults to `2`; a negative value disables the cap. It counts levels of worker-spawned workers, as its settings label says (`0` none, `1` single, `2` double), so the shared policy rejects a spawn only once the spawning worker's own task depth has passed the cap. With the default the main agent (depth 0) spawns a worker at depth 1, that worker may spawn at depth 2, and the deepest worker runs at depth 3. `runSubprocess` sets an empty spawn policy for a child that lands past the cap, so `fleet` refuses its spawn and send operations; the shared policy message is what the kernel `agent()` path reports.

For a restricted agent tool list, `runSubprocess` still adds `fleet` and `jobs` unless the session explicitly restricts tool names; worker control inside `fleet` stays gated on the declared spawn policy and depth.

