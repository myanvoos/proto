import { isRecord } from "@oh-my-pi/pi-utils";
import type {
	NodeBackend,
	NodeOperation,
	NodeOperationResult,
	NodeReply,
	NodeSnapshot,
	NodeTarget,
	NodeUpdate,
} from "../../session/node-backend";
import { connectSessionRpc, type SessionRpcConnection } from "../../session-host/client";
import {
	isNodeTarget,
	MAX_NODE_REQUESTS,
	MAX_NODE_SUBSCRIPTIONS,
	NODE_PROTOCOL_VERSION,
	type NodeRequest,
	type NodeResponse,
} from "../../session-host/node-protocol";
import { TRANSCRIPT_WINDOW_MESSAGES } from "../utils/transcript-window";

interface PendingNodeRequest {
	resolve(response: NodeResponse): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

type NodeRequestBody =
	| { type: "negotiate_protocol"; protocolVersion: number }
	| { type: "node_snapshot"; nodeId: string }
	| { type: "node_operation"; target: NodeTarget; operation: NodeOperation; controllerLease: string }
	| { type: "node_subscribe"; nodeIds: string[]; controllerLease: string };

export function isNodeSnapshot(value: unknown): value is NodeSnapshot {
	return (
		isRecord(value) &&
		isNodeTarget(value.target) &&
		isRecord(value.topology) &&
		value.topology.id === value.target.nodeId &&
		typeof value.topology.rootId === "string" &&
		value.topology.generation === value.target.generation &&
		(value.topology.state === "active" ||
			value.topology.state === "abandoned" ||
			value.topology.state === "stopped") &&
		(value.leafId === null || typeof value.leafId === "string") &&
		typeof value.entryCount === "number" &&
		Number.isSafeInteger(value.entryCount) &&
		value.entryCount >= 0 &&
		(value.runtime === "live" || value.runtime === "parked") &&
		typeof value.isStreaming === "boolean" &&
		typeof value.isCompacting === "boolean" &&
		Array.isArray(value.children) &&
		value.children.every(id => typeof id === "string")
	);
}

function isNodeOperationResult(value: unknown): value is NodeOperationResult {
	if (!isRecord(value)) return false;
	switch (value.type) {
		case "prompt":
		case "abort":
		case "abort_compaction":
		case "abort_retry":
		case "model":
		case "thinking":
		case "rename":
		case "label":
		case "extension":
			return true;
		case "context":
			return (
				(value.runtime === "live" || value.runtime === "parked") &&
				(value.usage === undefined ||
					(isRecord(value.usage) &&
						typeof value.usage.tokens === "number" &&
						typeof value.usage.contextWindow === "number" &&
						typeof value.usage.percent === "number")) &&
				(value.stats === undefined || isRecord(value.stats))
			);
		case "jobs":
			return (
				(value.runtime === "live" || value.runtime === "parked") &&
				(value.snapshot === null ||
					(isRecord(value.snapshot) &&
						Array.isArray(value.snapshot.running) &&
						Array.isArray(value.snapshot.recent)))
			);
		case "tree":
			return (
				Array.isArray(value.entries) &&
				value.entries.length <= 256 &&
				value.entries.every(
					entry =>
						isRecord(entry) &&
						typeof entry.id === "string" &&
						(entry.parentId === null || typeof entry.parentId === "string") &&
						typeof entry.type === "string" &&
						typeof entry.timestamp === "string",
				) &&
				typeof value.totalEntries === "number" &&
				Number.isSafeInteger(value.totalEntries) &&
				value.totalEntries >= 0 &&
				(value.nextOffset === undefined ||
					(typeof value.nextOffset === "number" &&
						Number.isSafeInteger(value.nextOffset) &&
						value.nextOffset >= 0))
			);
		case "history":
			return (
				isRecord(value.page) &&
				Array.isArray(value.page.messages) &&
				value.page.messages.length <= TRANSCRIPT_WINDOW_MESSAGES &&
				value.page.messages.every(message => isRecord(message) && typeof message.role === "string") &&
				Array.isArray(value.page.entryIds) &&
				value.page.entryIds.every(id => typeof id === "string") &&
				typeof value.page.totalMessages === "number" &&
				Number.isSafeInteger(value.page.totalMessages) &&
				(value.page.headId === null || typeof value.page.headId === "string") &&
				typeof value.page.generation === "number" &&
				Number.isSafeInteger(value.page.generation) &&
				(value.page.nextCursor === undefined || typeof value.page.nextCursor === "string")
			);
		case "compact":
			return (
				isRecord(value.result) &&
				typeof value.result.summary === "string" &&
				typeof value.result.firstKeptEntryId === "string" &&
				typeof value.result.tokensBefore === "number"
			);
		case "navigate":
			return (
				typeof value.cancelled === "boolean" &&
				(value.editorText === undefined || typeof value.editorText === "string") &&
				(value.editorImages === undefined || Array.isArray(value.editorImages))
			);
		case "branch":
			return typeof value.cancelled === "boolean" && typeof value.text === "string";
		case "fork":
			return value.root === undefined || isNodeSnapshot(value.root);
		case "cancel_job":
			return typeof value.cancelled === "boolean";
		default:
			return false;
	}
}

export function decodeNodeResponse(frame: unknown): NodeResponse {
	if (
		!isRecord(frame) ||
		frame.type !== "response" ||
		typeof frame.id !== "string" ||
		typeof frame.command !== "string"
	)
		throw new Error("Invalid node response envelope");
	if (frame.success === false && typeof frame.error === "string" && typeof frame.code === "string")
		return frame as NodeResponse;
	if (frame.success !== true || !isRecord(frame.data)) throw new Error("Invalid node response result");
	const data = frame.data;
	switch (frame.command) {
		case "negotiate_protocol":
			if (
				data.protocolVersion !== NODE_PROTOCOL_VERSION ||
				typeof data.controllerLease !== "string" ||
				data.attachmentPolicy !== "latest-wins" ||
				!isNodeSnapshot(data.root)
			)
				throw new Error("Incompatible node protocol negotiation");
			break;
		case "node_snapshot":
			if (!isNodeSnapshot(data)) throw new Error("Invalid authoritative node snapshot");
			break;
		case "node_operation":
			if (!isNodeSnapshot(data.snapshot) || !isNodeOperationResult(data.result))
				throw new Error("Invalid node operation result");
			break;
		case "node_subscribe":
			if (
				!Array.isArray(data.nodeIds) ||
				!data.nodeIds.every(id => typeof id === "string") ||
				data.nodeIds.length > MAX_NODE_SUBSCRIPTIONS
			)
				throw new Error("Invalid node subscription result");
			break;
		default:
			throw new Error(`Unknown node response command: ${frame.command}`);
	}
	return frame as NodeResponse;
}

/** Same typed operations as the in-process owner. No command text translation or root aliases. */
export class RpcNodeBackend implements NodeBackend {
	#connection: SessionRpcConnection | undefined;
	#connectionEpoch = 0;
	#counter = 0;
	readonly #clientId = crypto.randomUUID();
	#lease: string | undefined;
	#root: NodeSnapshot | undefined;
	#pending = new Map<string, PendingNodeRequest>();
	#listeners = new Map<string, Set<(update: NodeUpdate) => void>>();
	#subscriptionTail = Promise.resolve();

	get root(): NodeSnapshot {
		if (!this.#root) throw new Error("Node backend has not negotiated an authoritative root");
		return this.#root;
	}

	static async connect(socket: string): Promise<RpcNodeBackend> {
		const backend = new RpcNodeBackend();
		await backend.reconnect(socket);
		return backend;
	}

	async reconnect(socket: string): Promise<NodeSnapshot> {
		this.#disconnect(new Error("Session attachment replaced; refresh authoritative state"));
		const epoch = ++this.#connectionEpoch;
		const connection = await connectSessionRpc(socket);
		if (epoch !== this.#connectionEpoch) {
			connection.close();
			throw new Error("Connection superseded while attaching");
		}
		this.#connection = connection;
		void this.#pump(connection, epoch);
		try {
			const response = await this.#request({ type: "negotiate_protocol", protocolVersion: NODE_PROTOCOL_VERSION });
			if (!response.success || response.command !== "negotiate_protocol")
				throw new Error("Node protocol negotiation failed");
			this.#lease = response.data.controllerLease;
			this.#root = response.data.root;
			await this.#setSubscriptions();
			return this.#root;
		} catch (error) {
			if (epoch === this.#connectionEpoch)
				this.#disconnect(error instanceof Error ? error : new Error(String(error)));
			throw error;
		}
	}

	async #pump(connection: SessionRpcConnection, epoch: number): Promise<void> {
		try {
			while (epoch === this.#connectionEpoch) {
				const frame = await connection.frames.next();
				if (epoch !== this.#connectionEpoch) return;
				if (
					isRecord(frame) &&
					frame.type === "node_changed" &&
					typeof frame.nodeId === "string" &&
					typeof frame.generation === "number"
				) {
					for (const listener of this.#listeners.get(frame.nodeId) ?? [])
						listener({ type: "invalidate", nodeId: frame.nodeId, generation: frame.generation });
					continue;
				}
				const response = decodeNodeResponse(frame);
				const pending = this.#pending.get(response.id);
				if (!pending) continue;
				clearTimeout(pending.timer);
				this.#pending.delete(response.id);
				if (response.success) pending.resolve(response);
				else pending.reject(new Error(`${response.code}: ${response.error}`));
			}
		} catch (error) {
			if (epoch === this.#connectionEpoch)
				this.#disconnect(error instanceof Error ? error : new Error(String(error)));
		}
	}

	#request(body: NodeRequestBody): Promise<NodeResponse> {
		const connection = this.#connection;
		if (!connection) return Promise.reject(new Error("Node backend is detached"));
		if (this.#pending.size >= MAX_NODE_REQUESTS) return Promise.reject(new Error("Node request capacity exceeded"));
		const id = `${this.#clientId}:${this.#connectionEpoch}:${++this.#counter}`;
		const { promise, resolve, reject } = Promise.withResolvers<NodeResponse>();
		const timer = setTimeout(() => {
			this.#pending.delete(id);
			reject(new Error("Node request timed out; outcome must be refreshed from authoritative state"));
		}, 300_000);
		this.#pending.set(id, { resolve, reject, timer });
		try {
			const request: NodeRequest = { ...body, id };
			connection.sendCommand(request);
		} catch (error) {
			clearTimeout(timer);
			this.#pending.delete(id);
			reject(error instanceof Error ? error : new Error(String(error)));
		}
		return promise;
	}

	async snapshot(nodeId: string): Promise<NodeSnapshot> {
		const response = await this.#request({ type: "node_snapshot", nodeId });
		if (!response.success || response.command !== "node_snapshot")
			throw new Error("Unexpected node snapshot response");
		if (nodeId !== response.data.target.nodeId) throw new Error("Node snapshot identity mismatch");
		return response.data;
	}

	async execute(target: NodeTarget, operation: NodeOperation): Promise<NodeReply> {
		if (!this.#lease) throw new Error("No controlling attachment lease");
		const response = await this.#request({ type: "node_operation", target, operation, controllerLease: this.#lease });
		if (!response.success || response.command !== "node_operation")
			throw new Error("Unexpected node operation response");
		if (response.data.snapshot.target.nodeId !== target.nodeId || response.data.result.type !== operation.type)
			throw new Error("Node operation result identity mismatch");
		if (response.data.result.type === "fork" && response.data.result.root) {
			const negotiated = await this.#request({ type: "negotiate_protocol", protocolVersion: NODE_PROTOCOL_VERSION });
			if (!negotiated.success || negotiated.command !== "negotiate_protocol")
				throw new Error("Fork completed; authoritative root negotiation failed");
			this.#lease = negotiated.data.controllerLease;
			this.#root = negotiated.data.root;
			this.#listeners.clear();
		}
		return response.data;
	}

	async #setSubscriptions(): Promise<void> {
		if (!this.#lease) throw new Error("No attachment lease for subscriptions");
		const response = await this.#request({
			type: "node_subscribe",
			nodeIds: [...this.#listeners.keys()],
			controllerLease: this.#lease,
		});
		if (!response.success || response.command !== "node_subscribe")
			throw new Error("Unexpected node subscription response");
	}

	async subscribe(nodeId: string, listener: (update: NodeUpdate) => void): Promise<() => void> {
		let listeners = this.#listeners.get(nodeId);
		if (!listeners) {
			if (this.#listeners.size >= MAX_NODE_SUBSCRIPTIONS) throw new Error("Node subscription capacity exceeded");
			listeners = new Set();
			this.#listeners.set(nodeId, listeners);
		}
		listeners.add(listener);
		try {
			await this.#queueSubscriptions();
		} catch (error) {
			listeners.delete(listener);
			if (listeners.size === 0) this.#listeners.delete(nodeId);
			throw error;
		}
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) this.#listeners.delete(nodeId);
			if (this.#connection) void this.#queueSubscriptions().catch(() => {});
		};
	}

	#queueSubscriptions(): Promise<void> {
		const next = this.#subscriptionTail.then(() => this.#setSubscriptions());
		this.#subscriptionTail = next.catch(() => {});
		return next;
	}

	#disconnect(error: Error): void {
		this.#connectionEpoch++;
		this.#connection?.close();
		this.#connection = undefined;
		this.#lease = undefined;
		this.#root = undefined;
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
	}

	close(): void {
		this.#disconnect(new Error("Node backend detached"));
		this.#listeners.clear();
	}
}
