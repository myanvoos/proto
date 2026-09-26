import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import { type Component, Text } from "@oh-my-pi/pi-tui";
import { prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { Theme } from "../../modes/theme/theme";
import fleetDescription from "../../prompts/tools/fleet.md" with { type: "text" };
import type { AgentRegistry } from "../../registry/agent-registry";
import { discoverAgents } from "../../task/discovery";
import { resolveSpawnPolicy } from "../../task/spawn-policy";
import { canSpawnAtDepth } from "../../task/types";
import { WORKER_EFFORTS, type WorkerEffort } from "../../thinking";
import { renderStatusLine, truncateToWidth } from "../../tui";
import type { ToolSession } from "..";
import { replaceTabs } from "../render-utils";
import { ToolError } from "../tool-errors";
import { executeInbox, executeList, executeMessage, messagingRenderCall, messagingRenderResult } from "./messaging";
import { type FleetDetails, type FleetOp, type FleetRenderArgs, fleetErrorResult } from "./types";
import {
	executeInspect,
	executeOwnedList,
	executeSend,
	executeSpawn,
	executeTerminate,
	workerRenderCall,
	workerRenderResult,
} from "./workers";

export { createIrcMessageCard, isIrcEnabled } from "./messaging";
export * from "./types";

const fleetSchema = type({
	op: type("'spawn' | 'send' | 'message' | 'list' | 'inspect' | 'inbox' | 'terminate'").describe(
		"spawn/send/terminate/inspect: owned workers (tracked turns); message/inbox: peer communication; list: owned or visible agents",
	),
	"id?": type("string > 0").describe("send/inspect/terminate: canonical id of a worker you own"),
	"to?": type("string > 0").describe('message: recipient peer id, or "all" to broadcast'),
	"message?": type("string > 0").describe("spawn: first instruction; send: worker input; message: peer message body"),
	"agent?": type("string > 0").describe("spawn: worker agent type; omit for the parent-permitted default"),
	"label?": type("string <= 48").describe("spawn: display label ([A-Za-z0-9_-]{1,48}); never an address"),
	"model?": type("string > 0").describe(
		"spawn/send: role alias like `@worker` or concrete model id; validated before any worker or turn is allocated",
	),
	"effort?": type("'lo' | 'med' | 'hi'").describe("spawn: thinking-effort hint for the worker's turns"),
	"outputSchema?": type("object | boolean | string | null").describe(
		"spawn: JSON Schema for each worker turn's final response",
	),
	"schemaMode?": type("'permissive' | 'strict'").describe("spawn: schema enforcement policy; default permissive"),
	"isolated?": type("boolean").describe(
		"spawn: run once in an isolated workspace copy and apply successful changes back; the worker is terminal afterward",
	),
	"replyTo?": type("string > 0").describe("message: id of the message being answered"),
	"scope?": type("'owned' | 'visible'").describe(
		"list: owned (default) = your workers; visible = peers you can message",
	),
	"peek?": type("boolean").describe("inbox: list messages without consuming them"),
});

type FleetParams = typeof fleetSchema.infer;
type FleetField = Exclude<keyof FleetParams, "op">;

const FLEET_FIELDS: readonly FleetField[] = [
	"id",
	"to",
	"message",
	"agent",
	"label",
	"model",
	"effort",
	"outputSchema",
	"schemaMode",
	"isolated",
	"replyTo",
	"scope",
	"peek",
];

const OP_FIELDS: Record<FleetOp, { required: readonly FleetField[]; optional: readonly FleetField[] }> = {
	spawn: {
		required: ["message"],
		optional: ["agent", "label", "model", "effort", "outputSchema", "schemaMode", "isolated"],
	},
	send: { required: ["id", "message"], optional: ["model"] },
	message: { required: ["to", "message"], optional: ["replyTo"] },
	list: { required: [], optional: ["scope"] },
	inspect: { required: ["id"], optional: [] },
	inbox: { required: [], optional: ["peek"] },
	terminate: { required: ["id"], optional: [] },
};

const FLEET_OPS = Object.keys(OP_FIELDS) as FleetOp[];

function isFleetOp(value: unknown): value is FleetOp {
	return typeof value === "string" && Object.hasOwn(OP_FIELDS, value);
}

/** Strict per-op shape check; runs before any side effect, including for direct typed calls. */
function validateFleetParams(params: Record<string, unknown>): string | undefined {
	const unknown = Object.keys(params).filter(key => key !== "op" && !FLEET_FIELDS.includes(key as FleetField));
	if (unknown.length > 0) {
		return `Unknown fleet parameter${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`;
	}
	const op = params.op;
	if (!isFleetOp(op)) return `\`op\` is required: one of ${FLEET_OPS.join(", ")}.`;
	const { required, optional } = OP_FIELDS[op];
	const accepted = [...required, ...optional];
	const irrelevant = Object.keys(params).filter(
		key => key !== "op" && params[key] !== undefined && !accepted.includes(key as FleetField),
	);
	if (irrelevant.length > 0) {
		const acceptedText = accepted.length > 0 ? accepted.join(", ") : "none";
		return `op "${op}" does not accept ${irrelevant.join(", ")}; accepted: ${acceptedText}.`;
	}
	const missing = required.filter(key => typeof params[key] !== "string" || !(params[key] as string).trim());
	if (missing.length > 0) return `op "${op}" requires ${missing.join(", ")}.`;
	if (params.effort !== undefined && !WORKER_EFFORTS.includes(params.effort as WorkerEffort)) {
		return `Invalid effort ${JSON.stringify(params.effort)}. Use "lo", "med", or "hi".`;
	}
	if (params.scope !== undefined && params.scope !== "owned" && params.scope !== "visible") {
		return `Invalid scope ${JSON.stringify(params.scope)}. Use "owned" or "visible".`;
	}
	if (params.label !== undefined && !/^[A-Za-z0-9_-]{1,48}$/.test(String(params.label))) {
		return "Worker label must be 1–48 characters using only ASCII letters, digits, underscore, or hyphen.";
	}
	return undefined;
}

interface MessagingDeps {
	registry: AgentRegistry;
	senderId: string;
	fleetRoot?: string;
}

export class FleetTool implements AgentTool<typeof fleetSchema, FleetDetails> {
	readonly name = "fleet";
	readonly label = "Fleet";
	readonly summary = "Spawn and steer owned workers; message peer agents";
	readonly description: string;
	readonly parameters = fleetSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

	readonly examples: readonly ToolExample<FleetParams>[] = [
		{
			caption: "Spawn a worker; its receipt names the turn job to wait on",
			call: { op: "spawn", label: "parser", message: "Fix the tokenizer in src/lex.ts; run its tests." },
		},
		{
			caption: "Tracked follow-up for an owned worker (by immutable id)",
			call: { op: "send", id: "worker-1a2b3c", message: "Also cover the empty-input case." },
		},
		{
			caption: "Untracked peer message; delivery never proves a turn started",
			call: { op: "message", to: "Main", message: "Blocked: JWT or session cookies?" },
		},
		{ caption: "Your workers", call: { op: "list" } },
		{ caption: "Peers you can message", call: { op: "list", scope: "visible" } },
		{ caption: "Terminate an owned worker", call: { op: "terminate", id: "worker-1a2b3c" } },
	];

	constructor(
		private readonly session: ToolSession,
		agents: Array<{ name: string; description: string }> = [],
	) {
		this.description = prompt.render(fleetDescription, { agents });
	}

	static async create(session: ToolSession): Promise<FleetTool> {
		const { agents } = await discoverAgents(session.cwd);
		return new FleetTool(
			session,
			agents.map(agent => ({ name: agent.name, description: agent.description })),
		);
	}

	#messaging(): MessagingDeps | undefined {
		if (this.session.enableIrc === false) return undefined;
		const registry = this.session.agentRegistry;
		const senderId = this.session.getAgentId?.() ?? undefined;
		if (!registry || !senderId) return undefined;
		return { registry, senderId, fleetRoot: this.session.getAgentFleetRoot?.() };
	}

	/** Spawning and tracked turns follow the parent's spawn policy and recursion depth. */
	#workerControlDenial(): string | undefined {
		const policy = resolveSpawnPolicy(this.session.getSessionSpawns());
		if (!policy.enabled) return "Worker control is unavailable: this agent's spawn policy allows no workers.";
		const depth = this.session.taskDepth ?? 0;
		const maxDepth = this.session.settings.get("orchestrator.maxRecursionDepth") ?? 2;
		if (!canSpawnAtDepth(maxDepth, depth)) {
			return `Worker control is unavailable at task depth ${depth} (orchestrator.maxRecursionDepth=${maxDepth}).`;
		}
		return undefined;
	}

	#authorize(op: FleetOp, params: FleetParams): string | undefined {
		switch (op) {
			case "spawn":
			case "send":
				return this.#workerControlDenial();
			case "message":
			case "inbox":
				return this.#messaging() ? undefined : "Peer messaging is unavailable in this session.";
			case "list":
				return params.scope === "visible" && !this.#messaging()
					? 'Peer messaging is unavailable in this session; only scope "owned" can be listed.'
					: undefined;
			case "inspect":
			case "terminate":
				// Owner scope is enforced by the runtime: only workers this session owns resolve.
				return undefined;
		}
	}

	async execute(
		_toolCallId: string,
		params: FleetParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<FleetDetails>> {
		const invalid = validateFleetParams(params as Record<string, unknown>);
		const op = isFleetOp(params.op) ? params.op : undefined;
		if (invalid || !op) return fleetErrorResult(invalid ?? "`op` is required.", op ? { op } : {});
		const denied = this.#authorize(op, params);
		if (denied) return fleetErrorResult(denied, { op });
		try {
			return await this.#dispatch(op, params, signal);
		} catch (error) {
			if (error instanceof ToolError) return fleetErrorResult(error.message, { op });
			throw error;
		}
	}

	async #dispatch(op: FleetOp, params: FleetParams, signal?: AbortSignal): Promise<AgentToolResult<FleetDetails>> {
		switch (op) {
			case "spawn":
				return executeSpawn(
					this.session,
					{
						message: params.message!,
						...(params.agent !== undefined ? { agent: params.agent } : {}),
						...(params.label !== undefined ? { label: params.label } : {}),
						...(params.model !== undefined ? { model: params.model } : {}),
						...(params.effort !== undefined ? { effort: params.effort } : {}),
						...(Object.hasOwn(params, "outputSchema") ? { outputSchema: params.outputSchema } : {}),
						...(params.schemaMode !== undefined ? { schemaMode: params.schemaMode } : {}),
						...(params.isolated !== undefined ? { isolated: params.isolated } : {}),
					},
					signal,
				);
			case "send":
				return executeSend(this.session, {
					id: params.id!,
					message: params.message!,
					...(params.model !== undefined ? { model: params.model } : {}),
				});
			case "terminate":
				return executeTerminate(this.session, params.id!);
			case "inspect":
				return executeInspect(this.session, params.id!);
			case "list": {
				if (params.scope !== "visible") return executeOwnedList(this.session);
				const messaging = this.#messaging()!;
				return executeList(messaging.registry, messaging.senderId, messaging.fleetRoot);
			}
			case "message":
				return executeMessage(this.#messaging()!, {
					to: params.to!,
					message: params.message!,
					...(params.replyTo !== undefined ? { replyTo: params.replyTo } : {}),
				});
			case "inbox": {
				const messaging = this.#messaging()!;
				return executeInbox(messaging.registry, messaging.senderId, params.peek, messaging.fleetRoot);
			}
		}
	}
}

function isPeerRender(args: FleetRenderArgs | undefined, details?: FleetDetails): boolean {
	const op = details?.op ?? args?.op;
	if (op === "message" || op === "inbox") return true;
	return op === "list" && (details?.scope ?? args?.scope) === "visible";
}

type RenderedResult = { content: Array<{ type: string; text?: string }>; details?: FleetDetails; isError?: boolean };

/**
 * Transcripts written before fleet became agents-only carry peer `send` calls and job/process ops.
 * They render as history — peer sends as message cards, everything else as a plain status row.
 */
function historicalOp(args: FleetRenderArgs | undefined, details?: FleetDetails): string | undefined {
	const op = (details?.op as string | undefined) ?? args?.op;
	if (op === undefined) return undefined;
	// Tracked sends address `id`; a legacy peer send carried `to` and returned delivery receipts.
	const legacyPeerSend = op === "send" && args?.id === undefined && (args?.to !== undefined || !!details?.receipts);
	return isFleetOp(op) && !legacyPeerSend ? undefined : op;
}

function renderHistorical(
	op: string,
	result: RenderedResult | undefined,
	options: RenderResultOptions,
	uiTheme: Theme,
	args: FleetRenderArgs | undefined,
): Component {
	if (op === "send") {
		const legacy = result?.details as (FleetDetails & { id?: string }) | undefined;
		const messageArgs = { ...args, op: "message" };
		if (!result) return messagingRenderCall(messageArgs, options, uiTheme);
		const details: FleetDetails = { ...legacy, op: "message", to: legacy?.to ?? legacy?.id ?? args?.to };
		return messagingRenderResult({ ...result, details }, options, uiTheme, messageArgs);
	}
	const text = result?.content.find(part => part.type === "text")?.text?.split("\n")[0] ?? "";
	return new Text(
		renderStatusLine(
			{
				icon: result ? (result.isError ? "error" : "done") : "pending",
				title: `Fleet ${truncateToWidth(replaceTabs(op), 24)}`,
				meta: text ? [uiTheme.fg("dim", truncateToWidth(replaceTabs(sanitizeText(text)), 80))] : [],
			},
			uiTheme,
		),
		0,
		0,
	);
}

export const fleetToolRenderer = {
	inline: true,
	mergeCallAndResult: true,
	animatedPendingPreview: (args: unknown): boolean => {
		const renderArgs = args as FleetRenderArgs | undefined;
		return (renderArgs?.op === "spawn" || renderArgs?.op === "send") && historicalOp(renderArgs) === undefined;
	},

	renderCall(args: FleetRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		const legacy = historicalOp(args);
		if (legacy !== undefined) return renderHistorical(legacy, undefined, options, uiTheme, args);
		return isPeerRender(args)
			? messagingRenderCall(args, options, uiTheme)
			: workerRenderCall(args, options, uiTheme);
	},

	renderResult(
		result: RenderedResult,
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: FleetRenderArgs,
	): Component {
		const legacy = historicalOp(args, result.details);
		if (legacy !== undefined) return renderHistorical(legacy, result, options, uiTheme, args);
		return isPeerRender(args, result.details)
			? messagingRenderResult(result, options, uiTheme, args)
			: workerRenderResult(result, options, uiTheme, args);
	},
};
