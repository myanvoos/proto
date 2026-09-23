import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setKeybindings, type TUI } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "../../config/keybindings";
import type { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import type { SessionInfo } from "../../session/session-listing";
import { initThemeSync, theme } from "../theme/theme";
import { AdvisorConfigOverlayComponent } from "./advisor-config";
import { SessionSelectorComponent } from "./session-selector";

initThemeSync();
const DELETE = "\x1b[3~";
const DOWN = "\x1b[B";
const ESC = "\x1b";
const plain = (lines: readonly string[]) => lines.map(line => Bun.stripANSI(line));
const dirs: string[] = [];
// Sibling suites install their own keybindings globally; pin ours so Enter and
// the submit chord mean what this dialog contract says they mean.
beforeEach(() => {
	setKeybindings(new KeybindingsManager({ "app.message.followUp": ["ctrl+q"] }));
});
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sessions(count = 12): SessionInfo[] {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-nested-frames-"));
	dirs.push(dir);
	return Array.from({ length: count }, (_, index) => {
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
	});
}

/** A blank body row (inside the rails, or bare when the frame is dropped). */
function blankBodyRows(lines: readonly string[]): string[] {
	const rail = theme.boxRound.vertical;
	return lines.filter(line =>
		line.startsWith(rail) ? line.slice(1, -1).trim() === "" : !/[╭╮╰╯]/.test(line) && line.trim() === "",
	);
}

function openInstructions(overlay: AdvisorConfigOverlayComponent): void {
	const screen = () => plain(overlay.render(60));
	const editorOpen = () => screen().some(line => line.includes("❯") && line.includes("ADVISOR_FIXTURE_TEXT"));
	// Escape back to the roster first: cancelling an editor returns to the advisor
	// detail with its cursor reset, so navigation must start from a known screen.
	for (let i = 0; i < 6 && !screen().some(line => line.includes("Add advisor")); i++) overlay.handleInput(ESC);
	overlay.handleInput("\r");
	for (let i = 0; i < 12 && !editorOpen(); i++) {
		if (screen().some(line => line.includes("Instructions") && line.includes(theme.nav.cursor))) {
			overlay.handleInput("\r");
			break;
		}
		overlay.handleInput(DOWN);
	}
	if (!editorOpen()) throw new Error("instructions editor not reachable");
}

function frameCounts(lines: readonly string[]) {
	return {
		tops: lines.filter(line => line.includes(theme.boxRound.topLeft)).length,
		bottoms: lines.filter(line => line.includes(theme.boxRound.bottomLeft)).length,
	};
}

test("session delete confirmation renders one frame, one footer and keeps naming its target", () => {
	let rows = 20;
	const deleted: string[] = [];
	const selector = new SessionSelectorComponent(
		sessions(),
		() => {},
		() => {},
		() => {},
		{
			getTerminalRows: () => rows,
			fillHeight: true,
			onDelete: async session => {
				deleted.push(session.title ?? "");
				return true;
			},
		},
	);
	try {
		for (let i = 0; i < 8; i++) selector.handleInput(DOWN);
		selector.handleInput(DELETE);
		for (const width of [20, 30, 40, 50, 60]) {
			for (rows of [1, 2, 3, 4, 6, 8, 10, 15, 20]) {
				const lines = plain(selector.render(width));
				const text = lines.join("\n");
				expect(lines.length).toBeLessThanOrEqual(rows);
				// No dead rows: the confirmation is exactly as tall as it needs to be.
				expect(blankBodyRows(lines)).toHaveLength(0);
				// Below three rows the paired border is dropped entirely; above it there
				// is exactly one frame, never the old nested pair.
				const expected = rows >= 3 ? 1 : 0;
				expect(frameCounts(lines)).toEqual({ tops: expected, bottoms: expected });
				expect(text.match(/Delete/g)).toHaveLength(1);
				// The single footer belongs to the host and only when a row is spare.
				expect(text.match(/Esc back · Ente/g) ?? []).toHaveLength(rows >= 4 ? 1 : 0);
				expect(text).not.toContain("↑/↓ select · Enter confirm · Esc back");
				expect(text).toContain("Yes");
				if (rows >= 4)
					expect(lines.some(line => line.includes("Yes") && line.includes(theme.nav.cursor))).toBe(true);
				if (rows >= 6) expect(text).toContain("Session 8");
				for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
			}
		}
		rows = 8;
		selector.handleInput(ESC);
		const afterCancel = plain(selector.render(40));
		expect(afterCancel.join("\n")).not.toContain("Delete");
		expect(frameCounts(afterCancel)).toEqual({ tops: 1, bottoms: 1 });
		expect(afterCancel.some(line => line.includes("Session 8") && line.includes(theme.nav.cursor))).toBe(true);
		expect(deleted).toEqual([]);
	} finally {
		selector.dispose();
	}
});

test("reframed dialogs still resolve: confirm deletes, cancel does not, editor submits and cancels", async () => {
	const rows = 8;
	const deleted: string[] = [];
	const list = sessions();
	const selector = new SessionSelectorComponent(
		list,
		() => {},
		() => {},
		() => {},
		{
			getTerminalRows: () => rows,
			fillHeight: true,
			onDelete: async session => {
				deleted.push(session.title ?? "");
				return true;
			},
		},
	);
	try {
		selector.handleInput(DELETE);
		selector.handleInput(DOWN); // move to "No"
		selector.handleInput("\r");
		expect(deleted).toEqual([]);
		expect(plain(selector.render(40)).join("\n")).not.toContain("Delete");

		selector.handleInput(DELETE);
		selector.handleInput("\r"); // confirm "Yes"
		await Bun.sleep(10);
		expect(deleted).toEqual(["Session 0"]);
	} finally {
		selector.dispose();
	}

	const terminal = { rows: 24 };
	const doc = { advisors: [{ name: "default", instructions: "ADVISOR_FIXTURE_TEXT" }] };
	const overlay = new AdvisorConfigOverlayComponent(
		{ terminal } as TUI,
		{ modelRegistry: {} as ModelRegistry, settings: Settings.isolated(), scopedModels: [], availableToolNames: [] },
		"project",
		doc,
		{
			loadDoc: async () => ({ advisors: [] }),
			save: async () => {},
			close: () => {},
			requestRender: () => {},
			notify: () => {},
		},
	);
	openInstructions(overlay);
	terminal.rows = 6;
	overlay.handleInput("!");
	expect(plain(overlay.render(60)).join("\n")).toContain("ADVISOR_FIXTURE_TEXT!");
	overlay.handleInput(ESC);
	expect(doc.advisors[0]!.instructions).toBe("ADVISOR_FIXTURE_TEXT");
	terminal.rows = 24;
	openInstructions(overlay);
	terminal.rows = 4;
	overlay.handleInput("?");
	overlay.handleInput("\x11"); // ctrl+q submit
	expect(doc.advisors[0]!.instructions).toBe("ADVISOR_FIXTURE_TEXT?");
	expect(plain(overlay.render(60)).join("\n")).not.toContain("ctrl+g external editor");
});

test("session rows stay clickable after chrome rows are returned to the body", () => {
	let rows = 12;
	const opened: string[] = [];
	const selector = new SessionSelectorComponent(
		sessions(),
		session => opened.push(session.title ?? ""),
		() => {},
		() => {},
		{ getTerminalRows: () => rows, fillHeight: true },
	);
	try {
		rows = 24;
		const lines = plain(selector.render(40));
		const target = lines.findIndex(line => /Session \d/.test(line) && !line.includes(theme.nav.cursor));
		expect(target).toBeGreaterThan(0);
		const label = /Session \d+/.exec(lines[target]!)![0];
		// SGR rows are 1-based; the host must still map a click to the row it painted.
		selector.handleInput(`\x1b[<0;5;${target + 1}M`);
		selector.handleInput(`\x1b[<0;5;${target + 1}m`);
		expect(opened).toEqual([label]);
	} finally {
		selector.dispose();
	}
});

test("advisor instructions editor renders inside the host frame without a blank footer row", () => {
	const terminal = { rows: 24 };
	const overlay = new AdvisorConfigOverlayComponent(
		{ terminal } as TUI,
		{ modelRegistry: {} as ModelRegistry, settings: Settings.isolated(), scopedModels: [], availableToolNames: [] },
		"project",
		{ advisors: [{ name: "default", instructions: "ADVISOR_FIXTURE_TEXT" }] },
		{
			loadDoc: async () => ({ advisors: [] }),
			save: async () => {},
			close: () => {},
			requestRender: () => {},
			notify: () => {},
		},
	);
	openInstructions(overlay);
	for (const width of [20, 30, 40, 50, 60, 100]) {
		for (const height of [1, 2, 3, 4, 6, 10, 15, 20, 24]) {
			terminal.rows = height;
			const lines = plain(overlay.render(width));
			expect(lines.length).toBeLessThanOrEqual(height);
			// Never a blank first body row, and at most one interior spacer.
			expect(blankBodyRows(lines.slice(0, 2))).toHaveLength(0);
			expect(blankBodyRows(lines).length).toBeLessThanOrEqual(1);
			expect(frameCounts(lines).tops).toBe(height >= 3 ? 1 : 0);
			expect(frameCounts(lines).bottoms).toBe(height >= 3 ? 1 : 0);
			// Narrow rows scroll the editor to the caret; the draft stays editable.
			if (width >= 40) expect(lines.join("\n")).toContain("ADVISOR_FIXTURE_TEXT");
			else expect(lines.join("\n")).toContain("❯");
			for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
		}
	}
});
