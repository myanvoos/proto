import {
	captureDeclaredState,
	commitDeclaredStateCapture,
	type DeclaredKernelState,
	declaredStateLane,
	stageDeclaredState,
	withDeclaredStateBoundary,
} from "../eval/declared-state";
import { validateVmDeclaredState } from "../eval/js/context-manager";
import { listKernelLaneConfigurations, setKernelLaneConfiguration } from "../eval/kernel-environment";
import { parseKernelTarget } from "../eval/kernel-target";
import { PythonKernel } from "../eval/py/kernel";
import type { SessionManager } from "./session-manager";

export const DECLARED_STATE_CUSTOM_TYPE = "declared-state";
interface StateManifest {
	version: 1;
	sessionId: string;
	boundaryEntryId: string | null;
	kernels: DeclaredKernelState[];
	configurations: Omit<DeclaredKernelState, "snapshot">[];
}
export interface PreparedSessionState {
	readonly boundaryEntryId: string | null;
	readonly kernels: readonly DeclaredKernelState[];
	readonly configurations: readonly Omit<DeclaredKernelState, "snapshot">[];
}

function readManifest(value: unknown): StateManifest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Corrupt declared state manifest");
	const manifest = value as StateManifest;
	if (
		manifest.version !== 1 ||
		typeof manifest.sessionId !== "string" ||
		(manifest.boundaryEntryId !== null && typeof manifest.boundaryEntryId !== "string") ||
		!Array.isArray(manifest.kernels) ||
		!Array.isArray(manifest.configurations)
	)
		throw new Error("Corrupt or unsupported declared state manifest");
	const keys = new Set<string>();
	for (const state of [...manifest.kernels, ...manifest.configurations]) {
		if (
			!state ||
			!["python", "node", "bun"].includes(state.language) ||
			typeof state.lane !== "string" ||
			typeof state.cwd !== "string" ||
			(state.interpreter !== undefined && typeof state.interpreter !== "string")
		)
			throw new Error("Corrupt declared state kernel manifest");
		parseKernelTarget(state.target);
		const isKernel = manifest.kernels.includes(state as DeclaredKernelState);
		if (isKernel && !(state as DeclaredKernelState).snapshot) throw new Error("Corrupt declared state snapshot");
		const key = JSON.stringify([
			isKernel,
			state.language,
			state.lane,
			state.cwd,
			state.interpreter ?? "",
			state.target,
		]);
		if (keys.has(key)) throw new Error("Duplicate declared state kernel manifest");
		keys.add(key);
	}
	return structuredClone(manifest);
}

/** The immutable codec result is captured while every cell admission is frozen, then durably committed. */
export async function captureSessionState(
	manager: SessionManager,
	ownerId: string,
	boundaryEntryId = manager.getLeafId(),
	beforeCommit?: () => void,
): Promise<void> {
	await withDeclaredStateBoundary(ownerId, async () => {
		if (manager.getLeafId() !== boundaryEntryId)
			throw new Error("Declared state capture requires the exact current history boundary");
		const kernels = await captureDeclaredState(ownerId);
		const configurations = listKernelLaneConfigurations(ownerId).map(({ language, sessionId, configuration }) => ({
			language,
			lane: declaredStateLane(sessionId),
			...configuration,
		}));
		if (manager.getLeafId() !== boundaryEntryId)
			throw new Error("History changed while declared state was being captured");
		const leaf = manager.getLeafEntry();
		// An empty turn must not create an unbounded chain of redundant manifest-only boundaries.
		if (leaf?.type === "custom" && leaf.customType === DECLARED_STATE_CUSTOM_TYPE && boundaryEntryId === leaf.id) {
			const previous = readManifest(leaf.data);
			if (
				!beforeCommit &&
				previous.sessionId === manager.getSessionId() &&
				JSON.stringify(previous.kernels) === JSON.stringify(kernels) &&
				JSON.stringify(previous.configurations) === JSON.stringify(configurations)
			) {
				commitDeclaredStateCapture(ownerId, kernels);
				return;
			}
		}
		await manager.appendEntriesAtomically(() => {
			beforeCommit?.();
			manager.appendCustomEntry(DECLARED_STATE_CUSTOM_TYPE, {
				version: 1,
				sessionId: manager.getSessionId(),
				boundaryEntryId: manager.getLeafId(),
				kernels,
				configurations,
			} satisfies StateManifest);
		});
		commitDeclaredStateCapture(ownerId, kernels);
	});
}

/** Exact branch cuts only. A missing or corrupt declared boundary is never substituted with an older capture. */
export async function prepareSessionStateRestore(
	manager: SessionManager,
	ownerId: string,
	boundaryEntryId: string | null,
): Promise<PreparedSessionState> {
	return withDeclaredStateBoundary(ownerId, async () => {
		const current = await captureDeclaredState(ownerId);
		let selected: StateManifest | undefined;
		for (const entry of manager.iterateCustomEntries(DECLARED_STATE_CUSTOM_TYPE)) {
			// Inspect every retained historical manifest, not a recent-turn window.
			const manifest = readManifest(entry.data);
			if (manifest.sessionId !== manager.getSessionId()) continue;
			if (entry.id !== boundaryEntryId && manifest.boundaryEntryId !== boundaryEntryId) continue;
			if (entry.id !== boundaryEntryId && entry.parentId !== manifest.boundaryEntryId)
				throw new Error("Declared state manifest is not attached to its history boundary");
			selected = manifest;
		}
		if (!selected) {
			if (
				current.length ||
				manager.getCustomEntries(DECLARED_STATE_CUSTOM_TYPE).some(entry => {
					const manifest = readManifest(entry.data);
					return manifest.sessionId === manager.getSessionId() && manifest.kernels.length;
				})
			)
				throw new Error("No declared state manifest exists at this exact history boundary");
			selected = { version: 1, sessionId: manager.getSessionId(), boundaryEntryId, kernels: [], configurations: [] };
		}
		// Use the actual selected interpreter/target as the compatibility oracle, before source disposal.
		for (const state of selected.kernels) {
			if (state.language !== "python") {
				await validateVmDeclaredState(state);
				continue;
			}
			const kernel = await PythonKernel.start({
				cwd: state.cwd,
				interpreter: state.interpreter,
				target: state.target,
			});
			const errors: unknown[] = [];
			try {
				await kernel.declaredState("restore", state.snapshot);
			} catch (error) {
				errors.push(error);
			}
			try {
				const closed = await kernel.shutdown();
				if (!closed.confirmed) errors.push(new Error("Declared state preflight kernel cleanup was not confirmed"));
			} catch (error) {
				errors.push(error);
			}
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) throw new AggregateError(errors, "Declared state validation and cleanup failed");
		}
		return { boundaryEntryId, kernels: selected.kernels, configurations: selected.configurations };
	});
}

/** Commit only after the destination history and source runtime teardown have succeeded. No user cell is replayed. */
export function activateSessionStateRestore(
	prepared: PreparedSessionState,
	targetOwnerId: string,
	targetEvalSessionId: string,
): void {
	const kernels = structuredClone([...prepared.kernels]);
	stageDeclaredState(targetOwnerId, kernels);
	for (const state of prepared.configurations) {
		const sessionId =
			state.lane === "main" ? targetEvalSessionId : `${targetEvalSessionId}:lane:${encodeURIComponent(state.lane)}`;
		setKernelLaneConfiguration(targetOwnerId, state.language, `${state.language}:${sessionId}`, {
			cwd: state.cwd,
			interpreter: state.interpreter,
			target: state.target,
		});
	}
}

/** A newly opened runtime stages only its own exact durable head; copied ancestor history grants no state. */
export function stageSessionStateOnResume(manager: SessionManager, ownerId: string, evalSessionId: string): void {
	const leafId = manager.getLeafId();
	let selected: StateManifest | undefined;
	let hasDeclared = false;
	for (const entry of manager.iterateCustomEntries(DECLARED_STATE_CUSTOM_TYPE)) {
		const manifest = readManifest(entry.data);
		if (manifest.sessionId !== manager.getSessionId()) continue;
		hasDeclared ||= manifest.kernels.length > 0;
		if (entry.id === leafId || (manifest.boundaryEntryId === leafId && entry.parentId === leafId))
			selected = manifest;
	}
	if (!selected && hasDeclared)
		throw new Error("Declared state has no exact manifest at the resumed history boundary");
	if (selected)
		activateSessionStateRestore(
			{ boundaryEntryId: leafId, kernels: selected.kernels, configurations: selected.configurations },
			ownerId,
			evalSessionId,
		);
}

/** Parked/disposing nodes append metadata, never computation; carry their exact immutable view in that same commit. */
export async function appendSessionMetadataWithState(
	manager: Pick<
		SessionManager,
		"appendEntriesAtomically" | "getLeafId" | "iterateCustomEntries" | "getSessionId" | "appendCustomEntry"
	>,
	append: () => void,
): Promise<void> {
	await manager.appendEntriesAtomically(() => {
		const boundary = manager.getLeafId();
		let selected: StateManifest | undefined;
		let hasDeclared = false;
		for (const entry of manager.iterateCustomEntries(DECLARED_STATE_CUSTOM_TYPE)) {
			const manifest = readManifest(entry.data);
			if (manifest.sessionId !== manager.getSessionId()) continue;
			hasDeclared ||= manifest.kernels.length > 0;
			if (entry.id === boundary || (entry.parentId === boundary && manifest.boundaryEntryId === boundary))
				selected = manifest;
		}
		if (!selected && hasDeclared) throw new Error("Parked metadata has no exact declared state boundary to carry");
		append();
		if (selected)
			manager.appendCustomEntry(DECLARED_STATE_CUSTOM_TYPE, {
				...selected,
				boundaryEntryId: manager.getLeafId(),
			} satisfies StateManifest);
	});
}
