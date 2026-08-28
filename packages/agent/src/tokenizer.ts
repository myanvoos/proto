import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelTokenizer } from "@oh-my-pi/pi-catalog/types";
import { countTokens as countTokensNat, Encoding } from "@oh-my-pi/pi-natives";
import { stringifyJson } from "@oh-my-pi/pi-utils";
import { isEstimateCacheable, messageEstimateVersion } from "./compaction/message-cache";
import type { AgentMessage } from "./types";

const testEnv = Bun.env.NODE_ENV === "test";
const accurate = process.env.PI_TOKENIZER_ACCURATE === "1" && !testEnv;

const NATIVE_ENCODING: Record<ModelTokenizer, Encoding> = {
	"claude-v3": Encoding.ClaudeV3,
	"claude-v47": Encoding.ClaudeV47,
	"claude-v5": Encoding.ClaudeV5,
	"claude-v5-sonnet": Encoding.ClaudeV5Sonnet,
	qwen3: Encoding.Qwen3,
	"deepseek-v3": Encoding.DeepSeekV3,
	"kimi-k2": Encoding.KimiK2,
	glm5: Encoding.Glm5,
};

export function tokenizerEncodingForModel(model: Pick<Model, "tokenizer"> | null | undefined): Encoding | null {
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

export interface TokenBudgetCheck {
	fits: boolean;

	tokens: number;

	exact: boolean;
}

const IMAGE_TOKEN_ESTIMATE = 1200;

interface MessageEstimate {
	version: number;
	default?: number;
	floored?: number;
}

export class Tokenizer {
	readonly #encoding: Encoding | null;

	#estimates = new WeakMap<AgentMessage, MessageEstimate>();

	constructor(model?: Pick<Model, "tokenizer"> | null) {
		this.#encoding = tokenizerEncodingForModel(model);
	}

	get encoding(): Encoding | null {
		return this.#encoding;
	}

	countTokens(text: string | string[], mode: TokenCountMode = "approximate"): number {
		if (mode === "strict") return countTokensNat(text, this.#encoding);
		if (!testEnv && this.#encoding !== null) return countTokensNat(text, this.#encoding);
		if (accurate) return countTokensNat(text);
		return sumFragments(text, mode === "upperbound" ? byteLength : byteEstimate);
	}

	checkTokenBudget(text: string | string[], budget: number): TokenBudgetCheck {
		const bound = sumFragments(text, byteLength);
		if (bound <= budget) return { fits: true, tokens: bound, exact: false };
		const tokens = this.countTokens(text, "strict");
		return { fits: tokens <= budget, tokens, exact: true };
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

	#measureMessage(message: AgentMessage, excludeEncryptedReasoning: boolean): number {
		const fragments: string[] = [];
		let extra = 0;

		const role: string = message.role;
		if (role === "bashExecution") {
			if ("command" in message && typeof message.command === "string") fragments.push(message.command);
			if ("output" in message && typeof message.output === "string") fragments.push(message.output);
			return fragments.length === 0 ? 0 : this.countTokens(fragments);
		}

		switch (message.role) {
			case "user": {
				const content: string | Array<{ type: string; text?: string }> = message.content;
				if (typeof content === "string") {
					fragments.push(content);
				} else if (Array.isArray(content)) {
					for (const block of content) {
						if (block.type === "text" && block.text) {
							fragments.push(block.text);
						}
					}
				}
				break;
			}
			case "assistant": {
				for (const block of message.content) {
					if (block.type === "text") {
						fragments.push(block.text);
					} else if (block.type === "thinking") {
						fragments.push(block.thinking);

						if (block.thinkingSignature && !excludeEncryptedReasoning) {
							fragments.push(block.thinkingSignature);
						}
					} else if (block.type === "toolCall") {
						fragments.push(block.name);
						fragments.push(stringifyJson(block.arguments) ?? "null");
					} else if (block.type === "redactedThinking") {
						if (!excludeEncryptedReasoning) fragments.push(block.data);
					} else if (block.type === "anthropicServerTool") {
						if (!excludeEncryptedReasoning) fragments.push(stringifyJson(block.block) ?? "null");
					}
				}
				break;
			}
			case "hookMessage":
			case "toolResult": {
				if (typeof message.content === "string") {
					fragments.push(message.content);
				} else {
					for (const block of message.content) {
						if (block.type === "text" && block.text) {
							fragments.push(block.text);
						} else if (block.type === "image") {
							extra += IMAGE_TOKEN_ESTIMATE;
						}
					}
				}
				break;
			}
			case "branchSummary":
			case "compactionSummary":
				fragments.push(message.summary);
				break;
			default:
				return 0;
		}

		if (fragments.length === 0) return extra;
		return extra + this.countTokens(fragments);
	}
}
