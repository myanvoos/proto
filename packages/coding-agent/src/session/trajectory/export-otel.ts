import { GenAIAttr, PiGenAIAttr } from "@oh-my-pi/pi-agent-core";
import type { Trajectory, TrajectoryStep } from "./model";

const SERVICE_NAME = "proto";

const SPAN_KIND_CLIENT = 3;
const SPAN_KIND_INTERNAL = 1;

const STATUS_OK = 1;
const STATUS_ERROR = 2;

export interface OtelExportOptions {
	captureContent?: boolean;

	serviceVersion?: string;
}

interface OtlpAnyValue {
	stringValue?: string;
	intValue?: string;
	doubleValue?: number;
	boolValue?: boolean;
	arrayValue?: { values: OtlpAnyValue[] };
}

interface OtlpKeyValue {
	key: string;
	value: OtlpAnyValue;
}

interface OtlpSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind: number;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	attributes: OtlpKeyValue[];
	status?: { code: number; message?: string };
}

export interface OtlpTraceDocument {
	resourceSpans: Array<{
		resource: { attributes: OtlpKeyValue[] };
		scopeSpans: Array<{ scope: { name: string; version?: string }; spans: OtlpSpan[] }>;
	}>;
}

function str(value: string): OtlpAnyValue {
	return { stringValue: value };
}

function int(value: number): OtlpAnyValue {
	return { intValue: String(Math.round(value)) };
}

function dbl(value: number): OtlpAnyValue {
	return { doubleValue: value };
}

function strArray(values: readonly string[]): OtlpAnyValue {
	return { arrayValue: { values: values.map(str) } };
}

export function trajectoryTraceId(sessionId: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(`proto-trajectory:${sessionId}`);
	return hasher.digest("hex").slice(0, 32);
}

function spanId(sessionId: string, key: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(`${sessionId}:${key}`);
	return hasher.digest("hex").slice(0, 16);
}

function msToUnixNano(ms: number): string {
	return `${BigInt(Math.round(ms)) * 1_000_000n}`;
}

function mapStopReason(reason: string | undefined): string | undefined {
	switch (reason) {
		case "stop":
			return "stop";
		case "length":
			return "length";
		case "toolUse":
			return "tool_calls";
		case "error":
		case "aborted":
			return "error";
		default:
			return undefined;
	}
}

function usageAttributes(step: TrajectoryStep): OtlpKeyValue[] {
	const usage = step.usage;
	if (!usage) return [];
	const attrs: OtlpKeyValue[] = [];

	const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	attrs.push({ key: GenAIAttr.UsageInputTokens, value: int(inputTokens) });
	attrs.push({ key: GenAIAttr.UsageOutputTokens, value: int(usage.output) });
	attrs.push({ key: PiGenAIAttr.UsageTotalTokens, value: int(usage.totalTokens || inputTokens + usage.output) });
	if (usage.cacheRead > 0) attrs.push({ key: GenAIAttr.UsageCacheReadInputTokens, value: int(usage.cacheRead) });
	if (usage.cacheWrite > 0) {
		attrs.push({ key: GenAIAttr.UsageCacheCreationInputTokens, value: int(usage.cacheWrite) });
	}
	if (usage.reasoningTokens != null) {
		attrs.push({ key: GenAIAttr.UsageReasoningOutputTokens, value: int(usage.reasoningTokens) });
	}
	if (usage.cost) {
		attrs.push({ key: PiGenAIAttr.CostEstimatedUsd, value: dbl(usage.cost.total) });
		attrs.push({
			key: PiGenAIAttr.CostInputUsd,
			value: dbl(usage.cost.input + usage.cost.cacheRead + usage.cost.cacheWrite),
		});
		attrs.push({ key: PiGenAIAttr.CostOutputUsd, value: dbl(usage.cost.output) });
	}
	return attrs;
}

export function trajectoryToOtlp(trajectory: Trajectory, options: OtelExportOptions = {}): OtlpTraceDocument {
	const captureContent = options.captureContent ?? true;
	const sessionId = trajectory.header?.id ?? "session";
	const traceId = trajectoryTraceId(sessionId);

	const resourceAttributes: OtlpKeyValue[] = [{ key: "service.name", value: str(SERVICE_NAME) }];
	if (options.serviceVersion) resourceAttributes.push({ key: "service.version", value: str(options.serviceVersion) });

	const rootStartMs = trajectory.startMs || 0;
	const rootEndMs = Math.max(trajectory.endMs, rootStartMs);
	const rootSpanId = spanId(sessionId, "root");

	const rootAttributes: OtlpKeyValue[] = [
		{ key: GenAIAttr.OperationName, value: str("invoke_agent") },
		{ key: GenAIAttr.AgentName, value: str(SERVICE_NAME) },
		{ key: GenAIAttr.ConversationId, value: str(sessionId) },
		{ key: "pi.gen_ai.agent.step_count", value: int(trajectory.turnCount) },
		{
			key: PiGenAIAttr.CostEstimatedUsd,
			value: dbl(Number(trajectory.totals.costUsd.toFixed(6))),
		},
		{ key: PiGenAIAttr.UsageTotalTokens, value: int(trajectory.totals.totalTokens) },
	];

	const spans: OtlpSpan[] = [
		{
			traceId,
			spanId: rootSpanId,
			name: `invoke_agent ${SERVICE_NAME}`,
			kind: SPAN_KIND_CLIENT,
			startTimeUnixNano: msToUnixNano(rootStartMs),
			endTimeUnixNano: msToUnixNano(rootEndMs),
			attributes: rootAttributes,
			status: { code: trajectory.hasErrors ? STATUS_ERROR : STATUS_OK },
		},
	];

	const chatSpanByEntryId = new Map<string, string>();

	for (const step of trajectory.steps) {
		if (step.kind === "chat") {
			const model = step.detail ?? SERVICE_NAME;
			const provider = model.includes("/") ? model.slice(0, model.indexOf("/")) : undefined;
			const startMs = step.timestampMs || rootStartMs;
			const endMs = Math.max(startMs + (step.durationMs ?? 0), startMs);
			const spanIdForChat = spanId(sessionId, `${step.entryId}:chat`);
			chatSpanByEntryId.set(step.entryId, spanIdForChat);

			const attributes: OtlpKeyValue[] = [
				{ key: GenAIAttr.OperationName, value: str("chat") },
				{ key: GenAIAttr.ConversationId, value: str(sessionId) },
				{ key: GenAIAttr.RequestModel, value: str(model) },
				{ key: GenAIAttr.ResponseModel, value: str(model) },
			];
			if (provider) attributes.push({ key: GenAIAttr.ProviderName, value: str(provider.toLowerCase()) });
			const finishReason = mapStopReason(step.stopReason);
			if (finishReason) {
				attributes.push({ key: GenAIAttr.ResponseFinishReasons, value: strArray([finishReason]) });
			}
			if (step.ttftMs != null) {
				attributes.push({ key: GenAIAttr.ResponseTimeToFirstChunk, value: dbl(step.ttftMs) });
			}
			attributes.push(...usageAttributes(step));
			if (captureContent && step.text) {
				attributes.push({ key: PiGenAIAttr.ResponseText, value: str(step.text) });
			}
			if (captureContent && step.thinking) {
				attributes.push({ key: PiGenAIAttr.ResponseReasoning, value: str(step.thinking) });
			}

			spans.push({
				traceId,
				spanId: spanIdForChat,
				parentSpanId: rootSpanId,
				name: `chat ${model}`,
				kind: SPAN_KIND_CLIENT,
				startTimeUnixNano: msToUnixNano(startMs),
				endTimeUnixNano: msToUnixNano(endMs),
				attributes,
				status: step.isError
					? { code: STATUS_ERROR, message: step.errorText ?? step.stopReason ?? "error" }
					: { code: STATUS_OK },
			});
			continue;
		}

		if (step.kind === "tool_call") {
			const startMs = step.timestampMs || rootStartMs;
			const endMs = Math.max(startMs + (step.durationMs ?? 0), startMs);
			const attributes: OtlpKeyValue[] = [
				{ key: GenAIAttr.OperationName, value: str("execute_tool") },
				{ key: GenAIAttr.ToolName, value: str(step.title.toLowerCase()) },
				{ key: PiGenAIAttr.ToolStatus, value: str(step.isError ? "error" : "ok") },
			];
			if (step.toolCallId) attributes.push({ key: GenAIAttr.ToolCallId, value: str(step.toolCallId) });
			if (captureContent) {
				const separator = "\n\n[result]\n";
				const splitAt = step.content.indexOf(separator);
				const argsText = splitAt === -1 ? step.content : step.content.slice(0, splitAt);
				const resultText = step.resultText;
				if (argsText.trim()) attributes.push({ key: GenAIAttr.ToolCallArguments, value: str(argsText) });
				if (resultText != null) attributes.push({ key: GenAIAttr.ToolCallResult, value: str(resultText) });
			}

			spans.push({
				traceId,
				spanId: spanId(sessionId, `${step.entryId}:${step.index}:tool`),
				parentSpanId: chatSpanByEntryId.get(step.entryId) ?? rootSpanId,
				name: `execute_tool ${step.title.toLowerCase()}`,
				kind: SPAN_KIND_INTERNAL,
				startTimeUnixNano: msToUnixNano(startMs),
				endTimeUnixNano: msToUnixNano(endMs),
				attributes,
				status: step.isError
					? { code: STATUS_ERROR, message: firstErrorLine(step.resultText) }
					: { code: STATUS_OK },
			});
		}
	}

	return {
		resourceSpans: [
			{
				resource: { attributes: resourceAttributes },
				scopeSpans: [{ scope: { name: "@oh-my-pi/pi-coding-agent/trajectory" }, spans }],
			},
		],
	};
}
function firstErrorLine(text: string | undefined): string {
	if (!text) return "tool error";
	const line = text.split("\n")[0] ?? "tool error";
	return line.slice(0, 200);
}

export function trajectoryToOtlpJson(trajectory: Trajectory, options: OtelExportOptions = {}): string {
	return JSON.stringify(trajectoryToOtlp(trajectory, options));
}
