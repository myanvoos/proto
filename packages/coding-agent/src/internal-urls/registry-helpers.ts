import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { AgentRegistry } from "../registry/agent-registry";

const TRANSCRIPT_INDEX_FILE = ".proto-history-index.json";
const TRANSCRIPT_INDEX_VERSION = 1;

interface PersistedTranscriptIndex {
	version: typeof TRANSCRIPT_INDEX_VERSION;
	files: Record<string, string>;
}

const extraArtifactsDirs = new Set<string>();
const transcriptIndexes = new Map<string, Promise<Map<string, string>>>();
const transcriptLookups = new WeakMap<Map<string, string>, Map<string, string>>();
const transcriptIndexWriteTails = new Map<string, Promise<void>>();

export function registerArtifactsDir(dir: string): () => void {
	const normalized = path.resolve(dir);
	extraArtifactsDirs.add(normalized);
	return () => {
		extraArtifactsDirs.delete(normalized);
	};
}

export function artifactsDirsFromRegistry(): string[] {
	const dirs = new Set<string>();
	const addDir = (dir: string | null | undefined) => {
		if (dir) dirs.add(path.resolve(dir));
	};
	for (const ref of AgentRegistry.global().list()) {
		addDir(ref.session?.sessionManager?.getArtifactsDir());
		if (ref.sessionFile) addDir(ref.sessionFile.slice(0, -6));
	}
	for (const dir of extraArtifactsDirs) addDir(dir);

	const roots: string[] = [];
	for (const candidate of [...dirs].sort((a, b) => a.length - b.length)) {
		if (roots.some(root => isWithinRoot(root, candidate))) continue;
		roots.push(candidate);
	}
	return roots;
}

function isWithinRoot(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function indexPath(root: string): string {
	return path.join(root, TRANSCRIPT_INDEX_FILE);
}

function validIndexedPath(root: string, id: string, relative: unknown): string | undefined {
	if (typeof relative !== "string" || path.isAbsolute(relative)) return undefined;
	const file = path.resolve(root, relative);
	if (!isWithinRoot(root, file) || path.basename(file) !== `${id}.jsonl`) return undefined;
	return file;
}

async function readPersistedIndex(root: string): Promise<Map<string, string> | undefined> {
	try {
		const parsed = (await Bun.file(indexPath(root)).json()) as Partial<PersistedTranscriptIndex>;
		if (parsed.version !== TRANSCRIPT_INDEX_VERSION || !parsed.files || typeof parsed.files !== "object") {
			return undefined;
		}
		const files = new Map<string, string>();
		for (const [id, relative] of Object.entries(parsed.files)) {
			const file = validIndexedPath(root, id, relative);
			if (file) files.set(id, file);
		}
		return files;
	} catch (error) {
		if (isEnoent(error)) return undefined;
		logger.debug("Transcript index read failed; rebuilding", { root, error: String(error) });
		return undefined;
	}
}

async function writePersistedIndex(root: string, files: ReadonlyMap<string, string>): Promise<void> {
	const previous = transcriptIndexWriteTails.get(root) ?? Promise.resolve();
	const pending = previous
		.catch(() => {})
		.then(async () => {
			const relativeFiles: Record<string, string> = {};
			for (const [id, file] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
				if (isWithinRoot(root, file)) relativeFiles[id] = path.relative(root, file);
			}
			const target = indexPath(root);
			const temporary = `${target}.${process.pid}.tmp`;
			try {
				await Bun.write(
					temporary,
					`${JSON.stringify({ version: TRANSCRIPT_INDEX_VERSION, files: relativeFiles } satisfies PersistedTranscriptIndex)}\n`,
				);
				await fs.rename(temporary, target);
			} catch (error) {
				await fs.rm(temporary, { force: true }).catch(() => {});
				logger.debug("Transcript index write failed", { root, error: String(error) });
			}
		});
	transcriptIndexWriteTails.set(root, pending);
	await pending;
	if (transcriptIndexWriteTails.get(root) === pending) transcriptIndexWriteTails.delete(root);
}

async function scanRoot(root: string): Promise<Map<string, string>> {
	const found = new Map<string, string>();
	const seenDirs = new Set<string>();
	const pending = [root];
	while (pending.length > 0) {
		const dir = pending.pop()!;
		let realDir: string;
		try {
			realDir = await fs.realpath(dir);
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}
		if (!isWithinRoot(root, realDir) || seenDirs.has(realDir)) continue;
		seenDirs.add(realDir);
		let entries: Dirent[];
		try {
			entries = await fs.readdir(realDir, { withFileTypes: true });
		} catch (error) {
			if (isEnoent(error) || (error as NodeJS.ErrnoException).code === "ENOTDIR") continue;
			throw error;
		}
		for (const entry of entries) {
			const child = path.join(realDir, entry.name);
			if (entry.isDirectory()) {
				pending.push(child);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name.startsWith("__advisor")) continue;
			const id = entry.name.slice(0, -".jsonl".length);
			if (!found.has(id)) found.set(id, child);
		}
	}
	await writePersistedIndex(root, found);
	return found;
}

function lowercaseLookup(files: Map<string, string>): Map<string, string> {
	let lookup = transcriptLookups.get(files);
	if (!lookup) {
		lookup = new Map([...files].map(([id, file]) => [id.toLowerCase(), file]));
		transcriptLookups.set(files, lookup);
	}
	return lookup;
}

function indexForRoot(root: string): Promise<Map<string, string>> {
	let pending = transcriptIndexes.get(root);
	if (!pending) {
		pending = readPersistedIndex(root).then(index => index ?? scanRoot(root));
		transcriptIndexes.set(root, pending);
	}
	return pending;
}

export async function registerSessionFile(agentId: string, sessionFile: string): Promise<void> {
	const file = path.resolve(sessionFile);
	const root = artifactsDirsFromRegistry().find(candidate => isWithinRoot(candidate, file)) ?? path.dirname(file);
	try {
		const files = await indexForRoot(root);
		files.set(agentId, file);
		lowercaseLookup(files).set(agentId.toLowerCase(), file);
		await writePersistedIndex(root, files);
	} catch (error) {
		logger.debug("Transcript index registration failed", { agentId, file, error: String(error) });
	}
}

async function removeStaleIndexedFile(root: string, id: string, files: Map<string, string>): Promise<void> {
	files.delete(id);
	lowercaseLookup(files).delete(id.toLowerCase());
	await writePersistedIndex(root, files);
}

export async function findSessionFileFromDisk(agentId: string): Promise<string | undefined> {
	const lower = agentId.toLowerCase();
	for (const root of artifactsDirsFromRegistry()) {
		const files = await indexForRoot(root);
		const exact = files.get(agentId);
		const file = exact ?? lowercaseLookup(files).get(lower);
		if (!file) continue;
		if (await isReadableFile(file)) return file;
		const matchedId = exact ? agentId : [...files].find(([, candidate]) => candidate === file)?.[0];
		if (matchedId) await removeStaleIndexedFile(root, matchedId, files);
	}
	return undefined;
}

export async function sessionFilesFromDisk(): Promise<Map<string, string>> {
	const found = new Map<string, string>();
	for (const root of artifactsDirsFromRegistry()) {
		for (const [id, file] of await indexForRoot(root)) {
			if (!found.has(id)) found.set(id, file);
		}
	}
	return found;
}

export async function hasResolvableTranscript(agentId: string): Promise<boolean> {
	try {
		const registry = AgentRegistry.global();
		const lower = agentId.toLowerCase();
		let ref = registry.get(agentId);
		if (ref?.kind === "advisor") ref = undefined;
		ref ??= registry.list().find(candidate => candidate.kind !== "advisor" && candidate.id.toLowerCase() === lower);
		if (ref?.session) return true;
		if (ref?.sessionFile && (await isReadableFile(ref.sessionFile))) return true;
		return (await findSessionFileFromDisk(agentId)) !== undefined;
	} catch {
		return false;
	}
}

async function isReadableFile(file: string): Promise<boolean> {
	try {
		const stat = await fs.stat(file);
		return stat.isFile();
	} catch {
		return false;
	}
}
