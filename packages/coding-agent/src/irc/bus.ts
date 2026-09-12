import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import type { CustomMessage } from "../session/messages";

export interface IrcMessage {
	id: string;

	from: string;

	to: string;
	body: string;
	ts: number;

	replyTo?: string;
}

export interface IrcDeliveryReceipt {
	to: string;
	outcome: "injected" | "woken" | "revived" | "failed";
	error?: string;
}

interface IrcWaiter {
	from?: string;
	fleetRoot: string;
	resolve: (msg: IrcMessage) => void;
	cancel: () => void;
}

interface IrcMailboxEntry {
	message: IrcMessage;
	fleetRoot: string;
}

const MAILBOX_CAP = 100;

export class IrcBus {
	static #global: IrcBus | undefined;

	static global(): IrcBus {
		if (!IrcBus.#global) {
			IrcBus.#global = new IrcBus();
		}
		return IrcBus.#global;
	}

	static resetGlobalForTests(): void {
		IrcBus.#global = undefined;
	}

	readonly #registry: AgentRegistry;
	readonly #lifecycle: () => AgentLifecycleManager;
	readonly #mailboxes = new Map<string, IrcMailboxEntry[]>();
	readonly #waiters = new Map<string, IrcWaiter[]>();

	constructor(registry: AgentRegistry = AgentRegistry.global(), lifecycle?: AgentLifecycleManager) {
		this.#registry = registry;

		this.#lifecycle = () => lifecycle ?? AgentLifecycleManager.global();
	}

	async send(
		msg: Omit<IrcMessage, "id" | "ts">,
		opts?: { expectsReply?: boolean; suppressRelay?: boolean; fleetRoot?: string },
	): Promise<IrcDeliveryReceipt> {
		const message: IrcMessage = { ...msg, id: Snowflake.next(), ts: Date.now() };
		const source = opts?.fleetRoot
			? this.#registry.getInFleet(message.from, opts.fleetRoot)
			: this.#registry.get(message.from);
		const fleetRoot = opts?.fleetRoot ?? source?.fleetRoot;
		const ref = fleetRoot ? this.#registry.getInFleet(message.to, fleetRoot) : undefined;
		if (!source || !ref || !fleetRoot) {
			return {
				to: message.to,
				outcome: "failed",
				error: `Unknown agent "${message.to}" — check \`irc list\` for live peers.`,
			};
		}
		if (ref.status === "aborted") {
			return {
				to: message.to,
				outcome: "failed",
				error: `Agent "${message.to}" was hard-aborted and cannot be messaged or revived. Its transcript remains readable at history://${message.to}.`,
			};
		}

		if (ref.kind === "advisor") {
			return {
				to: message.to,
				outcome: "failed",
				error: `Agent "${message.to}" is a read-only advisor transcript and cannot be messaged.`,
			};
		}

		const lifecycle = this.#lifecycle();
		const lifecycleOwnsRegistry = lifecycle.manages(this.#registry);
		const needsLifecycleGate =
			ref.status === "parked" ||
			(lifecycleOwnsRegistry && (lifecycle.isParking(message.to) || lifecycle.has(message.to)));

		const priorSession = ref.session;
		let revived = false;
		if (needsLifecycleGate) {
			try {
				const liveSession = await lifecycle.ensureLive(message.to);

				revived = !priorSession || liveSession !== priorSession;
			} catch (error) {
				return {
					to: message.to,
					outcome: "failed",
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}

		if (
			this.#registry.getInFleet(message.from, fleetRoot) !== source ||
			this.#registry.getInFleet(message.to, fleetRoot) !== ref
		) {
			return {
				to: message.to,
				outcome: "failed",
				error: `Agent "${message.to}" changed sessions before delivery.`,
			};
		}

		const waiter = this.#takeMatchingWaiter(message.to, message.from, fleetRoot);
		if (waiter) {
			waiter.resolve(message);
			if (!opts?.suppressRelay) this.#relayToMainUi(message, fleetRoot);
			return { to: message.to, outcome: revived ? "revived" : "injected" };
		}

		const session = ref.session;
		if (!session) {
			return { to: message.to, outcome: "failed", error: `Agent "${message.to}" has no live session.` };
		}

		try {
			const delivery = await session.deliverIrcMessage(message, opts);
			if (!opts?.suppressRelay) this.#relayToMainUi(message, fleetRoot);
			return { to: message.to, outcome: revived ? "revived" : delivery };
		} catch (error) {
			this.#enqueue(message, fleetRoot);
			return {
				to: message.to,
				outcome: "failed",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async wait(
		agentId: string,
		filter: { from?: string },
		timeoutMs: number,
		signal?: AbortSignal,
		options?: {
			drainPending?: boolean;
			fleetRoot?: string;
			liveness?: { registry: AgentRegistry; senderId: string };
		},
	): Promise<IrcMessage | null> {
		if (signal?.aborted) {
			throw signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted");
		}
		const fleetRoot = options?.fleetRoot ?? this.#registry.get(agentId)?.fleetRoot;
		if (!fleetRoot || !this.#registry.getInFleet(agentId, fleetRoot)) {
			throw new Error("IRC wait aborted: agent session is unavailable");
		}

		if (options?.drainPending !== false) {
			const pending = this.#takeFromMailbox(agentId, filter.from, fleetRoot);
			if (pending) return pending;
		}

		const { promise, resolve, reject } = Promise.withResolvers<IrcMessage | null>();
		let timer: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;
		let unsubscribeLiveness: (() => void) | undefined;
		let unsubscribeScope: (() => void) | undefined;

		const liveness = options?.liveness;
		const livenessReason = filter.from
			? `IRC wait aborted: agent "${filter.from}" is no longer active`
			: "IRC wait aborted: no active peers remain";

		const settle = (
			outcome: { kind: "message"; msg: IrcMessage } | { kind: "timeout" } | { kind: "abort"; error: Error },
		): void => {
			cleanup();
			if (outcome.kind === "message") {
				resolve(outcome.msg);
			} else if (outcome.kind === "timeout") {
				resolve(null);
			} else {
				reject(outcome.error);
			}
		};

		const cleanup = (): void => {
			this.#removeWaiter(agentId, waiter);
			clearTimeout(timer);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
			unsubscribeLiveness?.();
			unsubscribeScope?.();
		};

		const waiter: IrcWaiter = {
			from: filter.from,
			fleetRoot,
			resolve: msg => settle({ kind: "message", msg }),
			cancel: () => cleanup(),
		};

		if (signal) {
			onAbort = () =>
				settle({
					kind: "abort",
					error: signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted"),
				});
			signal.addEventListener("abort", onAbort, { once: true });
		}
		if (timeoutMs > 0) {
			timer = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
			timer.unref?.();
		}

		let waiters = this.#waiters.get(agentId);
		if (!waiters) {
			waiters = [];
			this.#waiters.set(agentId, waiters);
		}
		waiters.push(waiter);

		const scopeChanged = (): boolean => !this.#registry.getInFleet(agentId, fleetRoot);
		unsubscribeScope = this.#registry.onChange(event => {
			if (event.ref.id !== agentId || !scopeChanged()) return;
			settle({ kind: "abort", error: new Error("IRC wait aborted: agent session changed") });
		});
		if (scopeChanged()) {
			settle({ kind: "abort", error: new Error("IRC wait aborted: agent session changed") });
			return promise;
		}

		if (liveness) {
			const { registry, senderId } = liveness;
			const hasActiveSender = (from?: string): boolean =>
				registry.listVisibleTo(senderId, fleetRoot).some(ref => !from || ref.id === from);
			const check = filter.from ? () => hasActiveSender(filter.from) : () => hasActiveSender();
			unsubscribeLiveness = registry.onChange(() => {
				if (!check()) {
					settle({ kind: "abort", error: new Error(livenessReason) });
				}
			});
			if (!check()) {
				settle({ kind: "abort", error: new Error(livenessReason) });
			}
		}

		return promise;
	}

	inbox(agentId: string, opts?: { peek?: boolean; fleetRoot?: string }): IrcMessage[] {
		const entries = this.#visibleMailbox(agentId, opts?.fleetRoot);
		if (!entries || entries.length === 0) return [];
		if (opts?.peek) return entries.map(entry => entry.message);
		const visible = new Set(entries);
		const retained = (this.#mailboxes.get(agentId) ?? []).filter(entry => !visible.has(entry));
		if (retained.length > 0) this.#mailboxes.set(agentId, retained);
		else this.#mailboxes.delete(agentId);
		return entries.map(entry => entry.message);
	}

	take(agentId: string, from?: string, fleetRoot?: string): IrcMessage | undefined {
		return this.#takeFromMailbox(agentId, from, fleetRoot);
	}

	unreadCount(agentId: string, fleetRoot?: string): number {
		return this.#visibleMailbox(agentId, fleetRoot)?.length ?? 0;
	}

	#visibleMailbox(agentId: string, scopedFleetRoot?: string): IrcMailboxEntry[] | undefined {
		const mailbox = this.#mailboxes.get(agentId);
		if (!mailbox) return undefined;
		const fleetRoot = scopedFleetRoot ?? this.#registry.get(agentId)?.fleetRoot;
		if (!fleetRoot) return undefined;
		const visible = mailbox.filter(
			entry =>
				entry.fleetRoot === fleetRoot &&
				this.#registry.getInFleet(entry.message.from, fleetRoot) !== undefined &&
				this.#registry.getInFleet(entry.message.to, fleetRoot) !== undefined,
		);
		const retained = mailbox.filter(entry => entry.fleetRoot !== fleetRoot || visible.includes(entry));
		if (retained.length !== mailbox.length) {
			if (retained.length > 0) this.#mailboxes.set(agentId, retained);
			else this.#mailboxes.delete(agentId);
		}
		return visible.length > 0 ? visible : undefined;
	}

	#enqueue(message: IrcMessage, fleetRoot: string): void {
		let mailbox = this.#mailboxes.get(message.to);
		if (!mailbox) {
			mailbox = [];
			this.#mailboxes.set(message.to, mailbox);
		}
		mailbox.push({ message, fleetRoot });
		if (mailbox.length > MAILBOX_CAP) {
			const dropped = mailbox.shift();
			logger.debug("IrcBus: mailbox full, dropped oldest message", {
				agentId: message.to,
				droppedId: dropped?.message.id,
				droppedFrom: dropped?.message.from,
			});
		}
	}

	#takeMatchingWaiter(agentId: string, from: string, fleetRoot: string): IrcWaiter | undefined {
		const waiters = this.#waiters.get(agentId);
		if (!waiters) return undefined;
		const index = waiters.findIndex(
			waiter => waiter.fleetRoot === fleetRoot && (!waiter.from || waiter.from === from),
		);
		if (index === -1) return undefined;
		const [waiter] = waiters.splice(index, 1);
		if (waiters.length === 0) this.#waiters.delete(agentId);
		return waiter;
	}

	#removeWaiter(agentId: string, waiter: IrcWaiter): void {
		const waiters = this.#waiters.get(agentId);
		if (!waiters) return;
		const index = waiters.indexOf(waiter);
		if (index !== -1) waiters.splice(index, 1);
		if (waiters.length === 0) this.#waiters.delete(agentId);
	}

	#takeFromMailbox(agentId: string, from?: string, fleetRoot?: string): IrcMessage | undefined {
		const visible = this.#visibleMailbox(agentId, fleetRoot);
		if (!visible) return undefined;
		const entry = from ? visible.find(candidate => candidate.message.from === from) : visible[0];
		if (!entry) return undefined;
		const mailbox = this.#mailboxes.get(agentId);
		if (!mailbox) return undefined;
		const index = mailbox.indexOf(entry);
		if (index === -1) return undefined;
		mailbox.splice(index, 1);
		if (mailbox.length === 0) this.#mailboxes.delete(agentId);
		return entry.message;
	}

	#relayToMainUi(message: IrcMessage, fleetRoot: string): void {
		if (message.to === MAIN_AGENT_ID || message.from === MAIN_AGENT_ID) return;
		const mainSession = this.#registry.getInFleet(MAIN_AGENT_ID, fleetRoot)?.session;
		if (!mainSession) return;
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:relay",
			content: `[IRC \`${message.from}\` → \`${message.to}\`]\n\n${message.body}`,
			display: true,
			details: { from: message.from, to: message.to, body: message.body },
			attribution: "agent",
			timestamp: message.ts,
		};
		try {
			mainSession.emitIrcRelayObservation(record);
		} catch (error) {
			logger.debug("IrcBus: main UI relay failed", { to: message.to, error: String(error) });
		}
	}
}
