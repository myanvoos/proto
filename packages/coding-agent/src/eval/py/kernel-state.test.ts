import { expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { disposeKernelSessionsByOwner, executePython } from "./executor";

test("Python selected bindings survive process reset with usable nested bytes and artifact references", async () => {
	using directory = TempDir.createSync("@python-state-");
	const owner = `state:${crypto.randomUUID()}`;
	const options = {
		cwd: directory.path(),
		artifactsDir: directory.path(),
		sessionId: owner,
		kernelOwnerId: owner,
		kernelMode: "session" as const,
		timeoutMs: 20_000,
	};
	const run = async (code: string, reset = false) => {
		const result = await executePython(code, { ...options, reset });
		expect(result.exitCode, result.output).toBe(0);
		return result.output;
	};
	try {
		await run(`persisted = {"nested": [None, True, 2.5, "雪", {"type": "bytes", "payload": b"\\x00\\xff"}], "mutable": bytearray(b"abc"), "artifact": {"type": "artifact", "version": 1, "uri": "artifact://1", "owner": "session", "mimeType": "application/octet-stream", "bytes": 2, "sha256": "ab" * 32}}
counter = 40
saved_pid = os.getpid()
saved_generation = kernel_state()["generation"]
unselected = lambda: "never replay"
result = save_state("bindings.json", ["persisted", "counter", "saved_pid", "saved_generation"])
assert result["names"] == ["persisted", "counter", "saved_pid", "saved_generation"]
import sys
assert result["interpreter"]["implementation"] == sys.implementation.name
assert result["interpreter"]["executable"] == sys.executable`);
		const stored = await Bun.file(directory.join("bindings.json")).json();
		expect(stored).toMatchObject({
			format: "proto.kernel-state",
			version: 1,
			language: "python",
			interpreter: { implementation: expect.any(String), executable: expect.any(String) },
		});
		await run(
			`assert "persisted" not in globals() and "unselected" not in globals()
load_state("bindings.json")
assert saved_pid != os.getpid()
assert saved_generation != kernel_state()["generation"]
assert persisted["nested"][:4] == [None, True, 2.5, "雪"]
assert persisted["nested"][4]["type"] == "bytes"
assert persisted["nested"][4]["payload"] == bytes([0, 255])
assert type(persisted["mutable"]) is bytearray
persisted["mutable"].append(100)
assert persisted["mutable"] == b"abcd"
assert persisted["artifact"]["uri"] == "artifact://1"
assert persisted["artifact"]["sha256"] == "ab" * 32
assert counter + 2 == 42
assert defs()["persisted"] == kernel_state()["executionCount"]
Path("restored.bin").write_bytes(persisted["nested"][4]["payload"])
print("restored usable state")`,
			true,
		);
		expect(new Uint8Array(await Bun.file(directory.join("restored.bin")).arrayBuffer())).toEqual(
			new Uint8Array([0, 255]),
		);
	} finally {
		await disposeKernelSessionsByOwner(owner);
	}
}, 60_000);

test("Python restore validates every binding and metadata before mutation and overwrite is explicit", async () => {
	using directory = TempDir.createSync("@python-state-validation-");
	const owner = `state:${crypto.randomUUID()}`;
	const options = {
		cwd: directory.path(),
		artifactsDir: directory.path(),
		sessionId: owner,
		kernelOwnerId: owner,
		kernelMode: "session" as const,
		timeoutMs: 20_000,
	};
	try {
		const result = await executePython(
			`first = 1
second = b"ok"
save_state("valid.json", ["first", "second"])
del first
second = "existing"
try:
    load_state("valid.json")
except ValueError as error:
    assert "collision" in str(error)
else:
    raise AssertionError("collision was silently overwritten")
assert "first" not in globals() and second == "existing"
load_state("valid.json", collision="overwrite")
assert first == 1 and second == b"ok"
del first, second
original = Path("valid.json").read_text()
def rejected(snapshot, expected):
    Path("bad.json").write_text(json.dumps(snapshot))
    try:
        load_state("bad.json")
    except ValueError as error:
        assert expected in str(error), str(error)
    else:
        raise AssertionError("invalid snapshot was accepted")
    assert "first" not in globals() and "second" not in globals()
for key, value, expected in [("version", 2, "version"), ("version", True, "version"), ("language", "other", "language"), ("format", "other", "format")]:
    snapshot = json.loads(original)
    snapshot[key] = value
    rejected(snapshot, expected)
snapshot = json.loads(original)
snapshot["interpreter"]["executable"] = None
rejected(snapshot, "metadata")
snapshot = json.loads(original)
snapshot["bindings"][1]["value"]["value"] = "%%%"
rejected(snapshot, "bytes")
snapshot = json.loads(original)
snapshot["bindings"][0]["value"] = {"type": "integer", "value": "+18446744073709551616"}
rejected(snapshot, "integer")
snapshot = json.loads(original)
snapshot["bindings"].append(snapshot["bindings"][0])
rejected(snapshot, "duplicate")
snapshot = json.loads(original)
snapshot["bindings"][1]["name"] = "save_state"
rejected(snapshot, "reserved")
Path("bad.json").write_text(original[:-4])
try:
    load_state("bad.json")
except ValueError as error:
    assert "JSON" in str(error)
else:
    raise AssertionError("corrupted JSON was accepted")
assert "first" not in globals() and "second" not in globals()
for policy in [True, None, "replace"]:
    try:
        load_state("valid.json", collision=policy)
    except ValueError:
        pass
    else:
        raise AssertionError("invalid collision policy accepted")
print("validation was atomic")`,
			options,
		);
		expect(result.exitCode, result.output).toBe(0);
		expect(result.output).toContain("validation was atomic");
	} finally {
		await disposeKernelSessionsByOwner(owner);
	}
}, 60_000);

test("Python encoding rejects executable objects and cycles without repr or metaclass hooks and preserves prior snapshot", async () => {
	using directory = TempDir.createSync("@python-state-safe-");
	const owner = `state:${crypto.randomUUID()}`;
	const options = {
		cwd: directory.path(),
		artifactsDir: directory.path(),
		sessionId: owner,
		kernelOwnerId: owner,
		kernelMode: "session" as const,
		timeoutMs: 20_000,
	};
	try {
		const result = await executePython(
			`good = [1, {"plain": True}]
save_state("safe.json", ["good"])
original = Path("safe.json").read_bytes()
probe_calls = 0
class EvilMeta(type):
    def __eq__(cls, other):
        global probe_calls
        probe_calls += 1
        raise AssertionError("metaclass equality invoked")
    @property
    def __name__(cls):
        global probe_calls
        probe_calls += 1
        raise AssertionError("metaclass name invoked")
class Evil(metaclass=EvilMeta):
    def __repr__(self):
        global probe_calls
        probe_calls += 1
        raise AssertionError("repr invoked")
class EvilDict(dict):
    def items(self):
        global probe_calls
        probe_calls += 1
        raise AssertionError("items invoked")
cycle = []
cycle.append(cycle)
resource = open("safe.json", "rb")
try:
    for unsafe in [Evil(), EvilDict(), lambda: 1, resource, cycle, {1: "key"}, float("nan"), (1, 2)]:
        try:
            save_state("safe.json", ["good", "unsafe"])
        except ValueError:
            pass
        else:
            raise AssertionError("unsupported state accepted")
        assert Path("safe.json").read_bytes() == original
finally:
    resource.close()
assert probe_calls == 0
for names in [[], ["good", "good"], ["absent"], ["save_state"], "good"]:
    try:
        save_state("safe.json", names)
    except ValueError:
        pass
    else:
        raise AssertionError("invalid selection accepted")
assert Path("safe.json").read_bytes() == original
print("encoding ran no user hooks")`,
			options,
		);
		expect(result.exitCode, result.output).toBe(0);
		expect(result.output).toContain("encoding ran no user hooks");
	} finally {
		await disposeKernelSessionsByOwner(owner);
	}
}, 60_000);
