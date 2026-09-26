import { expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../config/settings";
import type { ToolSession } from "../../tools";
import { disposeVmContextsByOwner, executeInVmContext } from "./context-manager";
import { JsRuntime } from "./shared/runtime";
import { saveKernelState } from "./shared/state";

async function harness(cwd: string) {
	const owner = `state:${crypto.randomUUID()}`;
	const settings = await Settings.loadReadOnly({ cwd, agentDir: cwd, inMemory: true });
	const session: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
	return {
		async run(code: string, reset = false) {
			let output = "";
			await executeInVmContext({
				runtime: "bun",
				sessionKey: owner,
				sessionId: owner,
				ownerId: owner,
				cwd,
				session,
				code,
				filename: "state-test.js",
				reset,
				runState: {
					onText: text => {
						output += text;
					},
					onDisplay: () => {},
				},
			});
			return output;
		},
		async [Symbol.asyncDispose]() {
			await disposeVmContextsByOwner(owner);
		},
	};
}

test("JavaScript selected bindings survive process reset and restore usable bytes rather than executable heap", async () => {
	using directory = TempDir.createSync("@js-state-");
	await using kernel = await harness(directory.path());
	await kernel.run(`var savedPid = process.pid;
var savedGeneration = kernelState().generation;
var persisted = { nested: [null, true, 2.5, "雪", {type: "bytes", payload: new Uint8Array([0, 255])}], buffer: Buffer.from("abc"), arrayBuffer: new Uint8Array([4, 5]).buffer, zero: -0, nullObject: Object.assign(Object.create(null), {key: 7}), artifact: {type: "artifact", version: 1, uri: "artifact://1", owner: "session", mimeType: "application/octet-stream", bytes: 2, sha256: "ab".repeat(32)} };
var counter = 40;
var unselected = () => "never replay";
await saveState("bindings.json", ["persisted", "counter", "savedPid", "savedGeneration"]);`);
	const snapshot = await Bun.file(directory.join("bindings.json")).json();
	expect(snapshot).toMatchObject({
		format: "proto.kernel-state",
		version: 1,
		language: "javascript",
		interpreter: { implementation: "bun" },
	});
	await kernel.run(
		`if (Object.hasOwn(globalThis, "persisted") || Object.hasOwn(globalThis, "unselected")) throw Error("reset retained bindings");
await loadState("bindings.json");
if (savedPid === process.pid || savedGeneration === kernelState().generation) throw Error("kernel process did not restart");
if (counter + 2 !== 42 || persisted.nested[3] !== "雪") throw Error("JSON values did not restore");
if (!(persisted.nested[4].payload instanceof Uint8Array) || persisted.nested[4].payload[1] !== 255) throw Error("bytes are unusable");
if (!Buffer.isBuffer(persisted.buffer) || persisted.buffer.toString() !== "abc") throw Error("Buffer kind lost");
if (!(persisted.arrayBuffer instanceof ArrayBuffer) || new Uint8Array(persisted.arrayBuffer)[1] !== 5) throw Error("ArrayBuffer kind lost");
if (!Object.is(persisted.zero, -0) || Object.getPrototypeOf(persisted.nullObject) !== null) throw Error("data shape lost");
if (persisted.artifact.uri !== "artifact://1" || persisted.artifact.sha256 !== "ab".repeat(32)) throw Error("artifact ref lost");
if (defs().persisted !== kernelState().executionCount) throw Error("restored binding provenance missing");
await Bun.write("restored.bin", persisted.nested[4].payload);`,
		true,
	);
	expect(new Uint8Array(await Bun.file(directory.join("restored.bin")).arrayBuffer())).toEqual(
		new Uint8Array([0, 255]),
	);
}, 60_000);

test("JavaScript restore rejects collisions, accessors, corruption, and incompatible metadata without partial mutation", async () => {
	using directory = TempDir.createSync("@js-state-validation-");
	await using kernel = await harness(directory.path());
	await kernel.run(`var first = 1;
var second = Buffer.from("ok");
await saveState("valid.json", ["first", "second"]);`);
	await kernel.run(`delete globalThis.first;
second = "existing";
var collisionRejected = false;
try { await loadState("valid.json"); } catch (error) { collisionRejected = /collision/.test(error.message); }
if (!collisionRejected || Object.hasOwn(globalThis, "first") || second !== "existing") throw Error("collision changed bindings");
await loadState("valid.json", {collision: "overwrite"});
if (first !== 1 || second.toString() !== "ok") throw Error("overwrite did not restore");
delete globalThis.first;
delete globalThis.second;
var probeCalls = 0;
Object.defineProperty(globalThis, "second", {get() { probeCalls++; throw Error("getter invoked"); }, configurable: true});
var accessorRejected = false;
try { await loadState("valid.json", {collision: "overwrite"}); } catch (error) { accessorRejected = /accessor/.test(error.message); }
if (!accessorRejected || probeCalls !== 0 || Object.hasOwn(globalThis, "first")) throw Error("accessor restore mutated state");
Object.defineProperty(globalThis, "second", {value: "locked", writable: false, configurable: true});
var readonlyRejected = false;
try { await loadState("valid.json", {collision: "overwrite"}); } catch (error) { readonlyRejected = /read-only/.test(error.message); }
if (!readonlyRejected || second !== "locked" || Object.hasOwn(globalThis, "first")) throw Error("read-only restore mutated state");
delete globalThis.second;
var original = await Bun.file("valid.json").text();
var rejected = async (snapshot, expected) => {
    await Bun.write("bad.json", JSON.stringify(snapshot));
    var rejectedError;
    try { await loadState("bad.json"); } catch (error) { rejectedError = error; }
    if (!rejectedError || !rejectedError.message.includes(expected)) throw Error("invalid snapshot accepted: " + expected);
    if (Object.hasOwn(globalThis, "first") || Object.hasOwn(globalThis, "second")) throw Error("invalid snapshot partially restored");
};
for (var [key, value, expected] of [["version", 2, "version"], ["language", "other", "language"], ["format", "other", "format"]]) {
    var snapshot = JSON.parse(original); snapshot[key] = value; await rejected(snapshot, expected);
}
var snapshot = JSON.parse(original);
snapshot.interpreter.executable = null;
await rejected(snapshot, "metadata");
snapshot = JSON.parse(original);
snapshot.bindings[1].value.value = "%%%";
await rejected(snapshot, "bytes");
snapshot = JSON.parse(original); snapshot.bindings.push(snapshot.bindings[0]); await rejected(snapshot, "duplicate");
snapshot = JSON.parse(original); snapshot.bindings[1].name = "saveState"; await rejected(snapshot, "reserved");
await Bun.write("bad.json", original.slice(0, -4));
var corruptRejected = false;
try { await loadState("bad.json"); } catch (error) { corruptRejected = /JSON/.test(error.message); }
if (!corruptRejected || Object.hasOwn(globalThis, "first")) throw Error("corrupted JSON changed state");
for (var options of [{collision: true}, {collision: null}, {collision: "replace"}, {other: true}]) {
    var invalidRejected = false;
    try { await loadState("valid.json", options); } catch { invalidRejected = true; }
    if (!invalidRejected) throw Error("invalid options accepted");
}
console.log("validation was atomic");`);
}, 60_000);

test("JavaScript encoding never invokes getters, proxy traps, or toJSON and failed saves preserve the previous snapshot", async () => {
	using directory = TempDir.createSync("@js-state-safe-");
	await using kernel = await harness(directory.path());
	await kernel.run(`var good = [1, {plain: true}];
await saveState("safe.json", ["good"]);
var original = await Bun.file("safe.json").text();
var probeCalls = 0;
var evil = new Proxy({}, {get() {probeCalls++; throw Error("get trap");}, ownKeys() {probeCalls++; throw Error("keys trap");}, getPrototypeOf() {probeCalls++; throw Error("prototype trap");}});
var accessor = {get value() {probeCalls++; throw Error("getter");}};
var serializer = {toJSON() {probeCalls++; throw Error("toJSON");}};
var cycle = []; cycle.push(cycle);
for (var unsafe of [evil, accessor, serializer, cycle, () => 1, new Map(), new Date(), 1n, undefined, NaN, [,,], Symbol("resource")]) {
    globalThis.unsafe = unsafe;
    var rejected = false;
    try { await saveState("safe.json", ["good", "unsafe"]); } catch { rejected = true; }
    if (!rejected || await Bun.file("safe.json").text() !== original) throw Error("unsafe save replaced snapshot");
}
Object.defineProperty(globalThis, "unsafeGetter", {get() {probeCalls++; throw Error("binding getter");}, configurable: true});
var rejected = false;
try { await saveState("safe.json", ["unsafeGetter"]); } catch { rejected = true; }
if (!rejected || probeCalls !== 0) throw Error("encoding invoked user hooks");
delete globalThis.unsafeGetter;
for (var names of [[], ["good", "good"], ["absent"], ["saveState"], "good", new Proxy(["good"], {get() {probeCalls++; throw Error("names getter");}})]) {
    var rejected = false;
    try { await saveState("safe.json", names); } catch { rejected = true; }
    if (!rejected) throw Error("invalid selection accepted");
}
if (probeCalls !== 0 || await Bun.file("safe.json").text() !== original) throw Error("invalid selection changed snapshot");
console.log("encoding ran no user hooks");`);
}, 60_000);

test("restored JavaScript globals are removed on runtime disposal and can be loaded by a new runtime", async () => {
	using directory = TempDir.createSync("@js-state-ownership-");
	const name = `stateOwned${crypto.randomUUID().replaceAll("-", "")}`;
	const snapshotPath = directory.join("owned.json");
	await saveKernelState(snapshotPath, [name], { [name]: { value: 41 } }, new Set());
	for (let pass = 0; pass < 2; pass++) {
		const runtime = new JsRuntime({ initialCwd: directory.path(), sessionId: crypto.randomUUID() });
		try {
			await runtime.loadState(snapshotPath);
			expect(
				await runtime.run(`${name}.value + 1`, "state-owned.js", {
					onText: () => {},
					onDisplay: () => {},
					callTool: async () => null,
				}),
			).toBe(42);
		} finally {
			runtime.dispose();
		}
		expect(Object.hasOwn(globalThis, name)).toBe(false);
	}
}, 10_000);
