import * as path from "node:path";

import { postmortem } from "@oh-my-pi/pi-utils";

import type { AgentSession } from "./agent-session";
import type { SessionManager } from "./session-manager";

interface DetachedEntry {
	session: AgentSession;
	manager: SessionManager;
	lastActivity: number;
}

export class DetachedSessionHolder {
	#live = new Map<string, DetachedEntry>();

	#key(file: string): string {
		return path.resolve(file);
	}

	async #disposeEntry(entry: DetachedEntry): Promise<void> {
		try {
			await entry.session.abort({ goalReason: "internal" });
		} catch {}
		try {
			await entry.session.dispose({ reason: postmortem.Reason.MANUAL });
		} catch {}
	}

	park(file: string | null | undefined, session: AgentSession, manager: SessionManager): void {
		if (!file?.endsWith(".jsonl")) return;
		const key = this.#key(file);
		const previous = this.#live.get(key);
		this.#live.set(key, { session, manager, lastActivity: Date.now() });
		if (previous && previous.session !== session) void this.#disposeEntry(previous);
	}

	take(file: string | null | undefined): DetachedEntry | undefined {
		if (!file?.endsWith(".jsonl")) return undefined;
		const key = this.#key(file);
		const entry = this.#live.get(key);
		if (!entry) return undefined;
		this.#live.delete(key);
		return entry;
	}

	peek(file: string | null | undefined): DetachedEntry | undefined {
		if (!file?.endsWith(".jsonl")) return undefined;
		return this.#live.get(this.#key(file));
	}

	has(file: string | null | undefined): boolean {
		if (!file?.endsWith(".jsonl")) return false;
		return this.#live.has(this.#key(file));
	}

	delete(file: string | null | undefined): void {
		const entry = this.take(file);
		if (entry) void this.#disposeEntry(entry);
	}

	async stopAndRemove(file: string | null | undefined): Promise<boolean> {
		const entry = this.take(file);
		if (!entry) return false;
		await this.#disposeEntry(entry);
		return true;
	}

	clear(): void {
		const entries = [...this.#live.values()];
		this.#live.clear();
		for (const entry of entries) void this.#disposeEntry(entry);
	}

	async disposeAll(): Promise<void> {
		const entries = [...this.#live.values()];
		this.#live.clear();
		for (const entry of entries) await this.#disposeEntry(entry);
	}

	size(): number {
		return this.#live.size;
	}

	async evictLRU(limit: number): Promise<string[]> {
		if (this.#live.size <= limit) return [];
		const sorted = [...this.#live.entries()].sort((a, b) => a[1].lastActivity - b[1].lastActivity);
		const toEvict = sorted.slice(0, this.#live.size - limit);
		const evicted: string[] = [];
		for (const [key] of toEvict) {
			this.#live.delete(key);
			evicted.push(key);
		}

		await Promise.all(toEvict.map(([, entry]) => this.#disposeEntry(entry)));
		return evicted;
	}

	touch(file: string): void {
		const entry = this.#live.get(this.#key(file));
		if (entry) entry.lastActivity = Date.now();
	}
}

export const detachedSessionHolder = new DetachedSessionHolder();
