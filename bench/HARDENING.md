# Harness hardening sweep — 2026-09-22

Work branch: `polish/harness-hardening-2026-09-22`, based on `dc49b3fbeb`.
Measurements: Linux arm64, Bun 1.4.2. This was a finite local stress sweep, not a
multi-hour reliability certification. No live provider-generation benchmark was required.

## Reproduced defects fixed

| Surface | Observable failure | Correction and regression evidence |
|---|---|---|
| TUI history | An empty live viewport erased acknowledged history, especially on tiny terminals | Preserve the below-screen viewport boundary; growth/shrink/overlay matrices assert exact scrollback order and acknowledgements |
| Virtual terminal | Height resize overwrote the final cell; CJK reflow moved the cursor and inserted spaces | Preserve pending wrap and map the cursor through actual packed wide cells; resize and 20,000-row retention regressions |
| Offline render | `proto render` silently omitted all but the last 256 messages | Explicit full-history replay for offline rendering; interactive paging remains bounded; real CLI regression |
| CLI stdout | Successful exit could return only 128 KiB of an 8 MiB piped result | Close/drain stdout after cleanup; exact large Unicode-output subprocess regression |
| Python kernel | A throwing output callback or rejected display callback wedged protocol processing/shutdown | Contain consumer errors, drain the cell, report failure, preserve subsequent state |
| JavaScript kernel | Output callbacks escaped IPC dispatch; cancelled resets destroyed persistent globals | Contain sink errors and reject cancellation before reset/acquisition/dispatch |
| Large Python output | UTF-16 repair rebuilt each character into expensive string chains | Native well-formed-string conversion preserves split-surrogate handling with much lower allocation |
| Async jobs | Immediate throws lost owner routing; late failures resurrected disposed delivery queues | Register before execution; fence disposal and clear deadline timers |
| Daemon RPC | Fragmented Unicode frames disappeared; idle timeouts/readers never settled | Streaming frame reconstruction, frame-size bounds, explicit deadline/EOF settlement |
| Attach/probes | Probe sockets and closed-client requests remained live | Close sockets and settle all pending requests on disconnect |
| Disposed UI | In-flight or queued events mutated already-disposed views | Fence dispatch and release transcript references |
| Worker recovery | Nested `agent://` output disappeared after registration removal | Resolve persisted output alongside transcripts using the existing index |
| Archive and mounted reads | Supported compressed files appeared binary; mounted reads corrupted internal URIs | Registry-driven archive recognition and URI-aware path handling |
| Browser forms | Filling controls failed with short Bun stack traces | Extend the existing Puppeteer patch; real Chromium form interaction and regression |
| PDF screenshots | Shared-browser local paths failed; full-page captures were blank | Exact-file loopback transport, viewer readiness, viewport capture; real visible PDF proof |
| Monitors | Huge lines/poll output accumulated unbounded data; cap counters showed misleading ratios | Bounded capture and line reads, release finished poll buffers, distinguish total events from output caps |
| CLI/UI consistency | Help omitted flags; invalid dimensions printed stacks; labels injected control characters | Central help metadata, canonical usage errors, shared sanitization, consistent Proto branding |
| Fleet cancellation | Missing jobs were counted as successfully cancelled | Separate successful and unsuccessful outcome summaries |
| Tool instructions | Worker-send examples contradicted the schema | Canonical `to` examples and removal of duplicate fleet guidance |
| Test stability | Broker integration intermittently raced its own auto-spawn; queue countdown crossed a minute boundary | Own listener readiness/cleanup, deterministic clock in the countdown regression |

Upstream package namespaces, attribution, compatibility environment variables, and telemetry
identifiers are intentionally unchanged; they are not visible-product branding mistakes.

## Reproducible workloads

```sh
bun test packages/coding-agent/src packages/tui/src packages/utils/src packages/agent/src packages/browser-relay/src
bun run check:ts
bun run check:rs
bun bench/tui-render.bench.ts --stress
bun bench/runtime-lifecycle.bench.ts
bun bench/kernel-lifecycle.bench.ts
bun bench/kernel-lifecycle.bench.ts --output-only
bun bench/monitor-lifecycle.bench.ts
```

The real kernel probe requires Python, native bindings, and Linux `/proc` for its
resource assertions. Stress scripts use real subprocesses/sockets/kernels, not model calls.

Five consecutive combined stress rounds completed successfully (63.60 seconds):

| Workload | Five-round total | Checked contract |
|---|---:|---|
| TUI cache/terminal writes | 300,000 | Bounded retained scrollback, Unicode/ANSI, repeated size changes |
| TUI resizes | 900 | Tiny/large/normal geometry transitions |
| Job managers | 33,500 | Correct routing and zero retained jobs after disposal |
| Job lifecycles | 100,500 | Success, synchronous failure, cancellation |
| Pending RPC waits | 670,000 | Every waiter settles on closure |
| Python + JavaScript cells | 60,000 | Exact persistent counters, sequential/concurrent execution |
| Native-shell commands | 1,570 | Exact outputs and timeout metadata |
| Monitor subprocess lifecycles | 1,125 | Output limits, actionable errors, event caps, disposal |

Each kernel round also verifies Python/node/bun routing, a complete 5 MiB raw artifact
behind bounded tool output, stable Python FD/thread counts, and removal of both measured
worker PIDs after disposal. Broker readiness was separately repeated: the original fixture
failed 3/10 combined runs; after its ownership fix, 11 combined runs passed (154 tests).

### Production render matrix

`results/harness-hardening.render-matrix.json` contains 21 fresh CLI-process samples:
10/500/5,000 messages at 1x1, 2x2, 12x3, 32x8, 80x24, 240x100, and 1000x200,
with 25 full repaints each. All returned successfully. Plain output checks retained all
500 ordered message markers at widths 32, 80, and 240; ANSI-free output was also checked
at width 12, where wrapping splits marker text. The fixture alternates user/assistant
messages with Unicode and fenced code; the permanent CLI regression covers history
beyond the interactive page boundary without modifying the input session.

At 5,000 messages, full offline rendering peaked around 420 MiB RSS at 80x24 and
1.36 GiB at 1x1. These are measured high-water costs of materializing the entire
wrapped transcript, not a claim of constant-memory export. Interactive history
still pages instead of materializing an unbounded transcript.

## Performance and memory observations

- Same real 10 MiB Python-output probe before/after native UTF-16 repair:
  249 → 46 ms, RSS delta 193.8 → 25.6 MB, heap delta 261.2 → 21.3 MB.
  These are single diagnostic samples, not statistical speedup medians. Subsequent
  repeated final-state probes also completed with exact output.
- Independently rerun runtime stress: post-GC heap 9.49 → 9.75 MB across
  6,700 managers / 20,100 jobs / 134,000 waits. RSS remained above startup.
- Independently rerun terminal stress: sampled retained rows stayed at 501;
  post-GC heap 11.78 → 11.86 MiB across 60,000 writes / 180 resizes.
- Kernel stress: Python stayed at 12 FDs / 5 threads through 6,000 cells;
  JS heap grew from about 5.22 MB initially to 6.42 MB at 600 cells and
  6.67 MB at 6,000. Host FDs returned from 41 active to 26 after disposal
  in the independent run (27 initially).
- Monitor low/high/low stress exercised 225 subprocesses, including commands
  attempting 8 MiB outputs. Post-GC heap sampled 10.08 → 11.33 MB, with
  the second high-load phase below the first; all managers were disposed.

RSS includes native allocations and allocator high-water retention. Stable sampled
heap, successful cleanup assertions, and finite stress runs do not prove universal
leak freedom. Timings taken during concurrent work are diagnostic, not release gates.

## Actual-surface verification

- Real TUI bytes were checked through the virtual terminal's screen/scrollback,
  including resize/reflow/overlay/cursor tests. An actual 100x30 interactive PTY
  launch showed the header/footer and exited successfully after Ctrl+C.
- CLI help/error tests launch the real entrypoint, covering central metadata,
  aliases, friendly argument errors, and visible branding.
- Fresh Chromium filled `Ada`, selected `Blue`, clicked Apply, and visibly
  displayed `Ada Blue`; short-stack regression also passed.
- Browser-relay settings visibly show `Proto Browser Relay` and the valid
  `proto browser-relay` command; installed extension assets match their sources.
- A PDF screenshot visibly displayed `DOGFOOD 123` after the shared-browser fix.

## Tool coverage and limitations

[TOOL-DOGFOOD.md](TOOL-DOGFOOD.md) records the complete per-tool/per-operation matrix,
including every tool actually exposed to the dogfood worker. The main session additionally
exercised goal creation, checklist initialization/transitions, and monitor start/list/automatic
limit/stop operations. The ask interaction was exercised through behavioral tests rather than
interrupting the user with a fake question. No DGX MCP tool was invoked.

Audio and video fixtures were submitted to `inspect_media`, but its configured model lacks
those modalities. Image inspection worked. Audio/video analysis therefore remains unverified
until a capable inspector role is configured; shared model preferences were not silently changed.
The running harness must be rebuilt/restarted to load source fixes; fresh-source tests and
browser runs, not the old mounted process, provide the corrected-behavior evidence.

The sweep did not exercise remote SSH, desktop control, user Chrome attachment, or live provider
conversation generation. Those were not available in the dogfood worker's non-MCP tool roster.
The browser-relay test verifies settings/install presentation, not Chrome extension storage.
No all-platform terminal-fidelity or leak-free certification is implied.

## Final verification

- Integrated affected packages: **1,688 passed, 1 skipped, 0 failed**, 13,251 assertions,
  279 test files (final run 71.54 seconds). No skipped test is counted as proof.
- `bun run check:ts`: passed root Biome, benchmark types, and all nine workspace checks.
- `bun run check:rs`: passed; Cargo reports an existing future-compatibility warning for
  dependency `nix v0.28.0`.
- Five-round cross-surface stress and 21-case production render matrix: completed.
- Disposable tool workers, fixture servers, browser tabs, diagnostic Chromium instances,
  and PDF transport servers were closed; no user services were stopped.
- Package changelogs document the permanent behavior changes. No git commit was made.
