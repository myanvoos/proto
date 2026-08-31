import * as path from "node:path";

import { type Api, type AssistantMessage, completeSimple, type Model, retryTransientCompletion } from "@oh-my-pi/pi-ai";
import { StreamMarkupHealing } from "@oh-my-pi/pi-ai/utils/stream-markup-healing";
import { writeThroughActiveTerminal } from "@oh-my-pi/pi-tui";
import { isTerminalHeadless, logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";

import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import titleMarkerInstruction from "../prompts/system/title-marker-instruction.md" with { type: "text" };
import titleSystemPrompt from "../prompts/system/title-system.md" with { type: "text" };
import { formatTitleUserMessage } from "../tiny/message-preproc";
import { isTinyTitleLocalModelKey, ONLINE_TINY_TITLE_MODEL_KEY } from "../tiny/models";
import { isLowSignalTitleInput, normalizeGeneratedTitle } from "../tiny/text";
import { tinyTitleClient } from "../tiny/title-client";

const TITLE_SYSTEM_PROMPT = prompt.render(titleSystemPrompt);
const TITLE_MARKER_INSTRUCTION = prompt.render(titleMarkerInstruction);

const DEFAULT_TERMINAL_TITLE = "π";
const TERMINAL_TITLE_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

function writeTitleSequence(seq: string): void {
	if (!writeThroughActiveTerminal(seq)) process.stdout.write(seq);
}

let lastTerminalTitle: string | undefined;

const TITLE_MAX_TOKENS = 1024;

const TITLE_MARKER_GLOBAL_RE = /<title>([\s\S]*?)<\/title>|<title\s*\/>|<title>\s*$/gi;
const TITLE_VISIBILITY_SENTINEL = "\uE000omp-title-visible\uE000";
const THINKING_TAG_ENVELOPE_RE = /<(think|thinking|reasoning)>\s*[\s\S]*?<\/\1>/gi;
const THINKING_FENCE_ENVELOPE_RE = /```(?:thinking|reasoning)\b[\s\S]*?```/gi;
const LEADING_THINKING_TAG_RE = /^\s*<(think|thinking|reasoning)>\s*[\s\S]*?<\/\1>\s*/i;
const LEADING_THINKING_FENCE_RE = /^\s*```(?:thinking|reasoning)\b[\s\S]*?```\s*/i;
const LEADING_PROSE_THINKING_PREAMBLE_RE =
	/^[ \t]*(?:(?:here(?:['’]s| is)[ \t]+(?:a|the|my)[ \t]+)|my[ \t]+)?(?:thinking|thought|reasoning)[ \t]+process[ \t]*:?[ \t]*(?:\r?\n|$)/i;

function getTitleModel(registry: ModelRegistry, settings: Settings, currentModel?: Model<Api>): Model<Api> | undefined {
	const availableModels = registry.getAvailable();
	if (availableModels.length === 0) return undefined;

	const titleModel = resolveRoleSelection(["tiny", "commit", "smol"], settings, availableModels)?.model;
	if (titleModel) return titleModel;

	if (currentModel) return currentModel;

	return undefined;
}

export async function generateSessionTitle(
	firstMessage: string,
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
	currentModel?: Model<Api>,
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined,
	customSystemPrompt?: string,
	signal?: AbortSignal,
): Promise<string | null> {
	if (isLowSignalTitleInput(firstMessage)) {
		logger.debug("title-generator: skipped low-signal input", { sessionId, reason: "low-signal" });
		return null;
	}

	const titleSystemPrompt = customSystemPrompt?.trim() || undefined;
	const tinyModel = settings.get("providers.tinyModel");
	if (tinyModel === ONLINE_TINY_TITLE_MODEL_KEY) {
		return generateTitleOnline(
			firstMessage,
			registry,
			settings,
			sessionId,
			currentModel,
			metadataResolver,
			signal,
			titleSystemPrompt,
		);
	}

	if (!isTinyTitleLocalModelKey(tinyModel)) {
		logger.warn("title-generator: unknown local tiny model; skipping title (will not fall back to online)", {
			sessionId,
			model: tinyModel,
			reason: "unknown-local-model",
		});
		return null;
	}
	try {
		let localTitle: string | null;
		if (signal) {
			localTitle = await tinyTitleClient.generate(
				tinyModel,
				firstMessage,
				titleSystemPrompt ? { signal, systemPrompt: titleSystemPrompt } : { signal },
			);
		} else if (titleSystemPrompt) {
			localTitle = await tinyTitleClient.generate(tinyModel, firstMessage, { systemPrompt: titleSystemPrompt });
		} else {
			localTitle = await tinyTitleClient.generate(tinyModel, firstMessage);
		}
		if (!localTitle) {
			logger.warn("title-generator: local tiny model produced no title; skipping (no online fallback)", {
				sessionId,
				model: tinyModel,
				reason: "local-no-output",
			});
			return null;
		}
		return localTitle;
	} catch (err) {
		logger.warn("title-generator: local tiny model errored; skipping (no online fallback)", {
			sessionId,
			model: tinyModel,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

async function generateTitleOnline(
	firstMessage: string,
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
	currentModel?: Model<Api>,
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined,
	signal?: AbortSignal,
	customSystemPrompt?: string,
): Promise<string | null> {
	const model = getTitleModel(registry, settings, currentModel);
	if (!model) {
		logger.warn("title-generator: no title model found", { sessionId, reason: "no-title-model" });
		return null;
	}

	const titleSystemPrompt = customSystemPrompt?.trim() || undefined;

	const systemPrompt = titleSystemPrompt ? [titleSystemPrompt, TITLE_MARKER_INSTRUCTION] : [TITLE_SYSTEM_PROMPT];
	const userMessage = formatTitleUserMessage(firstMessage);
	const modelName = `${model.provider}/${model.id}`;
	const modelContext = {
		sessionId,
		provider: model.provider,
		id: model.id,
		model: modelName,
	};
	logger.debug("title-generator: start", modelContext);

	try {
		const apiKey = await registry.getApiKey(model, sessionId);
		if (!apiKey) {
			logger.warn("title-generator: no API key", { ...modelContext, reason: "missing-api-key" });
			return null;
		}

		const metadata = metadataResolver?.(model.provider);

		const maxTokens = TITLE_MAX_TOKENS;
		logger.debug("title-generator: request", { ...modelContext, maxTokens });

		const response = await retryTransientCompletion(
			() =>
				completeSimple(
					model,
					{
						systemPrompt,
						messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
					},
					{
						apiKey: registry.resolver(model, sessionId),
						maxTokens,
						disableReasoning: true,

						temperature: 0,
						metadata,
						signal,
					},
				),
			{ signal },
		);

		if (response.stopReason === "error") {
			logger.warn("title-generator: response error", {
				...modelContext,
				reason: "provider-response-error",
				stopReason: response.stopReason,
				errorMessage: response.errorMessage,
			});
			return null;
		}

		const title = normalizeGeneratedTitle(extractGeneratedTitle(response.content), firstMessage);

		if (!title) {
			logger.debug("title-generator: no title returned", {
				...modelContext,
				reason: "model-returned-none",
				usage: response.usage,
				stopReason: response.stopReason,
			});
			return null;
		}

		logger.debug("title-generator: success", {
			...modelContext,
			title,
			usage: response.usage,
			stopReason: response.stopReason,
		});

		return title;
	} catch (err) {
		logger.warn("title-generator: error", {
			...modelContext,
			reason: "exception",
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

function extractGeneratedTitle(contentBlocks: AssistantMessage["content"]): string {
	let textTitle = "";
	for (const content of contentBlocks) {
		if (content.type === "text") {
			textTitle += content.text;
		}
	}

	const markedTitle = extractVisibleMarkedTitle(textTitle);
	if (markedTitle !== undefined) return unwrapJsonTitle(markedTitle);
	const cleanedTextTitle = stripLeadingLeakedThinkingMarkup(textTitle)
		.replace(/<\/?title>/gi, "")
		.trim();
	if (LEADING_PROSE_THINKING_PREAMBLE_RE.test(cleanedTextTitle)) return "";
	return unwrapJsonTitle(cleanedTextTitle);
}

function extractVisibleMarkedTitle(text: string): string | undefined {
	TITLE_MARKER_GLOBAL_RE.lastIndex = 0;
	let marker: RegExpExecArray | null = TITLE_MARKER_GLOBAL_RE.exec(text);
	while (marker !== null) {
		const content = marker[1];
		if (isVisibleTitleMarker(text, marker.index)) return content?.trim() ?? "";
		marker = TITLE_MARKER_GLOBAL_RE.exec(text);
	}
	return undefined;
}

function isVisibleTitleMarker(text: string, markerIndex: number): boolean {
	if (isInsideKnownThinkingEnvelope(text, markerIndex)) return false;
	return stripLeakedThinkingMarkup(`${text.slice(0, markerIndex)}${TITLE_VISIBILITY_SENTINEL}`).endsWith(
		TITLE_VISIBILITY_SENTINEL,
	);
}

function isInsideKnownThinkingEnvelope(text: string, index: number): boolean {
	return (
		isInsideEnvelopeMatchedBy(THINKING_TAG_ENVELOPE_RE, text, index) ||
		isInsideEnvelopeMatchedBy(THINKING_FENCE_ENVELOPE_RE, text, index)
	);
}

function isInsideEnvelopeMatchedBy(pattern: RegExp, text: string, index: number): boolean {
	pattern.lastIndex = 0;
	let marker = pattern.exec(text);
	while (marker !== null) {
		const start = marker.index;
		const end = start + marker[0].length;
		if (index > start && index < end) return true;
		if (start > index) return false;
		marker = pattern.exec(text);
	}
	return false;
}

function stripLeadingLeakedThinkingMarkup(text: string): string {
	let current = text;
	while (true) {
		const withoutTag = current.replace(LEADING_THINKING_TAG_RE, "");
		const withoutFence = withoutTag.replace(LEADING_THINKING_FENCE_RE, "");
		if (withoutFence === current) return current;
		current = withoutFence;
	}
}

function stripLeakedThinkingMarkup(text: string): string {
	const healer = new StreamMarkupHealing({ pattern: "thinking" });
	return healer.feed(text) + healer.flushPending();
}

function unwrapJsonTitle(candidate: string): string {
	const text = candidate
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/```$/, "")
		.trim();
	if (!text.startsWith("{")) return candidate;
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === "object" && "title" in parsed && typeof parsed.title === "string") {
			return parsed.title.trim();
		}
	} catch {
		const quoted = /"title"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text);
		if (quoted) {
			const salvaged: unknown = JSON.parse(quoted[1]);
			if (typeof salvaged === "string") return salvaged.trim();
		}
	}
	return candidate;
}

function sanitizeTerminalTitlePart(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const sanitized = value.replace(TERMINAL_TITLE_CONTROL_CHARS, "").trim();
	return sanitized || undefined;
}

function getFallbackTerminalTitle(cwd: string | undefined): string | undefined {
	if (!cwd) return undefined;
	const resolvedCwd = path.resolve(cwd);
	const baseName = path.basename(resolvedCwd);
	if (!baseName || baseName === path.parse(resolvedCwd).root) return undefined;
	return sanitizeTerminalTitlePart(baseName);
}

export function setTerminalTitle(title: string): void {
	if (!process.stdout.isTTY || isTerminalHeadless()) return;
	const next = sanitizeTerminalTitlePart(title) ?? DEFAULT_TERMINAL_TITLE;
	if (next === lastTerminalTitle) return;
	writeTitleSequence(`\x1b]0;${next}\x07`);
	lastTerminalTitle = next;
}

export function setSessionTerminalTitle(sessionName: string | undefined, cwd?: string): void {
	terminalTitleRuntime.extensionOverride = undefined;
	terminalTitleRuntime.label = sanitizeTerminalTitlePart(sessionName) ?? getFallbackTerminalTitle(cwd);
	emitTerminalTitle();
}

export function setExtensionTerminalTitle(title: string): void {
	terminalTitleRuntime.extensionOverride = title;
	emitTerminalTitle();
}

type TerminalTitleState = "idle" | "working" | "attention";

const TITLE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TITLE_SPINNER_INTERVAL_MS = 80;

const TITLE_IDLE_SEPARATOR = ">";

const TITLE_ATTENTION_SEPARATOR = "!";

const terminalTitleRuntime: {
	label: string | undefined;
	state: TerminalTitleState;
	frame: number;
	enabled: boolean;
	timer: NodeJS.Timeout | undefined;

	extensionOverride: string | undefined;
} = {
	label: undefined,
	state: "idle",
	frame: 0,
	enabled: true,
	timer: undefined,
	extensionOverride: undefined,
};

export function buildTerminalTitleWithState(
	label: string | undefined,
	state: TerminalTitleState,
	frame: number,
	enabled: boolean,
): string {
	if (!enabled) return label ? `${DEFAULT_TERMINAL_TITLE}: ${label}` : DEFAULT_TERMINAL_TITLE;
	const separator =
		state === "working"
			? TITLE_SPINNER_FRAMES[frame % TITLE_SPINNER_FRAMES.length]
			: state === "attention"
				? TITLE_ATTENTION_SEPARATOR
				: TITLE_IDLE_SEPARATOR;
	return label ? `${DEFAULT_TERMINAL_TITLE} ${separator} ${label}` : `${DEFAULT_TERMINAL_TITLE} ${separator}`;
}

function emitTerminalTitle(): void {
	const next =
		terminalTitleRuntime.extensionOverride ??
		buildTerminalTitleWithState(
			terminalTitleRuntime.label,
			terminalTitleRuntime.state,
			terminalTitleRuntime.frame,
			terminalTitleRuntime.enabled,
		);
	setTerminalTitle(next);
}

function stopTerminalTitleSpinner(): void {
	clearInterval(terminalTitleRuntime.timer);
	terminalTitleRuntime.timer = undefined;
}

function startTerminalTitleSpinner(): void {
	if (terminalTitleRuntime.timer || !process.stdout.isTTY) return;
	terminalTitleRuntime.timer = setInterval(() => {
		terminalTitleRuntime.frame = (terminalTitleRuntime.frame + 1) % TITLE_SPINNER_FRAMES.length;
		emitTerminalTitle();
	}, TITLE_SPINNER_INTERVAL_MS);

	terminalTitleRuntime.timer.unref?.();
}

export function setTerminalTitleState(state: TerminalTitleState): void {
	terminalTitleRuntime.state = state;
	if (state === "working" && terminalTitleRuntime.enabled) startTerminalTitleSpinner();
	else stopTerminalTitleSpinner();
	emitTerminalTitle();
}

export function setTerminalTitleStateEnabled(enabled: boolean): void {
	terminalTitleRuntime.enabled = enabled;
	if (enabled && terminalTitleRuntime.state === "working") startTerminalTitleSpinner();
	else stopTerminalTitleSpinner();
	emitTerminalTitle();
}

export function disposeTerminalTitleState(): void {
	stopTerminalTitleSpinner();
	lastTerminalTitle = undefined;
}

export function pushTerminalTitle(): void {
	if (!process.stdout.isTTY || isTerminalHeadless()) return;
	writeTitleSequence("\x1b[22;2t");
}

export function popTerminalTitle(): void {
	if (!process.stdout.isTTY || isTerminalHeadless()) return;
	writeTitleSequence("\x1b[23;2t");
}
