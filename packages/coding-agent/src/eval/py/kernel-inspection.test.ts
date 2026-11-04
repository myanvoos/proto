import { expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { JsStatusEvent } from "../js/shared/types";
import { disposeKernelSessionsByOwner, executePython } from "./executor";

test("Python inspection is bounded and side-effect-free, preserves provenance, and reflects a restarted process", async () => {
	using tempDir = TempDir.createSync("@python-inspection-");
	const ownerId = `inspection:${crypto.randomUUID()}`;
	const events: JsStatusEvent[] = [];
	const options = {
		cwd: tempDir.path(),
		sessionId: ownerId,
		kernelOwnerId: ownerId,
		timeoutMs: 20_000,
		onStatus: (event: JsStatusEvent) => {
			events.push(event);
		},
	};
	const run = async (code: string) => {
		const result = await executePython(`import proto_harness as harness\n${code}`, options);
		expect(result.exitCode).toBe(0);
		return result;
	};
	try {
		await run(`import asyncio, json
class EvilMeta(type):
    def __eq__(cls, other):
        raise RuntimeError("metaclass equality invoked")
    @property
    def __name__(cls):
        raise RuntimeError("metaclass getter invoked")
class Evil(metaclass=EvilMeta):
    def __repr__(self):
        raise RuntimeError("repr invoked")
    def __len__(self):
        raise RuntimeError("len invoked")
probe_evil = Evil()
probe_large = "\\x00" * 1000000
probe_integer = 1 << 1000000
probe_list = [probe_evil] * 100000
if True:
    probe_nested = 7
probe_task = harness.retain_task(asyncio.create_task(asyncio.sleep(60)))
await asyncio.sleep(0)
probe_cell = harness.kernel_state()["executionCount"]`);
		const inspected = await run(`snapshot = harness.kernel_state()
variables = {v["name"]: v for v in snapshot["variables"]}
assert variables["probe_evil"]["type"] == "Evil"
assert variables["probe_nested"]["cell"] == probe_cell
assert harness.defs()["probe_nested"] == probe_cell
assert variables["probe_integer"]["preview"] == "<large integer>"
assert all(len(v["preview"]) <= 200 for v in snapshot["variables"])
assert any(t["id"] == str(id(probe_task)) for t in snapshot["tasks"])
assert not any(t["kind"] == "cell" for t in snapshot["tasks"])  # Sync cells are not asyncio tasks.
assert snapshot["active"] == 1 and snapshot["queued"] == 0
assert harness.kernel_state(limit=0)["variables"] == []
assert harness.kernel_state(limit=0)["tasks"] == []
assert len(harness.kernel_state(limit=1)["variables"]) == 1
assert harness.kernel_state(limit=1)["totalVariables"] > 1
for invalid in [-1, 1001, True, 1.5]:
    try:
        harness.kernel_state(limit=invalid)
    except ValueError:
        pass
    else:
        raise AssertionError("invalid limit accepted")
print(json.dumps({"generation": snapshot["generation"]}))`);
		const previous = JSON.parse(inspected.output.trim()) as { generation: string };
		expect(previous.generation).toBeString();
		await run("probe_task.cancel(); del probe_nested");
		await run(
			'assert "probe_nested" not in harness.defs(); assert not any(v["name"] == "probe_nested" for v in harness.kernel_state()["variables"])',
		);
		const crashed = await executePython("import proto_harness as harness\n" + "import os; os._exit(17)", options);
		expect(crashed.output).toContain("completion is uncertain");
		await expect(run("print('must not silently recover')")).rejects.toThrow("Declared state was lost");
		const next = await executePython(
			'import proto_harness as harness; assert "probe_evil" not in globals(); import json; print(json.dumps({"generation": harness.kernel_state()["generation"]}))',
			{ ...options, reset: true },
		);
		expect(next.exitCode, next.output).toBe(0);
		const restarted = JSON.parse(next.output.trim()) as { generation: string };
		expect(restarted.generation).not.toBe(previous.generation);
		expect(events.filter(event => event.op === "kernel-state").map(event => event.generation)).toContain(
			restarted.generation,
		);
	} finally {
		await disposeKernelSessionsByOwner(ownerId);
	}
}, 60_000);
