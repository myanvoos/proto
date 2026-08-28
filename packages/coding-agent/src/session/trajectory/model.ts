import type { AssistantMessage, Message, TextContent, ThinkingContent, ToolCall, Usage } from "@oh-my-pi/pi-ai";
import type { SessionEntry, SessionHeader } from "../session-entries";

export type TrajectorySource = "user" | "assistant" | "tool" | "compaction" | "system" | "meta";

export interface TrajectoryUsageTotals {
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	costUsd: number;
	reasoningTokens: number;
}

export function emptyTrajectoryUsageTotals(): TrajectoryUsageTotals {
	return {
		requests: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		costUsd: 0,
		reasoningTokens: 0,
	};
}

export interface TrajectoryStep {
	index: number;
	entryId: string;
	source: TrajectorySource;

	kind: string;

	stopReason?: string;

	errorText?: string;

	text?: string;

	title: string;

	detail?: string;

	timestampMs: number;

	durationMs?: number;

	ttftMs?: number;

	usage?: Usage;
	isError: boolean;

	toolCallId?: string;

	resultText?: string;

	preview: string;

	content: string;

	turn: number;
}

function stepEndMs(step: TrajectoryStep): number {
	if (step.kind === "tool_call" && step.durationMs !== undefined) return step.timestampMs + step.durationMs;
	return step.timestampMs;
}

export interface TrajectoryTurn {
	index: number;
	startMs: number;
	endMs: number;
	firstStepIndex: number;
	lastStepIndex: number;
	totals: TrajectoryUsageTotals;
}

export interface Trajectory {
	header: Pick<SessionHeader, "id" | "title" | "cwd"> | null;
	steps: TrajectoryStep[];
	turns: TrajectoryTurn[];

	turnCount: number;
	totals: TrajectoryUsageTotals;
	startMs: number;
	endMs: number;

	hasErrors: boolean;
}

function entryTimestampMs(entry: SessionEntry): number {
	const parsed = Date.parse(entry.timestamp);
	return Number.isFinite(parsed) ? parsed : 0;
}

export function contentToText(content: Message["content"]): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") parts.push((block as TextContent).text);
		else if (block.type === "thinking") parts.push((block as ThinkingContent).thinking);
		else if (block.type === "image") parts.push("[image]");
	}
	return parts.filter(Boolean).join("\n\n");
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter(block => block.type === "text")
		.map(block => (block as TextContent).text)
		.join("\n");
}

function assistantThinking(message: AssistantMessage): string {
	return message.content
		.filter(block => block.type === "thinking")
		.map(block => (block as ThinkingContent).thinking)
		.join("\n");
}

function toolCallsOf(message: AssistantMessage): ToolCall[] {
	return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

export function firstLine(text: string): string {
	return (text.split("\n").find(candidate => candidate.trim().length > 0) ?? "").trim();
}

function addUsage(totals: TrajectoryUsageTotals, usage: Usage | undefined): void {
	if (!usage) return;
	totals.requests += 1;
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.totalTokens += usage.totalTokens;
	totals.costUsd += usage.cost?.total ?? 0;
	totals.reasoningTokens += usage.reasoningTokens ?? 0;
}

interface BuildState {
	steps: TrajectoryStep[];
	currentTurn: number;
	hasErrors: boolean;
}

function pushStep(state: BuildState, step: Omit<TrajectoryStep, "index" | "turn">): void {
	const index = state.steps.length + 1;
	state.steps.push({ ...step, index, turn: state.currentTurn });
}

export function buildTrajectory(
	entries: readonly SessionEntry[],
	header: Pick<SessionHeader, "id" | "title" | "cwd"> | null = null,
): Trajectory {
	const state: BuildState = { steps: [], currentTurn: 0, hasErrors: false };

	const pendingToolCalls = new Map<string, number>();

	for (const entry of entries) {
		const timestampMs = entryTimestampMs(entry);

		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "user" || message.role === "developer") {
				const isSteer = message.role === "user" && Boolean(message.steering);
				const isSynthetic = message.role === "user" && Boolean(message.synthetic);
				if (!isSteer && !isSynthetic && message.role === "user") state.currentTurn += 1;
				pushStep(state, {
					entryId: entry.id,
					source: "user",
					kind: message.role === "developer" ? "developer" : isSteer ? "steer" : isSynthetic ? "injected" : "text",
					title:
						message.role === "developer" ? "DEVELOPER" : isSteer ? "STEER" : isSynthetic ? "INJECTED" : "USER",
					timestampMs,
					isError: false,
					preview: firstLine(contentToText(message.content)),
					content: contentToText(message.content),
				});
			} else if (message.role === "assistant") {
				emitAssistant(state, pendingToolCalls, entry, message, timestampMs);
			} else if (message.role === "toolResult") {
				const resultText = contentToText(message.content);
				const pendingIndex = pendingToolCalls.get(message.toolCallId);
				if (pendingIndex !== undefined) {
					pendingToolCalls.delete(message.toolCallId);
					const step = state.steps[pendingIndex];
					step.resultText = resultText;
					step.isError = message.isError;
					step.durationMs = Math.max(0, timestampMs - step.timestampMs) || undefined;
					step.content = `${step.content}\n\n[result]\n${resultText || "(empty)"}`;
					if (message.isError) state.hasErrors = true;
				} else {
					if (message.isError) state.hasErrors = true;
					pushStep(state, {
						entryId: entry.id,
						source: "tool",
						kind: "tool_result",
						title: `${message.toolName.toUpperCase()} RESULT`,
						timestampMs,
						isError: message.isError,
						toolCallId: message.toolCallId,
						preview: firstLine(resultText),
						content: resultText,
					});
				}
			}
			continue;
		}

		switch (entry.type) {
			case "session_init":
				pushStep(state, {
					entryId: entry.id,
					source: "system",
					kind: "session_init",
					title: "SYSTEM PROMPT",
					detail: entry.agent ?? entry.modelRole,
					timestampMs,
					isError: false,
					preview: firstLine(entry.systemPrompt),
					content: entry.systemPrompt,
				});
				break;
			case "compaction":
				pushStep(state, {
					entryId: entry.id,
					source: "compaction",
					kind: "compaction",
					title: "COMPACTION",
					detail: entry.method,
					timestampMs,
					isError: false,
					preview: firstLine(entry.summary),
					content: `${entry.summary}\n\ntokens: ${entry.tokensBefore} → ${entry.tokensAfter ?? "?"}`,
				});
				break;
			case "branch_summary":
				pushStep(state, {
					entryId: entry.id,
					source: "compaction",
					kind: "branch_summary",
					title: "BRANCH SUMMARY",
					timestampMs,
					isError: false,
					preview: firstLine(entry.summary),
					content: entry.summary,
				});
				break;
			case "model_change":
				pushStep(state, {
					entryId: entry.id,
					source: "meta",
					kind: "model_change",
					title: "MODEL",
					detail: entry.role,
					timestampMs,
					isError: false,
					preview: entry.model,
					content: entry.model,
				});
				break;
			case "mode_change":
				pushStep(state, {
					entryId: entry.id,
					source: "meta",
					kind: "mode_change",
					title: "MODE",
					timestampMs,
					isError: false,
					preview: entry.mode,
					content: entry.mode,
				});
				break;
			case "custom_message":
				pushStep(state, {
					entryId: entry.id,
					source: "system",
					kind: `custom:${entry.customType}`,
					title: "CUSTOM",
					detail: entry.customType,
					timestampMs,
					isError: false,
					preview: firstLine(contentToText(entry.content)),
					content: contentToText(entry.content),
				});
				break;
			case "reset_boundary":
				pushStep(state, {
					entryId: entry.id,
					source: "meta",
					kind: "reset_boundary",
					title: "RESET",
					timestampMs,
					isError: false,
					preview: "/clear boundary — earlier context dropped from the live transcript",
					content: "/clear boundary — earlier context dropped from the live transcript",
				});
				break;
			default:
				break;
		}
	}

	return finalizeTrajectory(state, header);
}

function emitAssistant(
	state: BuildState,
	pendingToolCalls: Map<string, number>,
	entry: Extract<SessionEntry, { type: "message" }>,
	message: AssistantMessage,
	timestampMs: number,
): void {
	const text = assistantText(message);
	const thinking = assistantThinking(message);
	const calls = toolCallsOf(message);
	const model = `${message.provider}/${message.model}`;
	const isError = message.stopReason === "error";
	if (isError) state.hasErrors = true;

	const contentParts: string[] = [];
	if (text) contentParts.push(text);
	if (thinking) contentParts.push(`[thinking]\n${thinking}`);
	if (calls.length > 0) {
		contentParts.push(calls.map(call => `[tool call: ${call.name}]`).join("\n"));
	}
	pushStep(state, {
		entryId: entry.id,
		source: "assistant",
		kind: "chat",
		title: "ASSISTANT",
		detail: model,
		timestampMs,
		durationMs: message.duration,
		ttftMs: message.ttft,
		usage: message.usage,
		isError,
		text,
		stopReason: message.stopReason,
		errorText: message.errorMessage,
		preview: firstLine(text) || firstLine(calls.map(call => call.name).join(", ")),
		content: contentParts.join("\n\n"),
	});

	for (const call of calls) {
		const argPreview =
			typeof call.arguments.command === "string"
				? firstLine(String(call.arguments.command))
				: firstLine(JSON.stringify(call.arguments));
		pushStep(state, {
			entryId: entry.id,
			source: "tool",
			kind: "tool_call",
			title: call.name.toUpperCase(),
			detail: typeof call.arguments.command === "string" ? undefined : call.intent,
			timestampMs,
			isError: false,
			toolCallId: call.id,
			preview: argPreview,
			content: JSON.stringify(call.arguments, null, 2),
		});
		pendingToolCalls.set(call.id, state.steps.length - 1);
	}
}
function finalizeTrajectory(state: BuildState, header: Trajectory["header"]): Trajectory {
	const totals = emptyTrajectoryUsageTotals();
	let startMs = Number.POSITIVE_INFINITY;
	let endMs = 0;
	const turnsByIndex = new Map<number, TrajectoryTurn>();
	for (const step of state.steps) {
		addUsage(totals, step.usage);
		const closesAt = stepEndMs(step);
		if (closesAt > 0) {
			startMs = Math.min(startMs, step.timestampMs || closesAt);
			endMs = Math.max(endMs, closesAt);
		}
		if (step.turn === 0) continue;
		let turn = turnsByIndex.get(step.turn);
		if (!turn) {
			turn = {
				index: step.turn,
				startMs: step.timestampMs,
				endMs: closesAt,
				firstStepIndex: step.index,
				lastStepIndex: step.index,
				totals: emptyTrajectoryUsageTotals(),
			};
			turnsByIndex.set(step.turn, turn);
		}
		turn.endMs = Math.max(turn.endMs, closesAt);
		turn.lastStepIndex = step.index;
		addUsage(turn.totals, step.usage);
	}

	return {
		header,
		steps: state.steps,
		turns: [...turnsByIndex.values()].sort((a, b) => a.index - b.index),
		turnCount: state.currentTurn,
		totals,
		startMs: Number.isFinite(startMs) ? startMs : 0,
		endMs,
		hasErrors: state.hasErrors,
	};
}
