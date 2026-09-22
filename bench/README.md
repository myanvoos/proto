# bench

Microbenchmarks for proto's own code paths. Distinct from `proto bench`, which measures
provider/model latency over the network — everything here runs locally and offline.

## Running

```sh
bun bench/<suite>.bench.ts --label baseline   # before a change
bun bench/<suite>.bench.ts --label after      # after a change
bun bench/compare.ts <suite> baseline after   # print the delta table
```

Artifacts land in `bench/results/<suite>.<label>.json` and are committed alongside the change
they justify, so a perf claim can always be re-checked against the numbers it was based on.

## Harness lifecycle stress

These offline probes assert behavior and emit resource measurements; they are not provider benchmarks:

```sh
bun bench/tui-render.bench.ts --stress
bun bench/runtime-lifecycle.bench.ts
bun bench/kernel-lifecycle.bench.ts
bun bench/kernel-lifecycle.bench.ts --output-only
bun bench/monitor-lifecycle.bench.ts
```

The kernel probe requires Python, built native bindings, and Linux `/proc` for process/FD checks.
Runtime and monitor probes alternate small/large/small workloads; terminal stress varies geometry
and bounds retained scrollback. Kernel stress checks persistent state, concurrency, timeout metadata,
complete raw artifacts, and process disposal. Monitor stress checks real subprocess output caps and cleanup.
Post-GC heap and RSS are separate signals: allocator high-water retention is not proof of a leak,
and finite stable measurements are not proof that all leaks are absent.

See [HARDENING.md](HARDENING.md) for the September hardening sweep, coverage, and measured limitations.

## Writing a suite

```ts
import { formatArtifact, runSuite } from "./harness";

const artifact = await runSuite("my-suite", [
	{ name: "case-name", setup: () => buildFixture(), run: fixture => doWork(fixture) },
]);
console.log(formatArtifact(artifact));
```

`setup` runs once per case; its value is passed to `run`. Each case is warmed up (default 5
iterations) before the measured runs (default 20), and the artifact records min/median/p95/mean/
stddev plus the commit, platform, and Bun version the numbers came from.

Rules of thumb:

- Benchmark the real exported function, never a copy of its logic.
- Keep a case under ~200 ms so 20 runs stay cheap; scale the fixture, not the iteration count.
- Report the **median**; `mean` and `stddev` are there to show whether the median is trustworthy.
- Record `baseline` on the commit *before* the change so the comparison is honest.
