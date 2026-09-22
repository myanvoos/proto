# TUI runtime internals

This document maps the non-theme runtime path from terminal input to rendered output in interactive mode. It focuses on behavior in `packages/tui` and its integration from `packages/coding-agent` controllers.

> **Editing the rendering engine itself?** Read
> [`tui-core-renderer.md`](./tui-core-renderer.md) first — it documents the
> failure modes (yank / corruption / flash / width crashes) and the invariants
> the render planner, native-scrollback bookkeeping, and capability detection
> must not violate.

## Runtime layers and ownership

- **`packages/tui` engine**: terminal lifecycle, stdin normalization, focus routing, render scheduling, differential painting, overlay composition, hardware cursor placement.
- **`packages/coding-agent` interactive mode**: builds component tree, binds editor callbacks and keymaps, reacts to agent/session events, and translates domain state (streaming, tool execution, retries) into UI components.

Boundary rule: the TUI engine is message-agnostic. It accepts explicit history batches and a mutable viewport from `TerminalFrameProvider`, plus component input, focus, and overlays. Composer and the transcript ledger own message lifecycle and retirement; agent semantics stay in interactive controllers.

## Implementation files

- [`packages/coding-agent/src/modes/interactive-mode.ts`](../packages/coding-agent/src/modes/interactive-mode.ts)
- [`packages/coding-agent/src/modes/session-teardown.ts`](../packages/coding-agent/src/modes/session-teardown.ts)
- [`packages/coding-agent/src/modes/controllers/event-controller.ts`](../packages/coding-agent/src/modes/controllers/event-controller.ts)
- [`packages/coding-agent/src/modes/controllers/input-controller.ts`](../packages/coding-agent/src/modes/controllers/input-controller.ts)
- [`packages/coding-agent/src/modes/components/custom-editor.ts`](../packages/coding-agent/src/modes/components/custom-editor.ts)
- [`packages/tui/src/tui.ts`](../packages/tui/src/tui.ts)
- [`packages/tui/src/terminal.ts`](../packages/tui/src/terminal.ts)
- [`packages/tui/src/editor-component.ts`](../packages/tui/src/editor-component.ts)
- [`packages/tui/src/stdin-buffer.ts`](../packages/tui/src/stdin-buffer.ts)
- [`packages/tui/src/components/loader.ts`](../packages/tui/src/components/loader.ts)

## Boot and component tree assembly

`InteractiveMode` creates a `Composer` backed by `TUI` and `ProcessTerminal`, applies hardware-cursor, inline-image, and Kitty text-sizing preferences, then mounts persistent containers:

- `chatContainer`
- `pendingMessagesContainer`
- `statusContainer`
- `checklistContainer`
- `subagentContainer`
- `btwContainer`
- `errorBannerContainer`
- `modelCycleContainer` (ctrl+p model-role cycle chip track)
- `statusLine`
- `hookWidgetContainerAbove`
- `editorContainer` (holds `CustomEditor`)
- `hookWidgetContainerBelow`

`init()` mounts header, transcript, and prompt chrome through Composer, which installs itself as the frame provider. It focuses the editor, registers input handlers via `InputController`, starts TUI, pushes terminal title state, updates the editor border, and requests a forced render.
A forced render (`requestRender(true)`) queues a viewport repaint or explicit session replacement; it does **not** throw away previous-line history by default.

## Terminal lifecycle and stdin normalization

`ProcessTerminal.start()`:

1. Enables raw mode and bracketed paste.
2. Attaches resize handler and refreshes dimensions.
3. Enables Windows VT input mode when running on win32.
4. Creates a `StdinBuffer` to split partial escape chunks into complete sequences.
5. Queries Kitty keyboard protocol support (`CSI ? u`), then enables protocol flags if supported; otherwise enables modifyOtherKeys fallback after a short timeout.
6. Queries OSC 11 background color and Mode 2031 appearance notifications for dark/light theme detection.
7. Queries OSC 99 notification capabilities.
8. Starts periodic OSC 11 polling only where safe, then probes DEC private modes 2026/2048/2031 via DECRQM.

`StdinBuffer` behavior:

- Buffers fragmented escape sequences (CSI/OSC/DCS/APC/SS3).
- Emits `data` only when a sequence is complete or timeout-flushed.
- Detects bracketed paste and emits a `paste` event with raw pasted text.

This prevents partial escape chunks from being misinterpreted as normal keypresses.

### Shutdown and terminal handoff

Exit from double `Ctrl+C`, empty-editor `Ctrl+D`, `/exit`, and postmortem signals converges on a promise-memoized session teardown. The first caller wins: it snapshots the editor draft, calls `beginDispose()` synchronously, attempts to save the draft, and then disposes the session. A draft-save failure is logged but does not skip disposal; later keypress or signal callers await the same promise and cannot double-run shutdown.

Interactive shutdown then follows this ownership order:

1. `InteractiveMode` stops live commands and transient controllers, displays the closing status, and awaits session disposal before handing the terminal back.
2. It drains in-flight Kitty input for up to one second so release sequences do not leak into the parent shell.
3. It disposes the run-state title/spinner state and restores the prior terminal title before stopping the UI.
4. `TUI.stop()` leaves resize/fullscreen alternate-screen state, purges image/probe state, stops watchdog and render/resize timers, positions and forcibly restores the cursor, then delegates to `ProcessTerminal.stop()`.
5. `ProcessTerminal.stop()` restores real stderr and terminal modes, disables keyboard/mouse/appearance protocols, clears probes and timers, destroys `StdinBuffer`, removes stdin/stdout listeners, pauses stdin, and restores its previous raw-mode state.

Terminal disconnects mark the terminal dead and stop interactive rendering. Cleanup still removes owned state, but raw-mode restoration errors are suppressed only for that dead-terminal case because there is no live TTY left to restore.

Suspend is distinct from exit: `Ctrl+Z` stops the TUI to release terminal modes, sends `SIGTSTP`, and retains the session. Its one-shot `SIGCONT` handler starts the TUI again and forces a repaint; it does not run session teardown or terminal handoff to a parent shell.

## Input routing and focus model

Input path:

`stdin -> ProcessTerminal -> StdinBuffer -> TUI.#handleInput -> focusedComponent.handleInput`

Routing details:

1. TUI runs registered input listeners first (`addInputListener`), allowing consume/transform behavior.
2. TUI handles global debug shortcut (`shift+ctrl+d`) before component dispatch.
3. If focused component belongs to an overlay that is now hidden/invisible, TUI reassigns focus to next visible overlay or saved pre-overlay focus.
4. Key release events are filtered unless focused component sets `wantsKeyRelease = true`.
5. After dispatch, TUI schedules render.

`setFocus()` also toggles `Focusable.focused`, which controls whether components emit `CURSOR_MARKER` for hardware cursor placement.

## Key handling split: editor vs controller

`CustomEditor` intercepts high-priority combos first (escape, ctrl-c/d/z, ctrl-v, ctrl-p variants, ctrl-t, alt-up, extension custom keys) and delegates the rest to base `Editor` behavior (text editing, history, autocomplete, cursor movement).

`InputController.setupKeyHandlers()` then binds editor callbacks to mode actions:

- cancellation / mode exits on `Escape`
- shutdown on double `Ctrl+C` or empty-editor `Ctrl+D`
- suspend/resume on `Ctrl+Z`
- slash-command and selector hotkeys
- follow-up/dequeue toggles and expansion toggles

This keeps key parsing/editor mechanics in `packages/tui` and mode semantics in coding-agent controllers.

## Render loop and explicit history ownership

`TUI.requestRender()` coalesces requests under a budgeted cadence. Ordinary frames
wait `max(1000/60, min(200ms, 2 × previous frame cost))`; input-driven frames have
an 8ms floor. A forced render repaints the viewport; `clearScrollback` requests
an explicit destructive replay. Component/direct-write requests must preserve
the provider's history ownership and fall back to a scheduled frame when unsafe.

1. Composer allocates prompt chrome and asks its transcript ledger for an
   ordered, eligible history batch and a bounded live tail.
2. TUI prepares width-safe viewport rows, extracts cursor markers, and composites
   overlays. Visible overlays defer history retirement.
3. New history is written with the replacement viewport in one transaction;
   without history, only mutable viewport rows are diffed.
4. The provider acknowledges the batch after the terminal write succeeds.

Transcript blocks progress from active to settled to committed. Completed
blocks can remain in the viewport until space is needed. Append-only assistant
blocks publish closed Markdown/content prefixes with semantic identities;
mutable previews cannot enter history merely because they are tall. Final
retirement writes only the suffix not previously published.

`resetDisplay()` gestures, including tool expansion of historical output, reset
publication and replay the eligible transcript prefix with its current viewport
atomically. Ordinary updates never audit or repair historical text.

Writes use synchronized output (`CSI ? 2026 h/l`) when enabled. Disabling its
wrappers leaves autowrap discipline intact. See
[`tui-core-renderer.md`](./tui-core-renderer.md) for the complete contract.

## Render safety constraints

Critical safety checks in `TUI`:

- Non-image rendered lines are expected to fit terminal width; the differential path truncates overwide lines as a last-resort guard and can write debug diagnostics when redraw debugging is enabled.
- Overlay compositing includes defensive truncation and post-composite width guarding.
- Width changes force repaint/rebuild planning because wrapping semantics change.
- Cursor position is clamped before movement.

These constraints are runtime guards plus component conventions; renderers should still return width-safe lines rather than rely on truncation.

The deeper reasons these guards exist — why the renderer cannot observe scroll
position, why ED3 (`CSI 3 J`) is confined to one path, and why the hot path
clamps instead of throwing — are documented in
[`tui-core-renderer.md`](./tui-core-renderer.md).

## Resize handling

`ProcessTerminal` resize events schedule a render at the new dimensions. Native
history remains host-owned; Proto neither clears it nor tries to reconcile
old-width physical row coordinates. The mutable viewport and prompt are
recomposed at the current width. Resize-preview frames do not retire content.

Multiplexers and direct HerdR panes repaint in place. Terminals whose alternate
buffer changes reported geometry also use the in-place path; other terminals
may borrow the alternate screen for drag previews. Cursor reports anchor the
repaint after host reflow rather than probing the reader's scroll position.
`PI_TUI_RESIZE_IN_PLACE` controls the preview strategy, not history replay.

Overlay visibility may depend on dimensions; focus is corrected when an overlay
becomes non-visible after resize. Explicit display reset is separate from resize
and is the only way to request a rebuilt historical layout.

## Streaming and incremental UI updates

`EventController` subscribes to `AgentSessionEvent` and updates UI incrementally:

- `agent_start`: starts loader in `statusContainer`.
- `message_start` assistant: creates `streamingComponent` and mounts it.
- `message_update`: updates streaming assistant content; creates/updates tool execution components as tool calls appear.
- `tool_execution_update/end`: updates tool result components and completion state.
- `message_end`: finalizes assistant stream, handles aborted/error annotations, marks pending tool args complete on normal stop.
- `agent_end`: stops loaders, clears transient stream state, flushes deferred model switch, issues completion notification if backgrounded.

Read-tool grouping is intentionally stateful (`#lastReadGroup`) to coalesce consecutive read tool calls into one visual block until a non-read break occurs.

## Status and loader orchestration

Status lane ownership:

- `statusContainer` holds transient loaders (`loadingAnimation`, `autoCompactionLoader`, `retryLoader`).
- `statusLine` renders persistent status/hook indicators and drives editor top border updates.

Loader behavior:

- `Loader` advances its spinner every 80ms (animated message colorizers redraw at ~30fps) and uses the direct-write path for quiet fixed-height frames, with automatic fallback to a component-scoped render when direct rewriting is unsafe.
- Escape cancels an in-progress auto-compaction or auto-retry: the editor's single `onEscape` handler dispatches on live session state (`isCompacting`/`isRetrying`) and calls the matching abort method, rather than swapping the handler.
- On end/cancel paths, controllers stop/clear the loader components.

## Mode transitions and backgrounding

### Bash/Python input modes

Input text prefixes toggle editor border mode flags:

- `!` -> bash mode
- `$` (non-template literal prefix) -> python mode

Escape exits inactive mode by clearing editor text and restoring border color; when execution is active, escape aborts the running task instead.

### Suspend/resume (`Ctrl+Z`)

`InputController.handleCtrlZ()`:

1. Registers one-shot `SIGCONT` handler to restart TUI and force render.
2. Stops TUI before suspend.
3. Sends `SIGTSTP` to process group.

## Cancellation paths

Primary cancellation inputs:

- `Escape` during active stream loader: restores queued messages to editor and aborts agent.
- `Escape` during bash/python execution: aborts running command.
- `Escape` during auto-compaction or auto-retry: the editor's `onEscape` dispatches on live session state (`isCompacting`/`isRetrying`) and calls the matching abort method (`abortCompaction`/`abortRetry`).
- `Ctrl+C` single press: clear editor; double press within 500ms: shutdown.

Cancellation is state-conditional; same key can mean abort, mode-exit, selector trigger, or no-op depending on runtime state.

## Event-driven vs throttled behavior

Event-driven updates:

- Agent session events (`EventController`)
- Key input callbacks (`InputController`)
- terminal resize callback
- terminal appearance callbacks, SIGWINCH theme reevaluation, and git branch watchers in `InteractiveMode`

Throttled/debounced paths:

- TUI rendering uses coalescing and budgeted cadence with adaptive backpressure from render cost.
- Loader animation is interval-driven (80ms spinner advance; ~30fps when the message colorizer is animated), using direct writes when safe and component-scoped renders otherwise.
- Editor autocomplete updates (inside `Editor`) use debounce timers, reducing recompute churn during typing.

The runtime therefore mixes event-driven state transitions with bounded render cadence to keep interactivity responsive without repaint storms.
