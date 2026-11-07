import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveAgentAdvisorRolePattern } from "../config/model-resolver";
import { formatModelRoleAlias } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { MCPManager } from "../mcp/manager";
import { initializeExtensions } from "../modes/runtime-init";
import type { PersistedSubagentReviverFactory } from "../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { createAgentSession } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import type { AuthStorage } from "../session/auth-storage";
import { installRetryFallbackRole } from "../session/retry-fallback-chains";
import { extractSessionInit, hasConversationalHistory, SessionManager } from "../session/session-manager";
import { modelSupportsEffortCeiling } from "../thinking";
import type { EventBus } from "../utils/event-bus";
import {
	attachWakeTurnMonitor,
	createMCPProxyTools,
	createSubagentSettings,
	followMCPTools,
	replayRevivedAgentStart,
	softRequestBudgetFor,
	subagentRetryFallbackRole,
} from "./executor";
import type { AgentDefinition } from "./types";

interface PersistedSubagentReviveContext {
	session: AgentSession;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settings: Settings;

	eventBus?: EventBus;
}

export function createPersistedSubagentReviverFactory(
	ctx: PersistedSubagentReviveContext,
): PersistedSubagentReviverFactory {
	const registry = AgentRegistry.global();
	return async ref => {
		const sessionFile = ref.sessionFile;
		if (!sessionFile) return undefined;
		const peek = await SessionManager.peekSessionInit(sessionFile);

		if (!peek?.init) return undefined;
		try {
			await fs.stat(peek.cwd);
		} catch {
			return undefined;
		}
		let taskDepth = 1;
		let parentId = ref.parentId;
		const seen = new Set<string>();
		while (parentId && parentId !== MAIN_AGENT_ID && !seen.has(parentId)) {
			seen.add(parentId);
			taskDepth++;
			parentId = registry.get(parentId)?.parentId;
		}

		return async expectedRef => {
			// Re-open fresh on every revive; the lock-free peek above is only an advisory prefilter, so the contract and
			// history come from the file actually opened, and a vanished or truncated transcript fails closed.
			const reopened = await SessionManager.open(sessionFile, undefined, undefined, {
				suppressBreadcrumb: true,
				throwIfMissing: true,
			});
			const entries = reopened.getEntries();
			const init = extractSessionInit(entries);
			if (!init) {
				await reopened.close();
				throw new Error(
					`Cannot revive subagent "${ref.id}": session file "${sessionFile}" has no persisted session contract. The agent was not revived.`,
				);
			}
			if (!hasConversationalHistory(entries)) {
				await reopened.close();
				throw new Error(
					`Cannot revive subagent "${ref.id}": session file "${sessionFile}" has no message history (truncated to header/session_init). The agent was not revived.`,
				);
			}
			const subagentSettings = createSubagentSettings(ctx.settings, {
				...(init.readSummarize === false ? { "read.summarize.enabled": false } : undefined),
				...(init.advisor
					? {
							"advisor.enabled": true,
							...(init.advisor !== "on"
								? {
										modelRoles: {
											...ctx.settings.getModelRoles(),
											advisor: resolveAgentAdvisorRolePattern(init.advisor, ctx.settings),
										},
									}
								: undefined),
						}
					: undefined),
			});
			// The transcript cannot rebuild the spawn's `subagent:<id>` chain (multi-model patterns and inherited role
			// chains resolve only at spawn), so reinstall the persisted one.
			if (init.retryFallback) {
				installRetryFallbackRole(subagentSettings, subagentRetryFallbackRole(ref.id), init.retryFallback);
			}
			const explicitOverride =
				typeof init.modelOverride === "string"
					? init.modelOverride
							.split(",")
							.map(entry => entry.trim())
							.filter(Boolean)
					: undefined;
			const persistedModelPattern =
				explicitOverride && explicitOverride.length > 0
					? explicitOverride
					: init.modelRole && init.modelRole !== "default"
						? [formatModelRoleAlias(init.modelRole), ...(init.resolvedModel ? [init.resolvedModel] : [])]
						: init.resolvedModel;
			const artifactManager = ctx.session.sessionManager.getArtifactManager();
			if (artifactManager) reopened.adoptArtifactManager(artifactManager);

			const restrictToolNames = init.restrictToolNames === true;
			const mcpManager = restrictToolNames ? undefined : MCPManager.instance();
			const mcpFollower = mcpManager ? followMCPTools(mcpManager) : undefined;
			const mcpProxyTools = mcpManager ? createMCPProxyTools(mcpManager) : [];
			let session: AgentSession;
			try {
				({ session } = await createAgentSession({
					rootExtensionEnvironment: ctx.session.rootExtensionEnvironment,
					cwd: ctx.session.sessionManager.getCwd(),
					authStorage: ctx.authStorage,
					modelRegistry: ctx.modelRegistry,
					...(persistedModelPattern ? { modelPattern: persistedModelPattern } : {}),
					modelPatternAuthFallback: init.resolvedModel,
					settings: subagentSettings,
					asyncJobManager: ctx.session.asyncJobManager,
					excludeAgentsMd: true,
					sessionManager: reopened,
					agentId: ref.id,
					agentDisplayName: ref.label,
					parentTaskPrefix: ref.id,
					parentAgentId: ref.parentId,
					expectedAgentRef: expectedRef,
					taskDepth,
					toolNames: init.tools,
					outputSchema: init.outputSchema,
					outputSchemaMode: init.outputSchemaMode,
					restrictToolNames: restrictToolNames || undefined,
					requireYieldTool: true,
					systemPrompt: () => [...init.systemPrompt],
					thinkingLevelCeiling: init.thinkingLevelCeiling,

					spawns: init.spawns ?? "",
					hasUI: false,
					...(restrictToolNames
						? {
								enableIrc: false,
								enableMCP: false,
								preloadedPreparedExtensions: [],
								preloadedCustomToolPaths: [],
							}
						: {
								enableMCP: !mcpManager,
								mcpManager,
								mcpTools: mcpProxyTools.length > 0 ? mcpProxyTools : undefined,
							}),
				}));
			} catch (error) {
				mcpFollower?.dispose();
				throw error;
			}
			if (
				init.thinkingLevelCeiling &&
				session.model &&
				!modelSupportsEffortCeiling(session.model, init.thinkingLevelCeiling)
			) {
				mcpFollower?.dispose();
				await session.dispose();
				throw new Error(
					`Cannot revive subagent "${ref.id}": its model cannot run at or below the saved effort ceiling "${init.thinkingLevelCeiling}".`,
				);
			}
			mcpFollower?.bind(session);

			await session.setActiveToolPresentation(
				[...init.tools, ...session.getMountedXdevToolNames()],
				init.mountedTools ?? session.getMountedXdevToolNames(),
			);

			await initializeExtensions(session, {
				reportSendError: (action, err) => logger.error("Extension send failed", { action, error: err.message }),
				reportRuntimeError: err => logger.error("Extension error", { path: err.extensionPath, error: err.error }),
			});

			await replayRevivedAgentStart(session);

			registry.syncSessionStatus(ref.id, session);

			const wakeAgent: AgentDefinition = {
				name: ref.label,
				description: "",
				systemPrompt: init.systemPrompt.join("\n\n"),
				source: "user",
			};
			attachWakeTurnMonitor(session, {
				id: ref.id,
				agent: wakeAgent,
				eventBus: ctx.eventBus,
				sessionFile,
				...softRequestBudgetFor(ref.label, ctx.settings),
				outputSchema: init.outputSchema,
				outputSchemaMode: init.outputSchemaMode,
				artifactsDir: path.dirname(sessionFile),
			});
			return session;
		};
	};
}
