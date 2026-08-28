/**
 * Trajectory view-model: reconstructs the session's model-visible history as a
 * flat, inspectable ledger of steps grouped into turns.
 *
 * Mirrors the DeepSeek-harness trajectory principle — "model-visible means
 * logged": every entry type that reached the model context (or shaped it)
 * surfaces as a step with source, timing, and content, so the same structure
 * feeds the interactive `/trajectory` view, the OpenTelemetry span export,
 * and the prime-rl episode export.
 *
 * Pure module: no TUI, no I/O, no session-manager dependency — callers hand in
 * entries they already hold (the interactive TUI must NOT reopen the session
 * JSONL while the live SessionManager owns the writer lock).
 */
import type { AssistantMessage, Message, TextContent, ThinkingContent, ToolCall, Usage } from "@oh-my-pi/pi-ai";
import type { SessionEntry, SessionHeader } from "../session-entries";

/** Coarse provenance of a step, rendered as the ledger badge and used for filters. */
export type TrajectorySource = "user" | "assistant" | "tool" | "compaction" | "system" | "meta";

/** Aggregated token/cost rollup across a turn or a whole trajectory. */
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
	/** 1-based position in the flat ledger. */
	index: number;
	entryId: string;
	source: TrajectorySource;
	/** Fine-grained shape: text | steer | injected | chat | tool_call | tool_result | compaction | model_change | … */
	kind: string;
	/** Provider stop reason verbatim (chat steps). */
	stopReason?: string;
	/** Provider error message when the chat ended in an error (chat steps). */
	errorText?: string;
	/** Visible assistant text without thinking/tool annotations (chat steps). */
	text?: string;
	/** Short row label, e.g. the tool name or role. */
	title: string;
	/** Secondary label, e.g. provider/model for a chat step. */
	detail?: string;
	/** Epoch milliseconds; 0 when the entry carried no usable timestamp. */
	timestampMs: number;
	/** Wall-clock duration in ms (chat request duration / paired tool execution). */
	durationMs?: number;
	/** Time to first token in ms (chat steps). */
	ttftMs?: number;
	/** Provider-reported usage (chat steps). */
	usage?: Usage;
	isError: boolean;
	/** Present on tool_call steps; pairs call ↔ result. */
	toolCallId?: string;
	/** Result payload once the matching toolResult arrived (tool_call steps). */
	resultText?: string;
	/** Single-line sanitized preview for the ledger. */
	preview: string;
	/** Full text content for the inspector. */
	content: string;
	/** Turn this step belongs to; 0 = before the first real user turn. */
	turn: number;
}

/**
 * Ledger end of a step: tool calls close when their paired result lands
 * (timestampMs + durationMs), everything else closes at its own timestamp.
 */
function stepEndMs(step: TrajectoryStep): number {
	if (step.kind === "tool_call" && step.durationMs !== undefined) return step.timestampMs + step.durationMs;
	return step.timestampMs;
}

export interface TrajectoryTurn {
	/** 1-based turn number. */
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
	/** Turn count (steps with turn === 0 sit outside any turn). */
	turnCount: number;
	totals: TrajectoryUsageTotals;
	startMs: number;
	endMs: number;
	/** True when any assistant/tool step ended in an error. */
	hasErrors: boolean;
}

function entryTimestampMs(entry: SessionEntry): number {
	const parsed = Date.parse(entry.timestamp);
	return Number.isFinite(parsed) ? parsed : 0;
}

/** Collapse a message/content-array payload to plain text (text + thinking blocks). */
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

/** First non-empty line of a text blob, trimmed for ledger display. Exported domain concept shared by the view and exporters. */
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

/**
 * Reconstruct the trajectory ledger from session entries.
 *
 * Turn boundaries: a real user message (not synthetic, not steering). All
 * following assistant/tool activity belongs to the open turn; pre-turn
 * material (session_init, early meta) lands on turn 0 ("Preamble").
 */
export function buildTrajectory(
	entries: readonly SessionEntry[],
	header: Pick<SessionHeader, "id" | "title" | "cwd"> | null = null,
): Trajectory {
	const state: BuildState = { steps: [], currentTurn: 0, hasErrors: false };
	/** toolCallId → index of the emitted tool_call step awaiting its result. Dynamic pairing state, not a static table. */
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
				// thinking_level_change, service_tier_change, label, title_change,
				// ttsr_injection, credential_pin, custom: shaping metadata, not
				// model-visible content — intentionally absent from the ledger.
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
