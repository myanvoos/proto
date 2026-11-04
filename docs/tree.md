# `/tree` Command Reference

`/tree` opens the interactive **Session Tree** navigator for the selected session node, including a focused worker. It lets you select a historical entry and continue that node from the corresponding boundary.

This is a user temporal transition within the same node and transcript, not a new session export. It restores supported declared interpreter state and can permanently abandon children of the discarded continuation; it is not merely a model-context edit.

## What `/tree` does

- Builds a tree from current session entries (`SessionManager.getTree()`)
- Opens `TreeSelectorComponent` with keyboard navigation, filters, and search
- On selection, calls `AgentSession.navigateTree(targetId, { summarize, customInstructions })`
- Freezes new admissions into the selected node's subtree and rejects running or already-admitted work there
- Prepares the exact declared-state boundary before changing history or disposing kernels
- Commits the new continuation and its generation durably, then rebuilds visible chat from that path
- Optionally prefills editor text when selecting a user/custom message

An independently active ancestor or sibling is not a reason to reject an idle node's navigation. A busy descendant is: the backend checks the affected subtree atomically, rather than relying only on the selector's earlier busy check.

Primary implementation:

- `src/slash-commands/builtin-registry.ts` (`/tree`, `/branch` command routing)
- `src/modes/controllers/input-controller.ts` (keybinding wiring, double-escape behavior)
- `src/modes/controllers/selector-controller.ts` (tree UI launch + summary prompt flow)
- `src/modes/components/tree-selector.ts` (navigation, filters, search, labels, rendering)
- `src/session/agent-session.ts` (`navigateTree` transition + optional summary)
- `src/session/temporal-operations.ts` (subtree/kernel gates, spawn-anchor abandonment, durable transition journal)
- `src/session/state-manifest.ts` (exact declared-state capture, preparation and activation)
- `src/session/session-manager.ts` (history, topology/generation persistence, transition recovery and labels)

## How to open it

Any of the following opens the same selector:

- `/tree`
- configured keybinding for the `app.session.tree` action
- double-escape on empty editor when `doubleEscapeAction = "tree"` (default)

## Tree UI model

The tree is rendered from session-entry parent pointers (`id` / `parentId`).

- Children are sorted by timestamp ascending
- The branch containing the active leaf is ordered first in the selector; other history remains reachable
- Active branch (root-to-leaf path) is marked with a bullet
- Labels render as `[label]` before node text
- Missing parents, self-parent entries, and explicit null parents become roots; multiple roots share a virtual branching root

```text
Example tree view (active path marked with •):

├─ user: "Start task"
│  └─ assistant: "Plan"
│     ├─ • user: "Try approach A"
│     │  └─ • assistant: "A result"
│     │     └─ • [milestone] user: "Continue A"
│     └─ user: "Try approach B"
│        └─ assistant: "B result"
```

The selector recenters around current selection and shows up to:

- `max(5, floor(terminalHeight / 2))` rows

## Keybindings inside tree selector

- `Up` / `Down`: move selection (wraps)
- `Alt+Up` / `Alt+Down`: jump to previous/next user or assistant turn
- `Page Up` / `Page Down`, or `Left` / `Right`: page
- `Home` / `End`: first/last visible item
- `Enter`: select node
- `Shift+Enter`: summarize and switch without opening the summary-choice prompt
- `Esc`: clear search if active; otherwise close selector
- `Ctrl+C`: close selector
- `Type`: append to search query
- `Backspace`: delete search character
- `Shift+L`: edit/clear label when search is empty
- `Ctrl+O`: cycle filter forward
- `Shift+Ctrl+O`: cycle filter backward
- `Alt+D/T/U/L/A`: jump directly to a filter

## Filters and search semantics

Initial mode comes from `treeFilterMode` (default `default`). Modes cycle in this order:

1. `default`
2. `no-tools`
3. `user-only`
4. `labeled-only`
5. `all`

### `default`

Shows conversational nodes plus any entry types not explicitly suppressed. It hides these setting/bookkeeping entry types:

- `label`
- `custom`
- `model_change`
- `thinking_level_change`

Other entry types without specialized rendering (for example service-tier, title, credential-pin, reset, and mode entries) may appear as blank rows in current code.

### `no-tools`

Same as `default`, plus hides `toolResult` messages.

### `user-only`

Only `message` entries where role is `user`.

### `labeled-only`

Only entries that currently resolve to a label.

### `all`

Everything in the session tree, including bookkeeping/custom entries.

### Tool-only assistant node behavior

Assistant messages that contain only tool calls (no canonical text) are hidden in every filter mode, including `all`, unless:

- message is error/aborted (`stopReason` is neither `stop` nor `toolUse`), or
- it is the current leaf

### Search behavior

- Query is tokenized by spaces
- Matching is fuzzy (subsequence) and case-insensitive (`fuzzyMatch`)
- All tokens must match (AND semantics)
- Searchable text includes label, role, and type-specific content (message text, branch summary text, custom type, tool command snippets, etc.)

## Selection outcomes (important)

`navigateTree` computes new leaf behavior from selected entry type:

### Selecting `user` message

- New leaf becomes the selected entry’s `parentId`
- Root user message resets leaf to root
- Text and image attachments are reconstructed as an editable draft
- The selector only writes that draft when the editor is currently empty

### Selecting `custom_message`

- Ordinary custom messages use the same parent-leaf rule and text prefill as user messages
- `skill-prompt` custom messages are not editable; selecting one lands on that node like other non-user entries

### Selecting a past `ask` tool result

- Interactive `/tree` reopens the original question UI instead of reusing the stale answer
- Cancel leaves the tree unchanged
- A new answer is appended as a sibling tool result, preserving the old answer branch, then the agent resumes from it
- If legacy/corrupt data cannot recover the original questions, selection falls back to a plain leaf move

### Selecting other nodes

- New leaf becomes selected node id
- Editor is not prefilled

### Selecting current leaf

- Normally closes with `Already at this point`
- A current-leaf `ask` result still permits the re-answer flow

```text
Selection decision (simplified):

selected node
   │
   ├─ current leaf (not ask result)? ──> close selector (no-op)
   │
   ├─ ask tool result? ──> re-answer as a sibling branch when questions are recoverable
   │
   ├─ user or ordinary custom message? ──> leaf := parentId (or root)
   │                                         + prefill only into an empty editor
   │
   └─ otherwise ──> leaf := selected node id
                    + no editor prefill
```

## Summary-on-switch flow

Summary prompting is controlled by `branchSummary.enabled` (default `false`). `Shift+Enter` requests summarization directly regardless of the prompt setting; a model and provider credential must be available.

When prompting is enabled, ordinary Enter offers:

- `No summary`
- `Summarize`
- `Summarize with custom prompt`

Flow details:

- Escape in summary prompt reopens tree selector
- Custom prompt cancellation returns to summary choice
- During summarization, UI shows a loader and binds Esc to `abortBranchSummary()`
- If summarization aborts, tree selector reopens and no move is applied

`navigateTree` internals:

- freezes subtree admissions, checks for running/admitted work, and holds the source kernel boundary gate across the transition
- flushes pending bash output, validates the target, and collects entries from the old leaf to the common ancestor for any requested summary
- emits cancellable `session_before_tree`; an extension may supply the requested summary
- runs the default summarizer only when requested, entries need summarizing, and no hook summary was supplied
- prepares and validates the exact declared-state boundary before the destructive part of the transition
- durably journals the cut and abandoned child generations, replaces source kernels with the prepared state, and applies the selected history branch
- persists the new state boundary and node generation; the journal makes an interrupted cut recoverable on reopen
- rebuilds model context, checkpoint/rewind bookkeeping, advisor state, checklist items, and provider sessions affected by the history rewrite
- emits `session_tree` and rebuilds again if handlers may have appended entries

A failure after the durable cut has committed is not an undo: the damaged runtime is refused further execution and the committed history is recovered. Reopen the node rather than continuing stale runtime context.

If summary is requested but there is nothing to summarize, navigation proceeds without a summary entry.

## Labels

Label edits in tree UI call `appendLabelChange(targetId, label)`.

- non-empty label sets/updates resolved label
- empty label clears it
- labels are stored as append-only `label` entries
- tree nodes display resolved label state, not raw label-entry history

## Child ownership and historical branches

History remains browsable after a cut. Child ownership is decided by durable spawn-entry identity and the selected entry's ancestry, **not timestamps**:

- An earlier child's spawn anchor on the retained lineage remains valid; that child stays addressable.
- A child spawned only on the abandoned continuation, and its descendants, become **browse-only** in abandoned generations. Sends, revival and mutations are refused.
- Abandonment survives restart and is permanent for those generations. Revisiting their old history does **not** reactivate them. It is distinct from explicitly stopping/killing a node.
- A spawn racing navigation is either admitted before the freeze and prevents the cut, or refused while the subtree is frozen; it cannot silently appear outside the committed ownership graph.
- Navigating a child does not rewrite an answer already recorded in its parent's transcript. A later accepted send continues the child from its new head.

## `/tree` vs adjacent operations

| Operation | Scope | Result |
| --- | --- | --- |
| `/tree` | Selected session node | Changes its active continuation in the same transcript, with exact declared-state restoration and spawn-anchor abandonment |
| `/branch` | Selected session node | Repositions before a selected **user** message and returns it as an editable draft; retains node identity and transcript |
| `/fork` | Selected session node, at any supported depth | Constructs a fresh independent root from its active lineage and declared state, then adopts that root in the foreground |
| `/resume` | Root-session selection | Opens another persisted session |

An interactive fork leaves the source runtime, ownership tree and recorded results intact. The new root rebuilds root instructions/capabilities and has fresh scheduling/kernel ownership. Its inherited mission and lifecycle messages are history, not instructions to adopt source workers; live descendants and their transcript/artifact directories are not cloned. Readable output payloads are copied separately. The workspace remains shared: neither fork nor navigation snapshots or rolls back files, worktrees, external processes or other unmanaged resources.

### User navigation is not model `rewind`

Model [`checkpoint`/`rewind(report)`](./tools/rewind.md) compresses conversation context while keeping current computation and external state. It does not restore an earlier declared-state manifest or abandon workers just because exploratory prose was dropped. User `/tree` and `/branch` use the temporal operation described here instead.

Declared continuity is selected-data restoration, not heap/process cloning. Missing exact captures, incompatible environments, corrupt manifests and unsupported aliases/resources in declared state are visible failures before destructive navigation. See [declared state at temporal boundaries](./session-operations.md#declared-state-at-temporal-boundaries) for the declaration APIs, supported scope and restart contract.
## Operator workflows

### Re-run from an earlier user prompt without losing current branch

1. `/tree`
2. search/select earlier user message
3. choose `No summary` (or summarize if needed)
4. edit prefilled text in editor
5. submit

Effect: new branch grows from selected point within same session file.

### Leave current branch with context breadcrumb

1. enable `branchSummary.enabled`
2. `/tree` and select target node
3. choose `Summarize` (or custom prompt)

Effect: a `branch_summary` entry is appended at the target position before continuing.

### Investigate hidden bookkeeping entries

1. `/tree`
2. press `Alt+A` (all)
3. search for `model`, `thinking`, `custom`, or labels

Effect: inspect full internal timeline, not just conversational nodes.

### Bookmark pivot points for later jumps

1. `/tree`
2. move to entry
3. `Shift+L` and set label
4. later use `Alt+L` (`labeled-only`) to jump quickly

Effect: fast navigation among durable branch landmarks.
