# Session Operations: new, clear, delete, fork, resume/continue

This document describes operator-visible behavior for conversation reset, lifecycle, fork, and resume operations as currently implemented. The explicit Python library, rich-graph continuity and memory-residency changes described below are **unreleased**, not retroactive claims about v20.0.2/P5.

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
| `/tree`, `/branch`                       | Selected-node slash/key action | Yes (same node's active continuation changes) | Retains node identity and transcript; commits the temporal cut and generation             | Captures/restores exact state manifests; preserves historical branches                |
| `/fork`                                 | Selected-node slash command | Source unchanged; foreground adopts fresh root | Creates a new persisted independent root from the selected node's active lineage         | Copies readable output payloads, excluding descendant histories/artifact directories |
| `--fork <id\|path>`                     | CLI startup                  | Yes after session creation                    | Creates a stored-history fork from the selected source into current cwd/session dir       | Copies stored artifacts; no interactive live-state capture                     |
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

## Temporal navigation and branch

Interactive `/tree` and `/branch` act on the selected node, including a focused worker. They retain its identity and transcript: `/tree` changes the active continuation at the selected boundary; `/branch` selects a user message, moves before it, and returns its text/images as an editable draft. The discarded continuation remains historical data rather than being deleted.

The backend freezes admissions into the affected subtree, atomically refuses running/admitted turns or pending spawns, and holds the source kernel boundary gate through state preparation and activation. A busy ancestor or sibling does not by itself block an idle node. State compatibility and exact-boundary availability are checked before destructive navigation.

Child abandonment follows durable spawn anchors and entry ancestry, not creation timestamps. Children whose anchors remain on the retained lineage stay addressable. Children created only in the abandoned continuation, and their descendants, become **permanently browse-only in those generations**: sends, revival and mutations are refused. Reopening or revisiting the old historical branch does not reactivate them. Abandoned generations are distinct from explicitly stopped/killed nodes.

A durable temporal journal records the cut, generation and abandoned children before header updates. An interrupted committed cut is recovered on reopen; a damaged runtime cannot continue stale context. A child's later continuation does not change a result already recorded in its parent's transcript. See the [tree reference](./tree.md#child-ownership-and-historical-branches) for selection and summary behavior.

Model [`checkpoint`/`rewind(report)`](./tools/rewind.md) is different: it compresses model context while preserving current interpreter computation and external state. It does not apply user temporal-state restoration or abandon workers merely because exploratory prose was removed.

## Fork

Interactive `/fork` constructs a **fresh independent root** from the selected node's active lineage, even when that node is several worker levels deep. The foreground adopts the returned root; the source runtime, ownership tree, transcript and previously recorded parent results remain unchanged. Fork provenance is historical metadata, not a parent ownership edge.

### Preconditions and backend result

- The selected node and its subtree must have no running/admitted work or pending spawn reservation. The backend admission freeze closes races that an earlier UI streaming check cannot catch.
- The source generation must be active and have durable history. Abandoned/stopped histories are browse-only, and an in-memory-only source is refused rather than silently exported.
- Exact state must be capturable and compatible. Python graph aliases/cycles are supported; unsupported live resources, JavaScript selected-data aliases or corrupt state fail visibly, rather than producing an approximate fork.
- `AgentSession.fork()` returns the newly constructed `AgentSession`, or `undefined` when the before-switch hook cancels. It does not turn the source worker object into a root. An embedding without an independent-root factory receives an explicit error.

### Session-level flow

1. Freeze subtree admissions and source kernel execution; check the affected node's work.
2. Emit the source's cancellable `session_before_switch` with `reason: "fork"`, then flush pending source output/history.
3. Create a new persisted manager from the source's **active lineage** and capture the selected source state into the destination, without appending to the source.
4. Assign fresh root identity, ownership generation and scheduling scope. Retain the inherited mission and lifecycle messages as history, not executable child ownership.
5. Copy readable artifact payloads into the destination namespace, excluding source descendant transcript/artifact trees. A copy failure is an operation failure, not a best-effort success.
6. Construct a new root runtime with rebuilt root instructions/capabilities, fresh kernel ownership and correctly bound tool UI context. Activate and durably capture its state manifest before acknowledging success.
7. The caller adopts the new root. The source is not switched, stopped or rewritten by `fork()`; source descendants are neither cloned nor adopted. A failed construction cleans up its newly created destination.

The new header records fork provenance and an inherited provider prompt-cache key. That cache affinity does not reuse source ownership or interpreter state. **The workspace is shared**: a session fork is not a worktree/filesystem snapshot, process clone, or rollback of files and external side effects.

## Declared state at temporal boundaries

The canonical state manifest now includes automatically captured Python warm namespaces and the session's durable Python store, alongside JavaScript's explicit declarations. Completed turns and explicit continuity boundaries capture immutable, versioned manifests with lane, interpreter, target and environment metadata under the owner/kernel execution gate. Durable commitment precedes a boundary-dependent fork, navigation, parking or normal close; restoration is lazy in the destination's matching environment, including after host restart.

**Python execution is explicit.** Ordinary Python commands (including interactive `$` / `$$` and fresh `executePython`) run real fresh processes. Use `import proto_harness as harness` for the host API, `harness.store` for session-owned rich values, and `harness.kernel("name")` or `python -m proto_harness.kernel name` for an optional warm namespace. There are no injected helper globals or Python `declare_state` requirement.

Warm Python captures the **whole supported namespace as one object graph**, using lazy vendored cloudpickle 3.1.2. Aliases, cycles, closures, functions, classes and module metadata survive a compatible exact-boundary restore. The store likewise commits one complete mapping graph with revision CAS; stale concurrent writers fail instead of overwriting each other. `refresh()` loads the newest store revision; in-place mutations need `commit()` (or a successful `transaction()` batch). Python graphs are trusted session-local data, limited to **64 MiB encoded payload**; their state transport has **96 MiB framing headroom**, not larger ordinary request/queue limits.

Open files, sockets, live tasks/threads and other unsupported runtime resources are refused **before destructive transition**; the source remains usable after a failed preflight. Imported modules require the recorded compatible interpreter/module environment. No serializer claims to restore external process state, installed packages or workspace files.

**JavaScript is unchanged:** `declareState(["name", ...])` selects bounded plain data/bytes (`[]` clears it), with the existing **16 MiB selected-data** limit. Shared mutable aliases, cycles, custom objects, accessors/proxies and retained live resources remain unsupported for JavaScript. That codec is not Python's current graph contract.

Restoration is **exact-boundary only**. A message between captures is not automatically a restorable computation boundary. Once continuity state exists, a missing, corrupt or incompatible capture causes explicit refusal: **no nearest-earlier snapshot, twenty-turn window or silent fresh-kernel fallback**. Historical manifests remain reachable with their branches. A conversation without captured computation can still navigate history without claiming to restore an interpreter heap.

Navigation replaces the source node's computation with the selected manifest. Interactive fork activates an independent, destination-owned copy in the fresh root and leaves the source namespace, store, history and ownership tree unchanged. Copied ancestor history is not a worker's own manifest. The workspace remains shared. Model context-only `checkpoint`/`rewind(report)` preserves **current** computation; it is not temporal restoration. Explicit kernel stop/reset/restart discards that namespace, unlike durable parking or host restart. See [interpreter resource policy](./interactive-memory.md#interpreters-subprocesses-and-provider-state) and [Python APIs](./python-repl.md).

### CLI `--fork <id|path>`

Startup `--fork` is resolved before normal session creation:

1. `--fork` is rejected with `--no-session`.
2. Path-like values (`/`, `\`, or `.jsonl`) call `SessionManager.forkFrom(path, cwd, sessionDir)`.
3. Other values resolve via `resolveResumableSession(...)`: local sessions first, then global search when `sessionDir` is not forced. Matching accepts lowercased session id prefixes, full JSONL filename prefixes, and timestamp-stripped filename id suffixes.
4. The forked file is created in the current cwd/session-dir scope and becomes the active session manager for startup. This is the stored-history `forkFrom` path: it copies stored non-header history and artifacts, rather than invoking the interactive live-node active-lineage capture. It does not perform the interactive live-state capture or capture a running source kernel; copied lifecycle records do not grant ownership of source workers.
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
2. Reads the terminal-scoped breadcrumb. For an existing nested session, explicit node metadata identifies its root session file; fork provenance is not an ownership edge. Legacy sessions without topology are imported once into adjacent `.node.json` receipts, preserving worker IDs and history locations. Normal routing reads durable ownership rather than climbing directory names.
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

`newSession` and `switchSession` emit cancellable `session_before_switch` events with reasons `new` and `resume`, followed on success by `session_switch` with that reason and `previousSessionFile`.

Independent `fork()` emits only the source's cancellable `session_before_switch` with `reason: "fork"`; it does not emit a source `session_switch`, because the source is not switched. The destination has the normal lifecycle of a newly constructed root session, and foreground adoption belongs to the caller.

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

- `/fork` is refused for running/admitted work in the affected subtree, not just for a streaming selected node. Cancelling work and waiting for it to settle is distinct from stopping the node.
- `/resume` selector can be cancelled by user closing selector.
- Cross-project `--resume <id>` can be cancelled by declining the missing-directory move/re-root prompt.

## Non-persistent (in-memory) session behavior

When session manager is created with `SessionManager.inMemory()` (`--no-session`):

- Session file path remains absent, including after resuming saved history; the source does not become a persistence target or acquire a live-session marker.
- `/resume`, `--resume <id|path>`, and the startup `--resume` picker load saved history into memory. `--continue` loads the most recent session in the selected session-directory scope.
- Subsequent messages, title changes, and editor drafts remain ephemeral. Resuming does not rewrite the source transcript or its artifacts, and does not create a terminal resume breadcrumb.
- Interactive `/fork` is refused because its source has no durable history. Explicit export/save operations are separate from resuming.

## Known implementation caveats (as of current code)

- `/session delete` asks for confirmation, then deletes the current session
  JSONL and artifact directory and returns to the session selector. Deletion is
  permanent for the persisted session and its artifacts.
