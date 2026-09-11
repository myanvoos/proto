import type { AgentToolResult, CustomMessage } from "@oh-my-pi/pi-agent-core";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import { prompt } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { XD_URL_PREFIX } from "../internal-urls/xd-protocol";
import type { Theme } from "../modes/theme/theme";
import resolveReminderPrompt from "../prompts/system/resolve-device-reminder.md" with { type: "text" };
import { renderStatusLine } from "../tui/status-line";
import { Ellipsis, padToWidth, truncateToWidth } from "../tui/utils";
import type { ToolSession } from ".";
import { replaceTabs } from "./render-utils";
import { tokenizeShellSegments } from "./shell-tokenize";
import { ToolError } from "./tool-errors";
import type { XdevDispatch } from "./xdev";
import { parseXdBashCommand } from "./xdev";

export const RESOLVE_DEVICE_NAME = "resolve";
export const REJECT_DEVICE_NAME = "reject";

export const RESOLVE_DEVICE_PATH = `${XD_URL_PREFIX}${RESOLVE_DEVICE_NAME}`;
export const REJECT_DEVICE_PATH = `${XD_URL_PREFIX}${REJECT_DEVICE_NAME}`;

type ResolutionDeviceName = typeof RESOLVE_DEVICE_NAME | typeof REJECT_DEVICE_NAME;

export function isResolutionDeviceName(name: string): name is ResolutionDeviceName {
	return name === RESOLVE_DEVICE_NAME || name === REJECT_DEVICE_NAME;
}

export function resolutionDeviceUsage(device: ResolutionDeviceName): string {
	switch (device) {
		case RESOLVE_DEVICE_NAME:
			return `Run \`xd resolve <reason>\` (bash) with a one-sentence plain-text reason to APPLY the pending staged action (e.g. a tool preview).`;
		case REJECT_DEVICE_NAME:
			return `Run \`xd reject <reason>\` (bash) with a one-sentence plain-text reason to DISCARD the pending staged action (e.g. a tool preview).`;
	}
}

export function isPreviewResolutionToolCall(toolCall: { name: string; arguments?: Record<string, unknown> }): boolean {
	if (toolCall.name !== "bash") return false;
	const command = toolCall.arguments?.command;
	if (typeof command !== "string") return false;
	const segments = tokenizeShellSegments(command);
	if (segments.length !== 1) return false;
	const parsed = parseXdBashCommand(segments[0]);
	return parsed?.kind === "device" && isResolutionDeviceName(parsed.name);
}

export function writeDeviceDispatch(toolName: string, result: unknown): XdevDispatch | undefined {
	if (toolName !== "bash") return undefined;
	if (!result || typeof result !== "object" || !("details" in result)) return undefined;
	const details = result.details;
	if (!details || typeof details !== "object" || !("xdev" in details)) return undefined;
	const xdev = details.xdev;
	if (!xdev || typeof xdev !== "object" || !("tool" in xdev) || !("mode" in xdev)) return undefined;

	return xdev as XdevDispatch;
}

type ResolveAction = "apply" | "discard";

export interface ResolveDetails {
	action: ResolveAction;
	reason: string;
	sourceToolName?: string;
	label?: string;
	sourceResultDetails?: unknown;
}

export function resolveDispatchDetails(toolName: string, result: unknown): ResolveDetails | undefined {
	const dispatch = writeDeviceDispatch(toolName, result);
	if (!dispatch || (dispatch.tool !== RESOLVE_DEVICE_NAME && dispatch.tool !== REJECT_DEVICE_NAME)) return undefined;
	const inner = dispatch.inner;
	if (!inner || typeof inner !== "object") return undefined;
	const action = "action" in inner ? inner.action : undefined;
	const reason = "reason" in inner ? inner.reason : undefined;
	if ((action !== "apply" && action !== "discard") || typeof reason !== "string") return undefined;
	return {
		action,
		reason,
		...("sourceToolName" in inner && typeof inner.sourceToolName === "string"
			? { sourceToolName: inner.sourceToolName }
			: {}),
		...("label" in inner && typeof inner.label === "string" ? { label: inner.label } : {}),
		...("sourceResultDetails" in inner ? { sourceResultDetails: inner.sourceResultDetails } : {}),
	};
}

interface ResolveInvocation {
	action: ResolveAction;
	reason: string;
}

let pendingPreviewSeq = 0;

export function queueResolveHandler(
	session: ToolSession,
	options: {
		label: string;
		sourceToolName: string;
		apply(reason: string): Promise<AgentToolResult<unknown>>;
		reject?(reason: string): Promise<AgentToolResult<unknown> | undefined>;
	},
): void {
	const queue = session.getToolChoiceQueue?.();
	if (!queue) return;

	const id = `pending-action:${options.sourceToolName}:${pendingPreviewSeq++}`;

	const onInvoked = async (input: unknown): Promise<AgentToolResult<unknown>> => {
		const result = await runResolveInvocation(input as ResolveInvocation, {
			sourceToolName: options.sourceToolName,
			label: options.label,
			apply: options.apply,
			reject: options.reject,
			onApplyError: () => {
				queue.registerPendingInvoker(id, options.sourceToolName, onInvoked);
			},
		});

		queue.removePendingInvoker(id);
		return result;
	};

	queue.registerPendingInvoker(id, options.sourceToolName, onInvoked);
}

export function buildResolveReminderMessage(sourceToolName: string): CustomMessage {
	return {
		role: "custom",
		customType: "resolve-reminder",
		content: prompt.render(resolveReminderPrompt, { toolName: sourceToolName }).trim(),
		display: false,
		details: { toolName: sourceToolName },
		attribution: "agent",
		timestamp: Date.now(),
	};
}

async function runResolveInvocation(
	params: ResolveInvocation,
	options: {
		sourceToolName: string;
		label: string;
		apply(reason: string): Promise<AgentToolResult<unknown>>;
		reject?(reason: string): Promise<AgentToolResult<unknown> | undefined>;

		onApplyError?(error: unknown): void;
	},
): Promise<AgentToolResult<ResolveDetails>> {
	const baseDetails: ResolveDetails = {
		action: params.action,
		reason: params.reason,
		sourceToolName: options.sourceToolName,
		label: options.label,
	};
	if (params.action === "apply") {
		let result: AgentToolResult<unknown>;
		try {
			result = await options.apply(params.reason);
		} catch (error) {
			try {
				options.onApplyError?.(error);
			} catch {}
			if (error instanceof ToolError) throw error;
			const message = error instanceof Error ? error.message : String(error);
			throw new ToolError(`Apply failed: ${message}`);
		}
		return {
			...result,
			details: {
				...baseDetails,
				...(result.details != null ? { sourceResultDetails: result.details } : {}),
			},
		};
	}
	if (options.reject != null) {
		const result = await options.reject(params.reason);
		if (result != null) {
			return {
				...result,
				details: {
					...baseDetails,
					...(result.details != null ? { sourceResultDetails: result.details } : {}),
				},
			};
		}
	}
	return {
		content: [{ type: "text" as const, text: `Discarded: ${options.label}. Reason: ${params.reason}` }],
		details: baseDetails,
	};
}

export async function dispatchResolutionDevice(
	session: ToolSession,
	device: ResolutionDeviceName,
	text: string,
): Promise<{ result: AgentToolResult<unknown>; xdev: XdevDispatch }> {
	const body = text.trim();

	const action: ResolveAction = device === RESOLVE_DEVICE_NAME ? "apply" : "discard";
	const xdevBase: XdevDispatch = { tool: device, mode: "execute", args: { reason: body } };
	const invoker = session.peekQueueInvoker?.() ?? session.peekPendingInvoker?.();
	if (!invoker) {
		session.clearPendingInvokers?.();

		if (action === "discard") {
			const details: ResolveDetails = { action, reason: body };
			return {
				result: {
					content: [{ type: "text", text: `Nothing to reject; no pending action remains.` }],
					details,
				},
				xdev: { ...xdevBase, inner: details },
			};
		}
		throw new ToolError(
			`No pending action to apply — ${RESOLVE_DEVICE_PATH} is only valid while a staged preview is pending.`,
		);
	}
	const invocation: ResolveInvocation = { action, reason: body };
	const result = (await invoker(invocation)) as AgentToolResult<ResolveDetails>;
	return { result, xdev: { ...xdevBase, inner: result.details } };
}

export function renderResolutionDeviceCall(device: ResolutionDeviceName, content: unknown, uiTheme: Theme): Component {
	const body = typeof content === "string" ? replaceTabs(content.trim().split("\n")[0] ?? "") : "";
	const title = device === REJECT_DEVICE_NAME ? "Reject" : "Resolve";
	const text = renderStatusLine(
		{
			icon: "pending",
			title,
			description: body ? truncateToWidth(body, 72, Ellipsis.Omit) : undefined,
		},
		uiTheme,
	);
	return new Text(text, 0, 0);
}

export const resolveRenderer = {
	renderCall(args: Partial<ResolveInvocation>, _options: RenderResultOptions, uiTheme: Theme): Component {
		const reasonTrimmed = args.reason?.trim();
		const reason = reasonTrimmed ? truncateToWidth(reasonTrimmed, 72, Ellipsis.Omit) : undefined;
		const text = renderStatusLine(
			{
				icon: "pending",
				title: "Resolve",
				description: args.action,
				badge: {
					label: args.action === "apply" ? "proposed -> resolved" : "proposed -> rejected",
					color: args.action === "apply" ? "success" : "warning",
				},
				meta: reason ? [uiTheme.fg("muted", reason)] : undefined,
			},
			uiTheme,
		);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: ResolveDetails; isError?: boolean },
		_options: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		const details = result.details;
		const label = replaceTabs(details?.label ?? "pending action");
		const reason = replaceTabs(details?.reason?.trim() || "No reason provided");
		const action = details?.action ?? "apply";
		const isApply = action === "apply" && !result.isError;
		const isFailedApply = action === "apply" && result.isError;
		const bgColor = result.isError ? "error" : isApply ? "success" : "warning";

		const icon = uiTheme.symbol(isApply ? "tool.resolve" : "status.error");
		const verb = isApply ? "Accept" : isFailedApply ? "Failed" : "Discard";
		const separator = ": ";
		const separatorIndex = label.indexOf(separator);
		const sourceLabel = separatorIndex > 0 ? label.slice(0, separatorIndex).trim() : undefined;
		const summaryLabel = separatorIndex > 0 ? label.slice(separatorIndex + separator.length).trim() : label;
		const sourceBadge = sourceLabel
			? uiTheme.bold(`${uiTheme.format.bracketLeft}${sourceLabel}${uiTheme.format.bracketRight}`)
			: undefined;
		const headerLine = `${icon} ${uiTheme.bold(`${verb}:`)} ${summaryLabel}${sourceBadge ? ` ${sourceBadge}` : ""}`;
		const lines = ["", headerLine, "", uiTheme.italic(reason), ""];

		return {
			render(width: number): readonly string[] {
				const lineWidth = Math.max(3, width);
				const innerWidth = Math.max(1, lineWidth - 2);
				return lines.map(line => {
					const truncated = truncateToWidth(line, innerWidth, Ellipsis.Omit);
					const framed = ` ${padToWidth(truncated, innerWidth)} `;
					const padded = padToWidth(framed, lineWidth);
					return uiTheme.inverse(uiTheme.fg(bgColor, padded));
				});
			},
			invalidate() {},
		};
	},

	inline: true,
	mergeCallAndResult: true,
};
