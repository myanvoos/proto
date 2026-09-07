import type { Component } from "@oh-my-pi/pi-tui";
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
import { monitorToolRenderer } from "./monitor";
import { createOrchestrateToolRenderer, type OrchestrateOp } from "./orchestrate";
import { readToolRenderer } from "./read";
import { REPORT_ISSUE_DEVICE_NAME, renderReportIssueDeviceCall } from "./report-tool-issue";
import { isResolutionDeviceName, renderResolutionDeviceCall, resolveRenderer } from "./resolve";
import { tokenizeShellSegments } from "./shell-tokenize";
import { thinkToolRenderer } from "./think";
import { todoToolRenderer } from "./todo";
import { parseXdBashCommand, renderXdevCall, renderXdevResult, setXdevRendererLookup, type XdevDispatch } from "./xdev";

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

function bashXdCallFromArgs(args: unknown): { name: string; content: string } | undefined {
	const command = (args as { command?: unknown } | undefined)?.command;
	if (typeof command !== "string") return undefined;
	const segments = tokenizeShellSegments(command);
	if (segments.length !== 1) return undefined;
	const parsed = parseXdBashCommand(segments[0]);
	return parsed?.kind === "device" ? { name: parsed.name, content: parsed.content } : undefined;
}

let bashXdRendererInstance: ToolRenderer | undefined;

function getBashXdRenderer(): ToolRenderer {
	bashXdRendererInstance ??= {
		...bashToolRenderer,
		renderCall(args: unknown, options: RenderResultOptions, uiTheme: Theme): Component {
			const xd = bashXdCallFromArgs(args);
			if (xd) {
				if (isResolutionDeviceName(xd.name)) return renderResolutionDeviceCall(xd.name, xd.content, uiTheme);
				if (xd.name === REPORT_ISSUE_DEVICE_NAME) return renderReportIssueDeviceCall(xd.content, uiTheme);
				const context = (options as { renderContext?: { resolveXdevMounted?: (name: string) => unknown } })
					.renderContext;
				const delegated = renderXdevCall(
					xd.name,
					xd.content,
					options,
					uiTheme,
					context?.resolveXdevMounted as Parameters<typeof renderXdevCall>[4],
				);
				if (delegated) return delegated;
			}
			const call = bashToolRenderer.renderCall as (a: unknown, o: RenderResultOptions, t: Theme) => Component;
			return call(args, options, uiTheme);
		},
		renderResult(
			result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
			options: RenderResultOptions & { renderContext?: Record<string, unknown> },
			uiTheme: Theme,
			args?: unknown,
		): Component {
			const xdev = (result.details as { xdev?: XdevDispatch } | undefined)?.xdev;
			if (xdev) {
				const context = (options as { renderContext?: { resolveXdevMounted?: (name: string) => unknown } })
					.renderContext;
				const delegated = renderXdevResult(
					xdev,
					result,
					options,
					uiTheme,
					context?.resolveXdevMounted as Parameters<typeof renderXdevResult>[4],
				);
				if (delegated) return delegated;
			}
			const render = bashToolRenderer.renderResult as (
				r: typeof result,
				o: RenderResultOptions,
				t: Theme,
				a?: unknown,
			) => Component;
			return render(result, options, uiTheme, args);
		},
	};
	return bashXdRendererInstance;
}

export const toolRenderers: Record<string, ToolRenderer> = {
	ask: askToolRenderer as ToolRenderer,
	get bash(): ToolRenderer {
		return getBashXdRenderer();
	},
	browser: browserToolRenderer as ToolRenderer,
	computer: computerToolRenderer as ToolRenderer,
	eval: evalToolRenderer as ToolRenderer,
	kernel: evalToolRenderer as ToolRenderer,
	inspect_media: inspectMediaToolRenderer as ToolRenderer,

	get fleet(): ToolRenderer {
		return fleetToolRenderer as ToolRenderer;
	},
	monitor: monitorToolRenderer as ToolRenderer,
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
};

setXdevRendererLookup(name => toolRenderers[name]);
