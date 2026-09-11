import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID, type RegistryEvent } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import { setTerminalTitleState } from "../../utils/title-generator";
import type { InteractiveModeContext } from "../types";

export class SessionFocusController {
	#focusedAgentId: string | undefined;

	#attachedSession: AgentSession | undefined;
	#registryUnsubscribe: (() => void) | undefined;

	constructor(
		private ctx: InteractiveModeContext,
		private registry: AgentRegistry = AgentRegistry.global(),
		private lifecycle: () => AgentLifecycleManager = () => AgentLifecycleManager.global(),
	) {}

	get focusedAgentId(): string | undefined {
		return this.#focusedAgentId;
	}

	get target(): AgentSession | undefined {
		return this.#attachedSession;
	}

	async focusAgent(id: string): Promise<void> {
		if (id === MAIN_AGENT_ID) return this.unfocus();
		const session = await this.lifecycle().ensureLive(id);
		if (id === this.#focusedAgentId && session === this.#attachedSession) return;
		this.#focusedAgentId = id;
		this.#attachedSession = session;
		this.#registryUnsubscribe ??= this.registry.onChange(e => this.#onRegistryEvent(e));
		await this.#attach(session);
		this.ctx.showStatus(`Viewing agent ${id} — Esc returns to main, ←← hops to parent`);
	}

	async focusParent(): Promise<void> {
		if (!this.#focusedAgentId) return;
		const parentId = this.registry.get(this.#focusedAgentId)?.parentId;
		if (parentId && parentId !== MAIN_AGENT_ID && this.registry.get(parentId)) {
			return this.focusAgent(parentId);
		}
		return this.unfocus();
	}

	async unfocus(): Promise<void> {
		if (!this.#focusedAgentId) return;
		this.#focusedAgentId = undefined;
		this.#attachedSession = undefined;
		await this.#attach(this.ctx.session);
		this.ctx.showStatus("Returned to main session");
	}

	async attachSwappedMain(target: AgentSession): Promise<void> {
		this.#focusedAgentId = undefined;
		this.#attachedSession = target;
		await this.#attach(target);
	}

	dispose(): void {
		this.#registryUnsubscribe?.();
		this.#registryUnsubscribe = undefined;
	}

	#onRegistryEvent(event: RegistryEvent): void {
		if (event.ref.id !== this.#focusedAgentId) return;
		const gone = event.type === "removed";
		const dead = event.type === "status_changed" && (event.ref.status === "parked" || event.ref.status === "aborted");
		if (!gone && !dead) return;
		void this.unfocus().then(() => {
			this.ctx.showStatus(`Agent ${event.ref.id} is ${gone ? "gone" : event.ref.status}; returned to main session`);
		});
	}

	async #attach(target: AgentSession): Promise<void> {
		this.ctx.unsubscribe?.();
		this.ctx.clearTransientSessionUi();
		const transcriptAnchor = this.ctx.eventController.resetTranscriptAnchors();

		let assistantStreamSynced = false;
		this.ctx.unsubscribe = target.subscribe(async event => {
			if (event.type === "message_start" && event.message.role === "assistant") {
				assistantStreamSynced = true;
			} else if (event.type === "message_update" && event.message.role === "assistant" && !assistantStreamSynced) {
				assistantStreamSynced = true;
				await this.ctx.eventController.dispatchEvent(
					{ type: "message_start", message: event.message },
					transcriptAnchor,
				);
			}
			await this.ctx.eventController.dispatchEvent(event, transcriptAnchor);
		});
		this.ctx.statusLine.setSession(target, this.#focusedAgentId);
		await this.ctx.renderInitialMessages({ clearTerminalHistory: true });

		if (target.isStreaming) {
			await this.ctx.eventController.dispatchEvent({ type: "agent_start" }, transcriptAnchor);
		} else setTerminalTitleState("idle");
		this.ctx.updateEditorBorderColor();
		this.ctx.ui.requestRender();
	}
}
