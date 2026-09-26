import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import type { ToolSession } from ".";
import { BashTool } from "./bash";

const OWNER = `orchestration-test:${process.pid}`;

async function cell(lane: "python" | "bun", code: string | string[], ceiling = 0) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "orchestration-"));
	const session = {
		cwd,
		settings: {
			get: (key: string) => (key === "orchestrator.maxConcurrency" ? ceiling : undefined),
			getShellConfig: () => ({ env: {} }),
		},
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		getEvalSessionId: () => cwd,
		getEvalKernelOwnerId: () => OWNER,
	} as unknown as ToolSession;
	try {
		for (const source of typeof code === "string" ? [code] : code) {
			const result = await new BashTool(session).execute("orchestration", {
				command: `${lane} <<'CELL'\n${source}\nCELL`,
				timeout: 30,
			});
			const output = result.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
			expect(result.isError, output).not.toBe(true);
			expect(output).toContain("CONTRACT_OK");
			if (Array.isArray(code)) {
				await disposeKernelSessionsByOwner(OWNER);
				await disposeVmContextsByOwner(OWNER);
			}
		}
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
}

afterAll(async () => {
	await disposeKernelSessionsByOwner(OWNER);
	await disposeVmContextsByOwner(OWNER);
});

const failures = {
	python: `
def fail(value):
    raise ValueError("broken")
rows = pipeline([1, 2], lambda x: x * 2, fail, streaming=True, settled=True)
assert [r["stage"] for r in rows] == [1, 1], rows
assert all(r["error"]["name"] == "ValueError" and r["error"]["stack"] for r in rows)
try:
    parallel([lambda: 7, lambda: fail(0)])
    raise AssertionError("expected failure")
except BatchError as error:
    assert error.results[0]["value"] == 7
    assert error.results[1]["error"]["message"] == "broken"
print("CONTRACT_OK")`,
	bun: `
const fail = () => { throw new Error("broken"); };
const rows = await pipeline([1, 2], x => x * 2, fail, {streaming: true, settled: true});
if (rows.some(r => r.stage !== 1 || r.error.name !== "Error" || !r.error.stack)) throw new Error(JSON.stringify(rows));
try { await parallel([() => 7, fail]); throw new Error("expected failure"); }
catch (error) { if (!(error instanceof BatchError) || error.results[0].value !== 7 || error.results[1].error.message !== "broken") throw error; }
console.log("CONTRACT_OK");`,
};
for (const lane of ["python", "bun"] as const) {
	test(`${lane} preserves successes and reports the failing streaming stage`, () => cell(lane, failures[lane]), 60000);
}

const concurrency = {
	python: `
import threading
active = peak = 0
lock = threading.Lock()
gate = threading.Event()
def work():
    global active, peak
    with lock:
        active += 1
        peak = max(peak, active)
        if active == 2:
            gate.set()
    assert gate.wait(2)
    with lock:
        active -= 1
    return 1
assert parallel([work] * 6, concurrency=3) == [1] * 6
assert active == 0 and peak == 2, (active, peak)
peak = 0
assert parallel([work] * 4, concurrency=1) == [1] * 4
assert peak == 1
assert parallel([]) == []
assert pipeline([1, 2]) == [1, 2]
print("CONTRACT_OK")`,
	bun: `
let active = 0, peak = 0;
const {promise: gate, resolve: release} = Promise.withResolvers();
const work = async () => {
 active++; peak = Math.max(peak, active);
 if (active === 2) release();
 await gate;
 active--;
 return 1;
};
const values = await parallel(Array(6).fill(work), {concurrency: 3});
if (active !== 0 || peak !== 2 || values.join() !== "1,1,1,1,1,1") throw new Error(String(peak));
peak = 0;
await parallel(Array(4).fill(work), {concurrency: 1});
if (peak !== 1) throw new Error(String(peak));
if ((await parallel([])).length || (await pipeline([1, 2])).join() !== "1,2") throw new Error("legacy calls");
console.log("CONTRACT_OK");`,
};

// These integration cells exercise worker-local platform deadlines: host fake timers cannot control their clocks.
const drain = {
	python: `
import threading, time
marks = []
def slow():
    time.sleep(0.03)
    marks.append("work")
    return 1
def observer(row):
    time.sleep(0.01)
    marks.append("observer")
rows = parallel([slow], timeout=0.005, on_result=observer, settled=True)
assert rows[0]["status"] == "timed_out", rows
assert marks == ["work", "observer"]
time.sleep(0.02)
assert marks == ["work", "observer"]
def cooperative():
    try:
        while True:
            task_signal().check()
            time.sleep(0.001)
    finally:
        marks.append("cleanup")
assert parallel([cooperative], timeout=0.005, settled=True)[0]["status"] == "timed_out"
assert marks[-1] == "cleanup"
def late_failure():
    time.sleep(0.01)
    raise ValueError("failed after deadline")
assert parallel([late_failure], timeout=0.002, settled=True)[0]["status"] == "timed_out"
cancel = threading.Event()
cancel.set()
rows = parallel([lambda: marks.append("forbidden")] * 3, cancel=cancel, settled=True)
assert all(row["status"] == "cancelled" for row in rows)
assert "forbidden" not in marks
def cancelled():
    cancel.set()
    task_signal().check()
cancel.clear()
assert parallel([cancelled], cancel=cancel, settled=True)[0]["status"] == "cancelled"
def bad_observer(row):
    marks.append(row["value"])
    raise ValueError("observer failed")
try:
    parallel([lambda: 4, lambda: 5], on_result=bad_observer)
    raise AssertionError("expected observer failure")
except BatchError as error:
    assert [row["value"] for row in error.results] == [4, 5]
    assert len(error.callback_errors) == 2
    assert all(row["error"]["stack"] for row in error.callback_errors)
assert 4 in marks and 5 in marks
print("CONTRACT_OK")`,
	bun: `
const marks = [];
const sleep = ms => { const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, ms); return promise; };
const rows = await parallel([async () => { await sleep(30); marks.push("work"); return 1; }], {
 timeoutMs: 5, settled: true, onResult: async row => { await sleep(10); marks.push("observer"); },
});
if (rows[0].status !== "timed_out" || marks.join() !== "work,observer") throw new Error(JSON.stringify(rows));
await sleep(20);
if (marks.join() !== "work,observer") throw new Error("late work");
const cooperative = await parallel([async (index, signal) => {
 try { while (true) { signal.throwIfAborted(); await sleep(1); } }
 finally { marks.push("cleanup"); }
}], {timeoutMs: 5, settled: true});
if (cooperative[0].status !== "timed_out" || marks.at(-1) !== "cleanup") throw new Error("cleanup not drained");
const sync = await parallel([() => { const end = performance.now() + 10; while (performance.now() < end) {} }], {timeoutMs: 2, settled: true});
if (sync[0].status !== "timed_out") throw new Error("synchronous deadline missed");
const cancel = new AbortController(); cancel.abort();
const cancelled = await parallel(Array(3).fill(() => marks.push("forbidden")), {signal: cancel.signal, settled: true});
if (cancelled.some(row => row.status !== "cancelled") || marks.includes("forbidden")) throw new Error("cancelled work invoked");
const live = new AbortController();
const running = await parallel([(index, signal) => { live.abort(); signal.throwIfAborted(); }], {signal: live.signal, settled: true});
if (running[0].status !== "cancelled") throw new Error("in-flight cancellation missed");
try {
 await parallel([() => 4, () => 5], {onResult: async row => { await sleep(1); marks.push(row.value); throw null; }});
 throw new Error("expected observer failure");
} catch (error) {
 if (!(error instanceof BatchError) || error.results.map(row => row.value).join() !== "4,5" || error.callbackErrors.length !== 2 || error.callbackErrors.some(row => !row.error.stack)) throw error;
}
if (!marks.includes(4) || !marks.includes(5)) throw new Error("observer not drained");
console.log("CONTRACT_OK");`,
};

const stages = {
	python: `
import threading
gate = threading.Event()
seen = []
def first(value):
    if value == 0:
        assert gate.wait(2), "downstream blocked by unrelated item"
    return value
def second(value):
    seen.append(value)
    gate.set()
    return value + 10
assert pipeline([0, 1], first, second, streaming=True, concurrency=2) == [10, 11]
assert seen == [1, 0], seen
observed = []
def reject_zero(value):
    if value == 0:
        raise ValueError("zero")
    return value
def notify(row):
    observed.append((row["stage"], row["index"]))
rows = pipeline([0, 1, 2], reject_zero, lambda x: x + 10, settled=True, on_result=notify)
assert rows[0]["stage"] == 0 and rows[0]["status"] == "rejected"
assert [row["index"] for row in rows] == [0, 1, 2]
assert sorted(observed) == [(0, 0), (0, 1), (0, 2), (1, 1), (1, 2)], observed
assert [rows[i]["value"] for i in (1, 2)] == [11, 12]
def broken_notify(row):
    raise ValueError("observer")
try:
    pipeline([0, 1], reject_zero, lambda x: x + 10, on_result=broken_notify)
    raise AssertionError("expected observer failure")
except BatchError as error:
    assert error.results[1]["value"] == 11
    assert sorted((r["stage"], r["index"]) for r in error.callback_errors) == [(0, 0), (0, 1), (1, 1)]
print("CONTRACT_OK")`,
	bun: `
const seen = [];
const {promise: gate, resolve: release, reject} = Promise.withResolvers();
// Watchdog only: the downstream stage releases the awaited event; no guessed progress delay.
const timer = setTimeout(() => reject(new Error("downstream blocked")), 2000);
const values = await pipeline([0, 1], async value => { if (value === 0) await gate; return value; }, value => { seen.push(value); release(); clearTimeout(timer); return value + 10; }, {streaming: true, concurrency: 2});
if (values.join() !== "10,11" || seen.join() !== "1,0") throw new Error(JSON.stringify(seen));
const observed = [];
const rejectZero = value => { if (value === 0) throw new Error("zero"); return value; };
const rows = await pipeline([0, 1, 2], rejectZero, (value, index) => { if (value !== index) throw new Error("stage index shifted"); return value + 10; }, {settled: true, onResult: row => observed.push([row.stage, row.index].join(":"))});
if (rows[0].status !== "rejected" || rows[0].stage !== 0 || rows.map(row => row.index).join() !== "0,1,2" || rows[1].value !== 11 || rows[2].value !== 12) throw new Error(JSON.stringify(rows));
if (observed.sort().join() !== "0:0,0:1,0:2,1:1,1:2") throw new Error(observed.join());
try {
 await pipeline([0, 1], rejectZero, value => value + 10, {onResult: () => { throw new Error("observer"); }});
 throw new Error("expected observer failure");
} catch (error) {
 if (!(error instanceof BatchError) || error.results[1].value !== 11 || error.callbackErrors.map(row => [row.stage, row.index].join(":")).sort().join() !== "0:0,0:1,1:1") throw error;
}
console.log("CONTRACT_OK");`,
};
for (const lane of ["python", "bun"] as const) {
	test(`${lane} bounds work by both caller and host concurrency`, () => cell(lane, concurrency[lane], 2), 60000);
	test(
		`${lane} drains work and observers under deadlines, cancellation and callback failures`,
		() => cell(lane, drain[lane]),
		60000,
	);
	test(
		`${lane} streams downstream progress and preserves original stage indices`,
		() => cell(lane, stages[lane]),
		60000,
	);
}

const checkpoints = {
	python: `
calls = [0, 0]
def one():
    calls[0] += 1
    return {"nested": [1, None, True]}
def two():
    calls[1] += 1
    if calls[1] == 1:
        raise ValueError("transient")
    return 22
opts = dict(checkpoint="parallel-cache", key="workflow-v1", keys=["one", "two"], settled=True)
rows = parallel([one, two], **opts)
assert [r["status"] for r in rows] == ["fulfilled", "rejected"]
assert calls == [1, 1], calls
rows = parallel([one, two], resume=True, **opts)
assert calls == [1, 2] and rows[0]["resumed"] and rows[1]["value"] == 22, (calls, rows)
rows = parallel([one, two], **opts)
assert calls == [2, 3], "resume must be explicit"
rows = parallel([two, one], checkpoint="parallel-cache", key="workflow-v1", keys=["two", "one"], resume=True, settled=True)
assert calls == [2, 3] and rows[0]["value"] == 22 and rows[1]["value"] == {"nested": [1, None, True]}
parallel([one, two], **{**opts, "key": "workflow-v2", "resume": True})
assert calls == [3, 4], "workflow identity must invalidate cache"
counts = [0, 0]
def first(value):
    counts[0] += 1
    return value * 10
def second(value):
    counts[1] += 1
    if value == 10 and counts[1] <= 2:
        raise ValueError("stage failure")
    return value + 1
opts = dict(checkpoint="pipeline-cache", key="pipeline-v1", keys=["a", "b"], settled=True, concurrency=1)
rows = pipeline([1, 2], first, second, **opts)
assert rows[0]["stage"] == 1 and rows[0]["status"] == "rejected"
assert counts == [2, 2]
rows = pipeline([2, 1], first, second, streaming=True, resume=True, **{**opts, "keys": ["b", "a"]})
assert counts == [2, 3], counts
assert [r["value"] for r in rows] == [21, 11], rows
assert rows[0]["resumed"] and rows[0]["stage"] == 1 and rows[1]["stage"] == 1
seen = []
def canonical(item):
    seen.append(item)
    return len(seen)
assert pipeline([{"b": 2, "a": 1}], canonical, checkpoint="canonical", key="v1") == [1]
assert pipeline([{"a": 1, "b": 2}], canonical, checkpoint="canonical", key="v1", resume=True) == [1]
assert len(seen) == 1
print("CONTRACT_OK")`,
	bun: `
const calls = [0, 0];
const one = () => { calls[0]++; return {nested: [1, null, true]}; };
const two = () => { calls[1]++; if (calls[1] === 1) throw new Error("transient"); return 22; };
const opts = {checkpoint: "parallel-cache", key: "workflow-v1", keys: ["one", "two"], settled: true};
let rows = await parallel([one, two], opts);
if (rows.map(r => r.status).join() !== "fulfilled,rejected" || calls.join() !== "1,1") throw new Error("implicit retry");
rows = await parallel([one, two], {...opts, resume: true});
if (calls.join() !== "1,2" || !rows[0].resumed || rows[1].value !== 22) throw new Error(JSON.stringify(rows));
await parallel([one, two], opts);
if (calls.join() !== "2,3") throw new Error("resume must be explicit");
rows = await parallel([two, one], {...opts, keys: ["two", "one"], resume: true});
if (calls.join() !== "2,3" || rows[0].value !== 22 || JSON.stringify(rows[1].value) !== '{"nested":[1,null,true]}') throw new Error("unstable item keys");
await parallel([one, two], {...opts, key: "workflow-v2", resume: true});
if (calls.join() !== "3,4") throw new Error("workflow identity must invalidate cache");
const counts = [0, 0];
const first = value => { counts[0]++; return value * 10; };
const second = value => { counts[1]++; if (value === 10 && counts[1] <= 2) throw new Error("stage failure"); return value + 1; };
const pipelineOpts = {checkpoint: "pipeline-cache", key: "pipeline-v1", keys: ["a", "b"], settled: true, concurrency: 1};
rows = await pipeline([1, 2], first, second, pipelineOpts);
if (rows[0].stage !== 1 || rows[0].status !== "rejected" || counts.join() !== "2,2") throw new Error(JSON.stringify(rows));
rows = await pipeline([2, 1], first, second, {...pipelineOpts, keys: ["b", "a"], streaming: true, resume: true});
if (counts.join() !== "2,3" || rows.map(r => r.value).join() !== "21,11" || !rows[0].resumed || rows.some(r => r.stage !== 1)) throw new Error(JSON.stringify(rows));
const seen = [];
const canonical = item => { seen.push(item); return seen.length; };
await pipeline([{b: 2, a: 1}], canonical, {checkpoint: "canonical", key: "v1"});
const cached = await pipeline([{a: 1, b: 2}], canonical, {checkpoint: "canonical", key: "v1", resume: true});
if (seen.length !== 1 || cached[0] !== 1) throw new Error("noncanonical identity");
console.log("CONTRACT_OK");`,
};

const validation = {
	python: `
invalid = [float("nan"), float("inf"), 2 ** 53 + 1, (1, 2), {1: "coerced"}, {"missing": object()}, set([1])]
cycle = []
cycle.append(cycle)
invalid.append(cycle)
for index, value in enumerate(invalid):
    opts = dict(checkpoint="invalid", key="v1", keys=[str(index)], settled=True)
    rows = parallel([lambda: value], **opts)
    assert rows[0]["status"] == "rejected", rows
    rows = parallel([lambda: "replacement"], resume=True, **opts)
    assert rows[0]["value"] == "replacement" and not rows[0].get("resumed"), rows
for opts in [dict(concurrency=0), dict(concurrency=True), dict(timeout=0), dict(timeout=True), dict(timeout=float("nan")), dict(checkpoint="cache"), dict(checkpoint="cache", key=4), dict(resume=True), dict(keys=[1]), dict(keys=[]), dict(keys="x")]:
    for streaming in [False, True]:
        try:
            pipeline([1], lambda x: x, streaming=streaming, **opts)
            raise AssertionError(opts)
        except (ValueError, TypeError):
            pass
for streaming in [False, True]:
    try:
        pipeline([1, 2], lambda x: x, keys=["same", "same"], streaming=streaming)
        raise AssertionError("duplicate keys")
    except ValueError:
        pass
try:
    parallel([lambda: 1], checkpoint="cache", key="v1")
    raise AssertionError("parallel keys required")
except ValueError:
    pass
print("CONTRACT_OK")`,
	bun: `
const cycle = []; cycle.push(cycle);
const invalid = [undefined, NaN, Infinity, 1n, new Date(), new Set([1]), {missing: undefined}, {fn: () => 1}, [undefined], Array(1), cycle, {[Symbol("key")]: 1}];
for (let index = 0; index < invalid.length; index++) {
 const opts = {checkpoint: "invalid", key: "v1", keys: [String(index)], settled: true};
 let rows = await parallel([() => invalid[index]], opts);
 if (rows[0].status !== "rejected") throw new Error("accepted lossy JSON at " + index);
 rows = await parallel([() => "replacement"], {...opts, resume: true});
 if (rows[0].value !== "replacement" || rows[0].resumed) throw new Error("cached rejected value at " + index);
}
for (const opts of [{concurrency: 0}, {concurrency: true}, {timeoutMs: 0}, {timeoutMs: NaN}, {checkpoint: "cache"}, {checkpoint: "cache", key: 4}, {resume: true}, {keys: [1]}, {keys: []}, {keys: "x"}]) {
 for (const streaming of [false, true]) {
  let rejected = false;
  try { await pipeline([1], x => x, {...opts, streaming}); } catch (error) { rejected = error instanceof TypeError || error instanceof RangeError; }
  if (!rejected) throw new Error("invalid options accepted: " + JSON.stringify(opts));
 }
}
for (const streaming of [false, true]) {
 let rejected = false;
 try { await pipeline([1, 2], x => x, {keys: ["same", "same"], streaming}); } catch (error) { rejected = error instanceof TypeError; }
 if (!rejected) throw new Error("duplicate keys accepted");
}
let rejected = false;
try { await parallel([() => 1], {checkpoint: "cache", key: "v1"}); } catch (error) { rejected = error instanceof TypeError; }
if (!rejected) throw new Error("parallel keys required");
console.log("CONTRACT_OK");`,
};
for (const lane of ["python", "bun"] as const) {
	test(
		`${lane} resumes only explicit completed checkpoints with stable workflow, item and stage identities`,
		() => cell(lane, checkpoints[lane]),
		60000,
	);
	test(
		`${lane} rejects lossy checkpoints and invalid options before running stages`,
		() => cell(lane, validation[lane]),
		60000,
	);
}

const restart = {
	python: [
		`assert parallel([lambda: None, lambda: {"result": [1, 2]}], checkpoint="restart", key="v1", keys=["null", "object"]) == [None, {"result": [1, 2]}]
print("CONTRACT_OK")`,
		`def forbidden():
    raise AssertionError("checkpointed work executed after restart")
rows = parallel([forbidden, forbidden], checkpoint="restart", key="v1", keys=["object", "null"], resume=True, settled=True)
assert [r["value"] for r in rows] == [{"result": [1, 2]}, None]
assert all(r["resumed"] for r in rows)
print("CONTRACT_OK")`,
	],
	bun: [
		`await parallel([() => null, () => ({result: [1, 2]})], {checkpoint: "restart", key: "v1", keys: ["null", "object"]}); console.log("CONTRACT_OK");`,
		`const forbidden = () => { throw new Error("checkpointed work executed after restart"); };
const rows = await parallel([forbidden, forbidden], {checkpoint: "restart", key: "v1", keys: ["object", "null"], resume: true, settled: true});
if (JSON.stringify(rows.map(r => r.value)) !== '[{"result":[1,2]},null]' || rows.some(r => !r.resumed)) throw new Error(JSON.stringify(rows));
console.log("CONTRACT_OK");`,
	],
};
for (const lane of ["python", "bun"] as const) {
	test(
		`${lane} resumes serialized null and object results after a real kernel restart`,
		() => cell(lane, restart[lane]),
		60000,
	);
}
