# Interactive memory and resource limits

Interactive mode keeps durable history separate from replay components, output buffers, and live runtimes. Compaction reduces the model context; it is not, by itself, a garbage-collection boundary for everything the UI or fleet owns.

## Policy

- Keep session history on disk and hydrate the selected context or page, rather than reconstructing the entire conversation for every redraw, compaction, or worker lookup.
- Bound retained payloads by bytes as well as counts. A short slice or a small typed-array view must own its retained storage instead of pinning a much larger backing allocation.
- Dispose resources at the end of their actual ownership: transcript components, image registrations, provider sessions, extension timers, subprocesses, pending callbacks, and worker-scope references.
- Reject excess queued work before accepting it. Do not silently evict live interpreters, pending results, or already-issued blob handles to admit unrelated work.
- Make output elision visible. Output artifacts and history access preserve their documented content limits; they are not promises of unlimited output retention.

These are admission and retention limits, **not a process-wide RSS ceiling**. Memory still includes active model context, admitted runtimes, structural session/blob metadata, transient serialization and transport buffers, native allocations, and application-created interpreter state. Durable and temporary disk usage can grow with session length.

## Conversation history and compaction

Session managers retain small structural entries and keep raw entries in temporary backing storage with an LRU capped at **64 entries and 8 MiB**. Metadata preserves graph identity, usage and tool-call identity; human-readable previews are at most 256 UTF-16 code units plus an ellipsis. Active model context hydrates only the current reset/compaction window. Normal UI transcript access selects a window using metadata before loading its message bodies.

Compaction archives append independently compressed batches instead of decompressing and rewriting every prior archived message on every compaction. Legacy archives remain readable. Reopen, branch, rewind and export preserve the saved history, and malformed archive data fails closed for destructive rewrites.

The ordinary persistence size policy is unchanged: strings exceeding **500,000 characters** are truncated in their saved representation. Their complete current-process version may exist only in the temporary entry store; it is not guaranteed after process restart or temporary-directory deletion. Signed/encrypted provider replay content and images retain their separate durable blob handling. A missing or corrupt temporary entry can fall back to its display preview, but cannot authorize overwriting the durable transcript from that preview: reopen the session before rewriting it. See [session storage](./session.md).

Explicit APIs such as `getEntries()`, `getBranch()`, `getTree()` and unwindowed transcript export still materialize the requested collection. Callers needing bounded traversal use metadata views, entry iterators, or windowed transcript access. Returning a caller-requested full array cannot have a constant-memory contract.

## Transcript, selectors and rendering

| Retained data | Default bound and behavior |
|---|---|
| Committed main-transcript replay | 1,000 blocks and 2 MiB estimated source plus rendered rows; active output is not discarded |
| Main UI history page | 256 messages and 2 MiB estimated payload, with semantic groups admitted before hydration |
| Fleet raw-file viewer window | 2 MiB serialized span, 256 semantic groups, 512 JSONL records, and 1,024 estimated render units |
| Fleet transient stream | 2 MiB estimated retained source and 256 content blocks; checked before partial argument decoding |
| Markdown rendering cache | 4,096 entries / 24 MiB total / 4 MiB per entry, counting source keys and rendered rows; oversized sources render without cache admission. Incremental fragment caches have the same accounting limits |
| Session picker and tree view | Search/ranking metadata and selected visible rows, not one component or full rendered string per historical row |

Committed blocks retire only after acknowledged emission into terminal history. Disposal clears builder pointers, layout/replay caches, image ownership and obsolete streaming/optimistic components. Message-to-component reuse is weak and restricted to components still live in the previous view.

Terminal scrollback is best effort. After replay eviction, a full redraw or width change shows an explicit **`/history` / `Alt+PgUp`** notice instead of claiming all old rows remain replayable. Fleet history opens archived pages lazily; returning to the newest page includes output received while browsing older history. Oversized records/groups show a bounded notice with reversible older/newer navigation rather than constructing all their cards first.

Offline `proto render` still emits the complete saved transcript chronologically, one page at a time, with stdout backpressure. It does not adopt the interactive recent-history cutoff.

## Fleets and queued work

Worker admission covers both active and queued workers across nested fleets. Interactive async admission defaults to **400 accepted jobs**, with **64 MiB global / 16 MiB per-owner** pending payload budgets; standalone managers derive the count from four times their running capacity. Invalid or excessive inherited prompt/schema payloads reject before a child is installed. The existing runnable-turn limit remains **32** (`orchestrator.maxConcurrency`); zero retains its existing unlimited-concurrency meaning, without disabling the separate admission budget.

Nested waits lend the parent's runnable permit and reacquire it before continuing, so concurrency one can still complete a parent/child/grandchild dependency chain. Follow-up queues and unread/in-flight steering are each limited to **32 messages / 256 KiB per worker**. Completed runtime records and observer history retain **128 recent entries per owning scope/observer**, in addition to active entries.

Parked identities and dormant records use disk-backed SQLite indexes and weak in-memory identities. Each index uses a nominal 1 MiB native page-cache target, not a total RSS bound. Persisted schemas are loaded only for the selected revival, not for every historical worker during discovery. Transcript-index caching is limited to **16 roots / 4 MiB**; active operations share ownership until their writes settle. Cold restart preserves original worker identities for accepted initial work, including the gap between a durable turn start and durable child initialization. Restoring initialized workers still requires their saved transcript rather than silently replaying an already-started task.

Empty orchestration scopes release parent sessions. Suspending a scope races safely with pending admission; disposal prevents a late loader or queued spawn from reviving it. Steering-message byte reservations include messages waiting behind another send and are released on failure/cancellation.

Async jobs bound pending/running work and retained completed results together: the default completed-result allowance is **256 records and 16 MiB**, with **8 MiB** of accepted pending delivery. Saturation rejects new work explicitly. Already-accepted deliveries are drained in batches rather than truncated; owned metadata is snapshotted rather than retaining caller mutation graphs.

## Interpreters, subprocesses and provider state

JavaScript and Python share one admission pool of **256 process-wide interpreters and 16 per creating owner**, reserving capacity before startup and retaining it until shutdown is confirmed. Queue and payload bounds are also applied to JavaScript and Python requests. Idle persistent kernels are not silently evicted just to make room; exhaustion names the capacity failure so the owner can close/restart state intentionally.

Automatic nested shell execution uses **8 reusable leased lanes per tool session**, not a fresh persistent lane per call. Leases remain occupied through actual cleanup, including cancelled asynchronous work. The existing 15-minute idle reap remains; dead kernels can be reaped even when their prior busy state is unknown. Live kernels with unknown busy status remain protected.

Owner disposal terminates JavaScript/Python subprocess resources and known descendants, cancels bridge registrations, releases require/runtime caches and callbacks, closes owned provider connections, and stops extension-managed timers. The process-group/descendant behavior has Linux regression coverage; other operating systems and unmanaged application resources need their own platform verification.

## Rich displays, browser output and blobs

Rich-display admission is enforced at first ingestion, including the JavaScript producer before IPC and shell output across all cells in a run. Existing budgets are shared across collectors:

- 64 presentation blocks and 8 images;
- 64 KiB UTF-8 text per block and 256 KiB total text;
- 4 MiB serialized rich-display/metadata budget, with at most 64 metadata records;
- explicit notices for clipped/rejected display content.

Browser and computer output uses the same bounded output sink: **50 KiB inline text** and a **4 MiB artifact** by default (3 MiB head, 1 MiB tail, plus a truncation notice). Huge return values spill rather than crossing worker IPC as an unbounded raw value. Small structured returns remain structured. Completed sink accounting includes inline buffers, artifact tails, diagnostics, image payloads and pending writes; releasing a consumer during artifact finalization does not erase unwritten output.

Blob registry resident bytes default to **256 MiB**. With durable storage, eager and lazy payloads are served from disk without retaining their bytes in the registry. Without storage, an oversized or exhausted registration fails explicitly rather than deleting an unreloadable issued handle; lazy HTTP admission failures use status **507** and remain retryable. Durable materialization releases producer closures. Blob-handle metadata and active lazy producers remain owned for handle readability, so the byte budget is not a metadata-count or total-process cap.

## Editor, paste, prompt recall and images

| Resource | Default bound |
|---|---|
| Visible draft / bracketed paste | 4 MiB UTF-8 |
| Arrow-key prompt history | 8 MiB total |
| Undo history | 16 MiB |
| Kill ring | 4 MiB / 60 entries |
| Hidden text attachments | 16 MiB / 256 entries |
| Expanded submitted prompt | 16 MiB, checked before concatenation |
| Composer images | 32 images / 32 MiB base64 aggregate |
| Blocked clipboard input | 256 KiB / 128 chunks |
| Input image | 20 MiB raw / 32 million source and target pixels |
| Native image conversion | 2 active operations, 8 waiting inputs, 160 MiB estimated waiting payload, 64 million active source-plus-target pixels |
| Terminal image residency | 128 images / 256 MiB estimated payload; default visible-image count remains 8 |
| Terminal image source / wire queues | 64 MiB encoded sources / 32 MiB wire data; 8 MiB per encoded image |
| Prompt-history retrieval | 4 MiB per prompt / 8 MiB total including metadata |

Oversized inserts and draft replacements reject instead of truncating the accepted draft. A rejected bracketed paste drains through its terminator, so rejected text cannot become accidental keystrokes. Undo, history, hidden attachments and wrap caches release old payload ownership. Queue-to-editor restoration checks both text and images before draining accepted work; failure preserves the existing draft and queue. Failed image-marker insertion rolls back its image/link ownership.

Durable prompt recall accepts expanded submissions up to 16 MiB, but over-4-MiB prompts are not replayed into the editor. SQL search ranks numeric candidate metadata before hydrating eligible strings, returning an ordered byte-admitted prefix. Legacy normalization uses file-backed streaming migration, not a full JavaScript copy of the history database; oversized legacy rows remain unchanged on disk.

File image size and pixel headers are checked before native conversion. Active native capacity remains reserved until conversion really settles, and an admission failure cannot fall back to an unbounded original image. Clipboard shell capture is bounded; an operating system's native clipboard API can still allocate internally before returning its data.

Image disposal cancels queued encodes and releases ownership. Kitty offscreen residency is evicted by bytes/count and cleared on TUI stop. **Sixel and iTerm2 do not provide the same reliable selective scrollback purge**, so host-side accounting is not a guarantee that the terminal emulator has released its native graphics memory.

## Daemon logs

Pipe/PTY daemon logging admits at most **1 MiB queued plus in-flight UTF-8 output**. Storage cannot stop draining worker pipes. If storage stalls, excess text is omitted with an ordered notice reporting the exact omitted-byte count; admission resumes after that notice. Log cursors count captured bytes and notices, not omitted bytes, so follow/rotation does not replay old content or gap markers.

Detached direct-to-file output remains independent of the broker and survives broker restart. Catch-up uses **64 KiB reads**, a persistent UTF-8 decoder and one reader per process generation. Readiness matching has bounded carry and preserves split UTF-8/ANSI sequences. Managed logs retain their existing 25 MiB current file plus one rotated file; detached direct-file logs retain their existing non-rotating disk semantics.

## Remaining scaling dimensions

- Structural session entries, archive indexes, blob handles and durable files still grow with accepted history; they are no longer equivalent to keeping every raw message or UI component resident.
- A running provider response, live application object graph, native browser/desktop process or terminal graphics cache is outside a JavaScript cache's byte accounting.
- Forced GC is useful in isolated retention regressions, not a remedy for reachable objects. Production fixes remove owners and bound admission instead of adding periodic forced GC.
- Tests cover repeated compactions, large output bursts, nested admission, cancellation/disposal races, replay eviction and actual interactive resize/history navigation. They do not establish a cross-platform native-RSS ceiling or replace an extended soak under real providers and adversarial extensions.
