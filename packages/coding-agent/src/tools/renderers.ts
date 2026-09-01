import type { Component } from "@oh-my-pi/pi-tui";
import { editToolRenderer } from "../edit/renderer";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { goalToolRenderer } from "../goals/tools/goal-tool";
import type { Theme } from "../modes/theme/theme";
import { webSearchToolRenderer } from "../web/search/render";
import { askToolRenderer } from "./ask";
import { bashToolRenderer } from "./bash";
import { browserToolRenderer } from "./browser/render";
import { computerToolRenderer } from "./computer-renderer";
import { evalToolRenderer } from "./eval-render";
import { fleetToolRenderer } from "./fleet";
import { githubToolRenderer } from "./gh-renderer";
import { inspectMediaToolRenderer } from "./inspect-media-renderer";
import { createOrchestrateToolRenderer, type OrchestrateOp } from "./orchestrate";
import { readToolRenderer } from "./read";
import { resolveRenderer } from "./resolve";
import { thinkToolRenderer } from "./think";
import { todoToolRenderer } from "./todo";
import { writeToolRenderer } from "./write";
import { setXdevRendererLookup } from "./xdev";

export type FirstResultViewportRepaint = boolean | ((args: unknown, options: RenderResultOptions) => boolean);

export type ToolRenderer = {
	renderCall: (args: unknown, options: RenderResultOptions, theme: Theme) => Component;
	renderResult: (
		result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
		options: RenderResultOptions & { renderContext?: Record<string, unknown> },
		theme: Theme,
		args?: unknown,
	) => Component;
	mergeCallAndResult?: boolean;

	inline?: boolean;

	animatedPendingPreview?: boolean | ((args: unknown) => boolean);

	animatedPartialResult?: boolean | ((args: unknown) => boolean);

	forceFirstResultViewportRepaint?: FirstResultViewportRepaint;

	forceResultViewportRepaintOnSettle?: boolean;
};

export const toolRenderers: Record<string, ToolRenderer> = {
	ask: askToolRenderer as ToolRenderer,
	bash: bashToolRenderer as ToolRenderer,
	browser: browserToolRenderer as ToolRenderer,
	computer: computerToolRenderer as ToolRenderer,
	eval: evalToolRenderer as ToolRenderer,
	kernel: evalToolRenderer as ToolRenderer,
	edit: editToolRenderer as ToolRenderer,
	apply_patch: editToolRenderer as ToolRenderer,
	inspect_media: inspectMediaToolRenderer as ToolRenderer,

	get fleet(): ToolRenderer {
		return fleetToolRenderer as ToolRenderer;
	},
	read: readToolRenderer as ToolRenderer,

	resolve: resolveRenderer as ToolRenderer,
	reject: resolveRenderer as ToolRenderer,
	think: thinkToolRenderer as ToolRenderer,
	todo: todoToolRenderer as ToolRenderer,
	github: githubToolRenderer as ToolRenderer,
	goal: goalToolRenderer as ToolRenderer,
	web_search: webSearchToolRenderer as ToolRenderer,
	...(Object.fromEntries(
		(
			["orchestrate_spawn", "orchestrate_send", "orchestrate_wait", "orchestrate_kill", "orchestrate_list"] as const
		).map(name => [name, createOrchestrateToolRenderer(name.split("_")[1] as OrchestrateOp) as ToolRenderer]),
	) as Record<string, ToolRenderer>),
	write: writeToolRenderer as ToolRenderer,
};

setXdevRendererLookup(name => toolRenderers[name]);
