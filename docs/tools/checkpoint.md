# checkpoint

> Mark the current top-level conversation state so later `rewind` can collapse exploratory context into a report.

## Source
- Entry: `packages/coding-agent/src/tools/checkpoint.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/checkpoint.md`
- Key collaborators:
  - `packages/coding-agent/src/session/agent-session.ts` — captures the active checkpoint after tool success.
  - `packages/coding-agent/src/session/session-manager.ts` — persists the normal session entry stream; not the active checkpoint marker.
  - `packages/coding-agent/src/tools/index.ts` — registers the tool and gates it behind `checkpoint.enabled`.
  - `packages/coding-agent/src/config/settings-schema.ts` — defines the disabled-by-default feature flag.

## Registration / Visibility
- Tool metadata: `loadMode = "discoverable"`. Execution is single-shot; the tool does not stream progress updates.
- Registration requires `checkpoint.enabled = true` (default `false`).
- Top-level sessions receive the tool when enabled. Subagents do not discover it by default, but may receive it through an explicit `tools:`/requested-tools list.
- `checkpoint` and `rewind` are a safety pair: when either name is explicitly requested while the feature is enabled, registration automatically includes the other.
- In an ordinary `tools.xdev` session, discoverable built-ins may be presented as `xd://checkpoint`; an explicitly requested tool remains top-level.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `goal` | `string` | Yes | Investigation goal. Required by the schema and echoed unchanged in the tool result; the implementation does not trim it or reject an empty string. |

## Outputs
The tool returns a single text result plus structured details:

- text body:
  - `Checkpoint created.`
  - `Goal: <goal>`
  - `Run your investigation, then call rewind with a concise report.`
- `details`:
  - `goal: string`
  - `startedAt: string` — ISO timestamp created inside `CheckpointTool.execute()`

No checkpoint ID, artifact URI, job handle, file path, or restore token is returned.

## Flow
1. Tool registration in `packages/coding-agent/src/tools/index.ts` enforces `checkpoint.enabled` and the top-level/explicit-subagent visibility rules. `CheckpointTool.createIf()` itself always constructs the tool.
2. `CheckpointTool.execute()` rejects nested checkpoints with `ToolError("Checkpoint already active.")` when `session.getCheckpointState?.()` is already set.
3. It creates `startedAt = new Date().toISOString()` and returns a normal `toolResult()` payload. The tool method itself does not mutate checkpoint state.
4. On the later successful checkpoint tool-result event, `AgentSession` captures three runtime fields:
   - `checkpointMessageCount` — current `agent.state.messages.length`, after the checkpoint tool result has already been appended
   - `checkpointEntryId` — `sessionManager.getEntries().at(-1)?.id ?? null`, i.e. the last persisted session entry ID at checkpoint time
   - `startedAt` — copied from tool details or regenerated
5. `AgentSession` stores that object in `#checkpointState`, clears `#pendingRewindReport`, and clears the prior `#lastCompletedRewind`.
6. On resume, session switch, or tree navigation, `#rehydrateCheckpointRewindState()` scans the current persisted branch. A most-recent successful checkpoint without a later retained rewind report reconstructs the active checkpoint boundary and guard.

## Side Effects
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Sets `AgentSession.#checkpointState` in memory.
  - Records the checkpoint boundary as a message count plus the persisted checkpoint tool-result entry ID.
  - The ordinary successful tool-result entry is enough to reconstruct an unfinished checkpoint after resume; there is no separate checkpoint-marker entry.
  - Enables the later settle guard: if a checkpoint is active and no rewind report is pending, `#enforceRewindBeforeYield()` injects a developer-role warning and schedules another turn. The guard is budgeted: at most `REWIND_REMINDER_CAP = 3` reminders per user turn per checkpoint. A model that ignores all three ends the turn with the checkpoint still open instead of being continued forever.
- User-visible prompts / interactive UI
  - The tool result tells the model to call `rewind` after the investigation.
  - If the agent tries to `yield` first, `AgentSession` injects:

```text
<system-warning>
You are in an active checkpoint. You MUST call rewind with your investigation findings before yielding. Do NOT yield without completing the checkpoint. (Reminder 1 of 3.)
</system-warning>
```

  - The third reminder adds a final line: `This is the final reminder: if you do not call rewind now, the turn ends with the checkpoint still open and your findings unreported.`
  - When the budget is spent, the user gets a `warning` notice from source `checkpoint` (stderr in headless text mode, a transcript notice in the TUI) saying the checkpoint was left open and is still active.

## Limits & Caps
- Availability is gated by `checkpoint.enabled`, default `false`.
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
