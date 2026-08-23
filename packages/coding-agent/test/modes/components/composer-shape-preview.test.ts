import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { COMPOSER_SHAPE_VALUES, type ComposerShape } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import {
	ComposerShapePreview,
	renderComposerShapePreview,
} from "@oh-my-pi/pi-coding-agent/modes/components/composer-shape-preview";
import {
	getComposerShapeOptions,
	installExtensionComposerShape,
} from "@oh-my-pi/pi-coding-agent/modes/components/composer-shape-registry";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/settings-selector";
import { initTheme, setTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { ComposerStyle } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	await initTheme();
});

describe("composer shape preview", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	const shapes: ComposerShape[] = [...COMPOSER_SHAPE_VALUES];

	it.each(shapes)("renders %s shape preview without throwing in dark theme", async (shape: ComposerShape) => {
		await setTheme("dark");
		const lines = renderComposerShapePreview(shape, 80);
		expect(lines.length).toBeGreaterThan(0);
		const joined = lines.join("\n");
		expect(joined).toContain("Ask anything");
	});

	it.each(shapes)("renders %s shape preview without throwing in light theme", async (shape: ComposerShape) => {
		await setTheme("light");
		const lines = renderComposerShapePreview(shape, 80);
		expect(lines.length).toBeGreaterThan(0);
		const joined = lines.join("\n");
		expect(joined).toContain("Ask anything");
	});

	it("updates preview when setValue is called on ComposerShapePreview component", async () => {
		await setTheme("dark");
		let renderRequested = false;
		const preview = new ComposerShapePreview("box", {
			requestRender: () => {
				renderRequested = true;
			},
		});
		const initialLines = preview.render(80);
		expect(initialLines.some(l => l.includes("Preview:"))).toBe(true);

		preview.setValue("claude");
		expect(renderRequested).toBe(true);
		const nextLines = preview.render(80);
		expect(nextLines.some(l => l.includes("Preview:"))).toBe(true);
	});

	it("borrows the footline row from the live status source below every shape", async () => {
		await setTheme("dark");
		// Echo mock: the stand-in title must be forwarded as a prop to the
		// title-bearing status call, not glued onto the rendered content.
		const status = {
			renderQuietLine: (_width: number, extras?: { previewTitle?: string }) =>
				`FOOTLINE ${extras?.previewTitle ?? ""}`,
		};

		for (const shape of shapes) {
			const rendered = renderComposerShapePreview(shape, 80, status).join("\n");
			expect(rendered, shape).toContain("Ask anything");
			expect(rendered, shape).toContain("FOOTLINE omp"); // footline below every shape
			expect(rendered.lastIndexOf("FOOTLINE"), shape).toBeGreaterThan(rendered.indexOf("Ask anything"));
		}
	});

	it("installs extension shapes into both selectors and live rendering", async () => {
		await setTheme("dark");
		const style: ComposerStyle = {
			id: "extension-dock",
			sideBorders: false,
			verticalChrome: 1,
			statusAttachment: "none",
			bottomBar: "full",
			bottomBarGap: false,
			defaultPromptGutter: "EXT ",
			defaultPaddingX: () => 0,
			sideChromeWidth: () => 0,
			renderTop: context => context.borderColor("=".repeat(context.width)),
			renderRow: context => [context.gutter + context.text + context.pad],
			renderBottom: () => undefined,
		};
		const dispose = installExtensionComposerShape({
			label: "Extension Dock",
			description: "Custom extension composer",
			style,
		});

		try {
			expect(getComposerShapeOptions().at(-1)).toEqual({
				value: "extension-dock",
				label: "Extension Dock",
				description: "Custom extension composer",
			});
			const rendered = renderComposerShapePreview("extension-dock", 76).join("\n");
			expect(rendered).toContain("=".repeat(76));
			expect(rendered).toContain("EXT ");
			expect(rendered).toContain("Ask anything");
		} finally {
			dispose();
		}

		expect(getComposerShapeOptions().some(option => option.value === "extension-dock")).toBe(false);
	});

	it("renders preview inside SettingsSelectorComponent submenu without crashing", async () => {
		await setTheme("dark");
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark", "light"],
				providers: [],
				cwd: process.cwd(),
			},
			{
				onChange: () => {},
				onCancel: () => {},
			},
		);

		for (const ch of "composer shape") selector.handleInput(ch);
		// Open the composer.shape submenu
		selector.handleInput("\n");

		const rendered = selector.render(80).join("\n");
		expect(rendered).toContain("Composer Shape");
		expect(rendered).toContain("Preview:");
		expect(rendered).toContain("Ask anything");

		// Cycle down to claude
		selector.handleInput("\x1b[B");
		const nextRendered = selector.render(80).join("\n");
		expect(nextRendered).toContain("Claude Code");
		expect(nextRendered).toContain("Preview:");
	});
});
