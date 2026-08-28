import path from "node:path";
import type {
	AgentEvent,
	AgentIdentity,
	AgentMessage,
	AgentTelemetryConfig,
	ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import { EventLoopKeepalive, recordHandoff, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import type { Api, Model, ServiceTierByFamily, Usage } from "@oh-my-pi/pi-ai";
import { logger, popLoopPhase, prompt, pushLoopPhase, untilAborted } from "@oh-my-pi/pi-utils";
import { ASYNC_JOB_MANAGER_SHUTDOWN_REASON, AsyncJobManager } from "../async";
import type { Rule } from "../capability/rule";
import { ModelRegistry } from "../config/model-registry";
import {
	formatModelSelectorValue,
	formatModelStringWithRouting,
	resolveAgentAdvisorSelection,
	resolveAgentPrewalkPattern,
	resolveConfiguredModelPatterns,
	resolveExplicitModelRole,
	resolveModelOverride,
	resolveModelOverrideWithAuthFallback,
} from "../config/model-resolver";
import type { PromptTemplate } from "../config/prompt-templates";
import { buildServiceTierByFamily, resolveSubagentServiceTier } from "../config/service-tier";
import { Settings } from "../config/settings";
import { SETTINGS_SCHEMA, type SettingPath } from "../config/settings-schema";
import type { ToolPathWithSource } from "../extensibility/custom-tools";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { runExtensionCompact, runExtensionSetModel } from "../extensibility/extensions/compact-handler";
import { getSessionSlashCommands } from "../extensibility/extensions/get-commands-handler";
import { buildSkillPromptMessage, type Skill } from "../extensibility/skills";
import type { LocalProtocolOptions } from "../internal-urls";
import type { MCPManager } from "../mcp/manager";
import { initializeExtensions } from "../modes/runtime-init";
import subagentAsyncPendingTemplate from "../prompts/system/subagent-async-pending.md" with { type: "text" };
import subagentSystemPromptTemplate from "../prompts/system/subagent-system-prompt.md" with { type: "text" };
import submitReminderTemplate from "../prompts/system/subagent-yield-reminder.md" with { type: "text" };
import { AgentLifecycleManager, type AgentReviver } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import { type CreateAgentSessionOptions, createAgentSession, discoverAuthStorage } from "../sdk";
import type { AgentSession, AgentSessionEvent, Prewalk } from "../session/agent-session";
import type { ArtifactManager } from "../session/artifacts";
import { ASYNC_RESULT_MESSAGE_TYPE } from "../session/async-job-delivery";
import type { AuthStorage } from "../session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "../session/messages";
import { SessionManager } from "../session/session-manager";
import { truncateTail } from "../session/streaming-output";

import { prewalkWouldBeNoop, resolveWorkerEffortLevel, type WorkerEffort } from "../thinking";
import type { ContextFileEntry, ToolSession } from "../tools";
import { resolveEvalBackends } from "../tools/eval-backends";
import { isIrcEnabled } from "../tools/fleet";
import { normalizeSchema } from "../tools/jtd-to-json-schema";
import { buildOutputValidator, summarizeValidationFailure } from "../tools/output-schema-validator";
import { ToolAbortError } from "../tools/tool-errors";
import type { EventBus } from "../utils/event-bus";
import { trackLateCleanup } from "../utils/late-cleanup";
import { buildNamedToolChoice } from "../utils/tool-choice";
import type { WorkspaceTree } from "../workspace-tree";
import { attributeSubagentError } from "./error-attribution";
import { generateTaskLabel } from "./label";
import { resolveAgentPrewalkDefault } from "./prewalk";
import { isReadOnlyAgent } from "./read-only-policy";
import { subprocessToolRegistry } from "./subprocess-tool-registry";
import {
	type AgentDefinition,
	type AgentProgress,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	type SingleResult,
	type StructuredSubagentOutput,
	type StructuredSubagentSchemaMode,
	type StructuredSubagentSchemaSource,
	WORKER_SUBAGENT_EVENT_CHANNEL,
	WORKER_SUBAGENT_LIFECYCLE_CHANNEL,
	WORKER_SUBAGENT_PROGRESS_CHANNEL,
	type YieldItem,
} from "./types";
import { arrayValuedLabels, assembleYieldResult } from "./yield-assembly";

export type { YieldItem } from "./types";

const MCP_CALL_TIMEOUT_MS = 60_000;
const WORKER_ABORT_CLEANUP_GRACE_MS = 10_000;

const SOFT_REQUEST_BUDGET: Record<string, number> = {
	scout: 100,
	lightbot: 100,
	default: 200,
};

export function resolveSoftRequestBudget(agentName: string, configuredBudget: number): number {
	const normalized = Math.max(0, Math.trunc(configuredBudget));
	if (normalized === 0) return 0;
	return Math.min(normalized, SOFT_REQUEST_BUDGET[agentName] ?? normalized);
}

const BUDGET_STOP_GRACE_REQUESTS = 5;

function buildBudgetNotice(requests: number, budget: number): string {
	return `[budget notice] You have used ${requests} requests in this run (soft budget: ${budget}). Wrap up now: finish the current step and yield your final report. At ${Math.ceil(budget * 1.5)} requests the run is force-stopped and you will be asked to yield whatever you have.`;
}

function formatSalvageSnippet(text: string, maxLength = 500): string {
	const flattened = text.replace(/\s+/g, " ").trim();
	return flattened.length > maxLength ? `${flattened.slice(0, maxLength - 1)}…` : flattened;
}

const agentEventTypes = new Set<AgentEvent["type"]>([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

const isAgentEvent = (event: AgentSessionEvent): event is AgentEvent =>
	agentEventTypes.has(event.type as AgentEvent["type"]);

function normalizeModelPatterns(value: string | string[] | undefined): string[] {
	if (!value) return [];
	if (Array.isArray(value)) {
		return value.map(entry => entry.trim()).filter(Boolean);
	}
	return value
		.split(",")
		.map(entry => entry.trim())
		.filter(Boolean);
}

const SUBAGENT_RETRY_FALLBACK_ROLE_PREFIX = "subagent:";

interface SubagentRetryFallbackCandidate {
	model: Model<Api>;
	selector: string;
}

function resolveSubagentRetryFallbackCandidates(
	modelPatterns: string[],
	modelRegistry: ModelRegistry,
	settings: Settings,
): SubagentRetryFallbackCandidate[] {
	const candidates: SubagentRetryFallbackCandidate[] = [];
	const seen = new Set<string>();
	const disabledProviders = new Set(settings.get("disabledProviders"));
	for (const pattern of modelPatterns) {
		const resolved = resolveModelOverride([pattern], modelRegistry, settings);
		if (!resolved.model) continue;
		if (disabledProviders.has(resolved.model.provider)) continue;
		const selector = resolved.explicitThinkingLevel
			? formatModelSelectorValue(formatModelStringWithRouting(resolved.model), resolved.thinkingLevel)
			: formatModelStringWithRouting(resolved.model);
		if (seen.has(selector)) continue;
		seen.add(selector);
		candidates.push({ model: resolved.model, selector });
	}
	return candidates;
}

function resolveSubagentInheritedRetryFallbackChain(
	settings: Settings,
	modelRegistry: ModelRegistry,
	role: string | undefined,
): string[] | undefined {
	const configuredChains = settings.get("retry.fallbackChains");

	const fallbackChain = (role !== undefined ? configuredChains?.[role] : undefined) ?? configuredChains?.default;
	if (
		!Array.isArray(fallbackChain) ||
		fallbackChain.length === 0 ||
		!fallbackChain.every(entry => typeof entry === "string")
	) {
		return undefined;
	}
	const disabledProviders = new Set(settings.get("disabledProviders"));
	return fallbackChain.filter(entry => {
		const resolved = resolveModelOverride([entry], modelRegistry, settings);
		return !resolved.model || !disabledProviders.has(resolved.model.provider);
	});
}

function installSubagentRetryFallbackChain(args: {
	settings: Settings;
	id: string;
	candidates: SubagentRetryFallbackCandidate[];
	inheritedFallbackChain: string[] | undefined;
	model: Model<Api> | undefined;
	authFallbackUsed: boolean;
}): string | undefined {
	const { settings, id, candidates, inheritedFallbackChain, model, authFallbackUsed } = args;
	if (!model || authFallbackUsed || candidates.length === 0) return undefined;

	const selectedIndex = candidates.findIndex(
		candidate => candidate.model.provider === model.provider && candidate.model.id === model.id,
	);
	if (selectedIndex < 0) return undefined;
	const fallbackSelectors = candidates.slice(selectedIndex + 1).map(candidate => candidate.selector);
	const existingFallbackChains = settings.get("retry.fallbackChains");

	const fallbackChain = fallbackSelectors.length > 0 ? fallbackSelectors : inheritedFallbackChain;
	if (
		!Array.isArray(fallbackChain) ||
		fallbackChain.length === 0 ||
		!fallbackChain.every(entry => typeof entry === "string")
	) {
		return undefined;
	}

	const role = `${SUBAGENT_RETRY_FALLBACK_ROLE_PREFIX}${id}`;
	const modelRoles: Record<string, string> = {};
	const existingRoles = settings.getModelRoles();
	for (const existingRole in existingRoles) {
		const selector = existingRoles[existingRole];
		if (selector) {
			modelRoles[existingRole] = selector;
		}
	}
	modelRoles[role] = candidates[selectedIndex].selector;
	settings.override("modelRoles", modelRoles);

	const fallbackChains: Record<string, string[]> = {
		[role]: fallbackChain,
	};
	for (const existingRole in existingFallbackChains) {
		if (existingRole !== role) {
			fallbackChains[existingRole] = existingFallbackChains[existingRole];
		}
	}
	settings.override("retry.fallbackChains", fallbackChains);
	return role;
}

function renderIrcPeerRoster(selfId: string): string {
	const peers = AgentRegistry.global()
		.list()
		.filter(ref => ref.id !== selfId && ref.status !== "aborted" && ref.kind !== "advisor");
	if (peers.length === 0) return "- (no other agents)";
	const lines = peers.map(
		peer =>
			`- \`${peer.id}\` — ${peer.displayName} (${peer.kind}, ${peer.status})${peer.activity ? `: ${peer.activity}` : ""}`,
	);
	if (peers.some(peer => peer.status === "idle" || peer.status === "parked")) {
		lines.push("Idle/parked peers are not gone: messaging them wakes (or revives) them.");
	}
	return lines.join("\n");
}

function withAbortTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	signal?: AbortSignal,
	timeoutController?: AbortController,
): Promise<T> {
	if (signal?.aborted) {
		return Promise.reject(new ToolAbortError());
	}

	const { promise: wrappedPromise, resolve, reject } = Promise.withResolvers<T>();
	let settled = false;
	const timeoutId = setTimeout(() => {
		if (settled) return;
		settled = true;
		timeoutController?.abort(new DOMException(`MCP tool call timed out after ${timeoutMs}ms`, "TimeoutError"));
		reject(new Error(`MCP tool call timed out after ${timeoutMs}ms`));
	}, timeoutMs);

	const onAbort = () => {
		if (settled) return;
		settled = true;
		clearTimeout(timeoutId);
		timeoutController?.abort();
		reject(new ToolAbortError());
	};

	if (signal) {
		signal.addEventListener("abort", onAbort, { once: true });
	}

	promise.then(resolve, reject).finally(() => {
		if (signal) signal.removeEventListener("abort", onAbort);
		clearTimeout(timeoutId);
	});

	return wrappedPromise;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object") return false;
	return !Array.isArray(value);
}

export interface ExecutorOptions {
	cwd: string;

	additionalDirectories?: string[];

	getApiKey?: CreateAgentSessionOptions["getApiKey"];
	worktree?: string;
	agent: AgentDefinition;
	task: string;
	assignment?: string;

	context?: string;
	description?: string;
	index: number;
	id: string;
	parentToolCallId?: string;

	detached?: boolean;
	modelOverride?: string | string[];

	modelRole?: string;

	parentActiveModelPattern?: string;
	thinkingLevel?: ThinkingLevel;

	effort?: WorkerEffort;

	outputSchema?: unknown;

	outputSchemaMode?: StructuredSubagentSchemaMode;

	outputSchemaSource?: StructuredSubagentSchemaSource;

	outputSchemaOverridesAgent?: boolean;

	taskDepth?: number;

	maxRuntimeMs?: number;

	enableIrc?: boolean;
	enableLsp?: boolean;

	enableMCP?: boolean;

	restrictToolNames?: boolean;
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;

	invokedAt?: number;
	acquiredAt?: number;
	sessionFile?: string | null;
	persistArtifacts?: boolean;
	artifactsDir?: string;
	eventBus?: EventBus;
	contextFiles?: ContextFileEntry[];
	skills?: Skill[];
	promptTemplates?: PromptTemplate[];
	workspaceTree?: WorkspaceTree;

	rules?: Rule[];

	preloadedExtensionPaths?: string[];

	preloadedCustomToolPaths?: ToolPathWithSource[];
	mcpManager?: MCPManager;
	authStorage?: AuthStorage;
	modelRegistry?: ModelRegistry;
	settings?: Settings;

	parentServiceTier?: ServiceTierByFamily | null;

	localProtocolOptions?: LocalProtocolOptions;

	parentArtifactManager?: ArtifactManager;

	parentEvalSessionId?: string;

	parentTelemetry?: AgentTelemetryConfig;

	autoloadSkills?: Skill[];

	parentAgentId?: string;

	keepAlive?: boolean;

	onCleanupDeferred?: (completion: Promise<void>) => void;

	cleanupGraceMs?: number;
}

function parseStringifiedJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (!trimmed) return value;
	if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return value;
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

function previewOffendingData(value: unknown, maxLength = 500): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(value) ?? "null";
	} catch {
		serialized = String(value);
	}
	return serialized.length > maxLength ? `${serialized.slice(0, maxLength)}…` : serialized;
}

function tryParseJsonOutput(text: string): unknown | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

function extractCompletionData(parsed: unknown): unknown {
	if (!parsed || typeof parsed !== "object") return parsed;
	const record = parsed as Record<string, unknown>;
	if ("data" in record) {
		return record.data;
	}
	return parsed;
}

function resolveFallbackCompletion(rawOutput: string, outputSchema: unknown): { data: unknown } | null {
	const parsed = tryParseJsonOutput(rawOutput);
	if (parsed === undefined) return null;
	const candidate = parseStringifiedJson(extractCompletionData(parsed));
	if (candidate === undefined) return null;
	const { validator, error } = buildOutputValidator(outputSchema);
	if (error) return null;
	if (validator && !validator.validate(candidate).success) return null;
	return { data: candidate };
}

interface FinalizeSubprocessOutputArgs {
	rawOutput: string;
	exitCode: number;
	stderr: string;
	doneAborted: boolean;
	signalAborted: boolean;
	yieldItems?: YieldItem[];
	outputSchema: unknown;
	outputSchemaMode?: StructuredSubagentSchemaMode;
	outputSchemaSource?: StructuredSubagentSchemaSource;
	lastAssistantText?: string;
}

interface FinalizeSubprocessOutputResult {
	rawOutput: string;
	exitCode: number;
	stderr: string;
	abortedViaYield: boolean;
	hasYield: boolean;
	structuredOutput?: StructuredSubagentOutput;
}
export const SUBAGENT_WARNING_SCHEMA_OVERRIDDEN =
	"SYSTEM WARNING: Subagent exhausted schema-retry budget; result was accepted despite failing the output schema.";
export const SUBAGENT_WARNING_NULL_YIELD = "SYSTEM WARNING: Subagent called yield with null data.";
export const SUBAGENT_WARNING_MISSING_YIELD =
	"SYSTEM WARNING: Subagent exited without calling yield tool after 3 reminders.";

function buildSchemaViolationOutcome(
	failure: { message: string; missingRequired: string[] },
	data: unknown,
): { rawOutput: string; stderr: string; exitCode: number } {
	const missing = failure.missingRequired;
	const headline =
		missing.length > 0
			? `schema_violation: missing required fields: ${missing.join(", ")}`
			: `schema_violation: ${failure.message}`;
	const payload = {
		error: "schema_violation",
		message: failure.message,
		missingRequired: missing,
		data: previewOffendingData(data),
	};
	let rawOutput: string;
	try {
		rawOutput = JSON.stringify(payload, null, 2);
	} catch {
		rawOutput = `{"error":"schema_violation","message":${JSON.stringify(headline)}}`;
	}
	return { rawOutput, stderr: headline, exitCode: 1 };
}

export function finalizeSubprocessOutput(args: FinalizeSubprocessOutputArgs): FinalizeSubprocessOutputResult {
	let { rawOutput, exitCode, stderr } = args;
	const { yieldItems, doneAborted, signalAborted, outputSchema, lastAssistantText } = args;
	const mode = args.outputSchemaMode ?? "permissive";
	const source = args.outputSchemaSource ?? (outputSchema === undefined ? "none" : "session");
	const includeStructuredOutput = source !== "none";
	let structuredOutput: StructuredSubagentOutput | undefined;
	let abortedViaYield = false;
	const hasYield = Array.isArray(yieldItems) && yieldItems.length > 0;
	const hadFailureBeforeYield = exitCode !== 0 && stderr.trim().length > 0;

	if (hasYield) {
		const lastYield = yieldItems[yieldItems.length - 1];
		if (lastYield?.status === "aborted") {
			abortedViaYield = true;
			exitCode = 0;
			stderr = lastYield.error || "Subagent aborted task";
			try {
				rawOutput = JSON.stringify({ aborted: true, error: lastYield.error }, null, 2);
			} catch {
				rawOutput = `{"aborted":true,"error":"${lastYield.error || "Unknown error"}"}`;
			}
		} else {
			const assembled = assembleYieldResult(yieldItems, lastAssistantText, arrayValuedLabels(outputSchema));
			if (!assembled || assembled.missingData) {
				rawOutput = rawOutput ? `${SUBAGENT_WARNING_NULL_YIELD}\n\n${rawOutput}` : SUBAGENT_WARNING_NULL_YIELD;
			} else {
				const { validator, error: schemaError, normalized } = buildOutputValidator(outputSchema);
				const completeData = assembled.rawText ? assembled.data : parseStringifiedJson(assembled.data ?? null);
				const validation = validator?.validate(completeData);
				const failure =
					validation && !validation.success
						? summarizeValidationFailure(validation, completeData, validator?.requiredFields ?? [])
						: assembled.schemaOverridden
							? { message: SUBAGENT_WARNING_SCHEMA_OVERRIDDEN, missingRequired: [] }
							: schemaError
								? { message: `invalid output schema: ${schemaError}`, missingRequired: [] }
								: undefined;
				if (includeStructuredOutput) {
					structuredOutput =
						schemaError || normalized === undefined
							? {
									source,
									mode,
									status: "unavailable",
									data: completeData,
									error: schemaError ? `invalid output schema: ${schemaError}` : undefined,
								}
							: failure
								? { source, mode, status: "invalid", data: completeData, error: failure.message }
								: { source, mode, status: "valid", data: completeData };
				}
				const mustReject =
					failure !== undefined && (mode === "strict" || (!assembled.schemaOverridden && !schemaError));
				if (mustReject && failure) {
					const outcome = buildSchemaViolationOutcome(failure, completeData);
					rawOutput = outcome.rawOutput;
					stderr = outcome.stderr;
					exitCode = outcome.exitCode;
				} else {
					try {
						rawOutput =
							assembled.rawText && typeof completeData === "string"
								? completeData
								: (JSON.stringify(completeData, null, 2) ?? "null");
					} catch (err) {
						const errorMessage = err instanceof Error ? err.message : String(err);
						rawOutput = `{"error":"Failed to serialize yield data: ${errorMessage}"}`;
					}
					if (!hadFailureBeforeYield) {
						exitCode = 0;
						stderr = assembled.schemaOverridden
							? SUBAGENT_WARNING_SCHEMA_OVERRIDDEN
							: (structuredOutput?.error ?? "");
					} else if (!stderr) {
						stderr = "Subagent failed after yielding a result.";
					}
				}
			}
		}
	} else {
		const allowFallback = exitCode === 0 && !doneAborted && !signalAborted;
		const { normalized: normalizedSchema, error: schemaError } = normalizeSchema(outputSchema);
		const hasOutputSchema = normalizedSchema !== undefined && !schemaError;
		const fallback = allowFallback ? resolveFallbackCompletion(rawOutput, outputSchema) : null;
		if (fallback) {
			const { validator } = buildOutputValidator(outputSchema);
			const completeData = parseStringifiedJson(fallback.data ?? null);
			const result = validator?.validate(completeData) ?? { success: true as const };
			if (!result.success) {
				const summary = summarizeValidationFailure(result, completeData, validator?.requiredFields ?? []);
				if (includeStructuredOutput) {
					structuredOutput = { source, mode, status: "invalid", data: completeData, error: summary.message };
				}
				const outcome = buildSchemaViolationOutcome(summary, completeData);
				rawOutput = outcome.rawOutput;
				stderr = outcome.stderr;
				exitCode = outcome.exitCode;
			} else {
				if (includeStructuredOutput) {
					structuredOutput = {
						source,
						mode,
						status: "valid",
						data: completeData,
					};
				}
				try {
					rawOutput = JSON.stringify(completeData, null, 2) ?? "null";
				} catch (err) {
					const errorMessage = err instanceof Error ? err.message : String(err);
					rawOutput = `{"error":"Failed to serialize fallback completion: ${errorMessage}"}`;
				}
				exitCode = 0;
				stderr = "";
			}
		} else if (!hasOutputSchema && allowFallback && rawOutput.trim().length > 0) {
			exitCode = 0;
			stderr = "";
		} else if (exitCode === 0) {
			const hasRawOutput = rawOutput.trim().length > 0;
			rawOutput = rawOutput ? `${SUBAGENT_WARNING_MISSING_YIELD}\n\n${rawOutput}` : SUBAGENT_WARNING_MISSING_YIELD;
			if (hasOutputSchema || !hasRawOutput) {
				exitCode = 1;
				stderr = SUBAGENT_WARNING_MISSING_YIELD;
			}
		}
	}

	return { rawOutput, exitCode, stderr, abortedViaYield, hasYield, structuredOutput };
}

function extractToolArgsPreview(args: Record<string, unknown>): string {
	const previewKeys = ["command", "file_path", "path", "pattern", "query", "url", "task", "prompt"];

	for (const key of previewKeys) {
		if (args[key] && typeof args[key] === "string") {
			const value = args[key] as string;
			return value.length > 60 ? `${value.slice(0, 59)}…` : value;
		}
	}

	return "";
}

function getNumberField(record: Record<string, unknown>, key: string): number | undefined {
	if (!Object.hasOwn(record, key)) return undefined;
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function firstNumberField(record: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = getNumberField(record, key);
		if (value !== undefined) return value;
	}
	return undefined;
}

function getUsageTokens(usage: unknown): number {
	if (!usage || typeof usage !== "object") return 0;
	const record = usage as Record<string, unknown>;

	const input = firstNumberField(record, ["input", "input_tokens", "inputTokens"]) ?? 0;
	const output = firstNumberField(record, ["output", "output_tokens", "outputTokens"]) ?? 0;
	const cacheWrite = firstNumberField(record, ["cacheWrite", "cache_write", "cacheWriteTokens"]) ?? 0;
	const computed = input + output + cacheWrite;
	if (computed > 0) return computed;

	return firstNumberField(record, ["totalTokens", "total_tokens"]) ?? 0;
}

export function createMCPProxyTools(mcpManager: MCPManager): CustomTool[] {
	return mcpManager.getTools().map(tool => {
		const serverName = tool.mcpServerName ?? "";
		const mcpToolName = tool.mcpToolName ?? "";
		return {
			name: tool.name,
			label: tool.label ?? tool.name,
			description: tool.description ?? "",
			parameters: tool.parameters,
			strict: tool.strict,
			mcpServerName: serverName,
			mcpToolName,
			execute: async (toolCallId, params, onUpdate, ctx, signal) => {
				if (signal?.aborted) {
					throw new ToolAbortError();
				}

				const source = mcpManager
					.getTools()
					.find(t => t.mcpServerName === serverName && t.mcpToolName === mcpToolName);
				if (!source?.execute) {
					return {
						content: [{ type: "text" as const, text: `MCP error: tool ${mcpToolName} no longer available` }],
						details: { serverName, mcpToolName, isError: true },
					};
				}
				try {
					const timeoutController = new AbortController();
					const timeoutSignal = timeoutController.signal;
					const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
					return await withAbortTimeout(
						Promise.resolve(source.execute(toolCallId, params, onUpdate, ctx, combinedSignal)),
						MCP_CALL_TIMEOUT_MS,
						signal,
						timeoutController,
					);
				} catch (error) {
					if (error instanceof ToolAbortError) {
						throw error;
					}
					return {
						content: [
							{
								type: "text" as const,
								text: `MCP error: ${error instanceof Error ? error.message : String(error)}`,
							},
						],
						details: { serverName, mcpToolName, isError: true },
					};
				}
			},
		};
	});
}

export function createSubagentSettings(
	baseSettings: Settings,
	overrides?: Partial<Record<SettingPath, unknown>>,
	inheritedServiceTier?: ServiceTierByFamily | null,
): Settings {
	const snapshot: Partial<Record<SettingPath, unknown>> = {};
	for (const key of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
		snapshot[key] = baseSettings.get(key);
	}

	const inheritedTiers =
		inheritedServiceTier === undefined
			? buildServiceTierByFamily(
					baseSettings.get("tier.openai"),
					baseSettings.get("tier.anthropic"),
					baseSettings.get("tier.google"),
				)
			: (inheritedServiceTier ?? {});
	const subagentTiers = resolveSubagentServiceTier(baseSettings.get("tier.subagent"), inheritedTiers);
	snapshot["tier.openai"] = subagentTiers.openai ?? "none";
	snapshot["tier.anthropic"] = subagentTiers.anthropic ?? "none";
	snapshot["tier.google"] = subagentTiers.google ?? "none";
	return Settings.isolated(
		{
			...snapshot,

			"advisor.enabled": false,
			...overrides,
		},
		{ storage: baseSettings.getStorage() },
	);
}

export type AbortReason = "signal" | "shutdown" | "terminate" | "timeout" | "budget";

const MAX_YIELD_TOOL_ERRORS = 6;

interface RunMonitorArgs {
	index: number;
	id: string;
	agent: AgentDefinition;
	task: string;
	assignment?: string;
	description?: string;

	modelRegistry?: ModelRegistry;

	settings?: Settings;
	modelOverride?: string | string[];

	modelRole?: string;
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;
	eventBus?: EventBus;
	parentToolCallId?: string;
	detached?: boolean;
	sessionFile?: string;

	softRequestBudget: number;

	softRequestBudgetNotice: boolean;

	maxRuntimeMs: number;
}

interface SubagentRunMonitor {
	readonly progress: AgentProgress;

	readonly abortSignal: AbortSignal;
	readonly accumulatedUsage: Usage;
	hasUsage(): boolean;
	yieldCalled(): boolean;
	runtimeLimitExceeded(): boolean;

	budgetStopRequested(): boolean;

	waitForBudgetStop(): Promise<void>;

	yieldInvalidatedByAsync(): boolean;

	yieldTurnStopRequested(): boolean;

	waitForYieldTurnStop(): Promise<void>;

	abortKind(): AbortReason | undefined;
	terminalError(): string | undefined;

	hasExplicitAbortReason(): boolean;

	isAbortedRun(): boolean;
	requestAbort(reason: AbortReason): void;
	failWithError(message: string): void;
	abortActiveSession(): Promise<void>;
	waitForActiveSessionAbort(): Promise<void>;
	resolveSignalAbortReason(): string;
	resolveAbortReasonText(): string;
	setActiveSession(session: AgentSession | null): void;

	takeActiveSession(): AgentSession | null;

	attach(session: AgentSession): () => void;

	captureSalvage(session: AgentSession): void;
	lastAssistantSalvageText(): string | undefined;

	rawOutput(): string;
	scheduleProgress(flush?: boolean): void;

	finish(): void;
}

function isAsyncResultInjection(message: AgentMessage | undefined): boolean {
	return message?.role === "custom" && message.customType === ASYNC_RESULT_MESSAGE_TYPE;
}

function createSubagentRunMonitor(args: RunMonitorArgs): SubagentRunMonitor {
	const {
		index,
		id,
		agent,
		task,
		assignment,
		signal,
		onProgress,
		softRequestBudget,
		softRequestBudgetNotice,
		maxRuntimeMs,
	} = args;
	const startTime = Date.now();

	const progress: AgentProgress = {
		index,
		id,
		agent: agent.name,
		agentSource: agent.source,
		status: "running",
		task,
		assignment,
		description: args.description,
		lastIntent: undefined,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		modelOverride: args.modelOverride,
		modelRole: args.modelRole,
	};

	const outputChunks: string[] = [];
	const finalOutputChunks: string[] = [];
	const RECENT_OUTPUT_TAIL_BYTES = 8 * 1024;
	let recentOutputTail = "";
	let recentOutputDirty = false;
	let resolved = false;
	let abortSent = false;
	let abortReason: AbortReason | undefined;
	let runtimeLimitExceeded = false;
	const listenerController = new AbortController();
	const listenerSignal = listenerController.signal;
	const abortController = new AbortController();
	const abortSignal = abortController.signal;
	let activeSession: AgentSession | null = null;
	let yieldCalled = false;
	let yieldCallPending = false;
	let yieldInvalidatedByAsync = false;
	let yieldTurnStopRequested = false;
	let yieldTurnStopPromise: Promise<void> | null = null;

	const accumulatedUsage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		reasoningTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	let hasUsage = false;
	let budgetSteerSent = false;
	let budgetLimitExceeded = false;
	let budgetStopRequested = false;
	let budgetStopAbortPromise: Promise<void> | undefined;
	let terminalError: string | undefined;
	let consecutiveYieldToolErrors = 0;
	let lastAssistantSalvageText: string | undefined;
	let activeSessionAbortPromise: Promise<void> | undefined;

	const abortActiveSession = (): Promise<void> => {
		const session = activeSession;
		if (!session) return Promise.resolve();
		activeSessionAbortPromise ??= session.abort().catch(error => {
			logger.debug("Subagent session abort cleanup failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
		return activeSessionAbortPromise;
	};

	const waitForActiveSessionAbort = async (): Promise<void> => {
		if (activeSessionAbortPromise) await activeSessionAbortPromise;
	};

	const requestAbort = (reason: AbortReason) => {
		if (abortSent) {
			if (reason === "shutdown" && abortReason === "budget") {
				abortReason = "shutdown";
			} else if (
				reason === "signal" &&
				abortReason !== "signal" &&
				abortReason !== "timeout" &&
				abortReason !== "shutdown"
			) {
				abortReason = "signal";
			}
			return;
		}
		if (resolved) return;

		if (reason === "timeout") {
			runtimeLimitExceeded = true;
		}
		if (reason === "budget") {
			budgetLimitExceeded = true;
		}
		abortSent = true;
		abortReason = reason;
		abortController.abort();
		void abortActiveSession();
	};

	const requestBudgetStop = () => {
		if (budgetStopRequested || abortSent || resolved) return;
		budgetStopRequested = true;
		const session = activeSession;
		budgetStopAbortPromise = session
			? session.abort().catch(error => {
					logger.debug("Subagent budget-stop abort failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				})
			: Promise.resolve();
	};

	const failWithError = (message: string) => {
		terminalError ??= message;
		requestAbort("terminate");
	};

	const requestYieldTurnStop = () => {
		if (yieldTurnStopRequested || abortSent || resolved) return;
		yieldTurnStopRequested = true;
		const session = activeSession;
		yieldTurnStopPromise = session
			? session.abort().catch(error => {
					logger.debug("Subagent yield turn-stop abort failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				})
			: Promise.resolve();
	};

	const sessionHasPendingAsyncWork = (): boolean => activeSession?.hasPendingAsyncWork?.() ?? false;

	if (signal) {
		signal.addEventListener(
			"abort",
			() => {
				if (!resolved) requestAbort(signal.reason === ASYNC_JOB_MANAGER_SHUTDOWN_REASON ? "shutdown" : "signal");
			},
			{ once: true, signal: listenerSignal },
		);
	}

	let runtimeTimeoutId: NodeJS.Timeout | undefined;
	if (maxRuntimeMs > 0) {
		runtimeTimeoutId = setTimeout(() => {
			if (!resolved) {
				logger.warn("Subagent runtime limit exceeded; aborting", {
					id,
					agent: agent.name,
					maxRuntimeMs,
				});
				requestAbort("timeout");
			}
		}, maxRuntimeMs);
	}

	const resolveSignalAbortReason = (): string => {
		if (signal?.reason === ASYNC_JOB_MANAGER_SHUTDOWN_REASON) return "Async job manager shutdown";
		const reason = signal?.reason;
		if (reason instanceof Error) {
			const message = reason.message.trim();
			if (message.length > 0) return message;
		} else if (typeof reason === "string") {
			const message = reason.trim();
			if (message.length > 0) return message;
		}
		return "Cancelled by caller";
	};
	const resolveAbortReasonText = (): string => {
		if (runtimeLimitExceeded) {
			return `Subagent runtime limit exceeded (orchestrator.maxRuntimeMs=${maxRuntimeMs})`;
		}
		if (budgetLimitExceeded) {
			return `Soft request budget exceeded (${progress.requests} requests; budget ${softRequestBudget}) — agent did not yield when force-stopped`;
		}
		if (budgetStopRequested) {
			return `Soft request budget exceeded (${progress.requests} requests; budget ${softRequestBudget})`;
		}
		return resolveSignalAbortReason();
	};
	const PROGRESS_COALESCE_MS = 150;
	let lastProgressEmitMs = 0;
	let progressTimeoutId: NodeJS.Timeout | null = null;

	const refreshRecentOutput = () => {
		if (!recentOutputDirty) return;
		recentOutputDirty = false;
		const filtered = recentOutputTail.split("\n").filter(line => line.trim());
		progress.recentOutput = filtered.slice(-8).reverse();
	};

	const emitProgressNow = () => {
		refreshRecentOutput();
		progress.durationMs = Date.now() - startTime;
		onProgress?.({ ...progress });
		const activityGist =
			progress.lastIntent ?? (progress.currentTool ? `running ${progress.currentTool}` : undefined);
		if (activityGist) AgentRegistry.global().setActivity(id, activityGist);
		if (args.eventBus) {
			args.eventBus.emit(WORKER_SUBAGENT_PROGRESS_CHANNEL, {
				index,
				agent: agent.name,
				agentSource: agent.source,
				task,
				parentToolCallId: args.parentToolCallId,
				detached: args.detached,
				assignment,
				progress: { ...progress },
				sessionFile: args.sessionFile,
			});
		}
		lastProgressEmitMs = Date.now();
	};

	const scheduleProgress = (flush = false) => {
		if (flush) {
			if (progressTimeoutId) {
				clearTimeout(progressTimeoutId);
				progressTimeoutId = null;
			}
			emitProgressNow();
			return;
		}
		const now = Date.now();
		const elapsed = now - lastProgressEmitMs;
		if (lastProgressEmitMs === 0 || elapsed >= PROGRESS_COALESCE_MS) {
			if (progressTimeoutId) {
				clearTimeout(progressTimeoutId);
				progressTimeoutId = null;
			}
			emitProgressNow();
			return;
		}
		if (progressTimeoutId) return;
		progressTimeoutId = setTimeout(() => {
			progressTimeoutId = null;
			emitProgressNow();
		}, PROGRESS_COALESCE_MS - elapsed);
	};

	const labelSource = assignment?.trim();
	if (!args.description && args.modelRegistry && args.settings && labelSource) {
		generateTaskLabel(labelSource, args.modelRegistry, args.settings, id, abortSignal)
			.then(label => {
				if (!label || abortSignal.aborted || progress.description) return;
				progress.description = label;
				if (!resolved) scheduleProgress();
			})
			.catch(err => {
				logger.debug("Subagent label generation failed", {
					id,
					error: err instanceof Error ? err.message : String(err),
				});
			});
	}

	const getMessageContent = (message: unknown): unknown => {
		if (!isRecord(message) || !("content" in message)) {
			return undefined;
		}
		return message.content;
	};

	const getMessageUsage = (message: unknown): unknown => {
		if (!isRecord(message) || !("usage" in message)) {
			return undefined;
		}
		return message.usage;
	};

	const appendRecentOutputTail = (text: string) => {
		if (!text) return;
		recentOutputTail += text;
		if (recentOutputTail.length > RECENT_OUTPUT_TAIL_BYTES) {
			recentOutputTail = recentOutputTail.slice(-RECENT_OUTPUT_TAIL_BYTES);
		}

		recentOutputDirty = true;
	};

	const replaceRecentOutputFromContent = (content: unknown[]) => {
		recentOutputTail = "";
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const record = block as { type?: unknown; text?: unknown };
			if (record.type !== "text" || typeof record.text !== "string") continue;
			if (!record.text) continue;
			recentOutputTail += record.text;
			if (recentOutputTail.length > RECENT_OUTPUT_TAIL_BYTES) {
				recentOutputTail = recentOutputTail.slice(-RECENT_OUTPUT_TAIL_BYTES);
			}
		}
		recentOutputDirty = true;
	};

	const resetRecentOutput = () => {
		recentOutputTail = "";
		recentOutputDirty = false;
		progress.recentOutput = [];
	};

	const emitSubagentEvent = (event: AgentSessionEvent) => {
		if (!args.eventBus) return;
		args.eventBus.emit(WORKER_SUBAGENT_EVENT_CHANNEL, {
			id,
			event,
		});
	};

	const recordExtractedToolData = (toolName: string, data: unknown): void => {
		progress.extractedToolData = progress.extractedToolData || {};
		const existing = progress.extractedToolData[toolName] || [];
		existing.push(data);
		progress.extractedToolData[toolName] = existing;
		if (toolName === "yield") {
			yieldCalled = true;
			yieldCallPending = false;
			yieldInvalidatedByAsync = false;
		}
	};

	const processEvent = (event: AgentEvent) => {
		if (resolved) return;
		const now = Date.now();
		let flushProgress = false;

		switch (event.type) {
			case "message_start":
				if (event.message?.role === "assistant") {
					resetRecentOutput();
				}

				if (yieldCalled && !abortSignal.aborted && isAsyncResultInjection(event.message)) {
					yieldCalled = false;
					yieldInvalidatedByAsync = true;
				}
				break;

			case "tool_execution_start": {
				progress.toolCount++;
				progress.currentTool = event.toolName;
				let startArgs: Record<string, unknown> = {};
				if ("toolArgs" in event && isRecord(event.toolArgs)) {
					startArgs = event.toolArgs;
				} else if (isRecord(event.args)) {
					startArgs = event.args;
				}
				progress.currentToolArgs = extractToolArgsPreview(startArgs);
				progress.currentToolStartMs = now;
				const intent = event.intent?.trim();
				if (intent) {
					progress.lastIntent = intent;
				}
				if (event.toolName === "yield" && !yieldCalled) {
					yieldCallPending = true;
				}
				break;
			}

			case "tool_execution_end": {
				if (progress.currentTool) {
					progress.recentTools.unshift({
						tool: progress.currentTool,
						args: progress.currentToolArgs || "",
						endMs: now,
					});

					if (progress.recentTools.length > 5) {
						progress.recentTools.pop();
					}
				}
				progress.currentTool = undefined;
				progress.currentToolArgs = undefined;
				progress.currentToolStartMs = undefined;

				const handler = subprocessToolRegistry.getHandler(event.toolName);
				const eventRecord: unknown = event;
				const eventArgs = isRecord(eventRecord) && isRecord(eventRecord.args) ? eventRecord.args : {};
				if (handler) {
					if (handler.extractData) {
						const data = handler.extractData({
							toolName: event.toolName,
							toolCallId: event.toolCallId,
							args: eventArgs,
							result: event.result,
							isError: event.isError,
						});
						if (data !== undefined) {
							recordExtractedToolData(event.toolName, data);
						}
					}

					if (event.toolName === "yield") {
						yieldCallPending = false;
					}

					if (
						handler.shouldTerminate?.({
							toolName: event.toolName,
							toolCallId: event.toolCallId,
							args: eventArgs,
							result: event.result,
							isError: event.isError,
						})
					) {
						if (event.toolName === "yield" && sessionHasPendingAsyncWork()) {
							requestYieldTurnStop();
						} else {
							requestAbort("terminate");
						}
					}
				}
				if (event.toolName === "yield") {
					if (event.isError && !abortSent) {
						consecutiveYieldToolErrors++;
						let yieldErrorText = "";
						const resultContent = event.result?.content;
						if (Array.isArray(resultContent)) {
							const textParts: string[] = [];
							for (const block of resultContent) {
								if (
									block &&
									typeof block === "object" &&
									"type" in block &&
									block.type === "text" &&
									"text" in block &&
									typeof block.text === "string"
								) {
									textParts.push(block.text);
								}
							}
							yieldErrorText = textParts.join("\n").trim();
						}
						if (consecutiveYieldToolErrors >= MAX_YIELD_TOOL_ERRORS) {
							const suffix = yieldErrorText ? ` Last yield error: ${yieldErrorText}` : "";
							failWithError(
								`Subagent submitted invalid yield results ${consecutiveYieldToolErrors} times; stopping to avoid an infinite submit loop.${suffix}`,
							);
						}
					} else if (!event.isError) {
						consecutiveYieldToolErrors = 0;
					}
				}
				flushProgress = true;
				break;
			}

			case "tool_execution_update":
				break;

			case "message_update": {
				if (event.message?.role !== "assistant") break;
				const assistantEvent = (
					event as AgentEvent & {
						assistantMessageEvent?: { type?: string; delta?: string };
					}
				).assistantMessageEvent;
				if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
					appendRecentOutputTail(assistantEvent.delta);
					break;
				}
				if (assistantEvent && assistantEvent.type !== "text_delta") {
					break;
				}
				const updateContent =
					getMessageContent(event.message) || (event as AgentEvent & { content?: unknown }).content;
				if (updateContent && Array.isArray(updateContent)) {
					replaceRecentOutputFromContent(updateContent);
				}
				break;
			}

			case "message_end": {
				const role = event.message?.role;
				if (role === "assistant") {
					progress.requests += 1;
					const eventContent = isRecord(event) && "content" in event ? event.content : undefined;
					const messageContent = getMessageContent(event.message) || eventContent;
					if (messageContent && Array.isArray(messageContent)) {
						for (const block of messageContent) {
							if (!isRecord(block)) continue;
							if (block.type === "text" && typeof block.text === "string") {
								outputChunks.push(block.text);
								continue;
							}
							if (block.type !== "toolCall" || typeof block.name !== "string") continue;
							if (block.name === "yield" && !yieldCalled) {
								yieldCallPending = true;
								flushProgress = true;
							}
						}
					}
					if (softRequestBudget > 0 && !abortSent && !yieldCallPending) {
						const stopThreshold = softRequestBudget * 1.5;
						if (budgetStopRequested) {
							if (progress.requests >= stopThreshold + BUDGET_STOP_GRACE_REQUESTS) {
								requestAbort("budget");
							}
						} else if (progress.requests >= stopThreshold) {
							requestBudgetStop();
						} else if (softRequestBudgetNotice && !budgetSteerSent && progress.requests >= softRequestBudget) {
							budgetSteerSent = true;
							const steerSession = activeSession;
							if (steerSession) {
								const notice = buildBudgetNotice(progress.requests, softRequestBudget);
								void Promise.resolve()
									.then(() => steerSession.sendUserMessage(notice, { deliverAs: "steer" }))
									.catch(err => {
										logger.warn("Subagent budget steer failed", {
											error: err instanceof Error ? err.message : String(err),
										});
									});
							}
						}
					}
				}

				const eventUsage = isRecord(event) && "usage" in event ? event.usage : undefined;
				const messageUsage = getMessageUsage(event.message) || eventUsage;
				if (isRecord(messageUsage)) {
					if (role === "assistant") {
						const costRecord = isRecord(messageUsage.cost) ? messageUsage.cost : undefined;
						hasUsage = true;
						accumulatedUsage.input += getNumberField(messageUsage, "input") ?? 0;
						accumulatedUsage.output += getNumberField(messageUsage, "output") ?? 0;
						accumulatedUsage.cacheRead += getNumberField(messageUsage, "cacheRead") ?? 0;
						accumulatedUsage.cacheWrite += getNumberField(messageUsage, "cacheWrite") ?? 0;
						accumulatedUsage.totalTokens += getNumberField(messageUsage, "totalTokens") ?? 0;
						accumulatedUsage.reasoningTokens =
							(accumulatedUsage.reasoningTokens ?? 0) + (getNumberField(messageUsage, "reasoningTokens") ?? 0);
						if (costRecord) {
							accumulatedUsage.cost.input += getNumberField(costRecord, "input") ?? 0;
							accumulatedUsage.cost.output += getNumberField(costRecord, "output") ?? 0;
							accumulatedUsage.cost.cacheRead += getNumberField(costRecord, "cacheRead") ?? 0;
							accumulatedUsage.cost.cacheWrite += getNumberField(costRecord, "cacheWrite") ?? 0;
							accumulatedUsage.cost.total += getNumberField(costRecord, "total") ?? 0;
							progress.cost = accumulatedUsage.cost.total;
						}
					}

					progress.tokens += getUsageTokens(messageUsage);

					if (role === "assistant") {
						const perTurnTotal = getNumberField(messageUsage, "totalTokens");
						if (perTurnTotal !== undefined && perTurnTotal > 0) {
							progress.contextTokens = perTurnTotal;
						}
					}
				}
				break;
			}

			case "agent_end":
				if (event.messages && Array.isArray(event.messages)) {
					for (const msg of event.messages) {
						if ((msg as { role?: string })?.role !== "assistant") continue;
						const messageContent = getMessageContent(msg);
						if (messageContent && Array.isArray(messageContent)) {
							for (const block of messageContent) {
								if (block.type === "text" && block.text) {
									finalOutputChunks.push(block.text);
								}
							}
						}
					}
				}
				flushProgress = true;
				break;
		}

		scheduleProgress(flushProgress);
	};

	const attach = (session: AgentSession): (() => void) => {
		const publishServingModel = (): void => {
			const serving = session.servingModel;
			if (!serving) return;
			const isFallback = serving.isFallback;
			if (
				serving.selector === progress.resolvedModel &&
				(progress.resolvedModelIsFallback ?? false) === isFallback
			) {
				return;
			}
			progress.resolvedModel = serving.selector;
			progress.resolvedModelIsFallback = isFallback;
			scheduleProgress(true);
		};
		return session.subscribe(event => {
			emitSubagentEvent(event);
			publishServingModel();
			if (event.type === "auto_retry_start") {
				progress.retryState = {
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
					startedAtMs: Date.now(),
				};
				progress.retryFailure = undefined;
				scheduleProgress(true);
				return;
			}
			if (event.type === "auto_retry_end") {
				const attempt = progress.retryState?.attempt ?? event.attempt;
				progress.retryState = undefined;
				if (!event.success) {
					progress.retryFailure = {
						attempt,
						errorMessage: event.finalError ?? "Auto-retry failed",
					};
				}
				scheduleProgress(true);
				return;
			}
			if (isAgentEvent(event)) {
				pushLoopPhase(`subagent:${id}`);
				try {
					processEvent(event);
				} catch (err) {
					logger.error("Subagent event processing failed", {
						error: err instanceof Error ? err.message : String(err),
					});
					requestAbort("terminate");
				} finally {
					popLoopPhase();
				}
			}
		});
	};

	const captureSalvage = (session: AgentSession): void => {
		try {
			const lastContent = session.getLastAssistantMessage()?.content;
			if (Array.isArray(lastContent)) {
				const text = lastContent
					.map(block => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
					.filter(Boolean)
					.join("\n");
				if (text.trim()) {
					lastAssistantSalvageText = text;
				}
			}
		} catch {}
	};

	return {
		progress,
		abortSignal,
		accumulatedUsage,
		hasUsage: () => hasUsage,
		yieldCalled: () => yieldCalled,
		runtimeLimitExceeded: () => runtimeLimitExceeded,
		terminalError: () => terminalError,
		hasExplicitAbortReason: () =>
			abortReason === "signal" ||
			abortReason === "shutdown" ||
			runtimeLimitExceeded ||
			budgetLimitExceeded ||
			budgetStopRequested,
		budgetStopRequested: () => budgetStopRequested,
		waitForBudgetStop: () => budgetStopAbortPromise ?? Promise.resolve(),
		yieldInvalidatedByAsync: () => yieldInvalidatedByAsync,
		yieldTurnStopRequested: () => yieldTurnStopRequested,
		waitForYieldTurnStop: async () => {
			const pending = yieldTurnStopPromise;
			if (!pending) {
				yieldTurnStopRequested = false;
				return;
			}
			try {
				await pending;
			} finally {
				if (yieldTurnStopPromise === pending) {
					yieldTurnStopPromise = null;
					yieldTurnStopRequested = false;
				}
			}
		},

		abortKind: () => abortReason ?? (budgetStopRequested ? "budget" : undefined),
		isAbortedRun: () =>
			abortReason === "signal" ||
			abortReason === "shutdown" ||
			runtimeLimitExceeded ||
			budgetLimitExceeded ||
			abortReason === undefined,
		requestAbort,
		failWithError,
		abortActiveSession,
		waitForActiveSessionAbort,
		resolveSignalAbortReason,
		resolveAbortReasonText,
		setActiveSession: session => {
			activeSession = session;
		},
		takeActiveSession: () => {
			const session = activeSession;
			activeSession = null;
			return session;
		},
		attach,
		captureSalvage,
		lastAssistantSalvageText: () => lastAssistantSalvageText,
		rawOutput: () => (finalOutputChunks.length > 0 ? finalOutputChunks.join("") : outputChunks.join("")),
		scheduleProgress,
		finish: () => {
			resolved = true;
			listenerController.abort();
			if (runtimeTimeoutId !== undefined) {
				clearTimeout(runtimeTimeoutId);
				runtimeTimeoutId = undefined;
			}
			if (progressTimeoutId) {
				clearTimeout(progressTimeoutId);
				progressTimeoutId = null;
			}
		},
	};
}

interface DriveOutcome {
	exitCode: number;
	error?: string;
	aborted: boolean;
	abortReasonText?: string;
}

const MAX_YIELD_RETRIES = 3;

async function driveSessionToYield(
	session: AgentSession,
	monitor: SubagentRunMonitor,
	task: string,
): Promise<DriveOutcome> {
	using _keepalive = new EventLoopKeepalive();
	const abortSignal = monitor.abortSignal;
	let exitCode = 0;
	let error: string | undefined;
	let aborted = false;
	let abortReasonText: string | undefined;
	const checkAbort = () => {
		if (abortSignal.aborted) {
			aborted = monitor.isAbortedRun();
			if (aborted) {
				abortReasonText ??= monitor.resolveAbortReasonText();
			}
			exitCode = 1;
			throw new ToolAbortError();
		}
	};
	const awaitAbortable = async <T>(promise: Promise<T>): Promise<T> => {
		checkAbort();
		const { promise: abortPromise, reject } = Promise.withResolvers<never>();
		const onAbort = () => {
			try {
				checkAbort();
			} catch (err) {
				reject(err);
			}
		};
		abortSignal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([promise, abortPromise]);
		} finally {
			abortSignal.removeEventListener("abort", onAbort);
		}
	};

	try {
		try {
			await awaitAbortable(session.prompt(task, { attribution: "agent" }));
			await awaitAbortable(session.waitForIdle());
		} catch (err) {
			const recoverableStop = monitor.budgetStopRequested() || monitor.yieldTurnStopRequested();
			if (!recoverableStop || abortSignal.aborted) throw err;
		}

		const reminderToolChoice = buildNamedToolChoice("yield", session.model);

		const runYieldLadder = async (): Promise<void> => {
			let retryCount = 0;
			while (!monitor.yieldCalled() && retryCount < MAX_YIELD_RETRIES && !abortSignal.aborted) {
				const budgetStop = monitor.budgetStopRequested();
				if (budgetStop) {
					retryCount = MAX_YIELD_RETRIES - 1;
					await monitor.waitForBudgetStop();
					if (monitor.yieldCalled() || abortSignal.aborted) break;
				}

				const lastBeforeReminder = session.getLastAssistantMessage();
				if (lastBeforeReminder?.stopReason === "error") break;
				try {
					retryCount++;
					const reminder = prompt.render(submitReminderTemplate, {
						retryCount,
						maxRetries: MAX_YIELD_RETRIES,
						budgetStop,
					});

					const isFinalRetry = retryCount >= MAX_YIELD_RETRIES;
					await awaitAbortable(
						session.prompt(reminder, {
							attribution: "agent",
							synthetic: true,
							...(isFinalRetry && reminderToolChoice ? { toolChoice: reminderToolChoice } : {}),
						}),
					);
					await awaitAbortable(session.waitForIdle());
				} catch (err) {
					if (abortSignal.aborted || err instanceof ToolAbortError) {
						logger.debug("Subagent prompt aborted");
					} else {
						logger.error("Subagent prompt failed", {
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}
			}
		};

		let asyncPendingNoticeSent = false;
		while (!abortSignal.aborted) {
			if (!monitor.yieldCalled()) {
				await runYieldLadder();

				if (!monitor.yieldCalled()) break;
			}

			await awaitAbortable(monitor.waitForYieldTurnStop());
			if (!session.hasPendingAsyncWork()) break;
			if (!asyncPendingNoticeSent) {
				asyncPendingNoticeSent = true;
				const running = session.getAsyncJobSnapshot()?.running ?? [];
				if (running.length > 0) {
					const jobs = running.map(job => `${job.id}${job.label ? ` (${job.label})` : ""}`).join(", ");
					const notice = prompt.render(subagentAsyncPendingTemplate, {
						count: running.length,
						multiple: running.length > 1,
						jobs,
					});
					try {
						await awaitAbortable(session.prompt(notice, { attribution: "agent", synthetic: true }));
						await awaitAbortable(session.waitForIdle());
					} catch (err) {
						if (abortSignal.aborted || err instanceof ToolAbortError) throw err;

						logger.warn("Subagent async-pending notice failed", {
							error: err instanceof Error ? err.message : String(err),
						});
					}

					continue;
				}
			}
			await awaitAbortable(session.settleAsyncWork());
		}

		if (!monitor.yieldCalled()) {
			await awaitAbortable(session.waitForIdle());
		}

		const lastAssistant = session.getLastAssistantMessage();
		if (lastAssistant) {
			if (lastAssistant.stopReason === "aborted") {
				if (!monitor.yieldCalled() || monitor.runtimeLimitExceeded()) {
					aborted = monitor.isAbortedRun();
					if (aborted) {
						abortReasonText ??= monitor.hasExplicitAbortReason()
							? monitor.resolveAbortReasonText()
							: lastAssistant.errorMessage?.trim() || monitor.resolveAbortReasonText();
					}
					exitCode = 1;
				}
			} else if (lastAssistant.stopReason === "error") {
				exitCode = 1;
				error ??= attributeSubagentError(lastAssistant.errorMessage, lastAssistant);
			}
		}

		if (!monitor.yieldCalled() && monitor.budgetStopRequested() && !aborted) {
			aborted = true;
			abortReasonText ??= monitor.resolveAbortReasonText();
			exitCode = 1;
		}

		if (monitor.yieldInvalidatedByAsync() && !abortSignal.aborted) {
			exitCode = 1;
			error ??=
				"Background job results arrived after the subagent's last yield; it did not submit a refreshed yield covering them.";
		}
	} catch (err) {
		if (abortSignal.aborted && monitor.yieldCalled() && !monitor.runtimeLimitExceeded()) {
			exitCode = 0;
		} else {
			exitCode = 1;
			if (!abortSignal.aborted) {
				error = err instanceof Error ? err.stack || err.message : String(err);
			}
		}
	} finally {
		error ??= monitor.terminalError();
		if (abortSignal.aborted && (!monitor.yieldCalled() || monitor.runtimeLimitExceeded())) {
			aborted = monitor.isAbortedRun();
			if (aborted) {
				abortReasonText ??= monitor.resolveAbortReasonText();
			}
			if (exitCode === 0) exitCode = 1;
		}
	}

	return { exitCode, error, aborted, abortReasonText };
}

interface FinalizeRunArgs {
	monitor: SubagentRunMonitor;
	done: { exitCode: number; error?: string; aborted?: boolean; abortReason?: string; durationMs: number };
	index: number;
	id: string;
	agent: AgentDefinition;
	task: string;
	assignment?: string;
	modelOverride?: string | string[];

	modelRole?: string;
	outputSchema?: unknown;
	outputSchemaMode?: StructuredSubagentSchemaMode;
	outputSchemaSource?: StructuredSubagentSchemaSource;
	signal?: AbortSignal;
	artifactsDir?: string;
	eventBus?: EventBus;
	parentToolCallId?: string;
	detached?: boolean;
	sessionFile?: string;
	startTime: number;
}

async function finalizeRunResult(args: FinalizeRunArgs): Promise<SingleResult> {
	const { monitor, done, index, id, agent, task, assignment, signal, modelOverride, modelRole } = args;
	const progress = monitor.progress;
	let exitCode = done.exitCode;
	let stderr = done.error ?? "";

	let rawOutput = monitor.rawOutput();
	const yieldItems = progress.extractedToolData?.yield as YieldItem[] | undefined;

	pushLoopPhase(`subagent:${id}`);
	let finalized: FinalizeSubprocessOutputResult;
	try {
		finalized = finalizeSubprocessOutput({
			rawOutput,
			exitCode,
			stderr,
			doneAborted: Boolean(done.aborted),
			signalAborted: Boolean(signal?.aborted),
			yieldItems,
			outputSchema: args.outputSchema,
			outputSchemaMode: args.outputSchemaMode,
			outputSchemaSource: args.outputSchemaSource,
			lastAssistantText: monitor.lastAssistantSalvageText(),
		});
	} finally {
		popLoopPhase();
	}
	rawOutput = finalized.rawOutput;
	exitCode = finalized.exitCode;
	stderr = finalized.stderr;

	const salvageText = monitor.lastAssistantSalvageText();
	if (
		(done.aborted || signal?.aborted || monitor.runtimeLimitExceeded()) &&
		!rawOutput.trim() &&
		salvageText !== undefined
	) {
		rawOutput = `[cancelled after ${progress.requests} req, ${progress.tokens} tok — last activity: "${formatSalvageSnippet(salvageText)}"]`;
	}
	const lastYield = yieldItems?.[yieldItems.length - 1];
	const yieldAbortReason = lastYield?.status === "aborted" ? lastYield.error || "Subagent aborted task" : undefined;
	const { abortedViaYield, hasYield } = finalized;
	const { content: truncatedOutput, truncated } = truncateTail(rawOutput, {
		maxBytes: MAX_OUTPUT_BYTES,
		maxLines: MAX_OUTPUT_LINES,
	});

	let outputMeta: { lineCount: number; charCount: number } | undefined;
	let outputPath: string | undefined;
	if (args.artifactsDir) {
		outputPath = path.join(args.artifactsDir, `${id}.md`);
		try {
			await Bun.write(outputPath, rawOutput);
			outputMeta = {
				lineCount: rawOutput.split("\n").length,
				charCount: rawOutput.length,
			};
		} catch {}
	}

	const runtimeLimitExceeded = monitor.runtimeLimitExceeded();
	if (runtimeLimitExceeded && exitCode === 0) {
		exitCode = 1;
	}
	const wasAborted =
		runtimeLimitExceeded || Boolean(done.aborted) || abortedViaYield || (!hasYield && Boolean(signal?.aborted));
	const finalAbortReason = wasAborted
		? runtimeLimitExceeded
			? monitor.resolveAbortReasonText()
			: done.aborted
				? (done.abortReason ?? monitor.resolveAbortReasonText())
				: abortedViaYield
					? yieldAbortReason
					: signal?.aborted
						? monitor.resolveSignalAbortReason()
						: monitor.resolveAbortReasonText()
		: undefined;
	progress.status = wasAborted ? "aborted" : exitCode === 0 ? "completed" : "failed";
	monitor.scheduleProgress(true);

	if (args.eventBus) {
		args.eventBus.emit(WORKER_SUBAGENT_LIFECYCLE_CHANNEL, {
			id,
			agent: agent.name,
			parentToolCallId: args.parentToolCallId,
			detached: args.detached,
			agentSource: agent.source,
			description: progress.description,
			status: progress.status as "completed" | "failed" | "aborted",
			sessionFile: args.sessionFile,
			index,
		});
	}

	return {
		index,
		id,
		agent: agent.name,
		agentSource: agent.source,
		task,
		assignment,
		description: progress.description,
		lastIntent: progress.lastIntent,
		exitCode,
		output: truncatedOutput,
		stderr,
		truncated: Boolean(truncated),
		...(finalized.structuredOutput ? { structuredOutput: finalized.structuredOutput } : {}),
		durationMs: Date.now() - args.startTime,
		tokens: progress.tokens,
		requests: progress.requests,
		contextTokens: progress.contextTokens,
		contextWindow: progress.contextWindow,
		modelOverride,
		modelRole,
		resolvedModel: progress.resolvedModel,
		resolvedModelIsFallback: progress.resolvedModelIsFallback,
		error: exitCode !== 0 && stderr ? stderr : undefined,
		aborted: wasAborted,
		abortReason: finalAbortReason,
		usage: monitor.hasUsage() ? monitor.accumulatedUsage : undefined,
		outputPath,
		extractedToolData: progress.extractedToolData,
		retryFailure: progress.retryFailure,
		outputMeta,
	};
}

interface IrcWakeTurnMonitorOptions {
	id: string;
	index?: number;
	agent: AgentDefinition;
	description?: string;
	modelOverride?: string | string[];

	modelRole?: string;
	eventBus?: EventBus;
	parentToolCallId?: string;

	sessionFile?: string;
	maxRuntimeMs?: number;
	outputSchema?: unknown;
	outputSchemaMode?: StructuredSubagentSchemaMode;
	outputSchemaSource?: StructuredSubagentSchemaSource;
	artifactsDir?: string;
}

export function attachIrcWakeTurnMonitor(session: AgentSession, options: IrcWakeTurnMonitorOptions): void {
	const { id, agent } = options;
	const index = options.index ?? 0;
	const maxRuntimeMs = options.maxRuntimeMs ?? 0;
	session.setIrcWakeTurnObserver(records => {
		const ircTask =
			records
				.map(record => {
					const body =
						record.details && typeof record.details === "object"
							? Reflect.get(record.details, "message")
							: undefined;
					return typeof body === "string" ? body : record.content;
				})
				.filter(Boolean)
				.join("\n\n") || "IRC follow-up";
		const turnStartTime = Date.now();
		const sessionFile = AgentRegistry.global().get(id)?.sessionFile ?? options.sessionFile ?? undefined;
		const turnMonitor = createSubagentRunMonitor({
			index,
			id,
			agent,
			task: ircTask,
			description: options.description,
			modelOverride: options.modelOverride,
			modelRole: options.modelRole,
			eventBus: options.eventBus,
			parentToolCallId: options.parentToolCallId,
			detached: true,
			sessionFile,
			softRequestBudget: 0,
			softRequestBudgetNotice: false,
			maxRuntimeMs,
		});

		if (options.eventBus) {
			options.eventBus.emit(WORKER_SUBAGENT_LIFECYCLE_CHANNEL, {
				id,
				agent: agent.name,
				parentToolCallId: options.parentToolCallId,
				detached: true,
				agentSource: agent.source,
				description: options.description,
				status: "started",
				sessionFile,
				index,
			});
		}

		turnMonitor.setActiveSession(session);
		const unsubscribeTurn = turnMonitor.attach(session);
		return async turnError => {
			unsubscribeTurn();
			const activeSession = turnMonitor.takeActiveSession();
			if (activeSession) turnMonitor.captureSalvage(activeSession);
			const lastAssistant = session.getLastAssistantMessage();
			const yielded = turnMonitor.yieldCalled();
			const runtimeLimitExceeded = turnMonitor.runtimeLimitExceeded();
			const aborted = runtimeLimitExceeded || (lastAssistant?.stopReason === "aborted" && !yielded);
			const error =
				lastAssistant?.stopReason === "error"
					? attributeSubagentError(lastAssistant.errorMessage, lastAssistant)
					: turnError !== undefined && !yielded
						? turnError instanceof Error
							? turnError.stack || turnError.message
							: String(turnError)
						: undefined;
			turnMonitor.finish();
			try {
				await finalizeRunResult({
					monitor: turnMonitor,
					done: {
						exitCode: aborted || error ? 1 : 0,
						error,
						aborted,
						abortReason: aborted ? turnMonitor.resolveAbortReasonText() : undefined,
						durationMs: Date.now() - turnStartTime,
					},
					index,
					id,
					agent,
					task: ircTask,
					modelOverride: options.modelOverride,
					modelRole: options.modelRole,
					outputSchema: options.outputSchema,
					outputSchemaMode: options.outputSchemaMode,
					outputSchemaSource: options.outputSchemaSource,
					artifactsDir: options.artifactsDir,
					eventBus: options.eventBus,
					parentToolCallId: options.parentToolCallId,
					detached: true,
					sessionFile,
					startTime: turnStartTime,
				});
			} catch (finalizeError) {
				logger.warn("IRC subagent turn finalization failed", {
					id,
					error: finalizeError instanceof Error ? finalizeError.message : String(finalizeError),
				});
			}
		};
	});
}

export async function finalizeSubagentLifecycle(args: {
	id: string;
	session: AgentSession;
	aborted: boolean;

	abortKind?: AbortReason;
	keepAlive: boolean;
	isolated: boolean;
	agentIdleTtlMs: number;
	reviveSession: AgentReviver | null;
	cleanupDeadlineAt?: number;
	onCleanupDeferred?: (completion: Promise<void>) => void;
}): Promise<void> {
	const registry = AgentRegistry.global();
	const ref = registry.get(args.id);
	const ownsRef = Boolean(ref && ref.session === args.session);
	const cleanupDeadlineAt = args.cleanupDeadlineAt ?? Date.now() + 5000;
	const disposeSession = async (): Promise<void> => {
		const disposal = args.session.dispose();
		const remainingMs = Math.max(0, cleanupDeadlineAt - Date.now());
		try {
			await untilAborted(AbortSignal.timeout(remainingMs), () => disposal);
		} catch (error) {
			if (Date.now() >= cleanupDeadlineAt) {
				args.onCleanupDeferred?.(disposal);
				return;
			}
			logger.warn("Subagent session cleanup failed", {
				id: args.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};

	const resumableAbort =
		args.abortKind === "budget" && args.keepAlive && !args.isolated && args.reviveSession !== null;
	if (args.aborted && !resumableAbort) {
		if (ref && ownsRef) {
			if (args.abortKind === "shutdown") {
				try {
					await AgentLifecycleManager.global().release(args.id, ref);
				} catch (error) {
					logger.warn("runSubagent: failed to release session during manager shutdown", {
						id: args.id,
						error: String(error),
					});
					await disposeSession();
					registry.unregister(args.id, ref);
				}
			} else {
				try {
					await AgentLifecycleManager.global().release(args.id, ref, { tombstone: true });
				} catch (error) {
					logger.warn("runSubagent: failed to persist kill tombstone", { id: args.id, error: String(error) });
					registry.setStatus(args.id, "aborted", ref);
					registry.detachSession(args.id, ref);
					await disposeSession();
				}
			}
		} else {
			await disposeSession();
		}
		return;
	}

	if (!args.keepAlive) {
		await disposeSession();
		if (ref && ownsRef) registry.unregister(args.id, ref);
		return;
	}

	if (args.isolated) {
		if (ref && ownsRef) registry.setStatus(args.id, "parked", ref);
		await disposeSession();
		if (ref && ownsRef) registry.detachSession(args.id, ref);
		return;
	}

	if (!ref || !ownsRef || !registry.setStatus(args.id, "idle", ref)) {
		await disposeSession();
		return;
	}
	AgentLifecycleManager.global().adopt(
		args.id,
		{
			idleTtlMs: args.agentIdleTtlMs,
			revive: args.reviveSession ?? undefined,
		},
		ref,
	);
}

interface FollowUpTurnOptions {
	id: string;

	agent: AgentDefinition;

	message: string;
	index?: number;
	description?: string;

	modelRole?: string;

	outputSchema?: unknown;
	outputSchemaMode?: StructuredSubagentSchemaMode;
	outputSchemaSource?: StructuredSubagentSchemaSource;
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;
	eventBus?: EventBus;
	parentToolCallId?: string;

	artifactsDir?: string;

	maxRuntimeMs?: number;
}

export async function runSubagentFollowUpTurn(options: FollowUpTurnOptions): Promise<SingleResult> {
	const { id, agent, message, signal } = options;
	const index = options.index ?? 0;
	const startTime = Date.now();
	const session = await AgentLifecycleManager.global().ensureLive(id);
	const ref = AgentRegistry.global().get(id);
	const sessionFile = ref?.sessionFile ?? undefined;

	const monitor = createSubagentRunMonitor({
		index,
		id,
		agent,
		task: message,
		description: options.description,
		modelRole: options.modelRole,
		signal,
		onProgress: options.onProgress,
		eventBus: options.eventBus,
		parentToolCallId: options.parentToolCallId,
		detached: true,
		sessionFile,
		softRequestBudget: 0,
		softRequestBudgetNotice: false,
		maxRuntimeMs: options.maxRuntimeMs ?? 0,
	});

	if (options.eventBus) {
		options.eventBus.emit(WORKER_SUBAGENT_LIFECYCLE_CHANNEL, {
			id,
			agent: agent.name,
			parentToolCallId: options.parentToolCallId,
			detached: true,
			agentSource: agent.source,
			description: options.description,
			status: "started",
			sessionFile,
			index,
		});
	}

	monitor.setActiveSession(session);
	const unsubscribe = monitor.attach(session);
	let outcome: DriveOutcome;
	try {
		outcome = await driveSessionToYield(session, monitor, message);
	} finally {
		try {
			await untilAborted(AbortSignal.timeout(5000), () => monitor.waitForActiveSessionAbort());
		} catch {}
		unsubscribe();
		const active = monitor.takeActiveSession();
		if (active) monitor.captureSalvage(active);
		monitor.finish();
	}

	return finalizeRunResult({
		monitor,
		done: { ...outcome, abortReason: outcome.abortReasonText, durationMs: Date.now() - startTime },
		index,
		id,
		agent,
		task: message,
		modelRole: options.modelRole,
		outputSchema: options.outputSchema,
		outputSchemaMode: options.outputSchemaMode,
		outputSchemaSource: options.outputSchemaSource,
		signal,
		artifactsDir: options.artifactsDir,
		eventBus: options.eventBus,
		parentToolCallId: options.parentToolCallId,
		detached: true,
		sessionFile,
		startTime,
	});
}

export async function runSubprocess(options: ExecutorOptions): Promise<SingleResult> {
	const {
		cwd,
		agent,
		task,
		assignment,
		index,
		id,
		worktree,
		modelOverride,
		modelRole,
		thinkingLevel,
		outputSchema,
		enableLsp,
		signal,
		onProgress,
	} = options;
	const cleanupGraceMs = options.cleanupGraceMs ?? WORKER_ABORT_CLEANUP_GRACE_MS;
	const startTime = Date.now();

	let firstChatDispatchAt: number | undefined;

	if (signal?.aborted) {
		return {
			index,
			id,
			agent: agent.name,
			agentSource: agent.source,
			task,
			assignment,
			description: options.description,
			exitCode: 1,
			output: "",
			stderr: "Cancelled before start",
			truncated: false,
			durationMs: 0,
			tokens: 0,
			requests: 0,
			modelOverride,
			modelRole,
			error: "Cancelled before start",
			aborted: true,
			abortReason: "Cancelled before start",
		};
	}

	let subtaskSessionFile: string | undefined;
	if (options.artifactsDir) {
		subtaskSessionFile = path.join(options.artifactsDir, `${id}.jsonl`);
	}

	const settings = options.settings ?? Settings.isolated();

	const advisorSelection = resolveAgentAdvisorSelection({
		settingsOverride: settings.get("orchestrator.agentAdvisor")[agent.name],
		agentAdvisor: agent.advisor,
	});
	const subagentSettings = createSubagentSettings(
		settings,
		{
			...(agent.readSummarize === false ? { "read.summarize.enabled": false } : undefined),

			...(worktree !== undefined ? { "workspace.additionalDirectories": [] } : undefined),
			...(advisorSelection ? { "advisor.enabled": true } : undefined),
			...(advisorSelection?.model
				? { modelRoles: { ...settings.getModelRoles(), advisor: advisorSelection.model } }
				: undefined),
		},
		options.parentServiceTier,
	);
	const maxRecursionDepth = settings.get("orchestrator.maxRecursionDepth") ?? 2;
	const maxRuntimeMs = Math.max(
		0,
		Math.trunc(Number(options.maxRuntimeMs ?? settings.get("orchestrator.maxRuntimeMs") ?? 0) || 0),
	);

	const agentIdleTtlMs = Math.trunc(Number(settings.get("orchestrator.agentIdleTtlMs") ?? 420_000) || 0);
	const configuredDefaultBudget = Math.max(
		0,
		Math.trunc(Number(settings.get("orchestrator.softRequestBudget") ?? SOFT_REQUEST_BUDGET.default) || 0),
	);
	const softRequestBudget = resolveSoftRequestBudget(agent.name, configuredDefaultBudget);
	const softRequestBudgetNotice = settings.get("orchestrator.softRequestBudgetNotice") ?? false;
	const parentDepth = options.taskDepth ?? 0;
	const childDepth = parentDepth + 1;
	const atMaxDepth = maxRecursionDepth >= 0 && childDepth > maxRecursionDepth;
	const ircEnabled = options.enableIrc !== false && isIrcEnabled(subagentSettings, childDepth);

	const orchestrationTools = [
		"orchestrate_spawn",
		"orchestrate_send",
		"orchestrate_wait",
		"orchestrate_kill",
		"orchestrate_list",
	];
	let toolNames: string[] | undefined;
	if (agent.tools && agent.tools.length > 0) {
		toolNames = agent.tools;
		if (agent.spawns !== undefined && !atMaxDepth) {
			toolNames = [...new Set([...toolNames, ...orchestrationTools])];
		}
	}

	if (atMaxDepth && toolNames) {
		toolNames = toolNames.filter(name => !orchestrationTools.includes(name));
	}

	if (toolNames && !options.restrictToolNames && !toolNames.includes("fleet")) {
		toolNames = [...toolNames, "fleet"];
	}
	if (toolNames?.includes("exec")) {
		const backends = resolveEvalBackends({ settings } as ToolSession);
		const expanded = toolNames.filter(name => name !== "exec");
		if (backends.python || backends.js || backends.ruby || backends.julia) expanded.push("eval");
		expanded.push("bash");
		toolNames = Array.from(new Set(expanded));
	}

	const modelPatterns = normalizeModelPatterns(modelOverride ?? agent.model);
	const sessionFile = subtaskSessionFile ?? null;
	const spawnsEnv = atMaxDepth
		? ""
		: agent.spawns === undefined
			? ""
			: agent.spawns === "*"
				? "*"
				: agent.spawns.join(",");

	const lspEnabled = enableLsp ?? true;
	const skipPythonPreflight = Array.isArray(toolNames) && !toolNames.includes("eval");

	const monitor = createSubagentRunMonitor({
		index,
		id,
		agent,
		task,
		assignment,
		description: options.description,
		modelRegistry: options.modelRegistry,
		settings,
		modelOverride,
		modelRole,
		signal,
		onProgress,
		eventBus: options.eventBus,
		parentToolCallId: options.parentToolCallId,
		detached: options.detached,
		sessionFile: subtaskSessionFile,
		softRequestBudget,
		softRequestBudgetNotice,
		maxRuntimeMs,
	});
	const progress = monitor.progress;
	let unsubscribe: (() => void) | null = null;
	let reviveSession: AgentReviver | null = null;
	const installIrcWakeTurnMonitor = (target: AgentSession): void => {
		attachIrcWakeTurnMonitor(target, {
			id,
			index,
			agent,
			description: options.description,
			modelOverride,
			modelRole,
			eventBus: options.eventBus,
			parentToolCallId: options.parentToolCallId,
			sessionFile: subtaskSessionFile,
			maxRuntimeMs,
			outputSchema,
			outputSchemaMode: options.outputSchemaMode,
			outputSchemaSource: options.outputSchemaSource,
			artifactsDir: options.artifactsDir,
		});
	};

	const runSubagent = async (): Promise<{
		exitCode: number;
		error?: string;
		aborted?: boolean;
		abortReason?: string;
		durationMs: number;
	}> => {
		const sessionAbortController = new AbortController();
		const abortSignal = monitor.abortSignal;
		let exitCode = 0;
		let error: string | undefined;
		let aborted = false;
		let abortReasonText: string | undefined;
		const checkAbort = () => {
			if (abortSignal.aborted) {
				throw new ToolAbortError();
			}
		};
		const awaitAbortable = async <T>(promise: Promise<T>): Promise<T> => {
			checkAbort();
			const { promise: abortPromise, reject } = Promise.withResolvers<never>();
			const onAbort = () => {
				try {
					checkAbort();
				} catch (err) {
					reject(err);
				}
			};
			abortSignal.addEventListener("abort", onAbort, { once: true });
			try {
				return await Promise.race([promise, abortPromise]);
			} finally {
				abortSignal.removeEventListener("abort", onAbort);
			}
		};

		const perfStart = performance.now();
		let resolvedAt: number | undefined;
		let sessionOpenedAt: number | undefined;
		let sessionCreatedAt: number | undefined;
		let readyAt: number | undefined;

		try {
			checkAbort();

			const registryFromParent = options.modelRegistry !== undefined;
			const modelRegistry =
				options.modelRegistry ??
				new ModelRegistry(options.authStorage ?? (await awaitAbortable(discoverAuthStorage())));
			const authStorage = modelRegistry.authStorage;
			if (options.authStorage && options.authStorage !== authStorage) {
				throw new Error(
					"options.authStorage and options.modelRegistry.authStorage must be the same instance when both are provided",
				);
			}
			checkAbort();
			if (!registryFromParent) {
				modelRegistry.refreshInBackground();
			} else {
				logger.debug("runSubagent: reusing parent modelRegistry; skipping refresh");
			}
			checkAbort();

			const configuredModelPatterns = resolveConfiguredModelPatterns(modelPatterns, settings);
			const inheritedRetryFallbackChain =
				configuredModelPatterns.length === 1
					? resolveSubagentInheritedRetryFallbackChain(
							subagentSettings,
							modelRegistry,
							modelRole ?? resolveExplicitModelRole(modelPatterns, subagentSettings),
						)
					: undefined;
			const {
				model,
				thinkingLevel: resolvedThinkingLevel,
				explicitThinkingLevel,
				authFallbackUsed,
				warning: modelResolutionWarning,
			} = await awaitAbortable(
				resolveModelOverrideWithAuthFallback(
					modelPatterns,
					options.parentActiveModelPattern,
					modelRegistry,
					settings,
					id,
				),
			);
			if (modelResolutionWarning) {
				logger.warn("Subagent model resolution warning", {
					warning: modelResolutionWarning,
					requested: modelPatterns,
				});
			}
			if (authFallbackUsed && model) {
				logger.warn("Subagent model has no working credentials; falling back to parent session model", {
					requested: modelPatterns,
					parentModel: options.parentActiveModelPattern,
					resolvedProvider: model.provider,
					resolvedModel: model.id,
				});
			}
			const retryFallbackRole = installSubagentRetryFallbackChain({
				settings: subagentSettings,
				id,
				candidates: resolveSubagentRetryFallbackCandidates(modelPatterns, modelRegistry, subagentSettings),
				inheritedFallbackChain: inheritedRetryFallbackChain,
				model,
				authFallbackUsed,
			});
			if (retryFallbackRole) {
				logger.debug("Configured subagent runtime model fallback chain", {
					role: retryFallbackRole,
					requested: modelPatterns,
				});
			}
			if (model?.contextWindow && model.contextWindow > 0) {
				progress.contextWindow = model.contextWindow;
			}

			const spawnEffortCeiling = options.effort !== undefined ? settings.get("orchestrator.maxEffort") : undefined;
			const effortLevel =
				options.effort !== undefined
					? resolveWorkerEffortLevel(model, options.effort, spawnEffortCeiling)
					: undefined;
			if (model) {
				const displayLevel = effortLevel ?? (explicitThinkingLevel ? resolvedThinkingLevel : undefined);
				progress.resolvedModel =
					displayLevel !== undefined
						? formatModelSelectorValue(formatModelStringWithRouting(model), displayLevel)
						: formatModelStringWithRouting(model);
			}

			const effectiveThinkingLevel =
				effortLevel ?? (explicitThinkingLevel ? resolvedThinkingLevel : (thinkingLevel ?? resolvedThinkingLevel));
			resolvedAt = performance.now();
			const effectiveCwd = worktree ?? cwd;
			const sessionManagerPromise = sessionFile
				? SessionManager.open(sessionFile, undefined, undefined, {
						initialCwd: effectiveCwd,
						suppressBreadcrumb: true,
					})
				: Promise.resolve(SessionManager.inMemory(effectiveCwd));

			sessionManagerPromise.catch(() => {});

			let prewalk: Prewalk | undefined;
			const prewalkPattern = resolveAgentPrewalkPattern({
				settingsOverride: settings.get("orchestrator.agentPrewalk")[agent.name],
				agentPrewalk: resolveAgentPrewalkDefault(agent, settings.get("orchestrator.prewalk")),
			});
			if (prewalkPattern) {
				await awaitAbortable(modelRegistry.awaitBackgroundRefresh());
				const resolvedPrewalk = resolveModelOverride([prewalkPattern], modelRegistry, settings);
				const target = resolvedPrewalk.model;
				if (!target || !modelRegistry.hasConfiguredAuth(target)) {
					logger.warn("Subagent prewalk target unavailable; skipping prewalk", {
						agent: agent.name,
						pattern: prewalkPattern,
						warning: resolvedPrewalk.warning,
					});
				} else if (prewalkWouldBeNoop(model, effectiveThinkingLevel, target, resolvedPrewalk.thinkingLevel)) {
					logger.debug("Subagent prewalk target matches starting model and thinking level; skipping prewalk", {
						agent: agent.name,
						pattern: prewalkPattern,
					});
				} else {
					prewalk = { target, thinkingLevel: resolvedPrewalk.thinkingLevel };
				}
			}

			const restrictToolNames = options.restrictToolNames === true;
			const enableMCP = !restrictToolNames && (options.enableMCP ?? true);
			const mcpManager = enableMCP ? options.mcpManager : undefined;
			const mcpProxyTools = mcpManager ? createMCPProxyTools(mcpManager) : [];

			const subagentAgentIdentity: AgentIdentity | undefined = options.parentTelemetry
				? {
						id,
						name: agent.name,
						description: agent.description,
					}
				: undefined;
			const subagentTelemetry: AgentTelemetryConfig | undefined =
				options.parentTelemetry && subagentAgentIdentity
					? {
							...options.parentTelemetry,
							agent: subagentAgentIdentity,

							conversationId: undefined,
						}
					: undefined;

			if (options.parentTelemetry && subagentAgentIdentity) {
				const parentTelemetryHandle = resolveTelemetry(
					options.parentTelemetry,
					options.parentTelemetry.conversationId,
				);
				recordHandoff(parentTelemetryHandle, {
					fromAgent: options.parentTelemetry.agent,
					toAgent: subagentAgentIdentity,
				});
			}

			const { normalized: normalizedOutputSchema } = normalizeSchema(outputSchema);

			const buildSubagentSessionOptions = (
				sessionManagerForRun: SessionManager,
				expectedAgentRef: CreateAgentSessionOptions["expectedAgentRef"],
			): CreateAgentSessionOptions => ({
				cwd: worktree ?? cwd,
				additionalDirectories: worktree !== undefined ? undefined : options.additionalDirectories,
				authStorage,
				modelRegistry,
				getApiKey: options.getApiKey,
				settings: subagentSettings,
				model,
				modelPattern: model || modelOverride === undefined ? undefined : modelPatterns,
				modelPatternAuthFallback:
					model || modelOverride === undefined ? undefined : options.parentActiveModelPattern,
				modelPatternFallbackRole:
					model || modelOverride === undefined ? undefined : `${SUBAGENT_RETRY_FALLBACK_ROLE_PREFIX}${id}`,
				modelPatternDefaultFallbackChain:
					model || modelOverride === undefined ? undefined : inheritedRetryFallbackChain,
				thinkingLevel: effectiveThinkingLevel,
				thinkingLevelCeiling: spawnEffortCeiling,
				toolNames,
				outputSchema,
				outputSchemaMode: options.outputSchemaMode,
				restrictToolNames: options.restrictToolNames,
				requireYieldTool: true,
				contextFiles: options.contextFiles,
				skills: options.skills,
				promptTemplates: options.promptTemplates,
				workspaceTree: options.workspaceTree,
				rules: options.rules,
				preloadedExtensionPaths: restrictToolNames ? [] : options.preloadedExtensionPaths,
				preloadedCustomToolPaths: restrictToolNames ? [] : options.preloadedCustomToolPaths,
				systemPrompt: defaultPrompt => {
					const subagentPrompt = prompt.render(subagentSystemPromptTemplate, {
						agent: agent.systemPrompt,
						context: options.context?.trim() ?? "",
						worktree: worktree ?? "",
						outputSchema: normalizedOutputSchema,
						outputSchemaOverridesAgent: options.outputSchemaOverridesAgent === true,
						ircPeers: ircEnabled ? renderIrcPeerRoster(id) : "",
						ircSelfId: ircEnabled ? id : "",
					});
					return defaultPrompt.length === 0
						? [subagentPrompt]
						: [...defaultPrompt.slice(0, -1), subagentPrompt, defaultPrompt[defaultPrompt.length - 1]];
				},
				sessionManager: sessionManagerForRun,
				hasUI: false,
				prewalk,
				spawns: spawnsEnv,
				taskDepth: childDepth,
				parentTaskPrefix: id,
				parentAgentId: options.parentAgentId,
				agentId: id,
				agentDisplayName: agent.name,
				expectedAgentRef,
				enableLsp: lspEnabled,
				enableIrc: options.enableIrc,
				skipPythonPreflight,
				enableMCP,
				mcpManager,
				customTools: mcpProxyTools.length > 0 ? mcpProxyTools : undefined,
				localProtocolOptions: options.localProtocolOptions,
				telemetry: subagentTelemetry,
				parentEvalSessionId: options.parentEvalSessionId,
				onFirstChatDispatch: () => {
					firstChatDispatchAt ??= performance.now();
				},
			});

			const sessionManager = await awaitAbortable(sessionManagerPromise);
			if (options.parentArtifactManager) {
				sessionManager.adoptArtifactManager(options.parentArtifactManager);
			}
			sessionOpenedAt = performance.now();

			const sessionPromise = createAgentSession(buildSubagentSessionOptions(sessionManager, null));
			let session: AgentSession;
			try {
				({ session } = await awaitAbortable(sessionPromise));
			} catch (err) {
				void sessionPromise.then(created => created.session.dispose()).catch(() => {});
				throw err;
			}
			sessionCreatedAt = performance.now();

			monitor.setActiveSession(session);

			AgentRegistry.global().syncSessionStatus(id, session);
			if (sessionFile !== null && worktree === undefined) {
				reviveSession = async expectedAgentRef => {
					const reopened = await SessionManager.open(sessionFile, undefined, undefined, {
						suppressBreadcrumb: true,
					});
					if (options.parentArtifactManager) {
						reopened.adoptArtifactManager(options.parentArtifactManager);
					}
					const { session: revived } = await createAgentSession(
						buildSubagentSessionOptions(reopened, expectedAgentRef),
					);

					await initializeExtensions(revived, {
						reportSendError: (action, err) =>
							logger.error("Extension send failed", { action, error: err.message }),
						reportRuntimeError: err =>
							logger.error("Extension error", { path: err.extensionPath, error: err.error }),
					});
					AgentRegistry.global().syncSessionStatus(id, revived);
					installIrcWakeTurnMonitor(revived);
					return revived;
				};
			}

			if (options.eventBus) {
				options.eventBus.emit(WORKER_SUBAGENT_LIFECYCLE_CHANNEL, {
					id,
					agent: agent.name,
					parentToolCallId: options.parentToolCallId,
					detached: options.detached,
					agentSource: agent.source,
					description: options.description,
					status: "started",
					sessionFile: subtaskSessionFile,
					index,
				});
			}

			const isParentOwnedTool = (name: string): boolean => !prewalk && name === "todo";
			const subagentToolNames = session.getEnabledToolNames();
			const filteredSubagentTools = subagentToolNames.filter(name => !isParentOwnedTool(name));
			if (filteredSubagentTools.length !== subagentToolNames.length) {
				await awaitAbortable(session.setActiveToolsByName(filteredSubagentTools));
			}

			session.sessionManager.appendSessionInit({
				systemPrompt: session.agent.state.systemPrompt.join("\n\n"),
				task,
				tools: session.getEnabledToolNames(),
				agent: agent.name,
				modelRole: modelRole ?? resolveExplicitModelRole(modelOverride ?? agent.model, subagentSettings),
				resolvedModel: progress.resolvedModel,
				readOnly: isReadOnlyAgent(agent),
				spawns: spawnsEnv,
				readSummarize: agent.readSummarize,
				advisor: advisorSelection ? (advisorSelection.model ?? "on") : undefined,
				outputSchema,
				outputSchemaMode: options.outputSchemaMode,
				restrictToolNames: restrictToolNames || undefined,
			});

			abortSignal.addEventListener(
				"abort",
				() => {
					void monitor.abortActiveSession();
				},
				{ once: true, signal: sessionAbortController.signal },
			);

			if (abortSignal.aborted) {
				void monitor.abortActiveSession();
			}

			const pendingExtensionMessages: Array<Promise<unknown>> = [];
			const extensionRunner = session.extensionRunner;
			if (extensionRunner) {
				extensionRunner.initialize(
					{
						sendMessage: (message, options) => {
							const sendPromise = session.sendCustomMessage(message, options).catch(e => {
								logger.error("Extension sendMessage failed", {
									error: e instanceof Error ? e.message : String(e),
								});
							});
							pendingExtensionMessages.push(sendPromise);
						},
						sendUserMessage: (content, options) => {
							const sendPromise = session.sendUserMessage(content, options).catch(e => {
								logger.error("Extension sendUserMessage failed", {
									error: e instanceof Error ? e.message : String(e),
								});
							});
							pendingExtensionMessages.push(sendPromise);
						},
						appendEntry: (customType, data) => {
							session.sessionManager.appendCustomEntry(customType, data);
						},
						setLabel: (targetId, label) => {
							session.sessionManager.appendLabelChange(targetId, label);
						},
						getActiveTools: () => session.getEnabledToolNames(),
						getAllTools: () => session.getAllToolInfos(),
						setActiveTools: (toolNames: string[]) =>
							session.setActiveToolsByName(toolNames.filter(name => !isParentOwnedTool(name))),
						getCommands: () => getSessionSlashCommands(session),
						setModel: model => runExtensionSetModel(session, model),
						getThinkingLevel: () => session.thinkingLevel,
						setThinkingLevel: level => session.setThinkingLevel(level),
						getServiceTiers: () => session.serviceTierByFamily,
						setServiceTier: (family, tier) => session.setServiceTierFamily(family, tier),
						getSessionName: () => session.sessionManager.getSessionName(),
						setSessionName: async name => {
							await session.sessionManager.setSessionName(name, "user");
						},
					},
					{
						getModel: () => session.model,
						isIdle: () => !session.isStreaming,
						abort: () => session.abort({ reason: USER_INTERRUPT_LABEL }),
						hasPendingMessages: () => session.queuedMessageCount > 0,
						shutdown: () => {},
						getContextUsage: () => session.getContextUsage(),
						getSystemPrompt: () => session.systemPrompt,
						compact: instructionsOrOptions => runExtensionCompact(session, instructionsOrOptions),
					},
				);
				extensionRunner.onError(err => {
					logger.error("Extension error", { path: err.extensionPath, error: err.error });
				});
				await awaitAbortable(extensionRunner.emit({ type: "session_start" }));
				while (pendingExtensionMessages.length > 0) {
					await awaitAbortable(Promise.all(pendingExtensionMessages.splice(0)));
				}
			}

			unsubscribe = monitor.attach(session);

			checkAbort();

			if (options.autoloadSkills?.length) {
				for (const skill of options.autoloadSkills) {
					const { message } = await buildSkillPromptMessage(skill, "", "autoload");
					await session.sendCustomMessage(
						{
							customType: SKILL_PROMPT_MESSAGE_TYPE,
							content: message,
							display: false,
							details: { name: skill.name, path: skill.filePath },
						},
						{ triggerTurn: false },
					);
				}
			}

			readyAt = performance.now();
			const outcome = await driveSessionToYield(session, monitor, task);
			exitCode = outcome.exitCode;
			error = outcome.error;
			aborted = outcome.aborted;
			abortReasonText = outcome.abortReasonText;
		} catch (err) {
			exitCode = 1;
			if (!abortSignal.aborted) {
				error = err instanceof Error ? err.stack || err.message : String(err);
			}
		} finally {
			const cleanupDeadlineAt = Date.now() + cleanupGraceMs;
			const cleanupChangeStatus =
				worktree === undefined
					? "This task was not isolated, so its changes may remain in the working directory."
					: "No isolated changes were applied.";
			const lateCleanups: Promise<void>[] = [];
			let deferredSessionShutdown: Promise<void> | undefined;
			const deferCleanup = (completion: Promise<void>): void => {
				lateCleanups.push(completion);
				exitCode = 1;
				aborted = true;
				abortReasonText = `cleanup exceeded ${cleanupGraceMs} ms`;
				error ??= `Task aborted. Cleanup did not finish within ${cleanupGraceMs} ms. ${cleanupChangeStatus}`;
			};
			if (abortSignal.aborted) {
				aborted = monitor.isAbortedRun();
				if (aborted) {
					abortReasonText ??= monitor.resolveAbortReasonText();
				}
				if (exitCode === 0) exitCode = 1;
			}
			sessionAbortController.abort();
			const activeSessionAbort = monitor.waitForActiveSessionAbort();
			try {
				await untilAborted(
					AbortSignal.timeout(Math.max(0, cleanupDeadlineAt - Date.now())),
					() => activeSessionAbort,
				);
			} catch (cleanupError) {
				if (Date.now() >= cleanupDeadlineAt) {
					deferCleanup(activeSessionAbort);
				} else {
					logger.warn("Subagent abort cleanup failed", {
						id,
						error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
					});
				}
			}
			if (unsubscribe) {
				try {
					unsubscribe();
				} catch {}
				unsubscribe = null;
			}
			const jobManager = AsyncJobManager.instance();
			if (jobManager) {
				const reap = await jobManager.cancelAndReapOwnerJobs(id, cleanupDeadlineAt);
				if (!reap.settled) {
					deferCleanup(reap.completion);
					logger.warn("Subagent async job cleanup exceeded its deadline", {
						id,
						pendingJobIds: reap.pendingJobIds,
					});
				}
			}
			const session = monitor.takeActiveSession();
			if (session) {
				monitor.captureSalvage(session);
				if (options.keepAlive !== false && worktree === undefined) {
					installIrcWakeTurnMonitor(session);
				}
				await finalizeSubagentLifecycle({
					id,
					session,
					aborted,
					abortKind: monitor.abortKind(),
					keepAlive: options.keepAlive !== false,
					isolated: worktree !== undefined,
					agentIdleTtlMs,
					reviveSession,
					cleanupDeadlineAt,
					onCleanupDeferred: completion => {
						deferredSessionShutdown = completion;
						deferCleanup(completion);
					},
				});
			}
			if (jobManager) {
				if (deferredSessionShutdown) {
					const finalReap = Promise.allSettled([deferredSessionShutdown]).then(async () => {
						const reap = await jobManager.cancelAndReapOwnerJobs(id, Date.now());
						await reap.completion;
					});
					lateCleanups.push(finalReap);
				} else {
					const reap = await jobManager.cancelAndReapOwnerJobs(id, cleanupDeadlineAt);
					if (!reap.settled) {
						deferCleanup(reap.completion);
						logger.warn("Subagent async job cleanup exceeded its deadline after session shutdown", {
							id,
							pendingJobIds: reap.pendingJobIds,
						});
					}
				}
			}
			if (lateCleanups.length > 0) {
				const completion = Promise.allSettled(lateCleanups).then(() => {});
				trackLateCleanup(completion, { id, resource: "subagent" });
				options.onCleanupDeferred?.(completion);
			}
		}

		const span = (from: number | undefined, to: number | undefined): number | undefined =>
			from !== undefined && to !== undefined ? Math.round(to - from) : undefined;
		const queueMs =
			options.invokedAt !== undefined && options.acquiredAt !== undefined
				? Math.round(options.acquiredAt - options.invokedAt)
				: undefined;
		const preRunMs = options.acquiredAt !== undefined ? Math.round(startTime - options.acquiredAt) : undefined;
		const setupToFirstChatMs = span(perfStart, firstChatDispatchAt);
		const invokeToFirstChatMs =
			options.invokedAt !== undefined && setupToFirstChatMs !== undefined
				? Math.round(startTime - options.invokedAt) + setupToFirstChatMs
				: undefined;
		logger.debug("subagent launch timing", {
			id,
			agent: agent.name,
			queueMs,
			preRunMs,
			resolveMs: span(perfStart, resolvedAt),
			sessionOpenMs: span(resolvedAt, sessionOpenedAt),
			createSessionMs: span(sessionOpenedAt, sessionCreatedAt),
			readyMs: span(sessionCreatedAt, readyAt),
			promptToFirstChatMs: span(readyAt, firstChatDispatchAt),
			setupToFirstChatMs,
			invokeToFirstChatMs,
		});
		return {
			exitCode,
			error,
			aborted,
			abortReason: aborted ? abortReasonText : undefined,
			durationMs: Date.now() - startTime,
		};
	};

	const done = await runSubagent();
	monitor.finish();

	const result = await finalizeRunResult({
		monitor,
		done,
		index,
		id,
		agent,
		task,
		assignment,
		modelOverride,
		modelRole,
		outputSchema,
		outputSchemaMode: options.outputSchemaMode,
		outputSchemaSource: options.outputSchemaSource,
		signal,
		artifactsDir: options.artifactsDir,
		eventBus: options.eventBus,
		parentToolCallId: options.parentToolCallId,
		detached: options.detached,
		sessionFile: subtaskSessionFile,
		startTime,
	});
	AgentRegistry.global().setHistory(id, { outputPath: result.outputPath });
	return result;
}
