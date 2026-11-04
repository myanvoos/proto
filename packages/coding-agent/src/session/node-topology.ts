import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteJson, isEnoent } from "@oh-my-pi/pi-utils";
import type { SessionHeader, SessionNodeTopology } from "./session-entries";
import { visitEntriesFromFileStream } from "./session-loader";

export interface SessionNodeTemporalTransition {
	version: 1;
	sourceNodeId: string;
	sourceGeneration: number;
	boundaryEntryId: string | null;
	abandoned: Array<{ sessionFile: string; nodeId: string; generation: number }>;
}

export async function readNodeTemporalTransition(
	sessionFile: string,
): Promise<SessionNodeTemporalTransition | undefined> {
	try {
		return (await Bun.file(`${sessionFile}.temporal.json`).json()) as SessionNodeTemporalTransition;
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

/** Legacy import receipts are adjacent to history; history paths and payloads never move. */
function receiptPath(sessionFile: string): string {
	return `${sessionFile}.node.json`;
}

export function readNodeTopology(sessionFile: string): Promise<SessionNodeTopology | undefined> {
	return readEffectiveNodeTopology(path.resolve(sessionFile), new Set());
}

async function readEffectiveNodeTopology(
	sessionFile: string,
	ancestors: Set<string>,
): Promise<SessionNodeTopology | undefined> {
	if (ancestors.has(sessionFile)) throw new Error(`Cycle in persisted node ownership: ${sessionFile}`);
	ancestors.add(sessionFile);
	let header: SessionHeader | undefined;
	await visitEntriesFromFileStream(
		sessionFile,
		entry => {
			if (entry.type === "session") header = entry;
		},
		{ maxRecords: 2 },
	);
	let node = header?.node;
	if (!node) {
		try {
			node = (await Bun.file(receiptPath(sessionFile)).json()) as SessionNodeTopology;
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	if (!node) return undefined;
	if (
		!node.id ||
		!node.rootId ||
		node.id === "Main" ||
		node.rootId === "Main" ||
		node.parentId === "Main" ||
		!Number.isSafeInteger(node.generation) ||
		node.generation < 0 ||
		!["active", "abandoned", "stopped"].includes(node.state)
	)
		throw new Error(`Invalid durable node metadata: ${sessionFile}`);
	if (!node.parentId && node.rootId !== node.id) throw new Error(`Missing node parent: ${node.id}`);
	if (node.parentId && node.rootSessionFile && !node.parentSessionFile)
		throw new Error(`Missing parent session path: ${node.id}`);
	try {
		await fs.access(`${sessionFile}.tombstone`);
		node = { ...node, state: "stopped" };
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	if (node.parentSessionFile) {
		const nodeId = node.id;
		const parentFile = path.resolve(node.parentSessionFile);
		try {
			const transition = await readNodeTemporalTransition(parentFile);
			if (transition && (transition.version !== 1 || transition.sourceNodeId !== node.parentId))
				throw new Error(`Invalid temporal ownership journal: ${parentFile}`);
			const abandoned = transition?.abandoned.find(child => child.nodeId === nodeId);
			if (abandoned && node.state !== "stopped")
				node = { ...node, state: "abandoned", generation: Math.max(node.generation, abandoned.generation) };
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		const parent = await readEffectiveNodeTopology(parentFile, ancestors);
		if (!parent || parent.id !== node.parentId || parent.rootId !== node.rootId)
			throw new Error(`Missing or inconsistent node parent: ${node.id}`);
		if (parent.state !== "active" && node.state !== "stopped")
			node = { ...node, state: parent.state, generation: Math.max(node.generation, parent.generation) };
	}
	return node;
}

export async function persistNodeTopologyReceipt(sessionFile: string, node: SessionNodeTopology): Promise<void> {
	await atomicWriteJson(receiptPath(sessionFile), node);
}

/** Only the legacy importer consults layout; all subsequent reads use explicit ownership. */
export async function importLegacyNodeTopology(sessionFile: string): Promise<SessionNodeTopology> {
	const chain: Array<{ file: string; id: string }> = [];
	let current = path.resolve(sessionFile);
	let parent: SessionNodeTopology | undefined;
	for (;;) {
		parent = await readNodeTopology(current);
		if (parent) break;
		let header: SessionHeader | undefined;
		await visitEntriesFromFileStream(
			current,
			entry => {
				if (entry.type === "session") header = entry;
			},
			{ maxRecords: 2 },
		);
		if (!header) throw new Error(`Missing session header: ${current}`);
		const candidate = `${path.dirname(current)}.jsonl`;
		let hasParent = false;
		try {
			hasParent = (await fs.stat(candidate)).isFile();
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		chain.push({ file: current, id: hasParent ? path.basename(current, ".jsonl") : header.id });
		if (!hasParent) break;
		current = candidate;
	}
	for (const item of chain.reverse()) {
		let spawnAnchorId: string | undefined;
		if (parent) {
			await visitEntriesFromFileStream(current, entry => {
				if (entry.type !== "custom" || entry.customType !== "orchestrator-worker-lifecycle") return;
				const data = entry.data as { action?: string; id?: string; parentSessionId?: string } | undefined;
				if (data?.action === "spawn" && data.id === item.id) spawnAnchorId = entry.id;
			});
		}
		const node: SessionNodeTopology = {
			id: item.id,
			rootId: parent?.rootId ?? item.id,
			parentId: parent?.id,
			parentSessionFile: parent ? current : undefined,
			rootSessionFile: parent?.rootSessionFile ?? item.file,
			spawnAnchorId,
			generation: parent?.generation ?? 0,
			state: parent?.state ?? "active",
		};
		await persistNodeTopologyReceipt(item.file, node);
		parent = (await readNodeTopology(item.file)) ?? node;
		current = item.file;
	}
	if (!parent) throw new Error(`Cannot import session topology: ${sessionFile}`);
	return parent;
}

export interface DurableSessionNode {
	topology: SessionNodeTopology;
	sessionFile: string;
}

/** Rebuild the address index before publishing any rows to runtime consumers. */
export async function rebuildNodeIndex(rootSessionFile: string): Promise<ReadonlyMap<string, DurableSessionNode>> {
	const root = await importLegacyNodeTopology(rootSessionFile);
	const nodes: DurableSessionNode[] = [{ topology: root, sessionFile: path.resolve(rootSessionFile) }];
	const directories = [rootSessionFile.slice(0, -6)];
	for (const directory of directories) {
		let entries: Array<{ name: string; isFile(): boolean }>;
		try {
			entries = await fs.readdir(directory, { withFileTypes: true });
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}
		for (const entry of entries) {
			if (
				!entry.isFile() ||
				!entry.name.endsWith(".jsonl") ||
				entry.name.includes(".bak") ||
				entry.name.startsWith("__advisor")
			)
				continue;
			const stem = entry.name.slice(0, -6);
			if (!stem || stem === "." || stem === "..") continue;
			const sessionFile = path.resolve(directory, entry.name);
			const topology = await importLegacyNodeTopology(sessionFile);
			if (topology.rootId !== root.rootId) continue;
			nodes.push({ topology, sessionFile });
			directories.push(sessionFile.slice(0, -6));
		}
	}
	validateNodeTopology(nodes.map(node => node.topology));
	return new Map(nodes.map(node => [node.topology.id, node]));
}

export function validateNodeTopology(nodes: readonly SessionNodeTopology[]): void {
	const byId = new Map<string, SessionNodeTopology>();
	for (const node of nodes) {
		if (!node.id || !node.rootId || node.id === "Main" || node.parentId === "Main" || node.rootId === "Main")
			throw new Error("Invalid node identity");
		if (byId.has(node.id)) throw new Error(`Duplicate node identity: ${node.id}`);
		if (!Number.isSafeInteger(node.generation) || node.generation < 0)
			throw new Error(`Invalid node generation: ${node.id}`);
		byId.set(node.id, node);
	}
	for (const node of nodes) {
		const seen = new Set<string>();
		let current: SessionNodeTopology | undefined = node;
		while (current) {
			if (seen.has(current.id)) throw new Error(`Cycle in node ownership: ${current.id}`);
			seen.add(current.id);
			if (current.rootId !== node.rootId) throw new Error(`Inconsistent node root: ${node.id}`);
			if (current.id !== node.id && current.state === "stopped" && node.state === "active")
				throw new Error(`Live descendant of stopped node: ${node.id}`);
			if (!current.parentId) {
				if (current.id !== node.rootId) throw new Error(`Missing node root: ${node.rootId}`);
				break;
			}
			const parent: SessionNodeTopology | undefined = byId.get(current.parentId);
			if (!parent) throw new Error(`Missing node parent: ${current.parentId}`);
			current = parent;
		}
	}
}
