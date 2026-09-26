import { expect, test } from "bun:test";
import { Settings } from "../../config/settings";
import type { ToolSession } from "../../tools";
import { disposeVmContextsByOwner } from "./context-manager";
import { executeJs } from "./executor";

async function session(): Promise<ToolSession> {
	const cwd = process.cwd();
	return {
		cwd,
		hasUI: false,
		settings: await Settings.loadReadOnly({ cwd, agentDir: cwd, inMemory: true }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
}

test("JavaScript returns bounded rich displays instead of retaining the audit's sixteen MiB", async () => {
	const toolSession = await session();
	const owner = `display-output:${crypto.randomUUID()}`;
	try {
		const result = await executeJs('for (let i = 0; i < 16; i++) display({ i, s: "x".repeat(1048576) });', {
			runtime: "bun",
			session: toolSession,
			sessionId: owner,
			kernelOwnerId: owner,
		});
		expect(result.exitCode).toBe(0);
		expect(Buffer.byteLength(JSON.stringify(result.displayOutputs))).toBeLessThan(257 * 1024);
		expect(result.displayOutputs.some(output => output.type === "notice" && output.text.includes("omitted"))).toBe(
			true,
		);
	} finally {
		await disposeVmContextsByOwner(owner);
	}
});

test("completed-output eviction cannot erase a large image from the current JavaScript result", async () => {
	const toolSession = await session();
	const owner = `display-image:${crypto.randomUUID()}`;
	try {
		const result = await executeJs('display({type:"image", data:"A".repeat(1024 * 1024), mimeType:"image/png"});', {
			runtime: "bun",
			session: toolSession,
			sessionId: owner,
			kernelOwnerId: owner,
		});
		expect(result.exitCode).toBe(0);
		const image = result.displayOutputs.find(output => output.type === "image");
		expect(image?.type === "image" ? image.data.length : 0).toBe(1024 * 1024);
	} finally {
		await disposeVmContextsByOwner(owner);
	}
});
