import type { SessionManager } from "./session-manager";

export type ForeignSessionSource = "claude" | "codex";

export interface ForeignSessionInfo {
	readonly source: ForeignSessionSource;
	readonly id: string;
	readonly path: string;
	readonly cwd: string;
	readonly title?: string;
	readonly created: Date;
	readonly modified: Date;
	readonly messageCount?: number;
	readonly firstMessage?: string;
}

export interface ForeignSessionStore {
	readonly source: ForeignSessionSource;

	list(): Promise<ForeignSessionInfo[]>;

	load(session: ForeignSessionInfo): Promise<SessionManager>;
}
