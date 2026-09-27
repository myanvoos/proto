# TUI core renderer — explicit history and a mutable viewport

Companion to [`tui-runtime-internals.md`](./tui-runtime-internals.md). The
terminal engine owns bytes, cursor placement, overlays, and resize handling;
the application owns which transcript content is ready for history.

Core implementation:

- [`tui.ts`](../packages/tui/src/tui.ts): frame-provider contract, viewport diffing, history transactions, cursor placement.
- [`terminal.ts`](../packages/tui/src/terminal.ts): terminal lifecycle, capability probes, input reassembly.
- [`terminal-capabilities.ts`](../packages/tui/src/terminal-capabilities.ts): synchronized output and image capabilities.
- [`utils.ts`](../packages/tui/src/utils.ts): shared width, slicing, and wrapping.
- [`kitty-graphics.ts`](../packages/tui/src/kitty-graphics.ts) and [`components/image.ts`](../packages/tui/src/components/image.ts): inline images.

Application ownership lives in
[`Composer`](../packages/coding-agent/src/modes/composer.ts) and
[`TranscriptContainer`](../packages/coding-agent/src/modes/components/transcript-container.ts).
The terminal engine does not know about messages, tool lifecycles, or Markdown.

## 1. Ownership boundary

Native history remains on the **normal screen**: terminal scrollback and native
selection work, and the transcript remains after exit. The renderer cannot
observe whether the user is reading older history, and never uses that state to
reconcile transcript content. Ordinary viewport updates do not infer new history
from diffs; height-resize recovery can account for rows a host already archived,
and a settled width change with a frame-provider replay hook deliberately
rebuilds history at the new width.

A `TerminalFrameProvider`, installed with `TUI.setFrameProvider()`, returns a
`TerminalFramePlan` for the current `ViewportSize`:

- **`history`**, when present: an immutable `HistoryBatch` with a monotonic ID,
  physical rows at the current width, and kind `"append"` or `"replay"`.
- **`viewport`**: the bounded rows that may still change.
- **`viewportAnchor: "bottom"`**: used by Composer so the live tail and prompt
  remain bottom-aligned. The provider returns content, not padding that could
  accidentally become history.

The application keeps an offered transaction immutable until acknowledgement.
If its width or image-admission policy changes before the write, it withdraws
that offer and renders the same semantic content under a fresh ID; stale
acknowledgements cannot retire it. The writer accepts a fresh batch once, writes
history and the viewport, and only then acknowledges it; terminal-level write
failures are handled by the terminal disconnect path. Ordinary viewport updates
never inspect historical text or infer new history from a diff. A component-only
TUI is a mutable viewport; applications needing scrollback must supply explicit
batches.

### Transcript lifecycle

Each transcript block progresses through **active → settled → committed**.
Settled blocks remain visible while they fit. Under viewport pressure, the
ledger retires an ordered prefix; a later finalized block cannot jump ahead of
an active predecessor. The live suffix is bounded independently of the prompt,
status line, widgets, and overlays.

An explicitly **append-only** producer can publish stable semantic rows while
its block is still active. Row identities are independent of terminal width;
rows render at the width of the offered transaction. Assistant messages publish
closed Markdown prefixes and completed content blocks, leaving unfinished or
asynchronously relayouting content mutable. Final retirement emits only the
unpublished suffix, not a second copy of the whole message.

Mutable tool previews remain viewport-local until finalization. A large active
block may have a clipped head in the live viewport; clipping is not retirement
and does not discard its source. Displaceable checklist/jobs snapshots may be
replaced only while uncommitted. Once retired, changes require an explicit
replay rather than silently rewriting terminal history.

Committed blocks keep their components while they fit within the newest
`RETAINED_COMMITTED_BLOCKS` and `RETAINED_COMMITTED_BYTES` (2 MiB), so a replay
re-renders them with current expansion, thinking visibility, and width. When
that block/byte window trims older entries, `TranscriptContainer` removes and
disposes them rather than compacting them to row snapshots; durable session
history remains authoritative. Displaceable action cards and Kitty image owners
share this component lifetime. At replay width, retained components render at
that width, and the writer clamps each prepared row before writing.

## 2. Frame pipeline

1. Composer allocates space to prompt chrome, then asks the transcript ledger
   for an eligible history transaction and the remaining live tail.
2. The renderer extracts cursor markers, normalizes width-safe rows, and
   composites overlays in viewport coordinates only.
3. A history transaction erases the old mutable area before advancing history,
   preventing old prompt/status rows from being scrolled into it by the writer.
   It writes the batch and the replacement viewport together.
4. Without new history, the renderer diffs only the mutable viewport.
5. After the terminal write call, the provider acknowledges retirement.

Fullscreen overlays defer queued history retirement; inline overlays are
composited into the mutable viewport and never enter a history batch.
Cursor placement belongs inside the synchronized-output frame, not a second
write after it. Fullscreen and resize preview surfaces may borrow the alternate
screen without changing normal-screen history ownership.

### Explicit replay

`resetDisplay()` and `requestRender(true, { clearScrollback: true })` deliberately
replace history: for example, session replacement, branch navigation, or a user
expanding already-retired tool output. The provider resets its publication state
and offers one replay transaction containing the eligible transcript prefix,
with the mutable suffix in the same frame's viewport. Do not replay one block
per frame: that exposes intermediate transcripts and repeats the header.

The replay uses ED3 (`CSI 3 J`) and overwrites the display atomically where the
host supports synchronized output. Multiplexer panes may ignore ED3; hosts that
ignore it can retain older history above the newly painted transcript. An
explicit replay can move the reader to the tail. Ordinary renders and
height-only resizes never request one; a settled width change with a provider
replay hook does.

### Resize

Height-only resize preserves host-owned native history. A settled width change
with a frame provider that implements `beginHistoryReplay()` deliberately
requests a scrollback clear and replays the retained ledger at the new width;
without that hook, the host's own reflow remains. The live viewport is composed
at the new dimensions; a provider's resize-preview rendering does not
acknowledge or advance history.

The terminal's cursor report anchors the repaint after the host has moved rows.
It describes the engine's cursor, **not the user's scroll position**. The
in-place resize path waits for the host to settle; the alternate-screen path
shows a transient preview before returning to the normal buffer and probing its
anchor. Neither path retires preview rows. Height-only preservation means
historical wrapping and blank rows may reflect the host's reflow behavior;
width-changing resizes deliberately replace that history after the settle/replay
path.

A severe height shrink can move old **mutable** rows into native scrollback
before the resize callback runs. Some hosts then pad on growth instead of
pulling those rows back, especially with a visible cursor above the bottom row.
Snapshots whose provenance cannot be proven cannot be removed without clearing
history. Proto preserves acknowledged history and paints the complete current
viewport. When a resize pushes a whole, provably final live span into scrollback,
the provider may account for it through `retireArchivedRows()` and avoid writing
it again; partial or unproven rows stay live. Proto does not hide current content
to deduplicate host-created snapshots. An explicit display reset rebuilds a
clean transcript. Exact-once history-batch delivery is not a promise that the
host never archives a mutable screen snapshot during resize.

## 3. Invariants

1. **History ownership is explicit.** Do not reintroduce committed-prefix
   sampling, live-region seams, physical-row watermarks, or width-epoch repair.
2. **Retirement is ordered and acknowledged after the terminal write call.**
   Duplicate batch IDs cannot append twice; an offered batch remains pending
   until acknowledgement.
3. **Only stable content enters history.** A mutable preview is not a frozen
   historical snapshot merely because it exceeded the viewport height.
4. **Mutable viewport chrome never enters a history batch.** Composer may
   intentionally put welcome/header rows into history; erase old prompt/status
   rows before writer-controlled scrolling and keep transcript rows above them.
5. **Ordinary updates preserve history.** ED3 belongs only to a deliberate
   replay request, including the settled width-change replay; never height-only
   resize, a changed block, or an inferred structural mismatch.
6. **Stable identities are semantic.** Reflow cannot rename an already
   published prefix or cause it to be emitted again.
7. **Overlays do not enter history batches.** Fullscreen overlays defer queued
   retirement; closing one must expose the current viewport and then deliver
   queued history exactly once.
8. **Width mismatches are nonfatal.** Use shared width helpers and clamp unsafe
   rows rather than throwing in the render hot path.
9. **Verify bytes and state transitions.** Provider unit tests alone cannot
   prove terminal cursor placement, scrollback preservation, or prompt isolation.
## 4. Terminal capability detection

`TERMINAL` (`terminal-capabilities.ts`) is resolved once at import from
`TERMINAL_ID` plus environment sniffing. Capability predicates accept supplied
environment and terminal-ID inputs for unit tests; terminal-ID detection may
query the local tmux server once.

- `shouldEnableSynchronizedOutputByDefault(env, id)` → DEC 2026 default.
  Precedence: user opt-out (`PI_NO_SYNC_OUTPUT`/`PI_TUI_SYNC_OUTPUT=0`) → user
  force-on (`PI_FORCE_SYNC_OUTPUT=1`/`PI_TUI_SYNC_OUTPUT=1`) → `TERM_FEATURES`
  advertises `Sy` → Herdr pane → off for other multiplexers → known direct
  terminals → off for unknowns. Reconciled at runtime by the DECRQM mode-2026
  report; a user override still wins, and inside Herdr only an unrecognized
  (status 0) report keeps it on.
- `detectRectangularSgrSupport(id, env)` → DECCARA fills: kitty only, off in
  multiplexers and under `PI_NO_DECCARA`.
- `detectStyledUnderlineSupport(id, env)` → colon-form curly underline plus
  SGR 58/59 color: kitty, Ghostty, WezTerm, iTerm2 ≥ 3.5; never under a
  multiplexer. Others get plain `CSI 4 m`/`CSI 24 m`.

Inside tmux the pane environment identifies tmux rather than the attached
emulator. When `TERM_PROGRAM` is not a recognized terminal, detection asks the
local tmux server once for `#{client_termtype}` (500 ms cap) and maps the
client name through the same table; a missing `tmux` binary or reply keeps the
environment fallback.

The old ED3-risk classifier (`eagerEraseScrollbackRisk`, `PI_TUI_ED3_SAFE`,
`submitPinsViewportToTail`) is gone: history no longer has a terminal risk class.
Environment and identity probes select capability/optimization paths (sync
output, DECCARA, images, hyperlinks, styled underlines, notifications); a miss
changes a capability or appearance, not history ownership.

---

## 5. Width model

`visibleWidth` / `truncateToWidth` / `sliceByColumn` / `wrapTextWithAnsi`
(`utils.ts`) all agree on **one UAX#11 width model**. Slicing, truncation,
wrapping, and segment extraction run on the native engine
(`@oh-my-pi/pi-natives`, Rust `xutf`/`UnicodeWidthStr`); `visibleWidth` measures with
`Bun.stringWidth` **pinned to that same model** (`STRING_WIDTH_OPTS`:
`countAnsiEscapeCodes: false`, `ambiguousIsNarrow: true`) — a JSC builtin that
shares the native width tables without the per-call N-API box the native
scanner traps on under Bun 1.3.x. The two must never disagree; mixing unpinned
width models in measure-vs-slice produced crashes.

- Fast path: printable ASCII is one cell per code unit.
- Anything past the ASCII prefix measures through `Bun.stringWidth` (CSI/OSC
  stripped to zero); tabs are added back at the fixed `DEFAULT_TAB_WIDTH` columns.
- OSC 66 sized spans are added back as `scale × (explicit w ?? payload width)` —
  `Bun.stringWidth` would otherwise strip the whole span to zero.

**Rule:** any new measuring code routes through these helpers, and the hot
path clamps instead of throwing. Known residual: combining-heavy scripts
(Arabic harakat) can be over-counted by the native width model, so non-ASCII
rewrites erase the row before painting to avoid stale trailing cells.

---

## 6. The fidelity gate

Drive the renderer's real emitted ANSI into a terminal emulator. Check history
transactions separately from mutable viewport rows instead of reproducing the
old committed-prefix reconciliation math in a shadow oracle.

Coverage includes `packages/tui/src/tui-frame-sequence.test.ts`, the renderer
regression/resize/overlay/image suites, and product-level
`packages/coding-agent/src/modes/composer.test.ts` /
`packages/coding-agent/src/modes/components/assistant-streaming-scrollback.test.ts`.
Exercise:

- append, duplicate delivery, write failure, acknowledgement, and atomic replay;
- long thinking/text/tool sequences, including open Markdown and finalization;
- prompt growth/shrink, HUD updates, overlays, and width/height changes;
- unique completed content appearing exactly once, with no transcript content
  below the prompt and no prompt/status rows in writer-generated history;
- host-reflowed history unchanged by ordinary height-only resize repaints;
  settled width changes intentionally replay at the new width;
- synchronized-output/autowrap discipline and hardware cursor placement.

Run an actual interactive CLI surface as well as deterministic tests. A
single happy-path render does not establish long-session correctness.

---

## 7. Capability probes & stdin reassembly

`ProcessTerminal` fuses capability queries with a bare DA1 (`CSI c`) sentinel so
a non-answering terminal is detected when DA1 returns first. Replies can arrive
**split across a stdin flush**, so:

- `#privateCsiResponseBuffer` accumulates `\x1b[?…` partials while a sentinel is
  outstanding, rejoins on the terminator byte, then runs the handlers on the
  **complete** reply. A new `\x1b` mid-reassembly or >256 bytes abandons the
  partial so real keys still reach input.
- `#da1SentinelOwners` is a **typed FIFO** discriminated by `kind` so a
  keyboard DA1 cannot be mistaken for an OSC 11 / DECRQM / OSC 99 /
  cursor-position sentinel.
- DECRQM probes (2026, 2048, 2031, 2004, and xterm 1010/1011) drive runtime
  feature gating.

**Rule:** any new probe must own a typed response route (a DA1 owner when it
uses a DA1 sentinel) and survive a split reply (feed the reply byte-by-byte in a
test and assert nothing leaks to input).

---

## 8. Inline images & memory

Kitty images are **transmit-once, place-many** (`kitty-graphics.ts`).
`ImageBudget` keeps only the most-recent N images live; when the cap is
exceeded the demoted image's pixels are deleted by id (`a=d,d=I`) and its
visible rows re-render as the text fallback through the ordinary window diff —
**no destructive replay**. A demoted placement already committed to history
simply loses its pixels (committed rows are immutable), and the text fallback
is **height-preserving** once a graphic has rendered (reserved rows + fallback
line), so demotion never shrinks the block and never shifts committed content
below it.

**Rule:** never re-emit full base64 per frame. Kitty Unicode placeholders are
default-on for kitty, Ghostty, otty, and rio (`PI_NO_KITTY_PLACEHOLDERS` /
`PI_KITTY_PLACEHOLDERS`).

---

## 9. Escape hatches (env vars)

| Var                                                      | Effect                                                                                                                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_NO_SYNC_OUTPUT=1`                                    | Disable DEC 2026 BSU/ESU wrappers (autowrap discipline stays on).                                                                                                           |
| `PI_TUI_SYNC_OUTPUT=0\|1` / `PI_FORCE_SYNC_OUTPUT=1`     | Force sync output off / on.                                                                                                                                                 |
| `PI_NO_DECCARA`                                          | Disable Kitty DECCARA rectangular-fill optimization.                                                                                                                        |
| `PI_FORCE_IMAGE_PROTOCOL=kitty\|iterm2\|sixel\|off`      | Override image protocol detection.                                                                                                                                          |
| `PI_NO_KITTY_PLACEHOLDERS=1` / `PI_KITTY_PLACEHOLDERS=1` | Force Kitty Unicode placeholders off / on.                                                                                                                                  |
| `PI_HARDWARE_CURSOR=1`                                   | Show the real hardware cursor instead of a rendered one.                                                                                                                    |
| `PI_NOTIFICATIONS=off\|0\|false`                         | Suppress terminal notifications.                                                                                                                                            |
| `PI_DEBUG_REDRAW=1`                                      | Log resize-anchor recovery details (CPR, stale rows, and the resolved anchor) to the debug log.                                                                                 |
| `PI_TUI_RESIZE_IN_PLACE=1\|true` / `0\|false`             | Force resize settlement to repaint in place (no alternate-screen borrow); width changes still use the provider replay/ED3 path when available. Unset defaults to in-place only for Warp outside multiplexers. |

Removed with the old engine: `PI_TUI_ED3_SAFE` (no ED3-risk lever exists),
`PI_CLEAR_ON_SHRINK`, and `PI_TUI_DEBUG` (the per-render dump is superseded by
`PI_DEBUG_REDRAW` resize-anchor logging).

---

## 10. Before changing the render core

- [ ] Does retirement come from a provider transaction rather than a row diff?
- [ ] Can a duplicate offer, write failure, resize, or overlay lose or repeat content?
- [ ] Does the writer scroll any mutable prompt/status row into native history?
- [ ] Is destructive replay limited to explicit application/user requests or
      settled width changes?
- [ ] Are stable-row identities unchanged across width changes and finalization?
- [ ] Did real emitted-byte tests cover long sequences, not just one frame?
- [ ] New capability probe: typed sentinel owner and split-reply test?
- [ ] New width path: shared helpers and nonfatal clamping?
