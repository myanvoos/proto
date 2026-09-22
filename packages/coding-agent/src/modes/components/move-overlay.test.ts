import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CURSOR_MARKER } from "@oh-my-pi/pi-tui";
import { CommandController } from "../controllers/command-controller";
import { initThemeSync, theme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { HookSelectorComponent } from "./hook-selector";
import { MoveOverlay, type MoveOverlayResult } from "./move-overlay";

initThemeSync();
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "proto-move-test-"));
	roots.push(root);
	for (let n = 0; n < 18; n++) fs.mkdirSync(path.join(root, `${String(n).padStart(2, "0")}-target-directory`));
	fs.mkdirSync(path.join(root, "unicode-東京🙂"));
	return root;
}
function render(overlay: MoveOverlay, width: number, height: number): string[] {
	overlay.setMaxHeight(height);
	const lines = overlay.render(width);
	expect(lines.length).toBeLessThanOrEqual(height);
	expect(lines.join("\n")).toContain(CURSOR_MARKER);
	const plain = lines.map(line => Bun.stripANSI(line));
	for (const line of plain) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
	return plain;
}

test("move path and selected directory remain visible through short viewport navigation", () => {
	const root = fixture();
	let result: MoveOverlayResult | undefined;
	const overlay = new MoveOverlay(root, value => {
		result = value;
	});
	overlay.focused = true;
	const minimal = render(overlay, 20, 1).join("\n");
	expect(minimal).toContain("Path:");
	expect(minimal).not.toContain("Enter");
	for (const width of [20, 30, 40]) {
		for (const height of [6, 10, 15]) {
			const lines = render(overlay, width, height);
			expect(lines.some(line => line.includes("Path:"))).toBe(true);
			expect(lines.some(line => line.includes("Enter") && line.includes("Esc"))).toBe(true);
			expect(lines.some(line => line.includes("▶ 00-"))).toBe(true);
		}
	}
	for (let n = 0; n < 14; n++) overlay.handleInput("\x1b[B");
	for (const height of [15, 6, 10, 30]) {
		expect(render(overlay, 20, height).some(line => line.includes("▶ 14-"))).toBe(true);
	}
	overlay.handleInput("\r");
	expect(result).toEqual({ directory: path.join(root, "14-target-directory") });
});

test("move long path scrolls around the Unicode insertion point without changing its value", () => {
	const root = fixture();
	let result: MoveOverlayResult | undefined;
	const overlay = new MoveOverlay(root, value => {
		result = value;
	});
	overlay.focused = true;
	overlay.handleInput("unicode-");
	overlay.handleInput("\t");
	for (const width of [20, 30, 40]) {
		expect(render(overlay, width, 6).join("\n")).toContain("東京🙂");
	}
	expect(render(overlay, 30, 6).join("\n")).toContain("No subdirectories");
	overlay.handleInput("\x1b[D");
	overlay.handleInput("\x7f");
	expect(render(overlay, 20, 6).join("\n")).toContain("東🙂");
	overlay.handleInput("\r");
	expect(result).toEqual({ directory: path.join(root, "unicode-東🙂") });
});

test("move filtering reaches capped-out results and cancellation never confirms", () => {
	const root = fixture();
	const results: Array<MoveOverlayResult | undefined> = [];
	const overlay = new MoveOverlay(root, value => results.push(value));
	overlay.focused = true;
	overlay.pasteText("17-");
	expect(render(overlay, 20, 6).some(line => line.includes("▶ 17-"))).toBe(true);
	overlay.handleInput("\x03");
	expect(results).toEqual([undefined]);
	expect(fs.readdirSync(root)).toHaveLength(19);
});

test("move no-match path stays editable and confirms the exact sanitized path", () => {
	const root = fixture();
	let result: MoveOverlayResult | undefined;
	const overlay = new MoveOverlay(root, value => {
		result = value;
	});
	overlay.focused = true;
	overlay.pasteText("new-漢字🙂\n");
	const lines = render(overlay, 30, 6);
	expect(lines.join("\n")).toContain("No matching directories");
	overlay.handleInput("\r");
	expect(result).toEqual({ directory: "new-漢字🙂" });
	expect(fs.existsSync(path.join(root, "new-漢字🙂"))).toBe(false);
});

test("move creation confirmation keeps destination identity visible and only creates on acceptance", async () => {
	const root = fixture();
	const destination = path.join(root, "wave3-new");
	let accept = false;
	let moved: string | undefined;
	const controller = new CommandController({
		session: {
			isStreaming: false,
			moveSession: async (target: string) => {
				moved = target;
			},
		},
		sessionManager: { getCwd: () => root },
		showHookConfirm: async (title: string, description: string) => {
			expect(title).toContain("wave3-new");
			const selector = new HookSelectorComponent(
				`${title}\n${description}`,
				["Yes", "No"],
				() => {},
				() => {},
			);
			selector.setMaxHeight(3);
			const lines = selector
				.render(20)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(lines).toContain("wave3-new");
			expect(lines).toContain("Yes");
			expect(fs.existsSync(destination)).toBe(false);
			return accept;
		},
		settings: { flush: async () => {} },
		applyCwdChange: async () => {},
		updateEditorBorderColor: () => {},
		reloadChecklist: async () => {},
		ui: { requestRender: () => {} },
		present: () => {},
		showError: (message: string) => {
			throw new Error(message);
		},
	} as unknown as InteractiveModeContext);
	await controller.handleMoveCommand("wave3-new");
	expect(fs.existsSync(destination)).toBe(false);
	expect(moved).toBeUndefined();
	accept = true;
	await controller.handleMoveCommand("wave3-new");
	expect(fs.statSync(destination).isDirectory()).toBe(true);
	expect(moved).toBe(destination);
});

test("tiny move overlay keeps input and target before complete paired framing", () => {
	const overlay = new MoveOverlay(fixture(), () => {});
	overlay.focused = true;
	for (let i = 0; i < 14; i++) overlay.handleInput("\x1b[B");
	for (const height of [1, 2, 3, 4]) {
		const lines = render(overlay, 20, height);
		expect(lines.some(line => line.includes("Path:"))).toBe(true);
		if (height > 1) expect(lines.some(line => line.includes("▶ 14-"))).toBe(true);
		if (height < 4)
			expect(
				lines.some(line => line.startsWith(theme.boxRound.vertical) || line.startsWith(theme.boxRound.topLeft)),
			).toBe(false);
		else {
			expect(lines[0].startsWith(theme.boxRound.topLeft)).toBe(true);
			expect(lines[lines.length - 1].startsWith(theme.boxRound.bottomLeft)).toBe(true);
		}
	}
});
