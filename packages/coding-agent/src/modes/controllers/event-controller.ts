import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { type Component, Loader, TERMINAL } from "@oh-my-pi/pi-tui";
import { INTENT_FIELD, logger, prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import { settings } from "../../config/settings";
import { AssistantMessageComponent } from "../../modes/components/assistant-message";
import { detectCacheInvalidation } from "../../modes/components/cache-invalidation-marker";
import { ChecklistReminderComponent } from "../../modes/components/checklist-reminder";
import {
	groupedReadUsageCallIds,
	ReadToolGroupComponent,
	readArgsCollapseIntoGroup,
	readArgsHaveTarget,
} from "../../modes/components/read-tool-group";
import { ToolExecutionComponent, type ToolExecutionHandle } from "../../modes/components/tool-execution";
import { TtsrNotificationComponent } from "../../modes/components/ttsr-notification";
import { createUsageRowBlock } from "../../modes/components/usage-row";
import { getSymbolTheme, theme } from "../../modes/theme/theme";
import type { ChecklistPhase, InteractiveModeContext } from "../../modes/types";
import idleRecapPrompt from "../../prompts/system/recap-user.md" with { type: "text" };
import type { AgentSessionEvent } from "../../session/agent-session";
import { isUserInvokedSkillPrompt, readQueueChipText, resolveAbortLabel } from "../../session/messages";
import { nextActionableTask } from "../../tools/checklist";
import { previewLine, TRUNCATE_LENGTHS } from "../../tools/render-utils";
import { canonicalizeMessage } from "../../utils/thinking-display";
import { setTerminalTitleState } from "../../utils/title-generator";
import { interruptHint } from "../shared";
import { createAssistantMessageComponent } from "../utils/interactive-context-helpers";
import {
	assistantHasVisibleContent,
	assistantUsageIsBilled,
	extractDisplayInputText,
	resolveAssistantErrorPresentation,
	splitAssistantMessageToolTimeline,
} from "../utils/transcript-render-helpers";
import { isWarpCliAgentProtocolActive } from "../warp-events";
import { StreamingRevealController } from "./streaming-reveal";
import { decodeStreamedToolArgs, streamingStringKeysForTool, ToolArgsRevealController } from "./tool-args-reveal";

type AgentSessionEventKind = AgentSessionEvent["type"];
type AssistantContentBlock = AssistantMessage["content"][number];
type StreamedTimelineLocation =
	| { kind: "before"; index: number }
	| { kind: "after"; toolCallId: string; index: number };
type StreamedToolCallState = {
	id: string;
	name: string;
	partialJson: string | undefined;
	argumentsKey: string;
	rawInput: boolean;
};

const IRC_MESSAGE_VISIBLE_TTL_MS = 10_000;

const MAX_LIVE_IRC_CARDS = 4;
const IDLE_RECAP_MIN_SECONDS = 1;
const IDLE_RECAP_MAX_SECONDS = 3600;

const RAW_PARTIAL_JSON_RENDERERS: Record<string, true> = { bash: true };

function exposesRawPartialJson(toolName: string, rawInput: boolean, tool: unknown): boolean {
	if (rawInput) return true;
	if (RAW_PARTIAL_JSON_RENDERERS[toolName]) return true;
	if (tool === null || typeof tool !== "object" || !("renderCall" in tool)) return false;
	return typeof tool.renderCall === "function";
}

type AgentSessionEventHandlers = {
	[E in AgentSessionEventKind]: (event: Extract<AgentSessionEvent, { type: E }>) => Promise<void>;
};
export class EventController {
	#lastReadGroup: ReadToolGroupComponent | undefined = undefined;

	#renderedCustomMessages = new Set<string>();
	#lastIntent: string | undefined = undefined;

	#attentionToolCallIds = new Set<string>();
	#readToolCallArgs = new Map<string, Record<string, unknown>>();
	#readToolCallAssistantComponents = new Map<string, AssistantMessageComponent>();
	#toolTimelineComponents = new Map<string, Component>();

	#streamedToolCallIdByIndex = new Map<number, string>();
	#streamedToolCallStates = new Map<number, StreamedToolCallState>();
	#streamedContentBlockTypes = new Map<number, AssistantContentBlock["type"]>();
	#streamedTimelineLocations = new Map<number, StreamedTimelineLocation>();
	#streamedTimelineBeforeToolIndices: number[] = [];
	#streamedTimelineAfterToolIndices = new Map<string, number[]>();
	#streamedTimelineLastToolCallId: string | undefined;
	#streamedTimelineHasToolCalls = false;
	#streamedAssistantContentLength = 0;
	#streamedVisibleBlocks = new Map<number, boolean>();
	#streamedVisibleBlockCount = 0;

	#retractedToolCallIds = new Set<string>();
	#executionStartedCallIds = new Set<string>();

	#syntheticFailureCards = new Map<string, ToolExecutionHandle>();

	#orphanedToolCompletions = new Map<string, Extract<AgentSessionEvent, { type: "tool_execution_end" }>>();
	#postToolAssistantComponents = new Map<string, AssistantMessageComponent>();
	#lastAssistantComponent: AssistantMessageComponent | undefined = undefined;

	#pinnedErrorComponent: AssistantMessageComponent | undefined = undefined;
	#pinnedErrorMessage: AssistantMessage | undefined = undefined;
	#restorePinnedErrorInline = true;
	#retrySupersededAssistantComponents = new Map<string, AssistantMessageComponent>();
	#retrySupersededAssistantQueue: AssistantMessageComponent[] = [];

	#retryPending = false;
	#idleCompactionTimer?: NodeJS.Timeout;
	#idleRecapTimer?: NodeJS.Timeout;

	#idleRecapAbort?: AbortController;
	#ircExpiryTimers = new Map<string, NodeJS.Timeout>();

	#liveIrcCards = new Map<string, Component[]>();

	#displaceablePollComponent: ToolExecutionComponent | undefined = undefined;

	#displaceableChecklistComponent: ToolExecutionComponent | undefined = undefined;

	#lastTtsrNotification: TtsrNotificationComponent | undefined = undefined;
	#streamingReveal: StreamingRevealController;
	#toolArgsReveal: ToolArgsRevealController;
	#prevHideThinking = false;
	#handlers: AgentSessionEventHandlers;
	#terminalProgressActive = false;

	#pendingMessageUpdate: Extract<AgentSessionEvent, { type: "message_update" }> | undefined = undefined;
	#messageUpdateTimer: NodeJS.Timeout | undefined = undefined;

	#dispatchTail: Promise<void> = Promise.resolve();

	#dispatchInFlight = false;
	#transcriptAnchor = 0;
	static readonly #MESSAGE_UPDATE_COALESCE_MS = 33;

	constructor(private ctx: InteractiveModeContext) {
		this.#streamingReveal = new StreamingRevealController({
			getSmoothStreaming: () => this.ctx.settings.get("display.smoothStreaming"),
			getHideThinkingBlock: () => this.ctx.effectiveHideThinkingBlock,
			getProseOnlyThinking: () => this.ctx.proseOnlyThinking,
			requestRender: component => this.ctx.ui.requestComponentRender(component),
		});
		this.#toolArgsReveal = new ToolArgsRevealController({
			getSmoothStreaming: () => this.ctx.settings.get("display.smoothStreaming"),
			requestRender: component => this.ctx.ui.requestComponentRender(component),
		});
		this.#handlers = {
			agent_start: e => this.#handleAgentStart(e),
			agent_end: e => this.#handleAgentEnd(e),
			turn_start: async () => {},
			turn_end: async () => {},
			message_start: e => this.#handleMessageStart(e),
			message_update: e => this.#handleMessageUpdate(e),
			message_end: e => this.#handleMessageEnd(e),
			tool_execution_start: e => this.#handleToolExecutionStart(e),
			tool_execution_update: e => this.#handleToolExecutionUpdate(e),
			tool_execution_end: e => this.#handleToolExecutionEnd(e),
			auto_compaction_start: e => this.#handleAutoCompactionStart(e),
			auto_compaction_end: e => this.#handleAutoCompactionEnd(e),
			auto_retry_start: e => this.#handleAutoRetryStart(e),
			auto_retry_end: e => this.#handleAutoRetryEnd(e),
			retry_fallback_applied: e => this.#handleRetryFallbackApplied(e),
			retry_fallback_succeeded: e => this.#handleRetryFallbackSucceeded(e),
			ttsr_triggered: e => this.#handleTtsrTriggered(e),
			checklist_reminder: e => this.#handleChecklistReminder(e),
			checklist_auto_clear: e => this.#handleChecklistAutoClear(e),
			irc_message: e => this.#handleIrcMessage(e),
			notice: e => this.#handleNotice(e),
			model_changed: async () => {
				this.ctx.statusLine.invalidate();
				this.ctx.ui.requestRender();
			},
			thinking_level_changed: async () => {
				this.ctx.statusLine.invalidate();
				this.ctx.updateEditorBorderColor();
				const hideThinking = this.ctx.effectiveHideThinkingBlock;

				if (hideThinking === this.#prevHideThinking) {
					this.ctx.ui.requestRender();
					return;
				}
				this.#prevHideThinking = hideThinking;

				for (const child of this.ctx.chatContainer.children) {
					if (child instanceof AssistantMessageComponent) {
						child.setHideThinkingBlock(hideThinking);
					}
				}
				if (this.ctx.streamingComponent && this.ctx.streamingMessage) {
					this.ctx.streamingComponent.setHideThinkingBlock(hideThinking);
					this.#streamingReveal.resyncVisibility();
				}
				this.ctx.ui.resetDisplay();
			},
			goal_updated: async () => {},
		} satisfies AgentSessionEventHandlers;
	}

	dispose(): void {
		if (this.#messageUpdateTimer) {
			clearTimeout(this.#messageUpdateTimer);
			this.#messageUpdateTimer = undefined;
		}
		this.#pendingMessageUpdate = undefined;
		this.#streamingReveal.stop();
		this.#toolArgsReveal.stop();
		this.#cancelIdleCompaction();
		this.#cancelIdleRecap();
		this.#setTerminalProgress(false);
		for (const timer of this.#ircExpiryTimers.values()) {
			clearTimeout(timer);
		}
		this.#ircExpiryTimers.clear();
		this.#liveIrcCards.clear();
	}

	#resetStreamingAssistantState(): void {
		this.#streamedToolCallIdByIndex.clear();
		this.#streamedToolCallStates.clear();
		this.#streamedContentBlockTypes.clear();
		this.#streamedTimelineLocations.clear();
		this.#streamedTimelineBeforeToolIndices = [];
		this.#streamedTimelineAfterToolIndices.clear();
		this.#streamedTimelineLastToolCallId = undefined;
		this.#streamedTimelineHasToolCalls = false;
		this.#streamedAssistantContentLength = 0;
		this.#streamedVisibleBlocks.clear();
		this.#streamedVisibleBlockCount = 0;
	}

	#streamedArgumentsKey(argumentsValue: unknown): string {
		try {
			return JSON.stringify(argumentsValue) ?? String(argumentsValue);
		} catch {
			return String(argumentsValue);
		}
	}

	#streamedToolCallChanged(index: number, content: Extract<AssistantContentBlock, { type: "toolCall" }>): boolean {
		const partialJson = getStreamingPartialJson(content);
		const rawInput = content.customWireName !== undefined;
		const state: StreamedToolCallState = {
			id: content.id,
			name: content.name,
			partialJson,
			argumentsKey: this.#streamedArgumentsKey(content.arguments),
			rawInput,
		};
		const previous = this.#streamedToolCallStates.get(index);
		if (
			previous &&
			previous.id === state.id &&
			previous.name === state.name &&
			previous.partialJson === state.partialJson &&
			previous.argumentsKey === state.argumentsKey &&
			previous.rawInput === state.rawInput
		) {
			return false;
		}
		this.#streamedToolCallStates.set(index, state);
		return true;
	}

	#recordStreamingTimelineBlock(
		index: number,
		content: AssistantContentBlock,
		changedAfterToolCallIds: Set<string>,
	): void {
		if (content.type === "toolCall") {
			this.#streamedTimelineHasToolCalls = true;
			if (!this.#streamedContentBlockTypes.has(index)) this.#streamedTimelineLastToolCallId = content.id;
			return;
		}

		let location = this.#streamedTimelineLocations.get(index);
		if (!location) {
			if (this.#streamedTimelineLastToolCallId === undefined) {
				location = { kind: "before", index };
			} else {
				const segment = this.#streamedTimelineAfterToolIndices.get(this.#streamedTimelineLastToolCallId) ?? [];
				location = { kind: "after", toolCallId: this.#streamedTimelineLastToolCallId, index: segment.length };
			}
			this.#streamedTimelineLocations.set(index, location);
		}

		if (location.kind === "before") {
			this.#streamedTimelineBeforeToolIndices[location.index] = index;
			return;
		}
		const segment = this.#streamedTimelineAfterToolIndices.get(location.toolCallId) ?? [];
		segment[location.index] = index;
		this.#streamedTimelineAfterToolIndices.set(location.toolCallId, segment);
		changedAfterToolCallIds.add(location.toolCallId);
	}

	// Blocks are read out of the live message: each update is a fresh snapshot that shares
	// untouched blocks, so a cached block is a frozen copy of the text it held back then.
	#streamedTimelineSegment(message: AssistantMessage, indices: readonly number[]): AssistantMessage {
		const content: AssistantMessage["content"] = [];
		for (const index of indices) {
			const block = message.content[index];
			if (block) content.push(block);
		}
		return {
			...message,
			content,
			stopReason: "stop",
			errorMessage: undefined,
			retryRecovery: undefined,
		};
	}

	#resetReadGroup(): void {
		this.#lastReadGroup?.finalize();
		this.#lastReadGroup = undefined;
	}

	#getReadGroup(): ReadToolGroupComponent {
		if (!this.#lastReadGroup) {
			const group = new ReadToolGroupComponent({
				showContentPreview: this.ctx.settings.get("read.toolResultPreview"),
			});
			group.setExpanded(this.ctx.toolOutputExpanded);
			this.ctx.chatContainer.addChild(group);
			this.#lastReadGroup = group;
		}
		return this.#lastReadGroup;
	}

	#trackReadToolCall(toolCallId: string, args: unknown): void {
		if (!toolCallId) return;
		const normalizedArgs =
			args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
		this.#readToolCallArgs.set(toolCallId, normalizedArgs);
		const assistantComponent = this.ctx.streamingComponent ?? this.#lastAssistantComponent;
		if (assistantComponent) {
			this.#readToolCallAssistantComponents.set(toolCallId, assistantComponent);
		}
	}

	#clearReadToolCall(toolCallId: string): void {
		this.#readToolCallArgs.delete(toolCallId);
		this.#readToolCallAssistantComponents.delete(toolCallId);
	}

	#retractToolCardEntry(toolCallId: string, component: ToolExecutionHandle): void {
		component.seal();
		let removeComponent = true;
		if (component instanceof ReadToolGroupComponent) {
			removeComponent = component.removeEntry(toolCallId);
			if (component === this.#lastReadGroup) this.#resetReadGroup();
		}
		if (removeComponent) this.ctx.chatContainer.disposeAndRemoveChild(component);
		this.ctx.pendingTools.delete(toolCallId);
		this.#toolTimelineComponents.delete(toolCallId);
		this.#clearReadToolCall(toolCallId);
	}

	#detachToolCardForRendererMigration(toolCallId: string, component: ToolExecutionHandle): number | undefined {
		const componentIndex = this.ctx.chatContainer.children.indexOf(component);
		const replacementIndex = componentIndex >= 0 ? componentIndex : undefined;
		if (component instanceof ReadToolGroupComponent) {
			const removeGroup = component.removeEntry(toolCallId);
			if (component === this.#lastReadGroup) this.#resetReadGroup();
			if (removeGroup) {
				this.ctx.chatContainer.disposeAndRemoveChild(component);
			}
		} else {
			this.ctx.chatContainer.disposeAndRemoveChild(component);
		}
		this.ctx.pendingTools.delete(toolCallId);
		this.#toolTimelineComponents.delete(toolCallId);
		this.#clearReadToolCall(toolCallId);
		return replacementIndex;
	}

	#moveTranscriptComponent(component: Component, index: number | undefined): void {
		if (index === undefined) return;
		const children = this.ctx.chatContainer.children;
		const currentIndex = children.indexOf(component);
		if (currentIndex < 0 || currentIndex === index) return;
		children.splice(currentIndex, 1);
		children.splice(Math.min(index, children.length), 0, component);
	}

	#migrateStreamedToolCallId(oldId: string, newId: string): void {
		if (oldId === newId || !newId) return;
		const pending = this.ctx.pendingTools.get(oldId);
		if (pending && !this.ctx.pendingTools.has(newId)) {
			this.ctx.pendingTools.delete(oldId);
			this.ctx.pendingTools.set(newId, pending);
		}
		const timeline = this.#toolTimelineComponents.get(oldId);
		if (timeline && !this.#toolTimelineComponents.has(newId)) {
			this.#toolTimelineComponents.delete(oldId);
			this.#toolTimelineComponents.set(newId, timeline);
		}

		this.#toolArgsReveal.finish(oldId);
		if (this.#executionStartedCallIds.delete(oldId)) {
			this.#executionStartedCallIds.add(newId);
		}
		const readArgs = this.#readToolCallArgs.get(oldId);
		if (readArgs !== undefined) {
			this.#readToolCallArgs.delete(oldId);
			this.#readToolCallArgs.set(newId, readArgs);
		}
		const readAssistant = this.#readToolCallAssistantComponents.get(oldId);
		if (readAssistant !== undefined) {
			this.#readToolCallAssistantComponents.delete(oldId);
			this.#readToolCallAssistantComponents.set(newId, readAssistant);
		}

		if (pending instanceof ReadToolGroupComponent) pending.renameEntry(oldId, newId);

		if (pending) {
			const orphan = this.#orphanedToolCompletions.get(newId);
			if (orphan) {
				this.#orphanedToolCompletions.delete(newId);
				this.#settleHeldCompletion(pending, orphan);
			}
		}
	}

	#inlineReadToolImages(
		toolCallId: string,
		result: { content: Array<{ type: string; data?: string; mimeType?: string }> },
	): boolean {
		const assistantComponent = this.#readToolCallAssistantComponents.get(toolCallId);
		if (!assistantComponent) return false;
		const images: ImageContent[] = result.content
			.filter(
				(content): content is ImageContent =>
					content.type === "image" && typeof content.data === "string" && typeof content.mimeType === "string",
			)
			.map(content => ({ type: "image", data: content.data, mimeType: content.mimeType }));
		if (images.length === 0) return false;
		assistantComponent.setToolResultImages(toolCallId, images);
		return settings.get("terminal.showImages");
	}

	#insertAfterTranscriptComponent(anchor: Component | undefined, component: Component): boolean {
		const children = this.ctx.chatContainer.children;
		const anchorIndex = anchor ? children.indexOf(anchor) : -1;
		if (anchorIndex < 0) return false;
		if (children.slice(anchorIndex + 1).some(child => !this.ctx.chatContainer.isBlockUncommitted(child))) {
			return false;
		}
		this.ctx.chatContainer.addChild(component);
		children.splice(children.length - 1, 1);
		children.splice(anchorIndex + 1, 0, component);
		return true;
	}

	#upsertPostToolAssistantSegment(
		toolCallId: string,
		segment: AssistantMessage | undefined,
	): AssistantMessageComponent | undefined {
		if (!segment || !assistantHasVisibleContent(segment)) return undefined;
		const existing = this.#postToolAssistantComponents.get(toolCallId);
		if (existing) {
			existing.updateContent(segment);
			if (!this.ctx.chatContainer.children.includes(existing)) {
				if (!this.#insertAfterTranscriptComponent(this.#toolTimelineComponents.get(toolCallId), existing)) {
					this.ctx.chatContainer.addChild(existing);
				}
			}
			return existing;
		}
		const component = createAssistantMessageComponent(this.ctx);
		component.updateContent(segment);
		this.#postToolAssistantComponents.set(toolCallId, component);
		if (!this.#insertAfterTranscriptComponent(this.#toolTimelineComponents.get(toolCallId), component)) {
			this.ctx.chatContainer.addChild(component);
		}
		return component;
	}

	#updateWorkingMessageFromIntent(intent: unknown): void {
		if (this.ctx.session.isAborting) return;

		if (typeof intent !== "string") return;
		const trimmed = intent.trim();
		if (!trimmed || trimmed === this.#lastIntent) return;
		this.#lastIntent = trimmed;
		this.ctx.setWorkingMessage(`${trimmed}${interruptHint()}`);
	}

	subscribeToAgent(): void {
		this.ctx.unsubscribe = this.ctx.session.subscribe(async (event: AgentSessionEvent) => {
			await this.dispatchEvent(event);
		});
	}

	async dispatchEvent(event: AgentSessionEvent, transcriptAnchor = this.#transcriptAnchor): Promise<void> {
		if (transcriptAnchor !== this.#transcriptAnchor) return;
		if (event.type === "message_update") {
			this.#enqueueMessageUpdate(event, transcriptAnchor);
			return;
		}
		await this.#runSerialized(async () => {
			if (transcriptAnchor !== this.#transcriptAnchor) return;
			await this.#flushPendingMessageUpdate(transcriptAnchor);
			if (transcriptAnchor !== this.#transcriptAnchor) return;
			await this.handleEvent(event, transcriptAnchor);
		});
	}

	async #runSerialized(run: () => Promise<void>): Promise<void> {
		if (this.#dispatchInFlight) {
			const link = this.#dispatchTail.then(
				() => run(),
				() => run(),
			);
			this.#dispatchTail = link;
			void link.then(
				() => {
					if (this.#dispatchTail === link) this.#dispatchInFlight = false;
				},
				() => {
					if (this.#dispatchTail === link) this.#dispatchInFlight = false;
				},
			);
			await link;
			return;
		}
		this.#dispatchInFlight = true;
		const link = run();
		this.#dispatchTail = link;
		void link.then(
			() => {
				if (this.#dispatchTail === link) this.#dispatchInFlight = false;
			},
			() => {
				if (this.#dispatchTail === link) this.#dispatchInFlight = false;
			},
		);
		await link;
	}

	#enqueueMessageUpdate(
		event: Extract<AgentSessionEvent, { type: "message_update" }>,
		transcriptAnchor: number,
	): void {
		if (transcriptAnchor !== this.#transcriptAnchor) return;
		this.#pendingMessageUpdate = event;
		if (this.#messageUpdateTimer) return;
		const timer = setTimeout(() => {
			if (this.#messageUpdateTimer !== timer) return;
			this.#messageUpdateTimer = undefined;

			void this.#runSerialized(async () => {
				if (transcriptAnchor !== this.#transcriptAnchor) return;
				await this.#flushPendingMessageUpdate(transcriptAnchor);
			}).catch(err => {
				logger.warn("Message update flush rejected", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}, EventController.#MESSAGE_UPDATE_COALESCE_MS);
		this.#messageUpdateTimer = timer;
	}

	async #flushPendingMessageUpdate(transcriptAnchor: number): Promise<void> {
		if (transcriptAnchor !== this.#transcriptAnchor) return;
		if (this.#messageUpdateTimer) {
			clearTimeout(this.#messageUpdateTimer);
			this.#messageUpdateTimer = undefined;
		}
		const event = this.#pendingMessageUpdate;
		if (!event) return;
		this.#pendingMessageUpdate = undefined;
		await this.handleEvent(event, transcriptAnchor);
	}

	hasToolExecutionStarted(toolCallId: string): boolean {
		return this.#executionStartedCallIds.has(toolCallId);
	}

	getLivePostToolAssistantComponents(): readonly Component[] {
		if (!this.ctx.streamingMessage) return [];
		return [...this.#postToolAssistantComponents.values()];
	}

	resetTranscriptAnchors(): number {
		this.#transcriptAnchor++;
		if (this.#messageUpdateTimer) {
			clearTimeout(this.#messageUpdateTimer);
			this.#messageUpdateTimer = undefined;
		}
		this.#pendingMessageUpdate = undefined;
		this.#resetReadGroup();
		this.#resetStreamingAssistantState();
		this.#renderedCustomMessages.clear();
		this.#lastIntent = undefined;
		this.#toolTimelineComponents.clear();
		this.#retractedToolCallIds.clear();
		this.#executionStartedCallIds.clear();
		this.#syntheticFailureCards.clear();
		this.#orphanedToolCompletions.clear();
		this.#postToolAssistantComponents.clear();
		this.#attentionToolCallIds.clear();
		this.#readToolCallArgs.clear();
		this.#readToolCallAssistantComponents.clear();
		this.#lastAssistantComponent = undefined;
		this.#pinnedErrorComponent = undefined;
		this.#pinnedErrorMessage = undefined;
		this.#restorePinnedErrorInline = true;
		this.#retryPending = this.ctx.viewSession.isRetrying;
		this.#cancelIdleCompaction();
		this.#cancelIdleRecap();
		for (const timer of this.#ircExpiryTimers.values()) {
			clearTimeout(timer);
		}
		this.#ircExpiryTimers.clear();
		this.#liveIrcCards.clear();
		this.#displaceablePollComponent = undefined;
		this.#displaceableChecklistComponent = undefined;
		this.#lastTtsrNotification = undefined;
		this.#streamingReveal.stop();
		this.#toolArgsReveal.stop();
		return this.#transcriptAnchor;
	}

	async handleEvent(event: AgentSessionEvent, transcriptAnchor = this.#transcriptAnchor): Promise<void> {
		if (transcriptAnchor !== this.#transcriptAnchor) return;
		if (!this.ctx.isInitialized) {
			await this.ctx.init();
			if (transcriptAnchor !== this.#transcriptAnchor) return;
		}

		const run = this.#handlers[event.type] as (e: AgentSessionEvent) => Promise<void>;
		await run(event);
	}

	#setTerminalProgress(active: boolean): void {
		if (active) {
			if (this.#terminalProgressActive || this.ctx.settings?.get("terminal.showProgress") !== true) return;
			this.ctx.ui.terminal.setProgress(true);
			this.#terminalProgressActive = true;
			return;
		}
		if (!this.#terminalProgressActive) return;
		this.ctx.ui.terminal.setProgress(false);
		this.#terminalProgressActive = false;
	}

	#trackRetrySupersededAssistantComponent(component: AssistantMessageComponent | undefined): void {
		if (!component) return;
		const persistenceKey = component.messagePersistenceKey();
		if (persistenceKey) this.#retrySupersededAssistantComponents.set(persistenceKey, component);
		if (!this.#retrySupersededAssistantQueue.includes(component)) {
			this.#retrySupersededAssistantQueue.push(component);
		}
	}

	#takeRetrySupersededAssistantComponent(persistenceKey: string | undefined): AssistantMessageComponent | undefined {
		if (persistenceKey) {
			const component = this.#retrySupersededAssistantComponents.get(persistenceKey);
			if (component) {
				this.#retrySupersededAssistantComponents.delete(persistenceKey);
				this.#retrySupersededAssistantQueue = this.#retrySupersededAssistantQueue.filter(
					item => item !== component,
				);
				return component;
			}
		}
		while (this.#retrySupersededAssistantQueue.length > 0) {
			const component = this.#retrySupersededAssistantQueue.shift();
			if (!component) continue;
			const key = component.messagePersistenceKey();
			if (key && this.#retrySupersededAssistantComponents.get(key) !== component) continue;
			if (key) this.#retrySupersededAssistantComponents.delete(key);
			return component;
		}
		return undefined;
	}

	#clearRetrySupersededAssistantComponents(): void {
		this.#retrySupersededAssistantComponents.clear();
		this.#retrySupersededAssistantQueue = [];
	}

	async #handleAgentStart(_event: Extract<AgentSessionEvent, { type: "agent_start" }>): Promise<void> {
		this.#resetStreamingAssistantState();
		this.#toolTimelineComponents.clear();
		this.#retractedToolCallIds.clear();
		this.#executionStartedCallIds.clear();
		this.#syntheticFailureCards.clear();
		this.#orphanedToolCompletions.clear();
		this.#postToolAssistantComponents.clear();
		this.#lastIntent = undefined;
		this.#readToolCallArgs.clear();
		this.#readToolCallAssistantComponents.clear();
		this.#resetReadGroup();
		this.#resolveDisplaceableChecklist();
		this.#lastAssistantComponent = undefined;

		if (this.#restorePinnedErrorInline) this.#pinnedErrorComponent?.setErrorPinned(false);
		this.#pinnedErrorComponent = undefined;
		this.#pinnedErrorMessage = undefined;
		this.#restorePinnedErrorInline = true;
		this.ctx.clearPinnedError();
		if (this.ctx.retryLoader) {
			this.ctx.retryLoader.stop();
			this.ctx.retryLoader = undefined;
			this.ctx.statusContainer.disposeChildren();
		}
		this.#cancelIdleCompaction();
		this.#cancelIdleRecap();
		this.ctx.statusLine.markActivityStart();
		this.#setTerminalProgress(true);
		this.ctx.ensureLoadingAnimation();
		setTerminalTitleState("working");
		this.ctx.ui.requestRender();
	}

	async #handleMessageStart(event: Extract<AgentSessionEvent, { type: "message_start" }>): Promise<void> {
		this.#ensureWorkingLoaderWhileStreaming();
		if (event.message.role === "assistant") this.#updateWorkingSpinnerFrames(event.message);
		if (event.message.role === "hookMessage" || event.message.role === "custom") {
			const signature = this.#customMessageSignature(event.message);
			if (this.#renderedCustomMessages.has(signature)) {
				return;
			}
			this.#renderedCustomMessages.add(signature);
			this.#resetReadGroup();
			if (
				event.message.role === "custom" &&
				this.ctx.optimisticSkillMessagePending &&
				isUserInvokedSkillPrompt(event.message)
			) {
				this.ctx.reconcileOptimisticSkillMessage(event.message);
			} else {
				this.ctx.addMessageToChat(event.message);
			}

			if (event.message.role === "custom" && readQueueChipText(event.message.details)) {
				this.ctx.updatePendingMessagesDisplay();
			}
			this.ctx.ui.requestRender();
		} else if (event.message.role === "developer") {
			this.#resetReadGroup();
			this.#resolveDisplaceablePoll();
			this.#resolveDisplaceableChecklist();
			this.ctx.addMessageToChat(event.message);
			this.ctx.ui.requestRender();
		} else if (event.message.role === "user") {
			const textContent = extractDisplayInputText(event.message);
			const imageBlocks =
				typeof event.message.content === "string"
					? []
					: event.message.content.filter(
							(content): content is ImageContent =>
								content.type === "image" &&
								typeof content.data === "string" &&
								typeof content.mimeType === "string",
						);
			const imageCount = imageBlocks.length;
			const signature = `${textContent}\u0000${imageCount}`;

			this.#resetReadGroup();
			this.#resolveDisplaceablePoll();
			this.#resolveDisplaceableChecklist();
			const wasOptimistic = this.ctx.optimisticUserMessageSignature === signature;
			const matchedLocalSubmission = this.ctx.locallySubmittedUserSignatures.delete(signature);
			const replacesOptimistic =
				this.ctx.optimisticUserMessageSignature !== undefined && !wasOptimistic && !matchedLocalSubmission;
			const wasLocallySubmitted = matchedLocalSubmission || wasOptimistic || replacesOptimistic;
			if (wasOptimistic) {
				this.ctx.clearOptimisticUserMessage();
			} else if (replacesOptimistic) {
				this.ctx.replaceOptimisticUserMessage(event.message);
			} else {
				this.ctx.addMessageToChat(event.message);
			}

			if (!event.message.synthetic) {
				if (!wasLocallySubmitted) {
					this.ctx.editor.setText("");
				}
				this.ctx.updatePendingMessagesDisplay();
			}
			this.ctx.ui.requestRender();
		} else if (event.message.role === "fileMention") {
			this.#resetReadGroup();
			this.ctx.addMessageToChat(event.message);
			this.ctx.ui.requestRender();
		} else if (event.message.role === "assistant") {
			this.#resetStreamingAssistantState();
			this.ctx.streamingComponent = createAssistantMessageComponent(this.ctx);
			this.ctx.streamingMessage = event.message;
			this.#updateWorkingSpinnerFrames(event.message);
			this.ctx.chatContainer.addChild(this.ctx.streamingComponent);
			this.#streamingReveal.begin(
				this.ctx.streamingComponent,
				splitAssistantMessageToolTimeline(this.ctx.streamingMessage).beforeTools,
			);
			this.ctx.ui.requestRender();
		}
	}

	// One dedupe signature for every path that renders a custom record
	// (message_start events, irc_message events, deferred flush replays).
	// Same-millisecond distinct records must not collide, and the same record
	// delivered through two event types must dedupe: prefer the stable IRC
	// details.id, then fall back to a deterministic content fingerprint.
	#customMessageSignature(message: {
		role: string;
		customType: string;
		timestamp: number;
		content: unknown;
		details?: unknown;
	}): string {
		// Only IRC records have immutable delivery ids: the same record
		// arrives as irc_message and then through message_start. Extension
		// progress records reuse generic ids (e.g. job counters) where id
		// equality does NOT imply content equality.
		if (message.customType.startsWith("irc:")) {
			const details = (message.details ?? {}) as { id?: unknown };
			if (typeof details.id === "string" && details.id.length > 0) {
				return `${message.role}:${message.customType}:id:${details.id}`;
			}
		}
		const contentText = JSON.stringify(message.content ?? null);
		return `${message.role}:${message.customType}:${message.timestamp}:${contentText.length}:${Bun.hash(contentText)}`;
	}

	async #handleIrcMessage(event: Extract<AgentSessionEvent, { type: "irc_message" }>): Promise<void> {
		const signature = this.#customMessageSignature(event.message);
		if (this.#renderedCustomMessages.has(signature)) {
			return;
		}
		this.#renderedCustomMessages.add(signature);
		this.#resetReadGroup();
		const components = this.ctx.addMessageToChat(event.message);
		this.#scheduleIrcExpiry(signature, components);
		this.#enforceIrcCardCap(signature);
		this.ctx.ui.requestRender();
	}

	#scheduleIrcExpiry(signature: string, components: Component[]): void {
		if (components.length === 0 || this.#ircExpiryTimers.has(signature)) return;
		const timer = setTimeout(() => {
			this.#ircExpiryTimers.delete(signature);
			this.#retireIrcCard(signature);
		}, IRC_MESSAGE_VISIBLE_TTL_MS);
		timer.unref?.();
		this.#ircExpiryTimers.set(signature, timer);
		this.#liveIrcCards.set(signature, components);
	}

	#retireIrcCard(signature: string): void {
		const components = this.#liveIrcCards.get(signature);
		this.#liveIrcCards.delete(signature);
		if (!components) return;
		let removed = false;
		for (const component of components) {
			if (!this.ctx.chatContainer.isBlockUncommitted(component)) continue;
			this.ctx.chatContainer.disposeAndRemoveChild(component);
			removed = true;
		}
		if (removed) this.ctx.ui.requestRender();
	}

	#enforceIrcCardCap(latestSignature: string): void {
		while (this.#liveIrcCards.size > MAX_LIVE_IRC_CARDS) {
			const oldest = this.#liveIrcCards.keys().next().value;
			if (oldest === undefined || oldest === latestSignature) return;
			const timer = this.#ircExpiryTimers.get(oldest);
			if (timer) {
				clearTimeout(timer);
				this.#ircExpiryTimers.delete(oldest);
			}
			this.#retireIrcCard(oldest);
		}
	}

	#resolveDisplaceablePoll(nextToolName?: string): void {
		const previous = this.#displaceablePollComponent;
		if (!previous) return;
		this.#displaceablePollComponent = undefined;
		if (
			nextToolName === "fleet" &&
			previous.isDisplaceableBlock() &&
			this.ctx.chatContainer.isBlockUncommitted(previous)
		) {
			this.ctx.chatContainer.disposeAndRemoveChild(previous);
		}

		previous.seal();
		this.ctx.ui.requestRender();
	}

	#resolveDisplaceableChecklist(nextToolName?: string): void {
		const previous = this.#displaceableChecklistComponent;
		if (!previous) return;
		if (!previous.isDisplaceableBlock()) {
			this.#displaceableChecklistComponent = undefined;
			return;
		}
		if (previous.canBeDisplacedBy(nextToolName)) {
			this.#displaceableChecklistComponent = undefined;
			if (this.ctx.chatContainer.isBlockUncommitted(previous)) {
				this.ctx.chatContainer.disposeAndRemoveChild(previous);
			}
			previous.seal();
			this.ctx.ui.requestRender();
			return;
		}
		if (nextToolName !== undefined) return;
		this.#displaceableChecklistComponent = undefined;
		previous.seal();
		this.ctx.ui.requestRender();
	}

	inheritDisplaceableChecklist(component: ToolExecutionComponent | null | undefined): void {
		this.#displaceableChecklistComponent = component?.canBeDisplacedBy("checklist") ? component : undefined;
	}

	async #handleNotice(event: Extract<AgentSessionEvent, { type: "notice" }>): Promise<void> {
		const message = event.source ? `${event.source}: ${event.message}` : event.message;
		if (event.level === "error") {
			this.ctx.showError(message);
		} else if (event.level === "warning") {
			this.ctx.showWarning(message);
		} else {
			this.ctx.showStatus(message);
		}
	}

	#updateStreamingVisibleBlock(index: number, content: AssistantContentBlock): number {
		const visible =
			(content.type === "text" && canonicalizeMessage(content.text).length > 0) ||
			(content.type === "thinking" && canonicalizeMessage(content.thinking).length > 0);
		const previous = this.#streamedVisibleBlocks.get(index);
		if (previous === visible) return 0;
		this.#streamedVisibleBlocks.set(index, visible);
		return visible ? 1 : -1;
	}

	#updateStreamingToolIntent(content: Extract<AssistantContentBlock, { type: "toolCall" }>): void {
		const args = content.arguments;
		if (!args || typeof args !== "object") return;
		if (INTENT_FIELD in args) {
			this.#updateWorkingMessageFromIntent((args as Record<string, unknown>)[INTENT_FIELD]);
			return;
		}
		const tool = this.ctx.viewSession.getToolByName(content.name);
		if (typeof tool?.intent !== "function") return;
		try {
			const derived = tool.intent(args as never)?.trim();
			if (derived) this.#updateWorkingMessageFromIntent(derived);
		} catch {}
	}

	#processStreamingToolCall(
		contentIndex: number,
		content: Extract<AssistantContentBlock, { type: "toolCall" }>,
	): void {
		const priorId = this.#streamedToolCallIdByIndex.get(contentIndex);
		if (priorId !== undefined && priorId !== content.id) {
			this.#migrateStreamedToolCallId(priorId, content.id);
		}
		this.#streamedToolCallIdByIndex.set(contentIndex, content.id);

		let renderArgs: Record<string, unknown>;
		let classificationArgs = content.arguments;
		const partialJson = getStreamingPartialJson(content);
		const rawInput = content.customWireName !== undefined;
		const tool = this.ctx.viewSession.getToolByName(content.name);
		const streamingStringKeys = streamingStringKeysForTool(content.name, rawInput);
		if (partialJson !== undefined) {
			classificationArgs = decodeStreamedToolArgs(partialJson, {
				rawInput,
				fullArgs: content.arguments,
				streamingStringKeys,
			});
			renderArgs = this.#toolArgsReveal.setTarget(content.id, partialJson, {
				rawInput,
				exposeRawPartialJson: exposesRawPartialJson(content.name, rawInput, tool),
				streamingStringKeys,
			});
		} else {
			this.#toolArgsReveal.finish(content.id);
			renderArgs = content.arguments;
		}

		let replacementIndex: number | undefined;
		if (content.name === "read") {
			if (!readArgsHaveTarget(classificationArgs)) return;
			if (readArgsCollapseIntoGroup(classificationArgs)) {
				let component = this.ctx.pendingTools.get(content.id);
				if (component && !(component instanceof ReadToolGroupComponent)) {
					replacementIndex = this.#detachToolCardForRendererMigration(content.id, component);
					component = undefined;
				}
				if (!component) this.#resolveDisplaceablePoll(content.name);
				this.#trackReadToolCall(content.id, classificationArgs);
				if (component) {
					component.updateArgs(renderArgs, content.id);
					this.#toolArgsReveal.bind(content.id, component);
				} else {
					const group = this.#getReadGroup();
					group.updateArgs(renderArgs, content.id);
					this.ctx.pendingTools.set(content.id, group);
					this.#toolTimelineComponents.set(content.id, group);
					this.#toolArgsReveal.bind(content.id, group);
					this.#moveTranscriptComponent(group, replacementIndex);
				}
				return;
			}

			const component = this.ctx.pendingTools.get(content.id);
			if (component instanceof ReadToolGroupComponent) {
				replacementIndex = this.#detachToolCardForRendererMigration(content.id, component);
			}
		}

		if (!this.ctx.pendingTools.has(content.id) && !this.#toolTimelineComponents.has(content.id)) {
			this.#resolveDisplaceablePoll(content.name);
			this.#resetReadGroup();
			const component = new ToolExecutionComponent(
				content.name,
				renderArgs,
				{
					useBuiltInRenderer: this.ctx.viewSession.hasBuiltInTool(content.name),
					showImages: settings.get("terminal.showImages"),
				},
				tool,
				this.ctx.ui,
			);
			component.setExpanded(this.ctx.toolOutputExpanded);
			this.ctx.chatContainer.addChild(component);
			this.#moveTranscriptComponent(component, replacementIndex);
			this.ctx.pendingTools.set(content.id, component);
			this.#toolTimelineComponents.set(content.id, component);
			this.#toolArgsReveal.bind(content.id, component);

			const orphan = this.#orphanedToolCompletions.get(content.id);
			if (orphan) {
				this.#orphanedToolCompletions.delete(content.id);
				this.#settleHeldCompletion(component, orphan);
			}
		} else {
			const component = this.ctx.pendingTools.get(content.id);
			if (component) {
				component.updateArgs(renderArgs, content.id);
				this.#toolArgsReveal.bind(content.id, component);
			}
		}
	}

	// Assistant updates carry the cumulative message plus the changed content index. Keep the
	// timeline/cache state incremental for deltas; message_end invokes the authoritative full pass.
	// Updates are coalesced, so the surviving event can report a newly opened block while the block
	// that was streaming before it also grew: that one is revisited too.
	#processAssistantMessageUpdate(message: AssistantMessage, changedContentIndex?: number, fullPass = false): void {
		if (fullPass) this.#resetStreamingAssistantState();
		if (!fullPass && message.content.length < this.#streamedAssistantContentLength) {
			this.#resetStreamingAssistantState();
			fullPass = true;
		}

		const indices = new Set<number>();
		if (fullPass) {
			for (let index = 0; index < message.content.length; index++) indices.add(index);
		} else {
			for (let index = this.#streamedAssistantContentLength; index < message.content.length; index++) {
				indices.add(index);
			}
			const changedIndex = changedContentIndex ?? message.content.length - 1;
			if (changedIndex >= 0 && changedIndex < message.content.length) indices.add(changedIndex);
			if (this.#streamedAssistantContentLength > 0) indices.add(this.#streamedAssistantContentLength - 1);
		}
		const orderedIndices = [...indices].sort((left, right) => left - right);
		for (const index of orderedIndices) {
			const content = message.content[index]!;
			const priorType = this.#streamedContentBlockTypes.get(index);
			if (priorType !== undefined && priorType !== content.type) {
				this.#resetStreamingAssistantState();
				return this.#processAssistantMessageUpdate(message, undefined, true);
			}
		}

		const changedAfterToolCallIds = new Set<string>();
		const previousVisibleBlockCount = this.#streamedVisibleBlockCount;
		for (const index of orderedIndices) {
			const content = message.content[index]!;
			this.#recordStreamingTimelineBlock(index, content, changedAfterToolCallIds);
			this.#streamedContentBlockTypes.set(index, content.type);
			if (content.type !== "toolCall") {
				this.#streamedVisibleBlockCount += this.#updateStreamingVisibleBlock(index, content);
			}
		}
		if (this.#streamedVisibleBlockCount > previousVisibleBlockCount) this.#resetReadGroup();
		for (const index of orderedIndices) {
			const content = message.content[index]!;
			if (content.type !== "toolCall" || !this.#streamedToolCallChanged(index, content)) continue;
			this.#processStreamingToolCall(index, content);
			this.#updateStreamingToolIntent(content);
		}
		this.#streamedAssistantContentLength = Math.max(this.#streamedAssistantContentLength, message.content.length);

		const beforeTools = this.#streamedTimelineHasToolCalls
			? this.#streamedTimelineSegment(message, this.#streamedTimelineBeforeToolIndices)
			: message;
		this.#streamingReveal.setTarget(beforeTools, this.#streamedTimelineHasToolCalls);
		if (this.#streamedTimelineHasToolCalls && !this.ctx.streamingComponent?.isTranscriptBlockFinalized()) {
			this.ctx.streamingComponent?.markTranscriptBlockFinalized();
		}

		for (const toolCallId of changedAfterToolCallIds) {
			const segmentIndices = this.#streamedTimelineAfterToolIndices.get(toolCallId);
			this.#upsertPostToolAssistantSegment(
				toolCallId,
				segmentIndices ? this.#streamedTimelineSegment(message, segmentIndices) : undefined,
			);
		}
	}

	async #handleMessageUpdate(event: Extract<AgentSessionEvent, { type: "message_update" }>): Promise<void> {
		this.#ensureWorkingLoaderWhileStreaming();
		if (this.ctx.streamingComponent && event.message.role === "assistant") {
			const unlockedThinkingVisibility = this.ctx.noteDisplayableThinkingContent(event.message);
			if (unlockedThinkingVisibility) {
				this.ctx.streamingComponent.setHideThinkingBlock(this.ctx.effectiveHideThinkingBlock);
				this.#streamingReveal.resyncVisibility();
			}
			this.ctx.streamingMessage = event.message;
			this.#updateWorkingSpinnerFrames(event.message);
			this.#processAssistantMessageUpdate(event.message, event.assistantMessageEvent?.contentIndex);
			this.ctx.ui.requestRender();
		}
	}

	async #handleMessageEnd(event: Extract<AgentSessionEvent, { type: "message_end" }>): Promise<void> {
		if (event.message.role === "user") return;
		const unlockedThinkingVisibility =
			event.message.role === "assistant" && this.ctx.noteDisplayableThinkingContent(event.message);
		if (unlockedThinkingVisibility && this.ctx.streamingComponent) {
			this.ctx.streamingComponent.setHideThinkingBlock(this.ctx.effectiveHideThinkingBlock);
			this.#streamingReveal.resyncVisibility();
		}
		if (this.ctx.streamingComponent && event.message.role === "assistant") {
			const lastStreamedToolCallId = this.#streamedTimelineLastToolCallId;
			this.ctx.streamingMessage = event.message;
			this.#processAssistantMessageUpdate(event.message, undefined, true);
			this.#streamingReveal.stop();
			this.#toolArgsReveal.flushAll();
			let errorMessage: string | undefined;
			const aborted = this.ctx.streamingMessage.stopReason === "aborted";
			const ttsrSilenced = aborted && this.ctx.viewSession.isTtsrAbortPending;
			if (aborted && !ttsrSilenced) {
				errorMessage = resolveAbortLabel(this.ctx.streamingMessage, this.ctx.viewSession.retryAttempt);
				this.ctx.streamingMessage.errorMessage = errorMessage;
			}
			const displayMessage: AssistantMessage = ttsrSilenced
				? {
						...this.ctx.streamingMessage,
						stopReason: "stop",
					}
				: this.ctx.streamingMessage;
			const interruptedDiscardedTool =
				lastStreamedToolCallId !== undefined &&
				!displayMessage.content.some(block => block.type === "toolCall" && block.id === lastStreamedToolCallId) &&
				resolveAssistantErrorPresentation(displayMessage).kind === "interrupted";
			const displayTimeline = splitAssistantMessageToolTimeline(
				interruptedDiscardedTool
					? { ...displayMessage, stopReason: "stop", errorMessage: undefined }
					: displayMessage,
			);
			this.ctx.streamingComponent.updateContent(displayTimeline.beforeTools);

			if (this.ctx.streamingMessage.stopReason !== "aborted" && this.ctx.streamingMessage.stopReason !== "error") {
				for (const [toolCallId, component] of this.ctx.pendingTools.entries()) {
					component.setArgsComplete(toolCallId);
				}
			} else {
				const supersededByRewind =
					this.ctx.streamingMessage.stopReason === "aborted" && this.ctx.viewSession.isTtsrAbortPending;
				if (supersededByRewind) {
					for (const [toolCallId, component] of Array.from(this.ctx.pendingTools.entries())) {
						if (
							!(component instanceof ToolExecutionComponent) &&
							!(component instanceof ReadToolGroupComponent)
						) {
							continue;
						}
						if (this.ctx.chatContainer.isBlockUncommitted(component)) {
							this.#retractToolCardEntry(toolCallId, component);
							this.#retractedToolCallIds.add(toolCallId);
						} else {
							component.seal();
						}
					}
				}

				this.#resolveDisplaceablePoll();
			}

			const usage = event.message.usage;
			if (usage.cacheRead + usage.cacheWrite + usage.input > 0) {
				if (settings.get("display.cacheMissMarker")) {
					const invalidation = detectCacheInvalidation(this.ctx.lastAssistantUsage, usage);
					if (invalidation) this.ctx.streamingComponent.setCacheInvalidation(invalidation);
				}
				this.ctx.lastAssistantUsage = usage;
			}
			this.ctx.streamingComponent.markTranscriptBlockFinalized();
			let lastPostToolAssistantComponent: AssistantMessageComponent | undefined;
			for (const [toolCallId, segment] of displayTimeline.afterToolCalls) {
				const component = this.#upsertPostToolAssistantSegment(toolCallId, segment);
				component?.markTranscriptBlockFinalized();
				if (component) lastPostToolAssistantComponent = component;
			}
			if (interruptedDiscardedTool) {
				// The provider may discard an unfinished tool call at abort. Its prefix is
				// already immutable scrollback, so append the marker after the live card.
				lastPostToolAssistantComponent = this.#upsertPostToolAssistantSegment(lastStreamedToolCallId, {
					...displayMessage,
					content: [],
				});
				lastPostToolAssistantComponent?.markTranscriptBlockFinalized();
			}
			this.#lastAssistantComponent = lastPostToolAssistantComponent ?? this.ctx.streamingComponent;
			if (settings.get("display.showTokenUsage") && assistantUsageIsBilled(event.message.usage)) {
				const readCallIds = groupedReadUsageCallIds(event.message);
				const usageAttached =
					readCallIds !== undefined &&
					(this.#lastReadGroup?.attachUsage(
						readCallIds,
						event.message.usage,
						event.message.duration,
						event.message.ttft,
						event.message.timestamp,
					) ??
						false);
				if (!usageAttached) {
					this.#resetReadGroup();
					this.ctx.chatContainer.addChild(
						createUsageRowBlock(
							event.message.usage,
							event.message.duration,
							event.message.ttft,
							event.message.timestamp,
						),
					);
				}
			}
			if (displayMessage === event.message) {
				this.ctx.transcriptMessageComponents.set(event.message, this.ctx.streamingComponent);
			}
			this.ctx.streamingComponent = undefined;
			this.ctx.streamingMessage = undefined;

			if (event.message.stopReason === "error" && event.message.errorMessage) {
				const recoverableEmptyOutput =
					!event.message.errorMessage.startsWith("Retry budget exhausted") &&
					AIError.is(AIError.classifyMessage(event.message), AIError.Flag.EmptyResponse);
				this.#lastAssistantComponent?.setErrorPinned(true);
				this.#pinnedErrorComponent = this.#lastAssistantComponent;
				this.#pinnedErrorMessage = event.message;
				this.#restorePinnedErrorInline = !recoverableEmptyOutput;
				if (!recoverableEmptyOutput) this.ctx.showPinnedError(event.message.errorMessage);
			}
			this.ctx.statusLine.invalidate();
			this.ctx.ui.requestRender();
		}
		this.ctx.ui.requestRender();
	}

	async #handleToolExecutionStart(event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>): Promise<void> {
		if (this.#retractedToolCallIds.has(event.toolCallId)) return;
		this.#ensureWorkingLoaderWhileStreaming();
		this.#updateWorkingMessageFromIntent(event.intent);
		if (event.toolName === "ask") {
			this.#attentionToolCallIds.add(event.toolCallId);
			setTerminalTitleState("attention");
		}
		this.#resolveDisplaceablePoll(event.toolName);
		this.#toolArgsReveal.finish(event.toolCallId);

		let replacementIndex: number | undefined;
		const pending = this.ctx.pendingTools.get(event.toolCallId);
		if (event.toolName === "read" && readArgsHaveTarget(event.args) && pending) {
			const shouldGroup = readArgsCollapseIntoGroup(event.args);
			if (shouldGroup !== pending instanceof ReadToolGroupComponent) {
				replacementIndex = this.#detachToolCardForRendererMigration(event.toolCallId, pending);
			}
		}

		if (!this.ctx.pendingTools.has(event.toolCallId)) {
			if (event.toolName === "read" && readArgsCollapseIntoGroup(event.args)) {
				this.#trackReadToolCall(event.toolCallId, event.args);
				const group = this.#getReadGroup();
				group.updateArgs(event.args, event.toolCallId);
				this.ctx.pendingTools.set(event.toolCallId, group);
				this.#toolTimelineComponents.set(event.toolCallId, group);
				this.#moveTranscriptComponent(group, replacementIndex);
				this.ctx.ui.requestRender();
				return;
			}

			this.#resetReadGroup();
			const tool = this.ctx.viewSession.getToolByName(event.toolName);
			const component = new ToolExecutionComponent(
				event.toolName,
				event.args,
				{
					useBuiltInRenderer: this.ctx.viewSession.hasBuiltInTool(event.toolName),
					showImages: settings.get("terminal.showImages"),
					liveRegion: this.ctx.chatContainer,
				},
				tool,
				this.ctx.ui,
			);
			component.setArgsComplete(event.toolCallId);
			component.setExecutionStarted(event.toolCallId);
			this.#executionStartedCallIds.add(event.toolCallId);
			component.setExpanded(this.ctx.toolOutputExpanded);
			this.ctx.chatContainer.addChild(component);
			this.#moveTranscriptComponent(component, replacementIndex);
			this.ctx.pendingTools.set(event.toolCallId, component);
			this.#toolTimelineComponents.set(event.toolCallId, component);
			this.ctx.ui.requestRender();
		} else {
			const component = this.ctx.pendingTools.get(event.toolCallId);
			if (component && typeof component.updateArgs === "function") {
				component.updateArgs(event.args, event.toolCallId);
				if (typeof component.setArgsComplete === "function") {
					component.setArgsComplete(event.toolCallId);
				}
				if (typeof component.setExecutionStarted === "function") {
					component.setExecutionStarted(event.toolCallId);
				}
				this.#executionStartedCallIds.add(event.toolCallId);
				this.ctx.ui.requestRender();
			}
		}
	}

	async #handleToolExecutionUpdate(
		event: Extract<AgentSessionEvent, { type: "tool_execution_update" }>,
	): Promise<void> {
		this.#ensureWorkingLoaderWhileStreaming();
		const component = this.ctx.pendingTools.get(event.toolCallId);
		if (component) {
			const asyncState = (event.partialResult.details as { async?: { state?: string } } | undefined)?.async?.state;
			component.updateResult({ ...event.partialResult, isError: asyncState === "failed" }, true, event.toolCallId);
			this.ctx.ui.requestRender();
		}
	}

	#settleHeldCompletion(
		component: ToolExecutionHandle,
		event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>,
	): void {
		component.updateResult({ ...event.result, isError: event.isError }, false, event.toolCallId);
		this.ctx.pendingTools.delete(event.toolCallId);
		if (
			component instanceof ToolExecutionComponent &&
			component.isDisplaceableBlock() &&
			event.toolName === "checklist" &&
			component.canBeDisplacedBy("checklist")
		) {
			const previous = this.#displaceableChecklistComponent;
			if (previous && previous !== component && previous.isDisplaceableBlock()) {
				this.#displaceableChecklistComponent = undefined;
				if (this.ctx.chatContainer.isBlockUncommitted(previous)) {
					this.ctx.chatContainer.disposeAndRemoveChild(previous);
				}
				previous.seal();
			}
			this.#displaceableChecklistComponent = component;
		}
		this.ctx.ui.requestRender();
	}

	async #handleToolExecutionEnd(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): Promise<void> {
		if (this.#retractedToolCallIds.delete(event.toolCallId)) return;
		this.#executionStartedCallIds.delete(event.toolCallId);

		const syntheticFailureDetails = event.result.details as { __synthetic?: boolean; source?: string } | undefined;
		const syntheticFailureCard =
			syntheticFailureDetails?.__synthetic === true &&
			(syntheticFailureDetails.source === "assistant_stop_error" ||
				syntheticFailureDetails.source === "assistant_stop_aborted")
				? this.ctx.pendingTools.get(event.toolCallId)
				: undefined;

		this.#ensureWorkingLoaderWhileStreaming();

		if (this.#attentionToolCallIds.delete(event.toolCallId) && this.#attentionToolCallIds.size === 0) {
			setTerminalTitleState("working");
		}
		if (event.toolName === "read") {
			if (this.#inlineReadToolImages(event.toolCallId, event.result)) {
				const component = this.ctx.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError }, false, event.toolCallId);
					this.ctx.pendingTools.delete(event.toolCallId);
				}
				this.#clearReadToolCall(event.toolCallId);
				this.ctx.ui.requestRender();
			} else {
				let component = this.ctx.pendingTools.get(event.toolCallId);
				if (!component) {
					if (this.#toolTimelineComponents.has(event.toolCallId)) {
						this.#clearReadToolCall(event.toolCallId);
						return;
					}
					const group = this.#getReadGroup();
					const args = this.#readToolCallArgs.get(event.toolCallId);
					if (args) {
						group.updateArgs(args, event.toolCallId);
					}
					component = group;
					this.ctx.pendingTools.set(event.toolCallId, group);
				}
				component.updateResult({ ...event.result, isError: event.isError }, false, event.toolCallId);
				this.ctx.pendingTools.delete(event.toolCallId);
				this.#clearReadToolCall(event.toolCallId);
				this.ctx.ui.requestRender();
			}
		} else {
			const component = this.ctx.pendingTools.get(event.toolCallId);
			if (component) {
				component.updateResult({ ...event.result, isError: event.isError }, false, event.toolCallId);
				this.ctx.pendingTools.delete(event.toolCallId);
				if (component instanceof ToolExecutionComponent && component.isDisplaceableBlock()) {
					if (event.toolName === "fleet" && component.canBeDisplacedBy("fleet")) {
						this.#displaceablePollComponent = component;
					} else if (event.toolName === "checklist" && component.canBeDisplacedBy("checklist")) {
						const previous = this.#displaceableChecklistComponent;
						if (previous && previous !== component && previous.isDisplaceableBlock()) {
							this.#displaceableChecklistComponent = undefined;
							if (this.ctx.chatContainer.isBlockUncommitted(previous)) {
								this.ctx.chatContainer.disposeAndRemoveChild(previous);
							}
							previous.seal();
						}
						this.#displaceableChecklistComponent = component;
					}
				}
				this.ctx.ui.requestRender();
			} else if (event.toolName === "checklist") {
				this.#orphanedToolCompletions.set(event.toolCallId, event);
			}
		}
		if (syntheticFailureCard) this.#syntheticFailureCards.set(event.toolCallId, syntheticFailureCard);

		if (event.toolName === "checklist" && !event.isError) {
			const details = event.result.details as { phases?: ChecklistPhase[] } | undefined;
			if (details?.phases) {
				this.ctx.setChecklist(details.phases);
			}
		} else if (event.toolName === "checklist" && event.isError) {
			const textContent = event.result.content.find(
				(content: { type: string; text?: string }) => content.type === "text",
			)?.text;

			const detail = textContent ? previewLine(sanitizeText(textContent), TRUNCATE_LENGTHS.LINE) : "";
			this.ctx.showWarning(
				`Checklist update failed${detail ? `: ${detail}` : ". Progress may be stale until checklist succeeds."}`,
				{ hideWithToolActivity: true },
			);
		}
	}
	async #handleAgentEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>): Promise<void> {
		if (this.ctx.viewSession.isStreaming) return;

		if (event.isTerminal === false) {
			this.ctx.flushPendingCommandOutput();
			return;
		}
		setTerminalTitleState("idle");

		await this.#finishAgentEnd(event);
	}

	async #finishAgentEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>): Promise<void> {
		this.#setTerminalProgress(false);
		this.ctx.statusLine.markActivityEnd();
		this.#streamingReveal.stop();
		this.#toolArgsReveal.flushAll();
		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
			this.ctx.statusContainer.disposeChildren();
		}
		if (this.ctx.streamingComponent) {
			this.ctx.chatContainer.removeChild(this.ctx.streamingComponent);
			this.ctx.streamingComponent = undefined;
			this.ctx.streamingMessage = undefined;
		}
		for (const toolCallId of Array.from(this.ctx.pendingTools.keys())) {
			const component = this.ctx.pendingTools.get(toolCallId);
			if (component instanceof ToolExecutionComponent || component instanceof ReadToolGroupComponent) {
				component.seal();
			}
			this.ctx.pendingTools.delete(toolCallId);
		}
		this.#attentionToolCallIds.clear();
		this.#readToolCallArgs.clear();
		this.#readToolCallAssistantComponents.clear();
		this.#toolTimelineComponents.clear();
		this.#resetStreamingAssistantState();
		this.#retractedToolCallIds.clear();
		this.#executionStartedCallIds.clear();
		this.#syntheticFailureCards.clear();
		this.#orphanedToolCompletions.clear();
		this.#postToolAssistantComponents.clear();
		this.#resetReadGroup();

		this.#resolveDisplaceablePoll();
		this.#resolveDisplaceableChecklist();
		this.ctx.flushPendingCommandOutput();
		this.ctx.flushPendingBashComponents();
		this.#lastAssistantComponent = undefined;
		this.ctx.ui.requestRender();
		this.#scheduleIdleCompaction();
		this.#scheduleIdleRecap();
		this.sendErrorNotification(event);
		this.sendCompletionNotification(event);
	}

	#stopWorkingLoader(): void {
		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
		}
	}

	#ensureWorkingLoaderWhileStreaming(): void {
		if (!this.ctx.viewSession.isStreaming) return;
		if (this.ctx.autoCompactionLoader || this.ctx.retryLoader) return;
		this.ctx.ensureLoadingAnimation();
	}

	#updateWorkingSpinnerFrames(message: AssistantMessage): void {
		const loader = this.ctx.loadingAnimation;
		if (!loader) return;
		let tail: "text" | "thinking" | undefined;
		for (const content of message.content) {
			if (content.type === "toolCall") {
				tail = undefined;
				break;
			}
			if (content.type === "text" && canonicalizeMessage(content.text)) tail = "text";
			else if (content.type === "thinking" && canonicalizeMessage(content.thinking)) tail = "thinking";
		}
		loader.setSpinnerFrames(
			tail === "thinking" ? theme.getSpinnerFrames("thinking") : theme.getSpinnerFrames("activity"),
		);
	}

	#maintenanceEscHint(): string {
		return this.ctx.focusedAgentId ? "" : " (esc to cancel)";
	}

	async #handleAutoCompactionStart(
		event: Extract<AgentSessionEvent, { type: "auto_compaction_start" }>,
	): Promise<void> {
		this.#cancelIdleCompaction();
		this.#cancelIdleRecap();
		this.#setTerminalProgress(true);
		this.#stopWorkingLoader();
		this.ctx.statusContainer.disposeChildren();
		const reasonText =
			event.reason === "overflow"
				? "Context overflow detected, "
				: event.reason === "incomplete"
					? "Response incomplete, "
					: event.reason === "idle"
						? "Idle "
						: "";
		const actionLabel = event.action === "remote" ? "Auto server compaction" : "Auto context-full maintenance";
		this.ctx.autoCompactionLoader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("accent", spinner),
			text => theme.fg("muted", text),
			`${reasonText}${actionLabel}…${this.#maintenanceEscHint()}`,
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(this.ctx.autoCompactionLoader);
		this.ctx.ui.requestRender();
	}

	async #handleAutoCompactionEnd(event: Extract<AgentSessionEvent, { type: "auto_compaction_end" }>): Promise<void> {
		this.#cancelIdleCompaction();
		this.#cancelIdleRecap();
		this.#setTerminalProgress(false);
		if (this.ctx.autoCompactionLoader) {
			this.ctx.autoCompactionLoader.stop();
			this.ctx.autoCompactionLoader = undefined;
			this.ctx.statusContainer.disposeChildren();
		}
		const isRemoteAction = event.action === "remote";
		if (event.aborted) {
			this.ctx.showStatus(
				isRemoteAction ? "Auto server compaction cancelled" : "Auto context-full maintenance cancelled",
			);
		} else if (event.result) {
			this.ctx.lastAssistantUsage = undefined;
			this.ctx.rebuildChatFromMessages({ reuseSettledComponents: true });
			this.ctx.statusLine.invalidate();

			this.ctx.ui.requestRender();
		} else if (event.errorMessage) {
			this.ctx.showWarning(event.errorMessage);
		} else if (event.skipped) {
		} else if (isRemoteAction) {
			this.ctx.showWarning("Auto server compaction failed; continuing without maintenance");
		} else {
			this.ctx.showWarning("Auto context-full maintenance failed; continuing without maintenance");
		}
		await this.ctx.flushCompactionQueue({ willRetry: event.willRetry });
		this.#ensureWorkingLoaderWhileStreaming();
		this.ctx.ui.requestRender();
	}

	async #handleAutoRetryStart(event: Extract<AgentSessionEvent, { type: "auto_retry_start" }>): Promise<void> {
		this.#retryPending = true;
		this.#trackRetrySupersededAssistantComponent(this.#lastAssistantComponent);

		for (const [toolCallId, component] of this.#syntheticFailureCards) {
			if (this.ctx.chatContainer.isBlockUncommitted(component)) {
				this.#retractToolCardEntry(toolCallId, component);
			}
		}
		this.#syntheticFailureCards.clear();
		this.#stopWorkingLoader();
		this.ctx.statusContainer.disposeChildren();
		if (AIError.is(event.errorId, AIError.Flag.ThinkingLoop)) {
			this.#pinnedErrorComponent = undefined;
			this.#pinnedErrorMessage = undefined;
			this.#restorePinnedErrorInline = true;
			this.ctx.clearPinnedError();
		}
		const delaySeconds = Math.round(event.delayMs / 1000);
		this.ctx.retryLoader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("warning", spinner),
			text => theme.fg("muted", text),
			`Retrying (${event.attempt}/${event.maxAttempts}) in ${delaySeconds}s…${this.#maintenanceEscHint()}`,
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(this.ctx.retryLoader);
		this.ctx.ui.requestRender();
	}

	async #handleAutoRetryEnd(event: Extract<AgentSessionEvent, { type: "auto_retry_end" }>): Promise<void> {
		this.#retryPending = false;
		if (this.ctx.retryLoader) {
			this.ctx.retryLoader.stop();
			this.ctx.retryLoader = undefined;
			this.ctx.statusContainer.disposeChildren();
		}
		const pinnedError = this.#pinnedErrorMessage?.errorMessage;
		const terminalFailurePinned =
			!event.success &&
			this.#pinnedErrorComponent !== undefined &&
			pinnedError !== undefined &&
			pinnedError === event.finalError;
		let stalePinnedErrorCleared = false;
		if (!event.success && this.#pinnedErrorComponent && !terminalFailurePinned) {
			this.#pinnedErrorComponent.setErrorPinned(false);
			this.#pinnedErrorComponent = undefined;
			this.#pinnedErrorMessage = undefined;
			this.#restorePinnedErrorInline = true;
			this.ctx.clearPinnedError();
			stalePinnedErrorCleared = true;
		}
		let appliedRetryUpdate = false;
		for (const retryError of event.retryErrors ?? []) {
			const component = this.#takeRetrySupersededAssistantComponent(retryError.persistenceKey);
			if (!component) continue;
			component.applyRetryRecovery(retryError.retryRecovery);
			if (!terminalFailurePinned && this.#pinnedErrorComponent === component) {
				this.#pinnedErrorComponent = undefined;
				this.#pinnedErrorMessage = undefined;
				this.#restorePinnedErrorInline = true;
			}
			appliedRetryUpdate = true;
		}
		if (
			!terminalFailurePinned &&
			!stalePinnedErrorCleared &&
			(appliedRetryUpdate || (event.retryErrors?.length ?? 0) > 0)
		) {
			this.ctx.clearPinnedError();
		}
		this.#clearRetrySupersededAssistantComponents();
		if (!event.success) {
			if (terminalFailurePinned) {
				const terminalError = this.#restorePinnedErrorInline
					? `Retry failed after ${event.attempt} attempts: ${event.finalError || pinnedError || "Unknown error"}`
					: (pinnedError ?? event.finalError);
				if (terminalError) this.ctx.showPinnedError(terminalError);
				this.#restorePinnedErrorInline = true;
			} else {
				this.ctx.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
			}
		}
		this.#ensureWorkingLoaderWhileStreaming();
		this.ctx.ui.requestRender();
	}

	async #handleRetryFallbackApplied(
		event: Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>,
	): Promise<void> {
		this.ctx.showWarning(`Fallback: ${event.from} -> ${event.to}`);
	}

	async #handleRetryFallbackSucceeded(
		event: Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>,
	): Promise<void> {
		this.ctx.showStatus(`Fallback succeeded on ${event.model}`);
	}

	async #handleTtsrTriggered(event: Extract<AgentSessionEvent, { type: "ttsr_triggered" }>): Promise<void> {
		const previous = this.#lastTtsrNotification;
		if (
			previous &&
			this.ctx.chatContainer.children.at(-1) === previous &&
			this.ctx.chatContainer.isBlockUncommitted(previous)
		) {
			previous.addRules(event.rules);
			this.ctx.ui.requestRender();
			return;
		}
		const component = new TtsrNotificationComponent(event.rules);
		component.setExpanded(this.ctx.toolOutputExpanded);
		this.ctx.present(component);
		this.#lastTtsrNotification = component;
	}

	async #handleChecklistReminder(event: Extract<AgentSessionEvent, { type: "checklist_reminder" }>): Promise<void> {
		const component = new ChecklistReminderComponent(event.items, event.attempt, event.maxAttempts);
		this.ctx.present(component);
	}
	async #handleChecklistAutoClear(
		_event: Extract<AgentSessionEvent, { type: "checklist_auto_clear" }>,
	): Promise<void> {
		await this.ctx.reloadChecklist();
	}

	#cancelIdleCompaction(): void {
		if (this.#idleCompactionTimer) {
			clearTimeout(this.#idleCompactionTimer);
			this.#idleCompactionTimer = undefined;
		}
	}

	#cancelIdleRecap(): void {
		if (this.#idleRecapTimer) {
			clearTimeout(this.#idleRecapTimer);
			this.#idleRecapTimer = undefined;
		}
		if (this.#idleRecapAbort) {
			this.#idleRecapAbort.abort();
			this.#idleRecapAbort = undefined;
		}
	}

	#scheduleIdleCompaction(): void {
		this.#cancelIdleCompaction();

		if (this.ctx.viewSession.isCompacting) return;

		const idleSettings = settings.getGroup("compaction");
		if (!idleSettings.idleEnabled) return;

		if (this.ctx.editor.getText().trim()) return;

		const threshold = idleSettings.idleThresholdTokens;
		if (threshold <= 0) return;
		if (this.#currentContextTokens() < threshold) return;

		const timeoutMs = Math.max(60, Math.min(3600, idleSettings.idleTimeoutSeconds)) * 1000;
		this.#idleCompactionTimer = setTimeout(() => {
			this.#idleCompactionTimer = undefined;

			if (this.ctx.viewSession.isStreaming) return;
			if (this.ctx.viewSession.isCompacting) return;
			if (this.ctx.editor.getText().trim()) return;
			if (this.#currentContextTokens() < threshold) return;
			void this.ctx.viewSession.runIdleCompaction();
		}, timeoutMs);
		this.#idleCompactionTimer.unref?.();
	}

	#scheduleIdleRecap(): void {
		this.#cancelIdleRecap();
		if (this.ctx.viewSession.isCompacting) return;

		const recapSettings = settings.getGroup("recap");
		if (!recapSettings.enabled) return;
		if (this.ctx.editor.getText().trim()) return;

		const timeoutMs =
			Math.max(IDLE_RECAP_MIN_SECONDS, Math.min(IDLE_RECAP_MAX_SECONDS, recapSettings.idleSeconds)) * 1000;
		this.#idleRecapTimer = setTimeout(() => {
			this.#idleRecapTimer = undefined;
			void this.#runIdleRecap();
		}, timeoutMs);
		this.#idleRecapTimer.unref?.();
	}

	async #runIdleRecap(): Promise<void> {
		if (!this.#idleConditionsHold()) return;
		if (!this.ctx.viewSession.model) return;
		if (this.ctx.viewSession.messages.length === 0) return;

		const promptText = prompt.render(idleRecapPrompt, {
			goal: this.#idleRecapGoalText() ?? "",
			task: nextActionableTask(this.ctx.checklistPhases)?.content ?? "",
		});

		const abort = new AbortController();
		this.#idleRecapAbort = abort;
		try {
			const { replyText } = await this.ctx.viewSession.runEphemeralTurn({ promptText, signal: abort.signal });
			if (this.#idleRecapAbort !== abort || abort.signal.aborted || !this.#idleConditionsHold()) return;
			const recap = previewLine(replyText, TRUNCATE_LENGTHS.RECAP);
			if (!recap) return;
			this.ctx.showStatus(theme.fg("dim", theme.italic(`※ recap: ${recap}`)), { dim: false });
		} catch (error) {
			if (!abort.signal.aborted) logger.debug("Idle recap turn failed", { error: String(error) });
		} finally {
			if (this.#idleRecapAbort === abort) this.#idleRecapAbort = undefined;
		}
	}

	#idleConditionsHold(): boolean {
		if (this.ctx.viewSession.isStreaming) return false;
		if (this.ctx.viewSession.isCompacting) return false;
		if (this.ctx.editor.getText().trim()) return false;
		return true;
	}

	#idleRecapGoalText(): string | undefined {
		const goal = this.ctx.viewSession.getGoalModeState?.()?.goal.objective.trim();
		if (goal) return goal;
		const title = this.ctx.sessionManager.getSessionName()?.trim();
		return title || undefined;
	}

	#currentContextTokens(): number {
		return this.ctx.viewSession.getContextUsage()?.tokens ?? 0;
	}

	sendErrorNotification(event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
		if (event.isTerminal === false) return;

		if (this.#retryPending) return;

		if (isWarpCliAgentProtocolActive()) return;

		const notify = settings.get("error.notify");
		if (notify === "off") return;

		const last = event.messages.findLast((message): message is AssistantMessage => message.role === "assistant");
		if (last?.stopReason !== "error") return;

		const sessionName = this.ctx.sessionManager.getSessionName();
		TERMINAL.sendNotification({
			title: sessionName || "Proto",
			body: "Stopped with error",
			type: "error",
			actions: "focus",
		});
	}

	sendCompletionNotification(event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
		const notify = settings.get("completion.notify");
		if (notify === "off") return;

		if (isWarpCliAgentProtocolActive()) return;

		const last = event.messages.findLast((message): message is AssistantMessage => message.role === "assistant");
		if (last?.stopReason === "aborted" || last?.stopReason === "error") return;

		const sessionName = this.ctx.sessionManager.getSessionName();
		TERMINAL.sendNotification({
			title: sessionName || "Proto",
			body: "Complete",
			type: "completion",
			actions: "focus",
		});
	}
}
