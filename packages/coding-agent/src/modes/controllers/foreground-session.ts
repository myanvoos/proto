import { AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import { createAgentSession } from "../../sdk";
import type { AgentSession } from "../../session/agent-session";
import { detachedSessionHolder } from "../../session/detached-session-holder";
import type { SessionManager } from "../../session/session-manager";
import { shortenPath } from "../../tools/render-utils";
import type { InteractiveModeContext } from "../types";

const BACKGROUND_SESSION_LIMIT = 8;

/**
 * Whether leaving the foreground session should park it (keep it running in the background) instead of
 * interrupting it: it is persisted, background sessions are enabled, and it still has work in flight.
 */
export function canParkForegroundSession(ctx: InteractiveModeContext): boolean {
	if (ctx.settings.get("session.detachedMainSessions") === false) return false;
	if (!ctx.sessionManager.getSessionFile()?.endsWith(".jsonl")) return false;
	const session = ctx.session;
	if (session.isStreaming || session.hasActiveMonitors()) return true;
	if ((session.getAsyncJobSnapshot()?.running.length ?? 0) > 0) return true;
	return AgentRegistry.global()
		.listInFleet(session.getAgentId() ?? MAIN_AGENT_ID)
		.some(
			ref =>
				(ref.kind === "sub" && (ref.status === "running" || ref.status === "idle")) ||
				(ref.kind === "advisor" && ref.status === "running"),
		);
}

/** Builds a session for `manager` that runs in this UI alongside parked ones, sharing its settings, models, and MCP. */
export async function createForegroundSession(
	ctx: InteractiveModeContext,
	manager: SessionManager,
): Promise<AgentSession> {
	const created = await createAgentSession({
		cwd: manager.getCwd(),
		sessionManager: manager,
		settings: ctx.settings,
		modelRegistry: ctx.session.modelRegistry,
		eventBus: ctx.eventBus,
		mcpManager: ctx.mcpManager,
		hasUI: true,
	});
	const uiContext = ctx.getToolUIContext();
	if (uiContext) created.setToolUIContext(uiContext, true);
	created.session.setScopedModels([...ctx.session.scopedModels]);
	return created.session;
}

/**
 * Moves the foreground session to the background. A first turn is still unwritten while it streams, so the file is
 * materialized here: session lists read from disk and must offer the parked session for resume.
 */
export async function parkForegroundSession(ctx: InteractiveModeContext, sessionFile: string): Promise<void> {
	await ctx.sessionManager.ensureOnDisk();
	detachedSessionHolder.park(sessionFile, ctx.session, ctx.sessionManager);
}

/** Makes `session` the foreground session and points the transcript, status line, and editor at it. */
export async function swapForegroundSession(ctx: InteractiveModeContext, session: AgentSession): Promise<void> {
	ctx.clearTransientSessionUi();
	ctx.session = session;
	ctx.agent = session.agent;
	await ctx.attachSessionView(session);
}

/** Closes the oldest parked sessions beyond the background limit; returns the status suffix reporting it, if any. */
export async function enforceBackgroundSessionLimit(): Promise<string> {
	const evicted = await detachedSessionHolder.evictLRU(BACKGROUND_SESSION_LIMIT);
	if (evicted.length === 0) return "";
	return ` · background limit reached — closed ${evicted.length} oldest session${evicted.length === 1 ? "" : "s"}`;
}

export function formatParkedStatus(sessionFile: string): string {
	return `Parked ${shortenPath(sessionFile)} — still thinking in background`;
}
