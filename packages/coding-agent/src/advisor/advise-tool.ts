import { type } from "@oh-my-pi/omptype";
import type {
	AgentIdentity,
	AgentTelemetryConfig,
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@oh-my-pi/pi-agent-core";
import { escapeXmlAttribute, escapeXmlText, logger } from "@oh-my-pi/pi-utils";
import adviseDescription from "../prompts/advisor/advise-tool.md" with { type: "text" };
import { AdvisorEmissionGuard, type AdvisorSuppressionReason, normalizeAdvisorNote } from "./emission-guard";

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
	if (opts.terminalAnswerNoQueuedWork && opts.severity !== "blocker" && !opts.streaming && !opts.aborting)
		return "preserve";
	if (!isInterruptingSeverity(opts.severity)) return "aside";
	if (opts.autoResumeSuppressed && (opts.aborting || !opts.streaming)) return "preserve";
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

const ADVISOR_SEVERITY_RANK: Record<AdvisorSeverity, number> = { nit: 1, concern: 2, blocker: 3 };
function advisorSeverityRank(severity: AdvisorSeverity | undefined): number {
	return ADVISOR_SEVERITY_RANK[severity ?? "nit"];
}

const ADVISOR_ACK_SENT = "Delivered.";
const ADVISOR_ACK_DEFERRED = "Queued for the end of the turn. Do not re-raise.";
const ADVISOR_ACK_SUPPRESSED: Record<AdvisorSuppressionReason, string> = {
	empty: "Dropped: empty note.",
	noise: "Dropped: nothing actionable.",
	duplicate: "Dropped: already raised.",
	"rate-limit": "Dropped: this update's advice budget is spent.",
};

export class AdviseTool implements AgentTool<typeof adviseSchema, AdviseDetails> {
	readonly name = "advise";
	readonly label = "Advise";
	readonly description = adviseDescription;
	readonly parameters = adviseSchema;
	readonly intent = "omit" as const;

	/** Sole admission authority: the tool keeps no parallel dedupe or budget state. */
	readonly #guard = new AdvisorEmissionGuard();
	#inProgressUpdate = false;
	/** Admitted but withheld while the primary is mid-turn; flushed in arrival order, never re-admitted. */
	#deferredNotes: { key: string; note: string; severity?: AdviseDetails["severity"] }[] = [];

	/** `onAdvice` routes an admitted note to the primary; it never re-filters. */
	constructor(private readonly onAdvice: (note: string, severity?: AdviseDetails["severity"]) => void) {}

	/**
	 * Starts one advisor update with a fresh budget. Non-blockers reviewing an in-progress primary turn are withheld;
	 * the transition to a completed update flushes the backlog.
	 */
	beginUpdate(inProgress: boolean): void {
		const wasInProgress = this.#inProgressUpdate;
		this.#inProgressUpdate = inProgress;
		this.#guard.beginUpdate();
		if (wasInProgress && !inProgress) this.#flushDeferred();
	}

	/** The primary's terminal boundary: flush the backlog without opening a new update budget. */
	flushDeferredNotes(): void {
		this.#inProgressUpdate = false;
		this.#flushDeferred();
	}

	/** A fresh advisor conversation may re-raise old issues. */
	resetDeliveredNotes(): void {
		this.#guard.reset();
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
		const rank = advisorSeverityRank(args.severity);
		const key = normalizeAdvisorNote(args.note);
		if (this.#inProgressUpdate && args.severity !== "blocker") {
			const pending = this.#deferredNotes.find(item => item.key === key);
			if (pending) {
				if (rank > advisorSeverityRank(pending.severity)) {
					pending.severity = args.severity;
					this.#guard.escalatePending(args.note, rank);
				}
				return this.#result(ADVISOR_ACK_DEFERRED, args);
			}
			const decision = this.#guard.admit(args.note, { rank, pending: true });
			if (!decision.accepted) return this.#suppressed(args, decision.reason);
			if (decision.displacedKey !== undefined) {
				const displacedIndex = this.#deferredNotes.findIndex(item => item.key === decision.displacedKey);
				if (displacedIndex !== -1) this.#deferredNotes.splice(displacedIndex, 1);
			}
			this.#deferredNotes.push({ key, note: args.note, severity: args.severity });
			return this.#result(ADVISOR_ACK_DEFERRED, args);
		}
		// A blocker re-raise of a queued note pulls the reservation and interrupts now at blocker severity.
		const reservedIndex = this.#deferredNotes.findIndex(item => item.key === key);
		if (reservedIndex !== -1) this.#deferredNotes.splice(reservedIndex, 1);
		const decision = this.#guard.admit(args.note, { rank, pending: false });
		if (!decision.accepted) return this.#suppressed(args, decision.reason);
		this.onAdvice(args.note, args.severity);
		return this.#result(ADVISOR_ACK_SENT, args);
	}

	#flushDeferred(): void {
		if (this.#deferredNotes.length === 0) return;
		const pending = this.#deferredNotes;
		this.#deferredNotes = [];
		for (const { note, severity } of pending) {
			this.#guard.markRouted(note);
			this.onAdvice(note, severity);
		}
	}

	#suppressed(args: AdviseParams, reason: AdvisorSuppressionReason | undefined): AgentToolResult<AdviseDetails> {
		logger.debug("advisor advice suppressed by emission guard", { reason, severity: args.severity });
		return this.#result(ADVISOR_ACK_SUPPRESSED[reason ?? "duplicate"], args);
	}

	#result(text: string, args: AdviseParams): AgentToolResult<AdviseDetails> {
		return {
			content: [{ type: "text", text }],
			details: { note: args.note, severity: args.severity },
			useless: true,
		};
	}
}
