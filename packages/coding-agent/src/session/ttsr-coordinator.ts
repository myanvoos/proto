import * as os from "node:os";
import * as path from "node:path";
import {
	type AfterToolCallContext,
	type AfterToolCallResult,
	type Agent,
	type AgentEvent,
	type AgentMessage,
	type BeforeToolCallContext,
	createToolScopedAbortReason,
} from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@oh-my-pi/pi-ai";
import { isRecord, prompt, relativePathWithinRoot } from "@oh-my-pi/pi-utils";
import type { Rule } from "../capability/rule";
import type { Settings } from "../config/settings";
import type { TtsrManager, TtsrMatch, TtsrMatchContext, TtsrMatchSource } from "../export/ttsr";
import type { JudgeFn, MatchEvidence, ToolCallRecord } from "../export/ttsr-matcher";
import ttsrInterruptTemplate from "../prompts/system/ttsr-interrupt.md" with { type: "text" };
import ttsrToolReminderTemplate from "../prompts/system/ttsr-tool-reminder.md" with { type: "text" };
import type { AgentSessionEvent } from "./agent-session-events";
import type { SessionManager } from "./session-manager";

interface TtsrContinueOptions {
	delayMs?: number;
	generation?: number;
	shouldContinue?: () => boolean;
	onSkip?: () => void;
	onError?: () => void;
}

export interface TtsrCoordinatorHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	/** Answers `llm:` rule conditions; built on first use. */
	createJudge(): JudgeFn;
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	schedulePostPromptTask(task: (signal: AbortSignal) => Promise<void>, options?: { delayMs?: number }): void;
	scheduleAgentContinue(options: TtsrContinueOptions): void;
	promptGeneration(): number;
}

const MAX_HISTORY_ARGS = 4096;

export class TtsrCoordinator {
	readonly #host: TtsrCoordinatorHost;
	readonly #manager: TtsrManager | undefined;
	#pendingInjections: TtsrMatch[] = [];
	#perToolInjections = new Map<string, TtsrMatch[]>();
	#abortPending = false;
	#retryToken = 0;
	#records = new WeakMap<ToolCall, ToolCallRecord>();
	#history: HistoryCache | undefined;
	#resumePromise: Promise<void> | undefined;
	#resumeResolve: (() => void) | undefined;
	#judge: JudgeFn | undefined;
	#turnAbort: AbortController | undefined;

	constructor(host: TtsrCoordinatorHost, manager: TtsrManager | undefined) {
		this.#host = host;
		this.#manager = manager;
	}

	get manager(): TtsrManager | undefined {
		return this.#manager;
	}

	get abortPending(): boolean {
		return this.#abortPending;
	}

	get resumeGate(): Promise<void> | undefined {
		return this.#resumePromise;
	}

	onTurnStart(): void {
		this.#manager?.resetBuffer();
		this.#endTurnScope();
	}

	/** Built on first use: a session without `llm:` rules never resolves a model role. */
	#resolveJudge(): JudgeFn {
		this.#judge ??= this.#host.createJudge();
		return this.#judge;
	}

	onTurnEnd(): void {
		this.#manager?.incrementMessageCount();
		this.#endTurnScope();
	}

	/**
	 * A judge belongs to the turn that asked. Ending the turn — including when the
	 * user aborts it — cancels the model call, so the agent loop never waits out a
	 * judge's own timeout for a verdict nobody will use. The scope is created on
	 * first use rather than at turn start, so a judge is cancellable regardless of
	 * which lifecycle callbacks a host wires up.
	 */
	#turnSignal(): AbortSignal {
		this.#turnAbort ??= new AbortController();
		return this.#turnAbort.signal;
	}

	#endTurnScope(): void {
		this.#turnAbort?.abort();
		this.#turnAbort = undefined;
	}

	async checkMessageUpdate(event: AgentEvent): Promise<boolean> {
		if (event.type !== "message_update" || !this.#manager?.hasRules()) return false;
		const assistantEvent = event.assistantMessageEvent;
		let matchContext: TtsrMatchContext | undefined;
		let streamingToolCall: ToolCall | undefined;
		if (assistantEvent.type === "text_delta") {
			matchContext = this.#streamContext("text", event.message);
		} else if (assistantEvent.type === "thinking_delta") {
			matchContext = this.#streamContext("thinking", event.message);
		} else if (assistantEvent.type === "toolcall_delta") {
			streamingToolCall = this.#getStreamingToolCallBlock(event.message, assistantEvent.contentIndex);
			matchContext = this.#getToolMatchContext(streamingToolCall, assistantEvent.contentIndex, event.message);
		}
		if (!matchContext || !("delta" in assistantEvent)) return false;
		const targetMessageTimestamp = event.message.role === "assistant" ? event.message.timestamp : undefined;
		const matches = this.#checkStream(assistantEvent.delta, matchContext, streamingToolCall);
		if (matches.length > 0 && this.#handleMatches(matches, matchContext, targetMessageTimestamp)) return true;

		if (matchContext.source === "tool" && this.#manager.hasAsyncRules()) {
			const asyncMatches = await this.#checkAsyncStream(matchContext, streamingToolCall);
			if (asyncMatches.length > 0 && this.#handleMatches(asyncMatches, matchContext, targetMessageTimestamp))
				return true;
		}
		return false;
	}

	async onAssistantMessageEnd(message: AssistantMessage): Promise<void> {
		if (!this.#abortPending) this.resolveResume();
		await this.#checkSettledProse(message);
		this.#queueDeferredInjectionIfNeeded(message);
	}

	/**
	 * Judge the finished prose. A growing stream has nothing a model can rule on,
	 * so `llm:` conditions over assistant text resolve once, here, and land as a
	 * deferred injection rather than an interrupt — the message is already out.
	 */
	async #checkSettledProse(message: AssistantMessage): Promise<void> {
		if (!this.#manager?.hasJudgeRules()) return;
		if (message.stopReason === "aborted" || message.stopReason === "error") return;
		const text = message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map(block => block.text)
			.join("\n");
		if (text.trim().length === 0) return;
		const matchContext: TtsrMatchContext = {
			...this.#streamContext("text", message),
			judge: this.#resolveJudge(),
			signal: this.#turnSignal(),
			settled: true,
		};
		const matches = (await this.#manager.checkAsyncSnapshot(text, matchContext)).filter(
			match => !this.#claimed(match.rule.name),
		);
		if (matches.length === 0) return;
		this.#addPendingInjections(matches);
		this.#host.emitSessionEvent({ type: "ttsr_triggered", rules: matches.map(match => match.rule) }).catch(() => {});
	}

	/**
	 * Judge a tool call whose arguments are final but which has not run yet. This
	 * is the only point where a judge sees complete arguments and a reminder can
	 * still reach the model before the call takes effect.
	 */
	async beforeToolCall(ctx: BeforeToolCallContext): Promise<void> {
		if (!this.#manager?.hasJudgeRules()) return;
		const matchContext = this.#getToolMatchContext(ctx.toolCall, 0, ctx.assistantMessage);
		matchContext.judge = this.#resolveJudge();
		matchContext.signal = this.#turnSignal();
		matchContext.settled = true;
		const matches = await this.#checkAsyncStream(matchContext, ctx.toolCall);
		if (matches.length > 0) this.#handleMatches(matches, matchContext, undefined);
	}

	markInjectedFromDetails(details: unknown): void {
		if (!details || typeof details !== "object" || Array.isArray(details)) return;
		const rules = "rules" in details ? details.rules : undefined;
		if (!Array.isArray(rules)) return;
		this.#markInjected(rules.filter((ruleName): ruleName is string => typeof ruleName === "string"));
	}

	afterToolCall(ctx: AfterToolCallContext): AfterToolCallResult | undefined {
		const matches = this.#perToolInjections.get(ctx.toolCall.id);
		if (!matches || matches.length === 0) return undefined;
		this.#perToolInjections.delete(ctx.toolCall.id);
		const reminder = matches
			.map(match =>
				prompt.render(ttsrToolReminderTemplate, {
					name: match.rule.name,
					path: this.#displayRulePath(match.rule.path),
					content: match.rule.content,
					evidence: formatEvidence(match.evidence),
				}),
			)
			.join("\n\n");
		const ruleNames = matches.map(match => match.rule.name.trim()).filter(name => name.length > 0);
		if (ruleNames.length > 0) this.#host.sessionManager.appendTtsrInjection(ruleNames);
		return { content: [{ type: "text", text: reminder }, ...ctx.result.content] };
	}

	resolveResume(): void {
		if (!this.#resumeResolve) return;
		this.#resumeResolve();
		this.#resumeResolve = undefined;
		this.#resumePromise = undefined;
	}

	#ensureResumePromise(): void {
		if (this.#resumePromise) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#resumePromise = promise;
		this.#resumeResolve = resolve;
	}

	#formatAbortReason(matches: TtsrMatch[]): string {
		const label = matches.length === 1 ? "rule" : "rules";
		return `TTSR matched ${label}: ${matches.map(match => match.rule.name).join(", ")}`;
	}

	#getInjectionContent(): { content: string; rules: Rule[] } | undefined {
		if (this.#pendingInjections.length === 0) return undefined;
		const matches = this.#pendingInjections;
		const content = matches
			.map(match =>
				prompt.render(ttsrInterruptTemplate, {
					name: match.rule.name,
					path: this.#displayRulePath(match.rule.path),
					content: match.rule.content,
					evidence: formatEvidence(match.evidence),
				}),
			)
			.join("\n\n");
		this.#pendingInjections = [];
		return { content, rules: matches.map(match => match.rule) };
	}

	#displayRulePath(rulePath: string): string {
		const cwd = this.#host.sessionManager.getCwd();
		const cwdRelative = relativePathWithinRoot(cwd, rulePath) ?? this.#displayPathWithinRoot(cwd, rulePath);
		if (cwdRelative) return cwdRelative;
		const homeRelative = relativePathWithinRoot(os.homedir(), rulePath);
		if (homeRelative) return `~/${homeRelative}`;
		return rulePath;
	}

	#displayPathWithinRoot(root: string, candidate: string): string | null {
		const relative = path.relative(path.resolve(root), path.resolve(candidate));
		return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : null;
	}

	#addPendingInjections(matches: TtsrMatch[]): void {
		const seen = new Set(this.#pendingInjections.map(match => match.rule.name));
		for (const match of matches) {
			if (seen.has(match.rule.name)) continue;
			this.#pendingInjections.push(match);
			seen.add(match.rule.name);
		}
	}

	#extractToolCallId(matchContext: TtsrMatchContext): string | undefined {
		if (matchContext.source !== "tool") return undefined;
		const key = matchContext.streamKey;
		if (typeof key !== "string" || !key.startsWith("toolcall:")) return undefined;
		const id = key.slice("toolcall:".length);
		return id.length > 0 ? id : undefined;
	}

	#addPerToolInjections(toolCallId: string, matches: TtsrMatch[]): void {
		const bucket = this.#perToolInjections.get(toolCallId) ?? [];
		const seen = new Set(bucket.map(match => match.rule.name));
		const claimedElsewhere = new Set<string>();
		for (const [otherId, otherBucket] of this.#perToolInjections) {
			if (otherId === toolCallId) continue;
			for (const match of otherBucket) claimedElsewhere.add(match.rule.name);
		}
		const newlyAdded: string[] = [];
		for (const match of matches) {
			if (seen.has(match.rule.name) || claimedElsewhere.has(match.rule.name)) continue;
			bucket.push(match);
			seen.add(match.rule.name);
			newlyAdded.push(match.rule.name);
		}
		if (bucket.length === 0) return;
		this.#perToolInjections.set(toolCallId, bucket);
		if (newlyAdded.length > 0) this.#manager?.markInjectedByNames(newlyAdded);
	}

	#markInjected(ruleNames: string[]): void {
		const uniqueRuleNames = Array.from(
			new Set(ruleNames.map(ruleName => ruleName.trim()).filter(ruleName => ruleName.length > 0)),
		);
		if (uniqueRuleNames.length === 0) return;
		this.#manager?.markInjectedByNames(uniqueRuleNames);
		this.#host.sessionManager.appendTtsrInjection(uniqueRuleNames);
	}

	#findAssistantIndex(targetTimestamp: number | undefined): number {
		const messages = this.#host.agent.state.messages;
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index];
			if (message.role === "assistant" && (targetTimestamp === undefined || message.timestamp === targetTimestamp)) {
				return index;
			}
		}
		return -1;
	}

	#shouldInterrupt(matches: TtsrMatch[], matchContext: TtsrMatchContext): boolean {
		const globalMode = this.#manager?.getSettings().interruptMode ?? "always";
		for (const match of matches) {
			const mode = match.rule.interruptMode ?? globalMode;
			if (mode === "never") continue;
			if (mode === "prose-only" && (matchContext.source === "text" || matchContext.source === "thinking")) {
				return true;
			}
			if (mode === "tool-only" && matchContext.source === "tool") return true;
			if (mode === "always") return true;
		}
		return false;
	}

	#queueDeferredInjectionIfNeeded(message: AssistantMessage): void {
		if (message.stopReason === "aborted" || message.stopReason === "error") this.#perToolInjections.clear();
		if (this.#abortPending || this.#pendingInjections.length === 0) return;
		if (message.stopReason === "aborted" || message.stopReason === "error") {
			this.#pendingInjections = [];
			return;
		}
		const injection = this.#getInjectionContent();
		if (!injection) return;
		this.#host.agent.followUp({
			role: "custom",
			customType: "ttsr-injection",
			content: injection.content,
			display: false,
			details: { rules: injection.rules.map(rule => rule.name) },
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#ensureResumePromise();
		this.#host.scheduleAgentContinue({
			delayMs: 1,
			generation: this.#host.promptGeneration(),
			onSkip: () => this.resolveResume(),
			shouldContinue: () => {
				if (this.#host.agent.state.isStreaming || !this.#host.agent.hasQueuedMessages()) {
					this.resolveResume();
					return false;
				}
				return true;
			},
			onError: () => this.resolveResume(),
		});
	}

	#getStreamingToolCallBlock(message: AgentMessage, contentIndex: number): ToolCall | undefined {
		if (message.role !== "assistant") return undefined;
		const content = message.content;
		if (!Array.isArray(content) || contentIndex < 0 || contentIndex >= content.length) return undefined;
		const block = content[contentIndex];
		return block && typeof block === "object" && block.type === "toolCall" ? (block as ToolCall) : undefined;
	}

	#streamContext(source: TtsrMatchSource, batch?: AgentMessage): TtsrMatchContext {
		const batchIds = batch ? toolCallIdsOf(batch) : undefined;
		return {
			source,
			cwd: this.#host.sessionManager.getCwd(),
			history: () => this.#toolCallHistory(batchIds),
		};
	}

	/**
	 * The calls the session already made, oldest first, for `did:` conditions.
	 *
	 * History is read out of the live transcript rather than accumulated in a
	 * side ledger, so it always answers for the context the model can still see.
	 * That is what keeps `did:` honest when the transcript is rewritten:
	 * compaction, pruning, a TTSR `discard` rewind, or resuming a saved session
	 * all drop calls out of history, and a rule gated on `not: { did: … }` starts
	 * firing again — the agent no longer has what it read, so it needs the
	 * reminder again. A ledger that only grew would claim the read still counted
	 * and stay silent exactly when the guidance was lost.
	 *
	 * The batch under evaluation is excluded — the assistant message holding the
	 * call or the prose being matched. That message already exists in the
	 * transcript, but everything in it was decided at once: a `read` emitted
	 * beside a `write`, or beside a claim that the tests pass, cannot have
	 * informed it. History is what earlier messages did.
	 */
	#toolCallHistory(batchIds?: readonly string[]): readonly ToolCallRecord[] {
		const messages = this.#host.agent.state.messages;
		const batchKey = batchIds && batchIds.length > 0 ? batchIds.join("\u0000") : undefined;
		const cache = this.#history;
		// Reusable only while the transcript is the same array, grown at the end,
		// still ending where it did, and excluding the same in-flight call. Any
		// rewrite — compaction, pruning, a rewind, a popped message — fails one of
		// these and forces a rebuild, which is what keeps history honest.
		const reusable =
			cache !== undefined &&
			cache.excluded === batchKey &&
			cache.source.deref() === messages &&
			cache.scanned <= messages.length &&
			(cache.scanned === 0 || cache.tail?.deref() === messages[cache.scanned - 1]);
		const records = reusable ? cache.records : [];
		const from = reusable ? cache.scanned : 0;
		for (let index = from; index < messages.length; index++) {
			const message = messages[index];
			if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") continue;
			const content = (message as AssistantMessage).content;
			if (!Array.isArray(content)) continue;
			// Calls the model emitted in the same batch as the one being matched are
			// not history: they were decided simultaneously, so a parallel `read`
			// cannot have informed the `write` beside it. Skip the whole message.
			if (batchIds && containsAnyToolCall(content, batchIds)) continue;
			for (const block of content) {
				if (!block || typeof block !== "object" || block.type !== "toolCall") continue;
				records.push(this.#toolCallRecord(block as ToolCall));
			}
		}
		const tail = messages.length > 0 ? messages[messages.length - 1] : undefined;
		this.#history = {
			source: new WeakRef(messages),
			tail: tail ? new WeakRef(tail as object) : undefined,
			scanned: messages.length,
			excluded: batchKey,
			records,
		};
		return records;
	}

	/**
	 * Path extraction and argument serialization run once per call, memoized on
	 * the transcript block itself: rebuilding history is then a pointer walk, and
	 * the cache cannot outlive the messages it describes.
	 */
	#toolCallRecord(toolCall: ToolCall): ToolCallRecord {
		let record = this.#records.get(toolCall);
		if (!record) {
			record = {
				name: toolCall.name,
				paths: this.#extractToolFilePaths(toolCall),
				args: serializeCallArgs(toolCall.arguments),
			};
			this.#records.set(toolCall, record);
		}
		return record;
	}

	#getToolMatchContext(toolCall: ToolCall | undefined, contentIndex: number, batch?: AgentMessage): TtsrMatchContext {
		const context = this.#streamContext("tool", batch);
		if (!toolCall) return context;
		context.toolName = toolCall.name;
		context.streamKey = toolCall.id ? `toolcall:${toolCall.id}` : `tool:${toolCall.name}:${contentIndex}`;
		context.filePaths = this.#extractToolFilePaths(toolCall);
		return context;
	}

	#extractToolFilePaths(toolCall: ToolCall): string[] | undefined {
		const args = toolCall.arguments ?? {};
		const tool = this.#resolveTool(toolCall);
		const toolPaths = tool?.matcherPaths?.(args);
		if (toolPaths && toolPaths.length > 0) {
			const named = dedupePaths(toolPaths);
			if (named.length > 0) return named;
		}
		return this.#extractFilePathsFromArgs(args);
	}

	#checkStream(delta: string, matchContext: TtsrMatchContext, toolCall: ToolCall | undefined): TtsrMatch[] {
		if (!this.#manager) return [];
		const entries = this.#resolveMatcherEntries(toolCall);
		if (entries) {
			const matches: TtsrMatch[] = [];
			for (const entry of entries) {
				matches.push(...this.#manager.checkSnapshot(entry.digest, this.#perFileContext(matchContext, entry.path)));
			}
			return matches;
		}
		const digest = this.#resolveMatcherDigest(toolCall);
		return digest !== undefined
			? this.#manager.checkSnapshot(digest, matchContext)
			: this.#manager.checkDelta(delta, matchContext);
	}

	#resolveMatcherDigest(toolCall: ToolCall | undefined): string | undefined {
		const tool = this.#resolveTool(toolCall);
		return tool?.matcherDigest?.(toolCall?.arguments ?? {});
	}

	#resolveMatcherEntries(toolCall: ToolCall | undefined): readonly { path: string; digest: string }[] | undefined {
		const tool = this.#resolveTool(toolCall);
		const entries = tool?.matcherEntries?.(toolCall?.arguments ?? {});
		return entries && entries.length > 0 ? entries : undefined;
	}

	#resolveTool(toolCall: ToolCall | undefined) {
		if (!toolCall) return undefined;
		const tools = this.#host.agent.state.tools;
		return (
			tools.find(tool => tool.name === toolCall.name) ??
			tools.find(tool => tool.customWireName !== undefined && tool.customWireName === toolCall.name)
		);
	}

	#perFileContext(base: TtsrMatchContext, filePath: string): TtsrMatchContext {
		return {
			...base,
			filePaths: [filePath],
			streamKey: base.streamKey ? `${base.streamKey}#${filePath}` : undefined,
		};
	}

	async #checkAsyncStream(matchContext: TtsrMatchContext, toolCall: ToolCall | undefined): Promise<TtsrMatch[]> {
		if (!this.#manager) return [];
		const entries = this.#resolveMatcherEntries(toolCall);
		if (entries) {
			const matches: TtsrMatch[] = [];
			for (const entry of entries) {
				matches.push(
					...(await this.#manager.checkAsyncSnapshot(
						entry.digest,
						this.#perFileContext(matchContext, entry.path),
					)),
				);
			}
			return matches;
		}
		const digest = this.#resolveMatcherDigest(toolCall);
		return digest === undefined ? [] : this.#manager.checkAsyncSnapshot(digest, matchContext);
	}

	/** A rule already queued for injection must not interrupt or notify a second time. */
	#claimed(ruleName: string): boolean {
		if (this.#pendingInjections.some(match => match.rule.name === ruleName)) return true;
		for (const bucket of this.#perToolInjections.values()) {
			if (bucket.some(match => match.rule.name === ruleName)) return true;
		}
		return false;
	}

	#handleMatches(
		allMatches: TtsrMatch[],
		matchContext: TtsrMatchContext,
		targetTimestamp: number | undefined,
	): boolean {
		// The regex pass and the AST pass see the same buffer, so a rule with both
		// kinds of conditions reports twice; only the first claim is real.
		const matches = allMatches.filter(match => !this.#claimed(match.rule.name));
		if (matches.length === 0) return false;
		const shouldInterrupt = this.#shouldInterrupt(matches, matchContext);
		const rules = matches.map(match => match.rule);
		const matchedToolId = this.#extractToolCallId(matchContext);
		const perToolId = shouldInterrupt ? undefined : matchedToolId;
		if (perToolId) {
			this.#addPerToolInjections(perToolId, matches);
			this.#host.emitSessionEvent({ type: "ttsr_triggered", rules }).catch(() => {});
			return false;
		}
		this.#addPendingInjections(matches);
		if (!shouldInterrupt) {
			// A match that only queues an injection still triggered: extensions and
			// hooks subscribe to this event, and a prose rule that fires without one
			// is invisible to them even though its guidance reaches the model.
			this.#host.emitSessionEvent({ type: "ttsr_triggered", rules }).catch(() => {});
			return false;
		}

		this.#abortPending = true;
		this.#ensureResumePromise();
		const abortReason = this.#formatAbortReason(matches);
		this.#host.agent.abort(
			matchedToolId
				? createToolScopedAbortReason(
						abortReason,
						{ [matchedToolId]: abortReason },
						"TTSR interrupt on another tool call",
					)
				: abortReason,
		);
		this.#host.emitSessionEvent({ type: "ttsr_triggered", rules }).catch(() => {});
		const retryToken = ++this.#retryToken;
		const generation = this.#host.promptGeneration();
		this.#host.schedulePostPromptTask(
			async () => {
				if (this.#retryToken !== retryToken) {
					this.resolveResume();
					return;
				}
				const targetAssistantIndex = this.#findAssistantIndex(targetTimestamp);
				if (!this.#abortPending || this.#host.promptGeneration() !== generation || targetAssistantIndex === -1) {
					this.#abortPending = false;
					this.#pendingInjections = [];
					this.#perToolInjections.clear();
					this.resolveResume();
					return;
				}
				this.#abortPending = false;
				this.#perToolInjections.clear();
				if (this.#manager?.getSettings().contextMode === "discard") {
					this.#host.agent.replaceMessages(this.#host.agent.state.messages.slice(0, targetAssistantIndex));
				}
				const injection = this.#getInjectionContent();
				if (injection) {
					const details = { rules: injection.rules.map(rule => rule.name) };
					this.#host.agent.appendMessage({
						role: "custom",
						customType: "ttsr-injection",
						content: injection.content,
						display: false,
						details,
						attribution: "agent",
						timestamp: Date.now(),
					});
					this.#host.sessionManager.appendCustomMessageEntry(
						"ttsr-injection",
						injection.content,
						false,
						details,
						"agent",
					);
					this.#markInjected(details.rules);
				}
				try {
					await this.#host.agent.continue();
				} catch {
					this.resolveResume();
				}
			},
			{ delayMs: 50 },
		);
		return true;
	}

	#extractFilePathsFromArgs(args: unknown): string[] | undefined {
		if (!isRecord(args)) return undefined;
		const rawPaths: string[] = [];
		for (const key in args) {
			const value = args[key];
			const normalizedKey = key.toLowerCase();
			if (typeof value === "string" && (normalizedKey === "path" || normalizedKey.endsWith("path"))) {
				rawPaths.push(value);
				continue;
			}
			if (Array.isArray(value) && (normalizedKey === "paths" || normalizedKey.endsWith("paths"))) {
				for (const candidate of value) if (typeof candidate === "string") rawPaths.push(candidate);
			}
		}
		const paths = dedupePaths(rawPaths);
		return paths.length === 0 ? undefined : paths;
	}
}

/** Target paths travel as the tool spelled them; the matcher resolves spellings against the cwd. */
/**
 * Derived `did:` history plus the transcript fingerprint it was derived from.
 * References are weak so a compacted transcript is freed even if no `did:` leaf
 * runs again to notice the rewrite.
 */
interface HistoryCache {
	source: WeakRef<object>;
	tail: WeakRef<object> | undefined;
	scanned: number;
	excluded: string | undefined;
	records: ToolCallRecord[];
}

/** Arguments as `did: { args: … }` sees them, capped so one huge call cannot dominate history. */
function serializeCallArgs(args: unknown): string | undefined {
	if (args === undefined) return undefined;
	const text = JSON.stringify(args);
	if (typeof text !== "string") return undefined;
	return text.length > MAX_HISTORY_ARGS ? text.slice(0, MAX_HISTORY_ARGS) : text;
}

/** The tool call ids an assistant message emitted, identifying one batch. */
function toolCallIdsOf(message: AgentMessage): string[] {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	const ids: string[] = [];
	for (const block of message.content) {
		if (block && typeof block === "object" && block.type === "toolCall" && typeof block.id === "string") {
			ids.push(block.id);
		}
	}
	return ids;
}

/** Whether these content blocks belong to the batch under evaluation. */
function containsAnyToolCall(content: readonly unknown[], ids: readonly string[]): boolean {
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const candidate = block as { type?: string; id?: string };
		if (candidate.type === "toolCall" && candidate.id !== undefined && ids.includes(candidate.id)) return true;
	}
	return false;
}

function dedupePaths(filePaths: readonly string[]): string[] {
	const seen = new Set<string>();
	for (const filePath of filePaths) {
		const trimmed = filePath.trim();
		if (trimmed.length > 0) seen.add(trimmed);
	}
	return Array.from(seen);
}

/** Render the buffer lines that tripped a rule, so the reminder points at the violation. */
function formatEvidence(evidence: MatchEvidence): string | undefined {
	if (evidence.snippets.length === 0) return undefined;
	return evidence.snippets.map(snippet => `L${snippet.line}: ${snippet.text}`).join("\n");
}
