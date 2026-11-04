import type { AgentSession } from "./agent-session";
import type { SessionManager } from "./session-manager";

/** The ownership domain declared by an operation, independent of the current view. */
export type CommandScope = "node" | "tree" | "root" | "application";

/** Captured before asynchronous UI work; never retargeted to a later focus. */
export interface SessionCommandTarget {
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	readonly sessionId: string;
	readonly generation: number;
	readonly leafId: string | null;
}

export function captureSessionCommandTarget(session: AgentSession): SessionCommandTarget {
	const sessionManager = session.sessionManager;
	return Object.freeze({
		session,
		sessionManager,
		sessionId: sessionManager.getSessionId(),
		generation: sessionManager.getNodeTopology?.()?.generation ?? 0,
		leafId: sessionManager.getLeafId(),
	});
}

export function isSessionCommandTargetCurrent(
	target: SessionCommandTarget,
	session: AgentSession,
	history = false,
): boolean {
	return (
		session === target.session &&
		session.sessionManager === target.sessionManager &&
		target.sessionManager.getSessionId() === target.sessionId &&
		(!history ||
			((target.sessionManager.getNodeTopology?.()?.generation ?? 0) === target.generation &&
				target.sessionManager.getLeafId() === target.leafId))
	);
}
