import { beforeEach, expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { initThemeSync, theme } from "../theme/theme";
import type { CopyTarget } from "../utils/copy-targets";
import { CopySelectorComponent } from "./copy-selector";
import { UserMessageSelectorComponent } from "./user-message-selector";

beforeEach(() => initThemeSync());
const plain = (lines: readonly string[]) => lines.map(line => Bun.stripANSI(line));
const selected = (lines: readonly string[]) => plain(lines).find(line => line.includes(theme.nav.cursor));

const targets: CopyTarget[] = Array.from({ length: 15 }, (_, index) => ({
	id: `copy-${index}`,
	label: `Choice ${String(index).padStart(2, "0")}`,
	hint: "long metadata must not hide the copy target",
	content: `payload-${index}`,
	preview: "A preview spanning several lines\nline two\nline three",
}));

test("copy selection stays visible and copies the displayed target after short resizes", () => {
	const picked: string[] = [];
	const selector = new CopySelectorComponent(targets, { onPick: target => picked.push(target.id), onCancel() {} });
	for (let i = 0; i < 8; i++) selector.handleInput("\x1b[B");
	for (const [width, height] of [
		[60, 24],
		[32, 6],
		[20, 4],
		[20, 3],
		[20, 2],
		[20, 1],
		[40, 10],
		[60, 24],
	]) {
		selector.setMaxHeight(height);
		const lines = selector.render(width);
		expect(lines.length).toBeLessThanOrEqual(height);
		expect(plain(lines).some(line => line.startsWith(theme.boxRound.vertical))).toBe(height >= 3);
		expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
		expect(selected(lines)).toContain("Choice 08");
	}
	selector.handleInput("\r");
	expect(picked).toEqual(["copy-8"]);
});

test("deep copy tree gutters yield to the selected label in narrow panes", () => {
	let root: CopyTarget = { id: "leaf", label: "nested leaf", content: "payload", preview: "payload" };
	for (let depth = 0; depth < 7; depth++)
		root = { id: `group-${depth}`, label: "Group", preview: "", children: [root] };
	const selector = new CopySelectorComponent([root], { onPick() {}, onCancel() {} });
	selector.setMaxHeight(3);
	for (let i = 0; i < 7; i++) selector.handleInput("\x1b[B");
	expect(selected(selector.render(20))).toContain("nested leaf");
});

test("branch selector preserves the focused message instead of cropping its middle selection", () => {
	const picked: string[] = [];
	const messages = Array.from({ length: 15 }, (_, index) => ({
		id: `message-${index}`,
		text: `OPTION ${index + 1} 漢字🙂`,
	}));
	const selector = new UserMessageSelectorComponent(
		messages,
		id => picked.push(id),
		() => {},
	);
	const input = selector.getMessageList();
	for (let i = 0; i < 5; i++) input.handleInput("\x1b[A");
	for (const [width, height] of [
		[40, 24],
		[40, 10],
		[32, 6],
		[20, 4],
		[20, 3],
		[20, 2],
		[20, 1],
		[40, 24],
	]) {
		selector.setMaxHeight(height);
		const lines = selector.render(width);
		expect(lines.length).toBeLessThanOrEqual(height);
		expect(plain(lines).some(line => line.startsWith(theme.boxRound.vertical))).toBe(height >= 3);
		expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
		expect(selected(lines)).toContain("OPTION 10");
	}
	input.handleInput("\r");
	expect(picked).toEqual(["message-9"]);
});

test("short branch search keeps no-match feedback visible and cannot select stale messages", () => {
	const picked: string[] = [];
	const selector = new UserMessageSelectorComponent(
		Array.from({ length: 15 }, (_, index) => ({ id: `message-${index}`, text: `OPTION ${index + 1}` })),
		id => picked.push(id),
		() => {},
	);
	selector.setMaxHeight(3);
	const input = selector.getMessageList();
	input.handleInput("zzzz");
	expect(plain(selector.render(32)).join("\n")).toMatch(/no matching messages/i);
	input.handleInput("\r");
	expect(picked).toEqual([]);
	for (let i = 0; i < 4; i++) input.handleInput("\x7f");
	expect(selected(selector.render(32))).toContain("OPTION 15");
	input.handleInput("\r");
	expect(picked).toEqual(["message-14"]);
});
