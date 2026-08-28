import { type } from "@oh-my-pi/omptype";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { ToolDefinition } from "../extensibility/extensions";
import approveDescription from "../prompts/tools/approve.md" with { type: "text" };
import rewriteDescription from "../prompts/tools/rewrite.md" with { type: "text" };
import type { CompressDraft, CompressLoss, CompressMetrics } from "./types";

const lossSchema = type({
	content: type("string > 0").describe("the dropped source content, quoted or described precisely"),
	reason: type("string > 0").describe("why the compressed text is still correct without it"),
});

const rewriteSchema = type({
	text: type("string > 0").describe("the complete compressed text, ready to ship verbatim"),
	losses: lossSchema
		.array()
		.describe(
			"every claim, qualifier, example, default, or exact string deliberately dropped; empty array only when the draft loses nothing",
		),
	"+": "reject",
}).describe("submit a compressed draft together with everything it drops");

const approveSchema = type({
	verdict: type("string > 0").describe("why the newest draft is acceptable as the final output"),
	"+": "reject",
}).describe("accept the newest draft as the final output");

interface RewriteDetails {
	round: number;
	draftTokens: number;
	losses: number;
}

interface ApproveDetails {
	round: number;
}

function words(text: string): number {
	const trimmed = text.trim();
	return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

export class CompressProtocol {
	readonly #tokenizer: Tokenizer;
	readonly #sourceWords: number;
	readonly #sourceTokens: number;
	readonly #drafts: CompressDraft[] = [];
	#reviewed = 0;
	#approved = false;
	#verdict: string | undefined;

	constructor(source: string) {
		this.#tokenizer = new Tokenizer();
		this.#sourceWords = words(source);
		this.#sourceTokens = this.#tokenizer.countTokens(source);
	}

	get latest(): CompressDraft | undefined {
		return this.#drafts.at(-1);
	}

	get approved(): boolean {
		return this.#approved;
	}

	get verdict(): string | undefined {
		return this.#verdict;
	}

	get rounds(): number {
		return this.#drafts.length;
	}

	get sourceWords(): number {
		return this.#sourceWords;
	}

	get sourceTokens(): number {
		return this.#sourceTokens;
	}

	metrics(draft: CompressDraft): CompressMetrics {
		const draftTokens = this.#tokenizer.countTokens(draft.text);
		return {
			sourceWords: this.#sourceWords,
			draftWords: words(draft.text),
			sourceTokens: this.#sourceTokens,
			draftTokens,
			ratio: this.#sourceTokens === 0 ? 0 : (this.#sourceTokens - draftTokens) / this.#sourceTokens,
		};
	}

	markReviewed(round: number): void {
		this.#reviewed = Math.max(this.#reviewed, round);
	}

	submit(text: string, losses: readonly CompressLoss[]): CompressDraft {
		const draft: CompressDraft = {
			round: this.#drafts.length + 1,
			text,
			losses: losses.map(loss => ({ content: loss.content, reason: loss.reason })),
		};
		this.#drafts.push(draft);
		this.#approved = false;
		this.#verdict = undefined;
		return draft;
	}

	accept(verdict: string): CompressDraft {
		const draft = this.latest;
		if (!draft) throw new Error("Call rewrite before approve: there is no draft to accept");
		if (draft.round > this.#reviewed) {
			throw new Error(
				`Draft ${draft.round} has not been reviewed yet. End this turn; the review turn arrives next, and you approve there.`,
			);
		}
		this.#approved = true;
		this.#verdict = verdict;
		return draft;
	}

	rewriteTool(): ToolDefinition {
		return {
			name: "rewrite",
			label: "Rewrite",
			description: rewriteDescription.trim(),
			parameters: rewriteSchema,
			strict: true,
			execute: async (_toolCallId, rawParams) => {
				const params = rewriteSchema(rawParams);
				if (params instanceof type.errors) throw new Error(`rewrite received invalid arguments: ${params.summary}`);
				const draft = this.submit(params.text, params.losses);
				const metrics = this.metrics(draft);
				const percent = (metrics.ratio * 100).toFixed(1);
				const summary = `Draft ${draft.round} recorded: ${metrics.sourceTokens} → ${metrics.draftTokens} tokens (${percent}% smaller), ${draft.losses.length} declared loss(es). A review turn follows.`;
				const details: RewriteDetails = {
					round: draft.round,
					draftTokens: metrics.draftTokens,
					losses: draft.losses.length,
				};
				return { content: [{ type: "text", text: summary }], details };
			},
		};
	}

	approveTool(): ToolDefinition {
		return {
			name: "approve",
			label: "Approve",
			description: approveDescription.trim(),
			parameters: approveSchema,
			strict: true,
			execute: async (_toolCallId, rawParams) => {
				const params = approveSchema(rawParams);
				if (params instanceof type.errors) throw new Error(`approve received invalid arguments: ${params.summary}`);
				const draft = this.accept(params.verdict);
				const details: ApproveDetails = { round: draft.round };
				return {
					content: [{ type: "text", text: `Draft ${draft.round} approved. The run ends here.` }],
					details,
				};
			},
		};
	}
}
