import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import cueDescription from "../prompts/conductor/cue-tool.md" with { type: "text" };
import { ToolError } from "../tools/tool-errors";

const cueSchema = type({
	op: type("'verify' | 'escalate'").describe("Rule on the pended completion claim, or hand the question to the user."),
	"verdict?": type("'accept' | 'reject'").describe("Required when op=verify. Uncertainty is a reject."),
	"evidence?": type("string").describe(
		"Required when op=verify. Accept: the current-state evidence that proves every deliverable. Reject: the concrete discrepancies, one per line.",
	),
	"question?": type("string").describe("Required when op=escalate. Exactly what the user must decide."),
});

type CueParams = typeof cueSchema.infer;

export type ConductorVerdict = "accept" | "reject";

export type ConductorRuling =
	| { op: "verify"; verdict: ConductorVerdict; evidence: string }
	| { op: "escalate"; question: string };

export interface CueDetails {
	op: CueParams["op"];
	verdict?: ConductorVerdict;
	evidence?: string;
	question?: string;
}

function parseRuling(params: CueParams): ConductorRuling {
	if (params.op === "escalate") {
		const question = params.question?.trim();
		if (!question) throw new ToolError("question is required when op=escalate");
		return { op: "escalate", question };
	}
	const verdict = params.verdict;
	if (!verdict) throw new ToolError("verdict is required when op=verify");
	const evidence = params.evidence?.trim();
	if (!evidence) throw new ToolError("evidence is required when op=verify");
	return { op: "verify", verdict, evidence };
}

/**
 * The conductor's only channel. One accepted ruling per verification turn; later calls in the same turn are
 * acknowledged without overwriting, mirroring `AdviseTool`'s per-update rate limit.
 */
export class CueTool implements AgentTool<typeof cueSchema, CueDetails> {
	readonly name = "cue";
	readonly label = "Cue";
	readonly description = cueDescription;
	readonly parameters = cueSchema;
	readonly intent = "omit" as const;

	#rulingRecorded = false;

	constructor(private readonly onRuling: (ruling: ConductorRuling) => void) {}

	/** Opens a fresh ruling slot for the next verification turn. */
	beginTurn(): void {
		this.#rulingRecorded = false;
	}

	async execute(
		_toolCallId: string,
		params: CueParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<CueDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<CueDetails>> {
		const ruling = parseRuling(params);
		const details: CueDetails =
			ruling.op === "escalate"
				? { op: "escalate", question: ruling.question }
				: { op: "verify", verdict: ruling.verdict, evidence: ruling.evidence };

		if (this.#rulingRecorded) {
			return {
				content: [{ type: "text", text: "Ruling already recorded." }],
				details,
				useless: true,
			};
		}
		this.#rulingRecorded = true;
		this.onRuling(ruling);
		return {
			content: [
				{
					type: "text",
					text: ruling.op === "escalate" ? "Escalation recorded." : `Ruling recorded: ${ruling.verdict}.`,
				},
			],
			details,
			useless: true,
		};
	}
}
