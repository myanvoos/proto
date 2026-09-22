import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Input, SelectList, Spacer, Text, type TUI } from "@oh-my-pi/pi-tui";
import type { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import { getSelectListTheme, initThemeSync, theme } from "../theme/theme";
import { AdvisorConfigOverlayComponent } from "./advisor-config";
import { AskDialogComponent } from "./ask-dialog";
import { ExtensionList } from "./extensions/extension-list";
import type { Extension } from "./extensions/types";
import { HookSelectorComponent } from "./hook-selector";
import { OverlayPanel, renderDialogContent } from "./overlay-box";

initThemeSync();

function bounded(lines: readonly string[], width: number, height: number): string[] {
	const plain = lines.map(line => Bun.stripANSI(line));
	expect(lines.length).toBeLessThanOrEqual(height);
	for (const line of plain) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
	return plain;
}

test("tiny panels keep selected content with paired borders or no frame", () => {
	const panel = new OverlayPanel("Choices");
	const list = new SelectList(
		Array.from({ length: 20 }, (_, i) => ({ value: `${i}`, label: `Choice ${i}` })),
		10,
		getSelectListTheme(),
	);
	list.setSelectedIndex(18);
	panel.addChild(list);
	for (const height of [1, 2, 3, 4, 6, 20]) {
		panel.setMaxHeight(height);
		const lines = bounded(panel.render(20), 20, height);
		expect(lines.some(line => line.includes(theme.nav.cursor) && line.includes("Choice 18"))).toBe(true);
		if (height < 3)
			expect(
				lines.some(line => line.startsWith(theme.boxRound.vertical) || line.startsWith(theme.boxRound.topLeft)),
			).toBe(false);
		else {
			expect(lines[0].startsWith(theme.boxRound.topLeft)).toBe(true);
			expect(lines[lines.length - 1].startsWith(theme.boxRound.bottomLeft)).toBe(true);
		}
	}
});

test("nested panel and text input retain focus before descriptions and hints", () => {
	const input = new Input();
	input.setValue("edited value");
	const children = [
		new Text("Form title"),
		new Text("Long description ".repeat(8)),
		input,
		new Text("Enter save · Esc cancel"),
	];
	for (const height of [1, 2, 3, 6, 20]) {
		const result = renderDialogContent(children, input, 32, height);
		const lines = bounded(result.lines, 32, height);
		expect(lines.join("\n")).toContain("edited value");
	}
	const panel = new OverlayPanel("Plugin options");
	panel.addChild(new Spacer(1));
	const list = new SelectList(
		Array.from({ length: 20 }, (_, i) => ({ value: `${i}`, label: `Choice ${i}` })),
		12,
		getSelectListTheme(),
	);
	list.setSelectedIndex(18);
	panel.addChild(list);
	panel.addChild(new Text("Enter select · Esc back"));
	for (const height of [24, 1, 2, 3, 4, 6, 10, 24]) {
		panel.setMaxHeight(height);
		const lines = bounded(panel.render(32), 32, height);
		if (height >= 3) expect(lines[0]).toContain("Plugin options");
		expect(lines.some(line => line.startsWith(theme.boxRound.vertical))).toBe(height >= 3);
		expect(lines.some(line => line.includes("Choice 18") && line.includes(theme.nav.cursor))).toBe(true);
	}
});

test("confirmation options keep selection and activation consistent after shrinking", () => {
	let chosen = "";
	const selector = new HookSelectorComponent(
		"Delete session?\nSelected fixture",
		["Yes", "No"],
		value => {
			chosen = value;
		},
		() => {},
	);
	selector.handleInput("\x1b[B");
	for (const height of [24, 1, 2, 3, 4, 6, 10, 24]) {
		selector.setMaxHeight(height);
		const lines = bounded(selector.render(32), 32, height);
		if (height >= 3) expect(lines[0]).toContain("Delete session?");
		expect(lines.some(line => line.startsWith(theme.boxRound.vertical))).toBe(height >= 3);
		expect(lines.some(line => line.includes("No") && line.includes(theme.nav.cursor))).toBe(true);
	}
	selector.handleInput("\r");
	expect(chosen).toBe("No");
});

test("extension list keeps selected extension visible and mouse hit rows synchronized", () => {
	const extensions: Extension[] = Array.from({ length: 20 }, (_, i) => ({
		id: `ext-${i}`,
		kind: "skill",
		name: `Ext${i}`,
		displayName: `Ext${i}`,
		path: `/tmp/Ext${i}`,
		source: { provider: "test", providerName: "Test", level: "project" },
		state: "active",
		raw: {},
	}));
	const list = new ExtensionList(extensions);
	list.setFocused(true);
	for (let i = 0; i < 9; i++) list.handleInput("\x1b[B");
	const selected = list.getSelectedExtension();
	expect(selected).not.toBeNull();
	for (const height of [20, 1, 2, 4, 6, 20]) {
		list.setMaxHeight(height);
		const lines = bounded(list.render(32), 32, height);
		const index = lines.findIndex(line => line.includes(selected!.displayName));
		expect(index).toBeGreaterThanOrEqual(0);
		expect(list.hitTest(index)).not.toBeNull();
		expect(list.getSelectedExtension()?.id).toBe(selected!.id);
	}
});

test("advisor configuration uses injected terminal height and drops passive preview when narrow", () => {
	const terminal = { rows: 24 };
	const selector = new AdvisorConfigOverlayComponent(
		{ terminal } as TUI,
		{ modelRegistry: {} as ModelRegistry, settings: Settings.isolated(), scopedModels: [], availableToolNames: [] },
		"project",
		{ advisors: [{ name: "default" }] },
		{
			loadDoc: async () => ({ advisors: [] }),
			save: async () => {},
			close: () => {},
			requestRender: () => {},
			notify: () => {},
		},
	);
	for (const width of [20, 32, 40, 60, 100]) {
		for (const height of [1, 2, 3, 4, 6, 10, 24]) {
			terminal.rows = height;
			const lines = bounded(selector.render(width), width, height);
			expect(lines.some(line => line.startsWith(theme.boxRound.vertical))).toBe(height >= 3);
			expect(lines.some(line => line.includes("default") && line.includes(theme.nav.cursor))).toBe(true);
		}
	}
});

test("tiny ask dialog preserves the selected answer without partial framing", () => {
	const terminal = { rows: 24 };
	const ask = new AskDialogComponent(
		[{ id: "q", question: "Question text", options: [{ label: "ALPHA" }, { label: "BETA" }] }],
		{ onSubmit() {}, onCancel() {}, onPrompt: async () => undefined },
		{ tui: { terminal } as TUI },
	);
	try {
		for (const height of [1, 2, 3, 4]) {
			terminal.rows = height;
			ask.setMaxHeight(height);
			const lines = bounded(ask.render(20), 20, height);
			expect(lines.some(line => line.includes("ALPHA") && line.includes(theme.nav.cursor))).toBe(true);
			if (height < 3)
				expect(
					lines.some(line => line.startsWith(theme.boxRound.vertical) || line.startsWith(theme.boxRound.topLeft)),
				).toBe(false);
			else {
				expect(lines[0].startsWith(theme.boxRound.topLeft)).toBe(true);
				expect(lines[lines.length - 1].startsWith(theme.boxRound.bottomLeft)).toBe(true);
			}
		}
	} finally {
		ask.dispose();
	}
});

test("extension dashboard keeps its selected item and paired frame at tiny heights", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-extension-frame-"));
	try {
		await fs.mkdir(path.join(dir, "profile"));
		await fs.mkdir(path.join(dir, "home"));
		await fs.writeFile(
			path.join(dir, "profile", "mcp.json"),
			JSON.stringify({ mcpServers: { "fixture-server": { command: "false" } } }),
		);
		const script = `
			import { ExtensionDashboard } from ${JSON.stringify(new URL("./extensions/extension-dashboard.ts", import.meta.url).pathname)};
			import { Settings } from ${JSON.stringify(new URL("../../config/settings.ts", import.meta.url).pathname)};
			import { initThemeSync } from ${JSON.stringify(new URL("../theme/theme.ts", import.meta.url).pathname)};
			initThemeSync();
			const dashboard = await ExtensionDashboard.create(${JSON.stringify(dir)}, Settings.isolated(), 24);
			for (const key of "fixture-server") dashboard.handleInput(key);
			dashboard.handleInput("\x1b[B");
			const rendered = [];
			for (const width of [20, 100]) for (const height of [1, 2, 3, 4]) {
				Object.defineProperty(process.stdout, "rows", { configurable: true, value: height });
				rendered.push({ width, height, lines: dashboard.render(width).map(line => Bun.stripANSI(line)) });
			}
			console.log(JSON.stringify(rendered));
		`;
		const child = Bun.spawn([process.execPath, "--eval", script], {
			env: {
				PATH: process.env.PATH,
				HOME: path.join(dir, "home"),
				PI_CODING_AGENT_DIR: path.join(dir, "profile"),
				XDG_CONFIG_HOME: path.join(dir, "home"),
				XDG_CACHE_HOME: path.join(dir, "home"),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		const rendered = JSON.parse(stdout) as Array<{ width: number; height: number; lines: string[] }>;
		for (const { width, height, lines } of rendered) {
			bounded(lines, width, height);
			expect(lines.some(line => line.includes(width >= 100 ? "fixture-server" : "fixtur"))).toBe(true);
			if (height < 3)
				expect(
					lines.some(line => line.startsWith(theme.boxRound.vertical) || line.startsWith(theme.boxRound.topLeft)),
				).toBe(false);
			else {
				expect(lines[0].startsWith(theme.boxRound.topLeft)).toBe(true);
				expect(lines[lines.length - 1].startsWith(theme.boxRound.bottomLeft)).toBe(true);
			}
		}
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("a confirmation never activates a choice the frame could not show", () => {
	for (const width of [12, 20, 30, 40]) {
		for (let height = 1; height <= 12; height++) {
			let chosen: string | undefined;
			const selector = new HookSelectorComponent(
				"CONFIRM 漢字🙂 tool dialog title",
				["Yes", "No"],
				value => {
					chosen = value;
				},
				() => {},
			);
			selector.setMaxHeight(height);
			const lines = bounded(selector.render(width), width, height).join("\n");
			selector.handleInput("\r");
			if (chosen === undefined) continue;
			expect(chosen).toBe("Yes");
			// Identity may be ellipsis-truncated, but never absent.
			expect(lines).toContain("CONF");
			expect(lines).toContain("Yes");
			expect(lines.includes("No") || lines.includes("+1")).toBe(true);
		}
	}
});

test("a narrow confirmation keeps its question identity, both answers and cancellation", () => {
	let chosen: string | undefined;
	let cancelled = false;
	const selector = new HookSelectorComponent(
		"CONFIRM 漢字🙂 tool dialog title\nApprove 漢字🙂 this isolated action with a long question label?",
		["Yes", "No"],
		value => {
			chosen = value;
		},
		() => {
			cancelled = true;
		},
	);
	for (const height of [6, 4, 3, 24]) {
		selector.setMaxHeight(height);
		const lines = bounded(selector.render(20), 20, height).join("\n");
		expect(lines).toContain("CONF");
		expect(lines).toContain("Yes");
		expect(lines.includes("No") || lines.includes("+1")).toBe(true);
	}
	selector.setMaxHeight(6);
	selector.render(20);
	selector.handleInput("\x1b[B");
	const lines = bounded(selector.render(20), 20, 6).join("\n");
	expect(lines).toContain("No");
	selector.handleInput("\r");
	expect(chosen).toBe("No");
	expect(cancelled).toBe(false);
});
