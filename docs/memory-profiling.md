# Memory profiling

Proto memory measurements need to distinguish retained JavaScript objects, allocation churn, and resident process memory. A smaller heap does not necessarily produce an immediate RSS reduction: Bun, JavaScriptCore, native libraries, code pages, and allocator reserves also contribute.

## Windowed transcript hydration

Main-session revival keeps complete persisted entries and the agent's context, but constructs UI components only for the selected history window. Older/newer/latest navigation replaces and disposes the previous window. This reduces display hydration; it does **not** make total session-storage memory constant. The read-only subagent viewer additionally seeks bounded JSONL windows from disk instead of loading all historical records. Both preserve complete tool-call/result groups and oversized individual records rather than truncating their contents.

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

- A parked worker's revival callback is built at module scope from a spawn-time blueprint, so it cannot share an environment record with the finished run. Before this, the callback was created inside the run's scope and pinned the disposed session and its whole context graph — and the earlier "prefer disk revival" workaround never applied in the real CLI because every SDK session carries synthesized local-protocol callbacks, which the eligibility check treated as an override. A heap-snapshot probe with four 2 MiB-transcript workers measured **66.9 → 41.8 MiB after parking** (0/4 sessions reachable) versus **66.9 → 66.9 MiB** (4/4 reachable) before; the remaining delta is the async job manager's bounded result retention.
- The owned-MCP regression in `runtime-controlled.test.ts` parks a real worker during a hanging local HTTP handshake with the MCP timeout disabled. The request is aborted, the original session is collected, and messaging the same worker ID establishes a fresh MCP connection and completes turn 2. This extends the shared-parent-manager probe to worker-owned connections; it proves session release and transcript continuity, not an RSS percentage.
- Filesystem-observation state now follows eval ownership: disposing one shared owner preserves pending observations for the other owners, and final-owner release removes the session ledger. Session switching releases the previous ledger, and late writes to a captured old ledger do not contaminate a newly created session ledger. No process-wide RAM percentage is inferred from these ownership regressions.

- Repeating the isolated CLI workload after integration left retained heap essentially unchanged (about **35 MiB empty / 53 MiB populated** after 20 global-view cycles). RSS varied substantially as pages were reclaimed. No idle-startup memory reduction is claimed.
- The daemon lifecycle regression fixture verifies that clients closed during connection publish no responses, the broker stops after its remaining clients close, and historical pattern waits stay generation-scoped across broker recovery.

## Startup experiments without a retained optimization

Additional Linux arm64 / Bun 1.3.14 probes used an isolated source TUI with onboarding, update checks, extensions, skills, rules, and title generation disabled. No provider prompt was submitted.

- Relocating the existing JS-eval worker import boundary did not reduce memory. Seven alternating `--version` runs had median peak RSS **100,132 KiB before / 100,548 KiB after**. The corresponding empty-TUI samples were approximately **264.2 / 268.6 MiB RSS**. The experimental refactor was reverted.
- Three collected-heap runs with all tools versus `--tools read` differed by only **482,260 bytes (0.46 MiB)** at the median, with roughly **1,244** fewer live objects. Both retained **1,968 module records**. This measures incremental tool-instance and selected-tool state, not the cost of module-level schema declarations: selecting fewer tools does not unload the static import graph. It does not establish that lazy module or schema loading could never help.
- A controlled idle probe with Bun's runtime `--smol` flag measured approximately **263.8 MiB RSS**, versus the **264.2 MiB** ordinary source baseline. That single comparison did not justify changing production runtime defaults. Bun's flag belongs before the source entrypoint; Proto's own `--smol <model>` option selects a model and is unrelated.

These negative results are not a claim that idle startup is optimized. They justify leaving the measured import refactor and runtime mode unchanged, rather than accepting complexity without demonstrated savings. Source-mode measurements must not be presented as a before/after comparison with a compiled binary. Broader static loading remains a separate investigation.

## Import-graph and native-load findings

A Linux arm64 / Bun 1.3.14 source-mode import probe measured each module in a fresh process after a one-second settling interval. These isolated graphs overlap and their savings are not additive. Narrowing the built-in memory host imports and loading the subagent executor on the first worker turn reduced the orchestrator import from about 198 MiB to 125–130 MiB RSS, the SDK import from about 200–207 MiB to 181–183 MiB, and the bundled memory module from about 202–206 MiB to 177–183 MiB. The complete interactive process did not retain a corresponding saving because its normal startup graph reaches the deferred modules by other paths.

Settings-only consumers had a separate heavy edge: thinking metadata imported the pi-ai root through the `Effort` value, and compaction choice metadata imported the complete compaction engine. Moving effort values to the catalog source of truth and separating lightweight choice/label metadata reduced the isolated thinking module from about 107 MiB to 43 MiB RSS and the settings schema from about 111 MiB to 83 MiB. A same-tree interactive sample remained approximately 300 MiB in source mode, so this is an SDK/schema-consumer improvement rather than a claimed interactive-idle reduction.

The first interactive native-addon access was traced to the macOS spelling availability check in the startup composer. Platform-gating that check moved the first access immediately to `TtyWriter` construction when the terminal output pump starts. Rendering then uses other native text operations, so the experiment did not defer the addon beyond startup and was reverted. The current `__ompInstallTokioRuntime` Rust export is a no-op; removing its loader call would not avoid loading the N-API addon. A meaningful steady-state reduction requires a lightweight TTY/text addon, a proven non-native output path, or another native-package split—not a platform special case.

After the initial import changes, three four-second PTY samples of the same working tree had median RSS/PSS of approximately 300/273 MiB for source TypeScript, 249/229 MiB for the minified Bun bundle, and 256/250 MiB for the compiled executable. These observations confirmed that raw TypeScript evaluation remained costlier and that import splitting alone did not reduce the full interactive steady state.

A subsequent startup trace found that `ModelRegistry` parsed roughly 2,000 cached models during construction and runtime discovery then materialized 4,544 bundled models, although the active profile had only 73 available models across four providers. Provider caches and runtime-discovery overlays now preserve provider-scoped catalog composition; an explicit all-model request such as opening the model selector still materializes the complete catalog. Matched three-run median idle RSS fell from 296 MiB to 266 MiB in source mode, from 249 MiB to 226 MiB for the minified bundle, and from 256 MiB to 231 MiB for the compiled executable. The compiled `--version` peak remained approximately 66 MiB, and thread counts were unchanged.

Profile services and allocator variation make these observations unsuitable as narrow regression gates. Use repeated RSS and anonymous-RSS measurements, and exercise both provider-scoped startup and the all-model selector path when changing catalog composition.


At the optimized compiled idle point, `smaps` attributed approximately 141 MiB RSS to JavaScriptCore's `WKFastMalloc`, 15 MiB to other anonymous mappings, 54 MiB to the executable's resident mappings, and 10 MiB to the native addon. A live V8-format heap snapshot accounted for about 51 MiB of JavaScriptCore objects: roughly 23 MiB code, 17 MiB objects, 4 MiB strings, and the remainder structures and closures. The minified bundle reduced source module records from about 1,900 to 248 but had a similar live JavaScript heap, so further large reductions require fewer retained runtime objects/code rather than another bundling mode.

A one-shot `Bun.gc(true)` after startup decommitted an additional 8–10 MiB in about 10 ms, but it was not retained as an optimization: forced collection treats allocator pressure rather than its source and adds a stop-the-world pause. Bun bytecode compilation was also rejected: with the required split chunks it produced invalid cross-chunk references on Bun 1.3.14 and increased the executable from roughly 147 MiB to 247 MiB.

## Interpretation and safeguards

- Terminal-worker cleanup must preserve identifying metadata and persisted history; parked/resumable workers still need their revival state.
- Cleared/disposed transcript views should release old component and row references without waiting for another render. Live transcript appends must still invalidate cached rows.
- Cache limits are conservative accounting estimates, not hard process-memory ceilings. Large transient inputs may allocate more than the retained cache budget.
- Do not truncate conversation history, drop tool results, or add periodic forced collection merely to lower a memory number.
- GC excludes fresh session heartbeats, including nested sessions, and revalidates candidates around archive staging. These checks reduce writer races but are not a shared writer/collector lock; another process can still attach after the last check. Historical daemon waits are limited to retained log output, and terminal launch specifications and completion-replay metadata intentionally remain available.
- A long-running production heap profile is still needed to attribute a specific report such as 200→800 MB. The focused workloads establish individual retention paths, not a universal total-memory reduction.
