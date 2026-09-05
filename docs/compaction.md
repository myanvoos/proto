# Compaction and Branch Summaries

Compaction and branch summaries are the two mechanisms that keep long sessions usable without losing prior work context.

- **Compaction** uses the built-in [pi-blackhole](https://pi.dev/packages/pi-blackhole) extension to replace old history with a deterministic structural summary plus durable observations and reflections.
- **Branch summary** captures abandoned branch context during `/tree` navigation.

Both are persisted as session entries and converted back into user-context messages when rebuilding LLM input. Proto retains its existing scheduler, cut-point selection, persistence, overflow recovery, and provider reset machinery; pi-blackhole owns the default summary and observational-memory behavior through `session_before_compact`.

## Key implementation files

- `packages/coding-agent/src/vendor/pi-blackhole/index.js` (pi-blackhole 0.4.10 runtime)
- `packages/coding-agent/src/sdk.ts` (built-in extension registration)
- `packages/agent/src/compaction/compaction.ts` (preparation and optional pi-default summarization)
- `packages/agent/src/compaction/branch-summarization.ts`
- `packages/agent/src/compaction/pruning.ts`
- `packages/agent/src/compaction/compaction-v2-streaming.ts` (provider-native streaming compaction)
- `packages/agent/src/compaction/utils.ts`
- `packages/agent/src/compaction/openai.ts`
- `packages/coding-agent/src/session/session-manager.ts`
- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/session/session-maintenance.ts` (automatic maintenance orchestration)
- `packages/coding-agent/src/session/messages.ts`
- `packages/coding-agent/src/extensibility/hooks/types.ts`
- `packages/coding-agent/src/config/settings-schema.ts`

## Session entry model

Compaction and branch summaries are first-class session entries, not plain assistant/user messages.

- `CompactionEntry`
  - `type: "compaction"`
  - `summary`, optional `shortSummary`
  - `firstKeptEntryId` (compaction boundary)
  - `tokensBefore`
  - optional `details`, `preserveData`, `fromExtension`
- `BranchSummaryEntry`
  - `type: "branch_summary"`
  - `fromId`, `summary`
  - optional `details`, `fromExtension`

When context is rebuilt (`buildSessionContext`):

1. Latest compaction on the active path is converted to one `compactionSummary` message.
2. Kept entries from `firstKeptEntryId` to the compaction point are re-included.
3. Later entries on the path are appended.
4. `branch_summary` entries are converted to `branchSummary` messages.
5. `custom_message` entries are converted to `custom` messages.

Those custom roles are then transformed into LLM-facing messages in `convertToLlm()`: `compactionSummary` and `branchSummary` become user messages rendered through the static templates

- `packages/agent/src/compaction/prompts/compaction-summary-context.md`
- `packages/agent/src/compaction/prompts/branch-summary-context.md`

while `custom` messages pass through as developer messages with their raw content (no template).

## Compaction pipeline

### Triggers

Compaction/context maintenance can run in six ways:

1. **Manual context compaction**: `/compact [instructions]` calls `AgentSession.compact(...)`.
2. **Automatic overflow recovery**: after a same-model assistant error that matches context overflow.
3. **Automatic incomplete-output recovery**: after a same-model assistant message ends with `stopReason === "length"` (OpenAI/Codex `response.incomplete`).
4. **Automatic threshold maintenance**: after a successful turn when context exceeds the resolved threshold.
5. **Mid-turn threshold maintenance**: before the next provider request when a tool-loop turn crosses the threshold and `compaction.midTurnEnabled !== false`.
6. **Idle maintenance**: `runIdleCompaction()` can invoke the same auto-maintenance path with reason `"idle"`.

### Compaction shape (visual)

```text
Before compaction:

  entry:  0     1     2     3      4     5     6      7      8     9
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬──────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴──────┘
                └────────┬───────┘ └──────────────┬──────────────┘
               messagesToSummarize            kept messages
                                   ↑
                          firstKeptEntryId (entry 4)

After compaction (new entry appended):

  entry:  0     1     2     3      4     5     6      7      8     9      10
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬──────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool │ cmp │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴──────┴─────┘
               └──────────┬──────┘ └──────────────────────┬───────────────────┘
                 not sent to LLM                    sent to LLM
                                                         ↑
                                              starts from firstKeptEntryId

What the LLM sees:

  ┌────────┬─────────┬─────┬─────┬──────┬──────┬─────┬──────┐
  │ system │ summary │ usr │ ass │ tool │ tool │ ass │ tool │
  └────────┴─────────┴─────┴─────┴──────┴──────┴─────┴──────┘
       ↑         ↑      └─────────────────┬────────────────┘
    prompt   from cmp          messages from firstKeptEntryId
```

### Overflow/incomplete recovery vs threshold/idle maintenance

The automatic paths are intentionally different:

- **Overflow recovery**
  - Trigger: current-model assistant error is detected as context overflow and the error is not older than the latest compaction.
  - The failing assistant error message is removed from active agent state before retry.
  - Context promotion is tried first; if a configured larger model is available, the agent switches model and retries without compacting.
  - If promotion is unavailable and compaction is enabled, automatic maintenance walks `compaction.methodOrder` with `reason: "overflow"` and `willRetry: true`.
  - On success, `agent.continue()` is scheduled to retry the turn.

- **Incomplete-output recovery**
  - Trigger: same-model assistant message ends with `stopReason === "length"` and the message is not older than the latest compaction.
  - The incomplete assistant message is removed from active agent state before recovery.
  - Context promotion is tried first.
  - If promotion is unavailable and compaction is enabled, auto maintenance walks `compaction.methodOrder` with `reason: "incomplete"` and `willRetry: true`.
  - On soft-compaction success, `agent.continue()` is scheduled to retry the turn.

- **Threshold maintenance**
  - Trigger: successful, non-error assistant message whose adjusted context tokens exceed `resolveThresholdTokens(...)`.
  - Mid-turn maintenance also checks safe tool-loop boundaries before the next provider request when `compaction.midTurnEnabled !== false`.
  - Tool-output pruning can reduce the measured token count before threshold comparison.
  - Context promotion is tried before post-turn compaction.
  - If promotion is unavailable, auto maintenance walks `compaction.methodOrder` with `reason: "threshold"` and `willRetry: false`.
  - On success, if `compaction.autoContinue !== false`, post-turn maintenance schedules an agent-authored developer auto-continue prompt from `prompts/system/auto-continue.md`; mid-turn maintenance never schedules a separate continuation because the core loop already owns the next provider request.

- **Idle maintenance**
  - Trigger: `runIdleCompaction()` when not streaming or already compacting.
  - Uses `reason: "idle"` and does not auto-continue afterward.


### Display transcript

Compaction no longer visually restarts the conversation. The TUI renders the **display transcript** (`buildSessionContext({ transcript: true })` / `AgentSession.buildTranscriptSessionContext()`): every path entry in chronological order, with each compaction shown inline as a slim divider — `── compacted · ctrl+o ──` — at the point it fired. Expanding (ctrl+o) reveals the summary. Only the LLM context resets at the compaction boundary; the scrollback above the divider stays intact, including rendered tool output.

### Pre-compaction pruning

Before compaction checks, tool-result pruning may run (`pruneToolOutputs`).

Default prune policy:

- Protect newest `40_000` tool-output tokens.
- Require at least `20_000` total estimated savings.
- Never blank a result below `50` tokens (`MIN_PRUNE_TOKENS`): the `[Output truncated - N tokens]` placeholder costs ~8 tokens, so pruning a sub-floor result would grow the context and churn the prompt cache for nothing. (Superseded and useless results keep their own rules — the useless collector already drops no-savings candidates; superseded reads prune for correctness regardless of size.)
- Never prune `skill` tool results, `read` results of `skill://` paths, or reads of the active plan reference file (added via `AgentSession`'s plan protection).

Pruned tool results are replaced with:

- `[Output truncated - N tokens]`

If pruning changes entries, session storage is rewritten and agent message state is refreshed before compaction decisions.

### Useless-result elision

Tools can flag a finished result as contextually useless — a search with zero matches, a `fleet` wait that timed out with everything still running, an empty `fleet` inbox drain. The flag originates on the tool result (`AgentToolResult.useless`, set via `ToolResultBuilder.useless()` or directly on the returned object), is copied by the agent loop onto the persisted `ToolResultMessage` (never together with `isError` — errors always win), and is consumed in three places:

- **Per-turn stale-result pass** (`pruneSupersededToolResults`, gated by `compaction.dropUseless`, default on): flagged results are blanked to the exact placeholder `[Uneventful result elided]` (`USELESS_NOTICE`) with the same cache-aware timing as superseded reads — only when the suffix after the candidate is small (≤ ~8k tokens) or the session has idled past the provider prompt-cache lifetime. Results smaller than the notice itself are never blanked (no savings), and protected tools are exempt.
- **Threshold prune** (`pruneToolOutputs`): flagged results bypass the protect-recent window, same as superseded reads, and receive `USELESS_NOTICE` instead of the token-count placeholder.
- **Summary serialization**: `serializeConversation` (agent) drops the whole tool call/result pair from summarizer input — the source region is discarded after summarization anyway, so the exclusion costs no cache.

The flag never reaches provider wire formats, and flagged pairs are never removed from history (only blanked in place), so tool-call/result pairing and provider-native history replay stay intact.

### Boundary and cut-point logic

`prepareCompaction()` only considers entries since the last compaction entry (if any).

1. Find previous compaction index.
2. Compute `boundaryStart = prevCompactionIndex + 1`.
3. Adapt `keepRecentTokens` using measured usage ratio when available.
4. Run `findCutPoint()` over the boundary window.

Valid cut points include:

- message entries with roles: `user`, `assistant`, `bashExecution`, `hookMessage`, `branchSummary`, `compactionSummary`
- `custom_message` entries
- `branch_summary` entries

Hard rule: never cut at `toolResult`.

If there are non-message metadata entries immediately before the cut point (`model_change`, `thinking_level_change`, labels, etc.), they are pulled into the kept region by moving cut index backward until a message or compaction boundary is hit.

### Split-turn handling

If cut point is not at a user-turn start, compaction treats it as a split turn.

Turn start detection treats these as user-turn boundaries:

- `message.role === "user"`
- `message.role === "bashExecution"`
- `custom_message` entry
- `branch_summary` entry

Split-turn compaction generates two summaries:

1. History summary (`messagesToSummarize`)
2. Turn-prefix summary (`turnPrefixMessages`)

Final stored summary is merged as:

```markdown
<history summary>

---

**Turn Context (split turn):**

<turn prefix summary>
```

### Summary generation

By default, the built-in pi-blackhole `session_before_compact` hook returns the complete `CompactionResult`; no compaction-model call is made. Its deterministic compiler:

1. Normalizes messages and removes configured noise and thinking blocks.
2. Extracts goals, file changes, commits, outstanding context, and user preferences.
3. Builds a bounded recent transcript with stable entry references.
4. Folds observations and reflections from the session ledger.
5. Adds `recall` instructions so compacted source evidence remains recoverable.

The stored entry keeps Proto's normal `CompactionEntry` boundary and token fields. Blackhole-specific metadata is stored in `details`, including `compactor: "blackhole"` and the folded observational-memory snapshot. Existing session replay, TUI dividers, conductor transitions, SDK events, and RPC results therefore keep the same outer contract.

pi-blackhole also adds:

- `/memory` for explicit structural compaction and an optional post-compaction follow-up.
- `/memory settings`, `/observations`, and `/recall`.
- the agent-facing `recall` tool for transcript search, entry expansion, file drill-down, and observation/reflection evidence lookup.

Configuration lives at `~/.proto/agent/pi-blackhole/pi-blackhole-config.json`, with an optional project override at `.pi/pi-blackhole-config.json`. The default mode is deterministic compaction with observational memory enabled. Set `compactionEngine` to `"pi-default"` in that file to bypass Blackhole's result producer and use Proto's previous remote/soft summarizer path; the scheduler and recovery settings described below remain authoritative in either mode. See the [upstream configuration reference](https://github.com/k0valik/pi-blackhole/blob/270aa0912800b2b7ce64414ef4247be84106d8f8/docs/CONFIG.md) for Blackhole-specific options.

Observational memory runs background Observer, Reflector, and Dropper model calls. Structural compaction itself is deterministic and model-free; memory is not. Configure explicit inexpensive worker models and set `sessionFallback: false` to prevent workers from falling back to the active session model.

When `compactionEngine: "pi-default"`, the previous generator remains available as a compatibility fallback: it serializes the prepared conversation, treats it as untrusted data, and uses either provider-native compaction, a configured remote endpoint, or the structured LLM summary prompts in `packages/agent/src/compaction/prompts/`.

### File-operation context in summaries

Compaction tracks cumulative file activity using assistant tool calls:

- `read(path)` → read set
- `write(path)` → modified set
- `edit(path)` → modified set

Cumulative behavior:

- Includes prior compaction details only when prior entry is pi-generated (`fromExtension !== true`).
- In split turns, includes turn-prefix file ops too.
- `details.readFiles` excludes files also modified; `details.modifiedFiles` carries the rest (persisted shape is unchanged).

The file list is a grouped, prefix-folded directory tree (find-tool shape) with a per-file access marker — `(Read)` for read-only files, `(Write)` for modified files never read, `(RW)` for modified files also present in the cumulative read set. Capped at 20 files with an `[…N files elided…]` line. LLM-summary strategies append it as a `<files>` tag (via `upsertFileOperations`).

```xml
<files>
# packages/agent/src/compaction/
compaction.ts (Read)
utils.ts (RW)
## prompts/
file-operations.md (Write)
</files>
```

Legacy `<read-files>`/`<modified-files>` tags from summaries written by earlier versions are stripped (alongside `<files>`) before re-appending, so old summaries self-heal on the next compaction.

### Persist and reload

After summary generation (or hook-provided summary), agent session:

1. Appends `CompactionEntry` with `appendCompaction(...)`.
2. Rebuilds display context from the active leaf via `buildDisplaySessionContext()`.
3. Replaces live agent messages with rebuilt context.
4. Synchronizes active todo phases from the rebuilt branch and closes provider sessions whose history was rewritten.
5. Emits `session_compact` hook event.

## Branch summarization pipeline

Branch summarization is tied to tree navigation, not token overflow.

### Trigger

During `navigateTree(...)`:

1. Compute abandoned entries from old leaf to common ancestor using `collectEntriesForBranchSummary(...)`.
2. If caller requested summary (`options.summarize`), generate summary before switching leaf.
3. If summary exists, attach it at the navigation target using `branchWithSummary(...)`.

Operationally this is commonly driven by `/tree` flow when `branchSummary.enabled` is enabled.

### Branch switch shape (visual)

```text
Tree before navigation:

         ┌─ B ─ C ─ D (old leaf, being abandoned)
    A ───┤
         └─ E ─ F (target)

Common ancestor: A
Entries to summarize: B, C, D

After navigation with summary:

         ┌─ B ─ C ─ D (abandoned branch, unchanged)
    A ───┤
         └─ E ─ F ─ [summary of B,C,D] (new leaf)
```

### Preparation and token budget

`generateBranchSummary(...)` computes budget as:

- `tokenBudget = model.contextWindow - branchSummary.reserveTokens`

`prepareBranchEntries(...)` then:

1. First pass: collect cumulative file ops from all summarized entries, including prior pi-generated `branch_summary` details.
2. Second pass: walk newest → oldest, adding messages until token budget is reached.
3. Prefer preserving recent context.
4. May still include large summary entries near budget edge for continuity.

Compaction entries are included as messages (`compactionSummary`) during branch summarization input.

### Summary generation and persistence

Branch summarization:

1. Converts and serializes selected messages.
2. Wraps in `<conversation>`.
3. Uses custom instructions if supplied, otherwise `branch-summary.md`.
4. Calls summarization model with `SUMMARIZATION_SYSTEM_PROMPT`.
5. Prepends `branch-summary-preamble.md`.
6. Appends file-operation tags.

Result is stored as `BranchSummaryEntry` with optional details (`readFiles`, `modifiedFiles`).

## Extension and hook touchpoints

### `session_before_compact`

Pre-compaction hook.

Can:

- cancel compaction (`{ cancel: true }`)
- provide full custom compaction payload (`{ compaction: CompactionResult }`)

### `session.compacting`

Prompt/context customization hook for default compaction.

Can return:

- `prompt` (override base summary prompt)
- `context` (extra context lines injected into `<additional-context>`)
- `preserveData` (stored on compaction entry)

### `session_compact`

Post-compaction notification with saved `compactionEntry` and `fromExtension` flag.

### `session_compact_failed`

Terminal compaction-failure notification with `reason`, optional `errorMessage`, `aborted`, `willRetry`, and `fromExtension`. Blackhole uses it to clear in-flight state and surface attributed failures. Method fallbacks do not emit this event until every configured method has failed.

### `session_before_tree`

Runs on tree navigation before default branch summary generation.

Can:

- cancel navigation
- provide custom `{ summary: { summary, details } }` used when user requested summarization

### `session_tree`

Post-navigation event exposing new/old leaf and optional summary entry.

## Runtime behavior and failure semantics

- Manual compaction aborts current agent operation first.
- `abortCompaction()` cancels manual compaction and auto-compaction controllers.
- Auto compaction emits start/end session events for UI/state updates.
- Auto compaction can try multiple model candidates and retry transient failures; long retry delays prefer the next candidate when one is available.
- Overflow errors are excluded from generic retry path because they are handled by context promotion/compaction.
- If auto-compaction fails:
  - overflow path emits `Context overflow recovery failed: ...`
  - incomplete-output path emits `Incomplete response recovery failed: ...`
  - threshold/idle paths emit `Auto-compaction failed: ...`
- Branch summarization can be cancelled via abort signal (e.g., Escape), returning canceled/aborted navigation result.

## Settings and defaults

From `settings-schema.ts`:

- `compaction.enabled` = `true`
- `compaction.methodOrder` = `["remote", "soft"]`. `remote` uses provider-native OpenAI-compatible server compaction when available; unavailable or failed methods advance to the next preference. Legacy configured orders containing the removed `handoff`/`shake` methods are filtered down to their surviving `remote`/`soft` entries.
- `compaction.asyncEnabled` = `true`. Async (speculative) compaction: when context enters the pre-threshold band `[threshold − lead, threshold)` (lead = `clamp(threshold × 0.125, 8192, 32000)`), maintenance starts a background summarization for the first configured LLM-backed method (`remote` or `soft`) off a branch snapshot, isolated from the live turn by a side session id. The armed result is committed instantly when the threshold is actually crossed, hiding summarization latency; post-snapshot turns are appended after the summary unchanged. Armed results are discarded when the branch prefix changes (new compaction, reset boundary, `/tree` navigation), when a provider-native replay payload is no longer readable by the active model, or when context grows past `keepRecentTokens` since compute (a fresh speculation replaces it). Speculation is skipped while an extension registers `session_before_compact`. The status line pulses the auto-compact icon while a speculation runs and holds it in accent when a result is armed.
- `compaction.reserveTokens` is unset by default. The compaction layer normally applies a `16384`-token floor and at least 15% of the context window; on small windows where that default would be impractical, budget checks use the 15% proportional reserve. An explicit configured reserve is honored.
- `compaction.keepRecentTokens` = `20000`
- `compaction.autoContinue` = `true`
- `compaction.midTurnEnabled` = `true`
- `compaction.remoteEndpoint` = `undefined`
- `compaction.remoteStreamingV2Enabled` = `true`
- `compaction.v2RetainedMessageBudget` = `64000`
- `compaction.thresholdPercent` = `-1` and `compaction.thresholdTokens` = `-1`; a positive fixed token limit takes precedence over percentage, and otherwise the reserve-based threshold is used.
- `compaction.idleEnabled` = `false`
- `compaction.idleThresholdTokens` = `200000`
- `compaction.idleTimeoutSeconds` = `300`
- `compaction.supersedeReads` = `true`
- `compaction.dropUseless` = `true`
- `branchSummary.enabled` = `false`
- `branchSummary.reserveTokens` = `16384`

These values are consumed at runtime by `AgentSession`, `SessionMaintenance`, and the compaction/branch-summarization modules.
