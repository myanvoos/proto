import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionInfo } from "../../session/session-listing";
import { initThemeSync, theme } from "../theme/theme";
import { rankSessionSearchMatches, SessionSelectorComponent } from "./session-selector";

const ANSI = /\x1b\[[0-9;]*m/g;
const SHIFT_UP = "\x1b[1;2A";
const SHIFT_DOWN = "\x1b[1;2B";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const DELETE = "\x1b[3~";
const ENTER = "\r";

const tempDirs: string[] = [];

beforeEach(() => {
	initThemeSync();
});

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});

function makeSession(index: number): SessionInfo {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-session-selector-"));
	tempDirs.push(dir);
	const file = path.join(dir, `sess_${index}.jsonl`);
	fs.writeFileSync(file, "{}\n");
	return {
		path: file,
		id: `session-${index}`,
		cwd: dir,
		title: `Session ${index}`,
		created: new Date(),
		modified: new Date(),
		messageCount: 1,
		size: 128,
		firstMessage: `first message ${index}`,
		allMessagesText: `first message ${index}`,
	};
}

function renderPlain(selector: SessionSelectorComponent): string {
	return selector.render(90).join("\n").replace(ANSI, "");
}

// The selector invokes onDelete fire-and-forget from the confirmation dialog and
// exposes no completion signal, so the async batch must be awaited by polling.
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt++) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

describe("session selector global scope preload", () => {
	test("loader starts at first render and the scope toggle reuses the same load", async () => {
		const { promise, resolve } = Promise.withResolvers<SessionInfo[]>();
		let calls = 0;
		const loader = () => {
			calls++;
			return promise;
		};
		const selector = new SessionSelectorComponent(
			[makeSession(1)],
			() => {},
			() => {},
			() => {},
			{
				loadAllSessions: loader,
			},
		);
		expect(calls).toBe(0);

		renderPlain(selector);
		expect(calls).toBe(1);

		selector.handleInput("\t");
		expect(calls).toBe(1);
		await waitFor(() => renderPlain(selector).includes("all projects"), "scope toggle");
		expect(calls).toBe(1);
		expect(renderPlain(selector)).toContain("Session 1");
		resolve([makeSession(2)]);
		await waitFor(() => renderPlain(selector).includes("Session 2"), "preloaded sessions");
	});

	test("a failed preload surfaces on toggle and the next toggle retries", async () => {
		let calls = 0;
		const selector = new SessionSelectorComponent(
			[makeSession(1)],
			() => {},
			() => {},
			() => {},
			{
				loadAllSessions: () => {
					calls++;
					return calls === 1 ? Promise.reject(new Error("index unavailable")) : Promise.resolve([makeSession(2)]);
				},
			},
		);

		selector.handleInput("\t");
		await waitFor(() => renderPlain(selector).includes("index unavailable"), "preload error");

		selector.handleInput("\t");
		await waitFor(() => renderPlain(selector).includes("Session 2"), "retried sessions");
		expect(calls).toBe(2);
	});
});

describe("session selector shift-range selection", () => {
	test("shift+down marks a range, delete opens a batch confirmation, Yes deletes every marked session", async () => {
		const sessions = [makeSession(1), makeSession(2), makeSession(3)];
		const deleted: string[] = [];
		let cancelled = 0;
		const selector = new SessionSelectorComponent(
			sessions,
			() => {},
			() => {
				cancelled++;
			},
			() => {},
			{
				onDelete: async (session: SessionInfo) => {
					deleted.push(session.path);
					await fs.promises.rm(session.path, { force: true });
					return true;
				},
			},
		);

		const output = renderPlain(selector);
		expect(output).toContain("Session 1");
		expect(output).toContain("Session 3");

		selector.handleInput(SHIFT_DOWN);
		selector.handleInput(SHIFT_DOWN);
		const marked = renderPlain(selector);
		// one checkbox per marked block (title line only); the cursor row keeps its cursor glyph
		expect(marked.match(/■ /g)?.length).toBe(2);
		expect(marked).toContain("■ Session 1");
		expect(marked).toContain("■ Session 2");
		expect(marked).toContain("› Session 3");
		expect(marked).toContain("3 selected");
		expect(marked).toContain("delete 3");

		// Esc drops the range without cancelling the selector; re-mark for the batch delete
		selector.handleInput(ESC);
		expect(renderPlain(selector).match(/■ /g)).toBeNull();
		expect(renderPlain(selector)).not.toContain("3 selected");
		expect(cancelled).toBe(0);
		selector.handleInput(SHIFT_UP);
		selector.handleInput(SHIFT_UP);
		expect(renderPlain(selector)).toContain("3 selected");

		// removeSession splices the session list in place, so snapshot expectations first.
		const expectedPaths = sessions.map(session => session.path);

		selector.handleInput(DELETE);
		const prompt = renderPlain(selector);
		expect(prompt).toContain("Delete 3 sessions?");
		expect(prompt).toContain("Session 1, Session 2, Session 3");

		selector.handleInput(ENTER);
		await waitFor(() => deleted.length === 3, "all three onDelete calls");
		expect([...deleted].sort()).toEqual([...expectedPaths].sort());
		await waitFor(() => !renderPlain(selector).includes("Session 1"), "the rows to disappear");
		expect(renderPlain(selector)).not.toContain("Session 2");
		expect(renderPlain(selector)).not.toContain("Session 3");
		selector.dispose();
	});

	test("a batch failure keeps successfully deleted rows removed and reports the error", async () => {
		const sessions = [makeSession(1), makeSession(2), makeSession(3)];
		let calls = 0;
		const selector = new SessionSelectorComponent(
			sessions,
			() => {},
			() => {},
			() => {},
			{
				onDelete: async (session: SessionInfo) => {
					calls++;
					if (session.id === "session-2") throw new Error("disk on fire");
					return true;
				},
			},
		);

		selector.handleInput(SHIFT_DOWN);
		selector.handleInput(SHIFT_DOWN);
		selector.handleInput(DELETE);
		selector.handleInput(ENTER);
		await waitFor(() => calls === 3, "every marked session to be attempted");
		const output = renderPlain(selector);
		expect(output).not.toContain("Session 1");
		expect(output).toContain("Session 2"); // its delete threw; the row stays
		expect(output).not.toContain("Session 3");
		expect(output).toContain("disk on fire");
		selector.dispose();
	});

	test("a row deleted in the all-projects scope stays gone after Tab back to the folder", async () => {
		const sessions = [makeSession(1), makeSession(2)];
		let deleted = 0;
		const selector = new SessionSelectorComponent(
			sessions,
			() => {},
			() => {},
			() => {},
			{
				loadAllSessions: async () => [...sessions],
				onDelete: async () => {
					deleted++;
					return true;
				},
			},
		);

		selector.handleInput("\t");
		await waitFor(() => !renderPlain(selector).includes("Loading"), "the all-projects scope");
		selector.handleInput(DELETE);
		selector.handleInput(ENTER);
		await waitFor(() => deleted === 1 && !renderPlain(selector).includes("Delete session?"), "the delete to settle");
		selector.handleInput("\t");

		const folder = renderPlain(selector);
		expect(folder).not.toContain("Session 1");
		expect(folder).toContain("Session 2");
		selector.dispose();
	});

	test("plain cursor movement collapses the range back to a single-row delete", () => {
		const sessions = [makeSession(1), makeSession(2), makeSession(3)];
		const selector = new SessionSelectorComponent(
			sessions,
			() => {},
			() => {},
			() => {},
			{},
		);

		selector.handleInput(SHIFT_DOWN);
		selector.handleInput(SHIFT_DOWN);
		expect(renderPlain(selector).match(/■ /g)?.length).toBe(2);

		selector.handleInput(SHIFT_UP);
		selector.handleInput(SHIFT_UP);
		// back at the anchor: a single-row range renders like the plain cursor
		expect(renderPlain(selector).match(/■ /g)).toBeNull();

		selector.handleInput(DOWN);
		expect(renderPlain(selector).match(/■ /g)).toBeNull();
		selector.handleInput(DELETE);
		expect(renderPlain(selector)).toContain("Delete session?");
		selector.dispose();
	});
});

test("session picker retains selected title at short heights and reports unmatched search", () => {
	const sessions = Array.from({ length: 12 }, (_, index) => makeSession(index));
	let height = 24;
	const selector = new SessionSelectorComponent(
		sessions,
		() => {},
		() => {},
		() => {},
		{ getTerminalRows: () => height, fillHeight: true },
	);
	for (let i = 0; i < 8; i++) selector.handleInput(DOWN);
	for (height of [24, 1, 2, 3, 4, 6, 10, 24]) {
		const lines = selector.render(32).map(line => Bun.stripANSI(line));
		expect(lines.length).toBeLessThanOrEqual(height);
		if (height >= 3) expect(lines[0]).toContain("Resume Session");
		expect(lines.some(line => line.startsWith(theme.boxRound.vertical))).toBe(height >= 3);
		expect(lines.some(line => line.includes("Session 8") && line.includes("›"))).toBe(true);
		for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(32);
	}
	selector.handleInput("\x1b[3~");
	for (height of [4, 6, 8, 10, 24]) {
		const lines = selector.render(32).map(line => Bun.stripANSI(line));
		const text = lines.join("\n");
		expect(lines.length).toBeLessThanOrEqual(height);
		// One frame per dialog: a single border/title from the host, the question
		// and its destructive target inside that body, and one footer.
		expect(lines[0]).toContain("Resume Session");
		expect(lines.filter(line => line.includes(theme.boxRound.topLeft))).toHaveLength(1);
		expect(lines.filter(line => line.includes(theme.boxRound.bottomLeft))).toHaveLength(1);
		expect(text).toContain("Delete sessi");
		expect(text.match(/Delete sessi/g)).toHaveLength(1);
		// Above the single shared row the destructive target stays named.
		if (height >= 6) expect(text).toContain("Session 8");
		expect(lines.some(line => line.includes("Yes") && line.includes("›"))).toBe(true);
		expect(text.match(/Esc back · Enter confirm/g)).toHaveLength(1);
		expect(text).not.toContain("↑/↓ select · Enter confirm · Esc back");
	}
	selector.handleInput("\x1b");
	selector.handleInput("zzzzzzzz");
	expect(renderPlain(selector)).toContain("No matching sessions");
});

describe("session selector cache lifetime", () => {
	test("a refreshed session is searchable by its new history rather than a stale full-text copy", () => {
		const session = makeSession(1);
		session.allMessagesText = "uniqueoldneedle";
		expect(rankSessionSearchMatches([session], "uniqueoldneedle").map(item => item.id)).toEqual([session.id]);
		session.allMessagesText = "uniquenewneedle";
		expect(rankSessionSearchMatches([session], "uniquenewneedle").map(item => item.id)).toEqual([session.id]);
		expect(rankSessionSearchMatches([session], "uniqueoldneedle")).toEqual([]);
	});

	test("closing during a global load does not resurrect rows or request rendering", async () => {
		const pending = Promise.withResolvers<SessionInfo[]>();
		const selector = new SessionSelectorComponent(
			[makeSession(1)],
			() => {},
			() => {},
			() => {},
			{
				loadAllSessions: () => pending.promise,
			},
		);
		let renders = 0;
		selector.setOnRequestRender(() => renders++);
		selector.handleInput("\t");
		selector.dispose();
		const rendersAtClose = renders;
		pending.resolve([makeSession(2)]);
		await pending.promise;
		await Promise.resolve();
		expect(renders).toBe(rendersAtClose);
		expect(selector.render(90)).toEqual([]);
		expect(selector.getSessionList().render(90).join("\n")).not.toContain("Session 2");
	});
});

test("typing a new search query focuses its top hit instead of the old row index", () => {
	const sessions = Array.from({ length: 12 }, (_, index) => makeSession(index));
	const selector = new SessionSelectorComponent(
		sessions,
		() => {},
		() => {},
		() => {},
	);
	for (let i = 0; i < 8; i++) selector.handleInput(DOWN);
	for (const ch of "Session 1") selector.handleInput(ch);
	const rows = renderPlain(selector)
		.split("\n")
		.filter(line => /Session \d+/.test(line) && !line.includes("> Session 1"));
	expect(rows.length).toBeGreaterThan(1);
	expect(rows[0]).toContain("›");
});

test("session search ranks exact then partial title matches ahead of newer content hits", () => {
	const at = (id: string, title: string | undefined, firstMessage: string, modified: number): SessionInfo => ({
		path: `/sessions/${id}.jsonl`,
		id,
		cwd: "/work",
		title,
		created: new Date(modified),
		modified: new Date(modified),
		messageCount: 1,
		size: 1,
		firstMessage,
		allMessagesText: firstMessage,
	});
	const sessions = [
		at("body", undefined, "dashboard", 5),
		at("partial-new", "Dashboard notes", "hi", 4),
		at("partial-old", "Old dashboard", "hi", 3),
		at("exact", "  DASHBOARD  ", "hi", 2),
	];
	expect(rankSessionSearchMatches(sessions, "dashboard").map(session => session.id)).toEqual([
		"exact",
		"partial-new",
		"partial-old",
		"body",
	]);

	const selector = new SessionSelectorComponent(
		sessions,
		() => {},
		() => {},
		() => {},
	);
	for (const ch of "dashboard") selector.handleInput(ch);
	const text = renderPlain(selector);
	expect(text.indexOf("DASHBOARD")).toBeLessThan(text.indexOf("Dashboard notes"));
	expect(text.indexOf("Old dashboard")).toBeGreaterThan(text.indexOf("Dashboard notes"));
});
