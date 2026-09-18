import type { Agent } from "@oh-my-pi/pi-agent-core";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { IrcBus, type IrcMessage } from "../irc/bus";
import parentIrcSteerTemplate from "../prompts/steering/parent-irc.md" with { type: "text" };
import ircAutoReplyTemplate from "../prompts/system/irc-autoreply.md" with { type: "text" };
import ircIncomingTemplate from "../prompts/system/irc-incoming.md" with { type: "text" };
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSessionEvent } from "./agent-session-events";
import type { CustomMessage } from "./messages";
import type { SessionManager } from "./session-manager";

export const IRC_STREAM_BACKLOG_MAX_MESSAGES = 256;
export const IRC_STREAM_BACKLOG_MAX_BYTES = 1024 * 1024;

export interface IrcBridgeHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	isDisposed(): boolean;
	isStreaming(): boolean;
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	wakeForIrc(records: CustomMessage[]): void;
	runEphemeralTurn(args: { promptText: string }): Promise<{ replyText: string }>;
}

export class IrcBridge {
	readonly #host: IrcBridgeHost;
	#interrupts: CustomMessage[] = [];
	#asides: CustomMessage[] = [];
	#interruptBytes = 0;
	#asideBytes = 0;

	constructor(host: IrcBridgeHost) {
		this.#host = host;
	}

	#recordBytes(record: CustomMessage): number {
		const content = typeof record.content === "string" ? record.content : JSON.stringify(record.content);
		const details = record.details === undefined ? "" : JSON.stringify(record.details);
		return Buffer.byteLength(content) + Buffer.byteLength(details);
	}

	#enqueuePending(target: CustomMessage[], records: CustomMessage[]): void {
		const currentCount = this.#interrupts.length + this.#asides.length;
		const currentBytes = this.#interruptBytes + this.#asideBytes;
		const addedBytes = records.reduce((total, record) => total + this.#recordBytes(record), 0);
		if (
			currentCount + records.length > IRC_STREAM_BACKLOG_MAX_MESSAGES ||
			currentBytes + addedBytes > IRC_STREAM_BACKLOG_MAX_BYTES
		) {
			throw new Error(
				`IRC streaming backlog is full (${currentCount}/${IRC_STREAM_BACKLOG_MAX_MESSAGES} messages, ${currentBytes}/${IRC_STREAM_BACKLOG_MAX_BYTES} bytes); this message was not accepted. Drain the inbox, then retry.`,
			);
		}
		target.push(...records);
		if (target === this.#interrupts) this.#interruptBytes += addedBytes;
		else this.#asideBytes += addedBytes;
	}

	reset(): void {
		this.#interrupts = [];
		this.#asides = [];
		this.#interruptBytes = 0;
		this.#asideBytes = 0;
	}

	hasInterrupts(): boolean {
		return this.#interrupts.length > 0;
	}

	hasPending(): boolean {
		return this.#interrupts.length > 0 || this.#asides.length > 0;
	}

	drainPending(): CustomMessage[] {
		const records = [...this.#interrupts, ...this.#asides];
		this.#interrupts = [];
		this.#asides = [];
		this.#interruptBytes = 0;
		this.#asideBytes = 0;
		return records;
	}

	deferWake(records: CustomMessage[]): void {
		this.#enqueuePending(this.#asides, records);
	}

	drainInboxMessages(agentId: string, opts?: { from?: string; limit?: number; peek?: boolean }): IrcMessage[] {
		const messages: IrcMessage[] = [];
		const remainingInterrupts: CustomMessage[] = [];
		const remainingAsides: CustomMessage[] = [];
		const queues = [
			{ records: this.#interrupts, remaining: remainingInterrupts },
			{ records: this.#asides, remaining: remainingAsides },
		];
		for (const queue of queues) {
			for (const record of queue.records) {
				if (record.customType !== "irc:incoming") {
					queue.remaining.push(record);
					continue;
				}
				const details = record.details;
				if (!details || typeof details !== "object") {
					queue.remaining.push(record);
					continue;
				}
				const id = Reflect.get(details, "id");
				const from = Reflect.get(details, "from");
				const body = Reflect.get(details, "message");
				const replyTo = Reflect.get(details, "replyTo");
				if (typeof id !== "string" || typeof from !== "string" || typeof body !== "string") {
					queue.remaining.push(record);
					continue;
				}
				if (opts?.from !== undefined && from !== opts.from) {
					queue.remaining.push(record);
					continue;
				}
				if (opts?.limit !== undefined && messages.length >= opts.limit) {
					queue.remaining.push(record);
					continue;
				}
				if (opts?.peek) {
					// Peek reads must not consume the queued record.
					queue.remaining.push(record);
				}
				messages.push({
					id,
					from,
					to: agentId,
					body,
					ts: record.timestamp,
					...(typeof replyTo === "string" ? { replyTo } : {}),
				});
			}
		}
		this.#interrupts = remainingInterrupts;
		this.#asides = remainingAsides;
		this.#interruptBytes = remainingInterrupts.reduce((total, record) => total + this.#recordBytes(record), 0);
		this.#asideBytes = remainingAsides.reduce((total, record) => total + this.#recordBytes(record), 0);
		return messages;
	}

	async deliver(msg: IrcMessage, opts?: { expectsReply?: boolean }): Promise<"injected" | "woken"> {
		if (this.#host.isDisposed()) throw new Error("Recipient session is disposed.");
		const streaming = this.#host.isStreaming();
		const autoReply = (opts?.expectsReply ?? false) && streaming && !this.#host.settings.get("async.enabled");
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:incoming",
			content: prompt.render(ircIncomingTemplate, {
				from: msg.from,
				message: msg.body,
				replyTo: msg.replyTo ?? "",
				autoReplied: autoReply,
				interrupting: streaming,
			}),
			display: true,
			details: { id: msg.id, from: msg.from, message: msg.body, ...(msg.replyTo ? { replyTo: msg.replyTo } : {}) },
			attribution: "agent",
			timestamp: msg.ts,
		};
		if (streaming) {
			const recipientParentId = AgentRegistry.global().get(msg.to)?.parentId;
			if (recipientParentId === msg.from) {
				this.#host.agent.steer({
					role: "user",
					content: prompt.render(parentIrcSteerTemplate, { from: msg.from, message: msg.body }),
					attribution: "agent",
					timestamp: msg.ts,
					steering: true,
				});
			} else {
				this.#enqueuePending(this.#interrupts, [record]);
			}
			void this.#host.emitSessionEvent({ type: "irc_message", message: record });
			if (autoReply) void this.#runAutoReply(msg);
			return "injected";
		}
		void this.#host.emitSessionEvent({ type: "irc_message", message: record });
		this.#host.wakeForIrc([record]);
		return "woken";
	}

	emitRelayObservation(record: CustomMessage): void {
		void this.#host.emitSessionEvent({ type: "irc_message", message: record });
	}

	flushPending(): void {
		for (const record of this.drainPending()) {
			this.#host.agent.emitExternalEvent({ type: "message_start", message: record });
			this.#host.agent.emitExternalEvent({ type: "message_end", message: record });
		}
	}

	async #runAutoReply(msg: IrcMessage): Promise<void> {
		const sessionId = this.#host.sessionManager.getSessionId();
		try {
			const { replyText } = await this.#host.runEphemeralTurn({
				promptText: prompt.render(ircAutoReplyTemplate, {
					from: msg.from,
					message: msg.body,
					replyTo: msg.replyTo ?? "",
				}),
			});
			const body = replyText.trim();
			if (!body || this.#host.isDisposed() || this.#host.sessionManager.getSessionId() !== sessionId) return;
			const record: CustomMessage = {
				role: "custom",
				customType: "irc:autoreply",
				content: `[IRC you → \`${msg.from}\` (auto)]\n\n${body}`,
				display: true,
				details: { to: msg.from, body, replyTo: msg.id },
				attribution: "agent",
				timestamp: Date.now(),
			};
			void this.#host.emitSessionEvent({ type: "irc_message", message: record });
			this.#enqueuePending(this.#asides, [record]);
			const fleetRoot = AgentRegistry.global().get(msg.from)?.fleetRoot;
			const receipt = await IrcBus.global().send(
				{ from: msg.to, to: msg.from, body, replyTo: msg.id },
				{ fleetRoot },
			);
			if (receipt.outcome === "rejected" || receipt.outcome === "dropped") {
				logger.warn("IRC auto-reply delivery failed", { to: msg.from, error: receipt.error });
			}
		} catch (error) {
			logger.warn("IRC auto-reply turn failed", { from: msg.from, error: String(error) });
		}
	}
}
