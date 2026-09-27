# Session switching and recent session listing

This document describes how coding-agent discovers recent sessions, resolves `--resume` targets, presents session pickers, and switches the active runtime session.

It focuses on current implementation behavior, including fallback paths and caveats.

## Implementation files

- [`../src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)
- [`../src/session/session-listing.ts`](../packages/coding-agent/src/session/session-listing.ts)
- [`../src/session/session-paths.ts`](../packages/coding-agent/src/session/session-paths.ts)
- [`../src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`../src/cli/session-picker.ts`](../packages/coding-agent/src/cli/session-picker.ts)
- [`../src/modes/components/session-selector.ts`](../packages/coding-agent/src/modes/components/session-selector.ts)
- [`../src/modes/controllers/selector-controller.ts`](../packages/coding-agent/src/modes/controllers/selector-controller.ts)
- [`../src/main.ts`](../packages/coding-agent/src/main.ts)
- [`../src/sdk.ts`](../packages/coding-agent/src/sdk.ts)
- [`../src/modes/interactive-mode.ts`](../packages/coding-agent/src/modes/interactive-mode.ts)
- [`../src/modes/utils/ui-helpers.ts`](../packages/coding-agent/src/modes/utils/ui-helpers.ts)

## Recent-session discovery

### Directory scope

`SessionManager` stores file sessions under a canonical-cwd bucket by default:

- `~/.proto/agent/sessions/<encoded-cwd>/*.jsonl`

`<encoded-cwd>` is the path-encoded canonical cwd (`-<relative>` under home, `-tmp-<relative>` under the temp root, `--<encoded-absolute>--` otherwise; see [session.md](session.md#on-disk-layout)). Buckets from the reverted 17.2.5-17.2.8 hashed scheme are migrated best-effort. `SessionManager.list(cwd, sessionDir?)` reads only the resolved bucket unless an explicit `sessionDir` is provided.

### Two listing paths with different payloads

There are two different listing pipelines:

1. `getRecentSessions(sessionDir, limit)` (welcome/summary view)
   - Stats every `*.jsonl` and orders candidates by file `mtime` descending.
   - On `FileSessionStorage`, consults the `session-index` title rows for the newest `limit + 8` candidates; an indexed title can be returned without opening its JSONL. If those rows cannot fill the requested limit, it falls back to the complete ordered candidate list.
   - Unindexed candidates go through `scanSessionFile`, which streams complete JSONL records in bounded byte ranges (without retaining a whole-file string) and derives the header, title, and earliest user-text preview. Validated archive metadata is consulted only for otherwise unnamed, nearly empty active logs.
   - Understands both current fixed-width title-slot files and legacy header-first files.
   - Skips unnamed 0-turn stubs; titled or first-prompt 0-turn sessions remain eligible.
   - Returns lightweight `RecentSessionInfo` (`path`, `name`, `timeAgo`).

2. `SessionManager.list(...)` / `SessionManager.listAll()` (resume pickers and ID matching)
   - Cold scans stream complete JSONL records in bounded byte ranges. Unchanged files can instead be served from a persisted `session_scan` info row or an in-process stat-keyed cache; a bounded suffix (up to 32 KiB) supplies lifecycle status.
   - Builds `SessionInfo` (`path`, `id`, `cwd`, title/parent metadata, dates, size, message previews/count, and lifecycle status).
   - Counts parsed messages across the scan and retains the first user message plus bounded transcript search text (`allMessagesText`, at most 16,384 characters); this is not limited to the first 4 KiB.
   - Status is `complete`, `interrupted`, `aborted`, `error`, `pending`, or `unknown`.
   - Sorts by `modified` descending, with creation time and path tie-breakers. Large listings use bounded parallel workers.

Normal per-directory scans repair the newest orphaned `.bak` created by the EPERM atomic-rewrite fallback when its primary JSONL is absent. `listSessionsReadOnly` is the non-mutating variant.

### Metadata fallback behavior

For recent summaries (`RecentSessionInfo`):

- display name preference (`sessionDisplayName`): `title` -> first user message -> an `Untitled · <time>` label (the raw `id` is intentionally never used)
- the welcome screen sanitizes the name and truncates it to a width-dependent budget, `max(8, min(40, termWidth - 30))`; the welcome is hidden below 30 columns
- only the first line is kept and control characters are stripped from title/message-derived names (`sanitizeSessionName`)

For `SessionInfo` list entries:

- `title` is the fixed title-slot value when present, otherwise `header.title`, otherwise the last compaction `shortSummary` encountered during the scan
- `firstMessage` is the first user-message text found by the complete scan or `"(no messages)"`
- the picker shows modified time, file size, lifecycle status (except `unknown`), and fork marker; it shows cwd when `showCwd` is enabled, including the all-projects scope of the normal session pickers

## `--continue` resolution and terminal breadcrumb preference

`SessionManager.continueRecent(cwd, sessionDir?)` resolves the target in this order:

1. Read terminal-scoped breadcrumb (`~/.proto/agent/terminal-sessions/<terminal-id>`).
2. A materialized target is eligible; a missing target is eligible only when its breadcrumb carries `fresh`, denoting a lazily-unmaterialized `/new` boundary. An explicit `sessionDir` fences breadcrumbs outside that directory.
3. A missing, in-scope fresh target starts a new session instead of falling back and resurrecting the prior transcript.
4. Resolve stale pre-fix subagent breadcrumbs to their interactive parent session.
5. If the breadcrumb's cwd matches the current cwd and its target is in scope, use that breadcrumb.
6. For a cwd mismatch, inspect the newest non-empty session in the current bucket. Re-root the breadcrumb (`open` + `moveTo`) only when its recorded cwd is missing, it is the candidate that would otherwise be selected, and the current directory has the same device/inode identity recorded in the breadcrumb; a missing path without that positive move evidence is not re-rooted.
7. Without a usable breadcrumb, choose the newest non-empty session by mtime (skipping untitled 0-turn stubs). Claiming a session owned by another live process fails closed by starting a new session; if no candidate exists, create a new session.

Terminal ID derivation prefers TTY path and falls back to env-based identifiers (`ZELLIJ_PANE_ID`, `TMUX_PANE`, `CMUX_SURFACE_ID`, `KITTY_WINDOW_ID`, `WEZTERM_PANE`, `TERM_SESSION_ID`).

Breadcrumb writes are best-effort and non-fatal.

`-c <value>` is normalized to an explicit resume target when the sole positional value matches the full UUID-shaped session id; other positional text remains the initial prompt for `--continue`.

## Startup-time resume target resolution (`main.ts`)

### `--resume <value>`

`createSessionManager(...)` handles string-valued `--resume` in two modes:

1. Path-like value (contains `/`, `\\`, or ends with `.jsonl`)
   - persistent startup claims and directly opens it with `SessionManager.open(sessionArg, parsed.sessionDir)`; `--no-session` loads it through an in-memory manager instead

2. Resume key value
   - `resolveResumableSession(...)` searches local sessions first, then all sessions unless a custom `sessionDir` disables global fallback
   - matching is case-insensitive and accepts `id` prefix, the JSONL basename prefix (with `.jsonl` stripped), or the session-id suffix after the timestamp; CLI values ending in `.jsonl` are treated as paths instead
   - resolution searches the raw listing, so picker-only filtering of untitled 0-turn stubs does not apply to an explicit key
   - first match in modified-descending order is used (no ambiguity prompt), then the same persistent/in-memory open distinction applies

In persistent mode, for a matched resume-key session whose recorded cwd no longer exists, the CLI prompts `Move (re-root) it into the current directory? [Y/n]`. Acceptance opens it and `moveTo(cwd)` relocates it; decline exits cleanly. A non-TTY cannot answer and raises `SessionResolutionError`. Path-like direct opens and picker selections instead use the normal runtime-cwd fallback below.

Otherwise the session is opened in its recorded project, including global matches; startup switches process cwd, reloads project-scoped settings/plugins, and re-resolves enabled models before constructing the agent. It does **not** fork merely because the match is cross-project. A recorded project that exists but cannot be entered, or whose rescope fails, keeps startup in the launch directory with a `Could not switch to resumed project` notice; the session tracks the launch directory runtime-only.

No resume-key match throws `Session "..." not found.`.

### `--resume` (no value)

Handled after initial session-manager construction:

1. list current-folder sessions with `SessionManager.listForPicker(cwd, parsed.sessionDir)` (untitled 0-turn stubs are filtered out)
2. if empty, probe `SessionManager.listAllForPicker()` only to distinguish globally empty state and preload the Tab scope; the picker still opens in current-folder scope
3. if both lists are empty, print `No sessions found` and exit
4. open the fullscreen TUI picker (`selectSession`)
5. if canceled, print `No session selected` and exit
6. on selection, claim and open the selected path with `SessionManager.open` (or load it into an in-memory manager under `--no-session`), then switch process/project-scoped state to the selected session's cwd when enterable; otherwise retain the launch cwd and runtime-only fallback

### `--continue`

Persistent startup uses `SessionManager.continueRecent(...)` directly (breadcrumb-first behavior above). Under `--no-session`, startup instead finds the most recent file in the selected bucket and loads it through the in-memory manager; if none exists, it starts in memory without a resumed transcript.

## Picker-based selection internals

## CLI picker (`src/cli/session-picker.ts`)

`selectSession(sessions, options)` creates a fullscreen alternate-screen TUI with `SessionSelectorComponent` and resolves exactly once:

- selection -> resolves selected `SessionInfo`
- cancel (Esc) -> resolves `null`
- hard exit (Ctrl+C path) -> stops TUI and exits
- Tab toggles current-folder / all-projects scope; when not supplied preloaded, the all-projects list starts loading after the picker first renders and Tab waits for it
- search combines session metadata and bounded transcript text with prompt-history matches from `history.db` after a short debounce
- mouse wheel changes selection and left click selects in the fullscreen picker
- Delete, or Backspace with an empty search, opens confirmation and deletes the JSONL plus session artifacts

## Interactive in-session picker (`SelectorController.showSessionSelector`)

Flow:

1. fetch current-folder sessions via `SessionManager.listForPicker(currentCwd, currentSessionDir)`; the all-projects list is started after the first paint rather than blocking the folder scan
2. mount `SessionSelectorComponent` in the editor area with background all-project loading and a `history.db` prompt matcher
3. callbacks:
   - select -> lock picker input and call `handleResumeSession(sessionPath)`; a recoverable pre-switch failure unlocks the picker
   - cancel -> restore editor and rerender
   - exit -> `ctx.shutdown()`

`/resume <id-or-filename-prefix>` resolves local then global matches and switches directly. `/resume @claude` and `/resume @codex` instead open read-only-source import pickers: the selected foreign transcript is persisted as a PROTO session, then switched to; deletion, history augmentation, and all-project scope are not offered in those pickers.

## Session selector component behavior

`SessionList` supports:

- Up/Down and Page Up/Page Down navigation (clamped, not wrapped)
- Enter to select
- Delete, or Backspace on an empty search, to delete after confirmation
- Esc to cancel; Ctrl+C to exit (or clear a marked multi-selection range first)
- Tab to toggle current-folder / all-projects scope
- mouse wheel/click in the fullscreen picker
- multi-token search across id/title/cwd/first message/bounded transcript text/path: literal matches lead by recency, then sufficiently strong fuzzy matches; prompt-history matches from `history.db` may be promoted after typing pauses

Empty-list render behavior:

- current-folder scope renders `No sessions in current folder. Press Tab to view all.`; all-projects scope renders `No sessions found`
- Enter/Delete/Backspace on empty do nothing
- Esc/Ctrl+C still work

## Runtime switch execution (`AgentSession.switchSession`)

`switchSession(sessionPath)` is the core in-process switch path.

Lifecycle/state transition:

1. capture the previous file and, when handlers are registered, emit cancellable `session_before_switch` (`reason: "resume"`, target file)
2. disconnect agent listeners, abort active work, run the pre-switch reconciler, and flush pending bash/session writes
3. snapshot rollback state (manager, queues, messages, model/thinking/tier, tools/prompts, provider-cache identity, and checkpoint/rewind state), then clear message queues
4. for a different session, drain/detach advisor recorders
5. `sessionManager.setSessionFile(sessionPath)`: update breadcrumb, load/migrate/blob-resolve/index entries, and adopt the recorded cwd only when it can be entered; otherwise keep the current cwd and track the recorded project runtime-only (workspace edits are not persisted, and the next new/fork transcript lands in the current cwd's bucket). Adopting another project requires the caller's `onCwdChange` to move the process there; without it, or when it returns `false`, the switch is refused and returns `false`
6. sync session id, memory key, inherited provider-cache key, display context, and checkpoint/rewind state
7. emit `session_switch`, replace messages, reset advisor session state, and sync checklist items
8. close provider sessions for a different session, or for a same-session reload whose replay changed
9. restore the first available recorded model in role/default fallback order
10. if the loaded branch ended with an interrupted tool flow, append a synthetic abort message and rebuild display context
11. restore configured thinking (`auto` survives as auto) and per-family service tiers, falling back to current settings when no corresponding entry exists
12. reset memory/tool session state as required, reconnect listeners, run mode reconciliation, and refresh the workspace-aware base system prompt
13. restore advisor cost for a different session, finish the bash transition, notify session-change callbacks, and return `true`

Any escaping failure after the snapshot restores the previous manager and runtime state, reconnects/reconciles it, marks the bash transition failed, then rethrows. Mode reconciliation and base-prompt refresh failures are logged and left non-fatal. An applied project change is first undone through `onCwdChange(previousCwd, targetCwd)`; when that fails the session is disposed.

## UI state rebuild after interactive switch

For an idle, non-parked target, `SelectorController.handleResumeSession` calls `session.switchSession(sessionPath, { onCwdChange })`, where `onCwdChange` is `applyCwdChange`: it moves the process cwd, settings, provider globals, plugin roots, capabilities, skills, and slash commands transactionally, returning `false` (after undoing its own work) when any step fails. A busy foreground session may instead be parked and a detached or newly created foreground session attached. A `false` switch stops before any UI change. After a successful switch or foreground swap it:

- stop loading animation
- clear status container
- clear pending-message UI and pending tool map
- reset streaming component/message references
- clear chat container and rerender from session context (`renderInitialMessages`)
- reload checklist items from new session artifacts
- show a resume status (normally `Resumed session`, or `Resumed session in <dir>` for a cross-project resume; busy-session paths may report a parked/interrupted status), noting when the recorded project could not be entered

Visible conversation/checklist state is rebuilt from the new session file. Transcript component hydration starts with the newest window (soft limits: 256 messages and 2 MiB of estimated message data). An assistant and its associated tool results stay together; one oversized message or tool group may exceed those limits. Long autonomous turns can span multiple windows without waiting for another user message.

`Alt+PageUp` / `Alt+PageDown` / `Alt+End`, or `/history older|newer|latest`, navigate the display windows. Previous rendered components are disposed rather than retained as an ever-growing UI cache. The persisted entries and model context remain complete; this bounds eager UI hydration, not all session-storage memory.

## Startup resume vs in-session switch

### Startup resume (`--continue`, `--resume`, direct open)

- Session file is chosen before `createAgentSession(...)`.
- `sdk.ts` builds the existing session context during creation.
- Agent messages and replay state are restored once during construction.
- Model/thinking/service tier use persisted state with current configuration fallbacks.
- Interactive mode then reconciles persisted mode state.

### In-session switch (`/resume`-style selector path)

- The idle, non-parked path uses `AgentSession.switchSession(...)` on an already-running session; a busy foreground may instead be parked and a detached or newly created foreground session attached.
- In the in-place path, messages/model/thinking/tier and session-scoped runtime state are rebuilt in place.
- The in-place path emits registered `session_before_switch`/`session_switch` hooks.
- UI chat/checklist items are refreshed on either path.
- In-place switching runs interactive mode reconciliation through the registered session-switch reconciler; a foreground swap attaches the new session view and rebuilds its transcript view during attachment.

## Failure and edge-case behavior

### Cancellation paths

- CLI picker cancel -> returns `null`, caller prints `No session selected`, process exits.
- Interactive picker cancel -> closes the overlay with no session change.
- Core hook cancellation (`session_before_switch`) or a refused project change -> `switchSession()` returns `false`; the interactive selector keeps the old session and UI.

### Empty list paths

- CLI `--resume` (no value): only an empty current-folder **and** global list prints `No sessions found` and exits; otherwise the empty folder-scope picker invites Tab.
- Interactive selector: empty folder scope renders the Tab hint and remains cancellable.

### Missing/invalid target session file

When opening/switching to a specific path (`setSessionFile`):

- In persistent mode, ENOENT or an empty file -> treated as empty -> a new session is initialized at that exact path and persisted; an in-memory `--no-session` manager initializes without writing. Fail-closed callers such as `openReadOnly` pass missing/empty failures through instead.
- A non-empty file with a malformed/missing header, or a malformed complete (newline-terminated) record -> throws a resume error and leaves the source file untouched; it is not replaced with a fresh session. A malformed unterminated final record is ignored by parsing and may be discarded if a later persisted rewrite occurs after valid entries are loaded.

Missing/empty files are recovery behavior; malformed durable data is not silently recovered.

### Hard failures

Switch/open can still throw on true I/O failures (permission errors, rewrite failures, etc.), which propagate to callers.

### ID prefix matching caveats

- Matching uses `startsWith` on the lowercased session id, lowercased JSONL basename (without the `.jsonl` suffix), and lowercased id suffix after the filename timestamp.
- First match in modified-descending order wins; there is no ambiguity UI if multiple sessions share a prefix.
- Listing scans complete JSONL records in bounded ranges, so counts and first-message metadata can include records beyond the first 4 KiB; `allMessagesText` is capped at 16,384 characters and therefore may omit later text after that cap.
