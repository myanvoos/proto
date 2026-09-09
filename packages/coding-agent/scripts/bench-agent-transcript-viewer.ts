import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TUI } from "@oh-my-pi/pi-tui";
import { Settings } from "../src/config/settings";
import { AgentTranscriptViewer } from "../src/modes/components/agent-transcript-viewer";
import { ChatTranscriptBuilder } from "../src/modes/components/chat-transcript-builder";
import { initThemeSync } from "../src/modes/theme/theme";
import { AgentRegistry } from "../src/registry/agent-registry";
import type { SessionMessageEntry } from "../src/session/session-entries";
import { parseSessionEntries } from "../src/session/session-loader";

const args = process.argv.slice(2);
const valueAfter = (flag: string): string | undefined => {
	const index = args.indexOf(flag);
	return index < 0 ? undefined : args[index + 1];
};
const mode = valueAfter("--mode");
const count = Number(valueAfter("--count") ?? "8000");
const suppliedFixture = valueAfter("--fixture");
const ui = {
	imageBudget: undefined,
	requestRender: () => {},
	requestComponentRender: () => {},
	resetDisplay: () => {},
} as unknown as TUI;

function entry(id: string, message: Record<string, unknown>): string {
	return JSON.stringify({ type: "message", id, parentId: null, timestamp: new Date().toISOString(), message });
}
function makeFixture(file: string): void {
	const fd = fs.openSync(file, "w");
	try {
		fs.writeSync(fd, `${entry("user", { role: "user", content: "benchmark", timestamp: Date.now() })}\n`);
		for (let index = 0; index < count; index++) {
			const call = `call-${index}`;
			fs.writeSync(
				fd,
				`${entry(`assistant-${index}`, { role: "assistant", content: [{ type: "toolCall", id: call, name: "bench_tool", arguments: { index, payload: "x".repeat(256) } }], stopReason: "toolUse", api: "openai-completions", provider: "bench", model: "bench", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, total: 0 } }, timestamp: Date.now() })}\n`,
			);
			fs.writeSync(
				fd,
				`${entry(`result-${index}`, { role: "toolResult", toolCallId: call, toolName: "bench_tool", content: [{ type: "text", text: `result-${index}-${"y".repeat(256)}` }], details: {}, isError: false, timestamp: Date.now() })}\n`,
			);
		}
	} finally {
		fs.closeSync(fd);
	}
}
function memory() {
	const usage = process.memoryUsage();
	return { rssMiB: usage.rss / 1024 / 1024, heapMiB: usage.heapUsed / 1024 / 1024 };
}
function registryFor(file: string): AgentRegistry {
	const registry = new AgentRegistry();
	registry.register({
		id: "bench",
		displayName: "bench",
		kind: "sub",
		parentId: "Main",
		status: "parked",
		session: null,
		sessionFile: file,
	});
	return registry;
}

await Settings.init();
initThemeSync();
if (mode && suppliedFixture) {
	Bun.gc(true);
	const before = memory();
	let renderedLines = 0;
	let dispose = () => {};
	if (mode === "windowed") {
		const viewer = new AgentTranscriptViewer({
			agentId: "bench",
			registry: registryFor(suppliedFixture),
			ui,
			expandKeys: [],
			fleetKeys: [],
			requestRender: () => {},
			onClose: () => {},
			onFleetClose: () => {},
		});
		renderedLines = viewer.render(100).length;
		dispose = () => viewer.dispose();
	} else {
		const builder = new ChatTranscriptBuilder({ ui, requestRender: () => {} });
		const messages = parseSessionEntries(fs.readFileSync(suppliedFixture, "utf-8")).filter(
			(item): item is SessionMessageEntry => item.type === "message",
		);
		builder.rebuild(messages);
		renderedLines = builder.container.render(100).length;
		dispose = () => builder.dispose();
	}
	const after = memory();
	console.log(
		JSON.stringify({
			mode,
			records: count * 2 + 1,
			renderedLines,
			rssMiB: after.rssMiB,
			rssDeltaMiB: after.rssMiB - before.rssMiB,
			heapMiB: after.heapMiB,
			heapDeltaMiB: after.heapMiB - before.heapMiB,
		}),
	);
	dispose();
} else {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "proto-viewer-bench-"));
	const fixture = suppliedFixture ?? path.join(directory, "session.jsonl");
	if (!suppliedFixture) makeFixture(fixture);
	try {
		for (const childMode of ["windowed", "eager"]) {
			const child = Bun.spawnSync(
				[process.execPath, import.meta.path, "--mode", childMode, "--fixture", fixture, "--count", String(count)],
				{ env: process.env, stdout: "pipe", stderr: "inherit" },
			);
			if (child.exitCode !== 0) process.exit(child.exitCode);
			console.log(child.stdout.toString().trim());
		}
	} finally {
		if (!suppliedFixture) fs.rmSync(directory, { recursive: true, force: true });
	}
}
