import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import { shimmerEnabled, shimmerText } from "../../modes/theme/shimmer";
import type { Theme } from "../../modes/theme/theme";
import {
	type KillOutcome,
	OrchestratorRuntime,
	type SendOutcome,
	type WorkerReceipt,
	type WorkerScreen,
	type WorkerTurnState,
} from "../../orchestrator/runtime";
import { renderSpawnSummary } from "../../task/spawn-summary";
import { runStructuredSubagent } from "../../task/structured-subagent";
import { oneLineLabel } from "../../task/types";
import type { WorkerEffort } from "../../thinking";
import { renderStatusLine } from "../../tui";
import type { ToolSession } from "..";
import {
	Ellipsis,
	formatBadge,
	formatCost,
	formatDuration,
	formatStatusIcon,
	PREVIEW_LIMITS,
	replaceTabs,
	type ToolUIColor,
	type ToolUIStatus,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../render-utils";
import { ToolError } from "../tool-errors";
import {
	type FleetDetails,
	type FleetOp,
	type FleetRenderArgs,
	type FleetTurnReceipt,
	fleetErrorResult,
} from "./types";

export interface FleetSpawnParams {
	agent?: string;
	label?: string;
	message: string;
	model?: string;
	effort?: WorkerEffort;
	outputSchema?: unknown;
	schemaMode?: "permissive" | "strict";
	isolated?: boolean;
}

function textResult(text: string, details: FleetDetails): AgentToolResult<FleetDetails> {
	return { content: [{ type: "text", text }], details };
}

function turnReceipt(receipt: WorkerReceipt, jobId: string, mode: FleetTurnReceipt["mode"]): FleetTurnReceipt {
	return {
		workerId: receipt.workerId,
		label: receipt.label,
		turn: receipt.turn,
		job: { kind: "job", id: jobId },
		status: receipt.status,
		mode,
	};
}

function waitHint(jobId: string): string {
	return `Wait with jobs op "wait" on {"kind":"job","id":"${jobId}"}.`;
}

/** Runtime rejections carry a receipt (rejected/terminal) the caller must be able to observe. */
function runtimeFailure(op: FleetOp, error: unknown, session: ToolSession): AgentToolResult<FleetDetails> {
	if (!(error instanceof ToolError)) throw error;
	const receipt = error.context?.receipt as WorkerReceipt | undefined;
	return fleetErrorResult(error.message, {
		op,
		screens: OrchestratorRuntime.global().screens(session),
		...(receipt ? { rejected: receipt } : {}),
	});
}

export async function executeSpawn(
	session: ToolSession,
	params: FleetSpawnParams,
	signal?: AbortSignal,
): Promise<AgentToolResult<FleetDetails>> {
	const runtime = OrchestratorRuntime.global();
	if (params.isolated === true) {
		try {
			const execution = await runStructuredSubagent({
				session,
				invocationKind: "worker",
				assignment: params.message.trim(),
				agent: params.agent,
				...(params.model !== undefined ? { model: params.model } : {}),
				...(params.effort !== undefined ? { effort: params.effort } : {}),
				...(Object.hasOwn(params, "outputSchema") ? { outputSchema: params.outputSchema } : {}),
				...(params.schemaMode !== undefined ? { schemaMode: params.schemaMode } : {}),
				isolation: { requested: true },
				shareEvalSession: false,
				identity: { label: params.label },
				detached: false,
				signal,
			});
			const result = execution.result;
			const summary = renderSpawnSummary({
				result,
				agentName: result.agent,
				id: result.id,
				totalDurationMs: result.durationMs,
				mergeSummary: execution.mergeSummary,
			});
			return textResult(`${summary}\n\nThe isolated worker is terminal — spawn a new one for further work.`, {
				op: "spawn",
				spawned: { id: result.id, label: params.label ?? result.id, agent: result.agent },
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return fleetErrorResult(`Isolated worker failed: ${message}`, { op: "spawn" });
		}
	}
	let spawned: { id: string; label: string; jobId: string };
	try {
		spawned = await runtime.spawn(session, {
			agent: params.agent,
			label: params.label,
			message: params.message,
			...(params.model !== undefined ? { model: params.model } : {}),
			...(params.effort !== undefined ? { effort: params.effort } : {}),
			...(Object.hasOwn(params, "outputSchema") ? { outputSchema: params.outputSchema } : {}),
			...(params.schemaMode !== undefined ? { schemaMode: params.schemaMode } : {}),
		});
	} catch (error) {
		return runtimeFailure("spawn", error, session);
	}
	const { id, label, jobId } = spawned;
	const screens = runtime.screens(session);
	const agent = screens.find(screen => screen.id === id)?.agent ?? params.agent?.trim() ?? "worker";
	const receipt: FleetTurnReceipt = {
		workerId: id,
		label,
		turn: 1,
		job: { kind: "job", id: jobId },
		status: "accepted",
		mode: "turn",
	};
	const modelNote = params.model !== undefined ? `model \`${params.model}\`, ` : "";
	return textResult(
		`Spawned \`${agent}\` worker \`${id}\` (label \`${label}\`, ${modelNote}turn 1 job \`${jobId}\`); receipt: accepted. The immutable worker id is the only routing address; labels never route. Its result is delivered when the turn settles. ${waitHint(jobId)} Continue it with fleet op "send" id \`${id}\`.`,
		{ op: "spawn", screens, spawned: { id, label, agent }, receipt },
	);
}

export async function executeSend(
	session: ToolSession,
	params: { id: string; message: string; model?: string },
): Promise<AgentToolResult<FleetDetails>> {
	const runtime = OrchestratorRuntime.global();
	let outcome: SendOutcome;
	try {
		outcome = await runtime.send(session, {
			session: params.id,
			message: params.message,
			...(params.model !== undefined ? { model: params.model } : {}),
		});
	} catch (error) {
		return runtimeFailure("send", error, session);
	}
	const receipt = turnReceipt(outcome.receipt, outcome.jobId, outcome.mode);
	const modelNote =
		params.model !== undefined
			? ` Model switch to \`${params.model}\` applies to ${outcome.mode === "steered" ? "the worker's next request" : `turn ${receipt.turn}`} and all later turns.`
			: "";
	const head =
		outcome.mode === "turn"
			? `Accepted turn ${receipt.turn} for worker \`${outcome.id}\` (label \`${outcome.label}\`, job \`${outcome.jobId}\`); receipt: accepted.`
			: outcome.mode === "steered"
				? `Steered worker \`${outcome.id}\` (label \`${outcome.label}\`) inside its running turn ${receipt.turn} (job \`${outcome.jobId}\`); receipt: accepted. No new turn was created.`
				: `Queued turn ${receipt.turn} for busy worker \`${outcome.id}\` (label \`${outcome.label}\`, job \`${outcome.jobId}\`); receipt: queued — it starts after the current turn settles.`;
	return textResult(`${head}${modelNote} ${waitHint(outcome.jobId)}`, {
		op: "send",
		screens: runtime.screens(session),
		receipt,
	});
}

export async function executeTerminate(session: ToolSession, id: string): Promise<AgentToolResult<FleetDetails>> {
	const runtime = OrchestratorRuntime.global();
	let outcome: KillOutcome;
	try {
		outcome = await runtime.kill(session, id);
	} catch (error) {
		return runtimeFailure("terminate", error, session);
	}
	const cancelNote = outcome.cancelledTurn ? " Its in-flight turn was cancelled." : "";
	return textResult(
		`Worker \`${outcome.id}\` (label \`${outcome.label}\`) is terminal; receipt=${outcome.receipt.status}, reason=${outcome.receipt.reason ?? "explicit-kill"}.${cancelNote} Pending inputs were discarded. Recover at history://${outcome.id} or agent://${outcome.id}.`,
		{ op: "terminate", screens: runtime.screens(session), terminated: outcome },
	);
}

function screenRow(screen: WorkerScreen): string {
	const parts = [
		`- \`${screen.id}\` (label \`${screen.label ?? screen.id}\`) [${screen.agent}] lifecycle=${screen.lifecycle} · turn=${screen.turnState ?? "none"}`,
		`${screen.turns} turn${screen.turns === 1 ? "" : "s"}`,
		`addressable=${screen.addressable ?? false}`,
	];
	if (screen.turnJobId) parts.push(`job ${screen.turnJobId}`);
	if (screen.queued > 0) parts.push(`${screen.queued} queued`);
	if (screen.usage) parts.push(`${formatNumber(screen.usage.tokens)} tok`, formatCost(screen.usage.cost));
	if (screen.model) parts.push(screen.model);
	if (screen.lastActivity) parts.push(`last: ${screen.lastActivity}`);
	if (screen.terminal) parts.push(`reason: ${screen.terminal.reason}`, `history: ${screen.terminal.history}`);
	return parts.join(" · ");
}

export function executeOwnedList(session: ToolSession): AgentToolResult<FleetDetails> {
	const screens = OrchestratorRuntime.global().screens(session);
	const details: FleetDetails = { op: "list", scope: "owned", screens };
	if (screens.length === 0) {
		return textResult('No owned workers. Spawn one with fleet op "spawn"; list peers with scope "visible".', details);
	}
	return textResult(screens.map(screenRow).join("\n"), details);
}

export function executeInspect(session: ToolSession, id: string): AgentToolResult<FleetDetails> {
	const screens = OrchestratorRuntime.global().screens(session, [id]);
	const screen = screens[0];
	if (!screen) {
		return fleetErrorResult(`Unknown worker "${id}". Inspect addresses a worker this session owns, by id.`, {
			op: "inspect",
			screens: [],
		});
	}
	const lines = [
		`Worker \`${screen.id}\` (label \`${screen.label ?? screen.id}\`, agent ${screen.agent})`,
		`lifecycle: ${screen.lifecycle}`,
		`turn state: ${screen.turnState ?? "none"}`,
		`turns: ${screen.turns}`,
		`addressable: ${screen.addressable ?? false}`,
	];
	if (screen.model) lines.push(`model: ${screen.model}`);
	if (screen.ownerId) lines.push(`owner: ${screen.ownerId}`);
	if (screen.parentSessionId) lines.push(`parent session: ${screen.parentSessionId}`);
	if (screen.turnJobId) lines.push(`current turn job: ${screen.turnJobId}`);
	if (screen.lastJobId) lines.push(`last turn job: ${screen.lastJobId}`);
	if (screen.queuedJobIds.length > 0) lines.push(`queued turn jobs: ${screen.queuedJobIds.join(", ")}`);
	if (screen.usage) {
		lines.push(`usage: ${formatNumber(screen.usage.tokens)} tokens, ${formatCost(screen.usage.cost)}`);
	}
	if (screen.lastActivity) lines.push(`last activity: ${screen.lastActivity}`);
	if (screen.terminal) {
		lines.push(`terminal: ${screen.terminal.reason} after turn ${screen.terminal.lastTurn}`);
		lines.push(`recovery: ${screen.terminal.history}, ${screen.terminal.output}`);
	} else {
		lines.push(`recovery: history://${screen.id}, agent://${screen.id}`);
	}
	return textResult(lines.join("\n"), { op: "inspect", screens });
}

// ── rendering ────────────────────────────────────────────────────────────────

const COMPOSER_LINE_MAX = TRUNCATE_LENGTHS.LONG;
const TV_LINE_MAX = TRUNCATE_LENGTHS.LINE;
const TV_TRACE_COLLAPSED = PREVIEW_LIMITS.COLLAPSED_LINES;
const TV_TRACE_EXPANDED = PREVIEW_LIMITS.EXPANDED_LINES;
const TV_OUTPUT_COLLAPSED = PREVIEW_LIMITS.OUTPUT_COLLAPSED;
const TV_OUTPUT_EXPANDED = PREVIEW_LIMITS.OUTPUT_EXPANDED;
const CURSOR_GLYPH = "▌";

function turnStateToIcon(state: WorkerTurnState): ToolUIStatus {
	switch (state) {
		case "running":
			return "running";
		case "starting":
			return "pending";
		case "idle":
			return "done";
	}
}

function turnStateToColor(state: WorkerTurnState): ToolUIColor {
	return state === "idle" ? "success" : "accent";
}

function frameText(text: string, max: number): string {
	return oneLineLabel(replaceTabs(text), max);
}

function miniFrame(uiTheme: Theme, header: string, body: string[], footer?: string): string[] {
	const box = uiTheme.boxRound;
	const rail = (glyph: string) => uiTheme.fg("dim", glyph);
	const lines = [`${rail(`${box.topLeft}${box.horizontal}`)} ${header}`];
	for (const row of body) {
		lines.push(`${rail(box.vertical)} ${row}`);
	}
	lines.push(
		footer ? `${rail(`${box.bottomLeft}${box.horizontal}`)} ${footer}` : rail(`${box.bottomLeft}${box.horizontal}`),
	);
	return lines;
}

function composerRows(uiTheme: Theme, message: string, options: { cursor: boolean; expanded: boolean }): string[] {
	const promptGlyph = uiTheme.fg("accent", ">");
	const rawLines = message.split(/\r?\n/).filter(line => line.trim().length > 0);
	const maxRows = options.expanded ? 6 : 2;
	const visible = rawLines.slice(0, maxRows).map(line => frameText(line, COMPOSER_LINE_MAX));
	if (visible.length === 0) visible.push("");
	if (rawLines.length > maxRows) {
		visible[visible.length - 1] = `${visible[visible.length - 1]} …`;
	} else if (options.cursor) {
		visible[visible.length - 1] = `${visible[visible.length - 1]}${uiTheme.fg("accent", CURSOR_GLYPH)}`;
	}
	return visible.map((line, index) =>
		index === 0 ? `${promptGlyph} ${uiTheme.fg("toolOutput", line)}` : `  ${uiTheme.fg("toolOutput", line)}`,
	);
}

function tvScreen(uiTheme: Theme, screen: WorkerScreen, options: RenderResultOptions): string[] {
	const live = screen.turnState === "running" || screen.turnState === "starting";
	const spinnerFrame = live ? options.spinnerFrame : undefined;
	const icon = formatStatusIcon(
		screen.lifecycle === "terminal" ? "aborted" : turnStateToIcon(screen.turnState ?? "idle"),
		uiTheme,
		spinnerFrame,
	);
	const badge = formatBadge(screen.agent, turnStateToColor(screen.turnState ?? "idle"), uiTheme);
	const nameText =
		live && options.spinnerFrame !== undefined && shimmerEnabled()
			? shimmerText(frameText(screen.label ?? screen.id, 40), uiTheme)
			: uiTheme.fg(live ? "accent" : "toolOutput", frameText(screen.label ?? screen.id, 40));
	const headParts = [icon, badge, nameText];
	if (screen.label && screen.label !== screen.id) headParts.push(uiTheme.fg("dim", frameText(screen.id, 40)));
	headParts.push(uiTheme.fg("dim", `${screen.lifecycle}/${screen.turnState ?? "none"}`));
	headParts.push(uiTheme.fg("muted", `${screen.turns}t${screen.queued > 0 ? `+${screen.queued}q` : ""}`));
	if (screen.turnStartedAt !== undefined) {
		headParts.push(uiTheme.fg("dim", formatDuration(Date.now() - screen.turnStartedAt)));
	}
	if (screen.model) headParts.push(uiTheme.fg("muted", frameText(screen.model, 40)));

	const body: string[] = [];
	const hook = uiTheme.tree.hook;
	if (live) {
		if (screen.turnMessage) {
			body.push(`${uiTheme.fg("accent", ">")} ${uiTheme.fg("dim", frameText(screen.turnMessage, TV_LINE_MAX))}`);
		}
		const traceCap = options.expanded ? TV_TRACE_EXPANDED : TV_TRACE_COLLAPSED;
		for (const line of screen.trace.slice(-traceCap)) {
			body.push(`${uiTheme.fg("dim", hook)} ${uiTheme.fg("dim", frameText(line, TV_LINE_MAX))}`);
		}
		if (screen.currentTool) {
			const detail = screen.lastIntent ?? screen.currentToolArgs;
			const label = frameText(`${screen.currentTool}${detail ? `: ${detail}` : ""}`, TV_LINE_MAX);
			const painted =
				options.spinnerFrame !== undefined && shimmerEnabled()
					? shimmerText(label, uiTheme)
					: uiTheme.fg("muted", label);
			body.push(`${uiTheme.fg("accent", hook)} ${painted}`);
		} else if (screen.lastIntent) {
			body.push(`${uiTheme.fg("accent", hook)} ${uiTheme.fg("muted", frameText(screen.lastIntent, TV_LINE_MAX))}`);
		}
		const outputCap = options.expanded ? TV_OUTPUT_EXPANDED : TV_OUTPUT_COLLAPSED;
		for (const line of screen.outputTail.slice(-outputCap)) {
			if (line.trim().length === 0) continue;
			body.push(`  ${uiTheme.fg("muted", frameText(line, TV_LINE_MAX))}`);
		}
	} else if (screen.lastActivity) {
		body.push(`${uiTheme.fg("dim", hook)} ${uiTheme.fg("muted", frameText(screen.lastActivity, TV_LINE_MAX))}`);
	}
	const job = screen.turnJobId ?? screen.lastJobId;
	const footer = job ? uiTheme.fg("dim", `job ${frameText(job, 60)}`) : undefined;
	return miniFrame(uiTheme, headParts.join(" "), body, footer);
}

function linesComponent(lines: string[] | (() => string[])): Component {
	return {
		render(width: number): readonly string[] {
			const rows = typeof lines === "function" ? lines() : lines;
			return rows.map(line => truncateToWidth(line, width, Ellipsis.Unicode));
		},
		invalidate() {},
	};
}

function describeCall(args: FleetRenderArgs | undefined): string {
	switch (args?.op) {
		case "spawn":
			return `spawn ${frameText(args.agent ?? "worker", 30)}${args.label ? ` · ${frameText(args.label, 40)}` : ""}${args.isolated ? " · isolated" : ""}`;
		case "send":
			return `send → ${args.id ? frameText(args.id, 40) : "?"}${args.model ? ` · ${frameText(args.model, 36)}` : ""}`;
		case "inspect":
			return `inspect ${args.id ? frameText(args.id, 40) : "?"}`;
		case "terminate":
			return `terminate ${args.id ? frameText(args.id, 40) : "?"}`;
		default:
			return "workers";
	}
}

function isComposerOp(args: FleetRenderArgs | undefined): boolean {
	return args?.op === "spawn" || args?.op === "send";
}

export function workerRenderCall(args: FleetRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
	const title = uiTheme.fg("muted", `Fleet ${describeCall(args)}`);
	if (isComposerOp(args)) {
		const message = args.message ?? "";
		return linesComponent(() => {
			const cursorOn = ((options.spinnerFrame ?? 0) & 1) === 0;
			return miniFrame(
				uiTheme,
				title,
				composerRows(uiTheme, message, { cursor: cursorOn, expanded: options.expanded }),
				uiTheme.fg("dim", args.op === "spawn" ? "booting worker…" : "delivering…"),
			);
		});
	}
	return new Text(renderStatusLine({ icon: "pending", title: `Fleet ${describeCall(args)}` }, uiTheme), 0, 0);
}

function receiptAck(uiTheme: Theme, receipt: FleetTurnReceipt): string {
	const job = frameText(receipt.job.id, 60);
	switch (receipt.mode) {
		case "steered":
			return uiTheme.fg("success", `steered into turn ${receipt.turn} (job ${job})`);
		case "queued":
			return uiTheme.fg("warning", `queued as turn ${receipt.turn} (job ${job})`);
		case "turn":
			return uiTheme.fg("success", `turn ${receipt.turn} accepted (job ${job})`);
	}
}

export function workerRenderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: FleetDetails; isError?: boolean },
	options: RenderResultOptions,
	uiTheme: Theme,
	args?: FleetRenderArgs,
): Component {
	const details = result.details;
	if (!details || result.isError) {
		const fallback = result.content.find(part => part.type === "text")?.text ?? "";
		const header = renderStatusLine(
			{ icon: result.isError ? "error" : "done", title: `Fleet ${describeCall(args)}` },
			uiTheme,
		);
		const body = fallback
			? `\n  ${uiTheme.fg(result.isError ? "error" : "dim", frameText(fallback, TV_LINE_MAX))}`
			: "";
		return new Text(`${header}${body}`, 0, 0);
	}

	if (isComposerOp(args)) {
		const message = args?.message ?? "";
		const spawnName = details.spawned?.label ?? args?.label ?? details.spawned?.id ?? "";
		const spawnId =
			details.spawned?.id && spawnName !== details.spawned.id
				? ` ${uiTheme.fg("dim", frameText(details.spawned.id, 40))}`
				: "";
		const target =
			args?.op === "spawn"
				? `${uiTheme.fg("muted", "Fleet spawn")} ${formatBadge(details.spawned?.agent ?? args?.agent ?? "worker", "accent", uiTheme)} ${uiTheme.fg("accent", frameText(spawnName, 40))}${spawnId}`
				: `${uiTheme.fg("muted", "Fleet send →")} ${uiTheme.fg("accent", frameText(args?.id ?? "?", 40))}${args?.model ? ` ${uiTheme.fg("dim", frameText(args.model, 36))}` : ""}`;
		const ack = details.receipt
			? receiptAck(uiTheme, details.receipt)
			: uiTheme.fg("success", args?.isolated ? "isolated run finished" : "done");
		return linesComponent(
			miniFrame(uiTheme, target, composerRows(uiTheme, message, { cursor: false, expanded: options.expanded }), ack),
		);
	}

	if (details.op === "terminate") {
		const killed = details.terminated;
		const note = killed?.cancelledTurn ? " (in-flight turn cancelled)" : "";
		return new Text(
			renderStatusLine(
				{
					icon: "done",
					title: `Fleet terminate ${frameText(killed?.label ?? killed?.id ?? args?.id ?? "?", 40)}${note}`,
				},
				uiTheme,
			),
			0,
			0,
		);
	}

	const screens = details.screens ?? [];
	if (screens.length === 0) {
		const fallback = result.content.find(part => part.type === "text")?.text ?? "no workers";
		return new Text(
			renderStatusLine(
				{ icon: "info", title: "Fleet workers", meta: [uiTheme.fg("dim", frameText(fallback, 60))] },
				uiTheme,
			),
			0,
			0,
		);
	}
	return linesComponent(() => {
		const running = screens.filter(
			screen => screen.turnState === "running" || screen.turnState === "starting",
		).length;
		const meta = running > 0 ? [uiTheme.fg("accent", `${running} on air`)] : [];
		const title = details.op === "inspect" ? `Fleet inspect` : `Fleet workers (${screens.length})`;
		const lines = [
			renderStatusLine(
				{
					icon: running > 0 ? "info" : "done",
					spinnerFrame: running > 0 ? options.spinnerFrame : undefined,
					title,
					meta,
				},
				uiTheme,
			),
		];
		for (const screen of screens) lines.push(...tvScreen(uiTheme, screen, options));
		return lines;
	});
}
