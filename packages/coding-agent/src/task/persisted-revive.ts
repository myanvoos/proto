import * as fs from "node:fs/promises";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelRoleAlias } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { MCPManager } from "../mcp/manager";
import { initializeExtensions } from "../modes/runtime-init";
import type { PersistedSubagentReviverFactory } from "../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { createAgentSession } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import type { AuthStorage } from "../session/auth-storage";
import { SessionManager } from "../session/session-manager";
import type { EventBus } from "../utils/event-bus";
import { attachIrcWakeTurnMonitor, createMCPProxyTools, createSubagentSettings } from "./executor";
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
		const init = peek.init;

		let taskDepth = 1;
		let parentId = ref.parentId;
		const seen = new Set<string>();
		while (parentId && parentId !== MAIN_AGENT_ID && !seen.has(parentId)) {
			seen.add(parentId);
			taskDepth++;
			parentId = registry.get(parentId)?.parentId;
		}

		const subagentSettings = createSubagentSettings(ctx.settings, {
			...(init.readSummarize === false ? { "read.summarize.enabled": false } : undefined),
			...(init.advisor
				? {
						"advisor.enabled": true,
						...(init.advisor !== "on"
							? { modelRoles: { ...ctx.settings.getModelRoles(), advisor: init.advisor } }
							: undefined),
					}
				: undefined),
		});
		const persistedModelPattern =
			init.modelRole && init.modelRole !== "default"
				? [formatModelRoleAlias(init.modelRole), ...(init.resolvedModel ? [init.resolvedModel] : [])]
				: init.resolvedModel;
		return async expectedRef => {
			const reopened = await SessionManager.open(sessionFile, undefined, undefined, {
				suppressBreadcrumb: true,
			});
			const artifactManager = ctx.session.sessionManager.getArtifactManager();
			if (artifactManager) reopened.adoptArtifactManager(artifactManager);

			const restrictToolNames = init.restrictToolNames === true;
			const mcpManager = restrictToolNames ? undefined : MCPManager.instance();
			const mcpProxyTools = mcpManager ? createMCPProxyTools(mcpManager) : [];
			const { session } = await createAgentSession({
				cwd: ctx.session.sessionManager.getCwd(),
				authStorage: ctx.authStorage,
				modelRegistry: ctx.modelRegistry,
				...(persistedModelPattern ? { modelPattern: persistedModelPattern } : {}),
				modelPatternAuthFallback: init.resolvedModel,
				settings: subagentSettings,
				sessionManager: reopened,
				agentId: ref.id,
				agentDisplayName: ref.displayName,
				parentTaskPrefix: ref.id,
				parentAgentId: ref.parentId,
				expectedAgentRef: expectedRef,
				taskDepth,
				toolNames: init.tools,
				outputSchema: init.outputSchema,
				outputSchemaMode: init.outputSchemaMode,
				restrictToolNames: restrictToolNames || undefined,
				requireYieldTool: true,
				systemPrompt: () => [init.systemPrompt],

				spawns: init.spawns ?? "",
				hasUI: false,
				...(restrictToolNames
					? {
							enableIrc: false,
							enableMCP: false,
							preloadedExtensionPaths: [],
							preloadedCustomToolPaths: [],
						}
					: {
							enableMCP: !mcpManager,
							mcpManager,
							customTools: mcpProxyTools.length > 0 ? mcpProxyTools : undefined,
						}),
			});

			await session.setActiveToolsByName([...init.tools, ...session.getMountedXdevToolNames()]);

			await initializeExtensions(session, {
				reportSendError: (action, err) => logger.error("Extension send failed", { action, error: err.message }),
				reportRuntimeError: err => logger.error("Extension error", { path: err.extensionPath, error: err.error }),
			});

			registry.syncSessionStatus(ref.id, session);

			const wakeAgent: AgentDefinition = {
				name: ref.displayName,
				description: "",
				systemPrompt: init.systemPrompt,
				source: "user",
			};
			attachIrcWakeTurnMonitor(session, {
				id: ref.id,
				agent: wakeAgent,
				eventBus: ctx.eventBus,
				sessionFile,
				outputSchema: init.outputSchema,
				outputSchemaMode: init.outputSchemaMode,
				artifactsDir: ctx.session.sessionFile?.slice(0, -6),
			});
			return session;
		};
	};
}
