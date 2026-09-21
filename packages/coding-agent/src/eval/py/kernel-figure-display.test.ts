import { describe, expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { KernelDisplayOutput } from "./display";
import { disposeKernelSessionsByOwner, executePython } from "./executor";
import { checkPythonKernelAvailability } from "./kernel";

describe("Python kernel figure display", () => {
	test("closed figures saved with savefig still display at cell end", async () => {
		// Contract: an agent cell that does `fig.savefig(...); plt.close(fig)` —
		// the dominant plotting pattern — must still surface an image/png
		// display output, or plotted analysis results never reach the TUI.
		const availability = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
		if (!availability.ok) {
			console.warn("skipping figure display test: no local Python kernel");
			return;
		}
		using tempDir = TempDir.createSync("@python-figure-display-");
		const ownerId = `test-owner:${crypto.randomUUID()}`;
		const sessionId = `test-session:${crypto.randomUUID()}`;
		const options = {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: ownerId,
			kernelMode: "session" as const,
			timeoutMs: 60_000,
		};
		try {
			const probe = await executePython("import matplotlib; print(matplotlib.get_backend())", options);
			if (!probe.output.toLowerCase().includes("agg")) {
				console.warn("skipping figure display test: matplotlib unavailable");
				return;
			}
			const result = await executePython(
				[
					"import matplotlib",
					"matplotlib.use('Agg')",
					"import matplotlib.pyplot as plt",
					"fig, ax = plt.subplots()",
					"ax.plot([1, 2], [3, 4])",
					"fig.savefig('out.png')",
					"plt.close(fig)",
				].join("\n"),
				options,
			);
			const image = result.displayOutputs.find(
				(output): output is Extract<KernelDisplayOutput, { type: "image" }> =>
					output.type === "image" && output.mimeType === "image/png",
			);
			expect(image).toBeDefined();
			if (!image) throw new Error("expected image display output");
			expect(image.data.startsWith("iVBOR")).toBe(true);
		} finally {
			await disposeKernelSessionsByOwner(ownerId);
		}
	}, 120_000);
});
