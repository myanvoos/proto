import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message, UserMessage } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { visitEntriesFromFileStream } from "../session/session-loader";
import { SessionManager } from "../session/session-manager";

export const ADVISOR_TRANSCRIPT_STEM = "__advisor";
export const ADVISOR_TRANSCRIPT_FILENAME = `${ADVISOR_TRANSCRIPT_STEM}.jsonl`;

const JSONL_SUFFIX = ".jsonl";

export function advisorTranscriptFilename(slug: string): string {
	return slug ? `${ADVISOR_TRANSCRIPT_STEM}.${slug}${JSONL_SUFFIX}` : ADVISOR_TRANSCRIPT_FILENAME;
}

export function isAdvisorTranscriptName(name: string): boolean {
	return (
		name === ADVISOR_TRANSCRIPT_FILENAME ||
		(name.startsWith(`${ADVISOR_TRANSCRIPT_STEM}.`) && name.endsWith(JSONL_SUFFIX))
	);
}

export async function loadAdvisorTranscriptCosts(sessionFile: string | undefined): Promise<Map<string, number>> {
	const costs = new Map<string, number>();
	if (!sessionFile?.endsWith(JSONL_SUFFIX)) return costs;
	const directory = sessionFile.slice(0, -JSONL_SUFFIX.length);
	const dirents = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
	for (const dirent of dirents) {
		if (!dirent.isFile() || !isAdvisorTranscriptName(dirent.name)) continue;
		const slug =
			dirent.name === ADVISOR_TRANSCRIPT_FILENAME
				? ""
				: dirent.name.slice(`${ADVISOR_TRANSCRIPT_STEM}.`.length, -JSONL_SUFFIX.length);
		let total = 0;
		let validHeader: boolean | undefined;
		try {
			await visitEntriesFromFileStream(path.join(directory, dirent.name), entry => {
				const isObject = typeof entry === "object" && entry !== null;
				if (validHeader === undefined) {
					validHeader = isObject && entry.type === "session" && typeof entry.id === "string";
					return;
				}

				if (!validHeader || !isObject || entry.type !== "message") return;
				const message = entry.message;
				if (!message || typeof message !== "object" || message.role !== "assistant") return;

				const total_ = message.usage?.cost?.total;
				if (typeof total_ === "number" && Number.isFinite(total_)) total += total_;
			});
		} catch (err) {
			logger.debug("advisor transcript cost read failed", { file: dirent.name, err: String(err) });
			continue;
		}
		if (total > 0) costs.set(slug, total);
	}
	return costs;
}

export class AdvisorTranscriptRecorder {
	#manager: SessionManager | undefined;
	#file: string | undefined;
	#filename: string;

	#queue: Promise<void>;

	constructor(
		private readonly resolveSessionFile: () => string | undefined,
		private readonly resolveCwd: () => string,
		filename: string = ADVISOR_TRANSCRIPT_FILENAME,
		after?: Promise<unknown>,
	) {
		this.#filename = filename;
		this.#queue = after
			? after.then(
					() => {},
					() => {},
				)
			: Promise.resolve();
	}

	record(message: AgentMessage): void {
		let persisted: Message;
		switch (message.role) {
			case "assistant":
			case "toolResult":
				persisted = message;
				break;
			case "user":
				persisted = { ...(message as UserMessage), synthetic: true, attribution: "agent" };
				break;
			default:
				return;
		}
		const sessionFile = this.resolveSessionFile();
		if (!sessionFile?.endsWith(JSONL_SUFFIX)) return;
		const file = path.join(sessionFile.slice(0, -JSONL_SUFFIX.length), this.#filename);
		const cwd = this.resolveCwd();
		this.#enqueue(async () => {
			if (file !== this.#file) {
				await this.#closeManager();
				this.#manager = await SessionManager.open(file, undefined, undefined, {
					initialCwd: cwd,
					suppressBreadcrumb: true,
				});
				this.#file = file;
			}
			this.#manager?.appendMessage(persisted);
		});
	}

	flush(): Promise<void> {
		return this.#enqueueResult(async () => {
			if (this.#manager) await this.#manager.flush();
		});
	}

	close(): Promise<void> {
		return this.#enqueueResult(() => this.#closeManager());
	}

	async #closeManager(): Promise<void> {
		const manager = this.#manager;
		this.#manager = undefined;
		this.#file = undefined;
		if (!manager) return;
		try {
			await manager.close();
		} catch (err) {
			logger.debug("advisor transcript close failed", { err: String(err) });
		}
	}

	#enqueue(work: () => Promise<void>): void {
		this.#queue = this.#queue.then(work, work).catch(err => {
			logger.debug("advisor transcript record failed", { err: String(err) });
		});
	}

	#enqueueResult(work: () => Promise<void>): Promise<void> {
		const next = this.#queue.then(work, work);
		this.#queue = next.catch(() => {});
		return next;
	}
}
