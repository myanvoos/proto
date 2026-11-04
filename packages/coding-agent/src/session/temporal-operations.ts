import { atomicWriteJson } from "@oh-my-pi/pi-utils";
import { withDeclaredStateBoundary } from "../eval/declared-state";
import { type AgentRef, AgentRegistry } from "../registry/agent-registry";
import { registerPersistedSubagents } from "../registry/persisted-agents";
import { ExecutionAdmission } from "../task/execution-admission";
import type { AgentSession } from "./agent-session";
import { readNodeTemporalTransition, type SessionNodeTemporalTransition } from "./node-topology";
import type { SessionNodeTopology } from "./session-entries";
import { SessionManager } from "./session-manager";

function assertIdle(session: AgentSession): void {
	if (
		session.isStreaming ||
		session.isBashRunning ||
		session.isEvalRunning ||
		session.isCompacting ||
		session.isRetrying ||
		session.hasAdmittedSubmission
	) {
		throw new Error("Cannot navigate a session subtree with running or admitted work");
	}
}

/** Freeze the known live graph before any await, then include durable parked descendants. */
export function withTemporalMutation<T>(
	session: AgentSession,
	run: (descendants: AgentRef[]) => Promise<T>,
): Promise<T> {
	const registry = AgentRegistry.global();
	const topology = session.sessionManager.getNodeTopology();
	if (topology && topology.state !== "active")
		throw new Error(`Session node is ${topology.state}; history is browse-only`);
	const nodeId = topology?.id ?? session.sessionManager.getSessionId();
	const known = registry.descendants(nodeId);
	const frozen = new Set([nodeId, ...known.map(ref => ref.nodeId ?? ref.id)]);
	return ExecutionAdmission.global().withMutation([...frozen], async () => {
		assertIdle(session);
		for (const ref of known) if (ref.session) assertIdle(ref.session);
		const rootFile = topology?.rootSessionFile ?? session.sessionFile;
		if (rootFile) await registerPersistedSubagents(registry, rootFile);
		const descendants = registry.descendants(nodeId);
		const additional = descendants.map(ref => ref.nodeId ?? ref.id).filter(id => !frozen.has(id));
		return ExecutionAdmission.global().withMutation(additional, async () => {
			assertIdle(session);
			for (const ref of descendants) if (ref.session) assertIdle(ref.session);
			try {
				const result = await withDeclaredStateBoundary(session.getEvalKernelOwnerId(), () => run(descendants));
				const current = session.sessionManager.getNodeTopology();
				const ref = registry.getNode(nodeId);
				if (current && ref) {
					ref.generation = current.generation;
					ref.nodeState = current.state;
				}
				return result;
			} catch (error) {
				const file = session.sessionFile;
				const committed = file ? await readNodeTemporalTransition(file) : undefined;
				if (committed && committed.sourceGeneration > (topology?.generation ?? 0)) {
					// The durable cut cannot roll back. Reopen its read record instead of executing stale runtime context.
					session.beginDispose();
					for (const ref of descendants) if (ref.nodeState === "abandoned") ref.session?.beginDispose();
					try {
						await session.sessionManager.setSessionFile(file!, { throwIfMissing: true });
					} catch (recoveryError) {
						throw new AggregateError(
							[error, recoveryError],
							"Committed temporal cut requires durable recovery before this runtime can be released",
						);
					}
				}
				throw error;
			}
		});
	});
}

interface AbandonedNode {
	ref: AgentRef;
	manager: SessionManager;
	previous: SessionNodeTopology;
	owned: boolean;
}

/** Ownership follows spawn-entry ancestry, never wall-clock ordering. Abandonment is permanent; revisit does not revive. */
export async function abandonContinuationChildren(
	manager: SessionManager,
	boundary: string | null,
	descendants: readonly AgentRef[],
): Promise<void> {
	const node = manager.getNodeTopology();
	if (!node) return;
	const sourceFile = manager.getSessionFile();
	if (!sourceFile) {
		if (descendants.length > 0) throw new Error("Owned children require durable temporal history");
		return;
	}
	const retained = new Set(boundary === null ? [] : manager.getBranch(boundary).map(entry => entry.id));
	const abandoned = new Set<string>();
	const changes: AbandonedNode[] = [];
	try {
		const pending = [...descendants];
		while (pending.length > 0) {
			const index = pending.findIndex(ref => {
				const parentId = ref.parentNodeId ?? ref.parentId;
				return (
					parentId === node.id ||
					abandoned.has(parentId ?? "") ||
					!pending.some(parent => (parent.nodeId ?? parent.id) === parentId)
				);
			});
			if (index < 0) throw new Error("Cycle in temporal subtree ownership");
			const ref = pending.splice(index, 1)[0]!;
			if (!ref.sessionFile) throw new Error(`Missing durable history for node ${ref.id}`);
			const retainedJournal = AgentRegistry.global().getJournal(ref.sessionFile);
			const child =
				ref.session?.sessionManager ??
				retainedJournal ??
				(await SessionManager.open(ref.sessionFile, undefined, undefined, {
					throwIfMissing: true,
					suppressBreadcrumb: true,
				}));
			const owned = !ref.session && !retainedJournal;
			const topology = child.getNodeTopology();
			if (!topology || topology.rootId !== node.rootId) {
				if (owned) await child.close();
				throw new Error(`Invalid durable ownership for node ${ref.id}`);
			}
			if (topology.state === "abandoned") abandoned.add(topology.id);
			const losesAnchor =
				topology.parentId === node.id && (!topology.spawnAnchorId || !retained.has(topology.spawnAnchorId));
			if (topology.state === "active" && (losesAnchor || abandoned.has(topology.parentId ?? ""))) {
				abandoned.add(topology.id);
				changes.push({ ref, manager: child, previous: topology, owned });
			} else if (owned) await child.close();
		}
		const journalFile = `${sourceFile}.temporal.json`;
		const previous = await readNodeTemporalTransition(sourceFile);
		const abandonedEntries = new Map(previous?.abandoned.map(entry => [entry.nodeId, entry]));
		for (const change of changes)
			abandonedEntries.set(change.previous.id, {
				sessionFile: change.ref.sessionFile!,
				nodeId: change.previous.id,
				generation: change.previous.generation + 1,
			});
		const journal: SessionNodeTemporalTransition = {
			version: 1,
			sourceNodeId: node.id,
			sourceGeneration: node.generation + 1,
			boundaryEntryId: boundary,
			abandoned: [...abandonedEntries.values()],
		};
		await atomicWriteJson(journalFile, journal);
		// The journal is authoritative across partial header writes and process restart.
		for (const change of changes) {
			change.ref.nodeState = "abandoned";
			change.ref.generation = change.previous.generation + 1;
		}
		for (const change of changes) {
			await change.manager.setNodeTopology({
				...change.previous,
				state: "abandoned",
				generation: change.previous.generation + 1,
			});
		}
	} finally {
		await Promise.all(changes.filter(change => change.owned).map(change => change.manager.close()));
	}
}
