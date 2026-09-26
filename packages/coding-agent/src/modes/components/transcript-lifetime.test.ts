import { expect, test } from "bun:test";

test("eviction and empty resets collect components while builder and durable message keys remain alive", async () => {
	const child = Bun.spawn(
		[process.execPath, new URL("../../../test/fixtures/transcript-lifetime.ts", import.meta.url).pathname],
		{
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	expect(JSON.parse(stdout)).toEqual({
		evictedExpandables: 0,
		clearedComponent: 0,
		retiredWhileMessagesRemain: 0,
		retainedMessages: 1100,
		retainedBlocks: 1000,
	});
}, 20_000);
