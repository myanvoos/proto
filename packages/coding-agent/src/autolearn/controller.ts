import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import autolearnGuidance from "../prompts/system/autolearn-guidance.md" with { type: "text" };
import autolearnNudgeAutoContinue from "../prompts/system/autolearn-nudge-autocontinue.md" with { type: "text" };
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";

const AUTOLEARN_NUDGE_AUTOCONTINUE = autolearnNudgeAutoContinue.trim();
const DEFAULT_MIN_TOOL_CALLS = 5;

export function buildAutoLearnInstructions(available: { manageSkill: boolean }): string | null {
	if (!available.manageSkill) return null;
	return autolearnGuidance.trim();
}

interface AutoLearnControllerOptions {
	session: AgentSession;
	settings: Settings;
	capture: (content: string) => Promise<void>;
}

export class AutoLearnController {
	readonly #session: AgentSession;
	readonly #settings: Settings;
	readonly #capture: (content: string) => Promise<void>;
	#toolCalls = 0;

	#turnStartedInGoalMode = false;

	#captureInFlight = false;

	#capturePending = false;

	constructor(options: AutoLearnControllerOptions) {
		this.#session = options.session;
		this.#settings = options.settings;
		this.#capture = options.capture;

		this.#session.subscribe(event => this.#onEvent(event));
	}

	#onEvent(event: AgentSessionEvent): void {
		if (event.type === "agent_start") {
			this.#turnStartedInGoalMode = this.#session.getGoalModeState()?.enabled === true;
			return;
		}
		if (event.type === "tool_execution_end") {
			this.#toolCalls++;
			return;
		}
		if (event.type === "agent_end") {
			this.#onAgentEnd(event);
		}
	}

	#onAgentEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
		const toolCalls = this.#toolCalls;
		this.#toolCalls = 0;

		const startedInGoalMode = this.#turnStartedInGoalMode;
		this.#turnStartedInGoalMode = false;

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message && typeof message === "object" && "role" in message && message.role === "assistant") {
				if ("stopReason" in message && message.stopReason === "aborted") {
					return;
				}
				break;
			}
		}

		if (!this.#settings.get("autolearn.enabled")) return;
		const minToolCalls = this.#settings.get("autolearn.minToolCalls") ?? DEFAULT_MIN_TOOL_CALLS;
		if (toolCalls < minToolCalls) return;

		if (startedInGoalMode || this.#session.getGoalModeState()?.enabled) return;

		const autoContinue = this.#settings.get("autolearn.autoContinue") === true;
		if (!autoContinue) return;

		if (this.#captureInFlight) {
			this.#capturePending = true;
			return;
		}
		this.#startCapture();
	}

	#startCapture(): void {
		this.#captureInFlight = true;
		void this.#capture(AUTOLEARN_NUDGE_AUTOCONTINUE)
			.catch(err => {
				logger.warn("auto-learn capture failed", { err });
			})
			.finally(() => {
				this.#captureInFlight = false;
				if (!this.#capturePending) return;
				this.#capturePending = false;
				this.#startCapture();
			});
	}
}
