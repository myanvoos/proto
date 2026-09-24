import { afterEach, expect, test, vi } from "bun:test";
import { Settings } from "../../config/settings";
import type { ToolSession } from "../../tools";
import { disposeVmContextsByOwner, executeInVmContext } from "./context-manager";

afterEach(() => vi.restoreAllMocks());

test("completed JavaScript output sinks stay within the byte budget across 300 cells", async () => {
	const cwd = process.cwd();
	const settings = await Settings.loadReadOnly({ cwd, agentDir: cwd, inMemory: true });
	const toolSession: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
	const sessionId = `test-retention:${crypto.randomUUID()}`;
	const ownerId = `test-owner:${crypto.randomUUID()}`;
	const retained = new Set<{ bytes: number }>();
	let released = 0;
	try {
		for (let index = 0; index < 300; index++) {
			const buffer = { bytes: 3 * 1024 };
			retained.add(buffer);
			await executeInVmContext({
				sessionKey: sessionId,
				sessionId,
				ownerId,
				cwd,
				session: toolSession,
				code: `console.log("cell-${index}")`,
				filename: `retention-${index}.js`,
				runState: {
					onText: () => undefined,
					retainedBytes: () => buffer.bytes,
					release: () => {
						if (buffer.bytes > 0) released++;
						buffer.bytes = 0;
					},
				},
			});
		}
		expect([...retained].reduce((sum, buffer) => sum + buffer.bytes, 0)).toBeLessThanOrEqual(512 * 1024);
		expect(released).toBeGreaterThan(0);
	} finally {
		await disposeVmContextsByOwner(ownerId);
	}
}, 60_000);
