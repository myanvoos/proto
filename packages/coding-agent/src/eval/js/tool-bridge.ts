import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type Tool as AiTool, toolWireSchema, validateToolArguments } from "@oh-my-pi/pi-ai";
import { INTENT_FIELD, isRecord, nearestNames } from "@oh-my-pi/pi-utils";
import { type ExecutionOrigin, withExecutionOrigin } from "../../jobs/origin";
import type { ToolSession } from "../../tools";
import { ToolError } from "../../tools/tool-errors";
import { EVAL_AGENT_BRIDGE_NAME, runEvalAgent } from "../agent-bridge";
import { type EvalArtifactRef, publishEvalArtifact } from "../artifact-values";
import { EVAL_AST_BRIDGE_NAME, type EvalAstBlockRange, type EvalAstSymbols, runEvalAst } from "../ast-bridge";
import { runWithBridgeCwd } from "../bridge-cwd";
import { EVAL_BUDGET_BRIDGE_NAME, type EvalBudgetResult, runEvalBudget } from "../budget-bridge";
import {
	EVAL_COMPLETION_BRIDGE_NAME,
	type EvalCompletionInvocationContext,
	runEvalCompletion,
} from "../completion-bridge";
import { EVAL_CONCURRENCY_BRIDGE_NAME, type EvalConcurrencyResult, runEvalConcurrency } from "../concurrency-bridge";
import { EVAL_RUNTIME_BRIDGE_NAME, type RuntimeBridgeResult, runEvalRuntime } from "../runtime-bridge";
import type { JsStatusEvent } from "./shared/types";

export type { JsStatusEvent } from "./shared/types";

const MAX_NESTED_LANES = 8;
const nestedLanes = new WeakMap<ToolSession, Set<number>>();

function acquireNestedLane(session: ToolSession): { lane: string; release(): void } {
	let active = nestedLanes.get(session);
	if (!active) {
		active = new Set();
		nestedLanes.set(session, active);
	}
	for (let index = 0; index < MAX_NESTED_LANES; index++) {
		if (active.has(index)) continue;
		active.add(index);
		return {
			lane: `bridge-${index}`,
			release: () => {
				active.delete(index);
			},
		};
	}
	throw new ToolError(
		`Nested shell lane limit reached (${MAX_NESTED_LANES}); await an active nested call before starting another.`,
	);
}

export interface ToolBridgeOptions {
	session: ToolSession;
	executionOrigin?: ExecutionOrigin;
	/** Host-side cwd of the calling kernel cell; bridged tools resolve relative paths against it. */
	cwd?: string;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
	completionContext?: EvalCompletionInvocationContext;
	completionInvocationId?: string;
	toolCallId?: string;
	onUpdate?: AgentToolUpdateCallback;
	onResult?: (result: AgentToolResult) => void;
}

type BridgedMedia = { type: "image" | "audio" | "video"; mimeType: string; data: string };

export type ToolValue =
	| RuntimeBridgeResult
	| string
	| EvalBudgetResult
	| EvalConcurrencyResult
	| EvalAstBlockRange
	| EvalAstSymbols
	| null
	| {
			text: string;
			details?: unknown;
			images?: Array<{ mimeType: string; data: string }>;
			media?: BridgedMedia[];
			artifacts?: EvalArtifactRef[];
			hasError?: boolean;
	  };
function toolResultHasError(result: AgentToolResult): boolean {
	if ((result as { isError?: unknown }).isError === true) {
		return true;
	}
	if (!(result.details && typeof result.details === "object")) {
		return false;
	}
	return (result.details as { isError?: unknown }).isError === true;
}

/** Tool names listed when an unknown name has no close match, so the error stays readable. */
const MAX_LISTED_TOOL_NAMES = 30;

function unknownToolError(session: ToolSession, name: string): ToolError {
	const available = [...(session.getEvalBridgeToolNames?.() ?? [])].sort();
	const matches = nearestNames(name, available, 3);
	if (matches.length > 0) return new ToolError(`Unknown tool: ${name}. Did you mean ${matches.join(", ")}?`);
	if (available.length === 0) return new ToolError(`Unknown tool: ${name}`);
	const listed = available.slice(0, MAX_LISTED_TOOL_NAMES).join(", ");
	const more = available.length > MAX_LISTED_TOOL_NAMES ? `, … ${available.length - MAX_LISTED_TOOL_NAMES} more` : "";
	return new ToolError(`Unknown tool: ${name}. Available tools: ${listed}${more}`);
}

function getTool(session: ToolSession, name: string): AgentTool {
	const tool = session.getToolForEvalBridge ? session.getToolForEvalBridge(name) : session.getToolByName?.(name);
	if (!tool) throw unknownToolError(session, name);
	return tool;
}

function schemaDeclaresIntent(tool: AgentTool): boolean {
	const properties = toolWireSchema(tool as AiTool).properties;
	return !!properties && typeof properties === "object" && Object.hasOwn(properties, INTENT_FIELD);
}

/**
 * The agent loop strips the harness intent field before a tool executes, so the bridge passes it
 * on only to tools that declare `i` themselves; otherwise it is dropped rather than leaked into
 * argument validation.
 */
function normalizeArgs(tool: AgentTool, args: unknown): unknown {
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		return args;
	}
	const record = args as Record<string, unknown>;
	if (!schemaDeclaresIntent(tool)) {
		if (!Object.hasOwn(record, INTENT_FIELD)) return args;
		const { [INTENT_FIELD]: _intent, ...rest } = record;
		return rest;
	}
	if (record[INTENT_FIELD] !== undefined) return args;
	return { ...record, [INTENT_FIELD]: "js prelude" };
}

/** Bridged calls skip the agent loop, so they get its argument validation and lenient fallback here. */
function validateArgs(tool: AgentTool, toolCallId: string, args: unknown, options: ToolBridgeOptions): unknown {
	try {
		return validateToolArguments(tool as AiTool, {
			type: "toolCall",
			id: toolCallId,
			name: tool.name,
			arguments: args as Record<string, unknown>,
		});
	} catch (error) {
		if (!tool.lenientArgValidation) {
			options.emitStatus?.({ op: tool.name, error: error instanceof Error ? error.message : String(error) });
			throw error;
		}
		if (!isRecord(args)) return args;
		const { __parseError: _parseError, __rawJson: _rawJson, ...fallback } = args;
		return fallback;
	}
}

function summarizeToolResult(
	name: string,
	args: unknown,
	result: AgentToolResult,
	text: string,
	hasError: boolean,
): JsStatusEvent {
	const record = (args && typeof args === "object" ? (args as Record<string, unknown>) : {}) as Record<
		string,
		unknown
	>;
	const details = (
		result.details && typeof result.details === "object" ? (result.details as Record<string, unknown>) : {}
	) as Record<string, unknown>;
	const withError = (event: JsStatusEvent): JsStatusEvent =>
		hasError ? { ...event, hasError: true, error: text.slice(0, 500) } : event;

	switch (name) {
		case "read":
			return withError({ op: "read", path: record.path, chars: text.length, preview: text.slice(0, 500) });
		case "write":
			return withError({
				op: "write",
				path: record.path,
				chars: typeof record.content === "string" ? record.content.length : 0,
			});
		case "bash":
			return withError({
				op: "run",
				cmd: record.command,
				code: typeof details.exitCode === "number" ? details.exitCode : undefined,
				output: text.slice(0, 500),
			});
		case "checklist":
			return withError({
				op: "checklist",
				chars: text.length,
				committed: !hasError && details.op !== "view" && Array.isArray(details.phases),
			});
		default:
			return withError({ op: name, chars: text.length });
	}
}

export async function callSessionTool(name: string, args: unknown, options: ToolBridgeOptions): Promise<ToolValue> {
	const run = () => runWithBridgeCwd(options.session, options.cwd, () => dispatchSessionTool(name, args, options));
	return await (options.executionOrigin ? withExecutionOrigin(options.executionOrigin, run) : run());
}

async function dispatchSessionTool(name: string, args: unknown, options: ToolBridgeOptions): Promise<ToolValue> {
	if (name === EVAL_COMPLETION_BRIDGE_NAME) {
		return await runEvalCompletion(args, options);
	}
	if (name === EVAL_AGENT_BRIDGE_NAME) {
		return await runEvalAgent(args, options);
	}
	if (name === EVAL_BUDGET_BRIDGE_NAME) {
		return await runEvalBudget(args, options);
	}
	if (name === EVAL_CONCURRENCY_BRIDGE_NAME) {
		return runEvalConcurrency(args, options);
	}
	if (name === EVAL_RUNTIME_BRIDGE_NAME) return runEvalRuntime(args, options);
	if (name === EVAL_AST_BRIDGE_NAME) {
		return runEvalAst(args, options);
	}
	if (name === "checkpoint" || name === "rewind") {
		// The session recognizes checkpoint/rewind only as direct toolResult messages
		// (session/checkpoint-entries.ts); a bridged call would report success without taking effect.
		throw new ToolError(`\`${name}\` cannot run through the eval bridge; call the direct \`${name}\` tool.`);
	}
	const tool = getTool(options.session, name);
	const toolCallId = options.toolCallId ?? `js-${name}-${crypto.randomUUID()}`;
	let normalizedArgs = validateArgs(tool, toolCallId, normalizeArgs(tool, args), options);
	let lease: { lane: string; release(): void } | undefined;
	// Nested shell calls cannot wait for the lane held by their calling cell.
	if (name === "bash" && normalizedArgs && typeof normalizedArgs === "object" && !Array.isArray(normalizedArgs)) {
		const record = normalizedArgs as Record<string, unknown>;
		if (record.lane === undefined) {
			lease = acquireNestedLane(options.session);
			normalizedArgs = { ...record, lane: lease.lane };
		}
	}
	try {
		options.signal?.throwIfAborted();
		const result = await tool.execute(
			toolCallId,
			normalizedArgs,
			options.signal,
			options.onUpdate,
			options.session.getToolContext?.(),
		);
		options.onResult?.(result);
		// Async bash returns before its shell lane is free. Hold the lease through
		// callback settlement, including cancellation cleanup, not just admission.
		const details = result.details as { async?: { jobId?: string } } | undefined;
		const job = details?.async?.jobId ? options.session.asyncJobManager?.getJob(details.async.jobId) : undefined;
		if (lease && job) {
			const held = lease;
			lease = undefined;
			void job.promise.then(
				() => held.release(),
				() => held.release(),
			);
		}
		const textBlocks = result.content.filter(
			(content): content is { type: "text"; text: string } =>
				content.type === "text" && typeof content.text === "string",
		);
		const mediaBlocks = result.content.filter(
			(content): content is BridgedMedia =>
				(content.type === "image" || content.type === "audio" || content.type === "video") &&
				typeof content.mimeType === "string" &&
				typeof content.data === "string",
		);
		const text = textBlocks.map(block => block.text).join("");
		const hasError = toolResultHasError(result);
		options.emitStatus?.(summarizeToolResult(name, normalizedArgs, result, text, hasError));
		if (result.details === undefined && mediaBlocks.length === 0 && !hasError) {
			return text;
		}
		const value: Exclude<ToolValue, string> = {
			text,
			details: result.details,
		};
		if (mediaBlocks.length > 0) {
			value.artifacts = [];
			for (const block of mediaBlocks) {
				value.artifacts.push(
					await publishEvalArtifact(
						{
							kind: "binary",
							value: block.data,
							encoding: "base64",
							mimeType: block.mimeType,
						},
						options,
					),
				);
			}
			value.media = mediaBlocks;
			const imageBlocks = mediaBlocks.filter(block => block.type === "image");
			if (imageBlocks.length > 0) {
				value.images = imageBlocks.map(block => ({ mimeType: block.mimeType, data: block.data }));
			}
		}
		if (hasError) {
			value.hasError = true;
		}
		return value;
	} catch (error) {
		options.emitStatus?.({
			op: name,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	} finally {
		lease?.release();
	}
}
