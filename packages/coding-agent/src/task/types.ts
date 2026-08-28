import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import { $env } from "@oh-my-pi/pi-utils";
import type { AgentSessionEvent } from "../session/agent-session";

import type { NestedRepoPatch } from "./worktree";

export type AgentSource = "bundled" | "user" | "project";

export type StructuredSubagentSchemaMode = "permissive" | "strict";

export type StructuredSubagentSchemaSource = "caller" | "agent" | "session" | "none";

type StructuredSubagentValidationStatus = "valid" | "invalid" | "unavailable";

export interface StructuredSubagentOutput {
	source: StructuredSubagentSchemaSource;
	mode: StructuredSubagentSchemaMode;
	status: StructuredSubagentValidationStatus;
	data?: unknown;
	error?: string;
}

const parseNumber = (value: string | undefined, defaultValue: number): number => {
	if (value) {
		try {
			const number = Number.parseInt(value, 10);
			if (!Number.isNaN(number) && number > 0) {
				return number;
			}
		} catch {}
	}
	return defaultValue;
};

export const MAX_OUTPUT_BYTES = parseNumber($env.PI_TASK_MAX_OUTPUT_BYTES, 500_000);

export const MAX_OUTPUT_LINES = parseNumber($env.PI_TASK_MAX_OUTPUT_LINES, 5000);

export const WORKER_SUBAGENT_EVENT_CHANNEL = "worker:subagent:event";

export const WORKER_SUBAGENT_PROGRESS_CHANNEL = "worker:subagent:progress";

export const WORKER_SUBAGENT_LIFECYCLE_CHANNEL = "worker:subagent:lifecycle";

export interface SubagentProgressPayload {
	index: number;
	agent: string;
	agentSource: AgentSource;
	task: string;
	parentToolCallId?: string;
	assignment?: string;
	progress: AgentProgress;
	sessionFile?: string;

	detached?: boolean;
}

export interface SubagentEventPayload {
	id: string;
	event: AgentSessionEvent;
}

export interface SubagentLifecyclePayload {
	id: string;
	agent: string;
	agentSource: AgentSource;
	description?: string;
	status: "started" | "completed" | "failed" | "aborted";
	sessionFile?: string;
	parentToolCallId?: string;
	index: number;

	detached?: boolean;
}

const LABEL_MAX = 80;

export function oneLineLabel(text: string, max = LABEL_MAX): string {
	const oneLine = text.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
	const cap = Math.max(1, max);

	const chars = [...oneLine];
	return chars.length > cap ? `${chars.slice(0, cap - 1).join("")}…` : oneLine;
}

export function canSpawnAtDepth(maxRecursionDepth: number, taskDepth: number): boolean {
	return maxRecursionDepth < 0 || taskDepth === 0 || taskDepth <= maxRecursionDepth;
}

export interface AgentDefinition {
	name: string;
	description: string;
	systemPrompt: string;
	tools?: string[];
	spawns?: string[] | "*";
	model?: string[];
	thinkingLevel?: ThinkingLevel;
	output?: unknown;
	autoloadSkills?: string[];

	readSummarize?: boolean;

	prewalk?: boolean | string;

	advisor?: boolean | string;
	source: AgentSource;
	filePath?: string;
}

export interface YieldItem {
	data?: unknown;
	status?: "success" | "aborted";
	error?: string;

	type?: string | string[];

	useLastTurn?: boolean;

	schemaOverridden?: boolean;
}

export interface AgentProgress {
	index: number;
	id: string;
	agent: string;
	agentSource: AgentSource;
	status: "pending" | "running" | "completed" | "failed" | "aborted";
	task: string;
	assignment?: string;
	description?: string;
	lastIntent?: string;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartMs?: number;
	recentTools: Array<{ tool: string; args: string; endMs: number }>;
	recentOutput: string[];
	toolCount: number;

	requests: number;

	tokens: number;

	contextTokens?: number;

	contextWindow?: number;

	cost: number;
	durationMs: number;
	modelOverride?: string | string[];

	modelRole?: string;

	resolvedModel?: string;

	resolvedModelIsFallback?: boolean;

	extractedToolData?: Record<string, unknown[]>;

	retryState?: {
		attempt: number;
		maxAttempts: number;
		delayMs: number;
		errorMessage: string;
		startedAtMs: number;
	};

	retryFailure?: {
		attempt: number;
		errorMessage: string;
	};
}

export interface SingleResult {
	index: number;
	id: string;
	agent: string;
	agentSource: AgentSource;
	task: string;
	assignment?: string;
	description?: string;
	lastIntent?: string;
	exitCode: number;
	output: string;
	stderr: string;
	truncated: boolean;

	structuredOutput?: StructuredSubagentOutput;
	durationMs: number;

	tokens: number;

	requests: number;

	contextTokens?: number;

	contextWindow?: number;
	modelOverride?: string | string[];

	modelRole?: string;

	resolvedModel?: string;

	resolvedModelIsFallback?: boolean;
	error?: string;
	aborted?: boolean;
	abortReason?: string;

	usage?: Usage;

	outputPath?: string;

	patchPath?: string;

	branchName?: string;

	branchBaseSha?: string;

	nestedPatches?: NestedRepoPatch[];

	extractedToolData?: Record<string, unknown[]>;

	retryFailure?: {
		attempt: number;
		errorMessage: string;
	};

	outputMeta?: { lineCount: number; charCount: number };
}
