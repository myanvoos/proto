import type { Agent, AgentMessage, AgentTool, AgentTurnEndContext } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, Model } from "@oh-my-pi/pi-ai";
import { getStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { GeminiHeaderRunDetector } from "@oh-my-pi/pi-ai/utils/thinking-loop";
import { type RepeatedToolCallDetection, ToolCallLoopGuard } from "@oh-my-pi/pi-ai/utils/tool-call-loop-guard";
import { modelFamilyToken } from "@oh-my-pi/pi-catalog/identity";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { StreamedKernelFailure } from "../eval/speculation";
import geminiToolReminderTemplate from "../prompts/system/gemini-tool-call-reminder.md" with { type: "text" };
import kernelAssertPreflightTemplate from "../prompts/system/kernel-assert-preflight.md" with { type: "text" };
import toolCallLoopStopTemplate from "../prompts/system/tool-call-loop-stop.md" with { type: "text" };
import type { CustomMessage } from "./messages";
import type { SessionManager } from "./session-manager";
import { renderToolCallLoopRedirect } from "./tool-call-loop-redirect";

const GEMINI_HEADER_INTERRUPT_REASON = "Interrupted: emit a tool call instead of more planning";
const GEMINI_TOOL_REMINDER_TYPE = "gemini-tool-call-reminder";
const TOOL_CALL_LOOP_REDIRECT_TYPE = "tool-call-loop-redirect";
const TOOL_CALL_LOOP_STOP_TYPE = "tool-call-loop-stop";

export interface StreamGuardsHost {
	agent: Agent;
	settings: Settings;
	sessionManager: SessionManager;
	model(): Model | undefined;
	getToolByName(name: string): AgentTool | undefined;
	canObserveStreamedKernelInput(): boolean;
	isDisposed(): boolean;
	promptGeneration(): number;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	schedulePostPromptTask(task: (signal: AbortSignal) => Promise<void>): void;
	discardAssistantTurn(message: AssistantMessage): void;
}

interface StreamedKernelTool {
	observeStreamedInput(toolCallId: string, rawPartialJson: string): Promise<StreamedKernelFailure | undefined>;
	flushStreamedInput?(toolCallId: string, rawPartialJson?: string): Promise<void>;
	cancelStreamedInput(toolCallId?: string): void;
}

function streamedKernelTool(tool: AgentTool | undefined): (AgentTool & StreamedKernelTool) | undefined {
	if (
		tool &&
		"observeStreamedInput" in tool &&
		typeof tool.observeStreamedInput === "function" &&
		"cancelStreamedInput" in tool &&
		typeof tool.cancelStreamedInput === "function"
	) {
		return tool as AgentTool & StreamedKernelTool;
	}
	return undefined;
}

export class LoopGuards {
	readonly #host: StreamGuardsHost;
	#geminiHeaderDetector: GeminiHeaderRunDetector | undefined;
	#toolCallLoopGuard: ToolCallLoopGuard | undefined;
	#toolCallLoopGuardSettingsKey: string | undefined;
	#toolCallLoopStopGeneration: number | undefined;
	#streamedTimestamp: number | undefined;
	#streamedEpoch = 0;
	#streamedCalls = new Set<string>();
	#streamedTools = new Set<StreamedKernelTool>();

	constructor(host: StreamGuardsHost) {
		this.#host = host;
	}

	recordTurn(messages: AgentMessage[], context: AgentTurnEndContext | undefined): void {
		if (context?.message.role !== "assistant") return;
		const detection = this.#activeToolCallLoopGuard()?.recordTurn({
			message: context.message,
			toolResults: context.toolResults,
		});
		if (!detection) return;
		if (detection.severity === "stop") this.#stopToolCallLoop(detection);
		else this.#injectToolCallLoopRedirect(messages, detection);
	}

	onAssistantEvent(message: AssistantMessage, event: AssistantMessageEvent): void {
		this.#observeStreamedKernel(message, event);
		if (event.type === "thinking_start") {
			this.#geminiHeaderDetector = this.#geminiHeaderGuardActive() ? new GeminiHeaderRunDetector() : undefined;
			return;
		}
		const detector = this.#geminiHeaderDetector;
		if (!detector) return;
		if (event.type === "thinking_delta") {
			if (detector.push(event.delta)) this.#interruptGeminiHeaderRunaway(detector.count, message.timestamp);
			return;
		}
		if (event.type === "text_start" || event.type === "toolcall_start") detector.reset();
	}

	/** Stop accepting late preflight results; claimed runtime work owns its own lifetime. */
	cancelStreamedInput(): void {
		this.#streamedEpoch++;
		this.#streamedCalls.clear();
		this.#streamedTimestamp = undefined;
		for (const tool of this.#streamedTools) tool.cancelStreamedInput();
		this.#streamedTools.clear();
	}

	onAssistantMessageEnd(message: AssistantMessage): void {
		if (message.timestamp === this.#streamedTimestamp) this.#streamedCalls.clear();
	}

	#observeStreamedKernel(message: AssistantMessage, event: AssistantMessageEvent): void {
		if (event.type !== "toolcall_start" && event.type !== "toolcall_delta" && event.type !== "toolcall_end") return;
		if (this.#streamedTimestamp !== message.timestamp) {
			this.cancelStreamedInput();
			this.#streamedTimestamp = message.timestamp;
		}
		const call = message.content[event.contentIndex];
		if (call?.type !== "toolCall" || call.name !== "bash") return;
		if (event.type === "toolcall_end") {
			const host = this.#host;
			if (
				!host.isDisposed() &&
				!host.agent.isAborting &&
				host.canObserveStreamedKernelInput() &&
				(host.settings.get("kernel.speculation.enabled") || host.settings.get("kernel.assertPreflight.enabled"))
			) {
				const tool = streamedKernelTool(host.getToolByName("bash"));
				const rawPartialJson = getStreamingPartialJson(call) ?? JSON.stringify(call.arguments);
				if (tool?.flushStreamedInput && rawPartialJson !== undefined) {
					this.#streamedTools.add(tool);
					void tool.flushStreamedInput(call.id, rawPartialJson).catch(error => {
						logger.debug("final streamed kernel observation failed", { error: String(error) });
					});
				}
			}
			this.#streamedCalls.delete(call.id);
			return;
		}
		const host = this.#host;
		if (
			host.isDisposed() ||
			host.agent.isAborting ||
			!host.canObserveStreamedKernelInput() ||
			(!host.settings.get("kernel.speculation.enabled") && !host.settings.get("kernel.assertPreflight.enabled"))
		)
			return;
		const tool = streamedKernelTool(host.getToolByName("bash"));
		const rawPartialJson = getStreamingPartialJson(call);
		if (!tool || rawPartialJson === undefined) return;
		this.#streamedTools.add(tool);
		this.#streamedCalls.add(call.id);
		const epoch = this.#streamedEpoch;
		const generation = host.promptGeneration();
		const hasPrecedingToolCall = message.content
			.slice(0, event.contentIndex)
			.some(block => block.type === "toolCall");
		void tool
			.observeStreamedInput(call.id, rawPartialJson)
			.then(failure => {
				if (
					!failure ||
					hasPrecedingToolCall ||
					failure.toolCallId !== call.id ||
					epoch !== this.#streamedEpoch ||
					!this.#streamedCalls.has(call.id) ||
					host.promptGeneration() !== generation ||
					host.isDisposed() ||
					host.agent.isAborting ||
					!host.agent.state.isStreaming ||
					!host.canObserveStreamedKernelInput() ||
					!host.settings.get("kernel.assertPreflight.enabled")
				)
					return;
				this.cancelStreamedInput();
				host.emitNotice(
					"warning",
					"Stopped generation early: a streamed kernel assertion failed.",
					"kernel-preflight",
				);
				this.#interruptWithReminder({
					targetTimestamp: message.timestamp,
					reason: "Interrupted: streamed kernel assertion failed",
					customType: "kernel-assert-preflight",
					content: prompt.render(kernelAssertPreflightTemplate, { diagnostic: failure.message }),
					details: { toolCallId: call.id, diagnostic: failure.message },
				});
			})
			.catch(error => {
				// Preflight is optional; unsupported input or an observer failure never executes a partial cell.
				logger.debug("streamed kernel observation failed", { error: String(error) });
			});
	}

	/**
	 * True while the current prompt is stopped by the hard limit. Recovery consults
	 * this: without it the deliberate abort looks like a reasonless one and the run
	 * is retried straight back into the loop.
	 */
	get toolCallLoopStopped(): boolean {
		return this.#toolCallLoopStopGeneration === this.#host.promptGeneration();
	}

	#activeToolCallLoopGuard(): ToolCallLoopGuard | undefined {
		if (this.#host.settings.get("model.toolCallLoopGuard.enabled") !== true) {
			this.#toolCallLoopGuard = undefined;
			this.#toolCallLoopGuardSettingsKey = undefined;
			return undefined;
		}
		// A new prompt is the user deciding what happens next, so the counter and the
		// stop it produced start over.
		if (this.#toolCallLoopStopGeneration !== undefined && !this.toolCallLoopStopped) {
			this.#toolCallLoopStopGeneration = undefined;
			this.#toolCallLoopGuard = undefined;
			this.#toolCallLoopGuardSettingsKey = undefined;
		}
		const threshold = this.#host.settings.get("model.toolCallLoopGuard.threshold");
		const hardLimit = this.#host.settings.get("model.toolCallLoopGuard.hardLimit");
		const exemptTools = this.#host.settings
			.get("model.toolCallLoopGuard.exemptTools")
			.filter((tool): tool is string => typeof tool === "string" && tool.length > 0);
		const settingsKey = `${threshold}:${hardLimit}:${JSON.stringify(exemptTools)}`;
		if (!this.#toolCallLoopGuard || this.#toolCallLoopGuardSettingsKey !== settingsKey) {
			this.#toolCallLoopGuard = new ToolCallLoopGuard({ threshold, exemptTools, hardLimit });
			this.#toolCallLoopGuardSettingsKey = settingsKey;
		}
		return this.#toolCallLoopGuard;
	}

	#injectToolCallLoopRedirect(messages: AgentMessage[], detection: RepeatedToolCallDetection): void {
		const content = renderToolCallLoopRedirect(detection);
		const details = {
			toolName: detection.toolName,
			count: detection.count,
			argumentsSummary: detection.argumentsSummary,
			resultSummary: detection.resultSummary,
		};
		logger.warn("cross-turn tool-call loop detected", { toolName: detection.toolName, count: detection.count });
		const redirectMessage: CustomMessage = {
			role: "custom",
			customType: TOOL_CALL_LOOP_REDIRECT_TYPE,
			content,
			display: false,
			details,
			attribution: "agent",
			timestamp: Date.now(),
		};
		messages.push(redirectMessage);
		if (this.#host.agent.state.messages !== messages) this.#host.agent.appendMessage(redirectMessage);
		this.#host.sessionManager.appendCustomMessageEntry(
			TOOL_CALL_LOOP_REDIRECT_TYPE,
			content,
			false,
			details,
			"agent",
		);
	}

	/**
	 * The steer alone cannot bound a model that ignores it, so the ceiling stops the
	 * run: no further provider request is made until the user steers.
	 */
	#stopToolCallLoop(detection: RepeatedToolCallDetection): void {
		if (this.toolCallLoopStopped) return;
		this.#toolCallLoopStopGeneration = this.#host.promptGeneration();
		const content = prompt.render(toolCallLoopStopTemplate, {
			tool_name: detection.toolName,
			count: detection.count,
			hard_limit: detection.hardLimit,
			arguments_summary: detection.argumentsSummary,
			result_summary: detection.resultSummary || "(no text result)",
		});
		const details = {
			toolName: detection.toolName,
			count: detection.count,
			hardLimit: detection.hardLimit,
			argumentsSummary: detection.argumentsSummary,
			resultSummary: detection.resultSummary,
		};
		logger.warn("tool-call loop hard limit reached; stopping the run", {
			toolName: detection.toolName,
			count: detection.count,
			hardLimit: detection.hardLimit,
		});
		this.#host.sessionManager.appendCustomMessageEntry(TOOL_CALL_LOOP_STOP_TYPE, content, false, details, "agent");
		this.#host.emitNotice(
			"warning",
			`Stopped: \`${detection.toolName}\` was called ${detection.count} times in a row with identical arguments.`,
			TOOL_CALL_LOOP_STOP_TYPE,
		);
		this.#host.agent.abort(`Tool-call loop guard: ${detection.toolName} repeated ${detection.count} times`);
	}

	#geminiHeaderGuardActive(): boolean {
		const model = this.#host.model();
		return (
			process.env.PI_NO_THINKING_LOOP_GUARD !== "1" &&
			this.#host.settings.get("model.loopGuard.enabled") === true &&
			this.#host.settings.get("model.loopGuard.toolCallReminder") === true &&
			model !== undefined &&
			modelFamilyToken(model.id) === "gemini"
		);
	}

	#interruptGeminiHeaderRunaway(headerCount: number, targetTimestamp: number): void {
		const model = this.#host.model();
		logger.warn("Gemini reasoning-header runaway; interrupting to require a tool call", {
			model: model?.id,
			provider: model?.provider,
			headers: headerCount,
		});
		this.#host.emitNotice(
			"warning",
			`Interrupted ${headerCount} planning headers with no tool call; reminded the model to issue one.`,
			"loop-guard",
		);
		this.#interruptWithReminder({
			targetTimestamp,
			reason: GEMINI_HEADER_INTERRUPT_REASON,
			customType: GEMINI_TOOL_REMINDER_TYPE,
			content: prompt.render(geminiToolReminderTemplate, { count: headerCount }),
			details: { headers: headerCount },
		});
	}

	#interruptWithReminder(options: {
		targetTimestamp: number;
		reason: string;
		customType: string;
		content: string;
		details: Record<string, unknown>;
	}): void {
		const { targetTimestamp, reason, customType, content, details } = options;
		this.#host.agent.abort(reason);
		const generation = this.#host.promptGeneration();
		this.#host.schedulePostPromptTask(async signal => {
			if (signal.aborted || this.#host.isDisposed() || this.#host.promptGeneration() !== generation) return;
			await this.#host.agent.waitForIdle();
			if (signal.aborted || this.#host.isDisposed() || this.#host.promptGeneration() !== generation) return;
			const aborted = this.#host.agent.state.messages.findLast(
				(message): message is AssistantMessage =>
					message.role === "assistant" && message.timestamp === targetTimestamp,
			);
			if (aborted) this.#host.discardAssistantTurn(aborted);
			this.#host.agent.appendMessage({
				role: "custom",
				customType,
				content,
				display: false,
				details,
				attribution: "agent",
				timestamp: Date.now(),
			});
			this.#host.sessionManager.appendCustomMessageEntry(customType, content, false, details, "agent");
			try {
				await this.#host.agent.continue();
			} catch (error) {
				logger.warn("stream guard reminder continue failed", { customType, error: String(error) });
			}
		});
	}
}
