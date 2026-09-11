import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, Message, Usage } from "@oh-my-pi/pi-ai";
import { getStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { type Component, Spacer, Text, TruncatedText } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import type { AdvisorMessageDetails } from "../../advisor";
import { settings } from "../../config/settings";
import { createAdvisorMessageCard } from "../../modes/components/advisor-message";
import { AssistantMessageComponent } from "../../modes/components/assistant-message";
import { createBackgroundSideDispatchBlock } from "../../modes/components/background-side-dispatch";
import { BashExecutionComponent } from "../../modes/components/bash-execution";
import { detectCacheInvalidation } from "../../modes/components/cache-invalidation-marker";
import {
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
} from "../../modes/components/compaction-summary-message";
import { CustomMessageComponent } from "../../modes/components/custom-message";
import { DynamicBorder } from "../../modes/components/dynamic-border";
import { EvalExecutionComponent } from "../../modes/components/eval-execution";
import {
	groupedReadUsageCallIds,
	ReadToolGroupComponent,
	readArgsCollapseIntoGroup,
} from "../../modes/components/read-tool-group";
import { SkillMessageComponent } from "../../modes/components/skill-message";
import { StrippedToolCallsPlaceholder } from "../../modes/components/stripped-tool-calls-placeholder";
import { ToolActivityContainer } from "../../modes/components/tool-activity";
import { ToolExecutionComponent, type ToolExecutionHandle } from "../../modes/components/tool-execution";
import { TranscriptBlock, TranscriptContainer } from "../../modes/components/transcript-container";
import { createUsageRowBlock } from "../../modes/components/usage-row";
import { UserMessageComponent } from "../../modes/components/user-message";
import { decodeStreamedToolArgs, streamingStringKeysForTool } from "../../modes/controllers/tool-args-reveal";
import { materializeImageReferenceLinksSync } from "../../modes/image-references";
import { theme } from "../../modes/theme/theme";
import type { CompactionQueuedMessage, InteractiveModeContext, RenderSessionContextOptions } from "../../modes/types";
import { LAUNCH_COMPLETION_MESSAGE_TYPE } from "../../session/launch-completion";
import {
	BACKGROUND_SIDE_DISPATCH_MESSAGE_TYPE,
	type CustomMessage,
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
} from "../../session/messages";
import { MONITOR_EVENT_MESSAGE_TYPE } from "../../session/monitor-event";
import type { SessionContext, StrippedToolCallsMarker } from "../../session/session-context";
import { replaceTabs } from "../../tools/render-utils";
import { buildSkillCommandPrompt, invokeSkillCommandFromText, isKnownSkillCommand } from "../skill-command";
import { createAssistantMessageComponent } from "./interactive-context-helpers";
import {
	assistantHasVisibleContent,
	assistantUsageIsBilled,
	buildAsyncResultBlock,
	buildFileMentionBlock,
	buildIrcMessageCard,
	buildLaunchCompletionBlock,
	buildMonitorEventBlock,
	normalizeToolArgs,
	resolveAssistantErrorPresentation,
	splitAssistantMessageToolTimeline,
} from "./transcript-render-helpers";
import { TRANSCRIPT_WINDOW_SOFT_BYTES, TRANSCRIPT_WINDOW_SOFT_MESSAGES } from "./transcript-window";

type TextBlock = { type: "text"; text: string };
interface RenderInitialMessagesOptions {
	preserveExistingChat?: boolean;
	clearTerminalHistory?: boolean;
}

export type TranscriptHistoryDirection = "older" | "newer" | "latest";

export interface TranscriptWindow {
	start: number;
	end: number;
	pageFromLatest: number;
	totalMessages: number;
}

function estimateValueBytes(value: unknown, limit: number): number {
	const stack: unknown[] = [value];
	const seen = new WeakSet<object>();
	let bytes = 0;
	while (stack.length > 0 && bytes <= limit) {
		const item = stack.pop();
		if (typeof item === "string") {
			bytes += Buffer.byteLength(item);
		} else if (typeof item === "number" || typeof item === "bigint") {
			bytes += 16;
		} else if (typeof item === "boolean") {
			bytes += 5;
		} else if (item && typeof item === "object") {
			if (seen.has(item)) continue;
			seen.add(item);
			if (Array.isArray(item)) {
				for (const child of item) stack.push(child);
			} else {
				for (const [key, child] of Object.entries(item)) {
					bytes += Buffer.byteLength(key);
					stack.push(child);
				}
			}
		}
	}
	return bytes;
}

function assistantToolCallIds(message: AgentMessage): Set<string> | undefined {
	if (message.role !== "assistant") return undefined;
	let ids: Set<string> | undefined;
	for (const content of message.content) {
		if (content.type !== "toolCall") continue;
		ids ??= new Set<string>();
		ids.add(content.id);
	}
	return ids;
}

function transcriptGroupStart(messages: readonly AgentMessage[], end: number): number {
	let start = end - 1;
	if (start <= 0 || messages[start]?.role !== "toolResult") return Math.max(0, start);
	while (start > 0 && messages[start - 1]?.role === "toolResult") start--;
	const assistantIndex = start - 1;
	const assistant = messages[assistantIndex];
	if (!assistant) return start;
	const callIds = assistantToolCallIds(assistant);
	if (!callIds) return start;
	for (let i = start; i < end; i++) {
		const result = messages[i];
		if (result?.role !== "toolResult" || !callIds.has(result.toolCallId)) return start;
	}
	return assistantIndex;
}

/**
 * Select a newest-first transcript page without splitting an assistant and its
 * immediately following matching tool results. Limits are soft: one atomic
 * group or one oversized record remains intact and may exceed them.
 */
export function selectTranscriptWindow(
	messages: readonly AgentMessage[],
	pageFromLatest: number,
	softMessages = TRANSCRIPT_WINDOW_SOFT_MESSAGES,
	softBytes = TRANSCRIPT_WINDOW_SOFT_BYTES,
): TranscriptWindow {
	const requestedPage = Math.max(0, Math.floor(pageFromLatest));
	let end = messages.length;
	let actualPage = 0;
	while (actualPage <= requestedPage) {
		const pageEnd = end;
		let start = end;
		let count = 0;
		let bytes = 0;
		while (start > 0) {
			const groupStart = transcriptGroupStart(messages, start);
			const groupCount = start - groupStart;
			let groupBytes = 0;
			for (let i = groupStart; i < start; i++) {
				groupBytes += estimateValueBytes(messages[i], Math.max(0, softBytes - groupBytes) + 1);
			}
			if (count > 0 && (count + groupCount > softMessages || bytes + groupBytes > softBytes)) break;
			start = groupStart;
			count += groupCount;
			bytes += groupBytes;
		}
		if (actualPage === requestedPage || start === 0) {
			return { start, end: pageEnd, pageFromLatest: actualPage, totalMessages: messages.length };
		}
		end = start;
		actualPage++;
	}
	return { start: 0, end: 0, pageFromLatest: 0, totalMessages: messages.length };
}

export function transcriptWindowContext(context: SessionContext, window: TranscriptWindow): SessionContext {
	return {
		...context,
		messages: context.messages.slice(window.start, window.end),
		cacheMissExplainedAt: context.cacheMissExplainedAt?.slice(window.start, window.end),
	};
}

const TRANSCRIPT_RENDER_CHUNK_MESSAGES = 32;
const TRANSCRIPT_RENDER_CHUNK_MS = 8;

const TRANSCRIPT_REPLAY_MAX_ATTEMPTS = 5;

function waitForImmediate(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

type QueuedMessages = {
	steering: string[];
	followUp: string[];
};
type AddMessageOptions = {
	imageLinks?: readonly (string | undefined)[];
	reuseSettledComponent?: boolean;
};

function imageLinksForMessage(
	message: Extract<AgentMessage, { role: "developer" | "user" }>,
	putBlobSync: InteractiveModeContext["sessionManager"]["putBlobSync"],
): (string | undefined)[] | undefined {
	if (typeof message.content === "string") return undefined;
	const images = message.content.filter(
		(content): content is ImageContent =>
			content.type === "image" && typeof content.data === "string" && typeof content.mimeType === "string",
	);
	return materializeImageReferenceLinksSync(images, putBlobSync);
}

/**
 * Decide which live tool-call components a transcript rebuild must preserve
 * instead of letting the replay re-create them. Mutates `livePendingTools` and
 * `liveComponents` to drop entries the replay will settle from persisted
 * results. Calls with no persisted result yet (still executing) are preserved:
 * the replay would otherwise create a second, never-settled component for the
 * same call while the live component is re-appended below it.
 */
export function resolvePreservedLiveToolCallIds(params: {
	livePendingTools: Map<string, ToolExecutionHandle>;
	liveComponents: Component[];
	messages: readonly AgentMessage[];
}): Set<string> {
	const { livePendingTools, liveComponents, messages } = params;
	const preserved = new Set<string>();
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const resolved = livePendingTools.get(message.toolCallId);
		if (!resolved) continue;

		const details = message.details as { async?: { state?: string } } | undefined;
		if (details?.async?.state === "running") {
			preserved.add(message.toolCallId);
			continue;
		}
		livePendingTools.delete(message.toolCallId);

		let stillShared = false;
		for (const other of livePendingTools.values()) {
			if (other === resolved) {
				stillShared = true;
				break;
			}
		}
		if (stillShared) {
			preserved.add(message.toolCallId);
			continue;
		}
		const index = liveComponents.indexOf(resolved as unknown as Component);
		if (index >= 0) liveComponents.splice(index, 1);
	}
	for (const id of livePendingTools.keys()) {
		preserved.add(id);
	}
	return preserved;
}

export class UiHelpers {
	#transcriptPageFromLatest = 0;
	#transcriptRenderQueue: Promise<void> = Promise.resolve();

	constructor(private ctx: InteractiveModeContext) {}

	#queueTranscriptRender(task: () => Promise<void>): Promise<void> {
		const queued = this.#transcriptRenderQueue.then(task, task);
		this.#transcriptRenderQueue = queued.catch(() => {});
		return queued;
	}

	selectVisibleTranscriptContext(fullContext: SessionContext): { context: SessionContext; window: TranscriptWindow } {
		const window = selectTranscriptWindow(fullContext.messages, this.#transcriptPageFromLatest);
		this.#transcriptPageFromLatest = window.pageFromLatest;
		return { context: transcriptWindowContext(fullContext, window), window };
	}

	addTranscriptWindowNotice(container: TranscriptContainer, window: TranscriptWindow): void {
		if (window.start === 0 && window.end === window.totalMessages) return;
		const controls = "Alt+PgUp older · Alt+PgDn newer · Alt+End latest · /history";
		const label = `Transcript messages ${(window.start + 1).toLocaleString()}–${window.end.toLocaleString()} of ${window.totalMessages.toLocaleString()} · ${controls}`;
		container.addChild(new Text(label, 1, 0).setStyleFn(text => theme.fg("dim", text)));
	}

	getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((content): content is TextBlock => content.type === "text");
		return textBlocks.map(block => block.text).join("");
	}

	showStatus(message: string, options?: { dim?: boolean }): void {
		const children = this.ctx.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;
		const useDim = options?.dim ?? true;

		const styleFn = useDim ? (t: string) => theme.fg("dim", t) : undefined;

		if (last && secondLast && last === this.ctx.lastStatusText && secondLast === this.ctx.lastStatusSpacer) {
			this.ctx.lastStatusText.setStyleFn(styleFn);
			this.ctx.lastStatusText.setText(message);
			this.ctx.ui.requestRender();
			return;
		}

		const spacer = new Spacer(1);
		const text = new Text(message, 1, 0).setStyleFn(styleFn);
		this.ctx.present([spacer, text]);
		this.ctx.lastStatusSpacer = spacer;
		this.ctx.lastStatusText = text;
	}

	addMessageToChat(message: AgentMessage, options?: AddMessageOptions): Component[] {
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.ctx.ui, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(message.exitCode, message.cancelled, {
					truncation: message.meta?.truncation,
				});
				this.ctx.chatContainer.addChild(component);
				break;
			}
			case "pythonExecution": {
				const component = new EvalExecutionComponent(message.code, this.ctx.ui, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(message.exitCode, message.cancelled, {
					truncation: message.meta?.truncation,
				});
				this.ctx.chatContainer.addChild(component);
				break;
			}
			case "hookMessage":
			case "custom": {
				if (message.display) {
					if (message.customType === "async-result") {
						const component = buildAsyncResultBlock(message);
						this.ctx.chatContainer.addChild(component);
						break;
					}
					if (message.customType === LAUNCH_COMPLETION_MESSAGE_TYPE) {
						this.ctx.chatContainer.addChild(buildLaunchCompletionBlock(message));
						break;
					}
					if (message.customType === MONITOR_EVENT_MESSAGE_TYPE) {
						this.ctx.chatContainer.addChild(buildMonitorEventBlock(message));
						break;
					}
					if (message.customType === SKILL_PROMPT_MESSAGE_TYPE) {
						const component = new SkillMessageComponent(message as CustomMessage<SkillPromptDetails>);
						component.setExpanded(this.ctx.toolOutputExpanded);
						this.ctx.chatContainer.addChild(component);
						break;
					}
					if (
						message.customType === "irc:incoming" ||
						message.customType === "irc:autoreply" ||
						message.customType === "irc:relay"
					) {
						const card = buildIrcMessageCard(message, () => this.ctx.toolOutputExpanded);
						this.ctx.chatContainer.addChild(card);
						return [card];
					}
					if (message.customType === "advisor") {
						const details = (message as CustomMessage<AdvisorMessageDetails>).details;
						this.ctx.chatContainer.addChild(
							createAdvisorMessageCard(details, () => this.ctx.toolOutputExpanded, theme),
						);
						break;
					}
					if (message.customType === BACKGROUND_SIDE_DISPATCH_MESSAGE_TYPE) {
						this.ctx.chatContainer.addChild(createBackgroundSideDispatchBlock(message as CustomMessage<unknown>));
						break;
					}
					const renderer = this.ctx.viewSession.extensionRunner?.getMessageRenderer(message.customType);

					const component = new CustomMessageComponent(message as CustomMessage<unknown>, renderer);
					component.setExpanded(this.ctx.toolOutputExpanded);
					this.ctx.chatContainer.addChild(component);
				}
				break;
			}
			case "compactionSummary": {
				const component = new CompactionSummaryMessageComponent(message);
				component.setExpanded(this.ctx.toolOutputExpanded);
				this.ctx.chatContainer.addChild(component);
				break;
			}
			case "branchSummary": {
				const component = new BranchSummaryMessageComponent(message);
				component.setExpanded(this.ctx.toolOutputExpanded);
				this.ctx.chatContainer.addChild(component);
				break;
			}
			case "fileMention": {
				const block = buildFileMentionBlock(message.files, 0);
				if (block.children.length > 0) this.ctx.chatContainer.addChild(block);
				break;
			}
			case "user":
			case "developer": {
				const textContent = this.ctx.getUserMessageText(message);
				if (textContent) {
					const isSynthetic = message.role === "developer" ? true : (message.synthetic ?? false);
					const cached = options?.reuseSettledComponent
						? this.ctx.transcriptMessageComponents.get(message)
						: undefined;
					let userComponent: UserMessageComponent;
					if (cached instanceof UserMessageComponent) {
						userComponent = cached;
					} else {
						const imageLinks =
							options?.imageLinks ??
							imageLinksForMessage(
								message,
								this.ctx.viewSession.sessionManager.putBlobSync.bind(this.ctx.viewSession.sessionManager),
							);
						userComponent = new UserMessageComponent(textContent, isSynthetic, imageLinks);
						this.ctx.transcriptMessageComponents.set(message, userComponent);
					}
					this.ctx.chatContainer.addChild(userComponent);
				}
				break;
			}
			case "assistant": {
				const cached = options?.reuseSettledComponent
					? this.ctx.transcriptMessageComponents.get(message)
					: undefined;
				const assistantComponent =
					cached instanceof AssistantMessageComponent
						? cached
						: createAssistantMessageComponent(this.ctx, splitAssistantMessageToolTimeline(message).beforeTools);
				if (cached !== assistantComponent) {
					this.ctx.transcriptMessageComponents.set(message, assistantComponent);
				}
				this.ctx.chatContainer.addChild(assistantComponent);
				break;
			}
			case "toolResult": {
				break;
			}
			default: {
				message satisfies never;
			}
		}
		return [];
	}

	renderSessionContext(sessionContext: SessionContext, options: RenderSessionContextOptions = {}): void {
		const steps = this.#renderSessionContextSteps(sessionContext, options);
		while (!steps.next().done) {}
	}

	renderSessionContextWithLiveToolComponents(
		sessionContext: SessionContext,
		options: RenderSessionContextOptions,
		liveToolComponents: ReadonlyMap<string, Component>,
	): Set<Component> {
		const inserted = new Set<Component>();
		const steps = this.#renderSessionContextSteps(sessionContext, options, liveToolComponents, inserted);
		while (!steps.next().done) {}
		return inserted;
	}

	async renderSessionContextIncrementally(
		sessionContext: SessionContext,
		options: RenderSessionContextOptions,
		renderChunk?: () => void,
	): Promise<void> {
		const steps = this.#renderSessionContextSteps(sessionContext, options);
		let messagesSinceYield = 0;
		let chunkStartedAt = performance.now();
		while (!steps.next().done) {
			messagesSinceYield++;
			if (
				messagesSinceYield < TRANSCRIPT_RENDER_CHUNK_MESSAGES &&
				performance.now() - chunkStartedAt < TRANSCRIPT_RENDER_CHUNK_MS
			) {
				continue;
			}
			renderChunk?.();
			await waitForImmediate();
			messagesSinceYield = 0;
			chunkStartedAt = performance.now();
		}
	}

	*#renderSessionContextSteps(
		sessionContext: SessionContext,
		options: RenderSessionContextOptions = {},
		liveToolComponents?: ReadonlyMap<string, Component>,
		insertedLiveToolComponents?: Set<Component>,
	): Generator<void, void, void> {
		this.ctx.pendingTools.clear();

		this.ctx.lastAssistantUsage = undefined;

		if (options.updateFooter) {
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
		}

		let readGroup: ReadToolGroupComponent | null = null;
		const readToolCallArgs = new Map<string, Record<string, unknown>>();
		const readToolCallAssistantComponents = new Map<string, AssistantMessageComponent>();

		let pendingUsage: Usage | undefined;
		let pendingUsageDuration: number | undefined;
		let pendingUsageTtft: number | undefined;
		let pendingUsageTimestamp: number | undefined;
		let pendingReadUsageCallIds: string[] | undefined;
		const flushPendingUsage = () => {
			if (!pendingUsage) return;
			const usageAttached =
				pendingReadUsageCallIds !== undefined &&
				(readGroup?.attachUsage(
					pendingReadUsageCallIds,
					pendingUsage,
					pendingUsageDuration,
					pendingUsageTtft,
					pendingUsageTimestamp,
				) ??
					false);
			if (!usageAttached) {
				readGroup?.seal();
				readGroup = null;
				this.ctx.chatContainer.addChild(
					createUsageRowBlock(pendingUsage, pendingUsageDuration, pendingUsageTtft, pendingUsageTimestamp),
				);
			}
			pendingUsage = undefined;
			pendingUsageDuration = undefined;
			pendingUsageTtft = undefined;
			pendingUsageTimestamp = undefined;
			pendingReadUsageCallIds = undefined;
		};

		let waitingPoll: ToolExecutionComponent | null = null;
		const resolveWaitingPoll = (nextToolName?: string) => {
			const previous = waitingPoll;
			if (!previous) return;
			waitingPoll = null;
			if (
				nextToolName === "fleet" &&
				previous.isDisplaceableBlock() &&
				this.ctx.chatContainer.isBlockUncommitted(previous)
			) {
				this.ctx.chatContainer.removeChild(previous);
			}

			previous.seal();
		};
		let todoSnapshot: ToolExecutionComponent | null = null;
		const resolveTodoSnapshot = (nextToolName?: string) => {
			const previous = todoSnapshot;
			if (!previous) return;
			if (!previous.isDisplaceableBlock()) {
				todoSnapshot = null;
				return;
			}
			if (previous.canBeDisplacedBy(nextToolName)) {
				todoSnapshot = null;
				if (this.ctx.chatContainer.isBlockUncommitted(previous)) {
					this.ctx.chatContainer.removeChild(previous);
				}
				previous.seal();
				return;
			}
			if (nextToolName !== undefined) return;
			todoSnapshot = null;
			previous.seal();
		};
		const messages = sessionContext.messages;
		const count = messages.length;
		for (let i = 0; i < count; i++) {
			if (i > 0) yield;
			const message = messages[i]!;
			if (message.role !== "toolResult") flushPendingUsage();

			if (message.role === "assistant") {
				const timeline = splitAssistantMessageToolTimeline(message);
				this.ctx.addMessageToChat(message, { reuseSettledComponent: options.reuseSettledComponents });
				const lastChild = this.ctx.chatContainer.children[this.ctx.chatContainer.children.length - 1];
				const assistantComponent = lastChild instanceof AssistantMessageComponent ? lastChild : undefined;
				if (assistantComponent) {
					const usage = message.usage;
					const explained = sessionContext.cacheMissExplainedAt?.[i] ?? false;
					if (this.ctx.settings.get("display.cacheMissMarker") && !explained) {
						const invalidation = detectCacheInvalidation(this.ctx.lastAssistantUsage, usage);
						if (invalidation) assistantComponent.setCacheInvalidation(invalidation);
					}
					if (usage.cacheRead + usage.cacheWrite + usage.input > 0) {
						this.ctx.lastAssistantUsage = usage;
					}
				}
				const hasVisibleAssistantContent = assistantHasVisibleContent(message);
				if (hasVisibleAssistantContent) {
					readGroup?.seal();
					readGroup = null;
				}
				const errorPresentation = resolveAssistantErrorPresentation(message, this.ctx.viewSession.retryAttempt);
				const hasErrorStop = errorPresentation.kind === "full";
				const errorMessage = hasErrorStop ? errorPresentation.text : null;
				const appendAssistantSegment = (segment: AssistantMessage | undefined) => {
					if (!segment || !assistantHasVisibleContent(segment)) return;
					const component = createAssistantMessageComponent(this.ctx, segment);
					this.ctx.chatContainer.addChild(component);
				};

				for (const content of message.content) {
					if (content.type !== "toolCall") {
						continue;
					}
					const afterToolSegment = timeline.afterToolCalls.get(content.id);
					if (options.preservedLiveToolCallIds?.has(content.id)) {
						const liveComponent = liveToolComponents?.get(content.id);
						if (liveComponent && !this.ctx.chatContainer.children.includes(liveComponent)) {
							this.ctx.chatContainer.addChild(liveComponent);
							insertedLiveToolComponents?.add(liveComponent);
						}
						appendAssistantSegment(afterToolSegment);
						continue;
					}
					resolveWaitingPoll(content.name);

					if (content.name === "read" && readArgsCollapseIntoGroup(content.arguments)) {
						if (hasErrorStop && errorMessage) {
							if (!readGroup) {
								readGroup = new ReadToolGroupComponent({
									showContentPreview: this.ctx.settings.get("read.toolResultPreview"),
								});
								readGroup.setExpanded(this.ctx.toolOutputExpanded);
								this.ctx.chatContainer.addChild(readGroup);
							}
							readGroup.updateArgs(content.arguments, content.id);
							readGroup.updateResult(
								{ content: [{ type: "text", text: errorMessage }], isError: true },
								false,
								content.id,
							);
						} else if (afterToolSegment) {
							if (!readGroup) {
								readGroup = new ReadToolGroupComponent({
									showContentPreview: this.ctx.settings.get("read.toolResultPreview"),
								});
								readGroup.setExpanded(this.ctx.toolOutputExpanded);
								this.ctx.chatContainer.addChild(readGroup);
							}
							readGroup.updateArgs(content.arguments, content.id);
							this.ctx.pendingTools.set(content.id, readGroup);
							if (assistantComponent) {
								readToolCallAssistantComponents.set(content.id, assistantComponent);
							}
						} else {
							const normalizedArgs = normalizeToolArgs(content.arguments);
							readToolCallArgs.set(content.id, normalizedArgs);
							if (assistantComponent) {
								readToolCallAssistantComponents.set(content.id, assistantComponent);
							}
						}
						appendAssistantSegment(afterToolSegment);
						continue;
					}

					readGroup?.seal();
					readGroup = null;
					const tool = this.ctx.viewSession.getToolByName(content.name);
					const partialJson = getStreamingPartialJson(content);

					const rawInput = content.customWireName !== undefined;
					const renderArgs = partialJson
						? decodeStreamedToolArgs(partialJson, {
								rawInput,
								fullArgs: content.arguments,
								streamingStringKeys: streamingStringKeysForTool(content.name, rawInput),
							})
						: content.arguments;
					const component = new ToolExecutionComponent(
						content.name,
						renderArgs,
						{
							useBuiltInRenderer: this.ctx.viewSession.hasBuiltInTool(content.name),
							showImages: settings.get("terminal.showImages"),
							liveRegion: this.ctx.chatContainer,
						},
						tool,
						this.ctx.ui,
					);
					component.setExpanded(this.ctx.toolOutputExpanded);
					this.ctx.chatContainer.addChild(component);

					if (hasErrorStop && errorMessage) {
						component.updateResult(
							{ content: [{ type: "text", text: errorMessage }], isError: true },
							false,
							content.id,
						);
					} else {
						this.ctx.pendingTools.set(content.id, component);
					}
					appendAssistantSegment(afterToolSegment);
				}

				const strippedToolCalls = (message as AgentMessage & StrippedToolCallsMarker).strippedToolCalls ?? 0;
				if (strippedToolCalls > 0) {
					this.ctx.chatContainer.addChild(
						new StrippedToolCallsPlaceholder(strippedToolCalls, !this.ctx.hideToolActivity),
					);
				}
				pendingUsage =
					this.ctx.settings.get("display.showTokenUsage") && assistantUsageIsBilled(message.usage)
						? message.usage
						: undefined;
				pendingUsageDuration = message.duration;
				pendingUsageTtft = message.ttft;
				pendingUsageTimestamp = message.timestamp;
				pendingReadUsageCallIds = pendingUsage ? groupedReadUsageCallIds(message) : undefined;
			} else if (message.role === "toolResult") {
				if (options.preservedLiveToolCallIds?.has(message.toolCallId)) continue;
				const pendingReadComponent = this.ctx.pendingTools.get(message.toolCallId);
				const isReadGroupResult =
					message.toolName === "read" &&
					(!pendingReadComponent || pendingReadComponent instanceof ReadToolGroupComponent);
				if (isReadGroupResult) {
					const assistantComponent = readToolCallAssistantComponents.get(message.toolCallId);
					const images: ImageContent[] = message.content.filter(
						(content): content is ImageContent => content.type === "image",
					);
					if (images.length > 0 && assistantComponent) {
						assistantComponent.setToolResultImages(message.toolCallId, images);
						const hasText = message.content.some(c => c.type === "text");
						if (!hasText && settings.get("terminal.showImages")) {
							readToolCallArgs.delete(message.toolCallId);
							readToolCallAssistantComponents.delete(message.toolCallId);
							continue;
						}
					}
					let component = this.ctx.pendingTools.get(message.toolCallId);
					if (!component) {
						if (!readGroup) {
							readGroup = new ReadToolGroupComponent({
								showContentPreview: this.ctx.settings.get("read.toolResultPreview"),
							});
							readGroup.setExpanded(this.ctx.toolOutputExpanded);
							this.ctx.chatContainer.addChild(readGroup);
						}
						const args = readToolCallArgs.get(message.toolCallId);
						if (args) {
							readGroup.updateArgs(args, message.toolCallId);
						}
						component = readGroup;
						this.ctx.pendingTools.set(message.toolCallId, readGroup);
					}
					component.updateResult(message, false, message.toolCallId);
					this.ctx.pendingTools.delete(message.toolCallId);
					readToolCallArgs.delete(message.toolCallId);
					readToolCallAssistantComponents.delete(message.toolCallId);
					continue;
				}

				const component = this.ctx.pendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message, false, message.toolCallId);
					this.ctx.pendingTools.delete(message.toolCallId);
					if (
						message.toolName === "fleet" &&
						component instanceof ToolExecutionComponent &&
						component.isDisplaceableBlock()
					) {
						waitingPoll = component;
					} else if (
						message.toolName === "todo" &&
						component instanceof ToolExecutionComponent &&
						component.canBeDisplacedBy("todo")
					) {
						resolveTodoSnapshot("todo");
						todoSnapshot = component;
					}
				}
			} else {
				readGroup?.seal();
				readGroup = null;

				if (message.role === "user") resolveWaitingPoll();
				if (message.role === "user") resolveTodoSnapshot();

				this.ctx.addMessageToChat(message, { reuseSettledComponent: options.reuseSettledComponents });
			}
		}
		flushPendingUsage();

		readGroup?.seal();

		resolveWaitingPoll();

		if (todoSnapshot && this.ctx.viewSession.isStreaming) {
			this.ctx.eventController?.inheritDisplaceableTodo(todoSnapshot);
			todoSnapshot = null;
		} else {
			resolveTodoSnapshot();
		}

		if (this.ctx.viewSession.isStreaming) {
			for (const [toolCallId, component] of this.ctx.pendingTools) {
				component.setArgsComplete(toolCallId);
				if (this.ctx.eventController?.hasToolExecutionStarted(toolCallId)) {
					component.setExecutionStarted(toolCallId);
				}
			}
		} else {
			for (const component of this.ctx.pendingTools.values()) {
				component.seal();
			}
			this.ctx.pendingTools.clear();
		}
		this.ctx.ui.requestRender();
	}

	truncateTranscriptFromMessage(message: AgentMessage): boolean {
		if (!this.ctx.initialChatRendered || this.ctx.focusedAgentId || this.ctx.viewSession.isStreaming) return false;

		if (
			this.ctx.pendingTools.size > 0 ||
			this.ctx.pendingBashComponents.length > 0 ||
			this.ctx.pendingPythonComponents.length > 0
		) {
			return false;
		}
		const chat = this.ctx.chatContainer;
		const cut = this.ctx.transcriptMessageComponents.get(message);
		if (!cut) return false;
		const index = chat.children.indexOf(cut);
		if (index < 0) return false;

		for (let i = index; i < chat.children.length; i++) {
			if (!chat.isBlockUncommitted(chat.children[i]!)) return false;
		}

		const context = this.ctx.viewSession.buildTranscriptSessionContext();
		for (const remaining of context.messages) {
			if (remaining === message) return false;
		}
		const dropped = chat.children.slice(index);
		for (let i = dropped.length - 1; i >= 0; i--) {
			const child = dropped[i]!;
			chat.removeChild(child);
			child.dispose?.();
		}

		const retained = new WeakMap<AgentMessage, Component>();
		for (const remaining of context.messages) {
			const component = this.ctx.transcriptMessageComponents.get(remaining);
			if (component) retained.set(remaining, component);
		}
		this.ctx.transcriptMessageComponents = retained;

		let baseline: Usage | undefined;
		for (let i = context.messages.length - 1; i >= 0; i--) {
			const candidate = context.messages[i]!;
			if (candidate.role !== "assistant") continue;
			const usage = candidate.usage;
			if (usage.cacheRead + usage.cacheWrite + usage.input > 0) {
				baseline = usage;
				break;
			}
		}
		this.ctx.lastAssistantUsage = baseline;
		this.ctx.statusLine.invalidate();
		this.ctx.updateEditorBorderColor();
		this.ctx.ui.requestRender();
		return true;
	}

	async renderInitialMessages(options: RenderInitialMessagesOptions = {}): Promise<void> {
		return this.#queueTranscriptRender(async () => {
			this.#transcriptPageFromLatest = 0;
			await this.#renderTranscriptWindow(options, true);
		});
	}

	async navigateTranscriptHistory(direction: TranscriptHistoryDirection): Promise<void> {
		return this.#queueTranscriptRender(async () => {
			if (
				this.ctx.viewSession.isStreaming ||
				this.ctx.pendingBashComponents.length > 0 ||
				this.ctx.pendingPythonComponents.length > 0
			) {
				this.ctx.showStatus("Transcript history paging is unavailable while output is running.");
				return;
			}
			const previousPage = this.#transcriptPageFromLatest;
			if (direction === "older") this.#transcriptPageFromLatest++;
			else if (direction === "newer") this.#transcriptPageFromLatest = Math.max(0, previousPage - 1);
			else this.#transcriptPageFromLatest = 0;
			const window = await this.#renderTranscriptWindow({ clearTerminalHistory: true }, false);
			if (window.pageFromLatest === previousPage && direction !== "latest") {
				this.ctx.showStatus(
					direction === "older"
						? "Already at the oldest transcript page."
						: "Already at the latest transcript page.",
				);
			}
		});
	}

	async ensureLatestTranscriptWindow(): Promise<void> {
		return this.#queueTranscriptRender(async () => {
			if (this.#transcriptPageFromLatest === 0) return;
			this.#transcriptPageFromLatest = 0;
			await this.#renderTranscriptWindow({ clearTerminalHistory: true }, false);
		});
	}

	async #renderTranscriptWindow(
		options: RenderInitialMessagesOptions,
		resetPendingMessages: boolean,
	): Promise<TranscriptWindow> {
		const visibleChatContainer = this.ctx.chatContainer;
		const stagedChatContainer = new TranscriptContainer();
		stagedChatContainer.setToolActivityVisible(!this.ctx.hideToolActivity);
		const preservedChatChildren = options.preserveExistingChat ? [...visibleChatContainer.children] : undefined;
		const previousTranscriptMessageComponents = this.ctx.transcriptMessageComponents;
		const previousPendingTools = this.ctx.pendingTools;
		const previousPendingBashComponents = this.ctx.pendingBashComponents;
		const previousPendingPythonComponents = this.ctx.pendingPythonComponents;
		const previousLastAssistantUsage = this.ctx.lastAssistantUsage;
		const chatWasAlreadyRendered = this.ctx.initialChatRendered;

		this.ctx.chatContainer = stagedChatContainer;
		this.ctx.transcriptMessageComponents = new WeakMap<AgentMessage, Component>();
		this.ctx.pendingTools = new Map<string, ToolExecutionHandle>();
		if (resetPendingMessages) this.ctx.pendingMessagesContainer.disposeChildren();
		this.ctx.pendingBashComponents = [];
		this.ctx.pendingPythonComponents = [];

		let fullContext = this.ctx.viewSession.buildTranscriptSessionContext({
			keepDanglingToolCalls: this.ctx.viewSession.isStreaming,
		});
		let selection = this.selectVisibleTranscriptContext(fullContext);
		let { context, window } = selection;
		let replayEntryCount = this.ctx.viewSession.sessionManager.getEntries().length;
		const renderOptions = { updateFooter: true };
		let committed = false;
		let replayAttempts = 0;
		this.ctx.initialChatRendered = false;
		try {
			while (true) {
				this.addTranscriptWindowNotice(stagedChatContainer, window);
				if (this.ctx.viewSession.isStreaming) this.ctx.renderSessionContext(context, renderOptions);
				else await this.ctx.renderSessionContextIncrementally(context, renderOptions);
				if (this.ctx.viewSession.sessionManager.getEntries().length === replayEntryCount) break;
				replayAttempts++;
				if (replayAttempts >= TRANSCRIPT_REPLAY_MAX_ATTEMPTS) {
					logger.warn("renderInitialMessages: transcript replay did not converge; accepting current replay", {
						attempts: replayAttempts,
						replayEntryCount,
						currentEntryCount: this.ctx.viewSession.sessionManager.getEntries().length,
					});
					break;
				}
				stagedChatContainer.disposeChildren();
				this.ctx.transcriptMessageComponents = new WeakMap<AgentMessage, Component>();
				this.ctx.pendingTools.clear();
				this.ctx.pendingBashComponents = [];
				this.ctx.pendingPythonComponents = [];
				fullContext = this.ctx.viewSession.buildTranscriptSessionContext({
					keepDanglingToolCalls: this.ctx.viewSession.isStreaming,
				});
				selection = this.selectVisibleTranscriptContext(fullContext);
				({ context, window } = selection);
				replayEntryCount = this.ctx.viewSession.sessionManager.getEntries().length;
			}

			const replayedChatChildren = [...stagedChatContainer.children];
			stagedChatContainer.clear();
			this.ctx.chatContainer = visibleChatContainer;
			if (preservedChatChildren) visibleChatContainer.clear();
			else visibleChatContainer.disposeChildren();
			for (const child of replayedChatChildren) visibleChatContainer.addChild(child);
			if (preservedChatChildren) for (const child of preservedChatChildren) visibleChatContainer.addChild(child);
			committed = true;

			let latestUsage: Usage | undefined;
			for (let i = fullContext.messages.length - 1; i >= 0; i--) {
				const message = fullContext.messages[i];
				if (message?.role !== "assistant") continue;
				if (message.usage.cacheRead + message.usage.cacheWrite + message.usage.input > 0) {
					latestUsage = message.usage;
					break;
				}
			}
			this.ctx.lastAssistantUsage = latestUsage;

			const allEntries = this.ctx.viewSession.sessionManager.getEntries();
			let compactionCount = 0;
			for (const entry of allEntries) if (entry.type === "compaction") compactionCount++;
			if (compactionCount > 0) {
				const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
				this.ctx.showStatus(`Session compacted ${times}`);
			}
			if (options.clearTerminalHistory) this.ctx.ui.requestRender(true, { clearScrollback: true });
			else this.ctx.ui.requestRender();
			return window;
		} finally {
			if (!committed) {
				this.ctx.chatContainer = visibleChatContainer;
				this.ctx.transcriptMessageComponents = previousTranscriptMessageComponents;
				this.ctx.pendingTools = previousPendingTools;
				this.ctx.pendingBashComponents = previousPendingBashComponents;
				this.ctx.pendingPythonComponents = previousPendingPythonComponents;
				this.ctx.lastAssistantUsage = previousLastAssistantUsage;
				stagedChatContainer.disposeChildren();
			}
			this.ctx.initialChatRendered = committed ? true : chatWasAlreadyRendered;
		}
	}
	clearEditor(): void {
		this.ctx.editor.clearDraft();
		this.ctx.ui.requestRender();
	}

	showError(errorMessage: string): void {
		const text = new Text(`Error: ${errorMessage}`, 1, 0).setStyleFn(t => theme.fg("error", t));
		this.ctx.present([new Spacer(1), text]);
	}

	showWarning(warningMessage: string, options?: { hideWithToolActivity?: boolean }): void {
		const text = new Text(`Warning: ${warningMessage}`, 1, 0).setStyleFn(t => theme.fg("warning", t));
		const content = [new Spacer(1), text];
		this.ctx.present(options?.hideWithToolActivity ? new ToolActivityContainer(content) : content);
	}

	showNewVersionNotification(newVersion: string): void {
		const block = new TranscriptBlock();
		block.addChild(new DynamicBorder(text => theme.fg("warning", text)));
		const title = "Update Available";
		const prefix = `New version ${newVersion} is available. Run: `;
		const command = "proto update";
		block.addChild(
			new Text(`${title}\n${prefix}${command}`, 1, 0).setStyleFn(
				() =>
					`${theme.bold(theme.fg("warning", title))}\n${theme.fg("muted", prefix)}${theme.fg("accent", command)}`,
			),
		);
		block.addChild(new DynamicBorder(text => theme.fg("warning", text)));
		this.ctx.present(block);
	}

	updatePendingMessagesDisplay(): void {
		this.ctx.pendingMessagesContainer.disposeChildren();
		const queuedMessages = this.ctx.viewSession.getQueuedMessages() as QueuedMessages;

		const steeringMessages = [...queuedMessages.steering];
		for (const entry of this.ctx.compactionQueuedMessages as CompactionQueuedMessage[]) {
			if (entry.mode === "steer") steeringMessages.push(entry.text);
		}

		const followUpMessages = [...queuedMessages.followUp];
		for (const entry of this.ctx.compactionQueuedMessages as CompactionQueuedMessage[]) {
			if (entry.mode === "followUp") followUpMessages.push(entry.text);
		}

		const groups = [
			{ label: "Steering", messages: steeringMessages },
			{ label: "After yield", messages: followUpMessages },
		].filter(group => group.messages.length > 0);
		if (groups.length > 0) {
			this.ctx.pendingMessagesContainer.addChild(new Spacer(1));
			for (const group of groups) {
				const heading = theme.fg("muted", `${group.label}${theme.sep.dot}${group.messages.length}`);
				this.ctx.pendingMessagesContainer.addChild(new TruncatedText(heading, 1, 0));
				for (let index = 0; index < group.messages.length; index++) {
					const message = replaceTabs(group.messages[index] ?? "").replace(/\r?\n/g, " ↵ ");
					const queuedText = theme.fg("dim", `  ${index + 1}. ${message}`);
					this.ctx.pendingMessagesContainer.addChild(new TruncatedText(queuedText, 1, 0));
				}
			}
			const dequeueKey = this.ctx.keybindings.getDisplayString("app.message.dequeue") || "Alt+Up";
			const hintText = theme.fg("dim", `  ${theme.tree.hook} ${dequeueKey} to edit`);
			this.ctx.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
		}
		this.ctx.ui.requestComponentRender(this.ctx.pendingMessagesContainer);
	}

	queueCompactionMessage(text: string, mode: "steer" | "followUp", images?: ImageContent[]): void {
		const queuedImages = images && images.length > 0 ? images : undefined;
		this.ctx.compactionQueuedMessages.push({ text, mode, images: queuedImages } as CompactionQueuedMessage);
		this.ctx.editor.clearDraft(text);
		this.ctx.updatePendingMessagesDisplay();
		this.ctx.showStatus(
			queuedImages ? "Queued message with image for after compaction" : "Queued message for after compaction",
		);
	}

	async #deliverQueuedMessage(message: CompactionQueuedMessage): Promise<void> {
		if (
			await invokeSkillCommandFromText(this.ctx, message.text, message.mode, {
				propagateErrors: true,
				queueOnly: true,
				images: message.images,
			})
		) {
			return;
		}
		if (this.ctx.isKnownSlashCommand(message.text)) {
			await this.ctx.session.prompt(message.text);
			return;
		}
		await this.ctx.withLocalSubmission(
			message.text,
			() =>
				message.mode === "followUp"
					? this.ctx.session.followUp(message.text, message.images)
					: this.ctx.session.steer(message.text, message.images),
			{ imageCount: message.images?.length ?? 0 },
		);
	}

	isKnownSlashCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		if (!commandName) return false;

		if (this.ctx.session.extensionRunner?.getCommand(commandName)) {
			return true;
		}

		for (const command of this.ctx.session.customCommands) {
			if (command.command.name === commandName) {
				return true;
			}
		}

		return this.ctx.fileSlashCommands.has(commandName);
	}

	async flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		if (this.ctx.compactionQueuedMessages.length === 0) {
			return;
		}

		const queuedMessages = [...(this.ctx.compactionQueuedMessages as CompactionQueuedMessage[])];
		this.ctx.compactionQueuedMessages = [] as CompactionQueuedMessage[];
		this.ctx.updatePendingMessagesDisplay();

		const restoreQueue = (error: unknown) => {
			this.ctx.session.clearQueue();
			this.ctx.compactionQueuedMessages = queuedMessages;
			this.ctx.updatePendingMessagesDisplay();
			this.ctx.showError(
				`Failed to send queued message${queuedMessages.length > 1 ? "s" : ""}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		};

		try {
			if (options?.willRetry) {
				for (const message of queuedMessages) {
					await this.#deliverQueuedMessage(message);
				}
				this.ctx.updatePendingMessagesDisplay();
				return;
			}

			let firstPromptIndex = -1;
			for (let i = 0; i < queuedMessages.length; i++) {
				if (!this.ctx.isKnownSlashCommand(queuedMessages[i].text)) {
					firstPromptIndex = i;
					break;
				}
			}
			if (firstPromptIndex === -1) {
				for (const message of queuedMessages) {
					await this.ctx.session.prompt(message.text);
				}
				return;
			}

			const preCommands = queuedMessages.slice(0, firstPromptIndex);
			const firstPrompt = queuedMessages[firstPromptIndex];
			const rest = queuedMessages.slice(firstPromptIndex + 1);

			for (const message of preCommands) {
				await this.#deliverQueuedMessage(message);
			}

			let promptPromise: Promise<unknown>;
			if (isKnownSkillCommand(this.ctx, firstPrompt.text)) {
				const built = await buildSkillCommandPrompt(
					this.ctx,
					firstPrompt.text,
					firstPrompt.mode,
					firstPrompt.images,
				);
				promptPromise = built
					? this.ctx.session.promptCustomMessage(built.message, built.options).catch(restoreQueue)
					: Promise.resolve();
			} else {
				const disposeFirstPrompt = this.ctx.recordLocalSubmission(
					firstPrompt.text,
					firstPrompt.images?.length ?? 0,
				);
				promptPromise = this.ctx.session
					.prompt(firstPrompt.text, {
						streamingBehavior: firstPrompt.mode === "followUp" ? "followUp" : "steer",
						images: firstPrompt.images,
					})
					.catch((error: unknown) => {
						disposeFirstPrompt();
						restoreQueue(error);
					});
			}

			for (const message of rest) {
				await this.#deliverQueuedMessage(message);
			}
			this.ctx.updatePendingMessagesDisplay();
			void promptPromise;
		} catch (error) {
			restoreQueue(error);
		}
	}

	flushPendingBashComponents(): void {
		for (const component of this.ctx.pendingBashComponents) {
			this.ctx.pendingMessagesContainer.removeChild(component);
			this.ctx.chatContainer.addChild(component);
		}
		this.ctx.pendingBashComponents = [];
		for (const component of this.ctx.pendingPythonComponents) {
			this.ctx.pendingMessagesContainer.removeChild(component);
			this.ctx.chatContainer.addChild(component);
		}
		this.ctx.pendingPythonComponents = [];
	}

	findLastAssistantMessage(): AssistantMessage | undefined {
		for (let i = this.ctx.viewSession.messages.length - 1; i >= 0; i--) {
			const message = this.ctx.viewSession.messages[i];
			if (message?.role === "assistant") {
				return message as AssistantMessage;
			}
		}
		return undefined;
	}

	extractAssistantText(message: AssistantMessage): string {
		let text = "";
		for (const content of message.content) {
			if (content.type === "text") {
				text += content.text;
			}
		}
		return text.trim();
	}
}
