import type { Agent, AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, Model, TextContent, ToolChoice } from "@oh-my-pi/pi-ai";
import { isRecord, logger, prompt, stringProperty } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import eagerChecklistPrompt from "../prompts/system/eager-checklist.md" with { type: "text" };
import midRunChecklistNudgePrompt from "../prompts/system/mid-run-checklist-nudge.md" with { type: "text" };
import {
	type ChecklistItem,
	type ChecklistPhase,
	getLatestChecklistPhasesFromEntries,
	isChecklistPhase,
} from "../tools/checklist";
import { buildNamedToolChoice } from "../utils/tool-choice";
import type { AgentSessionEvent } from "./agent-session-events";
import type { SessionManager } from "./session-manager";

const MID_RUN_NUDGE_MUTATION_THRESHOLD = 12;
const MID_RUN_NUDGE_MAX_PER_CYCLE = 2;
const MUTATING_TOOLS: Record<string, true> = {
	bash: true,
	eval: true,
	edit: true,
	write: true,
};
const MID_RUN_NUDGE_MESSAGE_TYPE = "mid-run-checklist-nudge";

function hasFileMutation(details: unknown): boolean {
	if (!isRecord(details)) return false;
	const statusEvents = details.statusEvents;
	if (
		Array.isArray(statusEvents) &&
		statusEvents.some(event => isRecord(event) && (event.op === "write" || event.op === "delete"))
	) {
		return true;
	}
	const mutatedPaths = details.mutatedPaths;
	return Array.isArray(mutatedPaths) && mutatedPaths.some(path => typeof path === "string" && path.length > 0);
}
const MARKDOWN_PROMPT_PREFIX_RE = /^(?:>\s*)?(?:(?:[-*+]|\d+[.)])\s+)*/;
const PROMPT_LABEL_RE = /^(?:q(?:uestion)?|ask)\s*\d*\s*[:.)-]\s*/i;
const INLINE_EMPHASIS_RE = /(\*\*|__)(.*?)\1/g;
const OPTION_LINE_RE = /^(?:[-*+]|\d+[.)])\s+\S/;
const RECOMMENDATION_RE = /^(?:i(?:'d| would)?\s+recommend|(?:my\s+)?recommendation)\b/i;
const CHOICE_CONFIRMATION_RE = /^(?:go|proceed|continue|stick)\s+with\b/i;
const QUESTION_PROMPT_RE =
	/^(?:what|which|when|where|why|how|who|whom|whose|do|does|did|can|could|would|will|should|is|are|am|may|shall)\b/i;
const USER_DIRECTED_PROMPT_RE = /\b(?:you|your|we|our)\b/i;
const ADDRESSEE_RE = /\b(?:you|your)\b/i;
// Imperatives ("tell me", "message me") and conditional permission ("If you confirm, I'll…").
const USER_RESPONSE_CUE_RE =
	/^(?:please\s+)?(?:confirm|reply|choose|pick|decide|advise|answer|approve)\b|^(?:please\s+)?(?:let\s+me\s+know|(?:tell|message|ping)\s+me)\b|^(?:if|once|when)\s+you\s+(?:confirm|approve|agree|allow|okay|ok|give)\b/i;
// Strip a connective only before an explicit address/permission cue; bare response
// words can be nouns ("Finally, answer validation is complete.").
const LEADING_CONNECTIVE_RE =
	/^(?:and|or|so|then|also|otherwise|alternatively|separately|finally)\b,?\s*(?=(?:please\b|let\s+me\s+know\b|(?:tell|message|ping)\s+me\b|(?:if|once|when)\s+you\b))/i;
// Western terminators need trailing whitespace (so `foo?: string` stays whole); CJK ones do not.
const SENTENCE_BREAK_RE = /(?<=[.!?…])\s+|(?<=[。！？])/;
/**
 * A trailing question mark is the universal signal that a line is a question, but
 * the English word/pronoun gates above exist to filter incidental "?" out of prose
 * (e.g. a TypeScript `foo?: string` tail). Non-English text has no cheap word list,
 * yet any non-ASCII character in a "?"/"？"-terminated line reliably marks it as
 * genuine prose — CJK/Japanese/Korean, Spanish `¿…?`, accented Latin — so treat it
 * as a real user-directed question. Fixes non-Latin prompts going undetected (#7803).
 */
const NON_ASCII_TEXT_RE = /[^\x00-\x7F]/;

// A question wrapped whole in italics (`*…*`, `_…_`) — or the `*…*` that
// INLINE_EMPHASIS_RE leaves of `***…***` — must still match the ^-anchored
// QUESTION_PROMPT_RE. Strikethrough is deliberately absent: `~~…~~` marks the
// author as having discarded the span, so unwrapping it would promote a retracted
// question back to a live one and idle the session waiting for an answer nobody is going to give.
const WRAPPED_EMPHASIS_RE = /^(\*\*\*|\*\*|\*|___|__|_)([\s\S]+)\1$/;

interface PromptLine {
	text: string;
	hadPromptLabel: boolean;
}

export interface ChecklistTrackerHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	model(): Model | undefined;
	agentKind(): "main" | "sub";
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	scheduleAgentContinue(options: { generation?: number }): void;
	promptGeneration(): number;
	hasPendingAsyncWake(): boolean;
	hasActiveMonitors(): boolean;
	getActiveToolNames(): string[];
	getEnabledToolNames(): string[];
	toolRegistry(): Map<string, AgentTool>;
	/** Whether an armed prewalk will hand off; its plan nudge then owns checklist creation. */
	prewalkWillHandoff(): boolean;
}

export class ChecklistTracker {
	readonly #host: ChecklistTrackerHost;
	#phases: ChecklistPhase[] = [];
	#reminderCount = 0;
	#reminderAwaitingProgress = false;
	#mutationsSinceLastTouch = 0;
	#midRunNudgeCount = 0;

	constructor(host: ChecklistTrackerHost) {
		this.#host = host;
	}

	get phases(): ChecklistPhase[] {
		return this.#clonePhases(this.#phases);
	}

	setPhases(phases: ChecklistPhase[]): void {
		this.#phases = this.#clonePhases(phases);
	}

	syncFromBranch(): void {
		this.setPhases(getLatestChecklistPhasesFromEntries(this.#host.sessionManager.getBranch()));
	}

	clonePhases(phases: ChecklistPhase[]): ChecklistPhase[] {
		return this.#clonePhases(phases);
	}

	resetCycle(): void {
		this.#reminderCount = 0;
		this.#reminderAwaitingProgress = false;
		this.#mutationsSinceLastTouch = 0;
		this.#midRunNudgeCount = 0;
	}

	onToolResult(toolName: string, isError: boolean, details?: unknown): void {
		if (toolName === "checklist") {
			this.#mutationsSinceLastTouch = 0;
			this.#midRunNudgeCount = 0;
		} else if (!isError && MUTATING_TOOLS[toolName]) {
			const mutatesFiles = toolName === "edit" || toolName === "write" || hasFileMutation(details);
			if (mutatesFiles) this.#mutationsSinceLastTouch++;
		}
		this.#reminderAwaitingProgress = false;
	}

	onChecklistResultDetails(details: Record<string, unknown>, toolCallId: string | undefined): boolean {
		const phases = details.phases;
		if (!Array.isArray(phases) || !phases.every(isChecklistPhase)) return false;
		const detailOp = stringProperty(details, "op");
		if (detailOp) return detailOp === "init";
		if (!toolCallId) return false;
		for (let index = this.#host.agent.state.messages.length - 1; index >= 0; index--) {
			const message = this.#host.agent.state.messages[index];
			if (!message) continue;
			const op = toolCallOpFromMessage(message, toolCallId);
			if (op) return op === "init";
		}
		return false;
	}

	createEagerChecklistPrelude(
		promptText: string | undefined,
	): { message: AgentMessage; toolChoice?: ToolChoice } | undefined {
		const mode = this.#host.settings.get("checklist.eager");
		if (mode === "default" || !this.#host.settings.get("checklist.enabled")) return undefined;
		if (this.#phases.length > 0) return undefined;
		// An actionable prewalk drives checklist creation plan-first; the forced
		// eager prelude's "call checklist first this turn" would contradict it.
		if (this.#host.prewalkWillHandoff()) return undefined;
		if (promptText !== undefined) {
			if (this.#host.agent.state.messages.some(message => message.role === "user")) return undefined;
			const trimmedPromptText = promptText.trimEnd();
			if (trimmedPromptText.endsWith("?") || trimmedPromptText.endsWith("!")) return undefined;
		}
		const activeToolNames = this.#host.getActiveToolNames();
		if (!activeToolNames.includes("checklist")) {
			logger.warn("Eager checklist enforcement skipped because checklist is not active", { activeToolNames });
			return undefined;
		}
		const message: AgentMessage = {
			role: "custom",
			customType: "eager-checklist-prelude",
			content: prompt.render(eagerChecklistPrompt, {
				...this.#buildEagerPreludeContext(),
				forced: mode === "always",
			}),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
		if (promptText === undefined || mode === "preferred") return { message };
		const model = this.#host.model();
		const toolChoice = buildNamedToolChoice("checklist", model);
		if (!toolChoice) {
			logger.warn(
				"Eager checklist proceeding with the reminder only because the current model does not support a forced checklist tool_choice",
				{ modelApi: model?.api, modelId: model?.id },
			);
			return { message };
		}
		return { message, toolChoice };
	}

	buildPostCompactionEagerNudges(): AgentMessage[] {
		const nudges: AgentMessage[] = [];
		const checklist = this.createEagerChecklistPrelude(undefined);
		if (checklist) nudges.push(checklist.message);
		return nudges;
	}

	async checkCompletion(message: AssistantMessage): Promise<boolean> {
		if (this.#reminderAwaitingProgress) {
			logger.debug("Checklist completion: prior reminder still awaiting agent action; staying silent", {
				attempt: this.#reminderCount,
			});
			return false;
		}
		if (
			!this.#host.settings.get("checklist.reminders") ||
			!this.#host.settings.get("checklist.enabled") ||
			!this.#host.getActiveToolNames().includes("checklist")
		) {
			this.#reminderCount = 0;
			this.#reminderAwaitingProgress = false;
			return false;
		}
		const remindersMax = this.#host.settings.get("checklist.remindersMax");
		if (this.#reminderCount >= remindersMax) {
			logger.debug("Checklist completion: max reminders reached", { count: this.#reminderCount });
			return false;
		}
		const phases = this.phases;
		if (phases.length === 0) {
			this.#reminderCount = 0;
			this.#reminderAwaitingProgress = false;
			return false;
		}
		const incompleteByPhase = phases
			.map(phase => ({
				name: phase.name,
				tasks: phase.tasks
					.filter(
						(task): task is ChecklistItem & { status: "pending" | "in_progress" } =>
							task.status === "pending" || task.status === "in_progress",
					)
					.map(task => ({ content: task.content, status: task.status })),
			}))
			.filter(phase => phase.tasks.length > 0);
		const incomplete = incompleteByPhase.flatMap(phase => phase.tasks);
		if (incomplete.length === 0) {
			this.#reminderCount = 0;
			this.#reminderAwaitingProgress = false;
			return false;
		}
		if (isAwaitingUserAnswer(message)) {
			logger.debug("Checklist completion: assistant is waiting for user input; skipping reminder", {
				incomplete: incomplete.length,
			});
			return false;
		}
		if (this.#host.hasPendingAsyncWake()) {
			logger.debug("Checklist completion: async jobs in flight will re-wake the loop; skipping reminder", {
				incomplete: incomplete.length,
			});
			return false;
		}
		if (this.#host.hasActiveMonitors()) {
			logger.debug("Checklist completion: an active monitor will re-wake the loop; skipping reminder", {
				incomplete: incomplete.length,
			});
			return false;
		}
		this.#reminderCount++;
		const checklistList = incompleteByPhase
			.map(phase => `- ${phase.name}\n${phase.tasks.map(task => `  - ${task.content}`).join("\n")}`)
			.join("\n");
		const reminder =
			`<system-reminder>\n` +
			`You stopped with ${incomplete.length} incomplete checklist item(s):\n${checklistList}\n\n` +
			`Please continue working on these tasks or mark them complete if finished.\n` +
			`(Reminder ${this.#reminderCount}/${remindersMax})\n` +
			`</system-reminder>`;
		logger.debug("Checklist completion: sending reminder", {
			incomplete: incomplete.length,
			attempt: this.#reminderCount,
		});
		await this.#host.emitSessionEvent({
			type: "checklist_reminder",
			items: incomplete,
			attempt: this.#reminderCount,
			maxAttempts: remindersMax,
		});
		const reminderMessage: Message = {
			role: "developer",
			content: [{ type: "text", text: reminder }],
			attribution: "agent",
			timestamp: Date.now(),
		};
		this.#mutationsSinceLastTouch = 0;
		this.#reminderAwaitingProgress = true;
		this.#host.agent.appendMessage(reminderMessage);
		this.#host.sessionManager.appendMessage(reminderMessage);
		this.#host.scheduleAgentContinue({ generation: this.#host.promptGeneration() });
		return true;
	}

	takeMidRunNudge(): AgentMessage | null {
		if (this.#mutationsSinceLastTouch < MID_RUN_NUDGE_MUTATION_THRESHOLD) return null;
		if (this.#midRunNudgeCount >= MID_RUN_NUDGE_MAX_PER_CYCLE) return null;
		if (!this.#host.settings.get("checklist.enabled") || !this.#host.settings.get("checklist.reminders")) return null;
		if (!this.#host.getActiveToolNames().includes("checklist")) return null;
		const incomplete = this.#phases
			.flatMap(phase => phase.tasks)
			.filter(task => task.status === "pending" || task.status === "in_progress");
		if (incomplete.length === 0) return null;
		this.#mutationsSinceLastTouch = 0;
		this.#midRunNudgeCount++;
		const { toolRefs } = this.#buildEagerPreludeContext();
		const reminder = prompt.render(midRunChecklistNudgePrompt, {
			toolRefs,
			incompleteCount: incomplete.length,
			plural: incomplete.length !== 1,
		});
		logger.debug("Mid-run checklist nudge fired", {
			incomplete: incomplete.length,
			nudge: this.#midRunNudgeCount,
		});
		return {
			role: "custom",
			customType: MID_RUN_NUDGE_MESSAGE_TYPE,
			content: reminder,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	#buildEagerPreludeContext(): { toolRefs: Record<string, string> } {
		const checklist = this.#host.toolRegistry().get("checklist");
		return {
			toolRefs: {
				checklist: typeof checklist?.customWireName === "string" ? checklist.customWireName : "checklist",
			},
		};
	}

	#clonePhases(phases: ChecklistPhase[]): ChecklistPhase[] {
		return phases.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.map(task =>
				task.blocker !== undefined
					? { content: task.content, status: task.status, blocker: task.blocker }
					: { content: task.content, status: task.status },
			),
		}));
	}
}

function toolCallOpFromMessage(message: AgentMessage, toolCallId: string): string | undefined {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	for (const block of message.content) {
		if (!isRecord(block) || block.type !== "toolCall" || block.id !== toolCallId) continue;
		return isRecord(block.arguments) ? stringProperty(block.arguments, "op") : undefined;
	}
	return undefined;
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((content): content is TextContent => content.type === "text")
		.map(content => content.text)
		.join("\n")
		.trim();
}

function promptLine(line: string): PromptLine {
	const withoutMarkdownPrefix = line
		.trim()
		.replace(INLINE_EMPHASIS_RE, "$2")
		.replace(MARKDOWN_PROMPT_PREFIX_RE, "")
		.trim();
	const withoutPromptLabel = withoutMarkdownPrefix.replace(PROMPT_LABEL_RE, "").trim();
	const withoutEmphasis = withoutPromptLabel.replace(WRAPPED_EMPHASIS_RE, "$2").trim();
	return {
		text: withoutEmphasis,
		hadPromptLabel: withoutPromptLabel !== withoutMarkdownPrefix,
	};
}

function isQuestionPromptLine(line: string): boolean {
	const candidate = promptLine(line);
	if (!/[?？]\s*$/.test(candidate.text)) return false;
	return (
		candidate.hadPromptLabel ||
		QUESTION_PROMPT_RE.test(candidate.text) ||
		CHOICE_CONFIRMATION_RE.test(candidate.text) ||
		USER_DIRECTED_PROMPT_RE.test(candidate.text) ||
		NON_ASCII_TEXT_RE.test(candidate.text)
	);
}

function isResponseCueLine(line: string): boolean {
	const candidate = promptLine(line)
		.text.replace(/[.!?。！？]+$/, "")
		.replace(LEADING_CONNECTIVE_RE, "")
		.trim();
	return USER_RESPONSE_CUE_RE.test(candidate);
}

/**
 * How a closing span hands control back, strongest first: `cue` instructs the user
 * ("tell me…", "If you confirm, I'll…") and no later prose can answer it; `request`
 * asks outright (labelled, user-addressed, or non-English question) but the agent may
 * still answer it itself; `question` is only question-shaped ("What's next?") and may
 * be a heading.
 */
type ClosingAsk = "none" | "question" | "request" | "cue";

function askOf(span: string): ClosingAsk {
	if (isResponseCueLine(span)) return "cue";
	if (!isQuestionPromptLine(span)) return "none";
	const candidate = promptLine(span);
	return candidate.hadPromptLabel || ADDRESSEE_RE.test(candidate.text) || NON_ASCII_TEXT_RE.test(candidate.text)
		? "request"
		: "question";
}

/** The last two sentences of the prose lines closing `paragraph`; a list item ends the walk. */
function closingSentences(paragraph: string): string[] {
	const sentences: string[] = [];
	const lines = paragraph.split(/\r?\n/);
	for (let index = lines.length - 1; index >= 0 && sentences.length < 2; index--) {
		const line = lines[index].trim();
		if (OPTION_LINE_RE.test(line)) break;
		const lineSentences = line.split(SENTENCE_BREAK_RE).filter(Boolean);
		sentences.unshift(...lineSentences.slice(sentences.length - 2));
	}
	return sentences;
}

function closingAsk(paragraph: string): ClosingAsk {
	const lastLine = paragraph.slice(paragraph.lastIndexOf("\n") + 1).trim();
	const sentences = closingSentences(paragraph);
	const asks = [askOf(lastLine), ...sentences.slice(-1).map(askOf)];
	// No lexicon recognizes a non-English follow-up ("…? Отдельно скажите, …"), and none
	// recognizes a non-English self-answer either; an open request is the costlier miss.
	const foreignQuestion =
		sentences.length === 2 && NON_ASCII_TEXT_RE.test(sentences[0]) && isQuestionPromptLine(sentences[0]);
	if (asks.includes("cue")) return "cue";
	if (foreignQuestion || asks.includes("request")) return "request";
	return asks.includes("question") ? "question" : "none";
}

function isAwaitingUserAnswer(message: AssistantMessage): boolean {
	const text = assistantText(message);
	if (!text) return false;
	const paragraphs = text.split(/\r?\n\s*\r?\n/);
	const lastParagraph = paragraphs.at(-1)?.trim() ?? "";
	if (closingAsk(lastParagraph) !== "none") return true;
	// A one-line closing note ("Repository unchanged, no commits.") does not withdraw an
	// instruction in the paragraph before it. A question there may be self-answered by
	// that note ("Do you need…?\n\nNo, …"), so it does not count.
	const previousParagraph = paragraphs.at(-2)?.trim();
	if (
		previousParagraph &&
		!lastParagraph.includes("\n") &&
		!OPTION_LINE_RE.test(lastParagraph) &&
		closingAsk(previousParagraph) === "cue"
	) {
		return true;
	}
	const lines = text.split(/\r?\n/);

	// Options and a recommendation do not answer the question on the user's behalf.
	// Stop at other prose so self-answered questions still allow unfinished work to resume.
	let optionCount = 0;
	let hasRecommendation = false;
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index].trim();
		if (!line) continue;
		if (OPTION_LINE_RE.test(line)) {
			optionCount++;
			continue;
		}
		const candidate = promptLine(line);
		if (optionCount > 0) {
			return (
				optionCount >= 2 &&
				isQuestionPromptLine(line) &&
				(hasRecommendation ||
					candidate.hadPromptLabel ||
					USER_DIRECTED_PROMPT_RE.test(candidate.text) ||
					CHOICE_CONFIRMATION_RE.test(candidate.text))
			);
		}
		if (RECOMMENDATION_RE.test(candidate.text)) {
			hasRecommendation = true;
			continue;
		}
		return false;
	}
	return false;
}
