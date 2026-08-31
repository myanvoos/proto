import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import programDescription from "../prompts/conductor/program-tool.md" with { type: "text" };
import { ToolError } from "../tools/tool-errors";

const programSchema = type({
	op: type("'create'").describe("Commission the contract for this stretch. `amend` and `show` are not available yet."),
	objective: type("string").describe(
		"The contract as markdown, in exactly this order: ## Objective, ## Success criteria, ## Verification, ## Boundaries, ## Stop conditions.",
	),
	"token_budget?": type("number").describe(
		"Token cap for the stretch. Include only when the rough ask states one; omit for an unbudgeted stretch.",
	),
});

type ProgramParams = typeof programSchema.infer;

/** The ordered headings the guided goal interview mandates; `## Verification` doubles as the auditor's whitelist. */
const REQUIRED_SECTIONS: readonly string[] = [
	"## Objective",
	"## Success criteria",
	"## Verification",
	"## Boundaries",
	"## Stop conditions",
];

export interface ConductorProposal {
	objective: string;
	tokenBudget?: number;
}

export interface ProgramDetails {
	op: ProgramParams["op"];
	objective?: string;
	tokenBudget?: number;
}

/**
 * The five headings are enforced here, not just in the prompt: `## Verification` is what the verification turn
 * reads back as its command whitelist, so a contract missing it is unauditable the moment it is created.
 */
function parseProposal(params: ProgramParams): ConductorProposal {
	const objective = params.objective?.trim();
	if (!objective) throw new ToolError("objective is required when op=create");

	let cursor = -1;
	for (const heading of REQUIRED_SECTIONS) {
		const index = objective.indexOf(heading, cursor + 1);
		if (index < 0) {
			throw new ToolError(
				`objective is missing the "${heading}" section; use exactly ${REQUIRED_SECTIONS.join(", ")} in that order`,
			);
		}
		cursor = index;
	}

	const tokenBudget = params.token_budget;
	if (tokenBudget !== undefined && (!Number.isInteger(tokenBudget) || tokenBudget <= 0)) {
		throw new ToolError("token_budget must be a positive integer");
	}
	return tokenBudget === undefined ? { objective } : { objective, tokenBudget };
}

/**
 * The conductor's commissioning channel. One accepted proposal per commissioning turn; later calls in the same
 * turn are acknowledged without overwriting, mirroring {@link CueTool}'s per-turn ruling slot.
 */
export class ProgramTool implements AgentTool<typeof programSchema, ProgramDetails> {
	readonly name = "program";
	readonly label = "Program";
	readonly description = programDescription;
	readonly parameters = programSchema;
	readonly intent = "omit" as const;

	#proposalRecorded = false;

	constructor(private readonly onProposal: (proposal: ConductorProposal) => void) {}

	/** Opens a fresh proposal slot for the next commissioning turn. */
	beginTurn(): void {
		this.#proposalRecorded = false;
	}

	async execute(
		_toolCallId: string,
		params: ProgramParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ProgramDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ProgramDetails>> {
		const proposal = parseProposal(params);
		const details: ProgramDetails = {
			op: "create",
			objective: proposal.objective,
			tokenBudget: proposal.tokenBudget,
		};

		if (this.#proposalRecorded) {
			return {
				content: [{ type: "text", text: "Contract already proposed." }],
				details,
				useless: true,
			};
		}
		this.#proposalRecorded = true;
		this.onProposal(proposal);
		return {
			content: [{ type: "text", text: "Contract proposed; awaiting the user's decision." }],
			details,
			useless: true,
		};
	}
}
