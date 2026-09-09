import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { type TUI, visibleWidth } from "@oh-my-pi/pi-tui";
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

function entryLine(id: string, message: Record<string, unknown>): string {
	return JSON.stringify({
		type: "message",
		id: `entry-${id}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		message,
	});
}
function messageLine(text: string): string {
	return entryLine(text, { role: "user", content: text, timestamp: Date.now() });
}
function assistantLine(index: number): string {
	return entryLine(`assistant-${index}`, {
		role: "assistant",
		content: [{ type: "toolCall", id: `call-${index}`, name: "unknown_tool", arguments: { index } }],
		stopReason: "toolUse",
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, total: 0 },
		},
		timestamp: Date.now(),
	});
}
function toolResultLine(index: number): string {
	return entryLine(`result-${index}`, {
		role: "toolResult",
		toolCallId: `call-${index}`,
		toolName: "unknown_tool",
		content: [{ type: "text", text: `tool-result-${String(index).padStart(4, "0")}` }],
		details: {},
		isError: false,
		timestamp: Date.now(),
	});
}

function viewerFor(sessionFile: string, agentId = "probe-agent", requestRender = () => {}): AgentTranscriptViewer {
	const registry = new AgentRegistry();
	registry.register({
		id: agentId,
		displayName: agentId,
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
		agentId,
		registry,
		ui,
		expandKeys: [],
		fleetKeys: [],
		requestRender,
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

test("transcript viewer chrome stays within the terminal width for long external agent identities", async () => {
	const directory = await fs.mkdtemp("/tmp/proto-transcript-viewer-width-");
	temporaryDirectories.push(directory);
	const sessionFile = `${directory}/session.jsonl`;
	await Bun.write(sessionFile, `${messageLine("visible message")}\n`);
	const viewer = viewerFor(sessionFile, "worker\twith-a-very-long-identity-\u{1f600}");
	try {
		for (const width of [2, 20, 40]) {
			const lines = viewer.render(width);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				expect(line).not.toContain("\t");
			}
			if (width === 40) expect(lines.join("\n")).toContain("visible message");
		}
	} finally {
		viewer.dispose();
	}
});

test("viewer pages a bounded tool-safe tail across a single-user autonomous history", async () => {
	const directory = await fs.mkdtemp("/tmp/proto-viewer-window-");
	temporaryDirectories.push(directory);
	const sessionFile = `${directory}/session.jsonl`;
	const records = [messageLine("only-user")];
	for (let i = 0; i < 700; i++) records.push(assistantLine(i), toolResultLine(i));
	await Bun.write(sessionFile, `${records.join("\n")}\n`);
	const viewer = viewerFor(sessionFile);
	try {
		expect(viewer.render(100).join("\n")).toContain("tool-result-0699");
		expect(viewer.render(100).join("\n")).toContain("← older");
		viewer.handleInput("g");
		expect(viewer.render(100).join("\n")).toContain("only-user");
		expect(viewer.render(100).join("\n")).toContain("newer →");
		viewer.handleInput("\x1b[F");
		viewer.handleInput("\x1b[6~");
		expect(viewer.render(100).join("\n")).toContain("tool-result-0255");
		viewer.handleInput("G");
		expect(viewer.render(100).join("\n")).toContain("tool-result-0699");
		viewer.handleInput("\x1b[H");
		viewer.handleInput("\x1b[5~");
		expect(viewer.render(100).join("\n")).toContain("tool-result-0443");
	} finally {
		viewer.dispose();
	}
});

test("viewer evicts the old rendered tail as completed groups stream in", async () => {
	const directory = await fs.mkdtemp("/tmp/proto-viewer-evict-");
	temporaryDirectories.push(directory);
	const sessionFile = `${directory}/session.jsonl`;
	const records = [messageLine("stream-user")];
	for (let i = 0; i < 256; i++) records.push(assistantLine(i), toolResultLine(i));
	await Bun.write(sessionFile, `${records.join("\n")}\n`);
	vi.useFakeTimers();
	const viewer = viewerFor(sessionFile);
	try {
		const added: string[] = [];
		for (let i = 256; i < 600; i++) added.push(assistantLine(i), toolResultLine(i));
		await fs.appendFile(sessionFile, `${added.join("\n")}\n`);
		vi.advanceTimersByTime(300);
		const tail = viewer.render(100).join("\n");
		expect(tail).toContain("tool-result-0599");
		expect(tail).toContain("← older");
		viewer.handleInput("g");
		expect(viewer.render(100).join("\n")).toContain("stream-user");
	} finally {
		viewer.dispose();
		vi.useRealTimers();
	}
});

test("viewer waits for complete UTF-8 JSONL and reloads same-size rewrites", async () => {
	const directory = await fs.mkdtemp("/tmp/proto-viewer-rewrite-");
	temporaryDirectories.push(directory);
	const sessionFile = `${directory}/session.jsonl`;
	await Bun.write(sessionFile, `${messageLine("before-rewrite")}\n`);
	vi.useFakeTimers();
	const viewer = viewerFor(sessionFile);
	try {
		const record = Buffer.from(messageLine("split-🚀-record"));
		const split = record.indexOf(Buffer.from("🚀")) + 2;
		await fs.appendFile(sessionFile, record.subarray(0, split));
		vi.advanceTimersByTime(300);
		expect(viewer.render(100).join("\n")).not.toContain("split-");
		await fs.appendFile(sessionFile, Buffer.concat([record.subarray(split), Buffer.from("\n{malformed}\n")]));
		vi.advanceTimersByTime(300);
		expect(viewer.render(100).join("\n")).toContain("split-🚀-record");
		const original = await fs.readFile(sessionFile, "utf-8");
		const rewritten = original.replaceAll("before-rewrite", "after--rewrite");
		expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(original));
		await Bun.write(sessionFile, rewritten);
		vi.advanceTimersByTime(300);
		viewer.handleInput("g");
		const output = viewer.render(100).join("\n");
		expect(output).toContain("after--rewrite");
		expect(output).not.toContain("before-rewrite");
		await Bun.write(sessionFile, `${messageLine("after-truncate")}\n`);
		vi.advanceTimersByTime(300);
		expect(viewer.render(100).join("\n")).toContain("after-truncate");
	} finally {
		viewer.dispose();
		vi.useRealTimers();
	}
});

test("viewer keeps one valid oversized UTF-8 record intact", async () => {
	const directory = await fs.mkdtemp("/tmp/proto-viewer-oversized-");
	temporaryDirectories.push(directory);
	const sessionFile = `${directory}/session.jsonl`;
	await Bun.write(sessionFile, `${messageLine(`huge-start-${"界".repeat(700_000)}-huge-end`)}\n`);
	const viewer = viewerFor(sessionFile);
	try {
		expect(viewer.render(100).join("\n")).toContain("huge-end");
	} finally {
		viewer.dispose();
	}
});

test("disposing the viewer stops transcript polling", async () => {
	const directory = await fs.mkdtemp("/tmp/proto-viewer-dispose-");
	temporaryDirectories.push(directory);
	const sessionFile = `${directory}/session.jsonl`;
	await Bun.write(sessionFile, `${messageLine("before-dispose")}\n`);
	vi.useFakeTimers();
	let renders = 0;
	const viewer = viewerFor(sessionFile, "dispose-agent", () => renders++);
	viewer.dispose();
	const atDispose = renders;
	await fs.appendFile(sessionFile, `${messageLine("after-dispose")}\n`);
	vi.advanceTimersByTime(1_000);
	expect(renders).toBe(atDispose);
	vi.useRealTimers();
});
