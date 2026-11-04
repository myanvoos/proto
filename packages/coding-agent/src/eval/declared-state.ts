import { AsyncLocalStorage } from "node:async_hooks";
import type { KernelLanguage } from "./kernel-environment";
import type { KernelTarget } from "./kernel-target";

export interface DeclaredKernelState {
	language: KernelLanguage;
	lane: string;
	cwd: string;
	interpreter?: string;
	target: KernelTarget;
	snapshot: unknown;
}

interface KernelStateHandle {
	namespace: string;
	generation: string;
	metadata: Omit<DeclaredKernelState, "snapshot">;
	alive(): boolean;
	request(action: "capture" | "restore", snapshot?: unknown): Promise<unknown>;
}
interface TrackedKernel extends KernelStateHandle {
	captured?: unknown;
	dirty: boolean;
}
interface OwnerState {
	active: number;
	frozen?: PromiseWithResolvers<void>;
	idle?: PromiseWithResolvers<void>;
	kernels: Map<string, TrackedKernel>;
	pending: DeclaredKernelState[];
	staged?: boolean;
}
const owners = new Map<string, OwnerState>();
const boundaryOwners = new AsyncLocalStorage<ReadonlyMap<string, PromiseWithResolvers<void>>>();
function ownsBoundary(ownerId: string): boolean {
	const lease = boundaryOwners.getStore()?.get(ownerId);
	return lease !== undefined && owners.get(ownerId)?.frozen === lease;
}
function ownerState(ownerId: string): OwnerState {
	let state = owners.get(ownerId);
	if (!state) {
		state = { active: 0, kernels: new Map(), pending: [] };
		owners.set(ownerId, state);
	}
	return state;
}

/** Runtime IDs include their session prefix; only the explicit lane suffix crosses a session fork. */
export function declaredStateLane(sessionId: string): string {
	const marker = sessionId.lastIndexOf(":lane:");
	return marker < 0 ? "main" : decodeURIComponent(sessionId.slice(marker + 6));
}
function key(metadata: Omit<DeclaredKernelState, "snapshot">): string {
	return JSON.stringify([metadata.language, metadata.lane, metadata.interpreter ?? "", metadata.cwd, metadata.target]);
}

/** Cells may run concurrently; a history capture exclusively freezes admissions and drains all cells. */
export async function withDeclaredStateExecution<T>(ownerId: string, action: () => Promise<T>): Promise<T> {
	if (ownsBoundary(ownerId)) return await action();
	const state = ownerState(ownerId);
	while (state.frozen) await state.frozen.promise;
	state.active++;
	try {
		return await action();
	} finally {
		state.active--;
		if (!state.active) state.idle?.resolve();
	}
}
export async function withDeclaredStateBoundary<T>(ownerId: string, action: () => Promise<T>): Promise<T> {
	if (ownsBoundary(ownerId)) return await action();
	const state = ownerState(ownerId);
	while (state.frozen) await state.frozen.promise;
	const frozen = Promise.withResolvers<void>();
	state.frozen = frozen;
	try {
		if (state.active) {
			state.idle = Promise.withResolvers<void>();
			await state.idle.promise;
		}
		return await boundaryOwners.run(new Map(boundaryOwners.getStore()).set(ownerId, frozen), action);
	} finally {
		state.idle = undefined;
		state.frozen = undefined;
		frozen.resolve();
	}
}

/** Called on the real interpreter path, before user code; never replay user cells. */
export async function enterDeclaredStateKernel(
	ownerId: string,
	handle: KernelStateHandle,
	reset = false,
): Promise<void> {
	if (reset) discardDeclaredStateKernel(ownerId, handle.metadata, handle.namespace);
	const state = ownerState(ownerId);
	const metadataKey = key(handle.metadata);
	const identity = JSON.stringify([handle.namespace, metadataKey]);
	const previous = state.kernels.get(identity);
	let restore = state.pending.find(item => key(item) === metadataKey);
	if (
		!restore &&
		state.pending.some(item => item.language === handle.metadata.language && item.lane === handle.metadata.lane)
	)
		throw new Error("Declared state lane environment is incompatible; refusing a fresh kernel");
	if (previous && previous.generation !== handle.generation) {
		if (previous.dirty)
			throw new Error("Declared state was lost after its last boundary; refusing an older or fresh namespace");
		if (previous.captured != null) restore ??= { ...previous.metadata, snapshot: previous.captured };
	}
	if (restore) {
		await handle.request("restore", restore.snapshot);
		state.pending = state.pending.filter(item => item !== restore);
	}
	state.kernels.set(identity, { ...handle, captured: restore?.snapshot ?? previous?.captured, dirty: true });
}

/** Caller holds the owner boundary gate until its durable manifest commit finishes. */
export async function captureDeclaredState(ownerId: string): Promise<DeclaredKernelState[]> {
	const state = ownerState(ownerId);
	const result = structuredClone(state.pending);
	const captured = new Set(result.map(key));
	for (const tracked of state.kernels.values()) {
		let snapshot: unknown;
		if (!tracked.alive()) {
			if (tracked.dirty) throw new Error("Declared state kernel is unavailable before capture");
			snapshot = tracked.captured;
		} else snapshot = await tracked.request("capture");
		if (snapshot != null) {
			const identity = key(tracked.metadata);
			if (captured.has(identity))
				throw new Error(
					"Declared state has ambiguous physical namespace aliases for one language/lane/environment",
				);
			captured.add(identity);
			result.push({ ...tracked.metadata, snapshot });
		}
	}
	return result;
}

/** Only a successfully durable boundary makes a generation eligible for automatic residency release. */
export function commitDeclaredStateCapture(ownerId: string, kernels: readonly DeclaredKernelState[]): void {
	const state = ownerState(ownerId);
	const snapshots = new Map(kernels.map(kernel => [key(kernel), kernel.snapshot]));
	for (const tracked of state.kernels.values()) {
		tracked.captured = snapshots.get(key(tracked.metadata)) ?? null;
		tracked.dirty = false;
	}
}

export function stageDeclaredState(ownerId: string, kernels: DeclaredKernelState[]): void {
	const state = ownerState(ownerId);
	if (state.active) throw new Error("Cannot restore declared state while a cell is running");
	state.kernels.clear();
	state.pending = structuredClone(kernels);
	state.staged = true;
}

/** Runtime ownership ends only after interpreter teardown; durable manifests remain in session history. */
export function releaseDeclaredStateOwner(ownerId: string): void {
	const state = owners.get(ownerId);
	if (state && ownsBoundary(ownerId) && !state.active) {
		state.kernels.clear();
		state.pending = [];
		state.staged = false;
		return;
	}
	if (state?.active || state?.frozen)
		throw new Error("Cannot release declared state while its execution gate is active");
	owners.delete(ownerId);
}

/** Explicit reset/close is the user's existing request to discard this kernel, not temporal navigation. */
export function discardDeclaredStateKernel(
	ownerId: string,
	metadata: Omit<DeclaredKernelState, "snapshot">,
	namespace: string,
): void {
	const state = owners.get(ownerId);
	if (!state) return;
	const identity = key(metadata);
	for (const [physical, tracked] of state.kernels) {
		if (key(tracked.metadata) === identity && tracked.namespace === namespace) state.kernels.delete(physical);
	}
	state.pending = state.pending.filter(item => key(item) !== identity);
}

/** Residency may end only at a successfully captured, quiescent generation. Unknown/dirty state stays resident. */
export function isDeclaredStateKernelSafeToRelease(generation: string): boolean {
	let known = false;
	for (const state of owners.values()) {
		for (const tracked of state.kernels.values()) {
			if (tracked.generation !== generation) continue;
			known = true;
			if (tracked.dirty || (tracked.metadata.language === "python" && tracked.captured == null) || state.frozen)
				return false;
		}
	}
	return known;
}

export function hasDeclaredStateContinuity(ownerId: string): boolean {
	const state = owners.get(ownerId);
	return state !== undefined && (state.kernels.size > 0 || state.pending.length > 0 || state.staged === true);
}
