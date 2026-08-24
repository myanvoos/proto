/**
 * TUI renderers for built-in tools.
 *
 * These provide rich visualization for tool calls and results in the TUI.
 */
import type { Component } from "@oh-my-pi/pi-tui";
import { editToolRenderer } from "../edit/renderer";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { goalToolRenderer } from "../goals/tools/goal-tool";
import { lspToolRenderer } from "../lsp/render";
import type { Theme } from "../modes/theme/theme";
import { webSearchToolRenderer } from "../web/search/render";
import { askToolRenderer } from "./ask";
import { bashToolRenderer } from "./bash";
import { browserToolRenderer } from "./browser/render";
import { computerToolRenderer } from "./computer-renderer";
import { evalToolRenderer } from "./eval-render";
import { fleetToolRenderer } from "./fleet";
import { githubToolRenderer } from "./gh-renderer";
import { inspectImageToolRenderer } from "./inspect-image-renderer";
import { createOrchestrateToolRenderer, type OrchestrateOp } from "./orchestrate";
import { readToolRenderer } from "./read";
import { resolveRenderer } from "./resolve";
import { thinkToolRenderer } from "./think";
import { todoToolRenderer } from "./todo";
import { writeToolRenderer } from "./write";
import { setXdevRendererLookup } from "./xdev";

/**
 * Per-renderer opt-in for a full viewport replay when the first result
 * replaces a painted pending-call render. A predicate receives the painted
 * call args and render options so the repaint stays scoped to the pending
 * shapes that actually re-anchor (an over-eager replay wipes native
 * scrollback on direct terminals).
 */
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
	/** Render without background box, inline in the response flow */
	inline?: boolean;
	/**
	 * Whether the renderer's pending-call path visibly consumes
	 * `options.spinnerFrame`. Used to avoid scheduling repaint ticks for live
	 * partial calls whose bytes cannot change between spinner frames.
	 */
	animatedPendingPreview?: boolean | ((args: unknown) => boolean);
	/**
	 * Whether the renderer's partial-result path visibly consumes
	 * `options.spinnerFrame`.
	 */
	animatedPartialResult?: boolean | ((args: unknown) => boolean);
	/**
	 * Whether replacing a pending call render with the first result requires a
	 * full viewport repaint. Use for merged renderers whose pending rows can be
	 * re-anchored instead of preserved by the result render.
	 */
	forceFirstResultViewportRepaint?: FirstResultViewportRepaint;
	/**
	 * Whether settling a provisional partial result into the final render requires
	 * a full viewport repaint. Use when the result renderer changes chrome or
	 * frame topology at `options.isPartial: true -> false`.
	 */
	forceResultViewportRepaintOnSettle?: boolean;
};

export const toolRenderers: Record<string, ToolRenderer> = {
	ask: askToolRenderer as ToolRenderer,
	bash: bashToolRenderer as ToolRenderer,
	browser: browserToolRenderer as ToolRenderer,
	computer: computerToolRenderer as ToolRenderer,
	eval: evalToolRenderer as ToolRenderer,
	edit: editToolRenderer as ToolRenderer,
	apply_patch: editToolRenderer as ToolRenderer,
	lsp: lspToolRenderer as ToolRenderer,
	inspect_image: inspectImageToolRenderer as ToolRenderer,
	// Lazy getter: `fleetToolRenderer` lives in a module whose deps (messaging →
	// persisted-agents → orchestrator/runtime → task/executor → sdk) close an
	// import cycle back here, so reading it at init order-dependently hits its
	// temporal dead zone. Deferring the read to first access sidesteps it.
	get fleet(): ToolRenderer {
		return fleetToolRenderer as ToolRenderer;
	},
	read: readToolRenderer as ToolRenderer,
	// Keyed by xd:// resolution-device names: the write dispatch delegates here
	// by dispatch tool, and historical `resolve` tool transcripts still render
	// through the `resolve` entry. Both devices carry the same ResolveDetails.
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

// Wire the xd:// render delegation. Injected (instead of the xdev module
// importing this module) to avoid the renderers → tool modules → sdk →
// tools/index → xdev import cycle.
setXdevRendererLookup(name => toolRenderers[name]);
