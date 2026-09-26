import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { ComputerWorkerOutbound } from "./protocol";
import { ComputerWorkerCore, type NativeDesktopSession } from "./worker";

test("computer workers spill before transport and preserve admitted screenshots", async () => {
	using directory = TempDir.createSync("@computer-output-");
	const artifactPath = path.join(directory.path(), "output.log");
	const finished = Promise.withResolvers<Extract<ComputerWorkerOutbound, { type: "result" }>>();
	const closed = Promise.withResolvers<void>();
	const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
	const native: Pick<NativeDesktopSession, "capabilities" | "capture" | "close"> = {
		capabilities: {
			backend: "test",
			capture: true,
			input: false,
			ax: false,
			backgroundWindowInput: false,
			deliveryModes: [],
			capturePermission: "granted",
			inputPermission: "denied",
			axPermission: "denied",
			displayCount: 1,
		},
		capture: async () => ({
			data: Buffer.from(image, "base64"),
			width: 1,
			height: 1,
			sourceWidth: 1,
			sourceHeight: 1,
			target: "desktop",
		}),
		close: async () => {},
	};
	const core = new ComputerWorkerCore(
		{
			send: message => {
				if (message.type === "result") finished.resolve(message);
				if (message.type === "closed") closed.resolve();
			},
			onMessage: () => () => {},
			close: () => {},
		},
		() => native as NativeDesktopSession,
	);
	const screenshots: string[] = [];
	try {
		core.handle({
			type: "run",
			id: "output",
			timeoutMs: 5000,
			code: 'for (let i=0;i<16;i++) console.log("x".repeat(1048576)); await desktop.screenshot(); return {ok:true};',
			session: {
				cwd: directory.path(),
				sessionId: `computer-output:${crypto.randomUUID()}`,
				captureMaxWidth: 1280,
				captureMaxHeight: 896,
				display: "all",
				readOnly: true,
				outputArtifact: { path: artifactPath, id: "computer-output" },
			},
		});
		const message = await finished.promise;
		if (!message.ok) throw new Error(message.error.message);
		screenshots.push(...message.payload.screenshots.map(screenshot => screenshot.path));
		expect(message.payload.screenshots).toHaveLength(1);
		expect(message.payload.displays.filter(block => block.type === "image")).toEqual([
			{ type: "image", data: image, mimeType: "image/png" },
		]);
		expect(Buffer.byteLength(JSON.stringify(message.payload))).toBeLessThan(54 * 1024);
		expect(JSON.stringify(message.payload.displays)).toContain("artifact://computer-output");
		expect(await Bun.file(artifactPath).text()).toContain("ARTIFACT TRUNCATED");
	} finally {
		core.handle({ type: "close" });
		await closed.promise;
		await Promise.all(screenshots.map(file => fs.rm(file, { force: true })));
	}
});
