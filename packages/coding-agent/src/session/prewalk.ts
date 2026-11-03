import type { Agent, AgentMessage, AgentTurnEndContext } from "@oh-my-pi/pi-agent-core";
import { invalidateMessageCache } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model, ToolResultMessage } from "@oh-my-pi/pi-ai";
import prewalkChecklistPrompt from "../prompts/system/prewalk-checklist.md" with { type: "text" };
import prewalkContinuePrompt from "../prompts/system/prewalk-continue.md" with { type: "text" };
import prewalkPlanPrompt from "../prompts/system/prewalk-plan.md" with { type: "text" };
import { prewalkWouldBeNoop, type ThinkingLevel } from "../thinking";
import type { Prewalk } from "./agent-session-types";
import { PREWALK_PLAN_MESSAGE_TYPE } from "./messages";
import type { SessionManager } from "./session-manager";

const PREWALK_CONTINUE_MESSAGE_TYPE = "prewalk-continue";
const PREWALK_CHECKLIST_MESSAGE_TYPE = "prewalk-checklist";

export function isPrewalkPlanNudge(message: AgentMessage): boolean {
	return message.role === "custom" && message.customType === PREWALK_PLAN_MESSAGE_TYPE;
}
const PREWALK_ACTION_TOOLS: Record<string, true> = {
	edit: true,
	write: true,
};

function isPrewalkImplementationAction(result: ToolResultMessage): boolean {
	if (!PREWALK_ACTION_TOOLS[result.toolName]) return false;
	const details = result.details;

	if (!details || typeof details !== "object") return true;
	return !("xdev" in details);
}

export interface PrewalkCoordinatorHost {
	agent: Agent;
	sessionManager: SessionManager;
	model(): Model | undefined;
	configuredThinkingLevel(): ThinkingLevel | undefined;
	restoreThinkingLevel(level: ThinkingLevel | undefined): void;
	resolveDefaultPrewalk(): Prewalk | undefined;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	setModelTemporary(model: Model, thinkingLevel?: ThinkingLevel, options?: { ephemeral?: boolean }): Promise<void>;
	setActiveToolsByName(names: string[]): Promise<void>;
	runToolRegistryMutation<T>(mutation: () => Promise<T>): Promise<T>;
	getActiveToolNames(): string[];
	getEnabledToolNames(): string[];
	waitForSessionMessagePersistence(message: AgentMessage): Promise<void>;
}

interface PrewalkCoordinatorOptions {
	prewalk?: Prewalk;
}

export class PrewalkCoordinator {
	readonly #host: PrewalkCoordinatorHost;
	#prewalk: Prewalk | undefined;
	#planInjected = false;
	#continuePending = false;
	#checklistSeen = false;
	#handoff:
		| {
				source: Model;
				sourceThinkingLevel: ThinkingLevel | undefined;
				target: Model;
				targetThinkingLevel: ThinkingLevel | undefined;
		  }
		| undefined;

	constructor(host: PrewalkCoordinatorHost, options: PrewalkCoordinatorOptions = {}) {
		this.#host = host;
		this.#prewalk = options.prewalk;
	}

	get state(): Prewalk | undefined {
		return this.#prewalk;
	}

	/** Whether the armed prewalk would perform a model or thinking-level handoff. */
	get willHandoff(): boolean {
		const prewalk = this.#prewalk;
		return prewalk !== undefined && !this.#isNoop(prewalk);
	}

	#isNoop(prewalk: Prewalk): boolean {
		return prewalkWouldBeNoop(
			this.#host.model(),
			this.#host.configuredThinkingLevel(),
			prewalk.target,
			prewalk.thinkingLevel,
		);
	}

	#clearPrewalkState(): void {
		this.#prewalk = undefined;
		this.#planInjected = false;
		this.#continuePending = false;
		this.#checklistSeen = false;
	}

	/** Explicit model or effort selections take ownership from a completed prewalk. */
	releaseHandoff(): void {
		this.#handoff = undefined;
	}

	/** Restore the planning model and re-arm the configured handoff for a new session. */
	async resetForNewSession(enabled: boolean): Promise<void> {
		const handoff = this.#handoff;
		const current = this.#host.model();
		const restoreSource =
			enabled &&
			handoff !== undefined &&
			current?.provider === handoff.target.provider &&
			current?.id === handoff.target.id &&
			this.#host.configuredThinkingLevel() === handoff.targetThinkingLevel;
		this.#scrubPlanNudge(undefined, true);
		this.#clearPrewalkState();
		this.releaseHandoff();
		if (!enabled) return;
		if (restoreSource && handoff) {
			try {
				await this.#host.setModelTemporary(handoff.source, handoff.sourceThinkingLevel, { ephemeral: true });
				this.#host.restoreThinkingLevel(handoff.sourceThinkingLevel);
			} catch (error) {
				this.#host.emitNotice(
					"warning",
					`Prewalk: could not restore ${handoff.source.provider}/${handoff.source.id}: ${error instanceof Error ? error.message : String(error)}`,
					"prewalk",
				);
			}
		}
		const prewalk = this.#host.resolveDefaultPrewalk();
		if (!prewalk) return;
		if (this.#isNoop(prewalk)) {
			this.#disarmNoop(prewalk);
			return;
		}
		this.#prewalk = prewalk;
	}

	/** Cancel pending guidance without changing the model or delivered continuation history. */
	disarm(): void {
		const active = this.#prewalk;
		if (!active) return;
		this.#scrubPlanNudge(undefined, true);
		this.#clearPrewalkState();
		this.#host.emitNotice(
			"info",
			`Prewalk: disarmed; staying on the active model instead of switching to ${active.target.provider}/${active.target.id}.`,
			"prewalk",
		);
	}

	#disarmNoop(prewalk: Prewalk): void {
		this.#clearPrewalkState();
		this.#host.emitNotice(
			"info",
			`Prewalk: target ${prewalk.target.provider}/${prewalk.target.id} already matches the active model and thinking level; nothing to switch.`,
			"prewalk",
		);
	}

	async advanceAtTurnEnd(liveMessages: AgentMessage[], context: AgentTurnEndContext | undefined): Promise<void> {
		const prewalk = this.#prewalk;
		if (!prewalk || context?.message.role !== "assistant") return;
		if (this.#isNoop(prewalk)) {
			this.#scrubPlanNudge(liveMessages);
			this.#disarmNoop(prewalk);
			return;
		}
		if (context.toolResults.some(result => result.toolName === "checklist" && !result.isError))
			this.#checklistSeen = true;

		const hasToolResults = context.toolResults.length > 0;
		if (this.#planInjected && hasToolResults) {
			this.#continuePending = true;
		} else if (this.#continuePending) {
			this.#continuePending = false;
			this.#host.agent.steer({
				role: "custom",
				customType: PREWALK_CONTINUE_MESSAGE_TYPE,
				content: prewalkContinuePrompt,
				attribution: "agent",
				display: false,
				timestamp: Date.now(),
			});
		}

		const checklistGateOpen = this.#checklistSeen || !this.#host.getActiveToolNames().includes("checklist");
		const action = checklistGateOpen
			? context.toolResults.find(result => isPrewalkImplementationAction(result))
			: undefined;
		if (!action) {
			if (!this.#planInjected) {
				this.#planInjected = true;
				this.#continuePending = true;
				this.#host.agent.steer({
					role: "custom",
					customType: PREWALK_PLAN_MESSAGE_TYPE,
					content: prewalkPlanPrompt,
					display: false,
					attribution: "agent",
					timestamp: Date.now(),
				});
				this.#host.emitNotice("info", "Prewalk: injected deep-plan nudge.", "prewalk");
			}
			return;
		}

		await this.#host.waitForSessionMessagePersistence(context.message);
		for (const toolResult of context.toolResults) {
			await this.#host.waitForSessionMessagePersistence(toolResult);
		}
		this.#scrubPlanNudge(liveMessages);
		const target = prewalk.target;
		if (this.#isNoop(prewalk)) {
			this.#disarmNoop(prewalk);
			return;
		}
		const source = this.#host.model();
		const sourceThinkingLevel = this.#host.configuredThinkingLevel();
		await this.#host.setModelTemporary(target, prewalk.thinkingLevel, { ephemeral: true });
		this.#clearPrewalkState();
		if (source) {
			this.#handoff = {
				source,
				sourceThinkingLevel,
				target,
				targetThinkingLevel: this.#host.configuredThinkingLevel(),
			};
		}
		this.#host.emitNotice(
			"info",
			`Prewalk: switched to ${target.provider}/${target.id} after first ${action.toolName} call.`,
			"prewalk",
		);
		this.#host.agent.steer({
			role: "custom",
			customType: PREWALK_CHECKLIST_MESSAGE_TYPE,
			content: prewalkChecklistPrompt,
			attribution: "agent",
			display: false,
			timestamp: Date.now(),
		});
	}

	arm(target: Model, thinkingLevel?: ThinkingLevel): boolean {
		const active = this.#prewalk;
		if (active) {
			this.#host.emitNotice(
				"info",
				`Prewalk: already armed for ${active.target.provider}/${active.target.id}, waiting for the first edit/write.`,
				"prewalk",
			);
			return (
				active.target.provider === target.provider &&
				active.target.id === target.id &&
				active.thinkingLevel === thinkingLevel
			);
		}
		const candidate = { target, thinkingLevel };
		if (this.#isNoop(candidate)) {
			this.#disarmNoop(candidate);
			return false;
		}
		this.#prewalk = candidate;
		this.#planInjected = true;
		this.#continuePending = true;
		this.#checklistSeen = false;
		this.#host.agent.steer({
			role: "custom",
			customType: PREWALK_PLAN_MESSAGE_TYPE,
			content: prewalkPlanPrompt,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#host.emitNotice(
			"info",
			`Prewalk: armed for ${target.provider}/${target.id} — will switch at the first edit/write once the checklist list exists.`,
			"prewalk",
		);
		return true;
	}

	#scrubPlanNudge(liveMessages?: AgentMessage[], includeContinuation = false): void {
		const isPlanNudge = isPrewalkPlanNudge;
		if (liveMessages) {
			for (let index = liveMessages.length - 1; index >= 0; index--) {
				if (!isPlanNudge(liveMessages[index])) continue;
				invalidateMessageCache(liveMessages[index]);
				liveMessages.splice(index, 1);
			}
		}
		const stateMessages = this.#host.agent.state.messages;
		const filtered = stateMessages.filter(message => !isPlanNudge(message));
		if (filtered.length !== stateMessages.length) this.#host.agent.replaceMessages(filtered);
		const isPendingNudge = (message: AgentMessage): boolean =>
			isPlanNudge(message) ||
			(includeContinuation && message.role === "custom" && message.customType === PREWALK_CONTINUE_MESSAGE_TYPE);
		const steering = this.#host.agent.peekSteeringQueue();
		if (steering.some(isPendingNudge)) {
			this.#host.agent.replaceQueues(
				steering.filter(message => !isPendingNudge(message)),
				[...this.#host.agent.peekFollowUpQueue()],
			);
		}
	}
}
