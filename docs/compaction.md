# Compaction and Branch Summaries

Compaction and branch summaries are the two mechanisms that keep long sessions usable without losing prior work context.

- **Compaction** uses the built-in [pi-blackhole](https://pi.dev/packages/pi-blackhole) extension to replace old history with a deterministic structural summary plus durable observations and reflections.
- **Branch summary** captures abandoned branch context during `/tree` navigation.

Both are persisted as session entries and converted back into user-context messages when rebuilding LLM input. Proto retains its existing scheduler, cut-point selection, persistence, overflow recovery, and provider reset machinery; pi-blackhole owns the default summary and observational-memory behavior through `session_before_compact`.

## Key implementation files

- `packages/coding-agent/src/vendor/pi-blackhole/index.js` (pi-blackhole 0.4.10 runtime)
- `packages/coding-agent/src/tools/recall.ts` (native recall tool)
- `packages/coding-agent/src/sdk.ts` (built-in extension registration)
- `packages/agent/src/compaction/compaction.ts` (preparation and remote compaction)
- `packages/agent/src/compaction/branch-summarization.ts`
- `packages/agent/src/compaction/pruning.ts`
- `packages/agent/src/compaction/compaction-v2-streaming.ts` (provider-native streaming compaction)
- `packages/agent/src/compaction/utils.ts`
- `packages/agent/src/compaction/openai.ts`
- `packages/coding-agent/src/session/session-manager.ts`
- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/session/session-maintenance.ts` (automatic maintenance orchestration)
- `packages/coding-agent/src/session/reviewer-transport.ts` (advisor context maintenance)
- `packages/coding-agent/src/session/messages.ts`
- `packages/coding-agent/src/extensibility/hooks/types.ts`
- `packages/coding-agent/src/config/settings-schema.ts`

## Session entry model

Compaction and branch summaries are first-class session entries, not plain assistant/user messages.

- `CompactionEntry`
  - `type: "compaction"`
  - `summary`, optional `shortSummary`
  - `firstKeptEntryId` (compaction boundary)
  - `tokensBefore`, optional `tokensAfter`
  - optional `method`, `warning`, `details`, `preserveData`, `fromExtension`
  - optional `providerReplayThroughEntryId` (last entry covered by a native replay snapshot)
- `BranchSummaryEntry`
  - `type: "branch_summary"`
  - `fromId`, `summary`
  - optional `details`, `fromExtension`

When active model context is rebuilt (`buildSessionContext` without `transcript: true`):

1. Latest compaction on the active path is converted to one `compactionSummary` message.
2. For local and Anthropic-native summaries, kept entries from `firstKeptEntryId` to the compaction point are re-included; an OpenAI Responses-family replay uses its provider payload for the covered region.
3. Later entries on the path are appended.
4. Non-empty `branch_summary` entries are converted to `branchSummary` messages.
5. `custom_message` entries are converted to `custom` messages, except the hidden prewalk-plan marker in active context.

Those custom roles are then transformed into LLM-facing messages in `convertToLlm()`: `compactionSummary` and `branchSummary` become user messages rendered through the static templates

- `packages/agent/src/compaction/prompts/compaction-summary-context.md`
- `packages/agent/src/compaction/prompts/branch-summary-context.md`

while ordinary `custom`/`hookMessage` messages pass through as developer messages with their raw content (no template); steering messages, user-invoked skill prompts, and image-bearing custom/hook messages have specialized conversion.

OpenAI/Codex native replay requires a matching provider and a Responses-family API on the active model. A separate native compaction endpoint does not give a Chat Completions encoder the ability to consume its output; Anthropic-native payloads are replayed through the matching Anthropic Messages encoder.

Disabling future native compaction does not disable normal replay of an existing payload. Compaction preparation has a separate, stricter reuse policy: local summarization must re-expand the original messages rather than treat an opaque placeholder as a readable summary.

## Compaction pipeline

### Triggers

Primary-session compaction/context maintenance can run in six ways:

1. **Manual context compaction**: `/compact [instructions]` calls `AgentSession.compact(...)`.
2. **Automatic overflow recovery**: after a same-model assistant error that matches context overflow.
3. **Automatic incomplete-output recovery**: after a same-model assistant message ends with `stopReason === "length"`; OpenAI/Codex Responses providers surface this as `response.incomplete`.
4. **Automatic threshold maintenance**: after a successful turn or before a pending provider request when context exceeds the resolved threshold.
5. **Mid-turn threshold maintenance**: before the next provider request when a tool-loop turn crosses the threshold and `compaction.midTurnEnabled !== false`.
6. **Idle maintenance**: `runIdleCompaction()` can invoke the same auto-maintenance path with reason `"idle"`.

Advisor runtimes use a separate threshold path in `ReviewerTransport.maintainContext(...)`.

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
  - On remote-compaction success, `agent.continue()` is scheduled to retry the turn.

- **Threshold maintenance**
  - Trigger: successful, non-error assistant message whose adjusted context tokens exceed `resolveThresholdTokens(...)`.
  - Mid-turn maintenance also checks safe tool-loop boundaries before the next provider request when `compaction.midTurnEnabled !== false`.
  - Tool-output pruning can reduce the measured token count before threshold comparison.
  - Context promotion is tried before post-turn compaction.
  - If promotion is unavailable, auto maintenance walks `compaction.methodOrder` with `reason: "threshold"` and `willRetry: false`.
  - On success, if `compaction.autoContinue !== false`, post-turn maintenance schedules an agent-authored developer auto-continue prompt from `packages/coding-agent/src/prompts/system/auto-continue.md`; mid-turn maintenance never schedules a separate continuation because the core loop already owns the next provider request.

- **Idle maintenance**
  - Trigger: `runIdleCompaction()` when neither streaming nor already compacting.
  - Uses `reason: "idle"` and does not auto-continue afterward.


### Display transcript

Compaction no longer visually restarts the conversation. The TUI renders the **display transcript** (`buildSessionContext({ transcript: true })` / `AgentSession.buildTranscriptSessionContext()`): every path entry in chronological order, with each compaction shown inline as a slim divider labeled `compacted` (or its method/token amount) with a `ctrl+o` hint at the point it fired. Expanding (ctrl+o) reveals the summary. Only the LLM context resets at the compaction boundary; the scrollback above the divider stays intact, including rendered tool output.

### Pre-compaction pruning

Before compaction checks, tool-result pruning may run (`pruneToolOutputs`).

Default prune policy:

- Protect newest `40_000` tool-output tokens.
- Require at least `20_000` total estimated savings.
- Never blank a result below `50` tokens (`MIN_PRUNE_TOKENS`): the `[Output truncated - N tokens]` placeholder costs ~8 tokens, so pruning a sub-floor result would grow the context and churn the prompt cache for nothing. (Superseded and useless results keep their own rules — the useless collector already drops no-savings candidates; superseded reads prune for correctness regardless of size.)
- Never prune `skill` tool results or `read` results of `skill://` paths.

Pruned tool results are replaced with:

- `[Output truncated - N tokens]`

If pruning changes entries, live agent message state is refreshed before compaction decisions; replacements are held in the maintenance context rather than rewritten to session storage.

### Useless-result elision

Tools can flag a finished result as contextually useless — a search with zero matches, a `jobs` wait that timed out with everything still running, an empty `fleet` inbox drain. The flag originates on the tool result (`AgentToolResult.useless`, set via `ToolResultBuilder.useless()` or directly on the returned object), is copied by the agent loop onto the persisted `ToolResultMessage` (never together with `isError` — errors always win), and is consumed in three places:

- **Per-turn stale-result pass** (`pruneSupersededToolResults`, gated by `compaction.dropUseless`, default on): flagged results are blanked to the exact placeholder `[Uneventful result elided]` (`USELESS_NOTICE`) with the same cache-aware timing as superseded reads — only when the suffix after the candidate is small (≤ ~8k tokens) or the session has idled past the stale-result flush interval (90 minutes in `SessionMaintenance`). Results smaller than the notice itself are never blanked (no savings), and protected tools are exempt.
- **Threshold prune** (`pruneToolOutputs`): flagged results bypass the protect-recent window, same as superseded reads, and receive `USELESS_NOTICE` instead of the token-count placeholder.
- **Summary serialization**: `serializeConversation` (agent) drops the whole tool call/result pair from summarizer input — the source region is discarded after summarization anyway, so the exclusion costs no cache.

The flag never reaches provider wire formats, and flagged pairs are never removed from history (only blanked in place), so tool-call/result pairing and provider-native history replay stay intact.

### Boundary and cut-point logic

`prepareCompaction()` builds one effective message sequence for estimation, cut-point selection, and the history-summary, turn-prefix, and retained-message regions.

1. Find the latest compaction whose summary or provider-native history is reusable by the active model.
2. Honor the latest `/clear` `reset_boundary`: a newer reset discards the previous summary, and an older reset remains the lower bound for recovering retained messages.
3. For a local summary, recover the original entries from `firstKeptEntryId` up to the previous compaction record, then append entries after that record.
4. For reusable provider-native history, start after `providerReplayThroughEntryId` when it identifies an older snapshot, without crossing the latest reset boundary. This recovers the uncovered snapshot-to-commit interval, not the original messages already covered by native replay. A trailing native compaction record does not make that interval already compacted.
5. Exclude compaction records and other non-message metadata. Pass the previous summary separately through `previousSummary`; retain message-bearing `custom_message` and `branch_summary` entries.
6. Adapt `keepRecentTokens` using the measured usage ratio, then run `findCutPoint()` and partition that same sequence into `messagesToSummarize`, `turnPrefixMessages`, and `recentMessages`.

When updating a local summary, every effective original message belongs to exactly one of those three regions: after `summary(A) + B` grows to `summary(A) + B + C`, the next preparation distributes both B and C, not just C. The new `firstKeptEntryId` refers to an original entry; preparation does not move, duplicate, or rewrite journal entries.

`findCutPoint()` keeps the oldest suffix that fits `keepRecentTokens`, judged only at valid cut points after counting every message behind them (an assistant's tool results included). The newest group is kept even when it alone overflows the budget; an older group that would push a fitting suffix over it is summarized instead.

Valid cut points include:

- message entries with roles: `user`, `assistant`, `bashExecution`, `hookMessage`, `branchSummary`, `compactionSummary`
- `custom_message` entries
- `branch_summary` entries

Hard rule: never cut at `toolResult`.

Preparation filters out pure metadata (`model_change`, `thinking_level_change`, labels, etc.) before selecting the retained-message boundary. Those records remain in the journal but are not conversation input.

### Split-turn handling

If the cut point is not at a user-turn start and an earlier turn start exists, preparation treats it as a split turn.

Turn start detection treats these as user-turn boundaries:

- `message.role === "user"`
- `message.role === "bashExecution"`
- `custom_message` entry
- `branch_summary` entry

`prepareCompaction()` partitions the sequence into three regions:

1. History before the split turn (`messagesToSummarize`)
2. The split turn's prefix (`turnPrefixMessages`)
3. The retained tail (`recentMessages`)

A configured remote endpoint serializes the first two regions for summarization; provider-native compaction sends its provider-specific representation of all three and owns retained-tail handling. The result is one stored summary (provider-generated for remote paths or extension-generated otherwise); no separate local turn-prefix summary or merged markdown wrapper is generated.

### Summary generation

By default, the built-in pi-blackhole `session_before_compact` hook returns the complete `CompactionResult`; no compaction-model call is made. Its deterministic compiler:

1. Normalizes messages and removes configured noise and thinking blocks.
2. Extracts goals, file changes, commits, outstanding context, and user preferences.
3. Builds a bounded recent transcript with stable entry references.
4. Folds observations and reflections from the session ledger.
5. Adds `recall` instructions so compacted source evidence remains recoverable.

The stored entry keeps Proto's normal `CompactionEntry` boundary and token fields. Blackhole-specific metadata is stored in `details`, including `compactor: "blackhole"` and the folded observational-memory snapshot. Existing session replay, TUI dividers, SDK events, and RPC results therefore keep the same outer contract.

pi-blackhole also adds:

- `/memory` for explicit structural compaction and an optional post-compaction follow-up.
- `/memory settings`, `/observations`, and `/recall`.

The native [`recall` tool](tools/recall.md) provides transcript search, entry expansion, file drill-down, and observation/reflection evidence lookup independently of the memory extension.

By default, configuration lives at `~/.proto/agent/pi-blackhole/pi-blackhole-config.json`; `PI_CODING_AGENT_DIR` can change the agent root. An optional project override lives at `.pi/pi-blackhole-config.json`. The default mode is deterministic compaction with observational memory enabled. Blackhole is the only summary engine; remote compaction remains the fallback method when Blackhole declines. The scheduler and recovery settings described below remain authoritative. See the [upstream configuration reference](https://github.com/k0valik/pi-blackhole/blob/270aa0912800b2b7ce64414ef4247be84106d8f8/docs/CONFIG.md) for Blackhole-specific options.

The `[User Messages]` section records every genuine user turn still live at compaction time — the folded ones *and* the retained tail. With the default minimal tail the newest request is kept in context rather than folded, so collecting only the folded window dropped exactly the request the next model was supposed to act on. The self-summary is written from the same range for the same reason, including previous self-memory so the model can add only new learning and explicit corrections.

For local/observational-memory compaction with `compaction.selfSummary` enabled (default), the **session's own model** receives the full prepared transcript in provider message form, under the session system prompt and tools. It does not delegate to `@smol`/`@tiny` or silently fall back to an observer model. The prompt asks for usable learned substance, concrete examples, cross-source synthesis, operative requirements from briefs, decision rationale, and applied-versus-verified state. Paths and recall pointers provide provenance, not a replacement for the knowledge itself. Research and style-learning sessions may need thousands of tokens; there is no 200-word limit.

Self-authored memory is **append-only below its safety threshold**, independently of the observational-memory reflector/dropper. Each committed `<self-summary>` entry is carried forward verbatim, oldest first; the next model writes only new learning, state updates, or explicit corrections. A correction identifies what it supersedes rather than rewriting the earlier entry. A local compactor's shortened, omitted, or duplicated copy of earlier self-memory is replaced by the committed entries, not trusted as the memory source.

**Provider-native compaction is exempt.** OpenAI/Responses and Anthropic native compaction own their history; Proto does not add self-memory generation, accumulation, consolidation, or separate replay messages to those results.

The output allowance for each **new entry** is 10% of pre-compaction context, bounded to 4,096–32,768 tokens and capped by the model's output limit. This is capacity, not a minimum entry length or a cap on accumulated memory; providers may include reasoning in that allowance. Empty output adds nothing. Generation remains best-effort: a failed request commits the new structural summary with the earlier self-memory intact and logs the failure. Turning `compaction.selfSummary` off stops new entries; it does not erase existing ones.

After adding a local entry, Proto token-counts the entire self-memory chain against the active model's **effective total context window**. At **30% or more**, the session model receives all self-memory entries for a dedicated consolidation, targeting at most **20%** of the window (also capped by the model's output limit). This leaves room for further append-only growth instead of reconsolidating after every small addition. Consolidation merges redundant explanations and applies corrections while preserving source-specific lessons, examples, constraints, and unresolved work; the observational-memory summary is not replaced.

A non-empty, complete consolidation must token-count **below 30%** before replacing the chain. Error, truncated/aborted response, empty output, or an oversized result aborts that compaction without committing a replacement; the existing history remains intact. The safety check also applies to an existing chain when new-entry generation is disabled. There is no hard text truncation to force the cap. Branches retain their own history; `/clear` deliberately resets it. This limits recursive erosion to deliberate safety consolidations, but cannot guarantee that model-written memories captured every original detail; recall remains available for exact source evidence.

Summary `(#N)` references and the `[User Messages]` pointers share one index space: positions among `type: "message"` session entries, counted from the session file — the same numbering `recall` resolves. A converted window position that cannot be mapped back to a session entry renders no reference at all.

One Blackhole knob is a Proto-local addition, in the same config file:

- `recallResponseMaxChars` (default `48000`, `0` disables, env `PI_BLACKHOLE_RECALL_RESPONSE_MAX_CHARS`) bounds one `recall` response: snippet lines clip at 1,000 characters around the match, expanded entries share the budget, and entries are dropped whole with a footer naming the continuation (`page:N`, `#N:text`) rather than sliced mid-entry.

Observational memory runs background Observer, Reflector, and Dropper model calls. Structural compaction itself is deterministic and model-free; memory is not. Workers resolve the shared `@smol` and `@tiny` roles first, then the active session model as a fallback; configure `modelRoles.smol`/`modelRoles.tiny` when worker calls should use inexpensive models.

When native compaction starts from an ordinary local summary, that summary is included as a context message alongside the prepared conversation. Later native passes reuse the provider payload instead of re-injecting its placeholder summary.

For speculative OpenAI native compaction, `providerReplayThroughEntryId` records the snapshot's last entry, not the later commit position. Context rebuilding and the next compaction preparation both include messages appended between those positions, followed by post-commit messages.

Advisor runtimes retain OpenAI Responses native `preserveData` for subsequent maintenance and attach its provider payload to the in-memory compaction summary for the next model request. OpenAI native replay already contains the retained tail, so advisors do not also append that tail as raw messages; local summaries and other native paths still keep recent messages separately. Advisor requests use the shared message converter, so both textual compaction summaries and native payloads reach the provider.

The previous local structured summarizer was removed; the fallback serializes the prepared conversation, treats it as untrusted data, and uses provider-native compaction or a configured remote endpoint (`compaction.remoteEndpoint`) only.

Provider-native compaction also covers Anthropic's server-side compaction beta (`compact-2026-01-12`) for model lines the catalog marks `compat.supportsServerCompaction` (Opus/Sonnet 4.6+, Fable/Mythos 5) whose requests reach the official endpoint; other Anthropic-compatible routes opt in with `remoteCompaction.enabled`. When no OpenAI lane applies and the context is at least 55k tokens, compaction re-issues the live turn's own request (system prompt, tools, history — so it reads the warm prompt cache) plus a `compact_20260112` edit with `pause_after_compaction`, using the summary prompt as `instructions` scoped to exclude the retained tail. The returned summary becomes the entry `summary` (plus the file-operation list) and `preserveData.anthropicCompaction`; later Anthropic requests replay it as a native `compaction` block while every other provider reads the summary text. A response without a summary is a native failure.

### Model-assisted transcript queries

`recall` accepts an optional `code` JavaScript function expression alongside `query`:

```json
{
  "query": "What did the user require about retries?",
  "code": "async ({query, entries}) => completion(JSON.stringify({query, evidence: entries.filter(e => e.role === 'user')}), {model: 'smol'})"
}
```

The function runs once in a fresh Bun kernel and receives `{query, scope, entries}`. Each entry includes its stable session-global `index` (`#N`), `id`, `role`, rendered `summary`, and full `message`, including tool arguments and results. The question does not lexically prefilter history. The default scope is the active lineage; `scope: "all"` includes other session branches. Snapshot loading is streamed, and the full transcript stays out of the main agent's context unless the function returns or prints it.

Use ordinary JavaScript selection/chunking plus the kernel's `completion`, `agent`, `parallel`, and `pipeline` helpers to extract evidence in small batches, recursively ask follow-up questions, or combine findings. `completion(..., {model: "tiny"})` and `"smol"` use the configured online model roles; `tiny` is not the local title-only model. Return a string or JSON-serializable result, preferably with `#N` citations. Transcript text is evidence, not trusted instructions; model answers are not a substitute for exact-source recovery.

`code` requires a nonblank query and cannot be combined with `expand`, `page`, or `mode`. `timeout` is a code-only deadline in seconds (default 120, maximum 3600), including model calls. Failed, cancelled, or timed-out code is not retried; its kernel is disposed after the call. This is full kernel execution, not a sandbox: bash must be enabled, and restricted agents must have bash permission. Ordinary recall remains available without execution permission.

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
4. Synchronizes active checklist phases from the rebuilt branch and closes provider sessions whose history was rewritten.
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

- Manual compaction aborts current agent operation first. If that abort cut a turn in flight, a committed compaction — or a no-op rejection (`Nothing to compact`, `Already compacted`) — resumes it (queued steer/follow-up first, otherwise the auto-continue prompt) unless `compaction.autoContinue` is `false`. A hook cancel or summarizer failure does not resume. A prompt parked on the compaction barrier (`prompt()`, `promptCustomMessage()`) takes the session instead of the resume; if it turns out to be a locally handled command that starts no turn, the resume is handed back. A manual compaction issued while idle never starts a turn.
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
- `compaction.methodOrder` = `["remote"]`. `remote` uses provider-native server compaction (OpenAI Responses compact, Anthropic compaction beta) or the configured remote endpoint when available. Legacy configured orders containing the removed `handoff`/`shake`/`soft` methods are filtered down to their surviving `remote` entries.
- `compaction.asyncEnabled` = `true`. When no `session_before_compact` extension handler is installed and context enters the pre-threshold band `[threshold − lead, threshold)` (lead = `clamp(threshold × 0.125, 8192, 32000)`), maintenance starts a background remote compaction off a branch snapshot, isolated from the live turn by a side session id. The built-in Blackhole handler currently disables this speculative path. When armed, the result is committed instantly when the threshold is actually crossed, hiding summarization latency; post-snapshot turns are appended after the summary unchanged. Armed results are discarded when the snapshot is no longer on the active path (including branch-changing `/tree` navigation), when a new compaction or reset boundary follows it, when a provider-native replay payload is no longer readable by the active model, or when context drifts too far.
- `compaction.reserveTokens` is unset by default. The compaction layer normally applies a `16384`-token floor and at least 15% of the context window; on small windows where that default would be impractical, budget checks use the 15% proportional reserve. An explicit configured reserve is honored.
- `compaction.keepRecentTokens` = `20000`
- `compaction.selfSummary` = `true`
- `compaction.autoContinue` = `true`
- `compaction.midTurnEnabled` = `true`
- `compaction.remoteEndpoint` = `undefined`
- `compaction.remoteStreamingV2Enabled` = `true`
- `compaction.v2RetainedMessageBudget` = `64000`
- `compaction.thresholdPercent` = `-1` and `compaction.thresholdTokens` = `-1`; a positive fixed token limit takes precedence over percentage, and both retain their explicit behavior. With neither set, the threshold is `effective window − reserve`, normally 85% utilization. Larger windows no longer trigger at a smaller fraction of their capacity. The effective window respects `extendedContext` and model overrides: a 1M-capable model limited to a 272K standard window defaults to 231,200 tokens, whereas a 1M effective window defaults to 850,000. `/extended-context on` opts into larger supported windows and any premium pricing; compaction does not enable that opt-in itself.
- `compaction.idleEnabled` = `false`
- `compaction.idleThresholdTokens` = `200000`
- `compaction.idleTimeoutSeconds` = `300`
- `compaction.supersedeReads` = `true`
- `compaction.dropUseless` = `true`
- `branchSummary.enabled` = `false`
- `branchSummary.reserveTokens` = `16384`

These values are consumed at runtime by `AgentSession`, `SessionMaintenance`, and the compaction/branch-summarization modules.
