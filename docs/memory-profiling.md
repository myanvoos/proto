# Memory profiling

Proto memory measurements need to distinguish retained JavaScript objects, allocation churn, and resident process memory. A smaller heap does not necessarily produce an immediate RSS reduction: Bun, JavaScriptCore, native libraries, code pages, and allocator reserves also contribute.

## Repeatable focused workloads

Run from the repository root with the same Bun build and workload parameters when comparing revisions:

```sh
bun packages/coding-agent/scripts/bench-orchestrator-memory.ts
bun --expose-gc packages/coding-agent/scripts/bench-worker-lifecycle-memory.ts --workers 1,4,8 --payload-kib 256
bun packages/coding-agent/bench/assertion-preflight-cache.bench.ts
bun packages/coding-agent/bench/transcript-viewer-cache.bench.ts
bun packages/coding-agent/scripts/bench-agent-transcript-viewer.ts --count 8000
bun packages/coding-agent/scripts/bench-daemon-memory.ts --clients 200 --terminal 50
bun packages/coding-agent/scripts/bench-gc-memory.ts --mib 128 --runs 3
```

- **Orchestrator:** exercises aborted lifecycle references and terminal workers, including ordinary task configuration and an explicitly oversized schema stress phase. Worker tombstones and history remain available; execution-only payloads need not remain attached to terminal workers.
- **Worker lifecycle:** creates real worker sessions through `OrchestratorRuntime`, using a registered in-process provider and a registry-resolvable model rather than replacing revival callbacks. Each worker count runs in a fresh child with isolated HOME/auth/model state. Workers emit a configurable payload, park, resume through the production disk-revival path, and terminate. The script checks transcript continuity, exactly one provider request per worker turn, and collection of original and revived sessions; a retained session makes the normal command fail. The default result payload is **256 KiB per worker turn**. Compaction and observational-memory inference are disabled, and the fixture model context scales with the payload, so unrelated auxiliary model work does not distort this lifecycle measurement. This covers ordinary disk-resumable workers; custom runtime-callback preservation is covered separately by lifecycle regressions.
- **Assertion preflight:** exercises large streamed-source failures and reports estimated cache bytes alongside heap/RSS samples. The cache is bounded by both entry count and estimated bytes. Eviction is a cache miss, not permission to skip validation.
- **Transcript viewer:** generates a populated session and drives the production viewer. It compares unconditional line-array synchronization with revision-gated synchronization. This measures repeated-render allocation work, not full interactive navigation latency.
- **Daemon lifecycle:** runs the production broker and clients in one isolated process, with four concurrently streaming child services, 200 clients closed during connection, and two batches of 50 uniquely named terminal processes. It reports collected JavaScriptCore heap, external memory, RSS, weak-reference retention, last-client shutdown, and historical pattern waits before and after broker recovery. Terminal process metadata remains available for describe, logs, and restart; historical waits reload the retained log tail rather than keeping every completed process's output in memory. The RSS sample covers the broker/client host, not the four unchanged service processes.
- **Blob GC:** creates plain, gzip-archived, and backup single-line transcripts outside the measured child, then runs real blob collection in an isolated agent directory. Each run verifies referenced blobs survive and an orphan is removed. `--mib` is the size of each of the three transcripts; use `--mib 512 --runs 3` to check scaling. This measures one-shot scanner peak RSS, not retained daemon memory.

These are local, synthetic workloads; they do not require provider requests. Garbage collection in a benchmark is diagnostic instrumentation, not a production optimization. Keep input sizes, warmup, live fixture references, and collection boundaries identical. Use repeated samples; do not infer savings from a single RSS reading.

## Windowed transcript hydration

Main-session revival keeps complete persisted entries and the agent's context, but constructs UI components only for the selected history window. Older/newer/latest navigation replaces and disposes the previous window. This reduces display hydration; it does **not** make total session-storage memory constant. The read-only subagent viewer additionally seeks bounded JSONL windows from disk instead of loading all historical records. Both preserve complete tool-call/result groups and oversized individual records rather than truncating their contents.

The viewer benchmark runs the production `AgentTranscriptViewer` and the eager `ChatTranscriptBuilder` reference in separate child processes. With 8,000 assistant/tool-result groups (16,001 records), one local run measured an RSS increase of **18.6 MiB windowed versus 172.8 MiB eager**. The eager reference produced 40,003 transcript lines; the viewer returned its 40-line viewport. These are component-workload measurements, not whole-CLI or machine-wide savings. Heap reporting is allocator/runtime-dependent; a zero reported heap delta is not evidence of zero allocations.

A matched compiled-CLI PTY comparison used isolated homes, the same Bun runtime, 8,000 messages (user / assistant tool call / matching result / assistant conclusion), a 15.3 MB JSONL file, and a 140×40 terminal. No prompt was submitted and no diagnostic GC was requested. Each of three independent runs per build sampled memory through 14 seconds after startup/resume and a further 3-second settling interval:

| Metric (median of three runs) | Eager resume | Windowed resume |
| --- | ---: | ---: |
| Settled RSS | 518.6 MiB | 305.8 MiB |
| Settled PSS | 516.7 MiB | 303.9 MiB |
| Sampled peak RSS | 662.8 MiB | 593.8 MiB |

Settled RSS was about **41% lower** in this workload; sampled peak RSS was about **10% lower**. Peaks were sampled from procfs at approximately 50 ms intervals, not measured with a kernel peak counter. Allocator behavior, transcript contents, native services, and concurrent workloads can change these numbers. The JSONL/session context still loads for model continuation; windowing does not eliminate that baseline.

Additional compiled-CLI PTY probes exercised a single user followed by 7,999 assistant messages, eight older/latest paging cycles, thinking/tool display toggles, slash-command paging, and a read-only advisor viewer's latest/oldest/latest/close navigation. Main-window paging is refused while model, bash, or Python output is active; continuation restores the latest page before streaming. The read-only viewer can remain on an older page while its file grows. A final compiled-CLI continuation probe resumed 800 uniquely marked messages, navigated via both `/history` and keyboard controls, and submitted from an older page to a local test Anthropic SSE endpoint. Exactly one provider request contained all 800 original markers, the response rendered, and all 800 markers remained in the persisted session. No external provider was used.

Idle eval kernels (Python interpreter, JS VM worker) are released after 15 idle minutes and evicted detached subagent sessions are fully disposed; see "Idle reap" in `docs/python-repl.md`. Busy kernels — backgrounded cells, awaited subagents/tool bridges, monitors — are never reaped.

## Whole-process measurement

Use an isolated profile with no credentials and disable onboarding, update checks, and extensions for the minimal baseline. Then measure the real CLI in a PTY through:

1. Idle startup.
2. Resuming a long transcript with realistic tool outputs.
3. Repeated session and subagent view entry/exit.
4. Active, idle, parked, and terminated workers.
5. Session closure and a settling interval.

Record the exact configuration, message/result sizes, worker count, terminal dimensions, and number of navigation cycles. Do not submit a prompt during a provider-free navigation probe.

On Linux, collect `/proc/<pid>/smaps_rollup` for the CLI and its descendants. Sum **PSS** to account for shared pages; aggregate RSS can count shared mappings more than once. Inspect `smaps` when attributing native libraries, executable pages, or allocator regions. Shared daemons outside the descendant tree need separate accounting; moving memory into another process is not a saving.

For retained-object diagnosis, use `bun:jsc` heap statistics after an explicit diagnostic collection. Record uncollected RSS separately. Heap snapshots and weak-reference probes can establish why a particular object remains reachable; do not treat every RSS increase as a leak.

## Runtime virtual memory and multi-instance footprint

A compiled proto process reserves most of its address space at JSC initialization, before any proto code runs. On linux-arm64 the idle breakdown (measured via `/proc/<pid>/smaps`, v18.0.2) is:

| Mapping | Reservation |
|---|---|
| `[anon:JSGigacage]` | 64 GiB (61.5 GiB `rw-p`) |
| `[anon:JSStructureHeap]` | 4 GiB |
| `[anon:WKFastMalloc]` | ~1.6 GiB |
| `[anon:JSJITCode]` | 512 MiB (`rwxp`) |
| binary + natives mappings | ~290 MiB (file-backed, shared across instances) |

VSZ is not resident RAM: these mappings are predominantly reservations, and the sampled process had about 2.4 MiB of page tables. Commit accounting also depends on mapping flags and the kernel overcommit policy; RSS/PSS and memory-pressure measurements are more useful than VSZ alone.

In an isolated compiled-binary RPC experiment, setting `GIGACAGE_ENABLED=0` **before process start** reduced VSZ from approximately 74,540 MiB to 8,972 MiB without demonstrating an RSS saving. This disables a JavaScriptCore memory-isolation mechanism: it is a diagnostic experiment, not a recommended performance setting or a production default. Setting it from application JavaScript is too late.

An isolated PTY test with a synthetic 90 MB JSONL transcript containing 40,000 assistant messages increased RSS from about 226 MiB to 1,790 MiB after resume. This measures aggregate loading/rendering cost, not a proven leak or a per-object allocation breakdown. `Agent.replaceMessages` shallow-copies the message array, not every message object. The subsequent process exit was not established as OOM. Local tiny-model workers cache pipelines until termination; their model-loaded RSS was not measured in this experiment. They now terminate after five idle minutes and restart on demand.

## Reference observations

An isolated source CLI measurement on Linux arm64 with Bun 1.3.14 found approximately:

| Workload | Retained heap after diagnostic collection | RSS |
| --- | --- | --- |
| Empty CLI, initial/after 20 global-view cycles | 35–45 MiB | 262–281 MiB |
| 2,000-message transcript, 500 read results, 7.6 MB JSONL | 53–63 MiB | 326–337 MiB |

The empty and populated global-overlay cycles did not establish accumulating retained-heap growth. These are baseline observations, not portable memory targets or before/after savings. The isolated CLI had no descendant service processes. Configured MCP stdio servers can add idle service memory and were not included.

Most idle RSS in that source run was in JavaScriptCore allocator/anonymous mappings and the Bun executable; the native addon mapping was only one contributor. Startup service policy and the broad import graph were left unchanged rather than introducing unmeasured lazy-loading changes.

## Verified effects of the retention fixes

The focused probes establish narrower results than a whole-application memory percentage:

- Eligible disk-resumable workers release their run-local revival callback after parking, and invoke the persisted factory only on a later resume. A focused callback-lifetime probe attached a **64 MiB** payload solely to that callback: the weak reference became unreachable after park and diagnostic collection, while lazy revival still succeeded. RSS stayed approximately **140 MiB**. This is a callback-collection proof, not a measured 64 MiB whole-CLI RSS saving or a realistic transcript workload. Explicit runtime-only stream, local-protocol, and custom-tool overrides retain their original revival path.
- The real **1/4/8-worker lifecycle matrix** collected every original session after park and every revived session after termination, with all transcripts successfully resumed. A matched eight-worker source-substitution probe reverted only the two SDK retention fixes: the startup-deadline waiter and the MCP shutdown callback unregister. With those roots present, **0/8 original and 0/8 revived sessions** were collected; with the fixes, both counts were **8/8**, while continuity remained **8/8**. Collected heap was **53.08 → 45.70 MiB after parking** and **74.20 → 47.75 MiB after termination**. This is one focused 256 KiB-per-turn workload, not a whole-application percentage. RSS went in the opposite direction (**344.29 → 412.83 MiB**); allocator/page behavior means this probe proves object release, not an immediate RSS reduction. Heap snapshots traced the baseline roots to an outstanding startup-deadline reaction and a process-global MCP notification cleanup callback.
- Filesystem-observation state now follows eval ownership: disposing one shared owner preserves pending observations for the other owners, and final-owner release removes the session ledger. Session switching releases the previous ledger, and late writes to a captured old ledger do not contaminate a newly created session ledger. No process-wide RAM percentage is inferred from these ownership regressions.

- The representative assertion-cache workload (256 distinct 256 KiB sources) retains about **31.75 MiB of source text**, versus **64 MiB** if every source is retained. Conservative metadata/string accounting remains below the **64 MiB** cache budget. RSS deltas vary across samples and are not used as the saving claim.
- The orchestrator workload keeps all **100 terminal worker IDs** and no completed jobs. In one matched baseline/fixed run, additional retained heap fell from approximately **17.7 MiB to 6.4 MiB**. This includes an oversized-schema stress phase and is not an estimate for ordinary worker cost. All 40 aborted revival payloads were collected. The probe creates each closure in a separate helper scope so the measuring loop does not itself retain the last payload.
- The populated viewer benchmark reduced line-array synchronization from **111 calls to 1** across initial render, warmup, and 100 unchanged frames. A local run measured roughly **1.06 ms/frame versus 0.64 ms/frame**; this is a focused steady-render comparison, not an end-to-end switching guarantee.
- Repeating the isolated CLI workload after integration left retained heap essentially unchanged (about **35 MiB empty / 53 MiB populated** after 20 global-view cycles). RSS varied substantially as pages were reclaimed. No idle-startup memory reduction is claimed.
- In the daemon fixture, closing clients during connection previously left **200 of 200** clients reachable and published all 200 pending requests after closure; the broker did not stop after its remaining clients closed. The fixed run retained **0 of 200**, published no closed or connection-aborted requests, and shut down normally. After 100 terminal process names, collected broker/client heap was approximately **25.7 MiB before / 19.1 MiB after** in the matched workload. This is a focused retention observation, not a whole-CLI saving or a hard bound on retained process metadata. Pattern waits still matched completed output after broker recovery and did not match output from an earlier restart generation.
- For three **128 MiB** transcripts, the blob GC probe's median peak RSS fell from **802.2 MiB to 238.5 MiB** across three runs (about **70%**). Three **512 MiB** transcripts had a median peak of **257.4 MiB** after the streaming change, rather than scaling with transcript size. Median scan time at 128 MiB per transcript was approximately **405 ms before / 542 ms after**: the supported bounded-read path was about **34% slower** in this fixture. This is a memory/throughput tradeoff, not a general speedup.

## Startup experiments without a retained optimization

Additional Linux arm64 / Bun 1.3.14 probes used an isolated source TUI with onboarding, update checks, extensions, skills, rules, and title generation disabled. No provider prompt was submitted.

- Relocating the existing JS-eval worker import boundary did not reduce memory. Seven alternating `--version` runs had median peak RSS **100,132 KiB before / 100,548 KiB after**. The corresponding empty-TUI samples were approximately **264.2 / 268.6 MiB RSS**. The experimental refactor was reverted.
- Three collected-heap runs with all tools versus `--tools read` differed by only **482,260 bytes (0.46 MiB)** at the median, with roughly **1,244** fewer live objects. Both retained **1,968 module records**. This measures incremental tool-instance and selected-tool state, not the cost of module-level schema declarations: selecting fewer tools does not unload the static import graph. It does not establish that lazy module or schema loading could never help.
- A controlled idle probe with Bun's runtime `--smol` flag measured approximately **263.8 MiB RSS**, versus the **264.2 MiB** ordinary source baseline. That single comparison did not justify changing production runtime defaults. Bun's flag belongs before the source entrypoint; Proto's own `--smol <model>` option selects a model and is unrelated.

These negative results are not a claim that idle startup is optimized. They justify leaving the measured import refactor and runtime mode unchanged, rather than accepting complexity without demonstrated savings. Source-mode measurements must not be presented as a before/after comparison with a compiled binary. Broader static loading remains a separate investigation.

## Interpretation and safeguards

- Terminal-worker cleanup must preserve identifying metadata and persisted history; parked/resumable workers still need their revival state.
- Cleared/disposed transcript views should release old component and row references without waiting for another render. Live transcript appends must still invalidate cached rows.
- Cache limits are conservative accounting estimates, not hard process-memory ceilings. Large transient inputs may allocate more than the retained cache budget.
- Do not truncate conversation history, drop tool results, or add periodic forced collection merely to lower a memory number.
- GC excludes fresh session heartbeats, including nested sessions, and revalidates candidates around archive staging. These checks reduce writer races but are not a shared writer/collector lock; another process can still attach after the last check. Historical daemon waits are limited to retained log output, and terminal launch specifications and completion-replay metadata intentionally remain available.
- A long-running production heap profile is still needed to attribute a specific report such as 200→800 MB. The focused workloads establish individual retention paths, not a universal total-memory reduction.
