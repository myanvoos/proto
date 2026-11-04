import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import type { ContextUsage } from "../extensibility/extensions/types";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession, AsyncJobSnapshot, SessionStats } from "./agent-session";
import type { AgentSessionEvent } from "./agent-session-events";
import { captureSessionCommandTarget, type SessionCommandTarget } from "./command-target";
import { type NodeHistoryPage, pageNodeHistory } from "./node-history";
import type { SessionEntry, SessionNodeTopology } from "./session-entries";
import { SessionManager } from "./session-manager";

/** A captured authority, never a display label or a request to resolve current focus. */
export interface NodeTarget {
	readonly nodeId: string;
	readonly generation: number;
	readonly revision: string;
}

export interface NodeSnapshot {
	target: NodeTarget;
	topology: SessionNodeTopology;
	name?: string;
	leafId: string | null;
	entryCount: number;
	runtime: "live" | "parked";
	isStreaming: boolean;
	isCompacting: boolean;
	model?: Model;
	thinkingLevel?: ThinkingLevel;
	parent?: string;
	children: string[];
}

export type NodeOperation =
	| { type: "context" }
	| { type: "jobs" }
	| { type: "tree"; offset?: number; limit?: number }
	| { type: "history"; cursor?: string; limit?: number }
	| { type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { type: "abort" }
	| { type: "abort_compaction" }
	| { type: "abort_retry" }
	| { type: "compact"; instructions?: string }
	| { type: "model"; provider: string; modelId: string; thinkingLevel?: ThinkingLevel }
	| { type: "thinking"; level: ThinkingLevel }
	| { type: "rename"; name: string }
	| { type: "label"; entryId: string; label?: string }
	| { type: "navigate"; entryId: string; summarize?: boolean; instructions?: string }
	| { type: "branch"; entryId: string }
	| { type: "fork" }
	| { type: "cancel_job"; jobId: string }
	| { type: "extension"; name: string; args: string };

export type NodeOperationResult =
	| { type: "context"; usage?: ContextUsage; stats?: SessionStats; runtime: "live" | "parked" }
	| { type: "jobs"; snapshot: AsyncJobSnapshot | null; runtime: "live" | "parked" }
	| {
			type: "tree";
			entries: Array<Pick<SessionEntry, "id" | "parentId" | "type" | "timestamp">>;
			nextOffset?: number;
			totalEntries: number;
	  }
	| { type: "history"; page: NodeHistoryPage }
	| { type: "compact"; result: CompactionResult }
	| { type: "navigate"; cancelled: boolean; editorText?: string; editorImages?: ImageContent[] }
	| { type: "branch"; cancelled: boolean; text: string }
	| { type: "fork"; root?: NodeSnapshot }
	| { type: "cancel_job"; cancelled: boolean }
	| {
			type:
				| "prompt"
				| "abort"
				| "abort_compaction"
				| "abort_retry"
				| "model"
				| "thinking"
				| "rename"
				| "label"
				| "extension";
	  };

export interface NodeReply {
	snapshot: NodeSnapshot;
	result: NodeOperationResult;
}

export type NodeUpdate =
	| { type: "event"; nodeId: string; generation: number; event: AgentSessionEvent }
	| { type: "invalidate"; nodeId: string; generation: number };

export interface NodeBackend {
	snapshot(nodeId: string): Promise<NodeSnapshot>;
	execute(target: NodeTarget, operation: NodeOperation): Promise<NodeReply>;
	subscribe(nodeId: string, listener: (update: NodeUpdate) => void): Promise<() => void>;
	close(): void;
}

export class NodeBackendError extends Error {
	constructor(
		readonly code: "node_not_found" | "stale_target" | "node_read_only" | "node_busy" | "invalid_operation",
		message: string,
	) {
		super(message);
		this.name = "NodeBackendError";
	}
}

/** Metadata only: reading a parked/abandoned node never creates an AgentSession. */
export function captureNodeTarget(manager: SessionManager): NodeTarget {
	const topology = manager.getNodeTopology();
	return {
		nodeId: topology?.id ?? manager.getSessionId(),
		generation: topology?.generation ?? 0,
		revision: `${manager.getLeafId() ?? ""}:${manager.getEntryCount()}:${manager.titleRevision}`,
	};
}

const READ_OPERATIONS = new Set<NodeOperation["type"]>(["tree", "history", "context", "jobs"]);
const CONTROL_OPERATIONS = new Set<NodeOperation["type"]>(["abort", "abort_compaction", "abort_retry", "cancel_job"]);

export class DirectNodeBackend implements NodeBackend {
	#root: AgentSession;
	readonly #registry: AgentRegistry;
	readonly #lifecycle: AgentLifecycleManager;
	readonly #pending = new Set<string>();
	readonly #subscriptions = new Set<() => void>();

	constructor(
		root: AgentSession,
		registry = AgentRegistry.global(),
		lifecycle = AgentLifecycleManager.global(),
		readonly adoptFork?: (forked: AgentSession, source: SessionCommandTarget) => Promise<boolean>,
	) {
		this.#root = root;
		this.#registry = registry;
		this.#lifecycle = lifecycle;
	}

	async #read<T>(
		nodeId: string,
		read: (manager: SessionManager, session?: AgentSession) => T | Promise<T>,
	): Promise<T> {
		const rootTarget = captureNodeTarget(this.#root.sessionManager);
		if (nodeId === rootTarget.nodeId) return read(this.#root.sessionManager, this.#root);
		const rootId = this.#root.sessionManager.getNodeTopology()?.rootId ?? rootTarget.nodeId;
		const ref = this.#registry.getNode(nodeId, rootId);
		if (!ref) throw new NodeBackendError("node_not_found", `Node ${nodeId} is not in this tree`);
		if (ref.session) return read(ref.session.sessionManager, ref.session);
		if (!ref.sessionFile) throw new NodeBackendError("node_not_found", `Node ${nodeId} has no durable history`);
		const manager = await SessionManager.openReadOnly(ref.sessionFile);
		try {
			if (captureNodeTarget(manager).nodeId !== nodeId)
				throw new NodeBackendError("stale_target", "Node history identity changed");
			return await read(manager);
		} finally {
			await manager.close();
		}
	}

	#snapshot(manager: SessionManager, session?: AgentSession): NodeSnapshot {
		const target = captureNodeTarget(manager);
		const topology = manager.getNodeTopology() ?? {
			id: target.nodeId,
			rootId: target.nodeId,
			generation: 0,
			state: "active",
		};
		return {
			target,
			topology,
			name: manager.getSessionName(),
			leafId: manager.getLeafId(),
			entryCount: manager.getEntryCount(),
			runtime: session ? "live" : "parked",
			isStreaming: session?.isStreaming ?? false,
			isCompacting: session?.isCompacting ?? false,
			model: session?.model,
			thinkingLevel: session?.thinkingLevel,
			parent: topology.parentId,
			children: this.#registry
				.list()
				.filter(ref => ref.parentNodeId === target.nodeId && ref.rootId === topology.rootId)
				.map(ref => ref.nodeId ?? ref.id),
		};
	}

	snapshot(nodeId: string): Promise<NodeSnapshot> {
		return this.#read(nodeId, (manager, session) => this.#snapshot(manager, session));
	}

	#validate(target: NodeTarget, manager: SessionManager, mutation: boolean): void {
		const current = captureNodeTarget(manager);
		if (
			target.nodeId !== current.nodeId ||
			target.generation !== current.generation ||
			(mutation && target.revision !== current.revision)
		)
			throw new NodeBackendError(
				"stale_target",
				"Node changed since this action was captured; refresh before retrying",
			);
		if (mutation && manager.getNodeTopology()?.state !== undefined && manager.getNodeTopology()?.state !== "active")
			throw new NodeBackendError("node_read_only", "This node generation is browse-only");
	}

	async execute(target: NodeTarget, operation: NodeOperation): Promise<NodeReply> {
		const mutation = !READ_OPERATIONS.has(operation.type);
		const serial = mutation && !CONTROL_OPERATIONS.has(operation.type);
		if (serial && this.#pending.has(target.nodeId))
			throw new NodeBackendError("node_busy", "A node mutation is already in progress");
		if (serial) this.#pending.add(target.nodeId);
		try {
			return await this.#read(target.nodeId, async (manager, live) => {
				this.#validate(target, manager, serial);
				if (mutation && manager.getNodeTopology()?.state !== "active")
					throw new NodeBackendError("node_read_only", "This node generation is browse-only");
				if (!mutation) {
					let result: NodeOperationResult;
					if (operation.type === "tree") {
						const offset = operation.offset ?? 0;
						const entries = manager.getEntryMetadataPage(offset, operation.limit);
						const totalEntries = manager.getEntryCount();
						result = {
							type: "tree",
							entries,
							totalEntries,
							...(offset + entries.length < totalEntries ? { nextOffset: offset + entries.length } : {}),
						};
					} else if (operation.type === "history")
						result = { type: "history", page: pageNodeHistory(manager, target, operation) };
					else if (operation.type === "jobs")
						result = {
							type: "jobs",
							snapshot: live?.getAsyncJobSnapshot({ recentLimit: 32 }) ?? null,
							runtime: live ? "live" : "parked",
						};
					else
						result = {
							type: "context",
							usage: live?.getContextUsage(),
							stats: live?.getSessionStats(),
							runtime: live ? "live" : "parked",
						};
					return { snapshot: this.#snapshot(manager, live), result };
				}
				let session = live;
				if (!session) {
					const rootId = this.#root.sessionManager.getNodeTopology()?.rootId ?? this.#root.sessionId;
					const ref = this.#registry.getNode(target.nodeId, rootId);
					if (!ref) throw new NodeBackendError("node_not_found", "Node disappeared before revival");
					session = await this.#lifecycle.ensureLive(ref.id);
					this.#validate(target, session.sessionManager, serial);
				}
				const result = await this.#mutate(session, operation);
				await session.sessionManager.ensureOnDisk();
				await session.sessionManager.flush();
				return { snapshot: this.#snapshot(session.sessionManager, session), result };
			});
		} finally {
			if (serial) this.#pending.delete(target.nodeId);
		}
	}

	async #mutate(session: AgentSession, operation: NodeOperation): Promise<NodeOperationResult> {
		switch (operation.type) {
			case "prompt": {
				if (operation.message.startsWith("/")) {
					const name = /^\/(\S+)/.exec(operation.message)?.[1];
					if (name && session.extensionRunner?.getCommand(name))
						throw new NodeBackendError(
							"invalid_operation",
							"Invoke extension commands with a typed extension operation",
						);
				}
				await session.prompt(operation.message, {
					images: operation.images,
					streamingBehavior: operation.streamingBehavior,
				});
				return { type: operation.type };
			}
			case "extension": {
				const runner = session.extensionRunner;
				const command = runner?.getCommand(operation.name);
				if (!runner || !command?.scope)
					throw new NodeBackendError("invalid_operation", "Extension commands require an explicit declared scope");
				if (
					command.scope !== "node" &&
					captureNodeTarget(session.sessionManager).nodeId !== captureNodeTarget(this.#root.sessionManager).nodeId
				)
					throw new NodeBackendError(
						"invalid_operation",
						"This extension command requires an explicit root target",
					);
				await command.handler(operation.args, runner.createCommandContext());
				return { type: operation.type };
			}
			case "abort":
				await session.abort();
				return { type: operation.type };
			case "abort_compaction":
				session.abortCompaction();
				return { type: operation.type };
			case "abort_retry":
				session.abortRetry();
				return { type: operation.type };
			case "compact":
				return { type: "compact", result: await session.compact(operation.instructions) };
			case "model": {
				const model = session
					.getAvailableModels()
					.find(candidate => candidate.provider === operation.provider && candidate.id === operation.modelId);
				if (!model)
					throw new NodeBackendError(
						"invalid_operation",
						`Model not found: ${operation.provider}/${operation.modelId}`,
					);
				await session.setModelTemporary(model, operation.thinkingLevel);
				return { type: operation.type };
			}
			case "thinking":
				session.setThinkingLevel(operation.level);
				return { type: operation.type };
			case "rename":
				if (!(await session.setSessionName(operation.name, "user")))
					throw new NodeBackendError("invalid_operation", "Session name cannot be empty");
				return { type: operation.type };
			case "label":
				session.sessionManager.appendLabelChange(operation.entryId, operation.label);
				return { type: operation.type };
			case "navigate": {
				const result = await session.navigateTree(operation.entryId, {
					summarize: operation.summarize,
					customInstructions: operation.instructions,
					requireIdle: true,
				});
				return {
					type: "navigate",
					cancelled: result.cancelled,
					editorText: result.editorText,
					editorImages: result.editorImages,
				};
			}
			case "branch": {
				const result = await session.branch(operation.entryId);
				return { type: "branch", cancelled: result.cancelled, text: result.selectedText };
			}
			case "fork": {
				const owner = this.#root;
				const ownerTarget = captureNodeTarget(owner.sessionManager);
				const source = captureSessionCommandTarget(session);
				const forked = await session.fork();
				if (!forked) return { type: "fork" };
				try {
					const current = captureNodeTarget(owner.sessionManager);
					if (
						owner !== this.#root ||
						current.nodeId !== ownerTarget.nodeId ||
						current.generation !== ownerTarget.generation
					)
						throw new NodeBackendError("stale_target", "Foreground root changed while creating the fork");
					if (this.adoptFork && !(await this.adoptFork(forked, source)))
						throw new NodeBackendError("stale_target", "Fork foreground adoption was superseded");
					this.#root = forked;
					return { type: "fork", root: this.#snapshot(forked.sessionManager, forked) };
				} catch (error) {
					await forked.releaseRuntime();
					throw error;
				}
			}
			case "cancel_job":
				return { type: "cancel_job", cancelled: session.cancelAsyncJob(operation.jobId) };
			default:
				throw new NodeBackendError("invalid_operation", "Read operation passed to mutation dispatcher");
		}
	}

	async subscribe(nodeId: string, listener: (update: NodeUpdate) => void): Promise<() => void> {
		let current: AgentSession | undefined;
		let unsubscribe = () => {};
		const attach = (session?: AgentSession) => {
			if (session === current) return;
			unsubscribe();
			current = session;
			unsubscribe = session
				? session.subscribe(event =>
						listener({
							type: "event",
							nodeId,
							generation: captureNodeTarget(session.sessionManager).generation,
							event,
						}),
					)
				: () => {};
		};
		await this.#read(nodeId, (_manager, session) => attach(session));
		const rootId = this.#root.sessionManager.getNodeTopology()?.rootId ?? this.#root.sessionId;
		const unwatch = this.#registry.onChange(event => {
			if (event.ref.nodeId !== nodeId || event.ref.rootId !== rootId) return;
			attach(event.ref.session ?? undefined);
			listener({ type: "invalidate", nodeId, generation: event.ref.generation ?? 0 });
		});
		const close = () => {
			unwatch();
			unsubscribe();
			this.#subscriptions.delete(close);
		};
		this.#subscriptions.add(close);
		return close;
	}

	close(): void {
		for (const close of this.#subscriptions) close();
	}
}
