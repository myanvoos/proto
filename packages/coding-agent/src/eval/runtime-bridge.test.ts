import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../config/settings";
import type { ToolSession } from "../tools";
import { recordExecution, runEvalRuntime } from "./runtime-bridge";

let root: string;
let session: ToolSession;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-contract-"));
	session = {
		cwd: root,
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});
async function query(extra: Record<string, unknown> = {}) {
	const result = await runEvalRuntime({ op: "executions", ...extra }, { session });
	if (!("records" in result)) throw new Error("Expected records");
	return result;
}
function checkpoint(op: "checkpoint_save" | "checkpoint_load", extra: Record<string, unknown> = {}) {
	return runEvalRuntime({ op, path: "cache", key: "key", ...extra }, { session });
}
function checkpointFile(key = "key") {
	return path.join(root, "cache", `${new Bun.CryptoHasher("sha256").update(key).digest("hex")}.json`);
}
test("execution history snapshots inputs and outputs and isolates sessions", async () => {
	const record = {
		id: "one",
		command: "echo one",
		lane: "shell",
		startedAt: 1,
		result: { content: [{ type: "text" as const, text: "one" }], details: { value: 1 } },
	};
	recordExecution(session, record);
	record.result.details.value = 2;
	const first = await query();
	expect(first.records[0].result?.details).toEqual({ value: 1 });
	first.records[0].command = "changed";
	expect((await query()).records[0].command).toBe("echo one");
	expect(await runEvalRuntime({ op: "executions" }, { session: { ...session } })).toEqual({ records: [], evicted: 0 });
	expect((await query({ limit: 0 })).records).toEqual([]);
	expect((await query({ id: "missing" })).records).toEqual([]);
});
test("execution history updates identity and enforces count and byte bounds including a single oversized result", async () => {
	for (let i = 0; i < 130; i++)
		recordExecution(session, { id: String(i), command: "true", lane: "shell", startedAt: i });
	expect((await query({ limit: 128 })).records).toHaveLength(128);
	expect((await query()).evicted).toBe(2);
	recordExecution(session, { id: "129", command: "true", lane: "shell", startedAt: 129, finishedAt: 130 });
	expect((await query({ id: "129" })).records).toHaveLength(1);
	recordExecution(session, {
		id: "huge",
		command: "print",
		lane: "python",
		startedAt: 131,
		result: { content: [{ type: "text", text: "x".repeat(9 * 1024 * 1024) }], details: {} },
	});
	expect(Buffer.byteLength(JSON.stringify(await query({ limit: 128 })))).toBeLessThanOrEqual(8 * 1024 * 1024);
});
test("invalid execution identities and unserializable results do not poison history", async () => {
	expect(() => recordExecution(session, { id: "", command: "true", lane: "shell", startedAt: 1 })).toThrow();
	await expect(query({ id: 5 })).rejects.toThrow();
	const cycle: Record<string, unknown> = {};
	cycle.self = cycle;
	recordExecution(session, {
		id: "cycle",
		command: "true",
		lane: "shell",
		startedAt: 1,
		result: { content: [], details: cycle },
	});
	expect((await query()).records[0].id).toBe("cycle");
	expect((await query()).records[0].result).toBeUndefined();
});
test("checkpoint round trips JSON values and isolates keys and directories", async () => {
	expect(await checkpoint("checkpoint_load")).toEqual({ found: false });
	expect(await checkpoint("checkpoint_save", { value: { nested: [null, 1, "a"] } })).toEqual({ saved: true });
	expect(await checkpoint("checkpoint_load")).toEqual({ found: true, value: { nested: [null, 1, "a"] } });
	expect(await checkpoint("checkpoint_load", { key: "other" })).toEqual({ found: false });
	expect(await checkpoint("checkpoint_load", { path: "other" })).toEqual({ found: false });
});
test("serialization fails before directory creation and leaves prior checkpoints untouched", async () => {
	const cycle: Record<string, unknown> = {};
	cycle.self = cycle;
	await expect(checkpoint("checkpoint_save", { value: cycle })).rejects.toThrow();
	expect(await fs.readdir(root)).toEqual([]);
	await checkpoint("checkpoint_save", { value: "old" });
	await expect(checkpoint("checkpoint_save", { value: 1n })).rejects.toThrow();
	await expect(checkpoint("checkpoint_save", { value: undefined })).rejects.toThrow();
	expect(await checkpoint("checkpoint_load")).toEqual({ found: true, value: "old" });
});
test("checkpoint serialization occurs once and validates the serialized envelope", async () => {
	let calls = 0;
	await checkpoint("checkpoint_save", {
		value: {
			toJSON() {
				calls++;
				return calls;
			},
		},
	});
	expect(calls).toBe(1);
	expect(await checkpoint("checkpoint_load")).toEqual({ found: true, value: 1 });
	await expect(
		checkpoint("checkpoint_save", {
			value: {
				toJSON() {
					return undefined;
				},
			},
		}),
	).rejects.toThrow();
});
test("checkpoint rejects corrupt envelopes, wrong identity, oversized input and invalid paths", async () => {
	await fs.mkdir(path.join(root, "cache"));
	for (const body of [
		"{",
		"null",
		"[]",
		'{"version":2,"key":"key","value":1}',
		'{"version":1,"key":"other","value":1}',
		'{"version":1,"key":"key"}',
	]) {
		await fs.writeFile(checkpointFile(), body);
		await expect(checkpoint("checkpoint_load")).rejects.toThrow(/Checkpoint/);
	}
	await expect(checkpoint("checkpoint_save", { path: "", value: 1 })).rejects.toThrow();
	await expect(checkpoint("checkpoint_save", { key: "", value: 1 })).rejects.toThrow();
	await expect(checkpoint("checkpoint_save", { value: "x".repeat(8 * 1024 * 1024) })).rejects.toThrow(/8 MiB/);
	await fs.writeFile(checkpointFile(), " ".repeat(8 * 1024 * 1024 + 1));
	await expect(checkpoint("checkpoint_load")).rejects.toThrow(/8 MiB/);
});
test("checkpoint replacement is atomic for concurrent readers and writers", async () => {
	await checkpoint("checkpoint_save", { value: "initial" });
	const values = Array.from({ length: 8 }, (_, i) => String(i).repeat(10000));
	await Promise.all(
		values.map(async value => {
			await checkpoint("checkpoint_save", { value });
			const loaded = await checkpoint("checkpoint_load");
			expect("value" in loaded && typeof loaded.value === "string" && values.includes(loaded.value)).toBe(true);
		}),
	);
	expect((await fs.readdir(path.join(root, "cache"))).filter(name => name.endsWith(".tmp"))).toEqual([]);
});
test("pre-cancelled runtime operations do not mutate", async () => {
	await expect(
		runEvalRuntime(
			{ op: "checkpoint_save", path: "cache", key: "key", value: 1 },
			{ session, signal: AbortSignal.abort() },
		),
	).rejects.toThrow();
	expect(await fs.readdir(root)).toEqual([]);
});

test("execution byte eviction counts complete records and replacement updates accounting", async () => {
	const payload = "x".repeat(1024 * 1024);
	for (let i = 0; i < 10; i++)
		recordExecution(session, {
			id: String(i),
			command: "large",
			lane: "python",
			startedAt: i,
			result: { content: [{ type: "text", text: payload }], details: {} },
		});
	const result = await query({ limit: 128 });
	expect(result.evicted).toBe(3);
	expect(result.records.map(record => record.id)).toEqual(["3", "4", "5", "6", "7", "8", "9"]);
	recordExecution(session, {
		id: "9",
		command: "small",
		lane: "python",
		startedAt: 9,
		resultOmitted: "executions query",
	});
	recordExecution(session, {
		id: "10",
		command: "large",
		lane: "python",
		startedAt: 10,
		result: { content: [{ type: "text", text: payload }], details: {} },
	});
	expect((await query({ limit: 128 })).evicted).toBe(3);
	expect((await query({ id: "9" })).records[0].resultOmitted).toBe("executions query");
});
test("invalid runtime flags and unknown operations fail without mutations", async () => {
	for (const args of [
		{ op: "unknown" },
		{ op: "executions", limit: -1 },
		{ op: "executions", limit: 129 },
		{ op: "edit_batch", apply: "true", changes: [{ path: "new", before: null, after: "x" }] },
	]) {
		await expect(runEvalRuntime(args, { session })).rejects.toThrow();
	}
	expect(await fs.readdir(root)).toEqual([]);
});

test("cancellation during checkpoint serialization happens before disk mutation", async () => {
	const controller = new AbortController();
	await expect(
		runEvalRuntime(
			{
				op: "checkpoint_save",
				path: "cache",
				key: "key",
				value: {
					toJSON() {
						controller.abort();
						return "cancelled";
					},
				},
			},
			{ session, signal: controller.signal },
		),
	).rejects.toThrow();
	expect(await fs.readdir(root)).toEqual([]);
});

test("validated history queries emit an internal query signal even for empty results", async () => {
	const events: Array<{ op: string }> = [];
	const options = {
		session,
		emitStatus: (event: { op: string }) => {
			events.push(event);
		},
	};
	await expect(runEvalRuntime({ op: "executions", limit: -1 }, options)).rejects.toThrow();
	await expect(runEvalRuntime({ op: "executions", id: 7 }, options)).rejects.toThrow();
	expect(events).toEqual([]);
	expect(await runEvalRuntime({ op: "executions", limit: 0 }, options)).toEqual({ records: [], evicted: 0 });
	expect(events).toEqual([{ op: "execution-query" }]);
});
