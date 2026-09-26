import type { Component } from "@oh-my-pi/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { goalToolRenderer } from "../goals/tools/goal-tool";
import type { Theme } from "../modes/theme/theme";
import { webSearchToolRenderer } from "../web/search/render";
import { askToolRenderer } from "./ask";
import { bashToolRenderer } from "./bash";
import { browserToolRenderer } from "./browser/render";
import { checklistToolRenderer } from "./checklist";
import { computerToolRenderer } from "./computer-renderer";
import { fleetToolRenderer } from "./fleet";
import { inspectMediaToolRenderer } from "./inspect-media-renderer";
import { jobsToolRenderer } from "./jobs";
import { type LaunchRenderArgs, type LaunchToolDetails, launchRenderCall, launchRenderResult } from "./jobs/launch";
import type { JobSnapshot, JobsDetails } from "./jobs/types";
import { readToolRenderer } from "./read";
import { REPORT_ISSUE_DEVICE_NAME, renderReportIssueDeviceCall } from "./report-tool-issue";
import { isResolutionDeviceName, renderResolutionDeviceCall, resolveRenderer } from "./resolve";
import { thinkToolRenderer } from "./think";
import {
	renderXdevCall,
	renderXdevResult,
	setXdevRendererLookup,
	type XdevDispatch,
	xdDeviceCallFromBashArgs,
} from "./xdev";

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
};

let bashXdRendererInstance: ToolRenderer | undefined;

function getBashXdRenderer(): ToolRenderer {
	bashXdRendererInstance ??= {
		...bashToolRenderer,
		renderCall(args: unknown, options: RenderResultOptions, uiTheme: Theme): Component {
			const xd = xdDeviceCallFromBashArgs(args);
			if (xd) {
				if (isResolutionDeviceName(xd.name)) return renderResolutionDeviceCall(xd.name, xd.content ?? "", uiTheme);
				if (xd.name === REPORT_ISSUE_DEVICE_NAME) return renderReportIssueDeviceCall(xd.content ?? "", uiTheme);
				const context = (options as { renderContext?: { resolveXdevMounted?: (name: string) => unknown } })
					.renderContext;
				const delegated = renderXdevCall(
					xd.name,
					xd.content,
					options,
					uiTheme,
					context?.resolveXdevMounted as Parameters<typeof renderXdevCall>[4],
					xd.argv,
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
			const xdev = (result.details as { xdev?: XdevDispatch | readonly XdevDispatch[] } | undefined)?.xdev;
			if (xdev) {
				const context = (options as { renderContext?: { resolveXdevMounted?: (name: string) => unknown } })
					.renderContext;
				const delegated = renderXdevResult(
					xdev,
					result,
					options,
					uiTheme,
					context?.resolveXdevMounted as Parameters<typeof renderXdevResult>[4],
					xdDeviceCallFromBashArgs(args),
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

/** Process ops that `fleet` owned before the split; their details already match the jobs renderers. */
const LEGACY_PROCESS_OPS: Record<string, true> = {
	start: true,
	ps: true,
	logs: true,
	stop: true,
	restart: true,
	describe: true,
};

interface LegacyFleetDetails {
	op?: string;
	daemon?: unknown;
	daemons?: unknown;
	waited?: unknown;
	jobs?: Array<Omit<JobSnapshot, "ref" | "settled"> & { id: string }>;
}

/**
 * Transcripts written before fleet became agents-only stored process and job results under the
 * `fleet` name. Their payloads are exactly what the jobs renderers consume, so replay keeps the
 * original cards instead of degrading a resumed session to a single status line.
 */
function legacyJobsCard(args: unknown, details: LegacyFleetDetails | undefined): "process" | "jobs" | undefined {
	const argRecord = (args ?? {}) as Record<string, unknown>;
	const op = details?.op ?? (typeof argRecord.op === "string" ? argRecord.op : undefined);
	if (op === undefined) return undefined;
	if (details?.daemon !== undefined || details?.daemons !== undefined) return "process";
	if (Object.hasOwn(LEGACY_PROCESS_OPS, op)) return "process";
	// A retired process `send` addressed a process name; a peer send addressed an agent.
	if (op === "send" && typeof argRecord.name === "string") return "process";
	if (details?.waited === undefined && Array.isArray(details?.jobs)) return "jobs";
	return undefined;
}

/** Legacy job snapshots identified jobs by bare id; the jobs card renders discriminated references. */
function legacyJobsDetails(details: LegacyFleetDetails): JobsDetails {
	return {
		op: "list",
		jobs: (details.jobs ?? []).map(job => ({
			...job,
			settled: job.status !== "running",
			ref: { kind: job.type === "monitor" ? ("watch" as const) : ("job" as const), id: job.id },
		})),
	};
}

let fleetRendererInstance: ToolRenderer | undefined;

function getFleetRenderer(): ToolRenderer {
	fleetRendererInstance ??= {
		...(fleetToolRenderer as ToolRenderer),
		renderCall(args: unknown, options: RenderResultOptions, uiTheme: Theme): Component {
			if (legacyJobsCard(args, undefined) === "process") {
				return launchRenderCall(args as LaunchRenderArgs, options, uiTheme);
			}
			return (fleetToolRenderer as ToolRenderer).renderCall(args, options, uiTheme);
		},
		renderResult(result, options, uiTheme, args): Component {
			const details = result.details as LegacyFleetDetails | undefined;
			const legacy = legacyJobsCard(args, details);
			if (legacy === "process") {
				return launchRenderResult(
					{ ...result, details: details as LaunchToolDetails },
					options,
					uiTheme,
					args as LaunchRenderArgs,
				);
			}
			if (legacy === "jobs" && details) {
				return jobsToolRenderer.renderResult({ ...result, details: legacyJobsDetails(details) }, options, uiTheme, {
					op: "list",
				});
			}
			return (fleetToolRenderer as ToolRenderer).renderResult(result, options, uiTheme, args);
		},
	};
	return fleetRendererInstance;
}
export const toolRenderers: Record<string, ToolRenderer> = {
	ask: askToolRenderer as ToolRenderer,
	get bash(): ToolRenderer {
		return getBashXdRenderer();
	},
	browser: browserToolRenderer as ToolRenderer,
	computer: computerToolRenderer as ToolRenderer,
	inspect_media: inspectMediaToolRenderer as ToolRenderer,

	get fleet(): ToolRenderer {
		return getFleetRenderer();
	},
	jobs: jobsToolRenderer as ToolRenderer,
	read: readToolRenderer as ToolRenderer,

	resolve: resolveRenderer as ToolRenderer,
	reject: resolveRenderer as ToolRenderer,
	think: thinkToolRenderer as ToolRenderer,
	checklist: checklistToolRenderer as ToolRenderer,
	goal: goalToolRenderer as ToolRenderer,
	web_search: webSearchToolRenderer as ToolRenderer,
};

setXdevRendererLookup(name => toolRenderers[name]);
