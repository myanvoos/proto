import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeSessionStore } from "./claude-session-store";

let tempRoot: string;

beforeEach(async () => {
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "proto-claude-import-"));
});

afterEach(async () => {
	await fs.rm(tempRoot, { recursive: true, force: true });
});

async function writeJsonl(filePath: string, records: Record<string, unknown>[]): Promise<void> {
	await Bun.write(filePath, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
}

describe("ClaudeSessionStore", () => {
	it("lists an unindexed session at the cwd its transcript recorded", async () => {
		const root = path.join(tempRoot, ".claude");
		const cwd = path.join(tempRoot, "my-project.dir");
		const id = "33333333-3333-4333-8333-333333333333";
		// No history entry, and a directory name whose "-" separators are ambiguous.
		await writeJsonl(path.join(root, "projects", cwd.replace(/[/\\._]/g, "-"), `${id}.jsonl`), [
			{ type: "file-history-snapshot", timestamp: "2026-01-01T00:00:00.000Z" },
			{
				type: "user",
				uuid: "u",
				parentUuid: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				cwd,
				message: { content: "." },
			},
		]);

		const info = (await new ClaudeSessionStore(root).list()).find(item => item.id === id);
		expect(info?.cwd).toBe(cwd);
	});

	it("bounds cwd discovery to the transcript prefix before using the encoded fallback", async () => {
		const root = path.join(tempRoot, ".claude");
		const cwd = path.join(tempRoot, "late-project.dir");
		const encoded = cwd.replace(/[/\\._]/g, "-");
		const id = "55555555-5555-4555-8555-555555555555";
		await writeJsonl(path.join(root, "projects", encoded, `${id}.jsonl`), [
			{ type: "file-history-snapshot", snapshot: "x".repeat(128 * 1024) },
			{ type: "user", cwd, message: { content: "." } },
		]);

		const info = (await new ClaudeSessionStore(root).list()).find(item => item.id === id);
		expect(info?.cwd).toBe(encoded.replaceAll("-", path.sep));
	});

	it("imports an API error as a failed turn", async () => {
		const root = path.join(tempRoot, ".claude");
		const cwd = path.join(tempRoot, "overloaded");
		const id = "22222222-2222-4222-8222-222222222222";
		await writeJsonl(path.join(root, "projects", cwd.replaceAll(path.sep, "-"), `${id}.jsonl`), [
			{
				type: "user",
				uuid: "u",
				parentUuid: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd,
				message: { content: "." },
			},
			{
				type: "assistant",
				uuid: "a",
				parentUuid: "u",
				timestamp: "2026-01-01T00:00:01.000Z",
				isApiErrorMessage: true,
				apiErrorStatus: 529,
				error: "server_error",
				// Claude Code stamps a completed stop_reason on the record even though nothing was answered.
				message: {
					id: "msg_err",
					model: "claude-sonnet-4-5",
					stop_reason: "stop_sequence",
					content: [{ type: "text", text: "API Error: 529 Overloaded." }],
				},
			},
		]);
		const store = new ClaudeSessionStore(root);
		const info = (await store.list())[0];
		if (!info) throw new Error("Overloaded fixture was not listed");
		const manager = await store.load(info);

		const assistant = manager.getEntries().find(e => e.type === "message" && e.message.role === "assistant");
		if (assistant?.type !== "message" || assistant.message.role !== "assistant") {
			throw new Error("Missing imported assistant");
		}
		expect(assistant.message.stopReason).toBe("error");
		expect(assistant.message.errorStatus).toBe(529);
	});

	it("keeps user text around tool results in source order", async () => {
		const root = path.join(tempRoot, ".claude");
		const cwd = path.join(tempRoot, "mixed");
		const id = "11111111-1111-4111-8111-111111111111";
		await writeJsonl(path.join(root, "projects", cwd.replaceAll(path.sep, "-"), `${id}.jsonl`), [
			{
				type: "user",
				uuid: "u",
				parentUuid: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd,
				message: { content: "Go" },
			},
			{
				type: "assistant",
				uuid: "a",
				parentUuid: "u",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: {
					id: "msg_claude",
					model: "claude-sonnet-4-5",
					stop_reason: "tool_use",
					content: [{ type: "tool_use", id: "tool-claude", name: "read", input: { path: "file.ts" } }],
				},
			},
			{
				type: "user",
				uuid: "r",
				parentUuid: "a",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: {
					content: [
						{ type: "text", text: "Preserve this before the result." },
						{ type: "tool_result", tool_use_id: "tool-claude", content: "file contents" },
						{ type: "text", text: "Preserve this after the result." },
					],
				},
			},
		]);
		const store = new ClaudeSessionStore(root);
		const info = (await store.list())[0];
		if (!info) throw new Error("Mixed fixture was not listed");
		const messages = (await store.load(info)).getEntries().filter(entry => entry.type === "message");

		expect(messages.map(entry => entry.message.role)).toEqual(["user", "assistant", "user", "toolResult", "user"]);
		const [, , before, result, after] = messages;
		expect(before?.message).toMatchObject({ content: [{ type: "text", text: "Preserve this before the result." }] });
		expect(result?.message).toMatchObject({ toolCallId: "tool-claude" });
		expect(after?.message).toMatchObject({ content: [{ type: "text", text: "Preserve this after the result." }] });
	});
});
