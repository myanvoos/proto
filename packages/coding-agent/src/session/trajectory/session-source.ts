import type { SessionManager } from "../session-manager";
import { buildTrajectory, type Trajectory } from "./model";

export function buildSessionTrajectory(sessionManager: SessionManager): Trajectory {
	const header = sessionManager.getHeader();
	return buildTrajectory(
		sessionManager.getBranch(),
		header ? { id: header.id, title: header.title, cwd: header.cwd } : null,
	);
}

export function defaultExportPath(cwd: string, sessionId: string): string {
	const short = sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "session";
	return `${cwd}/.proto/exports/trajectory-${short}.otlp.json`;
}
