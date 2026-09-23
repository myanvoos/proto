# Session Operations: new, clear, delete, fork, resume/continue

This document describes operator-visible behavior for conversation reset, lifecycle, fork, and resume operations as currently implemented.

## Implementation files

- [`../src/modes/controllers/command-controller.ts`](../packages/coding-agent/src/modes/controllers/command-controller.ts)
- [`../src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`../src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)
- [`../src/main.ts`](../packages/coding-agent/src/main.ts)

## Operation matrix

| Operation                               | Entry path                   | Session mutation                              | Session file creation/switch                                                               | Output artifact                                                                     |
| --------------------------------------- | ---------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `/new`                                  | Interactive slash command    | Yes (starts an empty conversation)            | Switches identity; assigns a new transcript path in persistent mode                        | None                                                                                |
| `/clear`                                | Interactive slash command    | Yes (clears live/model conversation context)  | No; retains session identity, metadata, transcript file, and full on-disk history          | Appends a durable `reset_boundary`                                                  |
| `/session delete`                       | Interactive slash command    | Yes (after confirmation, returns to selector) | Deletes the current persisted session JSONL and artifact directory, then opens the session selector | None                                                                                |
| `/fork`                                 | Interactive slash command    | Yes (active session identity changes)         | Creates new session file and switches current session to it (persistent mode only)         | Copies artifact directory to new session namespace when present                     |
| `--fork <id\|path>`                     | CLI startup                  | Yes after session creation                    | Creates a new session fork from the selected source into current cwd/session dir           | None                                                                                |
| `/resume [id\|@claude\|@codex]`         | Interactive slash command    | Yes (active in-memory state replaced)         | Switches to a selected/matched session, or imports a selected foreign session              | None                                                                                |
| `--resume`                              | CLI startup picker           | Yes after session creation                    | Opens selected existing session file                                                       | None                                                                                |
| `--resume <id\|path>`                   | CLI startup                  | Yes after session creation                    | Opens existing session; a missing recorded cwd may be re-rooted into the current directory | None                                                                                |
| `--continue`                            | CLI startup                  | Yes after session creation                    | Opens terminal breadcrumb or most-recent session; creates new one if none exists           | None                                                                                |

There is no `/fresh` command and no `AgentSession.freshSession()`: to reset
provider stream state, `/clear` rotates it in place while keeping the session
identity and transcript file; `/new` starts a brand-new empty session. To
remove a persisted session, `/session delete` confirms, deletes the session
JSONL and its artifact directory, and returns to the session selector.

## Clear

Interactive `/clear` clears the current conversation context in place. It is
available only in the TUI and is rejected while a response is streaming or a
foreground bash/Python execution is running. If compaction is active, the
command aborts it and waits for it to stop before resetting.

`AgentSession.resetSessionContext()`:

- Drops live messages, queued steer/follow-up turns, pending tool calls, error
  state, checkpoint/rewind and deferred tool state, and session-stop
  continuation state. It also cancels this agent's queued continuation work and
  async bash/task jobs.
- Rotates provider-side session state, re-primes advisors, invalidates
  append-only model context, and resets memory promotion so the next turn
  rebuilds from the base system prompt and current project instructions.
- Retains the session id, title, cwd, model, settings, active plan path, and
  transcript file.
- Appends a durable `reset_boundary`. The collapsed live transcript and rebuilt
  model context begin after the latest boundary, while the JSONL transcript
  retains the pre-reset history on disk.

The TUI clears its rendered transcript after a successful clear. This differs
from `/new`, which creates a new session identity and transcript file, and from
`/session delete`, which deletes the persisted session entirely.

## Fork

Interactive `/fork` creates a new session from the current one and switches the active session identity.

### Preconditions and immediate guards

- If agent is streaming, `/fork` is rejected with warning.
- UI status/loading indicators are cleared before operation.

### Session-level flow

`AgentSession.fork()`:

1. Emits `session_before_switch` with `reason: "fork"` (cancellable).
2. Flushes pending writes.
3. Calls `SessionManager.fork()`.
4. Copies artifacts directory from old session namespace to new namespace (best-effort; non-ENOENT copy failures are logged, not fatal).
5. Updates `agent.sessionId` and inherits the previous provider prompt-cache key unless an explicit prompt-cache key is already pinned.
6. Emits `session_switch` with `reason: "fork"`.

`SessionManager.fork()` behavior:

- Requires persistent mode and existing session file.
- Creates new session id and new JSONL file path.
- Rewrites header with:
  - new `id`
  - new timestamp
  - `cwd` unchanged
  - `parentSession` set to previous session id
  - `providerPromptCacheKey` set to the previous header's inherited key, or the previous session id when none was pinned
- Keeps all non-header entries unchanged in the new file.

### Non-persistent behavior

- In-memory session manager returns `undefined` from `fork()`.
- `AgentSession.fork()` returns `false`.
- UI reports `Fork failed (session not persisted or cancelled)`.

### CLI `--fork <id|path>`

Startup `--fork` is resolved before normal session creation:

1. `--fork` is rejected with `--no-session`.
2. Path-like values (`/`, `\`, or `.jsonl`) call `SessionManager.forkFrom(path, cwd, sessionDir)`.
3. Other values resolve via `resolveResumableSession(...)`: local sessions first, then global search when `sessionDir` is not forced. Matching accepts lowercased session id prefixes, full JSONL filename prefixes, and timestamp-stripped filename id suffixes.
4. The forked file is created in the current cwd/session-dir scope and becomes the active session manager for startup.
5. Full-context forks automatically seed `providerPromptCacheKey` from the source header's inherited key, falling back to the source session id. Startup drops that automatic inheritance when `--model`, `--thinking`, `--system-prompt`, `--append-system-prompt`, `--tools`, or `--no-tools` changes the provider route or prompt/tool shape.

Use `--prompt-cache-key <key>` to pin the provider prompt-cache identity explicitly and independently from both the PROTO session id and `--provider-session-id`. `--provider-session-id` continues to control provider session/routing headers and sticky credential selection; `--prompt-cache-key` controls the OpenAI Responses `prompt_cache_key` payload where supported.

## Resume and continue

## Interactive `/resume [value]`

Without an argument:

1. Opens the session selector populated via `SessionManager.list(currentCwd, currentSessionDir)`.
2. The picker starts in current-folder scope; Tab toggles to all-projects scope, lazily loading and caching `SessionManager.listAll()`.
3. On selection, `SelectorController.handleResumeSession(sessionPath)` calls `session.switchSession(sessionPath, { onCwdChange })`, where `onCwdChange` re-points the process cwd and cwd-derived caches via `applyCwdChange`. A `false` result (hook cancel or a project change that could not be applied) leaves the current session and UI untouched.
4. UI clears/rebuilds chat and checklist items, then reports `Resumed session` (or `Resumed session in <dir>` when the resumed session belongs to another project). A session whose recorded project cannot be entered resumes in the current cwd, and the status says so.

With an argument:

- `/resume <id>` resolves an id/filename prefix with local-first, then global fallback and switches directly to the matched file; an unknown value reports `Session "<value>" not found`.
- `/resume @claude` and `/resume @codex` open a foreign-session picker. Selecting one converts and persists it under a fresh PROTO session identity, then switches to that new session.

## CLI `--resume`

### `--resume` (no value)

- `main.ts` lists sessions for the current cwd/sessionDir and opens the picker in current-folder scope. When that list is empty it preloads `SessionManager.listAll()` so a user-initiated Tab switch to all-projects scope is immediate; it does not auto-switch scopes. `No sessions found` is printed only when the global list is also empty.
- Selected path is opened with `SessionManager.open(selectedPath)` before session creation. Selecting a session from another project first switches the process into that project's directory and reloads cwd-scoped settings/caches.

### `--resume <value>`

`createSessionManager()` resolution order:

1. If value looks like path (`/`, `\`, or `.jsonl`), open directly.
2. Else `resolveResumableSession(...)` searches:
   - current scope (`SessionManager.list(cwd, sessionDir)`)
   - global sessions (`SessionManager.listAll()`) only when no explicit `sessionDir` was provided
3. Matching accepts case-insensitive session id prefixes, full JSONL filename prefixes, and the id suffix after the timestamp in `<timestamp>_<sessionId>.jsonl`.

Cross-project id match behavior:

- If the matched session's recorded directory no longer exists, CLI asks `Session's directory no longer exists (...). Move (re-root) it into the current directory? [Y/n]`.
  - On yes (default), `SessionManager.open(match.path)` followed by `manager.moveTo(cwd)` re-roots the existing session into the current directory without duplicating it.
  - On no, startup is cancelled. In non-TTY mode, startup fails with an error directing the user to run interactively.
- If the recorded directory still exists, the matched session is opened directly. Startup later changes the process/project scope to the resumed session's cwd and reloads cwd-scoped settings and plugin caches. It is not implicitly forked.
- If that directory exists but cannot be entered (for example a macOS TCC-protected folder), or its settings/plugins fail to load, startup stays in the launch directory, prints `Could not switch to resumed project <dir>; staying in <cwd>.`, and the session tracks the launch directory runtime-only until it is moved.

## CLI `--continue`

`SessionManager.continueRecent(cwd, sessionDir)`:

1. Resolves the session directory for the current cwd.
2. Reads the terminal-scoped breadcrumb. If it points into a nested artifact/subagent session, resolution walks up to the top-level interactive parent session (up to eight levels).
3. If the breadcrumb points at a session recorded under a different cwd whose directory no longer exists **and** the current directory has no sessions of its own, re-roots that session into the current directory via `moveTo` instead of starting fresh.
4. Otherwise, if the breadcrumb's cwd matches the current cwd, uses the breadcrumb session; else falls back to the most recently modified session file.
5. Opens the found session; if none exists, creates a new session.

For compatibility, `--continue <full-UUID>` is normalized to `--resume <UUID>` when the UUID is the sole positional message. The `autoResume` setting invokes the same `continueRecent` behavior when no explicit session flag/session directory is supplied, and restores session model/thinking state when a prior transcript was found.

This is startup-only behavior; there is no interactive `/continue` slash command.

## How session switching actually mutates runtime state

`AgentSession.switchSession(sessionPath)` does the runtime transition used by resume-like operations:

1. Emit `session_before_switch` with `reason: "resume"` and `targetSessionFile` (cancellable).
2. Disconnect the agent event subscription, abort in-flight work, and run the optional pre-switch reconciler.
3. Flush pending bash/session writes and capture rollback state: session manager state; agent messages and all queues; model/thinking/service tiers; tools and prompts; provider/cache ids; memory promotion; and checkpoint rewind state.
4. Clear agent and next-turn queues. For a different file, drain/detach advisor recorders.
5. `sessionManager.setSessionFile(sessionPath)`. When it adopts another project's cwd, the caller's `onCwdChange` must move the process there; without that callback, or when it returns `false`, the switch is refused and returns `false`. Then update provider-cache/session ids and memory keys, build the display context, and rehydrate checkpoint state.
6. Emit `session_switch` with `reason: "resume"`.
7. Replace agent messages, reset advisor state, and synchronize checklist items. Close cached provider sessions for a different file, or for a same-file reload whose replay messages changed.
8. Restore an available persisted model. If the loaded branch ended with an interrupted turn, append its synthetic abort message and rebuild context.
9. Restore configured/effective thinking and per-family service tiers, falling back to current settings when the target branch has no corresponding entries.
10. For a different transcript, reset memory context; for any conversation rewrite, clear session-scoped tool state.
11. Reconnect agent events, run the optional session-switch reconciler (interactive mode uses it to re-enter persisted modes such as plan), and best-effort refresh the workspace-root system-prompt block. Reconciler/prompt-refresh errors are logged rather than rolling back the committed switch.
12. Restore target advisor cost state, finish the bash transition, and notify session-change callbacks when the session id changed.

If a throwing step in the guarded transition fails, `switchSession()` restores the captured session, agent queues/messages, tools/prompts, model/thinking/service-tier, provider/cache, memory, and checkpoint state; it reconnects the prior agent subscription and re-runs mode reconciliation before rethrowing. A project change already applied is undone through `onCwdChange(previousCwd, targetCwd)`; if that fails, the session is disposed and the error names where the process may remain.

No new session file is created by `switchSession()` itself.

## Event emissions and cancellation points

### Switch/fork lifecycle hooks

For `newSession`, `fork`, and `switchSession`:

- Before event: `session_before_switch`
  - reasons: `new`, `fork`, `resume`
  - cancellable by returning `{ cancel: true }`
- After event: `session_switch`
  - same reason set
  - includes `previousSessionFile`

`ExtensionRunner.emit()` returns early on the first cancelling before-event result.

### Custom tool `onSession` behavior

SDK bridges extension session events to custom tool `onSession` callbacks:

- `session_switch` -> `onSession({ reason: "switch", previousSessionFile })`
- `session_branch` -> `reason: "branch"`
- `session_start` -> `reason: "start"`
- `session_tree` -> `reason: "tree"`
- `session_shutdown` -> `reason: "shutdown"`

These callbacks are observational; they do not cancel switch/fork.

### Other cancellation surfaces relevant to this doc

- `/fork` is blocked while streaming (user must wait/abort current response first).
- `/resume` selector can be cancelled by user closing selector.
- Cross-project `--resume <id>` can be cancelled by declining the missing-directory move/re-root prompt.

## Non-persistent (in-memory) session behavior

When session manager is created with `SessionManager.inMemory()` (`--no-session`):

- Session file path remains absent, including after resuming saved history; the source does not become a persistence target or acquire a live-session marker.
- `/resume`, `--resume <id|path>`, and the startup `--resume` picker load saved history into memory. `--continue` loads the most recent session in the selected session-directory scope.
- Subsequent messages, title changes, and editor drafts remain ephemeral. Resuming does not rewrite the source transcript or its artifacts, and does not create a terminal resume breadcrumb.
- `/fork` fails because `SessionManager.fork()` requires persistence. Explicit export/save operations are separate from resuming.

## Known implementation caveats (as of current code)

- `/session delete` asks for confirmation, then deletes the current session
  JSONL and artifact directory and returns to the session selector. Deletion is
  permanent for the persisted session and its artifacts.
