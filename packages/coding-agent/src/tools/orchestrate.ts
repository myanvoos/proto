import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { shimmerEnabled, shimmerText } from "../modes/theme/shimmer";
import type { Theme } from "../modes/theme/theme";
import {
	type KillOutcome,
	OrchestratorRuntime,
	type SendOutcome,
	type WaitOutcome,
	type WorkerReceipt,
	type WorkerScreen,
	type WorkerState,
} from "../orchestrator/runtime";
import orchestrateKillDescription from "../prompts/tools/orchestrate-kill.md" with { type: "text" };
import orchestrateListDescription from "../prompts/tools/orchestrate-list.md" with { type: "text" };
import orchestrateSendDescription from "../prompts/tools/orchestrate-send.md" with { type: "text" };
import orchestrateSpawnDescription from "../prompts/tools/orchestrate-spawn.md" with { type: "text" };
import orchestrateWaitDescription from "../prompts/tools/orchestrate-wait.md" with { type: "text" };
import { renderSpawnSummary } from "../task";
import { discoverAgents } from "../task/discovery";
import { runStructuredSubagent } from "../task/structured-subagent";
import { oneLineLabel } from "../task/types";
import { WORKER_EFFORTS, type WorkerEffort } from "../thinking";
import { renderStatusLine } from "../tui";
import type { ToolSession } from "./index";
import {
	Ellipsis,
	formatBadge,
	formatDuration,
	formatStatusIcon,
	PREVIEW_LIMITS,
	replaceTabs,
	type ToolUIColor,
	type ToolUIStatus,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "./render-utils";

export const ORCHESTRATE_TOOL_NAMES = [
	"orchestrate_spawn",
	"orchestrate_send",
	"orchestrate_wait",
	"orchestrate_kill",
	"orchestrate_list",
] as const;

const outputSchemaInput = type("object | boolean | string | null");

const orchestrateSpawnSchema = type({
	"agent?": type("string").describe(
		"worker agent type (any discovered type); omit for the generic strong-model `worker` (`lightbot` = fast mechanical work)",
	),
	"name?": type("string <= 48").describe("optional worker name; generated when omitted"),
	prompt: type("string > 0").describe("first instruction; the worker starts with no other context"),
	"effort?": type("'lo' | 'med' | 'hi'").describe("thinking-effort hint for the worker's turns"),
	"outputSchema?": outputSchemaInput.describe("optional JSON Schema for each worker turn's final response"),
	"schemaMode?": type("'permissive' | 'strict'").describe("schema enforcement policy; default permissive"),
	"isolated?": type("boolean").describe(
		"run once in an isolated copy of the workspace and apply successful changes back; the worker is terminal afterward",
	),
});

const orchestrateSendSchema = type({
	worker: type("string > 0").describe("worker id from orchestrate_spawn / orchestrate_list"),
	message: type("string > 0").describe("message for the worker; steers mid-turn, else runs as its next turn"),
});

const orchestrateWaitSchema = type({
	"workers?": type("string[]").describe("worker ids to watch; omit to watch every worker with a turn in flight"),
	"timeout?": type("number > 0").describe("max seconds to wait (default 30)"),
});

const orchestrateKillSchema = type({
	worker: type("string > 0").describe("worker id to terminate"),
});

const orchestrateListSchema = type({});

export type OrchestrateOp = "spawn" | "send" | "wait" | "kill" | "list";

export interface OrchestrateToolDetails {
	op: OrchestrateOp;

	screens: WorkerScreen[];
	spawned?: { id: string; label?: string; agent: string; jobId: string };
	send?: SendOutcome;
	wait?: {
		settled: Array<{
			id: string;
			label: string;
			jobId: string;
			status: "completed" | "failed" | "cancelled";
			receipt: WorkerReceipt;
		}>;
		stillRunning: string[];
		timedOut: boolean;

		waiting?: boolean;
	};
	killed?: KillOutcome;
}

function screensOf(session: ToolSession, ids?: string[]): WorkerScreen[] {
	return OrchestratorRuntime.global().screens(session, ids);
}

function textResult(text: string, details: OrchestrateToolDetails): AgentToolResult<OrchestrateToolDetails> {
	return { content: [{ type: "text", text }], details };
}

export class OrchestrateSpawnTool implements AgentTool<typeof orchestrateSpawnSchema, OrchestrateToolDetails> {
	readonly name = "orchestrate_spawn";
	readonly label = "Orchestration Spawn";
	readonly summary = "Spawn a persistent worker and start its first turn";
	readonly description: string;
	readonly parameters = orchestrateSpawnSchema;
	readonly loadMode = "discoverable";
	readonly strict = true;
	constructor(
		private readonly session: ToolSession,
		agents: Array<{ name: string; description: string }> = [],
	) {
		this.description = prompt.render(orchestrateSpawnDescription, { agents });
	}

	static async create(session: ToolSession): Promise<OrchestrateSpawnTool> {
		const { agents } = await discoverAgents(session.cwd);
		return new OrchestrateSpawnTool(
			session,
			agents.map(agent => ({ name: agent.name, description: agent.description })),
		);
	}

	async execute(
		_toolCallId: string,
		params: typeof orchestrateSpawnSchema.infer,
		signal?: AbortSignal,
	): Promise<AgentToolResult<OrchestrateToolDetails>> {
		if (params.effort !== undefined && !WORKER_EFFORTS.includes(params.effort as WorkerEffort)) {
			return textResult(`Invalid effort ${JSON.stringify(params.effort)}. Use "lo", "med", or "hi".`, {
				op: "spawn",
				screens: screensOf(this.session),
			});
		}
		const registry = OrchestratorRuntime.global();
		if (params.isolated === true) {
			try {
				const execution = await runStructuredSubagent({
					session: this.session,
					invocationKind: "worker",
					assignment: params.prompt.trim(),
					agent: params.agent,
					...(params.effort !== undefined ? { effort: params.effort as WorkerEffort } : {}),
					...(Object.hasOwn(params, "outputSchema") ? { outputSchema: params.outputSchema } : {}),
					...(params.schemaMode !== undefined ? { schemaMode: params.schemaMode } : {}),
					isolation: { requested: true },
					shareEvalSession: false,
					identity: { label: params.name },
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
					screens: screensOf(this.session),
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					...textResult(`Isolated worker failed: ${message}`, {
						op: "spawn",
						screens: screensOf(this.session),
					}),
					isError: true,
				};
			}
		}
		const { id, label, jobId } = await registry.spawn(this.session, {
			agent: params.agent,
			name: params.name,
			prompt: params.prompt,
			...(params.effort !== undefined ? { effort: params.effort as WorkerEffort } : {}),
			...(Object.hasOwn(params, "outputSchema") ? { outputSchema: params.outputSchema } : {}),
			...(params.schemaMode !== undefined ? { schemaMode: params.schemaMode } : {}),
		});
		const agentName = params.agent?.trim() || "worker";
		return textResult(
			`Spawned \`${agentName}\` worker \`${id}\` (label \`${label}\`, turn job \`${jobId}\`). The immutable worker id is the only routing address; its result will be delivered when the turn finishes. Continue this worker with orchestrate_send \`${id}\`.`,
			{ op: "spawn", screens: screensOf(this.session), spawned: { id, label, agent: agentName, jobId } },
		);
	}
}

export class OrchestrateSendTool implements AgentTool<typeof orchestrateSendSchema, OrchestrateToolDetails> {
	readonly name = "orchestrate_send";
	readonly label = "Orchestration Send";
	readonly summary = "Message a worker (steer or next turn)";
	readonly description: string;
	readonly parameters = orchestrateSendSchema;
	readonly loadMode = "discoverable";
	readonly strict = true;
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(orchestrateSendDescription);
	}

	async execute(
		_toolCallId: string,
		params: typeof orchestrateSendSchema.infer,
	): Promise<AgentToolResult<OrchestrateToolDetails>> {
		const outcome = await OrchestratorRuntime.global().send(this.session, {
			session: params.worker,
			message: params.message,
		});
		const ack =
			outcome.mode === "turn"
				? `Accepted turn ${outcome.receipt.turn} for worker \`${outcome.id}\` (label \`${outcome.label}\`, job \`${outcome.jobId}\`). Receipt: accepted; completion will report delivered.`
				: outcome.mode === "steered"
					? `Accepted steer for worker \`${outcome.id}\` (label \`${outcome.label}\`, turn ${outcome.receipt.turn}, job \`${outcome.jobId}\`). Receipt: accepted.`
					: `Accepted message for worker \`${outcome.id}\` (label \`${outcome.label}\`) as queued turn ${outcome.receipt.turn}; receipt: queued.`;
		return textResult(ack, { op: "send", screens: screensOf(this.session), send: outcome });
	}
}

const WAIT_PROGRESS_INTERVAL_MS = 500;

export class OrchestrateWaitTool implements AgentTool<typeof orchestrateWaitSchema, OrchestrateToolDetails> {
	readonly name = "orchestrate_wait";
	readonly label = "Orchestration Wait";
	readonly summary = "Block until a worker finishes its turn";
	readonly description: string;
	readonly parameters = orchestrateWaitSchema;
	readonly loadMode = "discoverable";
	readonly strict = true;
	readonly interruptible = true;
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(orchestrateWaitDescription);
	}

	async execute(
		_toolCallId: string,
		params: typeof orchestrateWaitSchema.infer,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<OrchestrateToolDetails>,
	): Promise<AgentToolResult<OrchestrateToolDetails>> {
		const registry = OrchestratorRuntime.global();

		const emitProgress = (): void => {
			onUpdate?.({
				content: [{ type: "text", text: "" }],
				details: {
					op: "wait",
					screens: screensOf(this.session, params.workers),
					wait: { settled: [], stillRunning: [], timedOut: false, waiting: true },
				},
			});
		};
		const progressTimer = onUpdate ? setInterval(emitProgress, WAIT_PROGRESS_INTERVAL_MS) : undefined;
		emitProgress();
		let outcome: WaitOutcome;
		try {
			outcome = await registry.wait(this.session, {
				sessions: params.workers,
				timeoutMs: params.timeout !== undefined ? params.timeout * 1000 : undefined,
				signal,
			});
		} finally {
			clearInterval(progressTimer);
		}
		const details: OrchestrateToolDetails = {
			op: "wait",
			screens: screensOf(this.session, params.workers),
			wait: {
				settled: outcome.settled.map(({ id, label, jobId, status, receipt }) => ({
					id,
					label,
					jobId,
					status,
					receipt,
				})),
				stillRunning: outcome.stillRunning,
				timedOut: outcome.timedOut,
			},
		};
		if (outcome.settled.length === 0 && outcome.stillRunning.length === 0) {
			return { ...textResult("No turns in flight to wait for.", details), useless: true };
		}
		const lines: string[] = [];
		for (const entry of outcome.settled) {
			lines.push(
				`## \`${entry.id}\` (label \`${entry.label}\`) — ${entry.status} / receipt=${entry.receipt.status} turn=${entry.receipt.turn}`,
				entry.resultText,
				"",
			);
		}
		if (outcome.stillRunning.length > 0) {
			lines.push(`Still running: ${outcome.stillRunning.map(id => `\`${id}\``).join(", ")}.`);
		}
		if (outcome.timedOut) {
			lines.push("Wait window elapsed before any turn settled — re-issue orchestrate_wait to keep waiting.");
		}
		const result = textResult(lines.join("\n").trimEnd(), details);

		return outcome.settled.length === 0 ? { ...result, useless: true } : result;
	}
}

export class OrchestrateKillTool implements AgentTool<typeof orchestrateKillSchema, OrchestrateToolDetails> {
	readonly name = "orchestrate_kill";
	readonly label = "Orchestration Kill";
	readonly summary = "Terminate a worker";
	readonly description: string;
	readonly parameters = orchestrateKillSchema;
	readonly loadMode = "discoverable";
	readonly strict = true;
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(orchestrateKillDescription);
	}

	async execute(
		_toolCallId: string,
		params: typeof orchestrateKillSchema.infer,
	): Promise<AgentToolResult<OrchestrateToolDetails>> {
		const outcome = await OrchestratorRuntime.global().kill(this.session, params.worker);
		const cancelNote = outcome.cancelledTurn ? " Its in-flight turn was cancelled." : "";
		return textResult(
			`Worker \`${outcome.id}\` (label \`${outcome.label}\`) is terminal; receipt=${outcome.receipt.status}, reason=${outcome.receipt.reason ?? "explicit-kill"}.${cancelNote} Recover at history://${outcome.id} or agent://${outcome.id}.`,
			{
				op: "kill",
				screens: screensOf(this.session),
				killed: outcome,
			},
		);
	}
}

export class OrchestrateListTool implements AgentTool<typeof orchestrateListSchema, OrchestrateToolDetails> {
	readonly name = "orchestrate_list";
	readonly label = "Orchestration List";
	readonly summary = "List workers and their states";
	readonly description: string;
	readonly parameters = orchestrateListSchema;
	readonly loadMode = "discoverable";
	readonly strict = true;
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(orchestrateListDescription);
	}

	async execute(): Promise<AgentToolResult<OrchestrateToolDetails>> {
		const screens = screensOf(this.session);
		const details: OrchestrateToolDetails = { op: "list", screens };
		if (screens.length === 0) {
			return textResult("No workers. Spawn one with orchestrate_spawn.", details);
		}
		const lines = screens.map(screen => {
			const parts = [
				`- \`${screen.id}\` (label \`${screen.label ?? screen.id}\`) [${screen.agent}] ${screen.state}`,
				`${screen.turns} turn${screen.turns === 1 ? "" : "s"}`,
				`addressable=${screen.addressable ?? false}`,
				`owner=${screen.ownerId ?? "?"}`,
				`parent=${screen.parentSessionId ?? "?"}`,
			];
			if (screen.queued > 0) parts.push(`${screen.queued} queued`);
			if (screen.model) parts.push(screen.model);
			if (screen.lastActivity) parts.push(`last: ${screen.lastActivity}`);
			if (screen.terminal) parts.push(`reason: ${screen.terminal.reason}`, `history: ${screen.terminal.history}`);
			return parts.join(" · ");
		});
		return textResult(lines.join("\n"), details);
	}
}

const COMPOSER_LINE_MAX = TRUNCATE_LENGTHS.LONG;
const TV_LINE_MAX = TRUNCATE_LENGTHS.LINE;
const TV_TRACE_COLLAPSED = PREVIEW_LIMITS.COLLAPSED_LINES;
const TV_TRACE_EXPANDED = PREVIEW_LIMITS.EXPANDED_LINES;
const TV_OUTPUT_COLLAPSED = PREVIEW_LIMITS.OUTPUT_COLLAPSED;
const TV_OUTPUT_EXPANDED = PREVIEW_LIMITS.OUTPUT_EXPANDED;
const CURSOR_GLYPH = "▌";

function stateToIcon(state: WorkerState): ToolUIStatus {
	switch (state) {
		case "running":
			return "running";
		case "starting":
			return "pending";
		case "idle":
			return "done";
		case "dead":
			return "aborted";
	}
}

function stateToColor(state: WorkerState): ToolUIColor {
	switch (state) {
		case "running":
			return "accent";
		case "starting":
			return "accent";
		case "idle":
			return "success";
		case "dead":
			return "muted";
	}
}

interface OrchestrateRenderArgs {
	agent?: string;
	prompt?: string;
	name?: string;
	worker?: string;
	message?: string;
	workers?: string[];
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

function tvScreen(
	uiTheme: Theme,
	screen: WorkerScreen,
	options: RenderResultOptions,
	settledStatus?: "completed" | "failed" | "cancelled",
): string[] {
	const live = screen.state === "running" || screen.state === "starting";
	const spinnerFrame = live ? options.spinnerFrame : undefined;
	const icon = formatStatusIcon(
		settledStatus === "failed" ? "error" : settledStatus === "cancelled" ? "aborted" : stateToIcon(screen.state),
		uiTheme,
		spinnerFrame,
	);
	const badge = formatBadge(screen.agent, stateToColor(screen.state), uiTheme);
	const idText =
		live && options.spinnerFrame !== undefined && shimmerEnabled()
			? shimmerText(screen.id, uiTheme)
			: uiTheme.fg(live ? "accent" : "toolOutput", screen.id);
	const labelText = uiTheme.fg("muted", screen.label ?? screen.id);
	const headParts = [icon, badge, idText, labelText, uiTheme.fg("dim", settledStatus ?? screen.state)];
	const turnsLabel = `${screen.turns}t${screen.queued > 0 ? `+${screen.queued}q` : ""}`;
	headParts.push(uiTheme.fg("muted", turnsLabel));
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
			const label = `${screen.currentTool}${detail ? `: ${detail}` : ""}`;
			const painted =
				options.spinnerFrame !== undefined && shimmerEnabled()
					? shimmerText(frameText(label, TV_LINE_MAX), uiTheme)
					: uiTheme.fg("muted", frameText(label, TV_LINE_MAX));
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
	const footer = settledStatus
		? uiTheme.fg(
				settledStatus === "completed" ? "success" : settledStatus === "failed" ? "error" : "warning",
				settledStatus === "cancelled"
					? "turn cancelled — receipt terminal/rejected"
					: `turn ${settledStatus} — result delivered`,
			)
		: undefined;
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

function describeCall(op: OrchestrateOp, args: OrchestrateRenderArgs | undefined): string {
	switch (op) {
		case "spawn":
			return `spawn ${args?.agent ?? "worker"}${args?.name ? ` · ${frameText(args.name, 40)}` : ""}`;
		case "send":
			return `send → ${args?.worker ? frameText(args.worker, 40) : "?"}`;
		case "wait":
			return args?.workers?.length ? `wait on ${frameText(args.workers.join(", "), 60)}` : "wait on running workers";
		case "kill":
			return `kill ${args?.worker ? frameText(args.worker, 40) : "?"}`;
		case "list":
			return "workers";
	}
}

export function createOrchestrateToolRenderer(op: OrchestrateOp) {
	const composerOp = op === "spawn" || op === "send";
	return {
		inline: true,
		mergeCallAndResult: true,
		animatedPendingPreview: composerOp,
		animatedPartialResult: op === "wait",

		renderCall(args: OrchestrateRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
			const title = uiTheme.fg("muted", `orchestrate ${describeCall(op, args)}`);
			if (composerOp) {
				const message = op === "spawn" ? (args?.prompt ?? "") : (args?.message ?? "");
				return linesComponent(() => {
					const cursorOn = ((options.spinnerFrame ?? 0) & 1) === 0;
					return miniFrame(
						uiTheme,
						title,
						composerRows(uiTheme, message, { cursor: cursorOn, expanded: options.expanded }),
						uiTheme.fg("dim", op === "spawn" ? "booting worker…" : "delivering…"),
					);
				});
			}
			return new Text(
				renderStatusLine({ icon: "pending", title: `orchestrate ${describeCall(op, args)}` }, uiTheme),
				0,
				0,
			);
		},

		renderResult(
			result: {
				content: Array<{ type: string; text?: string }>;
				details?: OrchestrateToolDetails;
				isError?: boolean;
			},
			options: RenderResultOptions,
			uiTheme: Theme,
			args?: OrchestrateRenderArgs,
		): Component {
			const details = result.details;
			if (!details || result.isError) {
				const fallback = result.content.find(part => part.type === "text")?.text ?? "";
				const header = renderStatusLine(
					{ icon: result.isError ? "error" : "done", title: `orchestrate ${describeCall(op, args)}` },
					uiTheme,
				);
				const body = fallback
					? `\n  ${uiTheme.fg(result.isError ? "error" : "dim", frameText(fallback, TV_LINE_MAX))}`
					: "";
				return new Text(`${header}${body}`, 0, 0);
			}

			if (composerOp) {
				const message = op === "spawn" ? (args?.prompt ?? "") : (args?.message ?? "");
				const target =
					op === "spawn"
						? `${uiTheme.fg("muted", "orchestrate spawn")} ${formatBadge(details.spawned?.agent ?? args?.agent ?? "worker", "accent", uiTheme)} ${uiTheme.fg("accent", frameText(details.spawned?.id ?? args?.name ?? "", 40))}`
						: `${uiTheme.fg("muted", "orchestrate send →")} ${uiTheme.fg("accent", frameText(args?.worker ?? "?", 40))}`;
				const ack =
					op === "spawn"
						? uiTheme.fg("success", `turn started${details.spawned ? ` (job ${details.spawned.jobId})` : ""}`)
						: details.send?.mode === "steered"
							? uiTheme.fg("success", "steered into the running turn")
							: details.send?.mode === "queued"
								? uiTheme.fg("warning", "mid-turn — queued as the next turn")
								: uiTheme.fg(
										"success",
										`turn started${details.send?.jobId ? ` (job ${details.send.jobId})` : ""}`,
									);
				const lines = miniFrame(
					uiTheme,
					target,
					composerRows(uiTheme, message, { cursor: false, expanded: options.expanded }),
					ack,
				);
				return linesComponent(lines);
			}

			if (op === "kill") {
				const killedNote = details.killed?.cancelledTurn ? " (in-flight turn cancelled)" : "";
				const header = renderStatusLine(
					{
						icon: "done",
						title: `orchestrate kill ${frameText(details.killed?.id ?? args?.worker ?? "?", 40)}${killedNote}`,
					},
					uiTheme,
				);
				return new Text(header, 0, 0);
			}

			const screens = details.screens;
			if (screens.length === 0) {
				const fallback = result.content.find(part => part.type === "text")?.text ?? "no sessions";
				return new Text(
					renderStatusLine(
						{ icon: "warning", title: `orchestrate ${op}`, meta: [uiTheme.fg("dim", frameText(fallback, 60))] },
						uiTheme,
					),
					0,
					0,
				);
			}
			const waiting = details.wait?.waiting === true;
			const settledById = new Map(details.wait?.settled.map(entry => [entry.id, entry.status] as const) ?? []);
			return linesComponent(() => {
				const running = screens.filter(screen => screen.state === "running" || screen.state === "starting").length;
				const meta: string[] = [];
				if (running > 0) meta.push(uiTheme.fg("accent", `${running} on air`));
				if (settledById.size > 0) meta.push(uiTheme.fg("success", `${settledById.size} settled`));
				if (details.wait?.timedOut) meta.push(uiTheme.fg("warning", "timed out"));
				const title =
					op === "wait"
						? waiting
							? "orchestrate wait — watching the wall"
							: "orchestrate wait"
						: `orchestrate workers (${screens.length})`;
				const header = renderStatusLine(
					{
						icon: details.wait?.timedOut ? "warning" : running > 0 ? "info" : "done",
						spinnerFrame: running > 0 ? options.spinnerFrame : undefined,
						title,
						meta,
					},
					uiTheme,
				);
				const lines = [header];
				for (const screen of screens) {
					lines.push(...tvScreen(uiTheme, screen, options, settledById.get(screen.id)));
				}
				return lines;
			});
		},
	};
}
