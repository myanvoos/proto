import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID, type RegistryEvent } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import { setTerminalTitleState } from "../../utils/title-generator";
import type { InteractiveModeContext } from "../types";

export class SessionFocusController {
	#focusedAgentId: string | undefined;

	#attachedSession: AgentSession | undefined;
	#focusAttachment: Promise<boolean> | undefined;
	#registryUnsubscribe: (() => void) | undefined;
	#attachGeneration = 0;
	// A focus request that resolves after a newer request (or an explicit leave) drops instead of replacing the view.
	#focusRequestSeq = 0;

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
		const request = ++this.#focusRequestSeq;
		let session: AgentSession;
		try {
			session = await this.lifecycle().ensureLive(id);
		} catch (error) {
			if (request !== this.#focusRequestSeq) return;
			throw error;
		}
		if (request !== this.#focusRequestSeq) return;
		// After ensureLive, because reviving a parked agent re-arms its idle timer on the way out.
		this.lifecycle().holdForFocus(id);
		let attachment = this.#focusAttachment;
		if (id !== this.#focusedAgentId || session !== this.#attachedSession) {
			this.#focusedAgentId = id;
			this.#attachedSession = session;
			this.#registryUnsubscribe ??= this.registry.onChange(e => this.#onRegistryEvent(e));
			attachment = this.#attach(session);
			this.#focusAttachment = attachment;
		} else if (!attachment) {
			// Rebuilding the same live view would discard tool cards whose results are not persisted yet.
			return;
		}
		let attached: boolean;
		try {
			attached = await attachment;
		} catch (error) {
			if (request !== this.#focusRequestSeq) return;
			throw error;
		} finally {
			if (this.#focusAttachment === attachment) this.#focusAttachment = undefined;
		}
		if (!attached || request !== this.#focusRequestSeq) return;
		if (this.#focusedAgentId === id && this.#attachedSession === session) {
			this.ctx.showStatus(`Viewing agent ${id} — Esc returns to main, ←← hops to parent, →→ opens its subagents`);
		}
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
		// An explicit leave also cancels a focus request still waiting on a revive.
		this.#focusRequestSeq++;
		return this.#detachToMain();
	}

	// Reactive teardown (the focused agent died) must not cancel a newer explicit focus request.
	async #detachToMain(): Promise<void> {
		if (!this.#focusedAgentId) return;
		this.lifecycle().holdForFocus(undefined);
		this.#focusedAgentId = undefined;
		this.#attachedSession = undefined;
		const attached = await this.#attach(this.ctx.session);
		if (attached && this.#focusedAgentId === undefined) this.ctx.showStatus("Returned to main session");
	}

	async attachSwappedMain(target: AgentSession): Promise<void> {
		this.#focusRequestSeq++;
		this.lifecycle().holdForFocus(undefined);
		this.#focusedAgentId = undefined;
		this.#attachedSession = target;
		await this.#attach(target);
	}

	dispose(): void {
		this.#focusRequestSeq++;
		this.#attachGeneration++;
		if (this.#focusedAgentId) this.lifecycle().holdForFocus(undefined);
		this.#registryUnsubscribe?.();
		this.#registryUnsubscribe = undefined;
	}

	#onRegistryEvent(event: RegistryEvent): void {
		if (event.ref.id !== this.#focusedAgentId) return;
		const gone = event.type === "removed";
		const dead = event.type === "status_changed" && (event.ref.status === "parked" || event.ref.status === "aborted");
		if (!gone && !dead) return;
		void this.#detachToMain()
			.then(() => {
				this.ctx.showStatus(
					`Agent ${event.ref.id} is ${gone ? "gone" : event.ref.status}; returned to main session`,
				);
			})
			.catch(error => this.#recoverRegistryUnfocus(error))
			.catch(error => {
				this.ctx.showError(`Failed to restore the main session view: ${this.#errorMessage(error)}`);
			});
	}

	async #recoverRegistryUnfocus(error: unknown): Promise<void> {
		this.lifecycle().holdForFocus(undefined);
		this.#focusedAgentId = undefined;
		this.#attachedSession = undefined;
		try {
			await this.#attach(this.ctx.session);
			this.ctx.showError(`Failed to return to the main session: ${this.#errorMessage(error)}`);
		} catch (recoveryError) {
			this.ctx.showError(
				`Failed to return to the main session: ${this.#errorMessage(error)}; recovery failed: ${this.#errorMessage(recoveryError)}`,
			);
		}
	}

	#errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	async #attach(target: AgentSession): Promise<boolean> {
		const generation = ++this.#attachGeneration;
		const current = () => generation === this.#attachGeneration;
		try {
			this.ctx.unsubscribe?.();
			this.ctx.unsubscribe = undefined;
			this.ctx.clearTransientSessionUi();
			const transcriptAnchor = this.ctx.eventController.resetTranscriptAnchors();

			let assistantStreamSynced = false;
			this.ctx.unsubscribe = target.subscribe(async event => {
				if (event.type === "message_start" && event.message.role === "assistant") {
					assistantStreamSynced = true;
				} else if (
					event.type === "message_update" &&
					event.message.role === "assistant" &&
					!assistantStreamSynced
				) {
					assistantStreamSynced = true;
					await this.ctx.eventController.dispatchEvent(
						{ type: "message_start", message: event.message },
						transcriptAnchor,
					);
				}
				await this.ctx.eventController.dispatchEvent(event, transcriptAnchor);
			});
			// Events emitted while no view listened still persist asynchronously: settle that persistence so the
			// rebuild cannot resurrect a result-less tool call whose completion fired unobserved.
			await target.settleInFlightMessagePersistence();
			if (!current()) return false;
			this.ctx.statusLine.setSession(target, this.#focusedAgentId);
			await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
			if (!current()) return false;
			// The checklist HUD follows live events of the attached session only; reload the target's own plan.
			await this.ctx.reloadChecklist(target);
			if (!current()) return false;
			this.ctx.updatePendingMessagesDisplay();

			if (target.isStreaming) {
				await this.ctx.eventController.dispatchEvent({ type: "agent_start" }, transcriptAnchor);
			} else setTerminalTitleState("idle");
			// Partial tool results are display-only events: replay each running tool's latest one over the rebuild.
			for (const event of target.activeToolExecutionUpdates()) {
				if (!current()) return false;
				await this.ctx.eventController.dispatchEvent(event, transcriptAnchor);
			}
			if (!current()) return false;
			this.ctx.updateEditorBorderColor();
			this.ctx.ui.requestRender();
			return true;
		} catch (error) {
			if (current() && this.#focusedAgentId !== undefined) {
				this.lifecycle().holdForFocus(undefined);
				this.#focusedAgentId = undefined;
				this.#attachedSession = undefined;
				try {
					await this.#attach(this.ctx.session);
				} catch (recoveryError) {
					throw new AggregateError(
						[error, recoveryError],
						"Focus attachment and main-session recovery both failed",
					);
				}
			}
			throw error;
		}
	}
}
