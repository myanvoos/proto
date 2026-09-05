import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import programDescription from "../prompts/conductor/program-tool.md" with { type: "text" };
import { extractFlatShellCommandSegments } from "../tools/shell-tokenize";
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
	verificationCommands: readonly string[];
	tokenBudget?: number;
}

export interface ParsedConductorObjective {
	objective: string;
	verificationCommands: readonly string[];
}

export interface ProgramDetails {
	op: ProgramParams["op"];
	objective?: string;
	verificationCommands?: readonly string[];
	tokenBudget?: number;
}

/** Parse the exact five-section contract and extract its runnable verification commands. */
export function parseConductorObjective(objectiveInput: string): ParsedConductorObjective {
	const objective = objectiveInput.trim();
	if (!objective) throw new ToolError("objective is required when op=create");

	const lines = objective.split("\n");
	const sections: Array<{ heading: string; start: number; end: number }> = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!.trimEnd();
		if (!/^#{1,6}\s/.test(line)) continue;
		if (!/^## [^#].*$/.test(line)) {
			throw new ToolError("objective may contain only the five exact top-level ## sections");
		}
		sections.push({ heading: line, start: index + 1, end: lines.length });
	}
	for (let index = 0; index < sections.length - 1; index++) {
		sections[index]!.end = sections[index + 1]!.start - 1;
	}

	if (
		sections.length !== REQUIRED_SECTIONS.length ||
		sections.some((section, index) => section.heading !== REQUIRED_SECTIONS[index])
	) {
		throw new ToolError(
			`objective MUST contain exactly ${REQUIRED_SECTIONS.join(", ")} in that order, with no other headings`,
		);
	}

	const verification = sections[2]!;
	const commands: string[] = [];
	for (const rawLine of lines.slice(verification.start, verification.end)) {
		const line = rawLine.trim();
		if (!line) continue;
		const inline = /`([^`]+)`/.exec(line)?.[1]?.trim();
		const candidate =
			inline ??
			line
				.replace(/^[-*]\s+/, "")
				.split(/\s+[—:]\s+/)[0]
				?.trim();
		if (!candidate || /^(?:run|verify|check|checks|ensure|confirm|this|the)\b/i.test(candidate)) {
			throw new ToolError("## Verification must contain runnable commands, one per nonempty line");
		}
		if (extractFlatShellCommandSegments(candidate).length !== 1) {
			throw new ToolError(`verification command is not a single safe shell command: ${candidate}`);
		}
		commands.push(candidate);
	}
	if (commands.length === 0) throw new ToolError("## Verification must contain at least one runnable command");
	return { objective, verificationCommands: commands };
}

function parseProposal(params: ProgramParams): ConductorProposal {
	const parsed = parseConductorObjective(params.objective);
	const tokenBudget = params.token_budget;
	if (tokenBudget !== undefined && (!Number.isInteger(tokenBudget) || tokenBudget <= 0)) {
		throw new ToolError("token_budget must be a positive integer");
	}
	return tokenBudget === undefined
		? { objective: parsed.objective, verificationCommands: parsed.verificationCommands }
		: { objective: parsed.objective, verificationCommands: parsed.verificationCommands, tokenBudget };
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
			verificationCommands: proposal.verificationCommands,
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
