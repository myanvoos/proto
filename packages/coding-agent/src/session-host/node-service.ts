import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { MAX_RPC_REASSEMBLED_BYTES, RpcFrameEncoder } from "../modes/rpc/rpc-frame";
import { readRpcInputFrames } from "../modes/rpc/rpc-input";
import { RpcMessagesPageError } from "../modes/rpc/rpc-messages";
import type { AgentSession } from "../session/agent-session";
import type { SessionCommandTarget } from "../session/command-target";
import { captureNodeTarget, DirectNodeBackend, type NodeBackend, NodeBackendError } from "../session/node-backend";
import {
	isNodeRequest,
	MAX_NODE_REQUESTS,
	NODE_PROTOCOL_VERSION,
	type NodeChangedFrame,
	type NodeRequest,
	type NodeResponse,
} from "./node-protocol";
import { commitHostedForeground } from "./ownership";
import {
	getSessionHostAttachmentGeneration,
	getSessionHostRpcInput,
	getSessionHostRpcSink,
	markSessionHostServing,
} from "./transport";

export interface HostedNodeService {
	readonly ready: Promise<void>;
	setSession(session: AgentSession): Promise<void>;
	close(): void;
}

/** One tree owner; detached clients lose only their observation and control lease. */
export class NodeService implements HostedNodeService {
	#session: AgentSession;
	#rootIdentity: string;
	#backend: NodeBackend;
	#lease: string | undefined;
	#leaseGeneration = 0;
	#leaseAttachment = -1;
	#pending = 0;
	readonly ready: Promise<void>;
	#handoff: Promise<void>;
	#closed = false;
	#subscriptions = new Map<string, () => void>();
	#changes = new Map<string, NodeChangedFrame>();
	#changeTimer: NodeJS.Timeout | undefined;
	readonly #output: (frame: NodeResponse | NodeChangedFrame) => void;

	constructor(
		session: AgentSession,
		output: (frame: NodeResponse | NodeChangedFrame) => void,
		backend?: NodeBackend,
		readonly attachmentGeneration: () => number = () => 0,
		readonly adoptFork?: (forked: AgentSession, source: SessionCommandTarget) => Promise<boolean>,
		readonly onTerminalRedraw?: () => void,
	) {
		this.#session = session;
		this.#rootIdentity = captureNodeTarget(session.sessionManager).nodeId;
		this.#backend = backend ?? this.#createBackend(session);
		this.#output = output;
		this.ready = commitHostedForeground(session);
		this.#handoff = this.ready;
		if (onTerminalRedraw) process.on("SIGWINCH", onTerminalRedraw);
	}

	#createBackend(session: AgentSession): DirectNodeBackend {
		const rootTarget = captureNodeTarget(session.sessionManager);
		return new DirectNodeBackend(session, undefined, undefined, async (forked, source) => {
			const current = captureNodeTarget(this.#session.sessionManager);
			if (this.#session !== session || current.nodeId !== rootTarget.nodeId || this.#closed)
				throw new NodeBackendError("stale_target", "Foreground root changed before fork adoption");
			if (this.adoptFork && !(await this.adoptFork(forked, source))) return false;
			await this.setSession(forked);
			return true;
		});
	}

	setSession(session: AgentSession): Promise<void> {
		const identity = captureNodeTarget(session.sessionManager).nodeId;
		if (session === this.#session && identity === this.#rootIdentity) return this.#handoff;
		this.#lease = undefined;
		const handoff = this.#handoff
			.catch(() => {})
			.then(async () => {
				if (this.#closed || captureNodeTarget(session.sessionManager).nodeId !== identity)
					throw new NodeBackendError("stale_target", "Foreground changed before its ownership handoff committed");
				await commitHostedForeground(session);
				if (this.#closed) throw new Error("Session host closed during foreground handoff");
				this.#rootIdentity = identity;
				this.#clearSubscriptions();
				this.#backend.close();
				this.#session = session;
				this.#backend = this.#createBackend(session);
			});
		this.#handoff = handoff;
		return handoff;
	}

	async request(request: NodeRequest): Promise<NodeResponse> {
		const fail = (code: string, error: string): NodeResponse => ({
			id: request.id,
			type: "response",
			command: request.type,
			success: false,
			code,
			error,
		});
		if (this.#closed) return fail("service_closed", "Session host is closing");

		if (this.#pending >= MAX_NODE_REQUESTS) return fail("request_capacity", "Too many outstanding node requests");
		this.#pending++;
		try {
			await this.#handoff;
			if (captureNodeTarget(this.#session.sessionManager).nodeId !== this.#rootIdentity)
				await this.setSession(this.#session);
			if (request.type === "negotiate_protocol") {
				if (request.protocolVersion !== NODE_PROTOCOL_VERSION)
					return fail("protocol_mismatch", `Interactive host requires node protocol ${NODE_PROTOCOL_VERSION}`);
				this.#clearSubscriptions();
				this.#leaseAttachment = this.attachmentGeneration();
				this.#lease = `${process.pid}:${++this.#leaseGeneration}:${crypto.randomUUID()}`;
				const root = await this.#backend.snapshot(captureNodeTarget(this.#session.sessionManager).nodeId);
				return {
					id: request.id,
					type: "response",
					command: request.type,
					success: true,
					data: {
						protocolVersion: NODE_PROTOCOL_VERSION,
						controllerLease: this.#lease,
						attachmentPolicy: "latest-wins",
						root,
					},
				};
			}
			if (request.type === "node_snapshot")
				return {
					id: request.id,
					type: "response",
					command: request.type,
					success: true,
					data: await this.#backend.snapshot(request.nodeId),
				};
			if (
				!this.#lease ||
				request.controllerLease !== this.#lease ||
				this.#leaseAttachment !== this.attachmentGeneration()
			)
				return fail("stale_controller", "The controlling attachment changed; negotiate again");
			if (request.type === "node_operation") {
				const data = await this.#backend.execute(request.target, request.operation);
				await this.#handoff;
				if (captureNodeTarget(this.#session.sessionManager).nodeId !== this.#rootIdentity)
					await this.setSession(this.#session);
				return { id: request.id, type: "response", command: request.type, success: true, data };
			}
			const lease = this.#lease;
			const subscriptions = new Map<string, () => void>();
			try {
				for (const nodeId of new Set(request.nodeIds)) {
					const close = await this.#backend.subscribe(nodeId, update => {
						if (lease !== this.#lease || this.#closed || this.#leaseAttachment !== this.attachmentGeneration())
							return;
						this.#changes.set(nodeId, { type: "node_changed", nodeId, generation: update.generation });
						this.#changeTimer ??= setTimeout(() => this.#flushChanges(), 25);
					});
					subscriptions.set(nodeId, close);
				}
				if (lease !== this.#lease || this.#leaseAttachment !== this.attachmentGeneration()) {
					for (const close of subscriptions.values()) close();
					return fail("stale_controller", "Attachment changed during subscription");
				}
			} catch (error) {
				for (const close of subscriptions.values()) close();
				throw error;
			}
			this.#clearSubscriptions();
			this.#subscriptions = subscriptions;
			return {
				id: request.id,
				type: "response",
				command: request.type,
				success: true,
				data: { nodeIds: [...subscriptions.keys()] },
			};
		} catch (error) {
			return fail(
				error instanceof NodeBackendError || error instanceof RpcMessagesPageError
					? error.code
					: "operation_failed",
				error instanceof Error ? error.message : String(error),
			);
		} finally {
			this.#pending--;
		}
	}

	#flushChanges(): void {
		this.#changeTimer = undefined;
		const changes = [...this.#changes.values()];
		this.#changes.clear();
		for (const change of changes) {
			try {
				this.#output(change);
			} catch (error) {
				logger.warn("Node observation connection failed", { nodeId: change.nodeId, error: String(error) });
				break;
			}
		}
	}

	#clearSubscriptions(): void {
		for (const close of this.#subscriptions.values()) close();
		this.#subscriptions.clear();
		clearTimeout(this.#changeTimer);
		this.#changeTimer = undefined;
		this.#changes.clear();
	}

	close(): void {
		if (this.onTerminalRedraw) process.off("SIGWINCH", this.onTerminalRedraw);
		this.#closed = true;
		this.#lease = undefined;
		this.#clearSubscriptions();
		this.#backend.close();
	}
}

/** Socket-only control service beside the full TUI. Never claims stdin or owns session disposal. */
export interface HostedNodeServiceOptions {
	onTerminalRedraw?: () => void;
	adoptFork?: (forked: AgentSession, source: SessionCommandTarget) => Promise<boolean>;
	backend?: NodeBackend;
	input?: ReadableStream<Uint8Array>;
	writeFrame?: (line: string) => void;
	attachmentGeneration?: () => number;
}

export function startHostedNodeService(
	session: AgentSession,
	options: HostedNodeServiceOptions = {},
): HostedNodeService {
	const input = options.input ?? getSessionHostRpcInput();
	const sink = options.writeFrame ?? getSessionHostRpcSink();
	const attachmentGeneration = options.attachmentGeneration ?? getSessionHostAttachmentGeneration;
	if (!input || !sink) throw new Error("Hosted node service requires the existing session-host transport");
	const encoder = new RpcFrameEncoder();
	encoder.setProtocolVersion(2);
	const output = (frame: NodeResponse | NodeChangedFrame) => {
		try {
			for (const line of encoder.encodeFrames(frame)) sink(line);
		} catch (error) {
			logger.warn("Node reply connection failed; client must reconnect for authoritative state", {
				error: String(error),
			});
		}
	};
	const service = new NodeService(
		session,
		output,
		options.backend,
		attachmentGeneration,
		options.adoptFork,
		options.onTerminalRedraw,
	);
	void readRpcInputFrames(
		input,
		frame => {
			if (!isNodeRequest(frame)) {
				output({
					id: isRecord(frame) && typeof frame.id === "string" ? frame.id : "invalid",
					type: "response",
					command: isRecord(frame) && typeof frame.type === "string" ? frame.type : "invalid",
					success: false,
					code: "invalid_request",
					error: "Expected a typed node request with explicit identity and revision",
				});
				return;
			}
			const attachment = attachmentGeneration();
			void service
				.request(frame)
				.then(response => {
					if (attachment === attachmentGeneration()) output(response);
				})
				.catch(error => logger.error("Node response transport failed", { error: String(error) }));
		},
		message =>
			output({
				id: "parse",
				type: "response",
				command: "parse",
				success: false,
				code: "invalid_request",
				error: message,
			}),
	)
		.catch(error =>
			logger.error("Hosted node input failed", { error: String(error), maxBytes: MAX_RPC_REASSEMBLED_BYTES }),
		)
		.finally(() => service.close());
	void service.ready
		.then(markSessionHostServing)
		.catch(error => logger.error("Hosted foreground activation failed", { error: String(error) }));
	return service;
}
