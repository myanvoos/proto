import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { readLines } from "@oh-my-pi/pi-utils";
import type { AgentRef } from "../registry/agent-registry";
import { AgentRegistry } from "../registry/agent-registry";
import { buildSessionContext } from "../session/session-context";
import type { FileEntry, SessionEntry, SessionHeader } from "../session/session-entries";
import { formatSessionHistoryMarkdown } from "../session/session-history-format";
import { migrateToCurrentVersion } from "../session/session-migrations";
import { findSessionFileFromDisk, sessionFilesFromDisk } from "./registry-helpers";
import type { InternalResource, InternalUrl, ProtocolHandler, UrlCompletion } from "./types";

function formatAgo(timestamp: number): string {
	const diffMs = Math.max(0, Date.now() - timestamp);
	const secs = Math.floor(diffMs / 1000);
	if (secs < 60) return `${secs}s ago`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

interface IndexEntry {
	id: string;
	label: string;
	status: string;
	kind: string;
	parent: string;
	lastActivity: string;
}

const HISTORY_ENTRY_LIMIT = 2_000;
const HISTORY_BYTE_LIMIT = 8 * 1024 * 1024;

interface LoadedHistory {
	messages: AgentMessage[];
	truncated: boolean;
	retainedEntries: number;
	totalEntries: number;
}

async function loadBoundedSessionHistory(file: string): Promise<LoadedHistory> {
	let header: SessionHeader | undefined;
	let totalEntries = 0;
	let retainedBytes = 0;
	const retained: Array<{ line: Uint8Array; bytes: number }> = [];
	const decoder = new TextDecoder();
	for await (const line of readLines(Bun.file(file).stream())) {
		if (line.byteLength === 0) continue;
		if (!header) {
			try {
				const candidate = JSON.parse(decoder.decode(line)) as FileEntry;
				if (candidate.type === "session") {
					header = candidate;
					continue;
				}
			} catch {
				// A title slot may precede the JSONL header.
			}
		}
		totalEntries++;
		const bytes = line.byteLength;
		if (bytes > HISTORY_BYTE_LIMIT) continue;
		retained.push({ line: line.slice(), bytes });
		retainedBytes += bytes;
		while (retained.length > HISTORY_ENTRY_LIMIT || retainedBytes > HISTORY_BYTE_LIMIT) {
			retainedBytes -= retained.shift()!.bytes;
		}
	}
	const entries: FileEntry[] = header ? [header] : [];
	for (const { line } of retained) {
		try {
			entries.push(JSON.parse(decoder.decode(line)) as FileEntry);
		} catch {
			// Read-only history tolerates malformed journal records just like the session loader.
		}
	}
	migrateToCurrentVersion(entries);
	const sessionEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
	const messages = buildSessionContext(sessionEntries, undefined, undefined, {
		transcript: true,
		collapseCompactedHistory: true,
	}).messages;
	return {
		messages,
		truncated: retained.length < totalEntries,
		retainedEntries: retained.length,
		totalEntries,
	};
}

export class HistoryProtocolHandler implements ProtocolHandler {
	readonly scheme = "history";
	readonly immutable = false;

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const agentId = url.rawHost || url.hostname;
		const registry = AgentRegistry.global();

		const visible = registry.list().filter(ref => ref.kind !== "advisor");

		if (!agentId) {
			const content = await this.#renderIndex(visible);
			return {
				url: url.href,
				content,
				contentType: "text/markdown",
				size: Buffer.byteLength(content, "utf-8"),
			};
		}

		let ref = registry.get(agentId);
		if (ref?.kind === "advisor") ref = undefined;
		if (!ref) {
			const lower = agentId.toLowerCase();
			ref = visible.find(candidate => candidate.id.toLowerCase() === lower);
		}

		if (!ref) {
			const disk = await this.#resolveFromDisk(agentId);
			if (disk) return { ...disk, url: url.href };

			const known = visible.map(candidate => candidate.id);
			const knownStr = known.length > 0 ? known.join(", ") : "none";
			throw new Error(`Unknown agent: ${agentId}\nKnown agents: ${knownStr}\nList all with history://`);
		}

		const notes: string[] = [];
		let messages: AgentMessage[];
		if (ref.session) {
			messages = ref.session.messages;
			notes.push("Source: live session");
		} else if (ref.sessionFile) {
			const loaded = await loadBoundedSessionHistory(ref.sessionFile);
			messages = loaded.messages;
			notes.push(`Source: session file (read-only, ${ref.status})`);
			if (loaded.truncated) {
				notes.push(
					`Transcript bounded to the latest ${loaded.retainedEntries} of ${loaded.totalEntries} entries; use the session file for the complete journal.`,
				);
			}
		} else {
			const disk = await this.#resolveFromDisk(ref.id);
			if (disk) return { ...disk, url: url.href };
			throw new Error(`Agent ${ref.id} has no transcript: session is gone and no session file was retained`);
		}

		const content = formatSessionHistoryMarkdown(messages, { title: `${ref.id} (${ref.status})` });
		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: ref.sessionFile ?? undefined,
			notes,
		};
	}

	async #resolveFromDisk(agentId: string): Promise<InternalResource | undefined> {
		const sessionFile = await findSessionFileFromDisk(agentId);
		if (!sessionFile) return undefined;
		const matchedId = sessionFile.slice(sessionFile.lastIndexOf("/") + 1, -".jsonl".length);
		const loaded = await loadBoundedSessionHistory(sessionFile);
		const content = formatSessionHistoryMarkdown(loaded.messages, { title: `${matchedId} (on disk)` });
		return {
			url: "",
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: sessionFile,
			notes: [
				"Source: session file (read-only, unregistered)",
				...(loaded.truncated
					? [
							`Transcript bounded to the latest ${loaded.retainedEntries} of ${loaded.totalEntries} entries; use the session file for the complete journal.`,
						]
					: []),
			],
		};
	}

	async #renderIndex(refs: AgentRef[]): Promise<string> {
		const entries: IndexEntry[] = refs.map(ref => ({
			id: ref.id,
			label: ref.label ?? "—",
			status: ref.status,
			kind: ref.kind,
			parent: ref.parentId ?? "—",
			lastActivity: formatAgo(ref.lastActivity),
		}));

		const registered = new Set(refs.map(ref => ref.id));
		const disk = await sessionFilesFromDisk();
		for (const id of disk.keys()) {
			if (registered.has(id)) continue;
			entries.push({ id, label: "—", status: "on disk", kind: "—", parent: "—", lastActivity: "—" });
		}

		const lines: string[] = ["# Agents", ""];
		if (entries.length === 0) {
			lines.push("No agents registered.");
			return `${lines.join("\n")}\n`;
		}
		lines.push("| id | label | status | kind | parent | last activity |", "|---|---|---|---|---|---|");
		for (const entry of entries) {
			lines.push(
				`| ${entry.id} | ${entry.label} | ${entry.status} | ${entry.kind} | ${entry.parent} | ${entry.lastActivity} |`,
			);
		}
		lines.push("", "Read a transcript with `read history://<id>`.");
		return `${lines.join("\n")}\n`;
	}

	async complete(): Promise<UrlCompletion[]> {
		const completions: UrlCompletion[] = [];
		const seen = new Set<string>();
		for (const ref of AgentRegistry.global().list()) {
			if (ref.kind === "advisor") continue;
			seen.add(ref.id);
			completions.push({
				value: ref.id,
				description: `${ref.label ? `${ref.label} · ` : ""}${ref.status} · ${ref.kind}${ref.parentId ? ` · parent ${ref.parentId}` : ""}`,
			});
		}
		const disk = await sessionFilesFromDisk();
		for (const id of disk.keys()) {
			if (seen.has(id)) continue;
			seen.add(id);
			completions.push({ value: id, description: "on disk" });
		}
		return completions;
	}
}
