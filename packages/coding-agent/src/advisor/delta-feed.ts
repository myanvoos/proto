import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { SecretObfuscator } from "../secrets/obfuscator";
import { formatSessionHistoryMarkdown } from "../session/session-history-format";
import {
	ADVISOR_RENDER_OPTIONS,
	ADVISOR_UPDATE_HEADING,
	ADVISOR_WIP_SUFFIX,
	renderAdvisorDeltaChunks,
} from "./delta-split";

export interface RenderedFeedItem {
	text: string;
	rawMessages: AgentMessage[];
	renderRevision: number;
	wip: boolean;
}

export interface ReviewerFeedHost {
	snapshotMessages(): AgentMessage[];

	obfuscator?: SecretObfuscator;
}

export interface ReviewerFeedOwner {
	includeThinking(): boolean;

	scrubHistory(obfuscator: SecretObfuscator, sharedRegexSecretValues: ReadonlySet<string>): void;

	stripPendingPlaceholderPrefixes(obfuscator: SecretObfuscator, sharedRegexSecretValues: ReadonlySet<string>): void;

	onDeliveredPrefixChanged(): void;
}

export interface ReviewerFeed {
	readonly renderRevision: number;

	readonly lastCount: number;

	render(messages: AgentMessage[], wip?: boolean): RenderedFeedItem | null;

	renderRaw(rawMessages: AgentMessage[], wip?: boolean): string | null;

	renderPrepared(preparedMessages: AgentMessage[], wip?: boolean): string | null;

	renderChunks(preparedMessages: AgentMessage[], wip?: boolean): AgentMessage[] | null;

	seedTo(count: number): void;

	reset(): void;

	clearSeenContext(): void;

	clearSecrets(): void;
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

export class DeltaCursorFeed implements ReviewerFeed {
	#lastCount = 0;

	#deliveredPrefix: DeliveredMessage[] = [];
	#prefixBackup: DeliveredMessage[] | undefined;

	#renderRevision = 0;

	#advisorRegexSecretValues = new Set<string>();

	constructor(
		private readonly host: ReviewerFeedHost,
		private readonly owner: ReviewerFeedOwner,
	) {}

	get renderRevision(): number {
		return this.#renderRevision;
	}

	get lastCount(): number {
		return this.#lastCount;
	}

	seedTo(count: number): void {
		const messages = this.host.snapshotMessages().slice(0, count);
		this.#lastCount = messages.length;
		this.#deliveredPrefix = messages.map(message => ({
			message,
			fingerprint: fingerprintMessage(message),
		}));
	}

	reset(): void {
		this.#lastCount = 0;
		this.#deliveredPrefix = [];
	}

	clearSeenContext(): void {
		this.#advisorRegexSecretValues.clear();
		this.#renderRevision++;
	}

	clearSecrets(): void {
		this.#advisorRegexSecretValues.clear();
	}

	render(messages: AgentMessage[], wip = false): RenderedFeedItem | null {
		const cursorBefore = this.#lastCount;
		try {
			return this.#renderDelta(messages, wip);
		} catch (err) {
			this.#lastCount = cursorBefore;
			if (this.#prefixBackup !== undefined) {
				this.#deliveredPrefix = this.#prefixBackup;
				this.#prefixBackup = undefined;
			}
			throw err;
		}
	}

	#beginMutate(): void {
		if (this.#prefixBackup === undefined) this.#prefixBackup = this.#deliveredPrefix.slice();
	}

	#renderDelta(all: AgentMessage[], wip: boolean): RenderedFeedItem | null {
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
			this.#beginMutate();
			delivered.message = current;
		}
		if (prefixChanged) {
			this.owner.onDeliveredPrefixChanged();
		}
		const rawMessages = all.slice(this.#lastCount);
		if (rawMessages.length > 0) this.#beginMutate();
		for (let i = this.#lastCount; i < all.length; i++) {
			const message = all[i];
			if (message === undefined) continue;
			this.#deliveredPrefix.push({ message, fingerprint: fingerprintMessage(message) });
		}
		this.#lastCount = all.length;
		const text = this.renderRaw(rawMessages, wip);
		return text ? { text, rawMessages, renderRevision: this.#renderRevision, wip } : null;
	}

	renderRaw(rawMessages: AgentMessage[], wip = false): string | null {
		const delta = rawMessages.filter(message => !(message.role === "custom" && message.customType === "advisor"));
		return this.renderPrepared(delta, wip);
	}

	renderPrepared(preparedMessages: AgentMessage[], wip = false): string | null {
		const delta = preparedMessages;
		if (delta.length === 0) return null;
		const obfuscator = this.host.obfuscator;
		let md = formatSessionHistoryMarkdown(delta, {
			...ADVISOR_RENDER_OPTIONS,
			includeThinking: this.owner.includeThinking(),
		});
		if (!md.trim()) return null;
		if (obfuscator?.hasSecrets()) {
			this.#collectAdvisorSecrets(obfuscator, delta, md);
			md = obfuscator.obfuscate(md, this.#advisorRegexSecretValues);
		}

		const mdHead = `${ADVISOR_UPDATE_HEADING}\n\n${md}`;
		if (!wip) return mdHead;
		return `${mdHead}${ADVISOR_WIP_SUFFIX}`;
	}

	renderChunks(preparedMessages: AgentMessage[], wip = false): AgentMessage[] | null {
		const delta = preparedMessages;
		if (delta.length === 0) return null;

		const obfuscator = this.host.obfuscator;

		const probeMd = formatSessionHistoryMarkdown(delta, {
			...ADVISOR_RENDER_OPTIONS,
			includeThinking: this.owner.includeThinking(),
		});
		if (obfuscator?.hasSecrets()) {
			this.#collectAdvisorSecrets(obfuscator, delta, probeMd);
		}

		const chunks = renderAdvisorDeltaChunks(delta, {
			wip,
			includeThinking: this.owner.includeThinking(),
			obfuscator: obfuscator?.hasSecrets() ? obfuscator : undefined,
			advisorRegexSecretValues: this.#advisorRegexSecretValues,
		});
		return chunks;
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
		this.owner.scrubHistory(obfuscator, this.#advisorRegexSecretValues);
		if (discoveredNewRegexSecretValue) {
			this.owner.stripPendingPlaceholderPrefixes(obfuscator, this.#advisorRegexSecretValues);
		}
		return discoveredNewRegexSecretValue;
	}
}
