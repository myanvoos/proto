import { expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../config/settings";
import type { ToolSession } from "../../tools";
import { disposeVmContextsByOwner, executeInVmContext } from "./context-manager";

test("reports uncertain completion without replaying a cell after the JS worker dies", async () => {
	using tempDir = TempDir.createSync("@js-worker-crash-");
	const cwd = tempDir.path();
	const settings = await Settings.loadReadOnly({ cwd, agentDir: cwd, inMemory: true });
	const toolSession: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
	const sessionId = `test-session:${crypto.randomUUID()}`;
	const ownerId = `test-owner:${crypto.randomUUID()}`;
	const effectsPath = path.join(cwd, "effects.txt");
	const crashCode = [
		`const effectsPath = ${JSON.stringify(effectsPath)};`,
		'const previous = await Bun.file(effectsPath).text().catch(() => "");',
		'await Bun.write(effectsPath, previous + "once\\n");',
		"process.exit(17);",
	].join("\n");

	try {
		await expect(
			executeInVmContext({
				sessionKey: sessionId,
				sessionId,
				ownerId,
				cwd,
				session: toolSession,
				code: crashCode,
				filename: "crashing-cell.js",
				runState: {},
			}),
		).rejects.toThrow("completion is uncertain");
		expect(await Bun.file(effectsPath).text()).toBe("once\n");

		await executeInVmContext({
			sessionKey: sessionId,
			sessionId,
			ownerId,
			cwd,
			session: toolSession,
			code: `await Bun.write(${JSON.stringify(effectsPath)}, (await Bun.file(${JSON.stringify(effectsPath)}).text()) + "next\\n");`,
			filename: "next-cell.js",
			runState: {},
		});
		expect(await Bun.file(effectsPath).text()).toBe("once\nnext\n");
	} finally {
		await disposeVmContextsByOwner(ownerId);
	}
}, 30_000);
