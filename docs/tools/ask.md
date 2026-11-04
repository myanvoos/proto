# ask

> Prompts the interactive user for one or more option-picker or free-form answers.

## Source
- Entry: `packages/coding-agent/src/tools/ask.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/ask.md`
- Key collaborators:
  - `packages/coding-agent/src/config/settings-schema.ts` — `ask.timeout` / `ask.notify` defaults
  - `packages/coding-agent/src/modes/theme/theme.ts` — checkbox and radio glyphs for TUI rendering
  - `packages/coding-agent/src/tui/index.ts` — status-line rendering

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `questions` | `Question[]` | Yes | One or more questions; empty arrays are rejected. |
| `timeout` | `number` | No | Non-negative whole-form deadline in seconds. Overrides `ask.timeout`; `0` disables. Omitted uses settings (default `0`). |

### `Question`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `string` | Yes | Stable identifier used in multi-question results. |
| `question` | `string` | Yes | Prompt text shown to the user. |
| `options` | `{ label: string; description?: string; preview?: string }[]` | Yes | Picker choices. `description` is explanatory text; `preview` supplies optional rich preview content to a rich ask dialog. No minimum/maximum is enforced. The runtime adds its own controls; callers must not use reserved labels `Other (type your own)`, `Chat about this`, or `Next →`. |
| `header` | `string` | No | Optional short display chip used by rich ask dialogs. Ignored by the selector fallback. |
| `multi` | `boolean` | No | Enables multi-select mode. Default: `false`. |
| `recommended` | `number` | No | Zero-based suggested option index; not approval. Invalid indexes are ignored for selection; the fallback selector marks a valid single-select option with ` (Recommended)`. |

## Outputs
- Single-shot result.
- `content[0].text` is plain text:
  - single question: selected/custom answer plus an optional `User added note: ...`
  - multiple questions: `User answers:` followed by one line per `id`
  - rich-dialog chat redirect: `User chose to chat about this instead of answering...`
- `details`:
  - single question: `{ question, options, multi, selectedOptions, customInput?, note?, timedOut? }`
  - multiple questions: `{ results: QuestionResult[] }`; each item includes `id`, `question`, `options`, `multi`, `selectedOptions`, and optional `customInput`, `note`, and `timedOut`
  - chat redirect: `{ chatRedirect: true, questions: string[] }`
- Expiry returns `details.timedOut: true`, explicit no-response text, and only confirmed answers. Unanswered result items have `selectedOptions: []` and `timedOut: true`; drafts and suggestions are never answers.
- Cancellation and headless cases throw instead of returning a structured success result. The tool does not stream updates.

## Flow
1. `AskTool.createIf()` only registers the discoverable tool when the session can prompt the user (`canPromptUser`, falling back to `hasUI`); headless sessions never get it.
2. `execute()` also requires `context.hasUI` and `context.ui`; if missing it aborts the context and throws `ToolAbortError("Ask tool requires interactive mode")`.
3. It resolves the per-call `timeout` before `ask.timeout` and starts one deadline for the entire outstanding form (`0` disables).
4. If `ask.notify` is not `off`, it sends a terminal notification: `Waiting for input`.
5. When the UI supplies `askDialog`, the tool opens one rich multi-question form. Rich options receive `header`, `description`, and `preview`; results may contain an answer note or choose the dialog's `Chat about this` redirect.
6. Otherwise it uses the selector/editor fallback for each question:
   - single-select list plus `Other (type your own)`
   - multi-select checkbox loop plus `Done selecting` when applicable and `Other (type your own)`
7. In fallback multi-question mode, left/right arrow handlers move backward/forward and preserve prior answers. The final question auto-advances on selection.
8. Expiry closes the outstanding picker/editor/form and returns control without cancelling the agent turn. Rich dialogs return `kind: "timeout"` with confirmed answers and explicit unanswered items. There is no automatic option selection; moving the cursor, toggling an unconfirmed multi-select draft, or leaving an editor open does not approve anything.
9. If the user cancels without timeout, `execute()` aborts the tool context and throws `ToolAbortError("Ask tool was cancelled by the user")`.
10. On success it formats human-readable text plus structured `details`; the TUI renderer uses `details` for rich result display.

## Modes / Variants
- Single question: returns flattened `details` fields.
- Multiple questions: returns `details.results[]`; the fallback permits arrow-key back/forward navigation, while a rich UI presents the complete form.
- Single-select: one option or custom input.
- Multi-select: toggled choices or custom input. In the fallback, `Done selecting` appears only when forward navigation is not active and at least one choice is selected.
- Rich ask dialog: supports per-question headers, option previews, answer notes, and a `Chat about this` redirect.
- Selector/editor fallback: supports labels/descriptions but not headers, previews, notes, or chat redirect.

## Side Effects
- User-visible prompts / interactive UI
  - Uses `context.ui.askDialog(...)` when the UI offers the rich form API; otherwise uses the selector/editor fallback.
  - Opens a selection dialog via `context.ui.select(...)`.
  - Opens a text editor dialog via `context.ui.editor(...)` for `Other`.
  - Sends a terminal notification unless `ask.notify=off`.
- Session state
  - Calls `context.abort()` on headless use or user cancellation.
- Background work / cancellation
  - Wraps UI waits in `untilAborted(...)` so abort signals interrupt pending dialogs.

## Limits & Caps
- `questions` must contain at least 1 item. Unknown fields are rejected because `AskTool.strict=true`.
- `ask.timeout` defaults to `0` seconds (disabled); configured non-zero values are seconds.
- Prompt guidance says provide 2–5 options, but code only requires the `options` array field and does not enforce a minimum or maximum length.
- Option labels must not equal the reserved runtime labels `Other (type your own)`, `Chat about this`, or `Next →`.
- The deadline covers all questions, custom/note editors, review, and navigation. Input never refreshes it. Confirmed earlier answers survive expiry; unsubmitted editor text and unconfirmed multi-select drafts do not.
- `AskTool.concurrency = "exclusive"`: the tool runs alone in its tool batch because the selector/editor UI surface is shared and concurrent `ask` calls would clobber each other.
- The call renderer normalizes incomplete or malformed streamed arguments for display: bare string options become labels and unusable question/option entries are omitted. Execution still receives schema-validated input.

## Errors
- Missing interactive UI: throws `ToolAbortError("Ask tool requires interactive mode")`.
- User cancels picker/editor without timeout: throws `ToolAbortError("Ask tool was cancelled by the user")`.
- Abort signal during input: converted to `ToolAbortError("Ask input was cancelled")`.
- Empty `questions` at runtime returns a text error payload instead of throwing: `Error: questions must not be empty`.
- Rich-dialog contract violations (wrong result count, id, or order) throw `Error`.

## Notes
- `recommended` is only a UI suggestion; invalid indexes are ignored. No response is not approval. The model uses independent judgment for ordinary/reversible work, but stops for disproportionate spend/cost or public-facing/external consequential actions until actual approval.
- In fallback single-select mode the returned `selectedOptions` value strips the appended ` (Recommended)` suffix.
- Multi-select results preserve selection order by `Set` insertion order, not original option order after arbitrary toggles.
- Option labels and prompt text are returned verbatim in `details`. Descriptions/previews/header guide presentation but are not copied into result details.
- `/tree` recovers schema-valid original ask arguments (including `timeout`) to re-open an answer branch. Malformed arguments fail closed; a timed-out re-answer does not create an answer branch.
