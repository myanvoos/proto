import { describe, expect, it } from "bun:test";
import type { BlobStore } from "./blob-store";
import { SessionManager } from "./session-manager";
import { prepareEntryForPersistence } from "./session-persistence";
import { MemorySessionStorage } from "./session-storage";

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
	it("persists the walk on the JSON projection when a probed field throws", () => {
		const details: Record<string, unknown> = { web: [{ url: "https://example.com" }] };
		Object.defineProperty(details, "type", {
			get() {
				throw new Error("accessor reached by the persistence walk");
			},
			enumerable: false,
		});
		const entry = {
			type: "message" as const,
			id: "entry-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: "toolResult" as const,
				toolCallId: "call-1",
				toolName: "firecrawl_search",
				content: [{ type: "text" as const, text: "results" }],
				details,
				isError: false,
				timestamp: 2,
			},
		};

		const persisted = prepareEntryForPersistence(entry, {} as BlobStore);

		// The JSON-visible fields survive; the throwing accessor is not consulted.
		if (persisted.type !== "message") throw new Error("Expected a message entry");
		expect(persisted.message).toMatchObject({ role: "toolResult", toolCallId: "call-1" });
		expect((persisted.message as { details?: unknown }).details).toEqual({
			web: [{ url: "https://example.com" }],
		});
	});

	it("persists the tool result and every later entry", async () => {
		const storage = new MemorySessionStorage();
		const session = SessionManager.create("/work", "/sessions", storage);
		session.appendMessage({ role: "user", content: "search", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "searching" }],
			api: "openai-completions",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		});
		session.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "firecrawl_search",
			content: [{ type: "text", text: "results" }],
			details: sdkResultWithThrowingGetter(),
			isError: false,
			timestamp: 2,
		});
		session.appendMessage({ role: "user", content: "after the search", timestamp: 3 });
		await session.flush();

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a session file");
		const lines = (await storage.readText(sessionFile))
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));
		const messages = lines.filter(line => line.type === "message").map(line => line.message);

		// A latched disk failure would drop the tool result and everything after it.
		expect(messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "user"]);
		expect(messages[2].details).toEqual({ web: [{ url: "https://example.com", title: "Example" }] });
	});
});
