import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../config/settings";
import type { ToolSession } from ".";
import { ReadTool } from "./read";

test("profile line selectors address original bytes while whole-file summaries create no editable snapshot", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-read-profile-"));
	const source = JSON.stringify(
		{
			nodes: [{ id: 1, callFrame: { functionName: "hotFunction", url: "file:///app.ts" }, hitCount: 1 }],
			startTime: 0,
			endTime: 1000,
			samples: [1],
			timeDeltas: [1000],
		},
		null,
		2,
	);
	await Bun.write(path.join(root, "cpu.cpuprofile"), source);
	const session = {
		cwd: root,
		settings: Settings.isolated({ "read.summarize.enabled": false }),
		hasUI: false,
		canPromptUser: false,
		skills: [],
		additionalDirectories: [],
		getSessionFile: () => null,
		getSessionId: () => "profile-test",
		getImageAttachments: () => [],
		getArtifactsDir: () => null,
		getActiveModel: () => undefined,
		isToolActive: () => false,
	} as unknown as ToolSession;
	const read = new ReadTool(session);
	try {
		const summary = await read.execute("summary", { path: "cpu.cpuprofile" });
		const summaryText = summary.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("");
		expect(summaryText).toContain("hotFunction");
		expect(summaryText).toContain("line range");
		expect(summary.details?.displayContent).toBeUndefined();
		const ranged = await read.execute("lines", { path: "cpu.cpuprofile:1-4:raw" });
		expect(
			ranged.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join(""),
		).toBe(source.split("\n").slice(0, 4).join("\n"));
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
