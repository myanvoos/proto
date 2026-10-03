# Advisor, WATCHDOG.md, and WATCHDOG.yml

The advisor subsystem attaches one or more optional reviewer models to a session. Each advisor reviews primary-agent transcript updates, can inspect the workspace with its own tools, and injects concise advice back into the primary session.

An advisor does not mutate primary session state directly. Its default grant is `read`; the SDK builds the advisor pool from `read` plus every `BUILTIN_TOOLS` factory, and a grant is limited to tools that factory actually constructed. A `WATCHDOG.yml` roster entry may grant any constructed built-in, including `bash`, `browser`, `fleet`, and `jobs`. Those tools run through an advisor `ToolSession` whose identity is suffixed `-advisor`; grant tools only when the advisor model and workspace are trusted (see [Tools and isolation](#tools-and-isolation)).

## Implementation files

- [`src/advisor/runtime.ts`](../packages/coding-agent/src/advisor/runtime.ts) (`ReviewerRuntime`, exported with an `AdvisorRuntime` alias)
- [`src/advisor/delta-feed.ts`](../packages/coding-agent/src/advisor/delta-feed.ts) (`DeltaCursorFeed` — the advisor's `ReviewerFeed`)
- [`src/session/reviewer-transport.ts`](../packages/coding-agent/src/session/reviewer-transport.ts) (shared reviewer transport)
- [`src/advisor/advise-tool.ts`](../packages/coding-agent/src/advisor/advise-tool.ts)
- [`src/advisor/emission-guard.ts`](../packages/coding-agent/src/advisor/emission-guard.ts)
- [`src/advisor/watchdog.ts`](../packages/coding-agent/src/advisor/watchdog.ts)
- [`src/advisor/config.ts`](../packages/coding-agent/src/advisor/config.ts)
- [`src/advisor/transcript-recorder.ts`](../packages/coding-agent/src/advisor/transcript-recorder.ts)
- [`src/prompts/advisor/system.md`](../packages/coding-agent/src/prompts/advisor/system.md)
- [`src/prompts/advisor/advise-tool.md`](../packages/coding-agent/src/prompts/advisor/advise-tool.md)
- [`src/session/session-advisors.ts`](../packages/coding-agent/src/session/session-advisors.ts)
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`src/slash-commands/builtin-registry.ts`](../packages/coding-agent/src/slash-commands/builtin-registry.ts)
- [`src/config/settings-schema.ts`](../packages/coding-agent/src/config/settings-schema.ts)

---

## Enabling the advisor

The subsystem requires `advisor.enabled: true`. Model selection then depends on the roster:

- Without any discovered `WATCHDOG.yml` advisor entries, PROTO creates the legacy/default advisor and resolves its model from `modelRoles.advisor`.
- With a roster, each enabled entry uses its explicit `model` when present, otherwise `modelRoles.advisor`. An unresolvable entry is reported as `no_model` without preventing other entries from running.
- `advisors[].enabled: false` keeps an entry visible as paused but does not build its runtime.

Example:

```yaml
modelRoles:
  advisor: anthropic/claude-sonnet-4-5:medium

advisor:
  enabled: true
```

Model selectors use normal role/model resolution, including provider-prefixed ids, canonical ids, fallback lists, and optional thinking suffixes.

`tier.advisor` controls service tier for all advisors. It defaults to `none` (standard processing); `inherit` follows the primary's live per-family tier, including `/fast` changes. Concrete values (`auto`, `default`, `flex`, `scale`, `priority`, `ultrafast`) are applied only when the advisor model's provider family supports them.

### Headless runs

Use `--advisor` to enable the advisor for one print-mode process without
persisting `advisor.enabled`:

```sh
proto -p --advisor "Review this task."
```

While a primary prompt is running, advisor concerns and blockers continue to steer that live turn. After the final prompt settles, print mode preserves late advisor notes without starting hidden primary turns, then waits up to ten minutes for final reviews before disposing the session. Error exits use a 30-second drain budget so failed automation can terminate. If either deadline expires, PROTO logs the reviews that disposal will abandon; completed reviews retain their transcript and token/cost usage.

Slash commands:

| Command              | Effect                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `/advisor`           | Toggle the advisor subsystem for this session (session-scoped override; does not change persisted `advisor.enabled`).                |
| `/advisor on`        | Enable the configured/default advisor runtimes for this session. Session-scoped; not persisted to config.                            |
| `/advisor off`       | Disable the advisor subsystem for this session and stop its runtimes. Session-scoped; not persisted to config.                       |
| `/advisor status`    | Show each advisor's runtime state, model, context usage, token usage, and cost.                                                      |
| `/advisor configure` | Open the interactive TUI editor for project- or user-level `WATCHDOG.yml`. Non-TUI command hosts report that the editor is TUI-only. |

If the subsystem is enabled but no legacy/default or roster model resolves, status reports the configured advisors as inactive/`no_model`.

## What the advisor sees

At each primary update, `AdvisorRuntime` receives only the new transcript delta since its previous update. Deltas are rendered with reasoning, tool intent, and watched-role markers, so advisors can review assistant reasoning as well as user-visible text, tool calls, and tool results. Provider-bound messages and tool arguments/results are passed through the session secret obfuscator before reaching the advisor model.

Most hidden `custom` messages collapse to a one-line summary in the delta. Advisors also receive the primary's discovered project context files (`AGENTS.md` and related standing instructions) in a `<project-context>` system-prompt block. If the session cwd is outside Git with exactly one direct child repository, an additional watchdog block tells the advisor which child is the active project.

Advisor messages already injected into the primary transcript are filtered out before the next delta is rendered. This prevents the advisor from recursively reviewing its own advice.

When the primary transcript is rewritten, the advisor runtime is reset:

- compaction and other context-rewrite maintenance (tool-output pruning, stale-result pruning, image dropping, or context shaking)
- session switch/resume
- branch/fork style history replacement
- context-maintenance re-prime when the advisor's own context cannot fit

Reset clears the advisor's private in-memory transcript and rewinds its cursor. The next advisor update replays the current bounded primary transcript instead of continuing from stale pre-rewrite context.

When the advisor is enabled mid-session, the cursor seeds to the current primary transcript length. That avoids replaying the whole old conversation on the first enabled turn.

## Tools and isolation

The advisor is a full agent with its own `Agent` instance and provider session. Its tools receive a `ToolSession` identity suffixed `-advisor`; the advisor transcript and in-memory context remain separate from the primary.

Every advisor has the `advise` tool for surfacing notes into the primary transcript. When `tools` is omitted, its default investigative grant is `read`.

A `WATCHDOG.yml` roster entry may select any subset of built-ins that were actually constructed for the session (a factory that returned `null` is absent). An explicit empty `tools: []` grants no investigative tools; `advise` remains available. Unknown-only lists are dropped with a warning and currently fall back to the default subset. Accepted names are [`read`, `bash`, `context`, `recall`, `ask`, `browser`, `computer`, `checkpoint`, `rewind`, `jobs`, `fleet`, `checklist`, `web_search`, and `manage_skill`](../packages/coding-agent/src/tools/builtin-names.ts).

Advisor tools are built against the advisor `ToolSession` and wrapped with `ExtensionToolWrapper`, just like registry tools. The Cursor exec bridge uses the same advisor tool map; direct file-mutation operations are disabled, while a granted `bash` tool can still mutate through shell commands.

The `advise` tool accepts one note and an optional severity:

| Severity        | Delivery                                                                                                                                                             | Intended use                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| omitted / `nit` | Non-interrupting aside, batched into the primary transcript at the next step boundary. A late terminal-answer `nit` is preserved as a visible card instead.         | Cleanup, simplification, low-risk edge cases.                                |
| `concern`       | Interrupting steering message when the delivery constraints below permit it. A late terminal-answer `concern` is preserved as a visible card instead.                | Material risk, likely wrong direction, missing constraint, hallucinated API. |
| `blocker`       | Interrupting steering message when the delivery constraints below permit it. Unlike a `concern`, a terminal answer alone does not prevent it from triggering a turn. | Continuing would clearly waste work or produce broken output.                |

Accepted notes are rendered into the primary transcript as XML-escaped `<advisory>` elements. Named roster advisors add an `advisor` attribute:

```text
<advisory advisor="Architecture" severity="concern" guidance="weigh, don't blindly obey">
note text
</advisory>
```

When you deliberately interrupt the agent (Esc, or a cancel from ACP, RPC, the SDK, or an extension), the advisor stops auto-resuming it. An interrupting `concern`/`blocker` raised while the run is stopped is recorded as a visible advisor card instead of restarting the turn, and a concern already in flight when you interrupt is preserved the same way rather than driving a surprise resume. The advice re-enters context the next time you resume — a new message, the `.`/`c` continue shortcut, or a steer/follow-up.

A normal yield the agent drove itself is treated differently from a deliberate interrupt, but it is not a blanket "always steers and resumes". The loop state and completed turn first determine the normal delivery path:

- **While the loop is still streaming** (the raise arrived before the yield, or during a resume you already drove), the note normally steers into the live turn.
- **While the final turn is unwinding** (the primary's last turn ended with a terminal text answer and no queued work, but the loop has not settled yet), a `nit` or `concern` is preserved as a visible card: the unwinding loop would never consume a steer. The guard lasts until the next real agent start. A terminal `yield` tool call likewise preserves every severity, including a `blocker`, because the yield aborts the loop.
- **Once the loop has yielded and gone idle**, delivery keys on how the turn ended:
  - If the primary's tail is a **terminal text answer with no queued work**, a late `nit` or `concern` is preserved as a visible card rather than waking the agent to restate a completed turn (#4840) — it re-enters context on the next resume (a new message, `.`/`c`, or a steer/follow-up), exactly like the interrupt case. A `blocker` is the exception: it normally steers a triggered turn, because it means the agent handed off broken or unexercised work that must be acknowledged before the turn is considered done (#5628).
  - Otherwise (the agent yielded mid-work, no terminal answer), an idle `concern`/`blocker` normally triggers a fresh turn so the advice is acted on immediately.

Two session/client constraints can still preserve a note whose normal delivery path is steering:

- **ACP with deferred agent-initiated turns:** when `deferAgentInitiatedTurns` is enabled and the bridge has not allowed agent-initiated turns, an idle would-be steer is preserved because the client cannot represent the triggered turn as busy. Advice raised while the primary loop is already streaming can still steer into that live turn.

So the advisor can steer and resume a run the agent ended on its own **while it is running or yielded mid-work and the current mode/client permits steering**. When steering is blocked instead, the note is either preserved as a card (the terminal-answer and deferred-ACP cases above) or downgraded to a non-interrupting aside (the `advisor.immuneTurns` cooldown below); either way it waits for the next step boundary or resume rather than waking the agent.

`advisor.immuneTurns` limits interruption frequency. After the advisor successfully delivers a `concern` or `blocker` through the steering channel, later concerns are routed as non-interrupting asides until the configured number of primary turns has completed; `blocker` notes still interrupt. The default is `3`. `nit` notes are unchanged, and advice raised while user-interrupt auto-resume suppression is active is still preserved instead of restarting a stopped run.

While an advisor update is reviewing work still in progress, `AdviseTool` defers `nit` and `concern` calls; only a `blocker` may interrupt partial work. Deferred notes pass the emission guard when raised, so a later flush delivers every one of them. A higher-severity note may displace a pending lower-severity note from the same update, but never a note from an earlier update or one already routed; re-raising a pending note at higher severity escalates it in place, and a `blocker` re-raise interrupts immediately. The primary's terminal turn boundary flushes the deferred notes without opening a new update budget, even when the advisor is quota-paused or halted before its next update; continuing tool turns keep them deferred.

### Emission guard

Each advisor's `AdviseTool` owns an `AdvisorEmissionGuard` (`src/advisor/emission-guard.ts`), the single admission authority for its notes. It enforces the system prompt's "at most one accepted note per update" and no-repeat rules:

1. **Normalization.** Lowercase, NFKC, collapse every run of non-alphanumeric characters to one space, then trim. `"Stop."`, `"*Stop*"`, and `"  stop  "` all key to `stop`.
2. **Content-free phrase filter.** Short phrases with no concrete reason — `stop`, `done`, `complete`, `no issue continue`, `lgtm`, `nothing to add`, and similar — are suppressed.
3. **Severity-aware dedupe.** A normalized note already accepted in this session is dropped at an equal or lower severity; a real escalation (`nit` → `concern` → `blocker`) is accepted. The FIFO history holds at most 4096 entries.
4. **Per-update rate limit.** At most one non-blocker note per advisor model `prompt()` cycle is accepted; blockers are exempt. Suppressed noise never consumes the budget.

Each `advise` call gets a one-line acknowledgment matching what happened: `Delivered.`, `Queued for the end of the turn. Do not re-raise.`, or `Dropped: …` with the reason (empty, nothing actionable, already raised, or this update's budget spent).

The per-update gate clears at each advisor update. Dedupe history clears when advisor session state resets (session switch/resume, branch/fork, or `/new`) or the runtime is rebuilt; a context-maintenance runtime reset alone preserves it.

## Bounded catch-up with `advisor.syncBacklog`

`advisor.syncBacklog` is not lockstep turn execution. It is a bounded catch-up delay for the primary agent when the advisor falls behind.

Allowed values:

- `off` — never wait for advisor catch-up
- `1`
- `3`
- `5`

On primary turn end:

1. the primary turn delta is queued for the advisor
2. the advisor drain loop starts or continues in the background
3. if `advisor.syncBacklog` is not `off`, the primary agent waits only while advisor backlog is at or above the configured threshold
4. the wait is capped at 30 seconds
5. if the advisor catches up below the threshold, the primary continues immediately
6. if the cap expires, the primary continues anyway

Practical interpretation:

- `off` favors maximum primary throughput.
- `1` is the closest mode to synchronous review: after each queued advisor delta, the primary waits up to 30 seconds for backlog to return to zero.
- `3` and `5` allow more advisor lag before the primary pauses.

Advisor failures do not permanently stall the primary. The host first attempts its credential/fallback recovery. Retriable failures are attempted up to three times before that backlog is dropped; three dropped-backlog cycles halt the runtime until an explicit reset, and a permanent request rejection can halt it after one cycle. A quota/usage-limit failure pauses the advisor with its batch retained until `/advisor` rebuilds it, configuration is reloaded, a new session starts, or the process restarts. Catch-up waiters are released as soon as an advisor is failing; print mode's final drain is the exception and waits through the advisor's retry and fallback-chain recovery, so a configured backup reviewer still finishes before the session is disposed.

Unsafe Advisor output follows a separate quarantine path rather than that
three-attempt request-retry policy. A call to a tool the Advisor was not
granted is not quarantined: the agent loop answers it in-band with a
`Tool <name> not found` result, so an `advise` call in the same turn still
lands. Before tool dispatch, the runtime quarantines generated text/advice when
an output-only destructive-shell directive is detected, or when at least three output-only hazard classes match
among destructive shell, instruction override, denial instruction, and
account-deletion claim. A new instruction override paired with a destructive
command quoted in the input also qualifies. The entire Advisor turn, including
any advice in it, is discarded before dispatch.

The first consecutive quarantine silently resets and re-primes the Advisor with
the latest pending context. A second consecutive quarantine emits one
deduplicated host warning, drops the affected batch, and resets the Advisor
context to break the loop. Any successful Advisor turn resets the quarantine
counter.

## WATCHDOG.md

`WATCHDOG.md` is advisor-only guidance. It is appended to the advisor system prompt; it is not injected into the primary agent's normal context and does not behave like `AGENTS.md`, `RULES.md`, or other context files.

Use it for review priorities: risks the advisor should watch for, project-specific traps, dangerous APIs, architectural boundaries, and quality bars that are useful to a reviewer but too noisy for the main executor.

Example:

```markdown
# Watchdog notes

Especially watch for:

- Changes that bypass the durable queue in `src/jobs/`.
- UI renderer paths that display unsanitized tool output.
- New worker spawns that do not re-enter the CLI host.
```

### Discovery locations

`discoverWatchdogFiles(cwd, agentDir)` loads every readable candidate from these locations:

1. user level: `<active agent dir>/WATCHDOG.md` (`~/.proto/agent/WATCHDOG.md` by default; relocated by `PI_CODING_AGENT_DIR`)
2. project levels while walking from `cwd` upward to the git repository root, or to the home directory when no repo root is found:
   - `<dir>/WATCHDOG.md`
   - `<dir>/.proto/WATCHDOG.md`

Unlike native context files, watchdog discovery does not stop at the nearest project file. Multiple project watchdog files can load together.

Candidates in hidden owner directories are ignored unless the file is inside an `.proto` directory. This keeps unrelated dot-directory conventions from being picked up accidentally while still allowing `.proto/WATCHDOG.md`.

### `@` imports

`WATCHDOG.md` content is expanded with the same `@` import helper used by context files:

- relative imports resolve from the importing file's directory
- `~/` resolves from the user's home directory
- imports inside fenced code blocks and inline code spans stay literal
- cycles are skipped
- missing or unreadable imports leave the original `@path` text in place

### Prompt order

Loaded watchdog blocks are sorted as:

1. user-level `WATCHDOG.md`
2. project-level files from farther ancestors down toward `cwd`

Each file is appended to the advisor system prompt as:

```xml
Especially pay attention to:
<attention>
...expanded watchdog content...
</attention>
```

Later project files sit closer to the end of the advisor prompt, so narrower directory guidance is more prominent than broad ancestor guidance.

## WATCHDOG.yml

`WATCHDOG.yml` (or `WATCHDOG.yaml`) is the advisor roster. Where `WATCHDOG.md` supplies review priorities, `WATCHDOG.yml` declares the advisors themselves — one entry per name, each with its own enable flag, model, tool grant, and specialization prompt. The interactive `/advisor configure` overlay edits this file in place.

Discovery and `/advisor configure` validate each entry independently: a malformed entry is skipped with a warning naming it (or its position) while the healthy advisors in the same file stay usable. Invalid YAML or a non-mapping document is skipped with a file-level warning. Problems appear as one aggregated warning at startup and when the editor opens, stay pinned inside the editor (including after a project/user scope switch), and saving writes only the valid entries.

Example:

```yaml
instructions: |
  Everyone: prefer diffs that keep tests unified.

advisors:
  - name: Architecture
    enabled: true
    model: anthropic/claude-sonnet-4-5:medium
    tools: [read, context]
    instructions: |
      Watch cross-module coupling and public-API growth.

  - name: Fixer
    enabled: false
    model: anthropic/claude-sonnet-4-5:high
    tools: [read, bash]
    instructions: |
      You may inspect and run tests locally with `bash`, then advise.
```

Fields:

- `instructions` (top level): shared prompt appended to every advisor's system prompt after `WATCHDOG.md` and before per-advisor instructions. Concatenated across all discovered `WATCHDOG.yml` files.
- `advisors[].name`: human label; slugified for the session id and its `__advisor.<slug>.jsonl` filename. Duplicate slugs across files are resolved by the same specificity rule as `WATCHDOG.md` discovery (project leaf > project ancestor > user).
- `advisors[].enabled`: optional per-advisor switch, default `true`. `false` leaves the advisor visible as paused in status/configuration.
- `advisors[].model`: optional model selector with optional `:level` thinking suffix (e.g. `x-ai/grok-code-fast:high`). Omitted → the advisor uses `modelRoles.advisor`.
- `advisors[].tools`: optional list of built-in tool names to grant. Omitted → requests the default `read` grant; explicit `[]` → no investigative tools. Any name in [`BUILTIN_TOOL_NAMES`](../packages/coding-agent/src/tools/builtin-names.ts) is accepted, including mutating tools. Names are lowercased only when they are recognized built-ins; `search` and `find` are not aliases. Unknown names are dropped with a warning; if that leaves a nonempty input with no valid names, the implementation currently treats the result as omitted and uses the default subset.
- `advisors[].instructions`: this advisor's specialization, appended after the shared baseline. Both instruction fields expand `@path` imports like `WATCHDOG.md`.

### Discovery locations

`WATCHDOG.yml`/`WATCHDOG.yaml` share the same user + project search path as `WATCHDOG.md`: the user-level `<active agent dir>/WATCHDOG.yml` plus every `WATCHDOG.yml`/`.proto/WATCHDOG.yml` encountered while walking from `cwd` up to the repository root (or the home directory when no repo root is found). All discovered files are loaded together; a more-specific file (project leaf > project ancestor > user) replaces an earlier entry with the same advisor slug.

## Subagents

Subagents run unadvised by default; advisors are opted in **per agent** instead of via a blanket toggle:

- Agent definition frontmatter `advisor`: `true` advises spawned sessions of that agent with the model resolved for the `advisor` role; a string (e.g. `advisor: "deepseek/deepseek-v4-flash"` or `advisor: "@smol:high"`) sets an explicit advisor model pattern with an optional `:level` thinking suffix.
- The `orchestrator.agentAdvisor` settings record (agent name → `"on"` / `"off"` / model pattern) overrides the frontmatter, and is configured per agent from the `/agents` browser: Enter on an agent opens its property strip; the advisor strip offers on/off, a model-browser pick, or a raw pattern.

An advised subagent session builds its own advisor subsystem with the same settings/model-role resolution (an explicit pattern lands on the spawned session's `modelRoles.advisor`), then reruns both `WATCHDOG.md` and `WATCHDOG.yml` discovery for that subagent session's `cwd` and agent directory. Subagent advisors remain isolated from the subagent's primary tool session in the same way the main advisor is isolated from the main agent.

## Cost and context behavior

Advisor usage is separate model usage. `/advisor status` reports advisor token counts and cost from the advisor agent's own transcript.

The advisor has its own append-only context. Before each advisor prompt, `AgentSession` estimates incoming tokens and may maintain advisor context:

1. try model-level context promotion when enabled and a larger compatible model is available
2. if promotion cannot fit enough context, compact the advisor's own message history
3. for readable history, re-prime from the current bounded primary transcript if compaction has no candidates or still cannot fit

Native compaction replaces advisor history only when the active model can replay its provider and Responses API format; a foreign native-enabled summarizer produces a portable text summary instead. Once the advisor holds native history, incompatible summarizers, retry fallbacks, cooldown restorations, and context promotions are skipped, and a maintenance failure preserves that history rather than re-priming it away. Replay compatibility does not require new native compaction to be enabled: same-provider Responses models can receive existing native history even when their own compaction endpoint is disabled, while creating a new native result still requires `remote` in `compaction.methodOrder` and an eligible writer.

The advisor's live context is in-memory and append-only; it is retained while the session runs, and is independently promoted/compacted/re-primed (above). It is not a replacement for the primary persisted transcript.

## Transcript persistence and observability

The advisor is a passive reviewer with its own model usage, so — like a worker — every finalized advisor turn is appended to JSONL inside the owning session's artifacts directory:

- legacy/default advisor: `<session>/__advisor.jsonl`
- named advisor: `<session>/__advisor.<slug>.jsonl`
- subagent advisor (frontmatter `advisor` / `orchestrator.agentAdvisor`): `<session>/<SubId>/__advisor[.<slug>].jsonl`

Paths derive from the owning session file (not the shared artifacts root), so each primary/subagent advisor writes a distinct file. The reserved `__advisor` stem cannot collide with a worker id.

Why a file:

- **Usage attribution.** Advisor assistant turns persist their usage/cost
  alongside the transcript, while advisor "session update" prompts are persisted
  as `synthetic`, agent-attributed user messages so they never inflate
  user-message metrics.
- **Observability.** [Agent Fleet](./agent-fleet.md) discovers legacy and named `__advisor*.jsonl` files on open and shows each as a read-only `advisor`-kind transcript under its owning session.

The file follows session switches: on `/new`, resume/switch, and branch the recorder reopens at the new session's path on the next advisor turn; before a `/drop` deletes the old artifacts dir the recorder feed is detached and drained so a queued write cannot recreate the deleted file. The on-disk log is append-only and independent of the in-memory context — re-primes and compaction never truncate it.

The advisor is never a peer. The `advisor`-kind registry ref is excluded from every agent-facing surface — the `fleet` peer roster and broadcast targets, the subagent peer prompt, and the `history://` index/lookup/completions — and cannot be messaged (`fleet` send refuses it) or [revived or killed from Agent Fleet](./agent-fleet.md#persisted-agents-and-advisors). It is not addressable as a peer, regardless of what tools it has been granted.
