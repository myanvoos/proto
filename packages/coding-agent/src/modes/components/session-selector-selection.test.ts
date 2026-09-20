import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionInfo } from "../../session/session-listing";
import { initThemeSync } from "../theme/theme";
import { SessionSelectorComponent } from "./session-selector";

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
