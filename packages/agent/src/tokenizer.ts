import type { Model, ProviderPayload, UserContent } from "@oh-my-pi/pi-ai";
import type { ModelTokenizer } from "@oh-my-pi/pi-catalog/types";
import * as natives from "@oh-my-pi/pi-natives";
import { stringifyJson } from "@oh-my-pi/pi-utils";
import { isEstimateCacheable, messageEstimateVersion } from "./compaction/message-cache";
import type { AgentMessage } from "./types";

const testEnv = Bun.env.NODE_ENV === "test";
const accurate = process.env.PI_TOKENIZER_ACCURATE === "1" && !testEnv;

const NATIVE_ENCODING: Record<ModelTokenizer, natives.Encoding> = {
	"claude-v3": natives.Encoding.ClaudeV3,
	"claude-v47": natives.Encoding.ClaudeV47,
	"claude-v5": natives.Encoding.ClaudeV5,
	"claude-v5-sonnet": natives.Encoding.ClaudeV5Sonnet,
	qwen3: natives.Encoding.Qwen3,
	"deepseek-v3": natives.Encoding.DeepSeekV3,
	"kimi-k2": natives.Encoding.KimiK2,
	glm5: natives.Encoding.Glm5,
};

export function tokenizerEncodingForModel(model: Pick<Model, "tokenizer"> | null | undefined): natives.Encoding | null {
	return model?.tokenizer ? NATIVE_ENCODING[model.tokenizer] : null;
}

export type TokenCountMode = "strict" | "approximate" | "upperbound";

export interface MessageCountOptions {
	excludeEncryptedReasoning?: boolean;
}

function byteEstimate(text: string): number {
	return (Buffer.byteLength(text, "utf-8") + 3) >> 2;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

function sumFragments(text: string | string[], perFragment: (t: string) => number): number {
	return Array.isArray(text) ? text.reduce((sum, t) => sum + perFragment(t), 0) : perFragment(text);
}

interface NativeTokenCount {
	tokens: number;
	exact: boolean;
}

/**
 * A stale native addon rejects encodings its string enum does not know yet (the version sentinel does not cover
 * that skew); fall back to the byte bound instead of failing spawn and compaction. Only `approximate` takes the
 * bytes/4 guess — every other mode keeps the conservative byte upper bound.
 */
function countTokensNat(
	text: string | string[],
	encoding: natives.Encoding | null | undefined,
	mode: TokenCountMode,
): NativeTokenCount {
	try {
		return { tokens: natives.countTokens(text, encoding), exact: true };
	} catch (error) {
		if (
			!(error instanceof Error) ||
			(!error.message.includes("does not match any variant of enum") &&
				!error.message.includes("unknown enum variant"))
		) {
			throw error;
		}
		return { tokens: sumFragments(text, mode === "approximate" ? byteEstimate : byteLength), exact: false };
	}
}

export interface TokenBudgetCheck {
	fits: boolean;

	tokens: number;

	exact: boolean;
}

const IMAGE_TOKEN_ESTIMATE = 1200;

const PROVIDER_PAYLOAD_METADATA_KEYS: Record<string, true> = {
	call_id: true,
	created_by: true,
	file_id: true,
	id: true,
	item_id: true,
	mimeType: true,
	mime_type: true,
	provider: true,
	role: true,
	status: true,
	type: true,
};

interface CollectedContent {
	fragments: string[];
	images: number;
}

interface MessageEstimate {
	version: number;
	default?: number;
	floored?: number;
}

export class Tokenizer {
	readonly #encoding: natives.Encoding | null;

	#estimates = new WeakMap<AgentMessage, MessageEstimate>();

	constructor(model?: Pick<Model, "tokenizer"> | null) {
		this.#encoding = tokenizerEncodingForModel(model);
	}

	get encoding(): natives.Encoding | null {
		return this.#encoding;
	}

	countTokens(text: string | string[], mode: TokenCountMode = "approximate"): number {
		if (mode === "strict") return countTokensNat(text, this.#encoding, mode).tokens;
		if (!testEnv && this.#encoding !== null) return countTokensNat(text, this.#encoding, mode).tokens;
		if (accurate) return countTokensNat(text, undefined, mode).tokens;
		return sumFragments(text, mode === "upperbound" ? byteLength : byteEstimate);
	}

	checkTokenBudget(text: string | string[], budget: number): TokenBudgetCheck {
		const bound = sumFragments(text, byteLength);
		if (bound <= budget) return { fits: true, tokens: bound, exact: false };
		const result = countTokensNat(text, this.#encoding, "strict");
		return { fits: result.tokens <= budget, tokens: result.tokens, exact: result.exact };
	}

	countMessage(message: AgentMessage, options?: MessageCountOptions): number {
		const floored = options?.excludeEncryptedReasoning === true;
		if (!isEstimateCacheable(message)) return this.#measureMessage(message, floored);
		const version = messageEstimateVersion(message);
		let entry = this.#estimates.get(message);
		if (entry === undefined || entry.version !== version) {
			entry = { version };
			this.#estimates.set(message, entry);
		}
		const cached = floored ? entry.floored : entry.default;
		if (cached !== undefined) return cached;
		const result = this.#measureMessage(message, floored);
		if (floored) entry.floored = result;
		else entry.default = result;
		return result;
	}

	countMessages(messages: readonly AgentMessage[], options?: MessageCountOptions): number {
		let total = 0;
		for (const message of messages) total += this.countMessage(message, options);
		return total;
	}

	#countCollected(content: CollectedContent): number {
		const textTokens = content.fragments.length === 0 ? 0 : this.countTokens(content.fragments);
		return textTokens + content.images * IMAGE_TOKEN_ESTIMATE;
	}

	#collectContent(content: string | readonly UserContent[]): CollectedContent {
		if (typeof content === "string") return { fragments: [content], images: 0 };

		const collected: CollectedContent = { fragments: [], images: 0 };
		for (const block of content) {
			switch (block.type) {
				case "text":
					collected.fragments.push(block.text);
					break;
				case "image":
					collected.images++;
					break;
				case "audio":
				case "video":
					// No duration is available, so encoded size is the only conservative signal.
					collected.fragments.push(block.data);
					break;
				default:
					this.#collectUnknownBlock(block, collected, false);
			}
		}
		return collected;
	}

	#collectUnknownBlock(block: unknown, collected: CollectedContent, excludeEncryptedReasoning: boolean): void {
		const fragmentsBefore = collected.fragments.length;
		const imagesBefore = collected.images;
		this.#collectUnknownValue(block, collected, excludeEncryptedReasoning, new Set());
		if (collected.fragments.length === fragmentsBefore && collected.images === imagesBefore) {
			collected.fragments.push("unknown");
		}
	}

	#collectProviderPayload(payload: ProviderPayload, excludeEncryptedReasoning: boolean): CollectedContent {
		const collected: CollectedContent = { fragments: [], images: 0 };
		switch (payload.type) {
			case "openaiResponsesHistory":
				// Native histories are wire objects: JSON.stringify would charge for IDs/status metadata and
				// can turn one base64 image into hundreds of thousands of fake text tokens. Walk their string
				// leaves instead, omitting structural metadata and charging images by the normal image estimate.
				this.#collectUnknownValue(payload.items, collected, excludeEncryptedReasoning, new Set());
				break;
			case "anthropicCompaction":
				collected.fragments.push(payload.content);
				if (payload.filesText) collected.fragments.push(payload.filesText);
				if (payload.encryptedContent && !excludeEncryptedReasoning) {
					collected.fragments.push(payload.encryptedContent);
				}
				break;
			case "anthropicMessage":
				// Request controls only; the message content carries the replayed text.
				break;
		}
		return collected;
	}

	#collectUnknownValue(
		value: unknown,
		collected: CollectedContent,
		excludeEncryptedReasoning: boolean,
		seen: Set<object>,
		key?: string,
	): void {
		if (typeof value === "string") {
			if (PROVIDER_PAYLOAD_METADATA_KEYS[key ?? ""] === true) return;
			if (key === "encrypted_content" && excludeEncryptedReasoning) return;
			collected.fragments.push(value);
			return;
		}
		if (value === null || typeof value !== "object" || seen.has(value)) return;
		seen.add(value);
		if (Array.isArray(value)) {
			for (const item of value) {
				this.#collectUnknownValue(item, collected, excludeEncryptedReasoning, seen, key);
			}
			return;
		}

		const record = value as Record<string, unknown>;
		const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
		const isImage = type.includes("image") || "image_url" in record;
		if (isImage) collected.images++;
		for (const [childKey, child] of Object.entries(record)) {
			if (isImage && (childKey === "data" || childKey === "file_data" || childKey === "image_url")) continue;
			this.#collectUnknownValue(child, collected, excludeEncryptedReasoning, seen, childKey);
		}
	}

	#countUnknownMessage(message: AgentMessage, excludeEncryptedReasoning: boolean): number {
		const collected: CollectedContent = { fragments: [], images: 0 };
		this.#collectUnknownValue(message, collected, excludeEncryptedReasoning, new Set());
		// AgentMessage is module-augmentable, so external roles cannot be exhaustively switched here.
		// A conservative structural estimate protects the context window; a warning alone would not.
		return Math.max(1, this.#countCollected(collected));
	}

	#measureMessage(message: AgentMessage, excludeEncryptedReasoning: boolean): number {
		const role: string = message.role;
		if (role === "bashExecution" || role === "pythonExecution" || role === "fileMention") {
			return this.#countUnknownMessage(message, excludeEncryptedReasoning);
		}

		switch (message.role) {
			case "user":
			case "developer": {
				const contentTokens = this.#countCollected(this.#collectContent(message.content));
				const payloadTokens = message.providerPayload
					? this.#countCollected(this.#collectProviderPayload(message.providerPayload, excludeEncryptedReasoning))
					: 0;
				return Math.max(contentTokens, payloadTokens);
			}
			case "assistant": {
				const collected: CollectedContent = { fragments: [], images: 0 };
				for (const block of message.content) {
					switch (block.type) {
						case "text":
							collected.fragments.push(block.text);
							break;
						case "thinking":
							collected.fragments.push(block.thinking);
							if (block.thinkingSignature && !excludeEncryptedReasoning) {
								collected.fragments.push(block.thinkingSignature);
							}
							break;
						case "toolCall":
							collected.fragments.push(block.name, stringifyJson(block.arguments) ?? "null");
							break;
						case "redactedThinking":
							if (!excludeEncryptedReasoning) collected.fragments.push(block.data);
							break;
						case "anthropicServerTool":
							if (!excludeEncryptedReasoning) collected.fragments.push(stringifyJson(block.block) ?? "null");
							break;
						case "fallback":
							collected.fragments.push(block.from.model, block.to.model);
							break;
						case "image":
							collected.images++;
							break;
						default:
							this.#collectUnknownBlock(block, collected, excludeEncryptedReasoning);
					}
				}
				const contentTokens = this.#countCollected(collected);
				const payloadTokens = message.providerPayload
					? this.#countCollected(this.#collectProviderPayload(message.providerPayload, excludeEncryptedReasoning))
					: 0;
				return Math.max(contentTokens, payloadTokens);
			}
			case "custom":
			case "hookMessage":
			case "toolResult":
				return this.#countCollected(this.#collectContent(message.content));
			case "branchSummary":
				return this.countTokens(message.summary);
			case "compactionSummary": {
				const summaryTokens = this.countTokens(message.summary);
				const payloadTokens = message.providerPayload
					? this.#countCollected(this.#collectProviderPayload(message.providerPayload, excludeEncryptedReasoning))
					: 0;
				return Math.max(summaryTokens, payloadTokens);
			}
			default:
				return this.#countUnknownMessage(message, excludeEncryptedReasoning);
		}
	}
}
