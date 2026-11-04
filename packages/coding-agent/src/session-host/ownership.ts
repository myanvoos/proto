import * as path from "node:path";
import { acquireFileLock, atomicWriteJson, type FileLockHandle, isEnoent, isRecord } from "@oh-my-pi/pi-utils";
import { canonicalProjectDir } from "../launch/paths";
import type { AgentSession } from "../session/agent-session";
import { readNodeTopology } from "../session/node-topology";
import { SessionManager } from "../session/session-manager";

const MAX_OWNERSHIP_BYTES = 4 * 1024 * 1024;

interface HostedRoot {
	sessionFile: string;
	nodeId: string;
	nodeGeneration: number;
}

interface HostOwnershipState {
	version: 1;
	hostId: string;
	name: string;
	socket: string;
	projectDir: string;
	initialSessionFile: string;
	generation: number;
	revision: number;
	ownerPid: number;
	active: HostedRoot;
	roots: HostedRoot[];
	restartArgv?: string[];
}

interface SessionHostReceipt {
	version: 1;
	hostId: string;
	name: string;
	socket: string;
	projectDir: string;
	sessionFile: string;
	nodeId: string;
	hostGeneration: number;
	committedRevision: number;
}

export interface ResolvedSessionHostOwnership {
	hostId: string;
	name: string;
	socket: string;
	projectDir: string;
	generation: number;
	revision: number;
	initialSessionFile: string;
	activeSessionFile: string;
	activeNodeId: string;
	requestedSessionFile: string;
	requestedNodeId: string;
}

function ownershipPath(socket: string): string {
	return `${socket}.ownership.json`;
}
export function sessionHostReceiptPath(sessionFile: string): string {
	return `${path.resolve(sessionFile)}.host.json`;
}

function isRoot(value: unknown): value is HostedRoot {
	return (
		isRecord(value) &&
		typeof value.sessionFile === "string" &&
		path.isAbsolute(value.sessionFile) &&
		typeof value.nodeId === "string" &&
		value.nodeId.length > 0 &&
		typeof value.nodeGeneration === "number" &&
		Number.isSafeInteger(value.nodeGeneration) &&
		value.nodeGeneration >= 0
	);
}

async function readJson(file: string): Promise<unknown | undefined> {
	const source = Bun.file(file);
	try {
		if (source.size > MAX_OWNERSHIP_BYTES) throw new Error(`Session-host ownership metadata is too large: ${file}`);
		return await source.json();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

async function readState(socket: string): Promise<HostOwnershipState | undefined> {
	const value = await readJson(ownershipPath(socket));
	if (value === undefined) return undefined;
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.hostId !== "string" ||
		typeof value.name !== "string" ||
		value.socket !== socket ||
		typeof value.projectDir !== "string" ||
		typeof value.initialSessionFile !== "string" ||
		typeof value.generation !== "number" ||
		!Number.isSafeInteger(value.generation) ||
		value.generation < 1 ||
		typeof value.revision !== "number" ||
		!Number.isSafeInteger(value.revision) ||
		value.revision < 0 ||
		typeof value.ownerPid !== "number" ||
		!Number.isSafeInteger(value.ownerPid) ||
		!isRoot(value.active) ||
		!Array.isArray(value.roots) ||
		!value.roots.every(isRoot) ||
		(value.restartArgv !== undefined &&
			(!Array.isArray(value.restartArgv) || !value.restartArgv.every(arg => typeof arg === "string")))
	)
		throw new Error(`Invalid session-host ownership state: ${ownershipPath(socket)}`);
	const active = value.active;
	if (
		!value.roots.some(root => root.sessionFile === active.sessionFile && root.nodeId === active.nodeId) ||
		new Set(value.roots.map(root => root.sessionFile)).size !== value.roots.length
	)
		throw new Error("Invalid session-host root membership");
	return value as unknown as HostOwnershipState;
}

/** A process-lifetime OS lease fences both socket replacement and every foreground commit. */
export class SessionHostOwnership {
	#state: HostOwnershipState;
	#closed = false;
	#tail = Promise.resolve();
	constructor(
		state: HostOwnershipState,
		readonly lease: FileLockHandle,
		readonly restoring = false,
	) {
		this.#state = state;
	}
	get activeSessionFile(): string {
		return this.#state.active.sessionFile;
	}
	get name(): string {
		return this.#state.name;
	}
	get socket(): string {
		return this.#state.socket;
	}
	get restartArgs(): readonly string[] | undefined {
		return this.#state.restartArgv?.slice();
	}
	get revision(): number {
		return this.#state.revision;
	}

	async #readOwnedState(): Promise<HostOwnershipState> {
		if (this.#closed) throw new Error("Session-host ownership lease is closed");
		const current = await readState(this.#state.socket);
		if (
			!current ||
			current.hostId !== this.#state.hostId ||
			current.generation !== this.#state.generation ||
			current.ownerPid !== process.pid
		)
			throw new Error("Session-host ownership generation was superseded");
		return current;
	}

	setRestartArgs(argv: readonly string[]): Promise<void> {
		const args = [...argv];
		const next = this.#tail.then(async () => {
			if (args.length > 4096 || args.some(arg => arg.includes("\0")) || !args.includes("--resume"))
				throw new Error("Invalid hosted restart arguments");
			const current = await this.#readOwnedState();
			const state: HostOwnershipState = { ...current, revision: current.revision + 1, restartArgv: args };
			if (Buffer.byteLength(JSON.stringify(state)) > MAX_OWNERSHIP_BYTES)
				throw new Error("Session-host restart argument capacity exceeded");
			await atomicWriteJson(ownershipPath(state.socket), state);
			this.#state = state;
		});
		this.#tail = next;
		return next;
	}

	commit(sessionFile: string, nodeId: string, nodeGeneration: number): Promise<void> {
		const next = this.#tail.then(async () => {
			if (!nodeId || nodeId === "Main" || !Number.isSafeInteger(nodeGeneration) || nodeGeneration < 0)
				throw new Error("Invalid foreground node identity/generation");
			const file = await canonicalProjectDir(sessionFile);
			const current = await this.#readOwnedState();
			const previousReceipt = await readJson(sessionHostReceiptPath(file));
			if (isRecord(previousReceipt) && previousReceipt.hostId !== current.hostId)
				throw new Error("Foreground session belongs to a different host; attach that owner explicitly");
			const active: HostedRoot = { sessionFile: file, nodeId, nodeGeneration };
			const state: HostOwnershipState = {
				...current,
				revision: current.revision + 1,
				active,
				roots: [...current.roots.filter(root => root.sessionFile !== file), active],
			};
			if (Buffer.byteLength(JSON.stringify(state)) > MAX_OWNERSHIP_BYTES)
				throw new Error("Session-host ownership metadata capacity exceeded");
			const receipt: SessionHostReceipt = {
				version: 1,
				hostId: state.hostId,
				name: state.name,
				socket: state.socket,
				projectDir: state.projectDir,
				sessionFile: file,
				nodeId,
				hostGeneration: state.generation,
				committedRevision: state.revision,
			};
			// Publish the locator first; the authoritative state is the commit record.
			await atomicWriteJson(sessionHostReceiptPath(file), receipt);
			await atomicWriteJson(ownershipPath(state.socket), state);
			this.#state = state;
		});
		this.#tail = next;
		return next;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		try {
			await this.#tail;
		} finally {
			this.#closed = true;
			this.lease.release();
			if (activeOwnership === this) activeOwnership = undefined;
		}
	}
}

export async function beginSessionHostOwnership(
	socket: string,
	projectDir: string,
	initialSessionFile: string,
): Promise<SessionHostOwnership> {
	const initial = await canonicalProjectDir(initialSessionFile);
	const project = await canonicalProjectDir(projectDir);
	const lease = await acquireFileLock(`${ownershipPath(socket)}.owner`);
	try {
		const previous = await readState(socket);
		if (previous && (previous.initialSessionFile !== initial || previous.projectDir !== project))
			throw new Error("Session-host ownership does not match its original launch identity");
		const initialManager = await SessionManager.openReadOnly(initial);
		let first: HostedRoot;
		try {
			first = {
				sessionFile: initial,
				nodeId: initialManager.getNodeTopology()?.id ?? initialManager.getSessionId(),
				nodeGeneration: initialManager.getNodeTopology()?.generation ?? 0,
			};
		} finally {
			await initialManager.close();
		}
		const state: HostOwnershipState = previous
			? { ...previous, generation: previous.generation + 1, ownerPid: process.pid }
			: {
					version: 1,
					hostId: crypto.randomUUID(),
					name: path.basename(socket, ".sock"),
					socket,
					projectDir: project,
					initialSessionFile: initial,
					generation: 1,
					revision: 0,
					ownerPid: process.pid,
					active: first,
					roots: [first],
				};
		if (!(await Bun.file(state.active.sessionFile).exists()))
			throw new Error(`Committed foreground session is missing: ${state.active.sessionFile}`);
		await atomicWriteJson(ownershipPath(socket), state);
		return new SessionHostOwnership(state, lease, previous !== undefined);
	} catch (error) {
		lease.release();
		throw error;
	}
}

let activeOwnership: SessionHostOwnership | undefined;
export function activateSessionHostOwnership(ownership: SessionHostOwnership): void {
	if (activeOwnership && activeOwnership !== ownership)
		throw new Error("A session-host owner is already active in this process");
	activeOwnership = ownership;
}

/** Called once the actual extension flag schema is known, before constructing the runtime/serving requests. */
export async function commitHostedRestartArgs(argv: readonly string[]): Promise<void> {
	await activeOwnership?.setRestartArgs(argv);
}

/** Called at initial activation and every canonical foreground-session adoption, before acknowledgement. */
export async function commitHostedForeground(session: AgentSession): Promise<void> {
	if (!activeOwnership) return;
	const manager = session.sessionManager;
	const file = manager.getSessionFile();
	const topology = manager.getNodeTopology();
	if (!file || !topology || topology.parentId) throw new Error("Hosted foreground must be a durable independent root");
	await manager.ensureOnDisk();
	await manager.flush();
	await activeOwnership.commit(file, topology.id, topology.generation);
}

/** A locator is usable only when the authoritative host generation committed this root's membership. */
export async function resolveSessionHostOwnership(
	sessionFile: string,
	visited = new Set<string>(),
): Promise<ResolvedSessionHostOwnership | undefined> {
	const file = await canonicalProjectDir(sessionFile);
	if (visited.has(file)) throw new Error("Cycle in session-host root ownership metadata");
	visited.add(file);
	const receipt = await readJson(sessionHostReceiptPath(file));
	if (receipt === undefined) {
		if (!(await Bun.file(file).exists())) return undefined;
		const topology = await readNodeTopology(file);
		if (!topology?.parentId || !topology.rootSessionFile || topology.rootSessionFile === file) return undefined;
		const root = await resolveSessionHostOwnership(topology.rootSessionFile, visited);
		return root ? { ...root, requestedSessionFile: file, requestedNodeId: topology.id } : undefined;
	}
	if (
		!isRecord(receipt) ||
		receipt.version !== 1 ||
		typeof receipt.hostId !== "string" ||
		typeof receipt.name !== "string" ||
		typeof receipt.socket !== "string" ||
		typeof receipt.projectDir !== "string" ||
		receipt.sessionFile !== file ||
		typeof receipt.nodeId !== "string" ||
		typeof receipt.hostGeneration !== "number" ||
		!Number.isSafeInteger(receipt.hostGeneration) ||
		receipt.hostGeneration < 1 ||
		typeof receipt.committedRevision !== "number" ||
		!Number.isSafeInteger(receipt.committedRevision) ||
		receipt.committedRevision < 0
	)
		throw new Error(`Invalid session-host receipt: ${sessionHostReceiptPath(file)}`);
	const state = await readState(receipt.socket);
	if (
		!state ||
		state.hostId !== receipt.hostId ||
		state.name !== receipt.name ||
		state.projectDir !== receipt.projectDir ||
		state.generation < receipt.hostGeneration
	)
		throw new Error("Session-host receipt belongs to an unavailable ownership generation");
	const root = state.roots.find(root => root.sessionFile === file && root.nodeId === receipt.nodeId);
	if (!root || receipt.committedRevision > state.revision) {
		if (receipt.hostGeneration < state.generation && !root) return undefined;
		throw new Error("Session-host foreground handoff has not committed");
	}
	return {
		hostId: state.hostId,
		name: state.name,
		socket: state.socket,
		projectDir: state.projectDir,
		generation: state.generation,
		revision: state.revision,
		initialSessionFile: state.initialSessionFile,
		activeSessionFile: state.active.sessionFile,
		activeNodeId: state.active.nodeId,
		requestedSessionFile: file,
		requestedNodeId: root.nodeId,
	};
}
