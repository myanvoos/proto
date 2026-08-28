import * as path from "node:path";
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

	park(file: string | null | undefined, session: AgentSession, manager: SessionManager): void {
		if (!file?.endsWith(".jsonl")) return;
		const key = this.#key(file);
		this.#live.set(key, { session, manager, lastActivity: Date.now() });
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
		if (!file?.endsWith(".jsonl")) return;
		this.#live.delete(this.#key(file));
	}

	async stopAndRemove(file: string | null | undefined): Promise<boolean> {
		const entry = this.take(file);
		if (!entry) return false;
		try {
			await entry.session.abort({ goalReason: "internal" });
		} catch {}
		return true;
	}

	clear(): void {
		this.#live.clear();
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

		await Promise.all(
			toEvict.map(async ([, entry]) => {
				try {
					await entry.session.abort({ goalReason: "internal" });
				} catch {}
			}),
		);
		return evicted;
	}

	touch(file: string): void {
		const entry = this.#live.get(this.#key(file));
		if (entry) entry.lastActivity = Date.now();
	}
}

export const detachedSessionHolder = new DetachedSessionHolder();
