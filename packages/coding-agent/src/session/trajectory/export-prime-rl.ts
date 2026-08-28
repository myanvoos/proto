import type { Trajectory, TrajectoryStep } from "./model";

const TRACE_VERSION = 1;

const AGENT_NAME = "proto";

export interface PrimeRlExportOptions {
	reward?: number;

	envId?: string;
}

interface VerifiersMessage {
	role: "system" | "user" | "assistant" | "tool";
	content?: string | null;
	tool_calls?: Array<{
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}>;
	tool_call_id?: string;
}

interface VerifiersNode {
	parent: number | null;
	message: VerifiersMessage;
	sampled: boolean;
	timestamp: number;
}

interface VerifiersModelCall {
	node: number;
	model: string | null;
	sampling: null;
	endpoint: string | null;
	finish_reason: "stop" | "length" | "tool_calls" | null;
	usage: {
		prompt_tokens: number;
		completion_tokens: number;
		cached_input_tokens?: number;
		reasoning_tokens?: number;
		cost?: number;
	} | null;
	time: { start: number; end: number };
	error: null;
}

function epochSeconds(ms: number): number {
	return ms > 0 ? ms / 1000 : 0;
}

function mapFinishReason(reason: string | undefined): "stop" | "length" | "tool_calls" | null {
	switch (reason) {
		case "stop":
			return "stop";
		case "length":
			return "length";
		case "toolUse":
			return "tool_calls";
		default:
			return null;
	}
}

function buildNodesAndCalls(steps: readonly TrajectoryStep[]): {
	nodes: VerifiersNode[];
	calls: VerifiersModelCall[];
	toolNames: string[];
} {
	const nodes: VerifiersNode[] = [];
	const calls: VerifiersModelCall[] = [];
	const toolNameSet = new Set<string>();
	let openAssistant: { nodeIndex: number; entryId: string } | null = null;

	const pushNode = (message: VerifiersMessage, sampled: boolean, timestamp: number): number => {
		const parent = nodes.length === 0 ? null : nodes.length - 1;
		nodes.push({ parent, message, sampled, timestamp });
		return nodes.length - 1;
	};

	for (const step of steps) {
		if (step.kind === "chat") {
			const text = step.text ?? step.content.trim();
			const nodeIndex = pushNode(
				{ role: "assistant", content: text || null, tool_calls: [] },
				true,
				epochSeconds(step.timestampMs),
			);
			openAssistant = { nodeIndex, entryId: step.entryId };

			const usage = step.usage;
			calls.push({
				node: nodeIndex,
				model: step.detail ?? null,
				sampling: null,
				endpoint: null,
				finish_reason: mapFinishReason(step.stopReason),
				usage: usage
					? {
							prompt_tokens: usage.input,
							completion_tokens: usage.output,
							...(usage.cacheRead > 0 ? { cached_input_tokens: usage.cacheRead } : {}),
							...(usage.reasoningTokens != null ? { reasoning_tokens: usage.reasoningTokens } : {}),
							...(usage.cost ? { cost: usage.cost.total } : {}),
						}
					: null,
				time: {
					start: epochSeconds(step.timestampMs - (step.durationMs ?? 0)),
					end: epochSeconds(step.timestampMs),
				},
				error: null,
			});
			continue;
		}

		if (step.kind === "tool_call") {
			const toolName = step.title.toLowerCase();
			toolNameSet.add(toolName);
			const argsText = toolContentArguments(step);
			if (openAssistant && openAssistant.entryId === step.entryId) {
				nodes[openAssistant.nodeIndex].message.tool_calls?.push({
					id: step.toolCallId ?? `call_${step.index}`,
					type: "function",
					function: { name: toolName, arguments: argsText },
				});
			}
			const resultText = step.resultText ?? toolContentResult(step);
			if (resultText != null) {
				pushNode(
					{ role: "tool", tool_call_id: step.toolCallId ?? `call_${step.index}`, content: resultText },
					false,
					epochSeconds(step.timestampMs + (step.durationMs ?? 0)),
				);
			}
			continue;
		}

		if (step.kind === "tool_result") {
			pushNode(
				{ role: "tool", tool_call_id: step.toolCallId ?? "", content: step.content },
				false,
				epochSeconds(step.timestampMs),
			);
			continue;
		}

		const contextRole = contextRoleForStep(step);
		if (contextRole && step.content.trim()) {
			pushNode({ role: contextRole, content: step.content }, false, epochSeconds(step.timestampMs));
		}
	}

	for (const node of nodes) {
		if (node.message.role === "assistant" && node.message.tool_calls?.length === 0) {
			delete node.message.tool_calls;
		}
	}

	return { nodes, calls, toolNames: [...toolNameSet] };
}

function contextRoleForStep(step: TrajectoryStep): "system" | "user" | null {
	switch (step.source) {
		case "system":
			return "system";
		case "user":
			return "user";
		default:
			return null;
	}
}

function toolContentArguments(step: TrajectoryStep): string {
	const withoutResult = splitOffResult(step.content).arguments;
	try {
		return JSON.stringify(JSON.parse(withoutResult));
	} catch {
		return withoutResult;
	}
}

function toolContentResult(step: TrajectoryStep): string | undefined {
	return splitOffResult(step.content).result;
}

function splitOffResult(content: string): { arguments: string; result: string | undefined } {
	const separator = "\n\n[result]\n";
	const splitAt = content.indexOf(separator);
	if (splitAt === -1) return { arguments: content, result: undefined };
	return { arguments: content.slice(0, splitAt), result: content.slice(splitAt + separator.length) };
}

export function trajectoryToPrimeRlEpisode(
	trajectory: Trajectory,
	options: PrimeRlExportOptions = {},
): Record<string, unknown> {
	const envId = options.envId ?? AGENT_NAME;
	const sessionId = trajectory.header?.id ?? "session";
	const { nodes, calls, toolNames } = buildNodesAndCalls(trajectory.steps);

	const errors = trajectory.steps
		.filter(step => step.isError)
		.map(step => ({
			type: step.kind === "chat" ? "chat_error" : "tool_error",
			message: step.errorText ?? firstLineOf(step.resultText ?? step.preview),
			status_code: null,
			traceback: null,
		}));

	const startSec = epochSeconds(trajectory.startMs);
	const endSec = Math.max(epochSeconds(trajectory.endMs), startSec);

	const trace: Record<string, unknown> = {
		version: TRACE_VERSION,
		id: deterministicHexId(`trace:${sessionId}`, 32),
		verifiers: { version: `${AGENT_NAME}-trajectory-export`, commit: null },
		task: {
			type: "ProtoSession",
			data: {
				title: trajectory.header?.title ?? null,
				cwd: trajectory.header?.cwd ?? null,
				turn_count: trajectory.turnCount,
			},
			key: sessionId,
			hash: null,
		},
		agent: { config: {}, runtime: null, name: AGENT_NAME, trainable: true },
		tools: toolNames,
		nodes,
		calls,
		mm_token_type_id_map: {},
		request_rewrites: [],
		response_rewrites: [],
		rewards: options.reward != null ? { manual: { score: options.reward, weight: 1.0 } } : {},
		metrics: {
			cost_usd: Number(trajectory.totals.costUsd.toFixed(6)),
			num_turns: trajectory.turnCount,
			total_tokens: trajectory.totals.totalTokens,
		},
		info: {
			proto: {
				session_id: sessionId,
				has_errors: trajectory.hasErrors,
				step_count: trajectory.steps.length,
			},
		},
		root_reply: null,
		extra_usage: [],
		is_completed: true,
		ok: !trajectory.hasErrors,
		stop_condition: null,
		errors,
		timing: {
			start: startSec,
			boot: { start: startSec, end: startSec },
			setup: { start: startSec, end: startSec },
			agent: { start: startSec, end: endSec, model: { duration: 0 }, harness: { duration: 0 } },
			finalize: { start: endSec, end: endSec },
			scoring: { start: endSec, end: endSec },
		},
	};

	return {
		id: deterministicHexId(`episode:${sessionId}`, 32),
		env: { id: envId, name: envId },
		task: trace.task,
		group: null,
		run: null,
		ok: !trajectory.hasErrors,
		errors,
		traces: [trace],
	};
}

function firstLineOf(text: string): string {
	const line = text.split("\n")[0] ?? "";
	return line.slice(0, 300);
}

function deterministicHexId(seed: string, length: number): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(`proto-prime-rl:${seed}`);
	return hasher.digest("hex").slice(0, length);
}

export function trajectoriesToPrimeRlJsonl(
	trajectories: readonly Trajectory[],
	options: PrimeRlExportOptions = {},
): string {
	const lines = trajectories.map(trajectory => JSON.stringify(trajectoryToPrimeRlEpisode(trajectory, options)));
	return `${lines.join("\n")}\n`;
}
