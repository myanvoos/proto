import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { raceWithSignal } from "@oh-my-pi/pi-ai/utils/abort";
import { type CursorExecResolvedCarrier, kCursorExecResolved } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { logger } from "@oh-my-pi/pi-utils";
import { obfuscateToolArguments } from "../secrets/message-transform";
import type { SecretObfuscator } from "../secrets/obfuscator";
import {
	formatExecutionSourcePreview,
	formatSessionHistoryMarkdown,
	formatToolResultErrorPreview,
} from "../session/session-history-format";
import { ADVISOR_RENDER_OPTIONS, renderAdvisorDeltaChunks } from "./delta-split";

export interface AdvisorAgent {
	prompt(input: string | AgentMessage[]): Promise<void>;
	abort(reason?: unknown): void;
	reset(): void;

	rollbackTo?(count: number): void;
	readonly state: { messages: AgentMessage[]; error?: string };
}

export interface AdvisorRuntimeHost {
	snapshotMessages(): AgentMessage[];

	enqueueAdvice(note: string, severity?: "nit" | "concern" | "blocker"): void;

	obfuscator?: SecretObfuscator;

	maintainContext?(incoming: AgentMessage, signal: AbortSignal): Promise<boolean>;

	beginAdvisorUpdate?(inProgress: boolean): void;

	onTurnError?(
		error: unknown,
		failedMessages: readonly AgentMessage[],
		signal: AbortSignal,
	): Promise<boolean | undefined> | boolean | undefined;

	onTurnSuccess?(): Promise<void> | void;

	notifyFailure?(error: unknown): void;

	notifyQuotaExhausted?(): void;

	getModelIdentity?(): string;
}

function isPermanentAdvisorError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /invalid_request_error|model[_ ]not[_ ]found|is not supported when|does not exist/i.test(message);
}

const ADVISOR_QUARANTINE_PREFIX = "Advisor response quarantined";

export class AdvisorOutputQuarantinedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AdvisorOutputQuarantinedError";
	}
}

interface AdvisorOutputHazard {
	label: string;
	pattern: RegExp;
}

const ADVISOR_OUTPUT_ONLY_HAZARDS: readonly AdvisorOutputHazard[] = [
	{ label: "account-deletion claim", pattern: /\buser\b.{0,80}\b(?:deleted|erased)\b.{0,80}\baccount\b/i },
	{
		label: "instruction override",
		pattern: /\bignore\s+(?:all\s+)?(?:prior|previous|earlier)\s+(?:user\s+)?instructions\b/i,
	},
	{
		label: "destructive shell command",
		pattern: /\brm\s+(?=(?:-[a-z]+\s*)*-[a-z]*r[a-z]*)(?=(?:-[a-z]+\s*)*-[a-z]*f[a-z]*)(?:-[a-z]+\s*)+/i,
	},
	{ label: "denial instruction", pattern: /\bdeny\s+(?:this|it|the\s+request)\s+if\s+(?:asked|questioned)\b/i },
];

export function quarantineAdvisorUnsafeOutput(
	message: AssistantMessage,
	availableToolNames: ReadonlySet<string>,
	sourceText = "",
): string | undefined {
	const reasons: string[] = [];
	const unavailableToolNames = new Set<string>();
	const generatedParts: string[] = [];
	for (const block of message.content) {
		if (
			block.type === "toolCall" &&
			!availableToolNames.has(block.name) &&
			(block as CursorExecResolvedCarrier)[kCursorExecResolved] !== true
		) {
			unavailableToolNames.add(block.name);
		}
		if (block.type === "toolCall" && block.name === "advise" && typeof block.arguments.note === "string") {
			generatedParts.push(block.arguments.note);
		}
		if (block.type === "text") generatedParts.push(block.text);
	}
	if (unavailableToolNames.size > 0) {
		const names = [...unavailableToolNames].sort();
		const toolLabel = names.length === 1 ? "tool" : "tools";
		reasons.push(`requested unavailable ${toolLabel} ${names.join(", ")}`);
	}

	const generatedText = generatedParts.join("\n");
	if (generatedText) {
		const labels: string[] = [];
		const matchedLabels: string[] = [];
		for (const hazard of ADVISOR_OUTPUT_ONLY_HAZARDS) {
			if (!hazard.pattern.test(generatedText)) continue;
			matchedLabels.push(hazard.label);
			if (!hazard.pattern.test(sourceText)) labels.push(hazard.label);
		}

		if (
			matchedLabels.includes("destructive shell command") &&
			labels.includes("instruction override") &&
			!labels.includes("destructive shell command")
		) {
			labels.push("destructive shell command");
		}
		if (labels.includes("destructive shell command") || labels.length >= 3) {
			reasons.push(`generated output-only destructive directives: ${labels.join(", ")}`);
		}
	}

	if (reasons.length === 0) return undefined;

	const messageText = `${ADVISOR_QUARANTINE_PREFIX}: ${reasons.join("; ")}`;
	message.content = [{ type: "text", text: messageText }];
	message.stopReason = "error";
	message.stopDetails = undefined;
	message.toolCallAbortMessages = undefined;
	message.providerPayload = undefined;
	message.errorMessage = messageText;
	return messageText;
}

export function buildAdvisorQuarantineSourceText(currentInput: string, messages: readonly AgentMessage[]): string {
	const parts: string[] = [];
	if (currentInput) parts.push(currentInput);
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		for (const block of message.content) {
			if (block.type === "text") parts.push(block.text);
		}
	}
	return parts.join("\n");
}

const MAX_COALESCE_ROUNDS = 3;

const MAX_QUARANTINE_RETRIES = 2;

interface PendingDelta {
	text: string;
	rawMessages: AgentMessage[];
	renderRevision: number;
	turns: number;

	wip: boolean;
	overflowRecovery?: boolean;
}

interface CatchupWaiter {
	threshold: number;
	finish: (caughtUp: boolean) => void;
	timer?: NodeJS.Timeout;
}

interface DeliveredMessage {
	message: AgentMessage;
	fingerprint: bigint | undefined;
}

function fingerprintMessage(message: AgentMessage): bigint | undefined {
	try {
		const m = message as unknown as Record<string, unknown>;
		const payload = JSON.stringify({
			r: m.role ?? null,
			c: m.content ?? null,
			toolCallId: m.toolCallId ?? null,
			toolName: m.toolName ?? null,
			err: m.isError ?? null,
			ct: m.customType ?? null,
			disp: m.display ?? null,
			cancel: m.cancelled ?? null,
			exit: m.exitCode ?? null,
			out: m.output ?? null,
			det: m.details ?? null,
			xfc: m.excludeFromContext ?? null,
			cmd: m.command ?? null,
			code: m.code ?? null,
			sum: m.summary ?? null,
			from: m.fromId ?? null,
			files: m.files ?? null,
		});
		if (payload === undefined) return undefined;
		return Bun.hash.wyhash(payload);
	} catch {
		return undefined;
	}
}

export class AdvisorRuntime {
	#lastCount = 0;

	#deliveredPrefix: DeliveredMessage[] = [];

	#renderRevision = 0;

	#advisorRegexSecretValues = new Set<string>();
	#pending: PendingDelta[] = [];
	#busy = false;
	#sessionTransitionPaused = false;
	#promptInFlight: Promise<void> | undefined;
	#iterationAbort: AbortController | undefined;
	#backlog = 0;
	#consecutiveFailures = 0;
	#failureNotified = false;

	#consecutiveQuarantines = 0;

	readonly #refusalModelsTried = new Set<string>();

	#includeThinking = true;
	#modelIdentity: string | undefined;

	#droppedBacklogs = 0;

	#halted = false;

	#failing = false;
	#latestMessages?: AgentMessage[];
	#waiters: CatchupWaiter[] = [];

	#epoch = 0;
	disposed = false;

	#quotaExhausted = false;

	constructor(
		private readonly agent: AdvisorAgent,
		private readonly host: AdvisorRuntimeHost,
		private readonly retryDelayMs = 1000,
	) {}

	get backlog(): number {
		return this.#backlog;
	}
	get quotaExhausted(): boolean {
		return this.#quotaExhausted;
	}
	get failureNotified(): boolean {
		return this.#failureNotified;
	}

	get halted(): boolean {
		return this.#halted;
	}

	onTurnEnd(messages?: AgentMessage[], opts?: { willContinue?: boolean }): void {
		if (this.disposed || this.#quotaExhausted || this.#halted) return;
		const all = messages ?? this.host.snapshotMessages();
		this.#latestMessages = all;
		const wip = opts?.willContinue ?? false;
		let rendered: Omit<PendingDelta, "turns" | "overflowRecovery"> | null = null;

		const cursorBefore = this.#lastCount;
		const prefixBefore = this.#deliveredPrefix.slice();
		try {
			rendered = this.#renderDelta(all, wip);
		} catch (err) {
			this.#lastCount = cursorBefore;
			this.#deliveredPrefix = prefixBefore;
			this.#failing = true;
			this.#wakeAllWaiters();
			logger.warn("advisor delta render failed", { err: String(err) });
		}
		if (rendered) {
			this.#pending.push({ ...rendered, turns: 1 });
			this.#backlog++;
			this.#notifyWaiters();
			void this.#drain();
		}
	}

	waitForCatchup(maxMs: number, threshold: number, signal?: AbortSignal): Promise<boolean> {
		if (
			this.disposed ||
			signal?.aborted ||
			this.#backlog < threshold ||
			this.#quotaExhausted ||
			this.#halted ||
			this.#failing
		)
			return Promise.resolve(this.#backlog < threshold);
		const { promise, resolve } = Promise.withResolvers<boolean>();
		let waiter!: CatchupWaiter;
		const finish = (caughtUp: boolean): void => {
			const idx = this.#waiters.indexOf(waiter);
			if (idx >= 0) this.#waiters.splice(idx, 1);
			clearTimeout(waiter.timer);
			signal?.removeEventListener("abort", abort);
			resolve(caughtUp);
		};
		const abort = (): void => finish(false);
		waiter = {
			threshold,
			finish,
			timer: setTimeout(abort, maxMs),
		};
		this.#waiters.push(waiter);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) {
			abort();
		}
		return promise;
	}

	dispose(): void {
		this.#iterationAbort?.abort("advisor disposed");
		this.disposed = true;
		this.#epoch++;
		this.#pending = [];
		this.#backlog = 0;
		this.#consecutiveFailures = 0;
		this.#failureNotified = false;
		this.#advisorRegexSecretValues.clear();
		this.#wakeAllWaiters();
		try {
			this.agent.abort("advisor disposed");
		} catch {}
	}

	#clearSeenContext(): void {
		this.#advisorRegexSecretValues.clear();
		this.#renderRevision++;
	}

	#clearAdvisorContextAtCurrentCursor(): void {
		this.#consecutiveFailures = 0;
		this.#clearSeenContext();
		try {
			this.agent.reset();
		} catch {}
		try {
			this.agent.abort("advisor reset");
		} catch {}
	}

	#resetAdvisorContext(clearBacklog: boolean, wakeWaiters: boolean, reason?: string): void {
		if (reason) {
			logger.debug("advisor context reset", {
				reason,
				lastCount: this.#lastCount,
				pending: this.#pending.length,
				backlog: this.#backlog,
			});
		}
		this.#lastCount = 0;
		this.#deliveredPrefix = [];
		this.#pending = [];
		this.#clearAdvisorContextAtCurrentCursor();
		if (clearBacklog) {
			this.#backlog = 0;
		}
		if (wakeWaiters) {
			this.#wakeAllWaiters();
		}
	}

	#noteDroppedBacklog(error: unknown): void {
		this.#droppedBacklogs++;
		if (this.#droppedBacklogs < 3 && !isPermanentAdvisorError(error)) return;
		this.#halted = true;
		this.#pending = [];
		this.#wakeAllWaiters();
		logger.warn("advisor halted after repeated failures; use /advisor or reload config to re-enable", {
			droppedBacklogs: this.#droppedBacklogs,
			err: String(error),
		});
	}

	pauseForSessionTransition(): Promise<void> {
		if (!this.#sessionTransitionPaused) {
			this.#sessionTransitionPaused = true;
			this.#wakeAllWaiters();
			this.#iterationAbort?.abort("advisor session transition");
			try {
				this.agent.abort("advisor session transition");
			} catch {}
		}
		return (
			this.#promptInFlight?.then(
				() => {},
				() => {},
			) ?? Promise.resolve()
		);
	}

	resumeAfterSessionTransition(): void {
		if (!this.#sessionTransitionPaused) return;
		this.#sessionTransitionPaused = false;
		if (!this.#quotaExhausted && !this.#halted) void this.#drain();
	}

	reset(reason = "external"): void {
		this.#iterationAbort?.abort("advisor reset");
		this.#epoch++;
		this.#sessionTransitionPaused = false;
		this.#quotaExhausted = false;
		this.#halted = false;
		this.#failing = false;
		this.#droppedBacklogs = 0;
		this.#consecutiveQuarantines = 0;
		this.#refusalModelsTried.clear();
		this.#failureNotified = false;
		this.#resetAdvisorContext(true, true, reason);
	}

	seedTo(count: number): void {
		const messages = this.host.snapshotMessages().slice(0, count);
		this.#lastCount = messages.length;
		this.#deliveredPrefix = messages.map(message => ({
			message,
			fingerprint: fingerprintMessage(message),
		}));
		this.#pending = [];
		this.#backlog = 0;
		this.#consecutiveFailures = 0;
		this.#failing = false;
		this.#droppedBacklogs = 0;
		this.#failureNotified = false;
		this.#clearSeenContext();
		this.#wakeAllWaiters();
	}

	#syncModelIdentity(): void {
		const identity = this.host.getModelIdentity?.();
		if (identity === undefined || identity === this.#modelIdentity) return;
		this.#modelIdentity = identity;
		this.#includeThinking = true;
	}

	#collectAdvisorSecrets(obfuscator: SecretObfuscator, _delta: AgentMessage[], renderedMd: string): boolean {
		let discoveredNewRegexSecretValue = false;
		const addRegexValues = (text: string): void => {
			for (const secretValue of obfuscator.collectRegexSecretValuesForObfuscation(text) ?? []) {
				if (this.#advisorRegexSecretValues.has(secretValue)) continue;
				this.#advisorRegexSecretValues.add(secretValue);
				discoveredNewRegexSecretValue = true;
			}
		};
		addRegexValues(renderedMd);
		scrubAdvisorHistory(obfuscator, this.agent.state.messages, this.#advisorRegexSecretValues);
		if (discoveredNewRegexSecretValue) {
			this.#pending = this.#pending.map(delta => ({
				...delta,
				text: obfuscator.stripUnsafeFriendlyPlaceholderPrefixes(delta.text, this.#advisorRegexSecretValues),
			}));
		}
		return discoveredNewRegexSecretValue;
	}

	#formatRawDeltaMessageChunks(preparedMessages: AgentMessage[], wip = false): AgentMessage[] | null {
		const delta = preparedMessages;
		if (delta.length === 0) return null;

		const obfuscator = this.host.obfuscator;

		const probeMd = formatSessionHistoryMarkdown(delta, {
			...ADVISOR_RENDER_OPTIONS,
			includeThinking: this.#includeThinking,
		});
		if (obfuscator?.hasSecrets()) {
			this.#collectAdvisorSecrets(obfuscator, delta, probeMd);
		}

		const chunks = renderAdvisorDeltaChunks(delta, {
			wip,
			includeThinking: this.#includeThinking,
			obfuscator: obfuscator?.hasSecrets() ? obfuscator : undefined,
			advisorRegexSecretValues: this.#advisorRegexSecretValues,
		});
		return chunks;
	}

	#formatRawDelta(rawMessages: AgentMessage[], wip = false): string | null {
		const delta = rawMessages.filter(message => !(message.role === "custom" && message.customType === "advisor"));
		return this.#renderPreparedDelta(delta, wip);
	}

	#renderPreparedDelta(preparedMessages: AgentMessage[], wip = false): string | null {
		const delta = preparedMessages;
		if (delta.length === 0) return null;
		const obfuscator = this.host.obfuscator;
		let md = formatSessionHistoryMarkdown(delta, {
			...ADVISOR_RENDER_OPTIONS,
			includeThinking: this.#includeThinking,
		});
		if (!md.trim()) return null;
		if (obfuscator?.hasSecrets()) {
			this.#collectAdvisorSecrets(obfuscator, delta, md);
			md = obfuscator.obfuscate(md, this.#advisorRegexSecretValues);
		}

		const heading = "### Session update";
		const mdHead = `${heading}\n\n${md}`;
		if (!wip) return mdHead;
		return `${mdHead}\n\n---\n\n[in progress — more steps follow]`;
	}

	#renderDelta(messages?: AgentMessage[], wip = false): Omit<PendingDelta, "turns" | "overflowRecovery"> | null {
		const all = messages ?? this.#latestMessages ?? this.host.snapshotMessages();
		let prefixChanged = all.length < this.#lastCount;
		for (let i = 0; !prefixChanged && i < this.#lastCount; i++) {
			const delivered = this.#deliveredPrefix[i];
			const current = all[i];
			if (delivered === undefined || current === undefined) {
				prefixChanged = true;
				break;
			}
			if (delivered.message === current) continue;
			const fingerprint = fingerprintMessage(current);
			if (
				delivered.fingerprint === undefined ||
				fingerprint === undefined ||
				delivered.fingerprint !== fingerprint
			) {
				prefixChanged = true;

				try {
					const oldMsg: Record<string, unknown> = delivered.message as unknown as Record<string, unknown>;
					const newMsg: Record<string, unknown> = current as unknown as Record<string, unknown>;
					const differingFields: string[] = [];
					for (const key of new Set([...Object.keys(oldMsg), ...Object.keys(newMsg)])) {
						if (JSON.stringify(oldMsg[key]) !== JSON.stringify(newMsg[key])) differingFields.push(key);
					}
					logger.debug("advisor delivered prefix changed", { index: i, role: newMsg.role, differingFields });
				} catch {}
				break;
			}
			delivered.message = current;
		}
		if (prefixChanged) {
			this.#epoch++;
			logger.debug("advisor context reset", { reason: "delivered-prefix-changed", lastCount: this.#lastCount });
			this.#resetAdvisorContext(true, true);
		}
		const rawMessages = all.slice(this.#lastCount);
		for (let i = this.#lastCount; i < all.length; i++) {
			const message = all[i];
			if (message === undefined) continue;
			this.#deliveredPrefix.push({ message, fingerprint: fingerprintMessage(message) });
		}
		this.#lastCount = all.length;
		const text = this.#formatRawDelta(rawMessages, wip);
		return text ? { text, rawMessages, renderRevision: this.#renderRevision, wip } : null;
	}

	#notifyWaiters(): void {
		for (let i = this.#waiters.length - 1; i >= 0; i--) {
			const w = this.#waiters[i];
			if (this.#backlog < w.threshold) {
				w.finish(true);
			}
		}
	}

	#wakeAllWaiters(): void {
		for (const w of [...this.#waiters]) {
			w.finish(false);
		}
	}

	#rollbackFailedTurn(snapshot: number): void {
		const messages = this.agent.state.messages;
		if (messages.length <= snapshot) return;
		try {
			if (this.agent.rollbackTo) {
				this.agent.rollbackTo(snapshot);
				return;
			}
			messages.length = snapshot;
		} catch (err) {
			logger.debug("advisor rollback failed", { err: String(err) });
		}
	}

	async #collectAndMaintainBatch(
		epoch: number,
		initial: PendingDelta[],
		recoveringOverflow: boolean,
		signal: AbortSignal,
	): Promise<{
		batch: string | null;
		rawMessages: AgentMessage[];
		preparedMessages: AgentMessage[];
		finalTurns: number;
		wip: boolean;
		resetContext: boolean;
	} | null> {
		let batchText = initial.map(b => b.text).join("\n\n");
		let rawMessages = initial.flatMap(b => b.rawMessages);
		let turns = initial.reduce((sum, b) => sum + b.turns, 0);

		let wip = initial.at(-1)?.wip ?? false;

		for (let round = 0; round < MAX_COALESCE_ROUNDS; round++) {
			if (this.#sessionTransitionPaused) break;
			if (this.host.maintainContext) {
				let shouldResetContext = false;
				try {
					shouldResetContext = await this.host.maintainContext(
						{ role: "user", content: batchText, timestamp: Date.now() },
						signal,
					);
				} catch (err) {
					logger.debug("advisor context maintenance failed", { err: String(err) });
				}

				if (this.#epoch !== epoch) return null;

				if (shouldResetContext) {
					if (round > 0) {
						const lateItems = this.#pending.splice(0);
						initial.push(...lateItems);
						turns += lateItems.reduce((sum, b) => sum + b.turns, 0);
						if (lateItems.length > 0) {
							wip = lateItems.at(-1)!.wip;
							rawMessages = rawMessages.concat(lateItems.flatMap(b => b.rawMessages));
						}
					}

					logger.debug("advisor context reset", {
						reason: "context-maintenance",
						lastCount: this.#lastCount,
						pending: this.#pending.length,
						backlog: this.#backlog,
					});
					this.#clearAdvisorContextAtCurrentCursor();
					const { batch: rerendered, preparedMessages } = this.#prepareBatch(rawMessages, wip, batchText);
					return {
						batch: rerendered ?? (batchText || null),
						rawMessages,
						preparedMessages,
						finalTurns: turns,
						wip,
						resetContext: true,
					};
				}
			}

			if (recoveringOverflow) break;

			if (round === MAX_COALESCE_ROUNDS - 1) break;

			const late = this.#pending.splice(0);
			if (late.length === 0) break;
			initial.push(...late);
			batchText = [batchText, ...late.map(b => b.text)].join("\n\n");
			rawMessages = rawMessages.concat(late.flatMap(b => b.rawMessages));
			turns += late.reduce((sum, b) => sum + b.turns, 0);
			wip = late.at(-1)!.wip;
		}

		const { batch: preparedBatch, preparedMessages } = this.#prepareBatch(rawMessages, wip, batchText);
		return {
			batch: preparedBatch ?? (batchText || null),
			rawMessages,
			preparedMessages,
			finalTurns: turns,
			wip,
			resetContext: false,
		};
	}

	#prepareBatch(
		rawMessages: AgentMessage[],
		wip: boolean,
		fallback: string | null,
	): { batch: string | null; preparedMessages: AgentMessage[] } {
		const preparedMessages = rawMessages.filter(
			message => !(message.role === "custom" && message.customType === "advisor"),
		);
		const batch = this.#renderPreparedDelta(preparedMessages, wip);
		return { batch: batch ?? fallback, preparedMessages };
	}

	#terminalAssistantFailure(snapshot: number): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= snapshot; i--) {
			const message = messages[i];
			if (message.role === "assistant" && message.stopReason === "error") return message;
		}
		return undefined;
	}

	#notifyFailureOnce(error: unknown): void {
		if (this.#failureNotified) return;
		this.#failureNotified = true;
		try {
			this.host.notifyFailure?.(error);
		} catch (notifyErr) {
			logger.warn("advisor failure notification failed", { err: String(notifyErr) });
		}
	}

	async #drain(): Promise<void> {
		if (this.#busy || this.#sessionTransitionPaused) return;
		this.#busy = true;
		try {
			this.#syncModelIdentity();
			while (!this.disposed && !this.#sessionTransitionPaused && this.#pending.length) {
				this.#syncModelIdentity();
				let popped: PendingDelta[];
				if (this.#pending[0]?.overflowRecovery) {
					const recovery = this.#pending.shift();
					if (!recovery) continue;
					popped = [recovery];
				} else {
					popped = this.#pending.splice(0);
				}
				const iterationAbort = new AbortController();
				this.#iterationAbort = iterationAbort;
				const epoch = this.#epoch;
				for (const delta of popped) {
					if (delta.renderRevision === this.#renderRevision) continue;

					delta.text = this.#formatRawDelta(delta.rawMessages, delta.wip) ?? delta.text;
					delta.renderRevision = this.#renderRevision;
				}
				const recoveringOverflow = popped.some(delta => delta.overflowRecovery === true);
				const result = await this.#collectAndMaintainBatch(
					epoch,
					popped,
					recoveringOverflow,
					iterationAbort.signal,
				);

				if (result === null) continue;
				if (this.#sessionTransitionPaused) {
					this.#pending.unshift(...popped);
					continue;
				}

				const { batch, rawMessages, preparedMessages, finalTurns, wip, resetContext } = result;

				if (this.disposed || batch === null) {
					this.#backlog = Math.max(0, this.#backlog - finalTurns);
					this.#notifyWaiters();
					continue;
				}

				let success = false;

				const messageSnapshot = this.agent.state.messages.length;
				const contextWasFresh = resetContext || recoveringOverflow || messageSnapshot === 0;
				try {
					this.host.beginAdvisorUpdate?.(wip);

					const splitMessages = this.#formatRawDeltaMessageChunks(preparedMessages, wip);
					const promptInput: string | AgentMessage[] = splitMessages ?? batch;
					const prompt = this.agent.prompt(promptInput);
					this.#promptInFlight = prompt;
					try {
						await prompt;
					} finally {
						if (this.#promptInFlight === prompt) this.#promptInFlight = undefined;
					}

					const promptError = this.agent.state.error;
					if (promptError) throw new Error(promptError);

					const turnError = getAdvisorTurnError(this.agent.state.messages.slice(messageSnapshot));
					if (turnError) throw turnError;
					success = true;
					this.#failing = false;
					this.#consecutiveFailures = 0;
					this.#failureNotified = false;
					this.#droppedBacklogs = 0;
					this.#consecutiveQuarantines = 0;
					this.#refusalModelsTried.clear();
					if (this.host.onTurnSuccess) {
						try {
							await raceWithSignal(Promise.resolve(this.host.onTurnSuccess()), iterationAbort.signal);
						} catch (hookErr) {
							logger.debug("advisor onTurnSuccess hook failed", { err: String(hookErr) });
						}
					}
				} catch (err) {
					if (this.#sessionTransitionPaused) {
						this.#rollbackFailedTurn(messageSnapshot);
						this.#pending.unshift(...popped);
						continue;
					}

					if (this.#epoch !== epoch) continue;

					this.#failing = true;
					this.#wakeAllWaiters();
					const failedMessages = this.agent.state.messages.slice(messageSnapshot);
					const terminalFailure = this.#terminalAssistantFailure(messageSnapshot);
					const rawErrorId = AIError.classify(err);
					const terminalFailureId =
						terminalFailure === undefined ? undefined : AIError.classifyMessage(terminalFailure);
					const classifierRefusal =
						(terminalFailure !== undefined && isClassifierRefusal(terminalFailure)) ||
						(!AIError.is(rawErrorId, AIError.Flag.AccountPolicy) &&
							AIError.is(rawErrorId, AIError.Flag.ContentBlocked));
					const contextOverflow =
						(terminalFailureId !== undefined && AIError.is(terminalFailureId, AIError.Flag.ContextOverflow)) ||
						AIError.is(rawErrorId, AIError.Flag.ContextOverflow);

					const terminalFailureRetriable =
						terminalFailureId === undefined ||
						AIError.retriable(terminalFailureId) ||
						AIError.is(terminalFailureId, AIError.Flag.ContextOverflow);
					this.#rollbackFailedTurn(messageSnapshot);
					logger.debug("advisor turn failed", { err: String(err) });
					if (classifierRefusal) {
						if (this.#includeThinking) {
							this.#includeThinking = false;

							const strippedBatch = this.#formatRawDelta(rawMessages, wip);
							if (strippedBatch) {
								this.#pending.unshift({
									text: strippedBatch,
									rawMessages,
									renderRevision: this.#renderRevision,
									turns: finalTurns,
									wip,
									overflowRecovery: recoveringOverflow || undefined,
								});
								logger.debug("advisor refusal recovered by stripping primary reasoning");
								continue;
							}
						}

						const refusalModel = this.host.getModelIdentity?.() ?? this.#modelIdentity ?? "";
						let refusalRecovered = false;
						try {
							if (!this.#refusalModelsTried.has(refusalModel)) {
								this.#refusalModelsTried.add(refusalModel);
								refusalRecovered =
									(await raceWithSignal(
										Promise.resolve(this.host.onTurnError?.(err, failedMessages, iterationAbort.signal)),
										iterationAbort.signal,
									)) === true;
							} else {
								logger.debug("advisor refusal chain exhausted", { model: refusalModel });
							}
						} catch (hookErr) {
							logger.debug("advisor onTurnError hook failed after refusal", { err: String(hookErr) });
						}
						if (this.#epoch !== epoch) continue;
						if (this.#sessionTransitionPaused) {
							this.#pending.unshift(...popped);
							continue;
						}
						if (refusalRecovered) {
							this.#consecutiveFailures = 0;
							this.#failureNotified = false;
							this.#pending.unshift({
								text: batch,
								rawMessages,
								renderRevision: this.#renderRevision,
								turns: finalTurns,
								wip,
								overflowRecovery: recoveringOverflow || undefined,
							});
							logger.debug("advisor refusal recovered by model fallback");
							continue;
						}

						this.#refusalModelsTried.clear();
						this.#notifyFailureOnce(err);
						this.#clearSeenContext();
						this.#backlog = Math.max(0, this.#backlog - finalTurns);
						this.#notifyWaiters();
						continue;
					}
					let recovered = false;
					try {
						recovered =
							(await raceWithSignal(
								Promise.resolve(this.host.onTurnError?.(err, failedMessages, iterationAbort.signal)),
								iterationAbort.signal,
							)) === true;
					} catch (hookErr) {
						logger.debug("advisor onTurnError hook failed", { err: String(hookErr) });
					}
					if (this.#sessionTransitionPaused) {
						this.#pending.unshift(...popped);
						continue;
					}
					if (err instanceof AdvisorOutputQuarantinedError) {
						this.#consecutiveQuarantines++;
						if (this.#consecutiveQuarantines >= MAX_QUARANTINE_RETRIES) {
							this.#notifyFailureOnce(err);
							this.#consecutiveQuarantines = 0;
							this.#resetAdvisorContext(true, true, "quarantine-retry-exhausted");
							continue;
						}
						const rePrime = this.#pending.length > 0 ? this.#latestMessages : undefined;

						this.#resetAdvisorContext(true, !rePrime, "quarantine-recovery");
						if (rePrime) this.onTurnEnd(rePrime);
						continue;
					}

					if (this.#epoch !== epoch) continue;
					if (recovered) {
						this.#consecutiveFailures = 0;
						this.#failureNotified = false;
						this.#pending.unshift({
							text: batch,
							rawMessages,
							renderRevision: this.#renderRevision,
							turns: finalTurns,
							wip,
							overflowRecovery: recoveringOverflow || undefined,
						});
						continue;
					}
					if (AIError.isUsageLimit(err)) {
						logger.warn("advisor quota exhausted", { err: String(err) });
						this.#quotaExhausted = true;
						this.#consecutiveFailures = 0;
						this.#failureNotified = false;
						this.#clearSeenContext();
						this.#pending.unshift({
							text: batch,
							rawMessages,
							renderRevision: this.#renderRevision,
							turns: finalTurns,
							wip,
							overflowRecovery: recoveringOverflow || undefined,
						});
						this.#wakeAllWaiters();
						try {
							this.host.notifyQuotaExhausted?.();
						} catch (notifyErr) {
							logger.warn("advisor quota notification failed", { err: String(notifyErr) });
						}
						break;
					}
					if (!terminalFailureRetriable) {
						logger.warn("advisor terminal failure is non-retriable; dropping bounded batch");
						this.#notifyFailureOnce(err);
						this.#consecutiveFailures = 0;

						this.#clearSeenContext();
						this.#noteDroppedBacklog(err);
						success = true;
					} else if (contextOverflow) {
						this.#clearAdvisorContextAtCurrentCursor();
						if (contextWasFresh) {
							logger.warn("advisor update overflowed a fresh context; dropping bounded batch");
							this.#notifyFailureOnce(err);
							success = true;
						} else {
							const recoveryBatch = this.#formatRawDelta(rawMessages, wip) ?? batch;
							this.#pending.unshift({
								text: recoveryBatch,
								rawMessages,
								renderRevision: this.#renderRevision,
								turns: finalTurns,
								wip,
								overflowRecovery: true,
							});
							logger.debug("advisor context overflow recovered at current primary cursor");
						}
					} else {
						this.#consecutiveFailures++;
						if (this.#consecutiveFailures >= 3) {
							logger.warn("advisor failed consecutively 3 times; dropping backlog to prevent stall");
							this.#notifyFailureOnce(err);
							this.#consecutiveFailures = 0;

							this.#clearSeenContext();
							this.#noteDroppedBacklog(err);
							success = true;
						} else {
							this.#pending.unshift({
								text: batch,
								rawMessages,
								renderRevision: this.#renderRevision,
								turns: finalTurns,
								wip,
								overflowRecovery: recoveringOverflow || undefined,
							});
							if (this.retryDelayMs <= 0) {
								await Bun.sleep(0);
							} else {
								try {
									await raceWithSignal(Bun.sleep(this.retryDelayMs), iterationAbort.signal);
								} catch (sleepError) {
									if (!iterationAbort.signal.aborted) throw sleepError;
								}
							}
						}
					}
				}

				if (success && this.#epoch === epoch) {
					this.#backlog = Math.max(0, this.#backlog - finalTurns);
					this.#notifyWaiters();
				}
			}
		} finally {
			this.#iterationAbort = undefined;
			this.#busy = false;
		}
	}
}

function isClassifierRefusal(message: AssistantMessage): boolean {
	if (message.stopReason !== "error") return false;
	const id = AIError.classifyMessage(message);
	if (AIError.is(id, AIError.Flag.AccountPolicy)) return false;
	const stopType = message.stopDetails?.type;
	if (stopType === "refusal" || stopType === "sensitive") return true;
	return AIError.is(id, AIError.Flag.ContentBlocked);
}

function getAdvisorTurnError(messages: readonly AgentMessage[]): Error | undefined {
	if (messages.length === 0) return undefined;
	if (messages.some(message => message.role === "assistant")) return undefined;
	return new Error("Advisor turn ended without an assistant response");
}

type TextualContent = string | readonly (TextContent | ImageContent)[];

function obfuscateTextualContent(
	obfuscator: SecretObfuscator,
	content: TextualContent,
	sharedRegexSecretValues: ReadonlySet<string>,
): TextualContent {
	if (typeof content === "string") return obfuscator.obfuscate(content, sharedRegexSecretValues);
	let changed = false;
	const result = content.map((block): TextContent | ImageContent => {
		if (block.type !== "text") return block;
		const text = obfuscator.obfuscate(block.text, sharedRegexSecretValues);
		if (text === block.text) return block;
		changed = true;
		return { ...block, text };
	});
	return changed ? result : content;
}

function firstAdvisorToolResultErrorLine(content: TextualContent): string | undefined {
	if (typeof content === "string") return content.split("\n", 1)[0];
	const first = content[0];
	if (first?.type !== "text") return undefined;
	return first.text.split("\n", 1)[0];
}

function obfuscateAdvisorToolResultErrorContent(
	obfuscator: SecretObfuscator,
	content: TextualContent,
	sharedRegexSecretValues: ReadonlySet<string>,
): TextualContent {
	const firstLine = firstAdvisorToolResultErrorLine(content);
	if (firstLine === undefined) return content;
	const preview = formatToolResultErrorPreview(content);
	const obfuscatedPreview = obfuscator.obfuscate(preview, sharedRegexSecretValues);
	if (obfuscatedPreview === firstLine) return content;
	if (typeof content === "string") return obfuscatedPreview + content.slice(firstLine.length);
	const first = content[0]!;
	if (first.type !== "text") return content;
	return [{ ...first, text: obfuscatedPreview + first.text.slice(firstLine.length) }, ...content.slice(1)];
}

function obfuscateAssistantMessage(
	obfuscator: SecretObfuscator,
	message: AssistantMessage,
	sharedRegexSecretValues: ReadonlySet<string>,
): AssistantMessage {
	let changed = false;
	const content = message.content.map((block): AssistantMessage["content"][number] => {
		if (block.type === "text") {
			const text = obfuscator.obfuscate(block.text, sharedRegexSecretValues);
			if (text === block.text) return block;
			changed = true;
			return { ...block, text };
		}
		if (block.type === "thinking") {
			const thinking = obfuscator.obfuscate(block.thinking, sharedRegexSecretValues);
			if (thinking === block.thinking) return block;
			changed = true;
			return { ...block, thinking, thinkingSignature: undefined };
		}
		if (block.type === "toolCall") {
			const args = obfuscateToolArguments(obfuscator, block.arguments, sharedRegexSecretValues);
			if (args === block.arguments) return block;
			changed = true;
			return { ...block, arguments: args };
		}
		return block;
	});
	return changed ? { ...message, content } : message;
}

function obfuscateDetails(
	obfuscator: SecretObfuscator,
	details: Record<string, unknown> | undefined,
	sharedRegexSecretValues: ReadonlySet<string>,
): Record<string, unknown> | undefined {
	if (!details) return details;

	return obfuscateToolArguments(obfuscator, details, sharedRegexSecretValues);
}

function obfuscateAdvisorMessage(
	obfuscator: SecretObfuscator,
	message: AgentMessage,
	sharedRegexSecretValues: ReadonlySet<string>,
): AgentMessage {
	switch (message.role) {
		case "user":
		case "developer": {
			const content = obfuscateTextualContent(
				obfuscator,
				message.content as TextualContent,
				sharedRegexSecretValues,
			);
			return content === message.content ? message : ({ ...(message as object), content } as AgentMessage);
		}
		case "toolResult": {
			const msg = message as AgentMessage & {
				content: TextualContent;
				details?: Record<string, unknown>;
				isError?: boolean;
			};
			const content = msg.isError
				? obfuscateAdvisorToolResultErrorContent(obfuscator, msg.content, sharedRegexSecretValues)
				: msg.content;
			let details = msg.details;
			if (typeof details?.diff === "string") {
				const diff = obfuscator.obfuscate(details.diff, sharedRegexSecretValues);
				if (diff !== details.diff) details = { ...details, diff };
			}
			if (content === msg.content && details === msg.details) return message;
			return { ...(message as object), content, details } as AgentMessage;
		}
		case "assistant":
			return obfuscateAssistantMessage(
				obfuscator,
				message as AssistantMessage,
				sharedRegexSecretValues,
			) as AgentMessage;
		case "custom":
		case "hookMessage": {
			if (!formatSessionHistoryMarkdown([message]).trim()) return message;
			const msg = message as AgentMessage & {
				content: TextualContent;
				details?: Record<string, unknown>;
			};
			const content = obfuscateTextualContent(obfuscator, msg.content, sharedRegexSecretValues);
			const details = obfuscateDetails(obfuscator, msg.details, sharedRegexSecretValues);
			if (content === msg.content && details === msg.details) return message;
			return { ...(message as object), content, details } as AgentMessage;
		}
		case "bashExecution": {
			const msg = message as AgentMessage & { command: string };
			const command = obfuscator.obfuscate(formatExecutionSourcePreview(msg.command), sharedRegexSecretValues);
			return command === msg.command ? message : ({ ...(message as object), command } as AgentMessage);
		}
		case "pythonExecution": {
			const msg = message as AgentMessage & { code: string };
			const code = obfuscator.obfuscate(formatExecutionSourcePreview(msg.code), sharedRegexSecretValues);
			return code === msg.code ? message : ({ ...(message as object), code } as AgentMessage);
		}
		case "branchSummary": {
			const msg = message as AgentMessage & { summary: string };
			const summary = obfuscator.obfuscate(msg.summary, sharedRegexSecretValues);
			return summary === msg.summary ? message : ({ ...(message as object), summary } as AgentMessage);
		}
		case "compactionSummary": {
			const msg = message as AgentMessage & { summary: string };
			const summary = obfuscator.obfuscate(msg.summary, sharedRegexSecretValues);
			return summary === msg.summary ? message : ({ ...(message as object), summary } as AgentMessage);
		}
		case "fileMention": {
			const msg = message as AgentMessage & {
				files: Array<{ path: string; content: string; image?: unknown }>;
			};
			let changed = false;
			const files = msg.files.map(file => {
				const path = obfuscator.obfuscate(file.path, sharedRegexSecretValues);
				if (path === file.path) return file;
				changed = true;
				return { ...file, path };
			});
			return changed ? ({ ...(message as object), files } as AgentMessage) : message;
		}
		default:
			return message;
	}
}

function scrubAdvisorHistory(
	obfuscator: SecretObfuscator,
	messages: AgentMessage[],
	sharedRegexSecretValues: ReadonlySet<string>,
): void {
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		const next = obfuscateAdvisorMessage(obfuscator, message, sharedRegexSecretValues);
		if (next !== message) messages[index] = next;
	}
}
