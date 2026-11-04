# Interactive memory and resource limits

Interactive mode keeps durable history separate from replay components, output buffers, and live runtimes. Compaction reduces the model context; it is not, by itself, a garbage-collection boundary for everything the UI or fleet owns.

## Policy

- Keep session history on disk and hydrate the selected context or page, rather than reconstructing the entire conversation for every redraw, compaction, or worker lookup.
- Bound retained payloads by bytes as well as counts. A short slice or a small typed-array view must own its retained storage instead of pinning a much larger backing allocation.
- Dispose resources at the end of their actual ownership: transcript components, image registrations, provider sessions, extension timers, subprocesses, pending callbacks, and worker-scope references.
- Release per-call state when the call settles, on every path (success, error, abort, background handoff), not when its session ends.
- Remove abort listeners when the operation settles. A listener left on an `AbortSignal.any` composite or a long-lived signal keeps the listener and its closure alive for as long as the source signal lives, including a `{ once: true }` listener that never fires. `AbortSignal.timeout` cannot be cancelled; use a cleared timer when the race usually ends early.
- Deferred callbacks capture their whole enclosing scope. Schedule long-lived timers with `setTimeout(fn, ms, ...args)` or a bound method instead of an inline closure created beside large per-run state.
- Reject excess queued work before accepting it. Do not silently evict live interpreters, pending results, or already-issued blob handles to admit unrelated work.
- Make output elision visible. Output artifacts and history access preserve their documented content limits; they are not promises of unlimited output retention.

These are admission and retention limits, **not a process-wide RSS ceiling**. Memory still includes active model context, admitted runtimes, structural session/blob metadata, transient serialization and transport buffers, native allocations, and application-created interpreter state. Durable and temporary disk usage can grow with session length.

## Conversation history and compaction

Session managers retain small structural entries and keep raw entries in temporary backing storage with an LRU capped at **64 entries and 8 MiB**. Metadata preserves graph identity, usage and tool-call identity; human-readable previews are at most 256 UTF-16 code units plus an ellipsis. Active model context hydrates only the current reset/compaction window. Normal UI transcript access selects a window using metadata before loading its message bodies.

Parking a runtime flushes its journal and discards the disposable hydrated-entry cache, even when the registry keeps that journal available to descendants. Structural metadata, compressed temporary entries, blobs and caller-owned snapshots survive. Later history reads or descendant writes can hydrate the cache again; parking does not seal or close the shared journal.

Compaction archives append independently compressed batches instead of decompressing and rewriting every prior archived message on every compaction. Legacy archives remain readable. Reopen, branch, rewind and export preserve the saved history, and malformed archive data fails closed for destructive rewrites.

The ordinary persistence size policy is unchanged: strings exceeding **500,000 characters** are truncated in their saved representation. Their complete current-process version may exist only in the temporary entry store; it is not guaranteed after process restart or temporary-directory deletion. Signed/encrypted provider replay content, images, and declared-state manifests retain their separate lossless durable blob handling; declared state is not truncated into a history preview. A missing or corrupt temporary entry can fall back to its display preview, but cannot authorize overwriting the durable transcript from that preview: reopen the session before rewriting it. See [session storage](./session.md).

Explicit APIs such as `getEntries()`, `getBranch()`, `getTree()` and unwindowed transcript export still materialize the requested collection. Callers needing bounded traversal use metadata views, entry iterators, or windowed transcript access. Returning a caller-requested full array cannot have a constant-memory contract.

## Transcript, selectors and rendering

| Retained data | Default bound and behavior |
|---|---|
| Committed main-transcript replay | 2,000 blocks and 4 MiB estimated source plus rendered rows; active output is not discarded |
| Main UI history page | 512 messages and 4 MiB estimated payload, with semantic groups admitted before hydration |
| Fleet raw-file viewer window | 4 MiB serialized span, 512 semantic groups, 1,024 JSONL records, and 2,048 estimated render units |
| Fleet transient stream | 4 MiB estimated retained source and 512 content blocks; checked before partial argument decoding |
| Global Markdown rendering cache | 4,096 entries / 10 MiB total / 4 MiB per entry; oversized sources render without cache admission. Per-instance incremental fragment caches retain their separate 24 MiB / 4 MiB-per-fragment limits |
| Global output-block rendering cache | 4,096 entries / 10 MiB total / 4 MiB per entry |
| Global wrapping / truncation caches | 6 MiB / 2 MiB respectively, each also capped at 512 entries |
| Node/RPC history page | At most 512 messages and a 1,536 KiB page budget; typed node pages preserve semantic groups and omit oversized indivisible groups visibly |
| Session picker and tree view | Search/ranking metadata and selected visible rows, not one component or full rendered string per historical row |

The four global rendering caches have a combined **28 MiB accounted allowance**, not a process-memory ceiling. Accounting conservatively includes UTF-16 text, keys, string overhead and row/container storage rather than treating JavaScript string length as bytes. Entries unused for 60 seconds are removed by an unreferenced sweep on a 30-second cadence; hits refresh their age. Sweeps stop when a cache becomes empty, do not keep the CLI alive, and do not alter rendered output or discard source history. Active component-local state remains separately owned.

Committed blocks retire only after acknowledged emission into terminal history. Disposal clears builder pointers, layout/replay caches, image ownership and obsolete streaming/optimistic components. Message-to-component reuse is weak and restricted to components still live in the previous view.

Terminal scrollback is best effort. After replay eviction, a full redraw or width change shows an explicit **`/history` / `Alt+PgUp`** notice instead of claiming all old rows remain replayable. Fleet history opens archived pages lazily; returning to the newest page includes output received while browsing older history. Oversized records/groups show a bounded notice with reversible older/newer navigation rather than constructing all their cards first.

The doubled history windows do not change active-work queues, tree metadata pages, result retention or interpreter admission. Typed node protocol 3 and both bundled RPC clients use the matching expanded history-page contract; the legacy v1 physical-frame ceiling is unchanged.

Offline `proto render` still emits the complete saved transcript chronologically, one page at a time, with stdout backpressure. It does not adopt the interactive recent-history cutoff.

## Fleets and queued work

Worker admission covers both active and queued workers across nested fleets. Interactive async admission defaults to **400 accepted jobs**, with **64 MiB global / 16 MiB per-owner** pending payload budgets; standalone managers derive the count from four times their running capacity. Invalid or excessive inherited prompt/schema payloads reject before a child is installed. The existing runnable-turn limit remains **32** (`orchestrator.maxConcurrency`); zero retains its existing unlimited-concurrency meaning, without disabling the separate admission budget.

Nested waits lend the parent's runnable permit and reacquire it before continuing, so concurrency one can still complete a parent/child/grandchild dependency chain. Follow-up queues and unread/in-flight steering are each limited to **32 messages / 256 KiB per worker**. Completed runtime records and observer history retain **128 recent entries per owning scope/observer**, in addition to active entries.

Parked identities and dormant records use disk-backed SQLite indexes and weak in-memory identities. Each index uses a nominal 1 MiB native page-cache target, not a total RSS bound. Persisted schemas are loaded only for the selected revival, not for every historical worker during discovery. Transcript-index caching is limited to **16 roots / 4 MiB**; active operations share ownership until their writes settle. Cold restart preserves original worker identities for accepted initial work, including the gap between a durable turn start and durable child initialization. Restoring initialized workers still requires their saved transcript rather than silently replaying an already-started task.

Runtime release drops the expensive parent session without stopping its descendants or their result delivery. Explicit subtree/tree shutdown remains a separate operation. Parked-parent lifecycle and usage receipts atomically carry the exact immutable state manifest forward with their metadata, so receiving a grandchild result does not erase the parent's restorable computation. Steering-message byte reservations include messages waiting behind another send and are released on failure/cancellation.

Async jobs bound pending/running work and retained completed results together: the default completed-result allowance is **256 records and 16 MiB**, with **8 MiB** of accepted pending delivery. Saturation rejects new work explicitly. Already-accepted deliveries are drained in batches rather than truncated; owned metadata is snapshotted rather than retaining caller mutation graphs.

## Interpreters, subprocesses and provider state

The Python execution overhaul described here is **unreleased**; it is not part of the original v20.0.2/P5 delivery. Ordinary Python commands now start real fresh processes, including `python -c`, stdin/heredocs, scripts, aliases, shebangs, subprocesses, interactive `$` / `$$` submissions and the fresh `executePython` API. There is no implicit warm dispatch, helper injection or declaration requirement. Native argv, binary stdin/stdout/stderr, exit status, signals, imports and process-exit behavior remain Python's own.

Explicit host integration uses `import proto_harness as harness`. The managed agent-shell environment makes this package available without changing the user's installed Python; `-I`, `-E` and `-S` remain native opt-outs from that environment integration. Helpers are authenticated to their owning run/session and retain host tool authority, cancellation and admission policy. Use `harness.fs` for permission-checked, atomic, stale-guarded file operations; ordinary Python file APIs retain native semantics.

### Fresh processes, durable store and optional warm kernels

These are separate choices:

- **Fresh Python:** normal commands retain no hidden globals across processes.
- **Durable values:** `harness.store` is a session-owned mapping serialized as one rich Python graph. Assignment/deletion commits the whole graph with a revision compare-and-swap (CAS); a stale writer fails instead of overwriting another process. `refresh()` reloads the current graph; `commit()` persists in-place mutations. `transaction()` batches updates into one commit, not a cross-process lock or filesystem transaction.
- **Warm namespace:** `harness.kernel("analysis", interpreter=None, cwd=None, target=None)` returns an explicit named handle with `run(code)`, `exec(file)`, `status()`, `stop()` and `restart()`. Alternatively, use `python -m proto_harness.kernel analysis -c '...'`, `--file script.py`, or code on stdin. Each warm namespace still imports `proto_harness` explicitly. Nested named kernels are supported; a dependency back to a waiting ancestor is refused, not deadlocked.

Python warm imports are ordinary persistent imports, not pretend-fresh module reloads. Explicit `stop()`/`restart()` and kernel reset/close discard that kernel's namespace; they are different from automatic parking or restoration after host restart.

### Python residency and process ownership

Python does **not** share the old JavaScript interpreter admission cap. Its settings are:

| Setting | Default and meaning |
|---|---|
| `python.kernelMemoryBudgetBytes` | `min(25% of physical RAM, 4 GiB)` private-memory residency budget |
| `python.kernelMaxResidentCount` | 64 resident named kernels as a process-count safety limit, not runnable concurrency |

Residency accounts for kernel children **and forkserver parents**, measuring macOS `phys_footprint` or Linux private mappings rather than summing shared RSS. This is neither a whole-application memory ceiling nor a promise to constrain user allocations during an executing cell. Remote or unavailable measurements are reported as unknown/unmeasured, not invented as zero.

Under measured pressure, only least-recently-used **idle, durably restorable** kernels may park. Busy, dirty, frozen, unknown-busy or unmeasured state is not evicted. If safe parking cannot admit a new kernel, admission fails visibly; it does not silently substitute a fresh or older namespace. Status reports expose residency, private-memory metric/bytes and reasons separately from execution admission.

Supported local POSIX CPython interpreters use a real per-interpreter, single-threaded forkserver launched with `-I -S`. The sterile parent imports no user libraries; child runtime threads start only after fork. The host uses buffered `node:net` transport. Unsupported local runtimes and remote targets report their supported spawn/remote launch mode rather than pretending to fork. Process resources and reservations remain owned until actual shutdown settles, including cancellation and forkserver failure.

JavaScript retains its separate **256 process-wide / 16 per creating owner** interpreter admission pool, reserved before startup until confirmed shutdown. Automatic nested shell execution uses **8 reusable leased lanes per tool session**. The 15-minute idle reap remains, with safe-state checks rather than silent loss of a busy or dirty generation. Runtime release does not stop descendants merely because their parent is parked; explicit subtree/tree shutdown remains separate.

### Exact state at temporal boundaries

Python warm kernels automatically capture the **whole supported user namespace as one graph**; there is no `declare_state` opt-in. `harness.store` uses the same rich-graph serialization contract. Lazy, vendored cloudpickle **3.1.2** preserves aliases, cycles, closures, functions, classes and module metadata. It is trusted session-local serialization, not a format for untrusted uploads. Imported modules require a compatible recorded environment; serialization does not roll back installed packages or external files.

The Python graph limit is **64 MiB of encoded payload** (base64 text), not 64 MiB of arbitrary live heap. State transport allows **96 MiB frames** for the graph envelope. Ordinary requests remain **8 MiB**, with a **16 MiB ordinary request queue**; the state exception does not raise ordinary code/helper admission limits. Unsupported live OS/runtime resources, including open files, sockets, generators, live tasks and user threads, refuse capture **before destructive teardown**. Bindings are not silently dropped or converted to approximate data.

JavaScript `declareState(["name", ...])` remains the existing selected-data contract (`[]` clears it): plain JSON-like data/bytes, at most 4,096 bindings, 100,000 value nodes, depth 64 and **16 MiB encoded per kernel**. Shared mutable aliases, cycles, custom objects, accessors/proxies and live retained resources remain unsupported for JavaScript. This JavaScript limit is not the Python graph limit.

Completed turns and explicit continuity boundaries capture immutable, versioned manifests under the owner/kernel execution gate and commit them durably before acknowledging boundary-dependent transitions. Historical manifests stay reachable with their branches: **no twenty-turn window, nearest-earlier restore or silent fresh fallback**. Missing, corrupt or incompatible exact state refuses the transition. Independently restorable namespaces must not ambiguously collide on one physical language/lane/environment identity.

Restoration is lazy, before the destination's first cell, into the recorded interpreter, target, working directory and environment. Preflight validates with the actual selected interpreter before source teardown. Fork copies the exact manifest into a destination-owned independent root without changing the source; copied ancestor history alone does not become a worker's own state. Model context-only `checkpoint`/`rewind(report)` preserves current computation, rather than applying temporal restoration. See [state at temporal boundaries](./session-operations.md#declared-state-at-temporal-boundaries).

Runtime release/normal close validates and commits state before destructive teardown; refusal keeps the source runtime attached and usable. Parking emits neither logical session shutdown nor session exit. Normal close commits its exit record and exact manifest together. Durable snapshots preserve computation across parking and host restart, not live external resources or filesystem side effects.

### Unreleased Python measurements (macOS sample)

One scoped macOS run compared four initialized warm fork children **plus their server** against four independent interpreters using the same embedded runner/runtime initialization. The residency owner's real-process selection passed **15 tests / 55 assertions**. These are machine-specific observations, not latency or memory guarantees and not Linux/remote measurements.

| Measurement | Forkserver mode | Independent spawn |
|---|---:|---:|
| Private footprint, four initialized children including server | 83,511,024 bytes | 98,027,296 bytes |
| Total initialized startup for four kernels with server already warm | 79.30 ms | 334.84 ms |

A separate cold-parent sample observed 56.89 ms for server plus first child and 2.01 ms for the next fork. A child allocating 64 MiB increased its measured private footprint by more than 48 MiB while its sibling changed by less than 16 MiB. Neither summed RSS nor total host application memory was the measurement.

The continuity owner's actual 40 MiB raw-byte graph encoded to **55,924,120 bytes**, crossed store HTTP with aliases intact and reopened durably from disk: one sample took about **770 ms**, with **55,925,550 bytes** of referenced blob plus session data. Warm namespace capture plus restore of that graph took about **4,750 ms** in that sample. A 49 MiB raw namespace exceeded the 64 MiB encoded limit and was refused while its live bindings remained intact. More than 23 later history boundaries, exact earlier restoration, independent forks, restart and uncaptured-boundary refusal were exercised. These proofs do not imply constant disk usage or arbitrary resource serialization.

### Prior P5 snapshot measurements (historical)

The following samples measured the **prior selected-data Python+Bun contract**, not the unreleased whole-graph serializer or forkserver. One macOS arm64 run (Apple M4 Max, CPython 3.13.16 and Bun 1.4.2) exercised three captures, compatibility preflights and cold restores. Each runtime held one ASCII string of the stated length; measurements include actual subprocess startup and durable commits. Ranges are observed samples, not guarantees.

| Namespace per runtime | Initial paired startup | Capture/commit | Compatibility preflight | Cold paired restore | Referenced durable bytes after boundaries 1 → 2 → 3 |
|---|---:|---:|---:|---:|---:|
| 100 characters | 292 ms | 1.7–4.5 ms | 209–249 ms | 238–246 ms | 2,270 → 3,774 → 5,278 |
| 600,000 characters | 266 ms | 9.4–10.4 ms | 221–243 ms | 242–247 ms | 1,202,170 → 2,403,574 → 3,604,978 |

Disk accounting includes session files and referenced snapshot blobs; retained boundaries/payloads consume durable disk. These historical timings did not measure private/native memory and establish neither an RSS ceiling nor Linux/remote performance.

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

## Measuring retained memory

RSS includes clean mappings and allocator pages that the operating system can reclaim; it is not a count of live JavaScript objects. Compare retained heap after collection and the operating system's charged footprint alongside RSS. In particular, releasing a cache can lower live heap and macOS physical footprint without immediately lowering RSS.

`bun test packages/coding-agent/src/tui/render-cache-retention.test.ts packages/coding-agent/src/session/session-history-lazy.test.ts` exercises isolated-process wrapping retention and parked-journal release. The wrapping probe processes 1,000 distinct 20,000-character strings for both ASCII and two-byte Unicode, drops caller-owned rows, and checks retained heap plus prompt process exit. The journal probe preserves history, snapshots and descendant writes across actual park/revive while checking that cached entry objects become collectible. These are focused retention contracts, not whole-session memory ceilings.

## Remaining scaling dimensions

- Structural session entries, archive indexes, blob handles and durable files still grow with accepted history; they are no longer equivalent to keeping every raw message or UI component resident.
- A running provider response, live application object graph, native browser/desktop process or terminal graphics cache is outside a JavaScript cache's byte accounting.
- Forced GC is useful in isolated retention regressions, not a remedy for reachable objects. Production fixes remove owners and bound admission instead of adding periodic forced GC.
- Tests cover repeated compactions, large output bursts, nested admission, cancellation/disposal races, replay eviction and actual interactive resize/history navigation. They do not establish a cross-platform native-RSS ceiling or replace an extended soak under real providers and adversarial extensions.
