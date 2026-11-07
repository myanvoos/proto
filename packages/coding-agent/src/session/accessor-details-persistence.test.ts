import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "./session-manager";

/**
 * Contract: a tool result whose `details` hold an object with a throwing
 * accessor still persists, and persistence keeps working for every later entry.
 * Before, the persistence walk reached the getter, latched a disk failure, and
 * every rewrite met the same entry, so the session stopped saving.
 */

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Shape of `@mendable/firecrawl-js` `SearchData`: plain own fields plus a
 * non-enumerable `data` getter that throws to steer callers to `.web`.
 * `JSON.stringify` never reads it; the persistence walk must not either.
 */
function sdkResultWithThrowingGetter(): object {
	const result = { web: [{ url: "https://example.com", title: "Example" }] };
	Object.defineProperty(result, "data", {
		get() {
			throw new Error("SearchData has no '.data'. Results are grouped by source: .web (1 results)");
		},
		enumerable: false,
	});
	return result;
}

describe("tool result details with throwing accessors", () => {
	it("persists the tool result and every later entry", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-accessor-details-"));
		tempDirs.push(dir);
		const session = SessionManager.create(dir, dir);
		session.appendMessage({ role: "user", content: "search", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "searching" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		session.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "firecrawl_search",
			content: [{ type: "text", text: "results" }],
			details: sdkResultWithThrowingGetter(),
			isError: false,
			timestamp: 3,
		});
		session.appendMessage({ role: "user", content: "after the search", timestamp: 4 });
		await session.ensureOnDisk();
		await session.flush();

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a session file");
		const lines = (await Bun.file(sessionFile).text())
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));
		const messages = lines.filter(line => line.type === "message").map(line => line.message);

		expect(messages.map((message: { role: string }) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"user",
		]);
		expect(messages[2].details).toEqual({ web: [{ url: "https://example.com", title: "Example" }] });
	});
});
