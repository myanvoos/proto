import { type } from "@oh-my-pi/omptype";
import type {
	AgentIdentity,
	AgentTelemetryConfig,
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@oh-my-pi/pi-agent-core";
import { escapeXmlAttribute, escapeXmlText } from "@oh-my-pi/pi-utils";
import adviseDescription from "../prompts/advisor/advise-tool.md" with { type: "text" };

const adviseSchema = type({
	note: type("string").describe(
		"One concrete piece of advice for the agent you are watching. Terse, specific, actionable.",
	),
	"severity?": type("'nit' | 'concern' | 'blocker'").describe("How strongly to weigh this. Omit for a plain nit."),
});

type AdviseParams = typeof adviseSchema.infer;

export type AdvisorSeverity = "nit" | "concern" | "blocker";

interface AdviseDetails {
	note: string;
	severity?: AdvisorSeverity;

	advisor?: string;
}

export interface AdvisorNote {
	note: string;
	severity?: AdvisorSeverity;

	advisor?: string;
}

export interface AdvisorMessageDetails {
	notes: AdvisorNote[];
}

const ADVISOR_GUIDANCE = "weigh, don't blindly obey";

export function formatAdvisorBatchContent(notes: readonly AdvisorNote[]): string {
	return notes
		.map(n => {
			const severity = n.severity ? ` severity="${n.severity}"` : "";
			const who = n.advisor ? ` advisor="${escapeXmlAttribute(n.advisor)}"` : "";
			return `<advisory${who}${severity} guidance="${ADVISOR_GUIDANCE}">\n${escapeXmlText(n.note)}\n</advisory>`;
		})
		.join("\n");
}

export function isInterruptingSeverity(severity: AdvisorSeverity | undefined): boolean {
	return severity === "concern" || severity === "blocker";
}

type AdvisorDeliveryChannel = "aside" | "steer" | "preserve";

export function isAdvisorInterruptImmuneTurnActive(opts: {
	completedTurns: number;
	immuneTurnStart: number | undefined;
	immuneTurns: number;
}): boolean {
	if (opts.immuneTurnStart === undefined || opts.immuneTurns <= 0) return false;
	return opts.completedTurns < opts.immuneTurnStart + opts.immuneTurns;
}

export function resolveAdvisorDeliveryChannel(opts: {
	severity: AdvisorSeverity | undefined;
	autoResumeSuppressed: boolean;
	streaming: boolean;
	aborting: boolean;
	terminalAnswerNoQueuedWork?: boolean;
	interruptImmuneTurnActive?: boolean;
	preserveOnly?: boolean;
}): AdvisorDeliveryChannel {
	if (opts.preserveOnly && !opts.streaming) return "preserve";
	if (!isInterruptingSeverity(opts.severity)) return "aside";
	if (opts.autoResumeSuppressed && (opts.aborting || !opts.streaming)) return "preserve";
	if (opts.terminalAnswerNoQueuedWork && opts.severity !== "blocker" && !opts.streaming && !opts.aborting)
		return "preserve";
	if (opts.interruptImmuneTurnActive && opts.severity !== "blocker") return "aside";
	return "steer";
}

export function deriveAdvisorTelemetry(
	primaryTelemetry: AgentTelemetryConfig | undefined,
	identity: AgentIdentity,
): AgentTelemetryConfig | undefined {
	if (!primaryTelemetry) return undefined;
	return { ...primaryTelemetry, agent: identity, conversationId: undefined };
}

export const ADVISOR_DEFAULT_TOOL_NAMES: ReadonlySet<string> = new Set(["read"]);

function advisorNoteDedupeKey(note: string): string {
	return note.trim().replace(/\s+/g, " ");
}

const ADVISOR_SEVERITY_RANK: Record<AdvisorSeverity, number> = { nit: 1, concern: 2, blocker: 3 };
function advisorSeverityRank(severity: AdvisorSeverity | undefined): number {
	return ADVISOR_SEVERITY_RANK[severity ?? "nit"];
}

export class AdviseTool implements AgentTool<typeof adviseSchema, AdviseDetails> {
	readonly name = "advise";
	readonly label = "Advise";
	readonly description = adviseDescription;
	readonly parameters = adviseSchema;
	readonly intent = "omit" as const;

	#deliveredNoteSeverities = new Map<string, number>();
	#inProgressUpdate = false;

	#deferredNotes: { key: string; note: string; severity?: AdviseDetails["severity"] }[] = [];

	constructor(private readonly onAdvice: (note: string, severity?: AdviseDetails["severity"]) => void) {}

	beginUpdate(inProgress: boolean): void {
		const wasInProgress = this.#inProgressUpdate;
		this.#inProgressUpdate = inProgress;

		if (wasInProgress && !inProgress && this.#deferredNotes.length > 0) {
			const pending = this.#deferredNotes;
			this.#deferredNotes = [];
			for (const { note, severity } of pending) this.#deliver(note, severity);
		}
	}

	resetDeliveredNotes(): void {
		this.#deliveredNoteSeverities.clear();
		this.#inProgressUpdate = false;
		this.#deferredNotes = [];
	}

	async execute(
		_toolCallId: string,
		args: AdviseParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AdviseDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<AdviseDetails>> {
		if (this.#inProgressUpdate && args.severity !== "blocker") {
			const key = advisorNoteDedupeKey(args.note);
			const pending = this.#deferredNotes.find(item => item.key === key);
			if (!pending) {
				this.#deferredNotes.push({ key, note: args.note, severity: args.severity });
			} else if (advisorSeverityRank(args.severity) > advisorSeverityRank(pending.severity)) {
				pending.severity = args.severity;
			}
			return {
				content: [
					{
						type: "text",
						text: "Deferred — primary is mid-turn; this note will be delivered automatically when the turn completes. Do not re-raise the same point.",
					},
				],
				details: { note: args.note, severity: args.severity },
				useless: true,
			};
		}
		const delivered = this.#deliver(args.note, args.severity);
		return {
			content: [{ type: "text", text: delivered ? "Recorded." : "Duplicate advice ignored." }],
			details: { note: args.note, severity: args.severity },
			useless: true,
		};
	}

	#deliver(note: string, severity?: AdviseDetails["severity"]): boolean {
		const key = advisorNoteDedupeKey(note);
		const rank = advisorSeverityRank(severity);
		const previousRank = this.#deliveredNoteSeverities.get(key) ?? 0;
		if (rank <= previousRank) return false;
		this.#deliveredNoteSeverities.set(key, rank);
		this.onAdvice(note, severity);
		return true;
	}
}
