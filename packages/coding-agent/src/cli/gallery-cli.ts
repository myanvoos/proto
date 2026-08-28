import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { TUI } from "@oh-my-pi/pi-tui";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { ToolExecutionComponent } from "../modes/components/tool-execution";
import { initTheme, theme } from "../modes/theme/theme";
import { toolRenderers } from "../tools/renderers";
import { type GalleryFixture, type GalleryResult, galleryFixtures } from "./gallery-fixtures";
import { captureGalleryScreenshots } from "./gallery-screenshot";

export const GALLERY_STATES = ["streaming", "progress", "success", "error"] as const;
export type GalleryState = (typeof GALLERY_STATES)[number];

const GALLERY_STATE_LABELS: Record<GalleryState, string> = {
	streaming: "streaming args",
	progress: "in progress",
	success: "done",
	error: "failed",
};

const GALLERY_STATE_ALIASES: Record<string, GalleryState> = {
	streaming: "streaming",
	"streaming args": "streaming",
	progress: "progress",
	"in progress": "progress",
	success: "success",
	done: "success",
	error: "error",
	failed: "error",
};

export const GALLERY_STATE_TOKENS = Object.keys(GALLERY_STATE_ALIASES);

export function parseGalleryStates(states: readonly string[] | undefined): GalleryState[] | undefined {
	if (!states || states.length === 0) return undefined;
	const parsed: GalleryState[] = [];
	for (const raw of states) {
		const state = GALLERY_STATE_ALIASES[raw.trim().toLowerCase()];
		if (!state) {
			throw new Error(`Invalid --state '${raw}'. Valid values: ${GALLERY_STATE_TOKENS.join(", ")}`);
		}
		if (!parsed.includes(state)) parsed.push(state);
	}
	return parsed;
}

interface GalleryCommandArgs {
	width?: number;

	tool?: string;

	states?: GalleryState[];

	expanded?: boolean;

	plain?: boolean;

	screenshot?: boolean;

	out?: string;

	font?: string;

	fontSize?: number;
}

export interface GallerySection {
	heading: string;
	lines: string[];
}

const GENERIC_ERROR: GalleryResult = {
	content: [{ type: "text", text: "Error: operation failed" }],
	isError: true,
};

function fakeToolFor(name: string, fixture: GalleryFixture | undefined): AgentTool | undefined {
	if (!fixture?.label && !fixture?.editMode && !fixture?.customRendered) return undefined;
	const tool: Record<string, unknown> = { name, label: fixture.label ?? name, mode: fixture.editMode };
	if (fixture.customRendered) {
		const renderer = toolRenderers[fixture.renderer ?? name] as
			| { renderCall?: unknown; renderResult?: unknown; mergeCallAndResult?: unknown; inline?: unknown }
			| undefined;
		if (renderer) {
			tool.renderCall = renderer.renderCall;
			tool.renderResult = renderer.renderResult;
			tool.mergeCallAndResult = renderer.mergeCallAndResult;
			tool.inline = renderer.inline;
		}
	}
	return tool as unknown as AgentTool;
}

export function resolveFixture(name: string): GalleryFixture {
	return (
		galleryFixtures[name] ??
		({
			args: { note: `sample ${name} call` },
			result: { content: [{ type: "text", text: `${name} completed` }] },
		} satisfies GalleryFixture)
	);
}

export async function renderGalleryState(
	name: string,
	fixture: GalleryFixture,
	state: GalleryState,
	width: number,
	expanded = false,
): Promise<readonly string[]> {
	if (fixture.renderState) {
		return await fixture.renderState(state, width, expanded);
	}

	const componentName = fixture.customRendered ? name : (fixture.renderer ?? name);
	const tool = fakeToolFor(componentName, fixture);
	const streamingArgs = state === "streaming" ? (fixture.streamingArgs ?? fixture.args) : fixture.args;

	const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
	const component = new ToolExecutionComponent(
		componentName,
		streamingArgs,
		{ showImages: false, useBuiltInRenderer: !fixture.customRendered },
		tool,
		ui,
		getProjectDir(),
	);
	component.setExpanded(expanded);

	if (state !== "streaming") {
		component.setArgsComplete();
		component.setExecutionStarted();
	}
	if (state === "success") {
		component.updateResult(fixture.result, false);
	} else if (state === "error") {
		component.updateResult(fixture.errorResult ?? GENERIC_ERROR, false);
	}

	await component.whenPreviewSettled();

	const lines = component.render(width);
	component.stopAnimation();
	return lines;
}

function resolveWidth(requested: number | undefined): number {
	const fallback = process.stdout.columns ?? 100;
	const width = requested ?? fallback;
	return Math.max(40, Math.min(200, width));
}

function sectionRule(label: string, width: number): string {
	const prefix = `── ${label} `;
	const fill = Math.max(0, width - prefix.length);
	return theme.fg("accent", theme.bold(`${prefix}${"─".repeat(fill)}`));
}

async function renderGallerySections(
	names: string[],
	states: GalleryState[],
	width: number,
	expanded: boolean,
): Promise<GallerySection[]> {
	const sections: GallerySection[] = [];
	for (const name of names) {
		const fixture = resolveFixture(name);
		const heading = fixture.label && fixture.label !== name ? `${name} — ${fixture.label}` : name;
		const lines: string[] = ["", sectionRule(heading, width)];
		for (const state of states) {
			lines.push("", theme.fg("dim", `  · ${GALLERY_STATE_LABELS[state]}`));
			try {
				for (const line of await renderGalleryState(name, fixture, state, width, expanded)) lines.push(line);
			} catch (err) {
				lines.push(theme.fg("error", `  render failed: ${String(err)}`));
			}
		}
		sections.push({ heading, lines });
	}
	return sections;
}

export async function runGalleryCommand(args: GalleryCommandArgs): Promise<void> {
	const settingsInstance = await Settings.init();

	if (args.screenshot) process.env.COLORTERM = "truecolor";
	await initTheme(
		false,
		settingsInstance.get("colorBlindMode"),
		settingsInstance.get("theme.dark"),
		settingsInstance.get("theme.light"),
	);

	const width = resolveWidth(args.width);
	const expanded = args.expanded ?? false;
	const states = args.states && args.states.length > 0 ? args.states : [...GALLERY_STATES];

	const allNames = Array.from(new Set([...Object.keys(toolRenderers), ...Object.keys(galleryFixtures)])).sort();
	const names = args.tool ? allNames.filter(name => name === args.tool) : allNames;
	if (args.tool && names.length === 0) {
		process.stdout.write(`Unknown tool '${args.tool}'. Known tools: ${allNames.join(", ")}\n`);
		return;
	}

	const sections = await renderGallerySections(names, states, width, expanded);

	if (args.screenshot) {
		const paths = await captureGalleryScreenshots(sections, {
			width,
			font: args.font,
			fontSize: args.fontSize,
			out: args.out,
		});
		process.stdout.write(`${paths.join("\n")}\n`);
		return;
	}

	const lines = sections.flatMap(section => section.lines);
	lines.push("");
	const text = lines.map(line => (args.plain ? Bun.stripANSI(line) : line)).join("\n");
	process.stdout.write(`${text}\n`);
}
