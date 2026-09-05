import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import type { TUI } from "@oh-my-pi/pi-tui";
import { Settings } from "../../config/settings";
import { AgentRegistry } from "../../registry/agent-registry";
import { initThemeSync } from "../theme/theme";
import { AgentTranscriptViewer } from "./agent-transcript-viewer";

await Settings.init();
initThemeSync();

const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

function messageLine(text: string): string {
	return JSON.stringify({
		type: "message",
		id: `entry-${text}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: text, timestamp: Date.now() },
	});
}

function viewerFor(sessionFile: string): AgentTranscriptViewer {
	const registry = new AgentRegistry();
	registry.register({
		id: "probe-agent",
		displayName: "probe-agent",
		kind: "sub",
		parentId: "Main",
		status: "parked",
		session: null,
		sessionFile,
	});
	const ui = {
		imageBudget: undefined,
		requestRender: () => {},
		requestComponentRender: () => {},
		resetDisplay: () => {},
	} as unknown as TUI;
	return new AgentTranscriptViewer({
		agentId: "probe-agent",
		registry,
		ui,
		expandKeys: [],
		fleetKeys: [],
		requestRender: () => {},
		onClose: () => {},
		onFleetClose: () => {},
	});
}

test("transcript viewer appends a newly persisted message without rebuilding or losing existing rows", async () => {
	const directory = await fs.mkdtemp("/tmp/proto-transcript-viewer-");
	temporaryDirectories.push(directory);
	const sessionFile = `${directory}/session.jsonl`;
	await Bun.write(sessionFile, `${messageLine("first message")}\n`);

	vi.useFakeTimers();
	const viewer = viewerFor(sessionFile);
	try {
		const initial = viewer.render(80).join("\n");
		expect(initial, "the initial persisted transcript is visible").toContain("first message");

		await fs.appendFile(sessionFile, `${messageLine("second message")}\n`);
		vi.advanceTimersByTime(300);

		const updated = viewer.render(80).join("\n");
		expect(updated, "newly appended transcript data is visible after polling").toContain("second message");
		expect(updated, "incremental polling preserves earlier transcript history").toContain("first message");
	} finally {
		viewer.dispose();
		vi.useRealTimers();
	}
});
