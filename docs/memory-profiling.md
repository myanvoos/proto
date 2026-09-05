# Memory profiling

Proto memory measurements need to distinguish retained JavaScript objects, allocation churn, and resident process memory. A smaller heap does not necessarily produce an immediate RSS reduction: Bun, JavaScriptCore, native libraries, code pages, and allocator reserves also contribute.

## Repeatable focused workloads

Run from the repository root with the same Bun build and workload parameters when comparing revisions:

```sh
bun packages/coding-agent/scripts/bench-orchestrator-memory.ts
bun packages/coding-agent/bench/assertion-preflight-cache.bench.ts
bun packages/coding-agent/bench/transcript-viewer-cache.bench.ts
```

- **Orchestrator:** exercises aborted lifecycle references and terminal workers, including ordinary task configuration and an explicitly oversized schema stress phase. Worker tombstones and history remain available; execution-only payloads need not remain attached to terminal workers.
- **Assertion preflight:** exercises large streamed-source failures and reports estimated cache bytes alongside heap/RSS samples. The cache is bounded by both entry count and estimated bytes. Eviction is a cache miss, not permission to skip validation.
- **Transcript viewer:** generates a populated session and drives the production viewer. It compares unconditional line-array synchronization with revision-gated synchronization. This measures repeated-render allocation work, not full interactive navigation latency.

These are local, synthetic workloads; they do not require provider requests. Garbage collection in a benchmark is diagnostic instrumentation, not a production optimization. Keep input sizes, warmup, live fixture references, and collection boundaries identical. Use repeated samples; do not infer savings from a single RSS reading.

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

- The representative assertion-cache workload (256 distinct 256 KiB sources) retains about **31.75 MiB of source text**, versus **64 MiB** if every source is retained. Conservative metadata/string accounting remains below the **64 MiB** cache budget. RSS deltas vary across samples and are not used as the saving claim.
- The orchestrator workload keeps all **100 terminal worker IDs** and no completed jobs. In one matched baseline/fixed run, additional retained heap fell from approximately **17.7 MiB to 6.4 MiB**. This includes an oversized-schema stress phase and is not an estimate for ordinary worker cost. All 40 aborted revival payloads were collected. The probe creates each closure in a separate helper scope so the measuring loop does not itself retain the last payload.
- The populated viewer benchmark reduced line-array synchronization from **111 calls to 1** across initial render, warmup, and 100 unchanged frames. A local run measured roughly **1.06 ms/frame versus 0.64 ms/frame**; this is a focused steady-render comparison, not an end-to-end switching guarantee.
- Repeating the isolated CLI workload after integration left retained heap essentially unchanged (about **35 MiB empty / 53 MiB populated** after 20 global-view cycles). RSS varied substantially as pages were reclaimed. No idle-startup memory reduction is claimed.

## Interpretation and safeguards

- Terminal-worker cleanup must preserve identifying metadata and persisted history; parked/resumable workers still need their revival state.
- Cleared/disposed transcript views should release old component and row references without waiting for another render. Live transcript appends must still invalidate cached rows.
- Cache limits are conservative accounting estimates, not hard process-memory ceilings. Large transient inputs may allocate more than the retained cache budget.
- Do not truncate conversation history, drop tool results, or add periodic forced collection merely to lower a memory number.
- A long-running production heap profile is still needed to attribute a specific report such as 200→800 MB. The focused workloads establish individual retention paths, not a universal total-memory reduction.
