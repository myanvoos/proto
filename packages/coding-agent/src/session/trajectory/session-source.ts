/**
 * Bridge between the live SessionManager and the trajectory modules.
 *
 * The interactive TUI must NOT reopen the session JSONL while the live
 * SessionManager owns the single-writer lock — read everything through the
 * manager's accessors instead (`getBranch`, `getHeader`).
 */
import type { SessionManager } from "../session-manager";
import { buildTrajectory, type Trajectory } from "./model";

/** Snapshot the active branch's model-visible history as a trajectory. */
export function buildSessionTrajectory(sessionManager: SessionManager): Trajectory {
	const header = sessionManager.getHeader();
	return buildTrajectory(
		sessionManager.getBranch(),
		header ? { id: header.id, title: header.title, cwd: header.cwd } : null,
	);
}

/** Deterministic per-session export path under the project's `.proto/exports` dir. */
export function defaultExportPath(cwd: string, sessionId: string, kind: "otel" | "prime-rl"): string {
	const short = sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "session";
	const filename = kind === "otel" ? `trajectory-${short}.otlp.json` : `trajectory-${short}.prime-rl.jsonl`;
	return `${cwd}/.proto/exports/${filename}`;
}
