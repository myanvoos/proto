import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { fuzzyFilter } from "@oh-my-pi/pi-tui/fuzzy";
import { formatDuration, isEnoent, prompt } from "@oh-my-pi/pi-utils";
import agentProgressTemplate from "../prompts/tools/agent-url-progress.md" with { type: "text" };
import agentSupersededTemplate from "../prompts/tools/agent-url-superseded.md" with { type: "text" };
import { type AgentRef, AgentRegistry } from "../registry/agent-registry";
import { loadSessionMessagesReadOnly } from "../session/session-loader";
import { applyQuery, pathToQuery } from "./json-query";
import { artifactsDirsFromRegistry, findSessionFileFromDisk } from "./registry-helpers";
import type { InternalResource, InternalUrl, ProtocolHandler, UrlCompletion } from "./types";

const MAX_ID_SUGGESTIONS = 5;

/** A long or resumed process has thousands of candidate ids; only the closest few are worth naming. */
function notFoundError(outputId: string, candidates: Iterable<string>): Error {
	const unique = [...new Set(candidates)].filter(id => id !== outputId);
	const suggestions = fuzzyFilter(unique, outputId, id => id).slice(0, MAX_ID_SUGGESTIONS);
	const hint = suggestions.length > 0 ? `Did you mean: ${suggestions.join(", ")}` : "List agents with history://";
	return new Error(`Not found: ${outputId}\n${hint}`);
}

interface YieldSection {
	labels?: string;
	data: string;
}

/** Accepted `yield` results in transcript order; errors and aborts are skipped. */
function yieldSections(messages: readonly AgentMessage[]): YieldSection[] {
	const sections: YieldSection[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult" || message.toolName !== "yield" || message.isError) continue;
		const details = message.details as { data?: unknown; status?: unknown; type?: unknown } | undefined;
		if (details?.status !== "success" || details.data === undefined) continue;
		const labels = Array.isArray(details.type) ? details.type.join(", ") : details.type;
		let data: string;
		try {
			data = JSON.stringify(details.data, null, 2) ?? "null";
		} catch {
			data = String(details.data);
		}
		sections.push({ labels: typeof labels === "string" && labels ? labels : undefined, data });
	}
	return sections;
}

function lastAssistantText(messages: readonly AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role !== "assistant") continue;
		const text = message.content
			.flatMap(block => (block.type === "text" ? [block.text] : []))
			.join("\n")
			.trim();
		if (text) return text;
	}
	return undefined;
}

function visibleRef(registry: AgentRegistry, id: string | undefined): AgentRef | undefined {
	const ref = id ? registry.get(id) : undefined;
	return ref && ref.kind !== "advisor" ? ref : undefined;
}

export class AgentProtocolHandler implements ProtocolHandler {
	readonly scheme = "agent";
	readonly immutable = true;

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const outputId = url.rawHost || url.hostname;
		if (!outputId) {
			throw new Error("agent:// URL requires an output ID: agent://<id>");
		}

		const urlPath = url.pathname;
		const queryParam = url.searchParams.get("q");
		const hasPathExtraction = urlPath && urlPath !== "/" && urlPath !== "";
		const hasQueryExtraction = queryParam !== null && queryParam !== "";

		if (hasPathExtraction && hasQueryExtraction) {
			throw new Error("agent:// URL cannot combine path extraction with ?q=");
		}

		const dirs = artifactsDirsFromRegistry();
		const registry = AgentRegistry.global();

		const pathSegments = hasPathExtraction ? urlPath.split("/").filter(Boolean) : [];
		const decodedSegments = pathSegments.map(segment => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
		});
		const nestedId =
			decodedSegments.length > 0 && decodedSegments.every(segment => !segment.includes("."))
				? [outputId, ...decodedSegments].join(".")
				: undefined;

		const scan =
			dirs.length > 0 ? await this.#findOutput(dirs, nestedId ? [nestedId, outputId] : [outputId]) : undefined;
		if (!scan?.foundPath) {
			// No published output yet: a registered agent (running, or idle after non-terminal yields) answers with its progress.
			const nestedRef = visibleRef(registry, nestedId);
			const ref = nestedRef ?? visibleRef(registry, outputId);
			if (ref)
				return this.#resolveProgress(url, ref, hasQueryExtraction || (Boolean(hasPathExtraction) && !nestedRef));
			if (!scan) throw new Error("No session - agent outputs unavailable");
			if (!scan.anyDirExists) throw new Error("No artifacts directory found");
			const registered = registry
				.list()
				.filter(candidate => candidate.kind !== "advisor")
				.map(candidate => candidate.id);
			throw notFoundError(nestedId ?? outputId, [...scan.availableIds, ...registered]);
		}

		const rawContent = await Bun.file(scan.foundPath).text();
		const notes: string[] = [];
		let content = rawContent;
		let contentType: InternalResource["contentType"] = "text/markdown";

		const extract = hasQueryExtraction || (hasPathExtraction && scan.matchedId !== nestedId);
		// A published file belongs to a finished run; while the agent streams a newer turn it is stale.
		if (!extract && visibleRef(registry, scan.matchedId)?.status === "running") {
			const publishedAt = (await fs.stat(scan.foundPath)).mtimeMs;
			content = `${prompt.render(agentSupersededTemplate, {
				id: scan.matchedId,
				age: formatDuration(Math.max(0, Date.now() - publishedAt)),
			})}${rawContent}`;
			notes.push(`Superseded: ${scan.matchedId} is running a newer turn`);
		}
		if (extract) {
			let jsonValue: unknown;
			try {
				jsonValue = JSON.parse(rawContent);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(`Output ${scan.matchedId} is not valid JSON: ${message}`);
			}

			const query = hasQueryExtraction ? queryParam! : pathToQuery(urlPath);
			if (query) {
				const extracted = applyQuery(jsonValue, query);
				try {
					content = JSON.stringify(extracted, null, 2) ?? "null";
				} catch {
					content = String(extracted);
				}
				notes.push(`Extracted: ${query}`);
			} else {
				content = JSON.stringify(jsonValue, null, 2);
			}
			contentType = "application/json";
		}

		return {
			url: url.href,
			content,
			contentType,
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: scan.foundPath,
			notes,
		};
	}

	/** Status, accepted `yield` sections, and latest assistant text of a registered agent with no published output. */
	async #resolveProgress(url: InternalUrl, ref: AgentRef, extraction: boolean): Promise<InternalResource> {
		if (extraction) {
			throw new Error(
				`Output ${ref.id} is not published yet (status: ${ref.status}); read agent://${ref.id} for its progress.`,
			);
		}
		let messages: readonly AgentMessage[] = [];
		let source = "no transcript";
		if (ref.session) {
			messages = ref.session.messages;
			source = "live session";
		} else if (ref.sessionFile) {
			messages = await loadSessionMessagesReadOnly(ref.sessionFile);
			source = "session file (read-only)";
		}
		const sections = yieldSections(messages);
		const lastText = lastAssistantText(messages);
		const content = `${prompt.render(agentProgressTemplate, {
			id: ref.id,
			status: ref.status,
			sections,
			lastText,
			empty: sections.length === 0 && !lastText,
		})}\n`;
		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			notes: [`No published output; progress from ${source} (${ref.status})`],
		};
	}

	async #findOutput(
		dirs: string[],
		candidateIds: string[],
	): Promise<{ foundPath?: string; matchedId?: string; anyDirExists: boolean; availableIds: Set<string> }> {
		const byId = new Map<string, string>();
		let anyDirExists = false;
		for (const dir of dirs) {
			let files: string[];
			try {
				files = await fs.readdir(dir);
			} catch (err) {
				if (isEnoent(err)) continue;
				throw err;
			}
			anyDirExists = true;
			for (const f of files) {
				if (!f.endsWith(".md")) continue;
				const id = f.slice(0, -3);
				if (!byId.has(id)) byId.set(id, path.join(dir, f));
			}
		}
		for (const id of candidateIds) {
			let foundPath = byId.get(id);
			if (!foundPath) {
				// Registry roots collapse nested worker artifact directories. The
				// persisted transcript index still locates outputs beside those sessions.
				const sessionFile = await findSessionFileFromDisk(id);
				if (sessionFile) {
					const outputPath = `${sessionFile.slice(0, -".jsonl".length)}.md`;
					if (await Bun.file(outputPath).exists()) foundPath = outputPath;
				}
			}
			if (foundPath) {
				return { foundPath, matchedId: id, anyDirExists, availableIds: new Set(byId.keys()) };
			}
		}
		return { anyDirExists, availableIds: new Set(byId.keys()) };
	}

	async complete(): Promise<UrlCompletion[]> {
		const ids = new Set<string>();
		for (const dir of artifactsDirsFromRegistry()) {
			let files: string[];
			try {
				files = await fs.readdir(dir);
			} catch (err) {
				if (isEnoent(err)) continue;
				throw err;
			}
			for (const f of files) {
				if (f.endsWith(".md")) ids.add(f.slice(0, -3));
			}
		}
		return [...ids].sort().map(value => ({ value }));
	}
}
