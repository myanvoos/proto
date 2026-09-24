import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "./session-manager";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test("metadata queries do not read spilled payloads and leave exact hydration available", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "proto-session-metadata-"));
	tempDirs.push(cwd);
	const manager = SessionManager.create(cwd, cwd);
	const original = Buffer.alloc(90_000, 120).toString("base64");
	let firstId = "";
	for (let index = 0; index < 70; index++) {
		const id = manager.appendCustomMessageEntry(
			"image",
			[{ type: "image", data: `${original}${index}`, mimeType: "image/png" }],
			true,
		);
		if (index === 0) firstId = id;
	}
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "present" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	});
	manager.appendCustomEntry("lifecycle", { nested: { value: "original" } });

	const rawDirectory = manager.captureState().rawEntryDirectory;
	if (!rawDirectory) throw new Error("Expected oversized messages to spill");
	const spillFiles = fs.readdirSync(rawDirectory).map(name => path.join(rawDirectory, name));
	if (spillFiles.length < 2) throw new Error("Expected many raw spill files");
	const spills = spillFiles.map(file => ({ file, bytes: fs.readFileSync(file) }));
	for (const spill of spills) fs.unlinkSync(spill.file);
	try {
		expect(manager.hasAssistantMessage()).toBe(true);
		const metadata = manager.getCustomEntryDataForMetadata("lifecycle");
		expect(metadata).toEqual([{ nested: { value: "original" } }]);
		const firstMetadata = metadata[0];
		if (!firstMetadata || typeof firstMetadata !== "object" || !("nested" in firstMetadata)) {
			throw new Error("Expected detached lifecycle metadata");
		}
		const nested = firstMetadata.nested;
		if (nested && typeof nested === "object" && "value" in nested) nested.value = "caller mutation";
		expect(manager.getCustomEntryDataForMetadata("lifecycle")).toEqual([{ nested: { value: "original" } }]);
	} finally {
		for (const spill of spills) fs.writeFileSync(spill.file, spill.bytes);
	}

	const entry = manager.getEntry(firstId);
	expect(entry?.type).toBe("custom_message");
	if (entry?.type === "custom_message" && Array.isArray(entry.content)) {
		const image = entry.content.find(block => block.type === "image");
		expect(image?.data).toBe(`${original}0`);
	}
	await manager.close();
});
