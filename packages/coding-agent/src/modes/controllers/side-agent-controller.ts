import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { prompt, Snowflake } from "@oh-my-pi/pi-utils";
import backgroundSideDispatchPrompt from "../../prompts/system/background-side-dispatch.md" with { type: "text" };
import sideAgentContextSwitchPrompt from "../../prompts/system/side-agent-context-switch.md" with { type: "text" };
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID, newSideAgentId } from "../../registry/agent-registry";
import * as sdk from "../../sdk";
import type { AgentSession } from "../../session/agent-session";
import { BACKGROUND_SIDE_DISPATCH_MESSAGE_TYPE } from "../../session/messages";
import { SessionManager } from "../../session/session-manager";
import { createMCPProxyTools, createSubagentSettings } from "../../task/executor";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "../../tools/todo";
import type { InteractiveModeContext } from "../types";

const SIDE_WORK_PREVIEW_LENGTH = 80;

function previewWork(work: string): string {
	const singleLine = work.trim().replace(/\s+/g, " ");
	if (singleLine.length <= SIDE_WORK_PREVIEW_LENGTH) return singleLine;
	return `${singleLine.slice(0, SIDE_WORK_PREVIEW_LENGTH - 1)}…`;
}

function extractAssistantText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	return message.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("")
		.trim();
}

async function removeCloneSession(cloneFile: string): Promise<void> {
	await Promise.allSettled([
		fs.rm(cloneFile, { force: true }),
		fs.rm(cloneFile.slice(0, -6), { recursive: true, force: true }),
	]);
}

export class SideAgentController {
	constructor(private readonly ctx: InteractiveModeContext) {}

	async start(work: string): Promise<void> {
		const trimmedWork = work.trim();
		if (!trimmedWork) {
			this.ctx.showStatus("Usage: /side --agent <work>");
			return;
		}

		const session = this.ctx.session;

		const model = session.model;
		if (!model) {
			this.ctx.showError("No active model available for /side --agent.");
			return;
		}

		const manager = session.asyncJobManager;
		if (!manager) {
			this.ctx.showError("Background jobs are disabled; enable async jobs to use /side --agent.");
			return;
		}

		const parentFile = this.ctx.sessionManager.getSessionFile();
		if (!parentFile) {
			this.ctx.showError("/side --agent requires a persisted session.");
			return;
		}

		const parentSessionId = session.sessionId;

		const parentPromptCacheKey = session.agent.promptCacheKey ?? parentSessionId;
		const thinkingLevel = session.configuredThinkingLevel();
		const systemPrompt = [...session.systemPrompt];
		const toolNames = session.getEnabledToolNames();
		const modelRegistry = session.modelRegistry;
		const ownerId = session.getAgentId() ?? MAIN_AGENT_ID;
		const asyncJobOwnerId = session.sessionId;
		const mcpManager = this.ctx.mcpManager;
		const cwd = this.ctx.sessionManager.getCwd();
		const parentArtifactsDir = this.ctx.sessionManager.getArtifactsDir();

		const parentLocalSessionId = this.ctx.sessionManager.getSessionId();
		const localProtocolOptions = {
			getArtifactsDir: () => parentArtifactsDir,
			getSessionId: () => parentLocalSessionId,
		};

		const sessionDir = parentFile.slice(0, -6);
		const settings = createSubagentSettings(this.ctx.settings);
		const customTools = mcpManager ? createMCPProxyTools(mcpManager) : undefined;
		const agentRegistry = AgentRegistry.global();
		const cloneId = newSideAgentId();
		const cloneFile = path.join(sessionDir, `${cloneId}.jsonl`);
		const label = `/side --agent ${previewWork(trimmedWork)}`;

		await this.ctx.sessionManager.ensureOnDisk();
		await this.ctx.sessionManager.flush();

		let jobId = "";
		try {
			const cloneManager = await SessionManager.forkFrom(parentFile, cwd, sessionDir, undefined, {
				copyArtifacts: false,
				suppressBreadcrumb: true,
				sessionFile: cloneFile,
			});

			jobId = manager.register(
				"worker",
				label,
				async ({ signal }) => {
					if (signal.aborted) throw new Error("Aborted before execution");

					let clone: AgentSession | undefined;
					let unsyncStatus: (() => void) | undefined;
					try {
						const created = await sdk.createAgentSession({
							cwd,
							sessionManager: cloneManager,
							model,
							thinkingLevel,
							systemPrompt,
							toolNames,
							providerSessionId: `${parentSessionId}:side:${Snowflake.next()}`,
							providerPromptCacheKey: parentPromptCacheKey,
							modelRegistry,
							authStorage: modelRegistry.authStorage,
							settings,
							hasUI: false,
							enableMCP: false,
							customTools,
							agentId: cloneId,
							agentDisplayName: "side",
							parentTaskPrefix: cloneId,
							parentAgentId: ownerId,
							agentRegistry,
							disableExtensionDiscovery: true,
							localProtocolOptions,
						});
						clone = created.session;
						// The side agent outlives this turn, so its registry status has to follow the session
						// instead of being frozen at whatever the dispatch left behind.
						unsyncStatus = agentRegistry.syncSessionStatus(cloneId, clone);
						clone.sessionManager?.appendSessionInit?.({
							systemPrompt: clone.systemPrompt ? clone.systemPrompt.join("\n\n") : systemPrompt.join("\n\n"),
							task: trimmedWork,
							tools: clone.getEnabledToolNames(),
						});
						const abortClone = () => {
							void clone?.abort();
						};
						signal.addEventListener("abort", abortClone, { once: true });

						clone.setTodoPhases([]);
						cloneManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: [] });
						const injectContextSwitch = () => {
							clone?.agent.appendMessage({
								role: "developer",
								content: sideAgentContextSwitchPrompt,
								attribution: "agent",
								timestamp: Date.now(),
							});
						};

						const unsubscribeCompaction = clone.subscribe(event => {
							if (event.type === "auto_compaction_end" && event.result && !event.aborted) {
								injectContextSwitch();
							}
						});
						try {
							if (signal.aborted) {
								abortClone();
								throw new Error("Aborted before execution");
							}

							injectContextSwitch();
							await clone.prompt(trimmedWork, { attribution: "user" });
							await clone.waitForIdle();
							return extractAssistantText(clone.getLastAssistantMessage()) || "(no output)";
						} finally {
							unsubscribeCompaction();
							signal.removeEventListener("abort", abortClone);
						}
					} finally {
						if (clone) {
							if (signal.aborted) {
								unsyncStatus?.();
								agentRegistry.setStatus(cloneId, "aborted");
								await clone.dispose();
							} else {
								// A finished side agent stays live and idle so the user can keep talking to it
								// without a revive round-trip. Adopting it with no idle TTL never arms the park
								// timer but still hands the session to the lifecycle for shutdown release.
								agentRegistry.setStatus(cloneId, "idle");
								AgentLifecycleManager.global().adopt(cloneId, { idleTtlMs: 0 });
							}
						}
					}
				},
				{ ownerId: asyncJobOwnerId, agentId: cloneId },
			);
		} catch (error) {
			if (cloneFile) await removeCloneSession(cloneFile);
			this.ctx.showError(error instanceof Error ? error.message : String(error));
			return;
		}

		const content = prompt.render(backgroundSideDispatchPrompt, { jobId, work: trimmedWork });

		const wasStreaming = session.isStreaming;
		await session.sendCustomMessage(
			{
				customType: BACKGROUND_SIDE_DISPATCH_MESSAGE_TYPE,
				content,
				display: true,
				attribution: "user",
				details: { jobId, work: trimmedWork, sessionFile: cloneFile },
			},
			{ triggerTurn: false, deliverAs: "nextTurn" },
		);
		if (!wasStreaming) this.ctx.rebuildChatFromMessages();
		this.ctx.showStatus(`Dispatched background agent ${jobId}`);
	}
}
