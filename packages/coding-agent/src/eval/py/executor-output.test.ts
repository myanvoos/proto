import { expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { KernelDisplayOutput } from "./display";
import { disposeKernelSessionsByOwner, executePython } from "./executor";
import { checkPythonKernelAvailability } from "./kernel";

const availability = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
const kernelTest = availability.ok ? test : test.skip;

kernelTest(
	"Python rich output is bounded at live admission and final collection",
	async () => {
		using directory = TempDir.createSync("@python-output-");
		const owner = `python-output:${crypto.randomUUID()}`;
		const streamed: KernelDisplayOutput[] = [];
		try {
			const result = await executePython('for i in range(16):\n    display({"i": i, "s": "x" * 1048576})', {
				cwd: directory.path(),
				sessionId: owner,
				kernelOwnerId: owner,
				kernelMode: "session",
				timeoutMs: 60_000,
				onDisplay: output => {
					if (output.type !== "status") streamed.push(output);
				},
			});
			expect(result.exitCode).toBe(0);
			expect(Buffer.byteLength(JSON.stringify(result.displayOutputs))).toBeLessThan(257 * 1024);
			expect(Buffer.byteLength(JSON.stringify(streamed))).toBeLessThan(257 * 1024);
			expect(streamed.some(output => output.type === "notice" && output.text.includes("omitted"))).toBe(true);
		} finally {
			await disposeKernelSessionsByOwner(owner);
		}
	},
	90_000,
);
