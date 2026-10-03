import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isSyntheticToolResultMessage } from "@oh-my-pi/pi-agent-core";
import { SessionManager } from "./session-manager";

let tempDir: string | undefined;

afterEach(async () => {
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

describe("SessionManager.forkFrom copyTitle", () => {
	test("default fork keeps the source title; side forks can start unnamed", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-side-fork-"));
		const cwd = tempDir;
		const source = SessionManager.create(cwd, path.join(tempDir, "sessions"));
		source.appendMessage({ role: "user", content: "parent work", timestamp: 1 });
		await source.setSessionName("Parent name", "user");
		await source.ensureOnDisk();
		const sourceFile = source.getSessionFile();
		expect(sourceFile).toBeDefined();
		if (!sourceFile) return;

		const keep = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir, "forks"));
		expect(keep.getSessionName()).toBe("Parent name");

		const side = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir, "forks"), undefined, {
			copyTitle: false,
		});
		expect(side.getSessionName()).toBeUndefined();

		// The unnamed fork must still accept a user rename from its live manager.
		const renamed = await side.setSessionName("Side title", "user");
		expect(renamed).toBe(true);
		expect(side.getSessionName()).toBe("Side title");
		await side.close();
		await keep.close();
	});
});

describe("SessionManager.forkFrom side-agent options", () => {
	const assistant = (id: string, parentId: string | null, toolCallId: string, total = 0) => ({
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "sleep 40" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude",
			stopReason: "toolUse",
			timestamp: 1,
			usage: {
				input: 100,
				output: 50,
				cacheRead: 10,
				cacheWrite: 5,
				totalTokens: 165,
				premiumRequests: 1,
				cost: { input: total / 2, output: total / 2, cacheRead: 0, cacheWrite: 0, total },
			},
		},
	});
	const toolResult = (id: string, parentId: string, toolCallId: string) => ({
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "bash",
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: 2,
		},
	});

	async function writeSource(entries: object[]): Promise<{ cwd: string; sourceFile: string }> {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-side-fork-"));
		const sourceFile = path.join(tempDir, "source.jsonl");
		const header = { type: "session", version: 3, id: "parent", timestamp: new Date().toISOString(), cwd: tempDir };
		await Bun.write(sourceFile, `${[header, ...entries].map(entry => JSON.stringify(entry)).join("\n")}\n`);
		return { cwd: tempDir, sourceFile };
	}

	function syntheticResultIds(manager: SessionManager): string[] {
		return manager
			.getBranch()
			.flatMap(entry =>
				entry.type === "message" && isSyntheticToolResultMessage(entry.message) ? [entry.message.toolCallId] : [],
			);
	}

	test("resetInheritedCost drops inherited spend but keeps token counts", async () => {
		const { cwd, sourceFile } = await writeSource([
			assistant("a1", null, "call-1", 2.5),
			toolResult("r1", "a1", "call-1"),
		]);
		const plain = await SessionManager.forkFrom(sourceFile, cwd, path.join(cwd, "plain"));
		expect(plain.getUsageStatistics().cost).toBe(2.5);

		const side = await SessionManager.forkFrom(sourceFile, cwd, path.join(cwd, "side"), undefined, {
			resetInheritedCost: true,
		});
		const stats = side.getUsageStatistics();
		expect(stats.cost).toBe(0);
		expect(stats.premiumRequests).toBe(0);
		expect(stats.totalTokens).toBe(165);
		await plain.close();
		await side.close();
	});

	test("repairInterruptedTail closes a live parent's in-flight tool call only when requested", async () => {
		const { cwd, sourceFile } = await writeSource([assistant("a1", null, "call-live")]);
		const plain = await SessionManager.forkFrom(sourceFile, cwd, path.join(cwd, "plain"));
		expect(syntheticResultIds(plain)).toEqual([]);

		const side = await SessionManager.forkFrom(sourceFile, cwd, path.join(cwd, "side"), undefined, {
			repairInterruptedTail: true,
		});
		expect(syntheticResultIds(side)).toEqual(["call-live"]);
		const reopened = await SessionManager.open(side.getSessionFile()!);
		expect(syntheticResultIds(reopened)).toEqual(["call-live"]);
		await plain.close();
		await side.close();
		await reopened.close();
	});

	test("repairInterruptedTail follows only the active branch", async () => {
		const { cwd, sourceFile } = await writeSource([
			assistant("active", null, "call-active"),
			toolResult("sibling-result", "active", "call-active"),
			assistant("sibling", null, "call-sibling"),
			{
				type: "message",
				id: "leaf",
				parentId: "active",
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "continue here", timestamp: 3 },
			},
		]);
		const side = await SessionManager.forkFrom(sourceFile, cwd, path.join(cwd, "side"), undefined, {
			repairInterruptedTail: true,
		});
		expect(syntheticResultIds(side)).toEqual(["call-active"]);
		await side.close();
	});

	test("repairInterruptedTail leaves a terminal tail untouched", async () => {
		const { cwd, sourceFile } = await writeSource([
			assistant("a1", null, "call-done"),
			toolResult("r1", "a1", "call-done"),
		]);
		const side = await SessionManager.forkFrom(sourceFile, cwd, path.join(cwd, "side"), undefined, {
			repairInterruptedTail: true,
		});
		expect(syntheticResultIds(side)).toEqual([]);
		expect(side.getBranch().filter(entry => entry.type === "message")).toHaveLength(2);
		await side.close();
	});
});

test("an assistant turn persisted without usage loads as zero usage", async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-usage-less-"));
	const sessionFile = path.join(tempDir, "legacy.jsonl");
	const header = { type: "session", version: 3, id: "legacy", timestamp: new Date().toISOString(), cwd: tempDir };
	const assistant = {
		type: "message",
		id: "a1",
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop", timestamp: 1 },
	};
	await Bun.write(sessionFile, `${JSON.stringify(header)}\n${JSON.stringify(assistant)}\n`);
	const before = await Bun.file(sessionFile).text();

	const manager = await SessionManager.open(sessionFile);
	const [entry] = manager.getBranch();
	expect(entry?.type === "message" && entry.message.role === "assistant" && entry.message.usage.totalTokens).toBe(0);
	expect(manager.getUsageStatistics().cost).toBe(0);
	await manager.close();
	expect(await Bun.file(sessionFile).text()).toBe(before);
});
