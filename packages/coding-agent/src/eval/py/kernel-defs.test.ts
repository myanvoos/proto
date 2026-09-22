import { expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { disposeKernelSessionsByOwner, executePython } from "./executor";

test("defs() reports every kernel-defined name with the cell that defined it", async () => {
	using tempDir = TempDir.createSync("@python-kernel-defs-");
	const ownerId = `test-owner:${crypto.randomUUID()}`;
	const options = {
		cwd: tempDir.path(),
		artifactsDir: tempDir.path(),
		sessionId: `test-session:${crypto.randomUUID()}`,
		kernelOwnerId: ownerId,
		kernelMode: "session" as const,
		timeoutMs: 20_000,
	};

	try {
		await executePython("probe_total = 41 + 1\nimport json as probe_json", options);
		await executePython("def probe_fn():\n    return probe_total", options);
		const listed = await executePython(
			"print(sorted(defs()))\nprint(defs()['probe_total'] < defs()['probe_fn'])",
			options,
		);

		expect(listed.output).toContain("'probe_fn'");
		expect(listed.output).toContain("'probe_total'");
		expect(listed.output).toContain("'probe_json'");
		expect(listed.output).toContain("True");
	} finally {
		await disposeKernelSessionsByOwner(ownerId);
	}
}, 120_000);
