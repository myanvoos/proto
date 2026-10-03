# checkpoint

> Mark the current conversation state so later `rewind` can collapse exploratory context into a report.

## Source
- Entry: `packages/coding-agent/src/tools/checkpoint.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/checkpoint.md`
- Key collaborators:
  - `packages/coding-agent/src/session/agent-session.ts` — captures the active checkpoint after tool success.
  - `packages/coding-agent/src/session/session-manager.ts` — persists normal session entries and exposes the branch used to anchor the checkpoint; there is no dedicated active-marker entry.
  - `packages/coding-agent/src/tools/index.ts` — registers the tool and gates it behind `checkpoint.enabled`.
  - `packages/coding-agent/src/config/settings-schema.ts` — defines the enabled-by-default feature flag.

## Registration / Visibility
- Tool metadata: `loadMode = "essential"`. Execution is single-shot; the tool does not stream progress updates.
- Registration requires `checkpoint.enabled = true` (default `true`).
- Top-level sessions expose the tool when enabled. Subagents do not discover it by default, but may receive it through an explicit `tools:`/requested-tools list.
- `checkpoint` and `rewind` are a safety pair: when either name is explicitly requested while the feature is enabled, registration automatically includes the other.
- This built-in loads as a native tool on every request (essential); it is not mounted under `protolens://`.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `goal` | `string` | Yes | Investigation goal. Required by the schema and echoed unchanged in the tool result; the implementation does not trim it or reject an empty string. |

## Outputs
The tool returns a single text result plus structured details:

- text body:
  - `Checkpoint: <goal>`
  - `Finish exploration and formulate findings.`
- `details`:
  - `goal: string`
  - `startedAt: string` — ISO timestamp created inside `CheckpointTool.execute()`

No checkpoint ID, artifact URI, job handle, file path, or restore token is returned.

## Flow
1. Tool registration in `packages/coding-agent/src/tools/index.ts` enforces `checkpoint.enabled` and the top-level/explicit-subagent visibility rules. `CheckpointTool.createIf()` itself always constructs the tool.
2. `CheckpointTool.execute()` rejects nested checkpoints with `ToolError("Checkpoint already active.")` when `session.getCheckpointState?.()` is already set.
3. It creates `startedAt = new Date().toISOString()` and returns a normal `toolResult()` payload. The tool method itself does not mutate checkpoint state.
4. On a successful checkpoint tool-result event, `AgentSession` invokes `#checkpointActiveReminderFor()`, which creates a hidden `checkpoint-active-reminder` custom message from `packages/coding-agent/src/prompts/system/checkpoint-active-notice.md`; the surrounding handler initializes `#checkpointState`, clears `#pendingRewindReport` and `#lastCompletedRewind`, and steers that reminder:
   - `checkpointMessageCount` — current `agent.state.messages.length`
   - `checkpointEntryId` — initially `null`; after persistence, `AgentSession` scans `sessionManager.getBranchForStats()` from newest to oldest for the entry whose `sessionMessagePersistenceKey` matches the checkpoint result and stores its ID (or leaves `null` if none matches)
   - `startedAt` — copied from tool details or regenerated
5. On resume, session switch, or tree navigation, `#rehydrateCheckpointRewindState()` scans the current persisted branch. A most-recent successful checkpoint without a later retained rewind report reconstructs the active checkpoint boundary and guard.

## Side Effects
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Sets `AgentSession.#checkpointState` in memory.
  - Records the checkpoint boundary as a message count plus the persisted checkpoint tool-result entry ID.
  - The ordinary successful tool-result entry is enough to reconstruct an unfinished checkpoint after resume; there is no separate checkpoint-marker entry.
  - Enables the later settle guard: if a checkpoint is active and no rewind report is pending, `#enforceRewindBeforeYield()` injects a developer-role warning and schedules another turn. The guard is budgeted: at most `REWIND_REMINDER_CAP = 3` reminders per user turn per checkpoint. A model that ignores all three ends the turn with the checkpoint still open instead of being continued forever.
- User-visible prompts / interactive UI
  - The direct tool result is `Checkpoint: <goal>` followed by `Finish exploration and formulate findings.`
  - After success, `AgentSession` steers the hidden `checkpoint-active-reminder` prompt, which requires `rewind` with findings and before yielding.
  - When a normal non-error stop reaches the settle guard without a pending rewind report (including a first attempt to `yield`), `AgentSession` injects:

```text
<system-warning>
You are in an active checkpoint. You MUST call rewind with your investigation findings before yielding. Do NOT yield without completing the checkpoint. (Reminder 1 of 3.)
</system-warning>
```

  - The third reminder adds a final line: `This is the final reminder: if you do not call rewind now, the turn ends with the checkpoint still open and your findings unreported.`
  - When the budget is spent, the user gets a `warning` notice from source `checkpoint` (stderr in headless text mode, a transcript notice in the TUI) saying the checkpoint was left open and is still active.

## Limits & Caps
- Availability is gated by `checkpoint.enabled`, default `true`.
- Only one active checkpoint is allowed per session or subagent.
- The yield guard is capped at 3 reminders per user turn per checkpoint (`REWIND_REMINDER_CAP` in `packages/coding-agent/src/session/agent-session.ts`). The budget is re-armed by a new user-initiated prompt, never by an auto-continue, so a checkpoint the model refuses to close costs at most three extra requests per turn instead of an unbounded provider storm.
- Subagents require an explicit requested-tools entry; requesting either checkpoint tool auto-includes its sister.
- Checkpoint state is not persisted as a dedicated entry. It is reconstructed from the successful checkpoint tool-result entry on the active branch, including after process resume.
- Session persistence applies to the ordinary checkpoint tool-call/result messages. Global session persistence truncation is `MAX_PERSIST_CHARS = 500_000` in `packages/coding-agent/src/session/session-persistence.ts`.

## Errors
- `ToolError("Checkpoint already active.")` — thrown when a prior checkpoint has not been rewound or cleared.
- The tool body has no local `try/catch`; unexpected exceptions propagate.

## Notes
- The summary string is `Mark a context checkpoint that rewind collapses into a short report`: the implementation never calls git and does not snapshot filesystem state.
- Captured state is conversation/session metadata only:
  - in-memory message count
  - persisted checkpoint tool-result entry ID in the session tree
  - timestamp
- Not captured:
  - working tree contents or staged changes
  - artifacts or blob-store contents
  - SQLite prompt-history rows from `packages/coding-agent/src/session/history-storage.ts`
  - auth or agent records from `packages/coding-agent/src/session/agent-storage.ts`
