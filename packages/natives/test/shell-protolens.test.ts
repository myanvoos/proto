import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Shell } from "../native/index.js";

test("shell runs a plain command without file or protolens records", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "native-shell-plain-"));
	const shell = new Shell();
	try {
		let output = "";
		const result = await shell.run({ cwd, command: "echo hi" }, (_error, chunk) => {
			output += chunk;
		});
		expect(result.exitCode).toBe(0);
		expect(output).toBe("hi\n");
		expect(result.fsObservations).toEqual([]);
		expect(result.protolensDispatches).toEqual([]);
		expect(Array.isArray(result.stageRecords)).toBe(true);
	} finally {
		await shell.close();
		await rm(cwd, { recursive: true, force: true });
	}
});

test("shell dispatches protolens through the callback and collects its record", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "native-shell-protolens-"));
	const shell = new Shell();
	try {
		const requests: string[] = [];
		let output = "";
		const result = await shell.run(
			{ cwd, command: "protolens probe --flag", protolensCallId: "call-42" },
			(_error, chunk) => {
				output += chunk;
			},
			async request => {
				requests.push(request);
				return JSON.stringify({
					stdout: "device-out\n",
					stderr: "",
					exitCode: 0,
					record: '{"kind":"probe"}',
				});
			},
		);
		expect(result.exitCode).toBe(0);
		expect(output).toBe("device-out\n");
		expect(requests).toHaveLength(1);
		const request = JSON.parse(requests[0]!);
		expect(request.name).toBe("probe");
		expect(request.args).toEqual(["--flag"]);
		expect(request.callId).toBe("call-42");
		expect(result.protolensDispatches).toEqual(['{"kind":"probe"}']);
		const stages = result.stageRecords.map(record => JSON.parse(record));
		expect(stages.some(stage => stage.route === "protolens")).toBe(true);
	} finally {
		await shell.close();
		await rm(cwd, { recursive: true, force: true });
	}
});

test("protolens without a dispatcher fails with 127", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "native-shell-protolens-none-"));
	const shell = new Shell();
	try {
		const result = await shell.run({ cwd, command: "protolens probe" });
		expect(result.exitCode).toBe(127);
		expect(result.protolensDispatches).toEqual([]);
	} finally {
		await shell.close();
		await rm(cwd, { recursive: true, force: true });
	}
});
