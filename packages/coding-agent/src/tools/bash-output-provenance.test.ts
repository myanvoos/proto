import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Shell } from "@oh-my-pi/pi-natives";
import { AsyncJobManager } from "../async";
import { Settings } from "../config/settings";
import { disposeBashSessions } from "../exec/bash-executor";
import type { ToolSession } from ".";
import { BashTool, bashCardOutput } from "./bash";

afterEach(() => vi.restoreAllMocks());

async function fixture(run: (tool: BashTool, dir: string) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-provenance-"));
	const manager = new AsyncJobManager({});
	const session = {
		cwd: dir,
		asyncJobManager: manager,
		settings: Settings.isolated({ "async.enabled": true }),
		getSessionId: () => dir,
		getSessionFile: () => null,
		allocateOutputArtifact: async () => ({ id: "1", path: path.join(dir, "1.log") }),
	} as unknown as ToolSession;
	try {
		await run(new BashTool(session), dir);
	} finally {
		await manager.dispose();
		await disposeBashSessions(dir);
		await fs.rm(dir, { recursive: true, force: true });
	}
}

test("subsecond stdout resembling a timing footer remains visible in the bash card", async () => {
	spyOn(performance, "now").mockReturnValue(0);
	await fixture(async tool => {
		const result = await tool.execute("timing-stdout", { command: "printf 'Wall time: 0.00 seconds\n'" });
		const text = result.content.find(block => block.type === "text")!.text;
		expect(result.details?.wallTimeNoticeEmitted).toBe(false);
		expect(bashCardOutput(text, result.details).text).toContain("Wall time: 0.00 seconds");
	});
});

test("minimized bash output reports the actual filter and byte counts beside a recoverable raw artifact", async () => {
	const run = Shell.prototype.run;
	spyOn(Shell.prototype, "run").mockImplementation(async function (this: Shell, options, onChunk, dispatcher) {
		const result = await run.call(this, options, onChunk, dispatcher);
		return {
			...result,
			minimized: {
				filter: "lint",
				text: "summary\n",
				originalText: "full diagnostics\n",
				inputBytes: 17,
				outputBytes: 8,
			},
		};
	});
	await fixture(async (tool, dir) => {
		const result = await tool.execute("minimized", { command: "printf 'full diagnostics\n'" });
		expect(result.details?.meta?.minimized).toEqual({
			filter: "lint",
			inputBytes: 17,
			outputBytes: 8,
			artifactId: "1",
		});
		expect(await Bun.file(path.join(dir, "1.log")).text()).toBe("full diagnostics\n");
		const text = result.content.find(block => block.type === "text")!.text;
		expect(text).toContain("summary");
		expect(text).toContain("artifact://1");
	});
});

test.each([0, 12])("background bash start discloses its effective deadline for timeout=%s", async timeout => {
	await fixture(async tool => {
		const result = await tool.execute("deadline", { command: "sleep 0.01", async: true, timeout });
		const text = result.content.find(block => block.type === "text")!.text;
		expect(text).toContain(timeout === 0 ? "no deadline" : "12s");
		expect(result.details?.timeoutDisabled ?? false).toBe(timeout === 0);
	});
});
