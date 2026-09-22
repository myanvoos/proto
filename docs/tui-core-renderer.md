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
observe whether the user is reading older history. It therefore never audits,
repairs, or automatically replays a committed transcript prefix.

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
acknowledgements cannot retire it. The writer accepts a fresh batch once, writes history and the viewport, and
only then acknowledges it. A failed write must not retire application content.
Ordinary viewport updates never inspect historical text or infer new history
from a diff. A component-only TUI is a mutable viewport; applications needing
scrollback must supply explicit batches.

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
and does not discard its source. Displaceable checklist/fleet snapshots may be
replaced only while uncommitted. Once retired, changes require an explicit
replay rather than silently rewriting terminal history.

## 2. Frame pipeline

1. Composer allocates space to prompt chrome, then asks the transcript ledger
   for an eligible history transaction and the remaining live tail.
2. The renderer extracts cursor markers, normalizes width-safe rows, and
   composites overlays in viewport coordinates only.
3. A history transaction erases the old mutable area before advancing history,
   preventing old prompt/status rows from being scrolled into it by the writer.
   It writes the batch and the replacement viewport together.
4. Without new history, the renderer diffs only the mutable viewport.
5. After the terminal write succeeds, the provider acknowledges retirement.

Overlays defer history retirement; they are never part of a history batch.
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
host supports synchronized output. tmux honors ED3; hosts that ignore it may
retain older history above the newly painted transcript. An explicit replay can
move the reader to the tail. Ordinary renders and resizes never request one.

### Resize

Resize preserves host-owned native history. Committed text is not rerendered,
rewrapped by Proto, or compared using old-width physical row counts. The host
may reflow it according to its own policy. The live viewport is composed at the
new dimensions; a provider's resize-preview rendering does not acknowledge or
advance history.

The terminal's cursor report anchors the repaint after the host has moved rows.
It describes the engine's cursor, **not the user's scroll position**. The
in-place resize path waits for the host to settle; the alternate-screen path
shows a transient preview before returning to the normal buffer and probing its
anchor. Neither path retires preview rows. Preserving history means historical
wrapping and blank rows may reflect the host's reflow behavior until an explicit
reset.

A severe height shrink can move old **mutable** rows into native scrollback
before the resize callback runs. Some hosts then pad on growth instead of
pulling those rows back, especially with a visible cursor above the bottom row.
Those inaccessible snapshots cannot be removed without clearing history. Proto
preserves acknowledged history and paints the complete current viewport; it
does not infer retirement or hide current content to deduplicate host-created
snapshots. An explicit display reset rebuilds a clean transcript. Exact-once
history-batch delivery is not a promise that the host never archives a mutable
screen snapshot during resize.

## 3. Invariants

1. **History ownership is explicit.** Do not reintroduce committed-prefix
   sampling, live-region seams, physical-row watermarks, or width-epoch repair.
2. **Retirement is ordered and acknowledged after write.** Duplicate batch IDs
   cannot append twice; a failed write cannot consume the offered content.
3. **Only stable content enters history.** A mutable preview is not a frozen
   historical snapshot merely because it exceeded the viewport height.
4. **Viewport chrome never enters a history batch.** Erase old mutable rows
   before writer-controlled scrolling; keep transcript rows above prompt rows.
5. **Ordinary updates preserve history.** ED3 belongs only to explicit replay,
   never resize, a changed block, or an inferred structural mismatch.
6. **Stable identities are semantic.** Reflow cannot rename an already
   published prefix or cause it to be emitted again.
7. **Overlays do not retire covered content.** Closing one must expose the
   current viewport and then deliver any queued history exactly once.
8. **Width mismatches are nonfatal.** Use shared width helpers and clamp unsafe
   rows rather than throwing in the render hot path.
9. **Verify bytes and state transitions.** Provider unit tests alone cannot
   prove terminal cursor placement, scrollback preservation, or prompt isolation.
## 4. Terminal capability detection

`TERMINAL` (`terminal-capabilities.ts`) is resolved once at import from
`TERMINAL_ID` plus environment sniffing; detection helpers are pure over
`(env, platform)` and unit-testable.

- `shouldEnableSynchronizedOutputByDefault(env, id)` → DEC 2026 default.
  Precedence: user opt-out (`PI_NO_SYNC_OUTPUT`/`PI_TUI_SYNC_OUTPUT=0`) → user
  force-on (`PI_FORCE_SYNC_OUTPUT=1`/`PI_TUI_SYNC_OUTPUT=1`) → `TERM_FEATURES`
  advertises `Sy` → `WT_SESSION` → known direct terminals → off for risky
  multiplexers and unknowns. Reconciled at runtime by the DECRQM mode-2026
  report; a user override still wins.
- `detectRectangularSgrSupport(id, env)` → DECCARA fills: kitty only, off in
  multiplexers and under `PI_NO_DECCARA`.
- `supportsScreenToScrollback` → kitty's ED22 (used once, on the initial
  paint, to preserve the pre-existing shell screen).

The old ED3-risk classifier (`eagerEraseScrollbackRisk`, `PI_TUI_ED3_SAFE`,
`submitPinsViewportToTail`) is gone: behavior no longer depends on which
terminal is rendering, so there is no risk class to detect. Env sniffing now
only selects _optimizations_ (sync output, DECCARA, images), where a miss is
cosmetic, not corrupting.

---

## 5. Width model

`visibleWidth` / `truncateToWidth` / `sliceByColumn` / `wrapTextWithAnsi`
(`utils.ts`) all agree on **one UAX#11 width model**. Slicing, truncation,
wrapping, and segment extraction run on the native engine
(`@oh-my-pi/pi-natives`, Rust `unicode-width`); `visibleWidth` measures with
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
(Arabic harakat) survive painting verbatim, but kitty-vt-wasm's cell snapshots
expose at most two combining marks per cell — the stress harness compares those
rows with marks stripped (`sameLinesAllowingMarkDrift`).

---

## 6. The fidelity gate

Drive the renderer's real emitted ANSI into a terminal emulator. Check history
transactions separately from mutable viewport rows instead of reproducing the
old committed-prefix reconciliation math in a shadow oracle.

Coverage includes `packages/tui/src/tui-frame-sequence.test.ts`, the renderer
regression/resize/overlay/image suites, and product-level
`composer.test.ts` / `assistant-streaming-scrollback.test.ts`. Exercise:

- append, duplicate delivery, write failure, acknowledgement, and atomic replay;
- long thinking/text/tool sequences, including open Markdown and finalization;
- prompt growth/shrink, HUD updates, overlays, and width/height changes;
- unique completed content appearing exactly once, with no transcript content
  below the prompt and no prompt/status rows in writer-generated history;
- host-reflowed history unchanged by ordinary resize repaints;
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
  keyboard DA1 cannot be mistaken for an OSC 11 / DECRQM / graphics-probe
  sentinel.
- DECRQM probes (2026/2048/2031) drive runtime feature gating.

**Rule:** any new probe must own a typed sentinel and survive a split reply
(feed the reply byte-by-byte in a test and assert nothing leaks to input).

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
default-on only for kitty/ghostty (`PI_NO_KITTY_PLACEHOLDERS` /
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
| `PI_DEBUG_REDRAW=1`                                      | Log frame-provider history and viewport rendering state to the debug log.                                                                                                     |
| `PI_TUI_RESIZE_IN_PLACE=1\|0`                            | Force resize to repaint in place (no alt-screen borrow, no ED3 rewrap) on / off. Default-on for terminals that re-report size on alt-screen toggles (Warp).                 |

Removed with the old engine: `PI_TUI_ED3_SAFE` (no ED3-risk lever exists),
`PI_CLEAR_ON_SHRINK`, and `PI_TUI_DEBUG` (per-render dump superseded by
`PI_DEBUG_REDRAW` ledger logging and the stress-harness replay/reduce tooling).

---

## 10. Before changing the render core

- [ ] Does retirement come from a provider transaction rather than a row diff?
- [ ] Can a duplicate offer, write failure, resize, or overlay lose or repeat content?
- [ ] Does the writer scroll any mutable prompt/status row into native history?
- [ ] Is destructive replay limited to explicit application/user requests?
- [ ] Are stable-row identities unchanged across width changes and finalization?
- [ ] Did real emitted-byte tests cover long sequences, not just one frame?
- [ ] New capability probe: typed sentinel owner and split-reply test?
- [ ] New width path: shared helpers and nonfatal clamping?
