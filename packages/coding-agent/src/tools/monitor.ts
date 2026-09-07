import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import type { MonitorSnapshot } from "../monitor";
import monitorDescription from "../prompts/tools/monitor.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { Ellipsis, renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import {
	formatBadge,
	formatEmptyMessage,
	formatErrorDetail,
	formatStatusIcon,
	PREVIEW_LIMITS,
	pluralize,
	replaceTabs,
	shortenPath,
	type ToolUIStatus,
	TRUNCATE_LENGTHS,
} from "./render-utils";

export type MonitorOperation = "start" | "list" | "stop";

export interface MonitorToolDetails {
	op: MonitorOperation;
	monitors: MonitorSnapshot[];

	notFound?: string[];
}

const monitorSchema = type({
	op: type("'start' | 'list' | 'stop'").describe("monitor operation"),
	"command?": type("string > 0").describe("start: shell command to watch"),
	"label?": type("string <= 48").describe("start: short display label"),
	"cwd?": type("string").describe("start: working directory; defaults to the session directory"),
	"match?": type("string > 0").describe("start: JS RegExp source; only matching output is reported"),
	"every?": type("number >= 1").describe("start: poll interval in seconds; omit to stream one long-running process"),
	"maxEvents?": type("number >= 1").describe("start: events delivered before the monitor stops itself"),
	"timeout?": type("number >= 1").describe("start: stop the monitor after this many seconds"),
	"ids?": type("string[]").describe("stop: monitor ids; omit to stop every running monitor"),
});

type MonitorParams = typeof monitorSchema.infer;

function monitorErrorResult(text: string, op: MonitorOperation): AgentToolResult<MonitorToolDetails> {
	return { content: [{ type: "text", text }], details: { op, monitors: [] }, isError: true };
}

function describeSnapshotLine(snapshot: MonitorSnapshot): string {
	const parts = [
		`${snapshot.id} [${snapshot.status}]`,
		snapshot.mode,
		snapshot.label,
		`${snapshot.eventCount}/${snapshot.maxEvents} events`,
	];
	if (snapshot.match !== undefined) parts.push(`match /${snapshot.match}/u`);
	if (snapshot.everySeconds !== undefined) parts.push(`every ${snapshot.everySeconds}s`);
	if (snapshot.timeoutSeconds !== undefined) parts.push(`timeout ${snapshot.timeoutSeconds}s`);
	if (snapshot.stopReason) parts.push(`stopped: ${snapshot.stopReason}`);
	if (snapshot.exitCode !== undefined) parts.push(`exit ${snapshot.exitCode}`);
	return `- ${parts.join(" · ")} — \`${snapshot.command}\``;
}

function describeStart(snapshot: MonitorSnapshot): string {
	const lines = [
		`Monitor \`${snapshot.id}\` started in ${snapshot.mode} mode (label "${snapshot.label}").`,
		`Command: \`${snapshot.command}\` (cwd ${snapshot.cwd})`,
	];
	const reported =
		snapshot.mode === "stream"
			? snapshot.match !== undefined
				? `Reporting: each output line matching /${snapshot.match}/u, plus process exit.`
				: "Reporting: every output line, plus process exit."
			: snapshot.match !== undefined
				? `Reporting: each changed output matching /${snapshot.match}/u, re-running every ${snapshot.everySeconds}s.`
				: `Reporting: each changed output, re-running every ${snapshot.everySeconds}s.`;
	lines.push(reported);
	const stops = [`after ${snapshot.maxEvents} events`];
	if (snapshot.timeoutSeconds !== undefined) stops.push(`after ${snapshot.timeoutSeconds}s`);
	if (snapshot.mode === "stream") stops.push("on process exit");
	stops.push('on error, or on `op: "stop"`');
	lines.push(`Stops ${stops.join(", ")}.`);
	lines.push(
		"Each event arrives as a message that wakes you. Do other work now, or end your turn and wait — do NOT poll.",
	);
	return lines.join("\n");
}

function describeList(op: MonitorOperation, monitors: MonitorSnapshot[], notFound: string[]): string {
	const lines: string[] = [];
	if (monitors.length === 0) {
		lines.push(op === "stop" ? "No monitors were stopped." : "No monitors in this session.");
	} else {
		const running = monitors.filter(monitor => monitor.status === "running").length;
		lines.push(
			op === "stop"
				? `Stopped ${monitors.length} ${pluralize("monitor", monitors.length)}:`
				: `${monitors.length} ${pluralize("monitor", monitors.length)} (${running} running):`,
		);
		for (const snapshot of monitors) lines.push(describeSnapshotLine(snapshot));
	}
	if (notFound.length > 0) lines.push(`Unknown monitor ${pluralize("id", notFound.length)}: ${notFound.join(", ")}`);
	return lines.join("\n");
}

export class MonitorTool implements AgentTool<typeof monitorSchema, MonitorToolDetails> {
	readonly name = "monitor";
	readonly label = "Monitor";
	readonly summary = "Watch a background command and wake on matching output instead of polling";
	readonly description: string;
	readonly parameters = monitorSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

	readonly examples: readonly ToolExample<typeof monitorSchema.infer>[] = [
		{
			caption: "Stream a dev server and wake only on errors",
			call: {
				op: "start",
				command: "bun run dev",
				label: "dev server",
				match: "error|ERR_|[Ff]ailed",
			},
		},
		{
			caption: "Poll a deployment until it goes live",
			call: {
				op: "start",
				command: "curl -sS -o /dev/null -w '%{http_code}' https://example.com/health",
				label: "health",
				every: 15,
				match: "200",
				timeout: 900,
			},
		},
		{
			caption: "Stop every running monitor",
			call: { op: "stop" },
		},
	];

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(monitorDescription);
	}

	async execute(
		_toolCallId: string,
		params: MonitorParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<MonitorToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<MonitorToolDetails>> {
		const manager = this.session.getMonitorManager?.();
		if (!manager) {
			return monitorErrorResult(
				"Monitors are unavailable in this session — run the command with `bash` or supervise it with `fleet` instead.",
				params.op,
			);
		}

		switch (params.op) {
			case "start": {
				const command = params.command?.trim();
				if (!command) return monitorErrorResult('`command` is required for op="start".', "start");
				let snapshot: MonitorSnapshot;
				try {
					snapshot = manager.start({
						command,
						label: params.label,
						cwd: params.cwd,
						match: params.match,
						everySeconds: params.every,
						maxEvents: params.maxEvents,
						timeoutSeconds: params.timeout,
					});
				} catch (error) {
					return monitorErrorResult(error instanceof Error ? error.message : String(error), "start");
				}
				return {
					content: [{ type: "text", text: describeStart(snapshot) }],
					details: { op: "start", monitors: [snapshot] },
				};
			}
			case "list": {
				const monitors = manager.list();
				return {
					content: [{ type: "text", text: describeList("list", monitors, []) }],
					details: { op: "list", monitors },
				};
			}
			case "stop": {
				const ids = params.ids;
				const notFound = ids ? ids.filter(id => manager.get(id) === undefined) : [];
				const monitors = manager.stop(ids);
				const details: MonitorToolDetails = { op: "stop", monitors };
				if (notFound.length > 0) details.notFound = notFound;
				return {
					content: [{ type: "text", text: describeList("stop", monitors, notFound) }],
					details,
					isError: notFound.length > 0 && monitors.length === 0 ? true : undefined,
				};
			}
		}
	}
}

interface MonitorRenderArgs {
	op?: string;
	command?: string;
	label?: string;
	cwd?: string;
	match?: string;
	every?: number;
	ids?: string[];
}

function forDisplay(text: string, width: number): string {
	return truncateToWidth(replaceTabs(sanitizeText(text)), width, Ellipsis.Unicode);
}

function statusIcon(snapshot: MonitorSnapshot): ToolUIStatus {
	if (snapshot.status === "running") return "running";
	return snapshot.stopReason === "error" ? "error" : "success";
}

function describeCallTarget(args: MonitorRenderArgs | undefined): string {
	if (!args) return "Monitor";
	switch (args.op) {
		case "start": {
			const target = args.label || args.command || "";
			return target ? `Monitor ${forDisplay(target, TRUNCATE_LENGTHS.TITLE)}` : "Monitor";
		}
		case "stop":
			return args.ids && args.ids.length > 0
				? `Stop ${forDisplay(args.ids.join(", "), TRUNCATE_LENGTHS.TITLE)}`
				: "Stop monitors";
		case "list":
			return "Monitors";
		default:
			return "Monitor";
	}
}

function callMeta(args: MonitorRenderArgs | undefined, uiTheme: Theme): string[] {
	if (args?.op !== "start") return [];
	const meta: string[] = [uiTheme.fg("dim", args.every === undefined ? "stream" : `poll ${args.every}s`)];
	if (args.match) meta.push(uiTheme.fg("dim", `/${forDisplay(args.match, TRUNCATE_LENGTHS.SHORT)}/`));
	if (args.cwd) meta.push(uiTheme.fg("dim", forDisplay(shortenPath(args.cwd), TRUNCATE_LENGTHS.SHORT)));
	return meta;
}

export const monitorToolRenderer = {
	mergeCallAndResult: true,

	renderCall(args: MonitorRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		const header = renderStatusLine(
			{
				icon: "pending",
				spinnerFrame: options.spinnerFrame,
				title: describeCallTarget(args),
				meta: callMeta(args, uiTheme),
			},
			uiTheme,
		);
		return new Text(header, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: MonitorToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: MonitorRenderArgs,
	): Component {
		if (result.isError) {
			const errorText = result.content?.find(content => content.type === "text")?.text ?? "Monitor failed";
			const header = renderStatusLine({ icon: "error", title: describeCallTarget(args) }, uiTheme);
			return new Text([header, formatErrorDetail(errorText, uiTheme)].join("\n"), 0, 0);
		}

		const monitors = result.details?.monitors ?? [];
		const notFound = result.details?.notFound ?? [];
		if (monitors.length === 0) {
			const fallback = result.content?.find(content => content.type === "text")?.text || "No monitors";
			const header = renderStatusLine({ icon: "warning", title: describeCallTarget(args) }, uiTheme);
			return new Text(
				[header, formatEmptyMessage(forDisplay(fallback, TRUNCATE_LENGTHS.LINE), uiTheme)].join("\n"),
				0,
				0,
			);
		}

		const running = monitors.filter(monitor => monitor.status === "running").length;
		const meta = [uiTheme.fg(running > 0 ? "accent" : "dim", `${running} running`)];
		if (notFound.length > 0) meta.push(uiTheme.fg("warning", `${notFound.length} unknown`));
		const header = renderStatusLine(
			{
				icon: running > 0 ? "info" : "success",
				spinnerFrame: running > 0 ? options.spinnerFrame : undefined,
				title: describeCallTarget(args),
				meta,
			},
			uiTheme,
		);

		const lines = renderTreeList<MonitorSnapshot>(
			{
				items: monitors,
				expanded: options.expanded,
				maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
				itemType: "monitor",
				renderItem: snapshot => {
					const icon = formatStatusIcon(
						statusIcon(snapshot),
						uiTheme,
						snapshot.status === "running" ? options.spinnerFrame : undefined,
					);
					const id = uiTheme.fg("muted", snapshot.id);
					const badge = formatBadge(snapshot.mode, snapshot.status === "running" ? "accent" : "muted", uiTheme);
					const label = uiTheme.fg("toolOutput", forDisplay(snapshot.label, TRUNCATE_LENGTHS.TITLE));
					const detail: string[] = [`${snapshot.eventCount}/${snapshot.maxEvents} events`];
					if (snapshot.match !== undefined) detail.push(`/${forDisplay(snapshot.match, TRUNCATE_LENGTHS.SHORT)}/`);
					if (snapshot.stopReason) detail.push(snapshot.stopReason);
					const body = [
						`${icon} ${id} ${badge} ${label} ${uiTheme.fg("dim", detail.join(" · "))}`,
						`  ${uiTheme.fg("dim", forDisplay(snapshot.command, TRUNCATE_LENGTHS.CONTENT))}`,
					];
					if (options.expanded) {
						body.push(`  ${uiTheme.fg("dim", forDisplay(shortenPath(snapshot.cwd), TRUNCATE_LENGTHS.CONTENT))}`);
					}
					return body;
				},
			},
			uiTheme,
		);

		const unknownLine =
			notFound.length > 0
				? [uiTheme.fg("warning", `  unknown: ${forDisplay(notFound.join(", "), TRUNCATE_LENGTHS.CONTENT)}`)]
				: [];
		return new Text([header, ...lines, ...unknownLine].join("\n"), 0, 0);
	},
};
