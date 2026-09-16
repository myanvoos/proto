# TTSR Injection Lifecycle

This document covers the current Time Traveling Stream Rules (TTSR) runtime path from rule discovery to stream interruption, retry injection, extension notifications, and session-state handling.

## Implementation files

- [`../src/sdk.ts`](../packages/coding-agent/src/sdk.ts)
- [`../src/export/ttsr.ts`](../packages/coding-agent/src/export/ttsr.ts)
- [`../src/export/ttsr-matcher.ts`](../packages/coding-agent/src/export/ttsr-matcher.ts)
- [`../src/export/ttsr-paths.ts`](../packages/coding-agent/src/export/ttsr-paths.ts)
- [`../src/export/ttsr-regions.ts`](../packages/coding-agent/src/export/ttsr-regions.ts)
- [`../src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`../src/session/ttsr-coordinator.ts`](../packages/coding-agent/src/session/ttsr-coordinator.ts)
- [`../src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)
- [`../src/prompts/system/ttsr-interrupt.md`](../packages/coding-agent/src/prompts/system/ttsr-interrupt.md)
- [`../src/prompts/system/ttsr-tool-reminder.md`](../packages/coding-agent/src/prompts/system/ttsr-tool-reminder.md)
- [`../src/tools/bash.ts`](../packages/coding-agent/src/tools/bash.ts)
- [`../src/tools/bash-file-write.ts`](../packages/coding-agent/src/tools/bash-file-write.ts)
- [`../src/tools/bash-kernel-cell.ts`](../packages/coding-agent/src/tools/bash-kernel-cell.ts)
- [`../src/capability/index.ts`](../packages/coding-agent/src/capability/index.ts)
- [`../src/extensibility/extensions/types.ts`](../packages/coding-agent/src/extensibility/extensions/types.ts)
- [`../src/extensibility/hooks/types.ts`](../packages/coding-agent/src/extensibility/hooks/types.ts)
- [`../src/extensibility/custom-tools/types.ts`](../packages/coding-agent/src/extensibility/custom-tools/types.ts)
- [`../src/modes/controllers/event-controller.ts`](../packages/coding-agent/src/modes/controllers/event-controller.ts)

## 1. Discovery feed and rule registration

At session creation, `createAgentSession()` loads discovered rules, constructs a `TtsrManager`, and buckets rules through `bucketRules(...)`:

```ts
const ttsrSettings = settings.getGroup("ttsr");
const ttsrManager = new TtsrManager(ttsrSettings);
const rulesResult = await loadCapability<Rule>(ruleCapability.id, { cwd });
const { rulebookRules, alwaysApplyRules } = bucketRules(
  rulesResult.items,
  ttsrManager,
  {
    builtinRules: ttsrSettings.builtinRules,
    disabledRules: ttsrSettings.disabledRules,
  },
);
```

`bucketRules(...)` drops names listed in `ttsr.disabledRules`, drops embedded `builtin-defaults` rules when `ttsr.builtinRules === false`, registers accepted TTSR rules, and then routes the remaining rules to always-apply/rulebook buckets.

### Pre-registration dedupe behavior

`loadCapability("rules")` deduplicates by `rule.name` with first-wins semantics (higher provider priority first). Shadowed duplicates are removed before TTSR registration.

### `TtsrManager.addRule()` behavior

Registration is skipped when:

- TTSR is disabled (`ttsr.enabled === false`)
- `rule.match`, `rule.condition`, and `rule.astCondition` are all absent
- the selected program fails to compile
- a rule with the same `rule.name` was already registered in this manager
- the parsed rule scope excludes all monitored streams

`addRule()` selects `compileMatchProgram(rule.match, rule.name)` when `match` is present; otherwise it selects `compileLegacyProgram(rule.condition, rule.astCondition)`. Both paths log one warning per compile error with the rule name. Structured `match` compilation is strict: any compile error rejects the whole program, so the rule is not registered as TTSR and falls through to the other rule buckets. Legacy compilation is tolerant of invalid regex entries: they are logged and skipped, and the rule still registers when at least one valid branch remains and the resulting legacy program compiles; if no branch remains or compilation otherwise fails, it falls through. AST parse/match failures and judge failures are logged when matching is attempted and count as no match. An unconfigured or unavailable judge settles an `llm:` leaf as no match. If a TTSR rule defines `globs`, those globs are compiled as a global file-path gate for matching.

With no explicit `scope`, a rule monitors assistant text and all tool arguments, but not thinking. Explicit scope tokens can enable `text`, `thinking`, any tool (`tool`/`toolcall`), a named tool, and optional per-tool path globs. A successfully registered rule retains its compiled `MatchProgram`; `getEntries()` exposes `{ rule, program }`, including the program's compact `description`, `needsAst`, `needsJudge`, and literal prefilter metadata.

### Async leaves and source snapshots

AST leaves only resolve on tool-argument streams for tools that expose a reconstructed `matcherDigest` or per-file `matcherEntries`, and only when a candidate path supplies a usable file extension for language inference. The coordinator resolves these surfaces generically from the active tool.

A snapshot is the source-bearing payload supplied by that matcher surface, not the whole command or pre-existing target file. For `bash`, `matcherEntries` exposes each embedded interpreter cell as an indexed `cell.<n>.py` or `cell.<n>.js` entry whose digest is the cell code, and also exposes recognized `cat`/`tee` heredoc file writes under the written path. Supported file-write entries include the clobber/append redirect forms (`>`, `>>`, `>|`) and `tee` append forms; their digest is the heredoc body. Each entry's extension selects the AST grammar and its real path drives per-file matching. Pre-existing target content is invisible unless the call repeats it. Matching is in-memory through native `astMatch`; structured `ast` leaves default to Smart strictness unless their `strictness` says otherwise.

`checkAsyncSnapshot()` is the async resolution API for both `ast:` and `llm:` leaves. Resolution repeats while a stage settles something new, since a resolved leaf can expose the next one — the `then:`/`else:` branch of an `if` is only reached once its guard has a verdict. An `llm:` leaf asks its yes/no question through the configured judge, trying its model-role chain in order; when no judge or available model can answer, it settles as no match. Judge leaves resolve only on settled buffers: complete tool-call arguments immediately before the tool executes, or finished assistant prose when the message ends. They never run per streaming delta.

A judge belongs to the turn that asked for it. The coordinator opens an abort scope per turn and passes its signal down through the match context into `JudgeFn`, so ending the turn — including a user abort — cancels any in-flight model call. Without that, `beforeToolCall` would hold the agent loop open until the judge's own 20 s timeout expired, and the verdict would arrive for a turn nobody is waiting on.

### Session history for `did:` conditions

`did:` leaves read the session's earlier tool calls, supplied by the coordinator on every match context. History is derived from the live transcript (`agent.state.messages`) rather than accumulated in a side ledger. Each entry keeps the tool name, the paths the call named — resolved through the same `matcherPaths`/argument extraction the current call uses — and the arguments in JSON form, capped so one huge call cannot dominate.

The derived list is cached, but only against a fingerprint of the transcript it came from: the same array object, grown at the end, still ending in the same message, and excluding the same in-flight call. Appending a message extends the list; **any** other edit fails the fingerprint and rebuilds it. That keeps the streaming path flat — a `did:` check costs the same at 10,000 prior calls as at ten — without letting a rewritten transcript answer from stale history. Path extraction and argument serialization are memoized on the `toolCall` block itself, and every reference into the transcript is weak, so a compacted window is freed even if no `did:` leaf runs again to notice.

Deriving from the transcript rather than accumulating is what keeps `did:` honest when the context is rewritten, which happens constantly:

| rewrite | what `did:` sees |
|---|---|
| **Compaction** replaces the window with a summary plus a tail | calls that were summarized away stop counting; calls kept in the tail still count |
| **Pruning / superseded reads** rewrite a `toolResult`'s content, leaving the `toolCall` block | still counts — the agent still sees that it made the call, only the bytes are gone |
| **TTSR's own `discard` rewind** truncates back past the offending assistant message | the discarded turn's calls un-happen, which is the point of the rewind |
| **Resuming a saved session** rebuilds the transcript from disk | the same answer a live session would give for that transcript |

The direction matters. When compaction drops the turn where the agent read a skill, the agent no longer has what it read, so `not: { did: read skill://viz }` starts matching again and the guidance is re-injected — precisely when it is needed. A ledger that only grew would report the read still counted and stay silent exactly then, and would answer differently from a resumed session with an identical transcript.

The call being matched is excluded from its own history, since it has not run yet. Hosts that run the compiled conditions without a session — `proto ttsr test`, `proto ttsr scan` — supply no history at all, so every `did:` leaf there reports that the session did nothing.

### Setting gating

`TtsrSettings.enabled` gates the manager: when `ttsr.enabled === false`, `addRule()` refuses registration and `checkDelta()`/`checkSnapshot()`/`checkAsyncSnapshot()`/`hasRules()`/`hasAsyncRules()` all return empty/false, so no matching runs.

Manager defaults when a setting is omitted:

| Setting         | Default                                          |
| --------------- | ------------------------------------------------ |
| `enabled`       | `true`                                           |
| `contextMode`   | `"discard"`                                      |
| `interruptMode` | `"always"`                                       |
| `repeatMode`    | `"once"`                                         |
| `repeatGap`     | `10` completed turns                             |
| `builtinRules`  | `true` (consumed by `bucketRules`, not matching) |
| `disabledRules` | `[]` (consumed by `bucketRules`, not matching)   |

## 2. Streaming monitor lifecycle

TTSR detection is delegated by `AgentSession.#handleAgentEvent` to the session-owned `TtsrCoordinator`.

### Turn start

On `turn_start`, the stream buffer is reset:

- `ttsrManager.resetBuffer()`

### During stream (`message_update`)

When assistant updates arrive and rules exist:

- monitor `text_delta`, `thinking_delta`, and `toolcall_delta`
- isolate buffers by source or tool-call stream key
- for a tool with per-file `matcherEntries`, treat each `{ path, digest }` as its own source snapshot, call synchronous `checkSnapshot` for that digest, and retain the entry path for language, lexical, and path matching; otherwise, use one `matcherDigest` snapshot when available, falling back to appending the raw delta via `checkDelta`
- when async rules exist on a tool stream, run asynchronous `checkAsyncSnapshot` against the same reconstructed per-file or single snapshot; during streaming this pass resolves AST leaves only, and identical consecutive AST snapshots for a stream key are skipped

`checkDelta()` and `checkSnapshot()` are synchronous and evaluate every registered program, including programs with AST or judge leaves. An unresolved async leaf evaluates to `unknown` and cannot decide a match; synchronous streaming checks therefore cannot read either leaf as satisfied or absent. `checkAsyncSnapshot()` is asynchronous and applies the same scope/path/repeat gates. For a streaming tool update it requires a tool source and inferred language, prepares AST leaves, and evaluates only candidates whose program has `needsAst`; judge leaves remain deferred. On settled buffers it also resolves `llm:` leaves: complete tool-call arguments immediately before execution and finished assistant prose when the message ends. Judges are never run per streaming delta. `deriveLang()` chooses the first candidate file path with an extension; that language drives AST grammar selection and `in:` lexical classification. Both paths return all matching rules with `MatchEvidence`; the results enter the same trigger-decision handler.

For `bash`, `matcherEntries` is the source-aware boundary: embedded Python/JS interpreter cells remain synthetic `cell.<n>.py`/`cell.<n>.js` snapshots, while recognized heredoc bodies written by `cat` or `tee` become snapshots under their actual normalized file paths. The supported `cat` redirects include `>`, `>>`, and `>|`; `tee` supports its append options. Entries are processed in command source order. A bash command with no recognized source entry uses the ordinary digest/delta fallback, so the raw shell command is not substituted for a file-write snapshot when an entry is available.

## 3. Trigger decision and immediate abort path

Each rule's `interruptMode` overrides the global setting when present:

- `always` interrupts any matching source
- `prose-only` interrupts text/thinking matches only
- `tool-only` interrupts tool matches only
- `never` never interrupts

If no matched rule interrupts, handling follows the source-specific deferred paths below.

When one or more rules match and at least one matched rule allows interruption:

1. Matched rules are deduplicated into the coordinator's pending injections.
2. The abort-pending flag is set and a TTSR resume gate is created.
3. `agent.abort()` is called immediately. For a tool match, the abort reason is scoped to that tool-call id so sibling calls receive the separate `TTSR interrupt on another tool call` reason.
4. `ttsr_triggered` is emitted asynchronously (fire-and-forget).
5. Retry work is scheduled through the post-prompt task scheduler with a 50ms delay, tagged with the current prompt generation and a retry token.

Abort is not blocked on extension callbacks.

## 4. Retry scheduling, context mode, and reminder injection

After the 50ms timeout, the scheduled task first verifies that its retry token, prompt generation, abort-pending state, and target assistant message are still current. If any check fails, it clears pending TTSR state and resolves the resume gate without retrying. Otherwise it:

1. clears the abort-pending flag and per-tool reminder buckets
2. reads `ttsrManager.getSettings().contextMode`
3. if `contextMode === "discard"`, drops the targeted partial assistant output with `agent.replaceMessages(...slice(0, targetAssistantIndex))`
4. builds injection content from pending rules using `ttsr-interrupt.md`
5. appends a hidden runtime custom message and persists a matching `custom_message` entry with `customType: "ttsr-injection"` and `details.rules`
6. marks/persists those rule names through a `ttsr_injection` entry and calls `agent.continue()` to retry generation

Template payload is:

```xml
<system-interrupt reason="rule_violation" rule="{{name}}" path="{{path}}">
...
{{content}}
{{#if evidence}}

<matched>
{{evidence}}
</matched>
{{/if}}
</system-interrupt>
```

When the match produced evidence, the optional `<matched>` block contains up to three distinct matched lines, rendered as `L<line>: <trimmed line text>` (each line is capped at 200 characters). It is omitted when there are no snippets. Pending injections are cleared after content generation.

### `contextMode` behavior on partial output

- `discard`: partial/aborted assistant message is removed before retry.
- `keep`: partial assistant output remains in conversation state; reminder is appended after it.

### Non-interrupting matches

Non-interrupting matches split by `matchContext.source`:

- **`source === "tool"` (tool-source match).** The rule is bucketed into `TtsrCoordinator.#perToolInjections`, keyed by the matched tool call's `id`, and marked injected in memory immediately. There is **no** deferred follow-up turn and the stream is not aborted. When the tool actually produces a result, the `afterToolCall` hook prepends a rendered `ttsr-tool-reminder.md` block to `ctx.result.content` (a single `text` block inserted ahead of the tool's own content) and persists a `ttsr_injection` entry with the consumed rule names. The template payload is:

  ```xml
  <system-reminder reason="rule_violation" rule="{{name}}" path="{{path}}">
  ...
  {{content}}
  {{#if evidence}}

  <matched>
  {{evidence}}
  </matched>
  {{/if}}
  </system-reminder>
  ```

- **`source === "text"` / `"thinking"` (prose-source match).** The rule is queued in the pending injections. After a successful non-error, non-aborted assistant message, `TtsrCoordinator` queues the hidden `ttsr-injection` custom message with `agent.followUp()` and schedules continuation after 1ms. These deferred non-interrupting prose matches do not emit `ttsr_triggered`; that event is emitted for actual interrupt paths and for non-interrupting per-tool reminders.

Within a matching batch, each rule is attached to exactly one sibling tool call: if multiple sibling calls would satisfy the same rule, the first claimed bucket wins. Multiple distinct rules can still fold onto one tool call.

#### Implications for tool authors and transcript readers

- The tool's own `toolResult` content is preserved verbatim; the reminder is **prepended** as an additional leading text block. Renderers that assume `content[0]` is the tool's primary output must scan past any block whose text begins with `<system-reminder reason="rule_violation"` (or filter on the wrapper tag) to find the real payload.
- The reminder is in-band on the tool result, not a separate `custom_message`/`ttsr-injection` entry. Transcript readers looking for non-interrupting TTSR activity on tool-source rules MUST inspect tool results (and the persisted `ttsr_injection` entry list), not just synthetic injection entries.
- A single tool result may carry reminders for several rules concatenated with a blank line between rendered templates.
- If the assistant message ends with `stopReason === "aborted"` or `"error"` before the matched tools run, pending per-tool buckets are cleared and no `ttsr_injection` entry is persisted. The match-time in-memory injection record is **not** rolled back: in `once` mode it stays suppressed until session reload; in `after-gap` mode it becomes eligible after the configured number of completed turns. Because the undelivered match was not persisted, reload also makes it eligible again.

## 5. Repeat policy and gap logic

`TtsrManager` tracks `#messageCount` and per-rule `lastInjectedAt`.

### `repeatMode: "once"`

A rule can trigger only once after it has an injection record.

### `repeatMode: "after-gap"`

A rule can re-trigger only when:

- `messageCount - lastInjectedAt >= repeatGap`

`messageCount` increments on `turn_end`, so gap is measured in completed turns, not stream chunks.

## 6. Event emission and extension/hook surfaces

### Session event

`AgentSessionEvent` includes:

```ts
{ type: "ttsr_triggered"; rules: Rule[] }
```

### Extension runner

`#emitSessionEvent()` routes the event to:

- extension listeners (`ExtensionRunner.emit({ type: "ttsr_triggered", rules })`)
- local session subscribers

### Hook and custom-tool typing

- extension API exposes `on("ttsr_triggered", ...)`
- hook API exposes `on("ttsr_triggered", ...)`
- custom tools receive `onSession({ reason: "ttsr_triggered", rules })`

### Interactive-mode rendering difference

Interactive mode uses `session.isTtsrAbortPending` to suppress showing the aborted assistant stop reason as a visible failure during TTSR interruption, and renders a `TtsrNotificationComponent` when the event arrives.

## 7. Persistence and resume state (current implementation)

`SessionManager` persists injected-rule state:

- entry type: `ttsr_injection`
- append API: `appendTtsrInjection(ruleNames)`
- query API: `getInjectedTtsrRules()`
- context reconstruction includes `SessionContext.injectedTtsrRules`

`TtsrManager` supports restoration via `restoreInjected(ruleNames)`.

Current runtime wiring:

- interrupted injections append a hidden `custom_message` with `customType: "ttsr-injection"` and append a `ttsr_injection` entry
- deferred non-interrupting prose-source injections are marked/persisted when their queued custom message reaches `message_end`
- non-interrupting tool-source matches are marked in memory when bucketed, then persisted from `afterToolCall` only when the matched tool's result is produced
- `createAgentSession()` restores `existingSession.injectedTtsrRules` into the manager

Injected-rule suppression is therefore restored from the current branch path. Persistence stores names, not the original turn age: `restoreInjected()` records each restored rule at message count zero. In `repeatMode: "after-gap"`, a resumed rule becomes eligible after `repeatGap` newly completed turns, regardless of how many turns elapsed before reload.

## 8. Race boundaries and ordering guarantees

### Abort vs retry callback

- abort is synchronous from TTSR handler perspective (`agent.abort()` called immediately)
- retry is deferred by timer (`50ms`)
- extension notification is asynchronous and intentionally not awaited before abort/retry scheduling

### Multiple matches in same stream window

`checkDelta()` returns all currently matching eligible rules for that scoped buffer. Pending injections are deduplicated by rule name before injection.

### Between abort and continue

During the timer window, state can change. The retry is guarded by retry token, prompt generation, abort state, and target-message identity; a stale task clears pending state and resolves its gate. `agent.continue()` failures are caught and also resolve the gate.

## 9. Edge cases summary

- Invalid `match` expression: logged with the rule name; strict compilation rejects the rule, so it is not registered as TTSR and can fall through to another bucket. Invalid legacy `condition` regex entries are logged and skipped; other valid legacy entries can still register the rule when the resulting legacy program compiles.
- Duplicate rule names at capability layer: lower-priority duplicates are shadowed before registration.
- Duplicate names at manager layer: second registration is ignored.
- `ttsr.disabledRules`: listed names are dropped before TTSR registration and are not surfaced through always-apply/rulebook buckets.
- `ttsr.builtinRules: false`: embedded `builtin-defaults` rules are dropped before TTSR registration; user/project rules still load.
- `globs` on a TTSR rule require at least one candidate file path matching either its normalized path or basename.
- Default scope monitors text and tools, not thinking.
- `contextMode: "keep"`: partial violating output can remain in context before reminder retry.
- `interruptMode: "never"`: prose-source matches queue a deferred hidden injection after a successful assistant message; tool-source matches fold an in-band `<system-reminder>` into the matched tool call's `toolResult` content via the `afterToolCall` hook (no mid-stream abort, no separate follow-up turn).
- Tool-source non-interrupting buckets are cleared when the parent assistant message ends with `stopReason === "aborted"` or `"error"`. Their match-time in-memory suppression remains until repeat policy permits another trigger (or reload discards the unpersisted record).
- Repeat-after-gap depends on turn count increments at `turn_end`; after reload, restored injection ages restart at zero.
