import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { SessionManager } from "../../session/session-manager";
import { BUILTIN_SESSION_SLASH_COMMANDS } from "../../slash-commands/builtin-session";
import type { ParsedSlashCommand, TuiSlashCommandRuntime } from "../../slash-commands/types";
import type { InteractiveModeContext } from "../types";
import { SelectorController } from "./selector-controller";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

interface Harness {
	controller: SelectorController;
	sessionManager: SessionManager;
	statuses: string[];
	treeOpens: Array<{ filterMode?: string } | undefined>;
	answer: string | undefined;
}

const tempDirs: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.close();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function harness(): Harness {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "proto-annotate-"));
	tempDirs.push(cwd);
	const sessionManager = SessionManager.create(cwd, cwd);
	managers.push(sessionManager);
	const statuses: string[] = [];
	const treeOpens: Array<{ filterMode?: string } | undefined> = [];
	const state = { answer: undefined as string | undefined };

	const ctx = {
		sessionManager,
		showStatus: (message: string) => statuses.push(message),
		showError: (message: string) => statuses.push(`ERROR: ${message}`),
		showHookEditor: async () => state.answer,
		ui: { requestRender: () => {} },
	} as unknown as InteractiveModeContext;

	const controller = new SelectorController(ctx);
	// showBookmarks delegates to the real tree overlay; record the filter it asks for.
	const spied = controller as unknown as { showTreeSelector: (o?: { filterMode?: string }) => void };
	spied.showTreeSelector = options => treeOpens.push(options);

	return {
		controller,
		sessionManager,
		statuses,
		treeOpens,
		get answer() {
			return state.answer;
		},
		set answer(value: string | undefined) {
			state.answer = value;
		},
	};
}

test("bookmarks the last assistant response, and an empty note clears it", async () => {
	// Contract: /annotate labels the response the user just read, and clearing
	// the note deletes the bookmark. Without the clear path a bookmark could
	// never be removed.
	const h = harness();
	h.sessionManager.appendMessage({ role: "user", content: "question", timestamp: 0 });
	const firstId = h.sessionManager.appendMessage(assistant("older answer"));
	h.sessionManager.appendMessage({ role: "user", content: "again", timestamp: 0 });
	const lastId = h.sessionManager.appendMessage(assistant("newest answer"));

	await h.controller.annotateLastResponse("ship it");
	expect(h.sessionManager.getLabel(lastId)).toBe("ship it");
	expect(h.sessionManager.getLabel(firstId)).toBeUndefined();
	expect(h.statuses.at(-1)).toBe("Bookmarked: ship it");

	await h.controller.annotateLastResponse("");
	expect(h.sessionManager.getLabel(lastId)).toBeUndefined();
	expect(h.statuses.at(-1)).toBe("Bookmark cleared");
});

test("cancelling the note prompt leaves an existing bookmark untouched", async () => {
	// Contract: escaping the prompt must abort. The previous editor saved a
	// bookmark even when the user escaped, with no way to delete it afterwards.
	const h = harness();
	h.sessionManager.appendMessage({ role: "user", content: "question", timestamp: 0 });
	const id = h.sessionManager.appendMessage(assistant("answer"));

	await h.controller.annotateLastResponse("keep me");
	expect(h.sessionManager.getLabel(id)).toBe("keep me");

	h.answer = undefined; // showHookEditor resolves undefined on cancel
	await h.controller.annotateLastResponse();
	expect(h.sessionManager.getLabel(id)).toBe("keep me");

	h.answer = "renamed";
	await h.controller.annotateLastResponse();
	expect(h.sessionManager.getLabel(id)).toBe("renamed");
});

test("refuses to bookmark when the session has no assistant prose", async () => {
	const h = harness();
	h.sessionManager.appendMessage({ role: "user", content: "question", timestamp: 0 });

	await h.controller.annotateLastResponse("nothing to anchor to");
	expect(h.statuses.at(-1)).toBe("No agent response to bookmark yet");
});

test("browsing bookmarks opens the labelled-only tree, and says so when empty", () => {
	// Contract: /annotate view must not open an empty tree overlay, and when
	// bookmarks exist it must filter to them rather than showing everything.
	const h = harness();
	h.sessionManager.appendMessage({ role: "user", content: "question", timestamp: 0 });
	const id = h.sessionManager.appendMessage(assistant("answer"));

	h.controller.showBookmarks();
	expect(h.treeOpens).toHaveLength(0);
	expect(h.statuses.at(-1)).toContain("No bookmarks yet");

	h.sessionManager.appendLabelChange(id, "found it");
	h.controller.showBookmarks();
	expect(h.treeOpens).toEqual([{ filterMode: "labeled-only" }]);
});

test("/annotate routes view to the browser and everything else to a note", async () => {
	// Contract: `/annotate view` must browse, never create a bookmark literally
	// named "view"; a bare `/annotate` must prompt rather than label with "".
	const spec = BUILTIN_SESSION_SLASH_COMMANDS.find(c => c.name === "annotate");
	if (!spec?.handleTui) throw new Error("/annotate is not registered");

	const notes: Array<string | undefined> = [];
	let browsed = 0;
	const ctx = {
		editor: { setText: () => {} },
		annotateLastResponse: async (note?: string) => {
			notes.push(note);
		},
		showBookmarks: () => {
			browsed += 1;
		},
	} as unknown as TuiSlashCommandRuntime["ctx"];

	const run = (args: string) =>
		spec.handleTui?.(
			{ name: "annotate", args, text: `/annotate ${args}` } as ParsedSlashCommand,
			{
				ctx,
			} as TuiSlashCommandRuntime,
		);

	await run("view");
	await run("ship it");
	await run("");

	expect(browsed).toBe(1);
	expect(notes).toEqual(["ship it", undefined]);
});
