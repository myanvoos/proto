import * as path from "node:path";
import { type AgentMessage, type AgentToolResult, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CompactionOutcome } from "@oh-my-pi/pi-agent-core/compaction";
import { isPasteCodeLoginProvider } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthProvider } from "@oh-my-pi/pi-ai/oauth/types";
import type { Component, OverlayHandle } from "@oh-my-pi/pi-tui";
import { Loader, Spacer, setTuiTight, Text } from "@oh-my-pi/pi-tui";
import { getAgentDbPath, getAgentDir, getProjectDir, normalizePathForComparison, VERSION } from "@oh-my-pi/pi-utils";
import {
	type AdvisorConfigScope,
	discoverAdvisorConfigs,
	loadWatchdogConfigFile,
	resolveAdvisorConfigEditPath,
	saveWatchdogConfigFile,
} from "../../advisor";
import { reset as resetCapabilities } from "../../capability";
import {
	formatModelSelectorValue,
	resolveAdvisorRoleSelection,
	resolveModelRoleValue,
} from "../../config/model-resolver";
import { getRoleInfo } from "../../config/model-roles";
import { settings } from "../../config/settings";
import { disableProvider, enableProvider } from "../../discovery";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
} from "../../extensibility/plugins/marketplace";
import {
	getAvailableThemes,
	getSymbolTheme,
	previewTheme,
	setColorBlindMode,
	setMarkdownMermaidRendering,
	setTheme,
	theme,
} from "../../modes/theme/theme";
import type { InteractiveModeContext } from "../../modes/types";
import { AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import { registerPersistedSubagents } from "../../registry/persisted-agents";
import { createAgentSession } from "../../sdk";
import type { AgentSession } from "../../session/agent-session";
import type { ResetCreditAccountStatus, ResetCreditRedeemOutcome } from "../../session/auth-storage";
import { detachedSessionHolder } from "../../session/detached-session-holder";
import {
	createForeignSessionStore,
	foreignSessionInfoToSessionInfo,
	foreignSessionSourceName,
	persistForeignSession,
} from "../../session/foreign-session-import";
import type { ForeignSessionInfo, ForeignSessionSource } from "../../session/foreign-session-store";
import type { SessionEntry } from "../../session/session-entries";
import type { SessionInfo } from "../../session/session-listing";
import { readSessionLiveState } from "../../session/session-liveness";
import { SessionManager } from "../../session/session-manager";
import { FileSessionStorage } from "../../session/session-storage";
import { buildSessionTrajectory } from "../../session/trajectory/session-source";
import { type LogoutAccount, toLogoutAccounts } from "../../slash-commands/helpers/logout";
import {
	describeRedeemOutcome,
	type ResetUsageAccount,
	toResetUsageAccounts,
} from "../../slash-commands/helpers/reset-usage";
import { parseThinkingLevel } from "../../thinking";
import {
	isSearchProviderId,
	setExcludedSearchProviders,
	setImageProviderOrder,
	setSearchProviderOrder,
	type ToolSession,
} from "../../tools";
import { AskTool, type AskToolDetails, type AskToolInput } from "../../tools/ask";
import { shortenPath } from "../../tools/render-utils";
import { ToolAbortError } from "../../tools/tool-errors";
import { copyToClipboard } from "../../utils/clipboard";
import { repo } from "../../utils/git";
import { setSessionTerminalTitle } from "../../utils/title-generator";
import { type AdvisorConfigDeps, AdvisorConfigOverlayComponent } from "../components/advisor-config";
import { AgentFleetOverlayComponent } from "../components/agent-fleet";
import { AgentsViewComponent } from "../components/agents-view/agents-view-mode";
import type { AgentsViewPersistentState } from "../components/agents-view/agents-view-state";
import {
	type AgentsViewScope,
	buildAgentsViewIndex,
	getRecordTitle,
	reconcileAgentsViewRecords,
} from "../components/agents-view/agents-view-state";
import { AssistantMessageComponent } from "../components/assistant-message";
import { CopySelectorComponent } from "../components/copy-selector";
import { ExtensionDashboard } from "../components/extensions";
import { HistorySearchComponent } from "../components/history-search";
import { LoginDialogComponent } from "../components/login-dialog";
import { LogoutAccountSelectorComponent } from "../components/logout-account-selector";
import { ModelHubComponent, type ModelRoleSelectionScope } from "../components/model-hub";
import { ModelPickerComponent } from "../components/model-picker";
import { OAuthSelectorComponent } from "../components/oauth-selector";
import { PluginSelectorComponent } from "../components/plugin-selector";
import { ReadToolGroupComponent } from "../components/read-tool-group";
import { ResetUsageSelectorComponent } from "../components/reset-usage-selector";
import { renderSegmentTrack } from "../components/segment-track";
import { SessionSelectorComponent, type SessionSelectorOptions } from "../components/session-selector";
import { SettingsSelectorComponent } from "../components/settings-selector";
import { ToolExecutionComponent } from "../components/tool-execution";
import { TrajectoryView } from "../components/trajectory-view";
import { TranscriptBlock } from "../components/transcript-container";
import { TreeSelectorComponent } from "../components/tree-selector";
import { UserMessageSelectorComponent } from "../components/user-message-selector";
import type { SessionObserverRegistry } from "../session-observer-registry";
import { buildCopyTargets } from "../utils/copy-targets";

const MANUAL_LOGIN_PROMPT = "Paste the authorization code (or full redirect URL), then press Enter:";

export class SelectorController {
	#agentsViewState: AgentsViewPersistentState | undefined;

	constructor(private ctx: InteractiveModeContext) {}

	#showFullscreenMenu(component: Component): OverlayHandle {
		const handle = this.ctx.ui.showOverlay(component, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.ctx.ui.setFocus(component);
		this.ctx.ui.requestRender();
		return handle;
	}

	#defaultRoleMutationTail = Promise.resolve();

	async #acquireDefaultRoleMutation(): Promise<() => void> {
		const previous = this.#defaultRoleMutationTail;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#defaultRoleMutationTail = previous.then(() => promise);
		await previous;
		return resolve;
	}

	async #refreshOAuthProviderAuthState(): Promise<void> {
		const oauthProviders = getOAuthProviders();
		await Promise.all(
			oauthProviders.map(provider =>
				this.ctx.session.modelRegistry
					.getApiKeyForProvider(provider.id, this.ctx.session.sessionId)
					.catch(() => undefined),
			),
		);
	}

	focusActiveEditorArea(): void {
		const visible = this.ctx.editorContainer.children[0] ?? this.ctx.editor;
		this.ctx.ui.setFocus(visible);
	}

	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
		const done = () => {
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(this.ctx.editor);
			this.ctx.ui.setFocus(this.ctx.editor);
		};
		const { component, focus } = create(done);
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(component);
		this.ctx.ui.setFocus(focus);
		this.ctx.ui.requestRender();
	}

	showSettingsSelector(): void {
		getAvailableThemes().then(availableThemes => {
			let overlayHandle: OverlayHandle | undefined;
			const done = () => {
				overlayHandle?.hide();
				this.focusActiveEditorArea();
				this.ctx.ui.requestRender();
			};
			const selector = new SettingsSelectorComponent(
				{
					availableThinkingLevels: [...this.ctx.session.getAvailableThinkingLevels()],
					thinkingLevel: this.ctx.session.thinkingLevel,
					availableThemes,
					providers: [...new Set(this.ctx.session.getAvailableModels().map(model => model.provider))].sort(
						(a, b) => a.localeCompare(b),
					),
					cwd: getProjectDir(),
					requestRender: () => this.ctx.ui.requestRender(),
				},
				{
					onChange: (id, value) => this.handleSettingChange(id, value),
					onThemePreview: async themeName => {
						const result = await previewTheme(themeName);
						if (result.success) {
							this.ctx.statusLine.invalidate();
							this.ctx.ui.invalidate();
							this.ctx.ui.requestRender();
						}
					},
					onStatusLinePreview: previewSettings => {
						this.ctx.statusLine.updateSettings({
							leftSegments: settings.get("statusLine.leftSegments"),
							rightSegments: settings.get("statusLine.rightSegments"),
							separator: settings.get("statusLine.separator"),
							showHookStatus: settings.get("statusLine.showHookStatus"),
							transparent: settings.get("statusLine.transparent"),
							compactThinkingLevel: settings.get("statusLine.compactThinkingLevel"),
							...previewSettings,
						});
						this.ctx.ui.requestRender();
					},
					getStatusLinePreview: () => {
						const width = this.ctx.editor.getTopBorderAvailableWidth(this.ctx.ui.terminal.columns);
						const { locationLine, capabilityLine } = this.ctx.statusLine.renderQuietLines(width);
						return [locationLine, capabilityLine].filter(line => line !== null).join("\n");
					},
					onPluginsChanged: async () => {
						const projectPath = await resolveActiveProjectRegistryPath(this.ctx.sessionManager.getCwd());
						clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
						await this.ctx.refreshSkillState();
						await this.ctx.refreshSlashCommandState();
						resetCapabilities();
						this.ctx.ui.requestRender();
					},
					onCancel: () => {
						done();

						this.ctx.statusLine.updateSettings({
							leftSegments: settings.get("statusLine.leftSegments"),
							rightSegments: settings.get("statusLine.rightSegments"),
							separator: settings.get("statusLine.separator"),
							showHookStatus: settings.get("statusLine.showHookStatus"),
							transparent: settings.get("statusLine.transparent"),
							compactThinkingLevel: settings.get("statusLine.compactThinkingLevel"),
						});
						this.ctx.ui.requestRender();
					},
				},
			);
			overlayHandle = this.#showFullscreenMenu(selector);
		});
	}

	showAdvisorConfigure(): void {
		const cwd = this.ctx.sessionManager.getCwd();
		const agentDir = getAgentDir() ?? getProjectDir();
		const initialScope: AdvisorConfigScope = "project";
		void (async () => {
			let projectDir = cwd;
			try {
				projectDir = (await repo.root(cwd)) ?? cwd;
			} catch {
				projectDir = cwd;
			}
			const dirs = { projectDir, agentDir };
			const initialDoc = await loadWatchdogConfigFile(await resolveAdvisorConfigEditPath(initialScope, dirs));

			let overlayHandle: OverlayHandle | undefined;
			const done = () => {
				overlayHandle?.hide();
				this.focusActiveEditorArea();
				this.ctx.ui.requestRender();
			};

			const advisorRoleSel = resolveAdvisorRoleSelection(
				this.ctx.settings,
				this.ctx.session.modelRegistry.getAvailable(),
			);
			const defaultAdvisorModel = advisorRoleSel?.model;
			const deps: AdvisorConfigDeps = {
				modelRegistry: this.ctx.session.modelRegistry,
				settings: this.ctx.settings,
				scopedModels: this.ctx.session.scopedModels,
				availableToolNames: this.ctx.session.getAdvisorAvailableToolNames(),
				defaultModelLabel: defaultAdvisorModel
					? `${defaultAdvisorModel.provider}/${defaultAdvisorModel.id}`
					: undefined,
			};
			const overlay = new AdvisorConfigOverlayComponent(this.ctx.ui, deps, initialScope, initialDoc, {
				loadDoc: async scope => loadWatchdogConfigFile(await resolveAdvisorConfigEditPath(scope, dirs)),
				save: async (scope, doc) => {
					await saveWatchdogConfigFile(await resolveAdvisorConfigEditPath(scope, dirs), doc);

					const discovered = await discoverAdvisorConfigs(cwd, agentDir);
					const count = this.ctx.session.applyAdvisorConfigs(discovered.advisors, discovered.sharedInstructions);
					this.ctx.statusLine.invalidate();
					this.ctx.showStatus(
						count > 0
							? `Saved ${scope} WATCHDOG.yml — ${count} advisor${count === 1 ? "" : "s"} active.`
							: `Saved ${scope} WATCHDOG.yml. Run /advisor on to activate the configured advisors.`,
					);
					this.ctx.ui.requestRender();
				},
				close: done,
				requestRender: () => this.ctx.ui.requestRender(),
				notify: message => this.ctx.showStatus(message),
				getAdvisorStats: () => this.ctx.session.getAdvisorStats().advisors,
				getUsageReports: async () => this.ctx.session.fetchUsageReports?.() ?? null,
				resolveActiveAccount: (provider, sessionId) =>
					this.ctx.session.modelRegistry.authStorage.getOAuthAccountIdentity(
						provider,
						sessionId ?? this.ctx.session.sessionId,
					),
			});
			overlayHandle = this.ctx.ui.showOverlay(overlay, {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
				fullscreen: true,
			});
			this.ctx.ui.setFocus(overlay);
			this.ctx.ui.requestRender();
		})();
	}

	showHistorySearch(): void {
		const historyStorage = this.ctx.historyStorage;
		if (!historyStorage) return;

		this.showSelector(done => {
			const component = new HistorySearchComponent(
				historyStorage,
				prompt => {
					done();
					this.ctx.editor.setText(prompt);
					this.ctx.ui.requestRender();
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component, focus: component };
		});
	}

	async showExtensionsDashboard(): Promise<void> {
		const dashboard = await ExtensionDashboard.create(getProjectDir(), this.ctx.settings, this.ctx.ui.terminal.rows);

		const overlay = this.ctx.ui.showOverlay(dashboard, {
			width: "100%",
			maxHeight: "100%",
			anchor: "top-left",
			margin: 0,
			fullscreen: true,
		});
		dashboard.onClose = () => {
			overlay.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		dashboard.onRequestRender = () => {
			this.ctx.ui.requestRender();
		};
	}

	async showAgentsView(scope: AgentsViewScope = "global"): Promise<void> {
		const currentSessionFile = this.ctx.sessionManager.getSessionFile() ?? null;
		let initialScopeIdentity: string | undefined;
		let initialScopeTitle: string | undefined;
		let initialSessions: SessionInfo[] | undefined;
		if (scope === "current") {
			if (!currentSessionFile) {
				this.ctx.showError("No session file to inspect (in-memory session)");
				return;
			}
			const sessions = await SessionManager.listAll();
			initialSessions = sessions;
			const registry = AgentRegistry.global();

			if (currentSessionFile) await registerPersistedSubagents(registry, currentSessionFile);
			const index = buildAgentsViewIndex(reconcileAgentsViewRecords(registry.list(), sessions));
			const identity = `file:${path.resolve(currentSessionFile)}`;
			const root = index.byKey.get(identity);
			if (root && (index.childrenByParent.get(root)?.length ?? 0) > 0) {
				initialScopeIdentity = identity;
				initialScopeTitle = getRecordTitle(root);
			} else {
				this.ctx.showStatus("No subagents in this session");
				return;
			}
		}
		const activeModel = this.ctx.session.model;
		let overlayHandle: OverlayHandle | undefined;
		let closed = false;
		const done = () => {
			if (closed) return;
			closed = true;
			view?.dispose();
			overlayHandle?.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		this.#agentsViewState ??= {};
		const view = new AgentsViewComponent({
			ui: this.ctx.ui,
			keybindings: this.ctx.keybindings,
			persistentState: this.#agentsViewState,
			currentSessionFile,
			initialSessions,
			cwd: this.ctx.sessionManager.getCwd(),
			version: VERSION,
			modelName: activeModel?.name,
			providerName: activeModel?.provider,
			requestRender: () => this.ctx.ui.requestRender(),
			close: () => done(),
			openSession: sessionPath => this.handleResumeSession(sessionPath),
			focusAgent: id => this.ctx.focusAgentSession(id),
			newSession: () => this.ctx.handleClearCommand(),
			renameCurrentSession: name => this.ctx.handleRenameCommand(name),
			deleteCurrentSession: () => this.handleSessionDeleteCommand(),
			promptAfterResume: text =>
				this.ctx.withLocalSubmission(text, () => this.ctx.session.prompt(text)).then(() => undefined),
			showError: message => this.ctx.showError(message),
			showStatus: message => this.ctx.showStatus(message),
			getTool: name => this.ctx.session.getToolByName(name),
			isBuiltInTool: name => this.ctx.session.hasBuiltInTool(name),
			getMessageRenderer: type => this.ctx.session.extensionRunner?.getMessageRenderer(type),
			hideThinkingBlock: () => this.ctx.effectiveHideThinkingBlock,
			proseOnlyThinking: () => this.ctx.proseOnlyThinking,
			expandKeys: this.ctx.keybindings.getKeys("app.tools.expand"),

			hideSubagents: scope === "global",
			initialScopeIdentity,
			initialScopeTitle,
		});
		overlayHandle = this.#showFullscreenMenu(view);
	}

	showTrajectoryView(): void {
		const trajectory = buildSessionTrajectory(this.ctx.sessionManager);
		if (trajectory.steps.length === 0) {
			this.ctx.showStatus("Trajectory is empty — nothing logged yet");
			return;
		}
		let overlayHandle: OverlayHandle | undefined;
		let closed = false;
		const done = () => {
			if (closed) return;
			closed = true;
			overlayHandle?.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		const view = new TrajectoryView({
			trajectory,
			ui: this.ctx.ui,
			requestRender: () => this.ctx.ui.requestRender(),
			close: () => done(),
		});
		overlayHandle = this.#showFullscreenMenu(view);
	}

	handleSettingChange(id: string, value: unknown): void {
		if (id.startsWith("discovery.")) {
			const providerId = id.replace("discovery.", "");
			if (value) {
				enableProvider(providerId);
			} else {
				disableProvider(providerId);
			}
			return;
		}

		switch (id) {
			case "autoCompact":
				this.ctx.session.setAutoCompactionEnabled(value as boolean);
				this.ctx.statusLine.setAutoCompactEnabled(value as boolean);
				break;
			case "advisor.enabled":
				this.ctx.session.setAdvisorEnabled(value as boolean);
				this.ctx.statusLine.invalidate();
				this.ctx.ui.requestRender();
				break;
			case "steeringMode":
				this.ctx.session.setSteeringMode(value as "all" | "one-at-a-time");
				break;
			case "followUpMode":
				this.ctx.session.setFollowUpMode(value as "all" | "one-at-a-time");
				break;
			case "interruptMode":
				this.ctx.session.setInterruptMode(value as "immediate" | "wait");
				break;
			case "thinkingLevel":
			case "defaultThinkingLevel":
				this.ctx.session.setThinkingLevel(value as ThinkingLevel, true);
				this.ctx.statusLine.invalidate();
				this.ctx.updateEditorBorderColor();
				break;
			case "personality":
				void this.ctx.session.refreshBaseSystemPrompt().catch(err => {
					this.ctx.showError(`Failed to apply personality: ${err}`);
				});
				break;
			case "tools.xdevDocs":
				void this.ctx.session.refreshBaseSystemPrompt().catch(err => {
					this.ctx.showError(`Failed to apply xd:// prompt docs setting: ${err}`);
				});
				break;
			case "inspect_media.mode":
				void this.ctx.session.applyInspectMediaModeChange().catch(err => {
					this.ctx.showError(`Failed to apply vision mode: ${err}`);
				});
				break;
			case "externalThinking":
				void this.ctx.session.setThinkToolEnabled(value as boolean).catch(err => {
					this.ctx.showError(`Failed to apply external thinking: ${err}`);
				});
				break;

			case "autocompleteMaxVisible":
				this.ctx.editor.setAutocompleteMaxVisible(typeof value === "number" ? value : Number(value));
				break;
			case "spelling.typoDetection":
			case "spelling.autocomplete":
			case "spelling.autocorrect":
				this.ctx.syncEditorSpelling();
				this.ctx.ui.requestRender();
				break;

			case "display.hideToolActivity": {
				const hidden = value as boolean;
				this.ctx.hideToolActivity = hidden;
				if (!hidden) this.ctx.toolOutputExpanded = false;
				for (const child of this.ctx.chatContainer.children) {
					if (!hidden && (child instanceof ToolExecutionComponent || child instanceof ReadToolGroupComponent)) {
						child.setExpanded(false);
					} else if (child instanceof AssistantMessageComponent) {
						child.setToolResultImagesVisible(!hidden);
					}
				}
				this.ctx.chatContainer.setToolActivityVisible(!hidden);
				if (hidden) this.ctx.ui.clearInlineImages();
				this.ctx.ui.resetDisplay();
				break;
			}
			case "terminal.showImages":
			case "showImages": {
				const visible = value as boolean;
				for (const child of this.ctx.chatContainer.children) {
					if (child instanceof ToolExecutionComponent) {
						child.setShowImages(visible);
					} else if (child instanceof AssistantMessageComponent) {
						child.setImagesVisible(visible);
					}
				}
				if (!visible) this.ctx.ui.clearInlineImages();
				this.ctx.ui.resetDisplay();
				break;
			}
			case "hideThinkingBlock":
				this.ctx.hideThinkingBlock = value as boolean;
				for (const child of this.ctx.chatContainer.children) {
					if (child instanceof AssistantMessageComponent) {
						child.setHideThinkingBlock(this.ctx.effectiveHideThinkingBlock);
					}
				}

				this.ctx.ui.resetDisplay();
				break;
			case "proseOnlyThinking":
				this.ctx.proseOnlyThinking = value as boolean;
				for (const child of this.ctx.chatContainer.children) {
					if (child instanceof AssistantMessageComponent) {
						child.setProseOnlyThinking(value as boolean);
					}
				}
				this.ctx.ui.resetDisplay();
				break;
			case "omitThinking":
				this.ctx.session.agent.hideThinkingSummary = value as boolean;
				break;
			case "display.cacheMissMarker":
				this.ctx.rebuildChatFromMessages();
				this.ctx.ui.resetDisplay();
				break;
			case "display.showTokenUsage":
				this.ctx.rebuildChatFromMessages();
				this.ctx.ui.resetDisplay();
				break;
			case "tui.tight":
				setTuiTight(value as boolean);
				this.ctx.ui.invalidate();
				this.ctx.ui.requestRender();
				break;

			case "tui.renderMermaid":
				setMarkdownMermaidRendering(value as boolean);
				this.ctx.session.refreshBaseSystemPrompt().catch(err => {
					this.ctx.showError(`Failed to apply Mermaid rendering setting: ${err}`);
				});
				this.ctx.rebuildChatFromMessages();
				this.ctx.ui.resetDisplay();
				break;

			case "theme": {
				setTheme(value as string, true).then(result => {
					this.ctx.statusLine.invalidate();
					this.ctx.ui.requestRender();
					this.ctx.ui.invalidate();
					if (!result.success) {
						this.ctx.showError(`Failed to load theme "${value}": ${result.error}\nFell back to dark theme.`);
					}
				});
				break;
			}
			case "colorBlindMode": {
				setColorBlindMode(value === "true" || value === true).then(() => {
					this.ctx.ui.invalidate();
				});
				break;
			}
			case "temperature": {
				const temp = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.temperature = temp >= 0 ? temp : undefined;
				break;
			}
			case "topP": {
				const topP = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.topP = topP >= 0 ? topP : undefined;
				break;
			}
			case "topK": {
				const topK = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.topK = topK >= 0 ? topK : undefined;
				break;
			}
			case "minP": {
				const minP = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.minP = minP >= 0 ? minP : undefined;
				break;
			}
			case "presencePenalty": {
				const presencePenalty = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.presencePenalty = presencePenalty >= 0 ? presencePenalty : undefined;
				break;
			}
			case "repetitionPenalty": {
				const repetitionPenalty = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.repetitionPenalty = repetitionPenalty >= 0 ? repetitionPenalty : undefined;
				break;
			}
			case "git.enabled":
			case "statusLine.separator":
			case "statusLineShowHooks":
			case "statusLine.showHookStatus":
			case "statusLine.transparent":
			case "statusLine.compactThinkingLevel":
			case "statusLineSegments":
			case "statusLineModelThinking":
			case "statusLinePathAbbreviate":
			case "statusLinePathMaxLength":
			case "statusLinePathStripWorkPrefix":
			case "statusLineGitShowBranch":
			case "statusLineGitShowStaged":
			case "statusLineGitShowUnstaged":
			case "statusLineGitShowUntracked":
			case "statusLineTimeFormat":
			case "statusLineTimeShowSeconds": {
				const statusLineSettings = {
					leftSegments: settings.get("statusLine.leftSegments"),
					rightSegments: settings.get("statusLine.rightSegments"),
					separator: settings.get("statusLine.separator"),
					showHookStatus: settings.get("statusLine.showHookStatus"),
					transparent: settings.get("statusLine.transparent"),
					segmentOptions: settings.get("statusLine.segmentOptions"),
					compactThinkingLevel: settings.get("statusLine.compactThinkingLevel"),
				};
				this.ctx.statusLine.updateSettings(statusLineSettings);
				this.ctx.ui.requestRender();
				break;
			}

			case "providers.webSearchOrder":
				if (Array.isArray(value)) {
					setSearchProviderOrder(value.filter(isSearchProviderId));
				}
				break;
			case "providers.webSearchExclude":
				if (Array.isArray(value)) {
					setExcludedSearchProviders(value.filter(isSearchProviderId));
				}
				break;
			case "providers.imageOrder":
				if (Array.isArray(value)) {
					setImageProviderOrder(value.filter((entry): entry is string => typeof entry === "string"));
				}
				break;

			case "mcp.notifications":
				this.ctx.mcpManager?.setNotificationsEnabled(value as boolean);
				break;
		}
	}

	showModelSelector(options?: { temporaryOnly?: boolean }): void {
		if (options?.temporaryOnly) {
			this.#showModelPicker();
			return;
		}
		this.#showModelHub({});
	}

	#showModelPicker(): void {
		const currentContextTokens = this.ctx.session.getContextUsage()?.tokens ?? 0;
		const current = this.ctx.session.model;
		const quickRoleOrder = this.ctx.settings.get("cycleOrder");
		const quickRoleCycle = this.ctx.session.getRoleModelCycle(quickRoleOrder);
		let overlayHandle: OverlayHandle | undefined;
		let closed = false;
		const done = () => {
			if (closed) return;
			closed = true;
			overlayHandle?.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		const picker = new ModelPickerComponent(
			this.ctx.ui,
			this.ctx.settings,
			this.ctx.session.modelRegistry,
			this.ctx.session.scopedModels,
			{
				onPick: async (model, selector, { overContext }) => {
					const applySessionModel = async () => {
						const roleThinkingLevel = this.ctx.session.resolveTemporaryModelThinkingLevel(model);
						await this.ctx.session.setModelTemporary(model, roleThinkingLevel);
						this.ctx.statusLine.invalidate();
						this.ctx.updateEditorBorderColor();
						const roleSelectorHint = this.ctx.keybindings.getKeys("app.model.select")[0] ?? "Alt+M";
						this.ctx.showStatus(`Session-only model: ${selector}. Use ${roleSelectorHint} or /model for roles.`);
					};
					try {
						if (overContext) {
							done();
							let switched = false;
							const switchAfterCompaction = async (outcome: CompactionOutcome) => {
								if (switched || outcome !== "ok") return;
								switched = true;
								await applySessionModel();
							};
							const outcome = await this.ctx.handleCompactCommand(undefined, undefined, switchAfterCompaction);
							await switchAfterCompaction(outcome);
							return;
						}
						await applySessionModel();
						done();
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					}
				},
				onPickRole: async entry => {
					try {
						await this.ctx.session.applyRoleModel(entry);
						this.ctx.statusLine.invalidate();
						this.ctx.updateEditorBorderColor();
						this.ctx.showModelCycleTrack(
							renderSegmentTrack(
								quickRoleOrder.map(role => ({ label: role })),
								quickRoleOrder.indexOf(entry.role),
							),
						);
						done();
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					}
				},
				onCancel: done,
			},
			{
				currentContextTokens,
				currentSelector: current ? `${current.provider}/${current.id}` : undefined,
				quickRoles: quickRoleCycle?.models,
				quickRoleOrder,
				currentQuickRole: quickRoleCycle?.models[quickRoleCycle.currentIndex]?.role,
			},
		);
		overlayHandle = this.ctx.ui.showOverlay(picker, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		});
		this.ctx.ui.setFocus(picker);
		this.ctx.ui.requestRender();
	}

	#showModelHub(hubOptions: { initialProviderId?: string }): void {
		let overlayHandle: OverlayHandle | undefined;
		let hub: ModelHubComponent | undefined;
		let closed = false;
		const done = () => {
			if (closed) return;
			closed = true;
			hub?.dispose();
			overlayHandle?.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		hub = new ModelHubComponent(
			this.ctx.ui,
			this.ctx.settings,
			this.ctx.session.modelRegistry,
			this.ctx.session.scopedModels,
			{
				onAssign: async (model, role, thinkingLevel, selector, scope?: ModelRoleSelectionScope) => {
					const releaseDefaultMutation = role === "default" ? await this.#acquireDefaultRoleMutation() : undefined;
					const configuredStorage = this.ctx.settings.get("modelRoleStorage");
					const targetScope = configuredStorage === "project" ? (scope ?? "project") : "global";
					const selectorValue = selector ?? `${model.provider}/${model.id}`;
					const scopeLabel =
						configuredStorage === "project" ? `${targetScope === "project" ? "Project" : "Global"} ` : "";
					const defaultStatusLabel = configuredStorage === "project" ? `${scopeLabel}default` : "Default";
					try {
						if (role === "default") {
							const concreteThinking =
								thinkingLevel !== undefined && thinkingLevel !== ThinkingLevel.Inherit
									? thinkingLevel
									: undefined;
							const effectiveProvenance = this.ctx.settings.getModelRoleProvenance("default");
							const shadowedGlobal =
								configuredStorage === "project" &&
								targetScope === "global" &&
								(effectiveProvenance === "project" ||
									effectiveProvenance === "overlay" ||
									(effectiveProvenance === "runtime" &&
										this.ctx.settings.isProjectModelRoleRuntimeOverrideActive("default")));
							const shadowedProject =
								configuredStorage === "project" &&
								targetScope === "project" &&
								effectiveProvenance === "overlay";
							if (shadowedGlobal) {
								this.ctx.settings.setModelRole(
									"default",
									formatModelSelectorValue(selectorValue, concreteThinking),
								);
							} else if (shadowedProject) {
								this.ctx.settings.setProjectModelRole(
									"default",
									formatModelSelectorValue(selectorValue, concreteThinking),
								);
							} else {
								const { switched } = await this.ctx.session.setModel(model, role, {
									selector,
									thinkingLevel: concreteThinking ?? ThinkingLevel.Inherit,
									persist: targetScope === "global",
								});
								if (!switched) return;
								if (targetScope === "project") {
									this.ctx.settings.setProjectModelRole(
										"default",
										formatModelSelectorValue(selectorValue, concreteThinking),
									);
								}
								if (concreteThinking) {
									this.ctx.session.setThinkingLevel(concreteThinking);
								}
								this.ctx.statusLine.invalidate();
								this.ctx.updateEditorBorderColor();
							}
							this.ctx.showStatus(`${defaultStatusLabel} model: ${selector ?? model.id}`);
						} else {
							const modelRoleValue = formatModelSelectorValue(selectorValue, thinkingLevel);
							if (targetScope === "project") {
								this.ctx.settings.setProjectModelRole(role, modelRoleValue);
							} else {
								this.ctx.settings.setModelRole(role, modelRoleValue);
							}
							const roleInfo = getRoleInfo(role, settings);
							this.ctx.showStatus(
								`${scopeLabel}${roleInfo?.tag ?? roleInfo?.name ?? role} model: ${selector ?? model.id}`,
							);
						}
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					} finally {
						releaseDefaultMutation?.();
						hub?.refreshAfterExternalMutation();
					}
				},
				onUnassign: async (role, scope?: ModelRoleSelectionScope) => {
					const releaseDefaultMutation = role === "default" ? await this.#acquireDefaultRoleMutation() : undefined;
					const configuredStorage = this.ctx.settings.get("modelRoleStorage");
					const targetScope = configuredStorage === "project" ? (scope ?? "project") : "global";
					const scopeLabel =
						configuredStorage === "project" ? `${targetScope === "project" ? "Project" : "Global"} ` : "";
					try {
						const previousEffectiveRoleValue =
							role === "default" ? this.ctx.settings.getModelRole("default") : undefined;
						if (targetScope === "project") {
							this.ctx.settings.clearProjectModelRole(role);
						} else {
							this.ctx.settings.setModelRole(role, undefined);
						}
						const roleInfo = getRoleInfo(role, settings);
						this.ctx.showStatus(
							`${scopeLabel}${roleInfo?.tag ?? roleInfo?.name ?? role} role cleared — auto-selection applies`,
						);

						if (role === "default") {
							const fallbackRoleValue = this.ctx.settings.getModelRole("default");
							const fallbackProvenance = this.ctx.settings.getModelRoleProvenance("default");
							const exposesPersistedFallback =
								fallbackProvenance === "project" || fallbackProvenance === "global";
							if (
								fallbackRoleValue &&
								fallbackRoleValue !== previousEffectiveRoleValue &&
								exposesPersistedFallback
							) {
								const scopedModels = this.ctx.session.scopedModels.map(sm => sm.model);
								const availableModels =
									scopedModels.length > 0 ? scopedModels : this.ctx.session.getAvailableModels();
								const resolved = resolveModelRoleValue(fallbackRoleValue, availableModels, {
									settings: this.ctx.settings,
								});
								if (resolved.model) {
									let fallbackThinking = resolved.explicitThinkingLevel ? resolved.thinkingLevel : undefined;
									if (fallbackThinking === undefined) {
										fallbackThinking = parseThinkingLevel(this.ctx.settings.get("defaultThinkingLevel"));
									}
									const { switched } = await this.ctx.session.setModel(resolved.model, "default", {
										persist: false,
										thinkingLevel: fallbackThinking ?? ThinkingLevel.Inherit,
									});
									if (!switched) return;
									if (fallbackThinking && fallbackThinking !== ThinkingLevel.Inherit) {
										this.ctx.session.setThinkingLevel(fallbackThinking);
									}
									this.ctx.statusLine.invalidate();
									this.ctx.updateEditorBorderColor();
								}
							}
						}
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					} finally {
						releaseDefaultMutation?.();
						hub?.refreshAfterExternalMutation();
					}
				},
				onFallbackChainChange: (role, chain) => {
					try {
						const chains = { ...this.ctx.settings.get("retry.fallbackChains") };
						if (chain.length === 0) {
							delete chains[role];
						} else {
							chains[role] = chain;
						}
						this.ctx.settings.set("retry.fallbackChains", chains);
						const roleInfo = getRoleInfo(role, settings);
						this.ctx.showStatus(
							chain.length > 0
								? `${roleInfo?.tag ?? roleInfo?.name ?? role} fallbacks: ${chain.join(" → ")}`
								: `${roleInfo?.tag ?? roleInfo?.name ?? role} fallbacks cleared`,
						);
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					}
				},

				onLoginRequest: providerId => {
					done();
					void this.#loginThenReopenModelHub(providerId);
				},
				onCycleOrderChange: order => {
					try {
						this.ctx.settings.set("cycleOrder", order);
						this.ctx.showStatus(
							order.length > 0 ? `Quick-switch cycle: ${order.join(" → ")}` : "Quick-switch cycle cleared",
						);
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					}
				},
				onCancel: () => done(),
			},
			{
				initialProviderId: hubOptions.initialProviderId,
			},
		);
		overlayHandle = this.#showFullscreenMenu(hub);
	}

	async #loginThenReopenModelHub(providerId: string): Promise<void> {
		const succeeded = await this.#handleOAuthLogin(providerId);
		if (succeeded) {
			this.#showModelHub({ initialProviderId: providerId });
		}
	}

	async showPluginSelector(mode: "install" | "uninstall" = "install"): Promise<void> {
		const mgr = new MarketplaceManager({
			marketplacesRegistryPath: getMarketplacesRegistryPath(),
			installedRegistryPath: getInstalledPluginsRegistryPath(),
			projectInstalledRegistryPath: (await resolveActiveProjectRegistryPath(getProjectDir())) ?? undefined,
			marketplacesCacheDir: getMarketplacesCacheDir(),
			pluginsCacheDir: getPluginsCacheDir(),
			clearPluginRootsCache: clearPluginRootsAndCaches,
		});

		const [marketplaces, installed] = await Promise.all([mgr.listMarketplaces(), mgr.listInstalledPlugins()]);
		const installedIds = new Set(installed.map(p => p.id));

		if (mode === "uninstall") {
			const items = installed.map(p => {
				const entry = p.entries[0];
				const atIdx = p.id.lastIndexOf("@");
				const pluginName = atIdx > 0 ? p.id.slice(0, atIdx) : p.id;
				const mkt = atIdx > 0 ? p.id.slice(atIdx + 1) : "unknown";
				return {
					plugin: { name: pluginName, version: entry?.version, description: undefined as string | undefined },
					marketplace: mkt,
					scope: p.scope,
				};
			});
			this.showSelector(done => {
				const selector = new PluginSelectorComponent(marketplaces.length, items, new Set(), {
					onSelect: async (name, marketplace, scope) => {
						done();
						const pluginId = `${name}@${marketplace}`;
						this.ctx.showStatus(`Uninstalling ${pluginId}...`);
						this.ctx.ui.requestRender();
						try {
							await mgr.uninstallPlugin(pluginId, scope);
							this.ctx.showStatus(`Uninstalled ${pluginId}`);
						} catch (err) {
							this.ctx.showStatus(`Uninstall failed: ${err}`);
						}
						this.ctx.ui.requestRender();
					},
					onCancel: () => {
						done();
						this.ctx.ui.requestRender();
					},
				});
				return { component: selector, focus: selector.getSelectList() };
			});
			return;
		}

		const allPlugins: Array<{
			plugin: { name: string; version?: string; description?: string };
			marketplace: string;
		}> = [];
		for (const mkt of marketplaces) {
			const plugins = await mgr.listAvailablePlugins(mkt.name);
			for (const plugin of plugins) {
				allPlugins.push({ plugin, marketplace: mkt.name });
			}
		}

		this.showSelector(done => {
			const selector = new PluginSelectorComponent(marketplaces.length, allPlugins, installedIds, {
				onSelect: async (name, marketplace) => {
					done();
					this.ctx.showStatus(`Installing ${name} from ${marketplace}...`);
					this.ctx.ui.requestRender();
					try {
						const force = installedIds.has(`${name}@${marketplace}`);
						await mgr.installPlugin(name, marketplace, { force });
						this.ctx.showStatus(`Installed ${name} from ${marketplace}`);
					} catch (err) {
						this.ctx.showStatus(`Install failed: ${err}`);
					}
					this.ctx.ui.requestRender();
				},
				onCancel: () => {
					done();
					this.ctx.ui.requestRender();
				},
			});
			return { component: selector, focus: selector.getSelectList() };
		});
	}

	showUserMessageSelector(): void {
		const userMessages = this.ctx.session.getUserMessagesForBranching();

		if (userMessages.length === 0) {
			this.ctx.showStatus("No messages to branch from");
			return;
		}

		this.showSelector(done => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map(m => ({ id: m.entryId, text: m.text })),
				async entryId => {
					const branchEntry = this.ctx.sessionManager.getEntry(entryId);
					const branchMessage =
						branchEntry?.type === "message" && branchEntry.message.role === "user"
							? branchEntry.message
							: undefined;
					const result = await this.ctx.session.branch(entryId);
					if (result.cancelled) {
						done();
						this.ctx.ui.requestRender();
						return;
					}

					const fastRewind =
						branchMessage !== undefined &&
						branchEntry?.parentId != null &&
						this.ctx.sessionManager.getLeafId() === branchEntry.parentId &&
						this.ctx.truncateTranscriptFromMessage(branchMessage);
					if (!fastRewind) {
						await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
					}
					this.ctx.editor.setDraft(result.selectedText, result.selectedImages);
					done();
					this.ctx.showStatus("Branched to new session");
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component: selector, focus: selector.getMessageList() };
		});
	}

	showCopySelector(): void {
		const targets = buildCopyTargets(this.ctx.session);
		if (targets.length === 0) {
			this.ctx.showStatus("Nothing to copy yet.");
			return;
		}

		let overlayHandle: OverlayHandle | undefined;
		const done = () => {
			overlayHandle?.hide();
			this.ctx.ui.requestRender();
		};
		const selector = new CopySelectorComponent(targets, {
			onPick: target => {
				done();
				if (target.content === undefined) return;
				void copyToClipboard(target.content);
				this.ctx.showStatus(target.copyMessage ?? "Copied to clipboard");
			},
			onCancel: done,
		});

		overlayHandle = this.ctx.ui.showOverlay(selector, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		});
		this.ctx.ui.setFocus(selector);
		this.ctx.ui.requestRender();
	}

	showTreeSelector(): void {
		const tree = this.ctx.sessionManager.getTree();
		const realLeafId = this.ctx.sessionManager.getLeafId();

		if (tree.length === 0) {
			this.ctx.showStatus("No entries in session");
			return;
		}

		this.showSelector(done => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				this.ctx.ui.terminal.rows,
				async (entryId, options) => {
					if (entryId === realLeafId) {
						const currentEntry = this.ctx.sessionManager.getEntry(entryId);
						const currentIsAskResult =
							currentEntry?.type === "message" &&
							currentEntry.message.role === "toolResult" &&
							currentEntry.message.toolName === "ask";
						if (!currentIsAskResult) {
							done();
							this.ctx.showStatus("Already at this point");
							return;
						}
					}

					done();

					const treeRewind = this.#treeRewindBoundary(entryId, realLeafId);

					let wantsSummary = options.summarize;
					let customInstructions: string | undefined;

					const branchSummariesEnabled = settings.get("branchSummary.enabled");

					while (!wantsSummary && branchSummariesEnabled) {
						const summaryChoice = await this.ctx.showHookSelector("Summarize branch?", [
							"No summary",
							"Summarize",
							"Summarize with custom prompt",
						]);

						if (summaryChoice === undefined) {
							this.showTreeSelector();
							return;
						}

						wantsSummary = summaryChoice !== "No summary";

						if (summaryChoice === "Summarize with custom prompt") {
							customInstructions = await this.ctx.showHookEditor("Custom summarization instructions");
							if (customInstructions === undefined) {
								continue;
							}
						}

						break;
					}

					let summaryLoader: Loader | undefined;
					const originalOnEscape = this.ctx.editor.onEscape;

					if (wantsSummary) {
						this.ctx.editor.onEscape = () => {
							this.ctx.session.abortBranchSummary();
						};
						this.ctx.chatContainer.addChild(new Spacer(1));
						summaryLoader = new Loader(
							this.ctx.ui,
							spinner => theme.fg("accent", spinner),
							text => theme.fg("muted", text),
							"Summarizing branch... (esc to cancel)",
							getSymbolTheme().spinnerFrames,
						);
						this.ctx.statusContainer.addChild(summaryLoader);
						this.ctx.ui.requestRender();
					}

					try {
						let result = await this.ctx.session.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
							allowAskReopen: true,
						});

						if (result.reopenAsk) {
							const reanswer = await this.#reanswerAsk(result.reopenAsk.questions);
							if (!reanswer) {
								this.ctx.showStatus("Re-answer cancelled");
								return;
							}
							result = await this.ctx.session.navigateTree(entryId, {
								summarize: wantsSummary,
								customInstructions,
								allowAskReopen: true,
								reanswerAskResult: reanswer,
							});
						}

						if (result.aborted) {
							this.ctx.showStatus("Branch summarization cancelled");
							this.showTreeSelector();
							return;
						}
						if (result.cancelled) {
							this.ctx.showStatus("Navigation cancelled");
							return;
						}

						const fastRewind =
							treeRewind !== undefined &&
							!wantsSummary &&
							!result.summaryEntry &&
							!result.askReanswerCommitted &&
							this.ctx.sessionManager.getLeafId() === treeRewind.expectedLeafId &&
							this.ctx.truncateTranscriptFromMessage(treeRewind.message);
						if (!fastRewind) {
							await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
						}
						await this.ctx.reloadTodos();
						if (result.editorText && !this.ctx.editor.getText().trim()) {
							this.ctx.editor.setDraft(result.editorText, result.editorImages);
						}
						this.ctx.showStatus("Navigated to selected point");

						if (result.askReanswerCommitted) {
							this.ctx.session.resumeAfterAskReanswer();
						}
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					} finally {
						if (summaryLoader) {
							summaryLoader.stop();
							this.ctx.statusContainer.disposeChildren();
						}
						this.ctx.editor.onEscape = originalOnEscape;
					}
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
				(entryId, label) => {
					this.ctx.sessionManager.appendLabelChange(entryId, label);
					this.ctx.ui.requestRender();
				},
				settings.get("treeFilterMode"),
			);
			return { component: selector, focus: selector };
		});
	}

	#treeRewindBoundary(
		targetId: string,
		leafId: string | null,
	): { message: AgentMessage; expectedLeafId: string } | undefined {
		if (!leafId) return undefined;
		const target = this.ctx.sessionManager.getEntry(targetId);
		if (!target) return undefined;
		const rewindsPastTarget = target.type === "message" && target.message.role === "user";
		if (!rewindsPastTarget && target.type === "custom_message") return undefined;

		let firstDropped: SessionEntry | undefined;
		let cursor = this.ctx.sessionManager.getEntry(leafId);
		while (cursor && cursor.id !== targetId) {
			firstDropped = cursor;
			cursor = cursor.parentId ? this.ctx.sessionManager.getEntry(cursor.parentId) : undefined;
		}
		if (!cursor) return undefined;
		const boundary = rewindsPastTarget ? target : firstDropped;
		if (boundary?.type !== "message") return undefined;

		const expectedLeafId = rewindsPastTarget ? target.parentId : targetId;
		if (expectedLeafId === null) return undefined;
		return {
			message: boundary.message,
			expectedLeafId,
		};
	}

	async #reanswerAsk(questions: AskToolInput["questions"]): Promise<AgentToolResult<AskToolDetails> | undefined> {
		const uiContext = this.ctx.getToolUIContext();
		if (!uiContext) {
			this.ctx.showError("Ask tool UI is not ready");
			return undefined;
		}
		const toolSession: ToolSession = {
			cwd: this.ctx.sessionManager.getCwd(),
			hasUI: true,
			settings: this.ctx.settings,
			getSessionFile: () => this.ctx.sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => null,
		};
		const askTool = new AskTool(toolSession);
		const context = this.ctx.session.buildAskReanswerContext(uiContext);
		let result: AgentToolResult<AskToolDetails>;
		try {
			result = await askTool.execute("tree-reanswer", { questions }, undefined, undefined, context);
		} catch (error) {
			if (error instanceof ToolAbortError) return undefined;
			throw error;
		}

		if (result.details?.chatRedirect) {
			this.ctx.showError(
				"Chat about this isn't available when re-answering from the tree — pick an option or type a custom answer instead.",
			);
			return undefined;
		}
		return result;
	}

	async showSessionSelector(source?: ForeignSessionSource): Promise<void> {
		let sessions: SessionInfo[];
		let onSelectSession: (session: SessionInfo) => Promise<boolean>;
		let selectorOptions: SessionSelectorOptions;

		if (source) {
			const sourceName = foreignSessionSourceName(source);
			const store = createForeignSessionStore(source);
			let foreignSessions: ForeignSessionInfo[];
			try {
				foreignSessions = await store.list();
			} catch (error) {
				this.ctx.showError(
					`Failed to list ${sourceName} sessions: ${error instanceof Error ? error.message : String(error)}`,
				);
				return;
			}
			if (foreignSessions.length === 0) {
				this.ctx.showWarning(`No ${sourceName} sessions found`);
				return;
			}
			const foreignByPath = new Map(foreignSessions.map(session => [session.path, session]));
			sessions = foreignSessions.map(foreignSessionInfoToSessionInfo);
			onSelectSession = async session => {
				try {
					await this.ctx.settings.flush();
				} catch (error) {
					this.ctx.showError(
						`Failed to save pending settings: ${error instanceof Error ? error.message : String(error)}`,
					);
					return false;
				}
				const foreignSession = foreignByPath.get(session.path);
				if (!foreignSession) throw new Error(`Selected ${sourceName} session is no longer available`);
				const imported = await persistForeignSession(store, foreignSession, {
					fallbackCwd: this.ctx.sessionManager.getCwd(),
					suppressBreadcrumb: true,
				});
				const sessionFile = imported.getSessionFile();
				if (!sessionFile) throw new Error(`Failed to persist ${sourceName} session`);
				await imported.close();
				return await this.handleResumeSession(sessionFile, { settingsFlushed: true });
			};
			selectorOptions = {
				title: `Import ${sourceName} Session`,
				scopeLabel: false,
				showCwd: true,
			};
		} else {
			const loadedSessions = await SessionManager.list(
				this.ctx.sessionManager.getCwd(),
				this.ctx.sessionManager.getSessionDir(),
			);
			sessions = loadedSessions;
			const historyStorage = this.ctx.historyStorage;
			const historyMatcher = historyStorage
				? (query: string) => historyStorage.matchingSessionIds(query)
				: undefined;
			onSelectSession = session => this.handleResumeSession(session.path);
			selectorOptions = {
				onDelete: async (session: SessionInfo) => {
					if (!(await this.#detachActiveSessionBeforeDeletion(session.path))) {
						return false;
					}
					const storage = new FileSessionStorage();
					try {
						await storage.deleteSessionWithArtifacts(session.path);
						return true;
					} catch (error) {
						throw new Error(
							`Failed to delete session: ${error instanceof Error ? error.message : String(error)}`,
							{ cause: error },
						);
					}
				},
				historyMatcher,
				loadAllSessions: () => SessionManager.listAll(),
			};
		}

		let overlayHandle: OverlayHandle | undefined;
		const done = () => {
			overlayHandle?.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		const selector = new SessionSelectorComponent(
			sessions,
			async (session: SessionInfo) => {
				selector.lockInput();
				let keepOpen = false;
				try {
					const success = await onSelectSession(session);
					if (!success) {
						keepOpen = true;
						selector.unlockInput();
						this.ctx.ui.requestRender();
					}
				} catch (error) {
					this.ctx.showError(error instanceof Error ? error.message : String(error));
				} finally {
					if (!keepOpen) done();
				}
			},
			done,
			() => {
				done();
				void this.ctx.shutdown();
			},
			{
				...selectorOptions,
				getTerminalRows: () => this.ctx.ui.terminal.rows,
				fillHeight: true,
			},
		);
		selector.setOnRequestRender(() => this.ctx.ui.requestRender());
		overlayHandle = this.ctx.ui.showOverlay(selector, {
			anchor: "top-left",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.ctx.ui.setFocus(selector);
		this.ctx.ui.requestRender();
	}

	#refreshSessionTerminalTitle(): void {
		const sessionManager = this.ctx.sessionManager as {
			getSessionName?: () => string | undefined;
			getCwd: () => string;
			titleSource?: "auto" | "user" | undefined;
		};
		setSessionTerminalTitle(sessionManager.getSessionName?.(), sessionManager.getCwd());
	}

	async #detachActiveSessionBeforeDeletion(sessionPath: string): Promise<boolean> {
		const currentSessionFile = this.ctx.sessionManager.getSessionFile();
		if (currentSessionFile !== sessionPath) {
			return true;
		}

		const detached = await this.ctx.session.newSession();
		if (!detached) {
			return false;
		}
		this.#refreshSessionTerminalTitle();

		this.ctx.clearTransientSessionUi();
		this.ctx.statusLine.invalidate();
		this.ctx.statusLine.resetActiveTime();
		this.ctx.ui.requestRender();
		this.ctx.updateEditorBorderColor();
		await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
		await this.ctx.reloadTodos();
		this.ctx.ui.requestRender(true, { clearScrollback: true });
		return true;
	}

	async handleResumeSession(sessionPath: string, options?: { settingsFlushed?: boolean }): Promise<boolean> {
		const previousCwd = this.ctx.sessionManager.getCwd();
		const previousFile = this.ctx.sessionManager.getSessionFile();
		const wasStreaming = this.ctx.session.isStreaming;
		const switchingToDifferentSession = previousFile
			? path.resolve(previousFile) !== path.resolve(sessionPath)
			: true;

		if (!options?.settingsFlushed) {
			try {
				await this.ctx.settings.flush();
			} catch (err) {
				this.ctx.showError(`Failed to save pending settings: ${err instanceof Error ? err.message : String(err)}`);
				return false;
			}
		}
		if (switchingToDifferentSession && !detachedSessionHolder.has(sessionPath)) {
			const live = readSessionLiveState(sessionPath);
			if (live.fresh && live.pid !== process.pid) {
				this.ctx.showError(
					`Another proto process (pid ${live.pid}) is currently using this session — release it there before resuming here.`,
				);
				return false;
			}
		}

		const canPark =
			switchingToDifferentSession &&
			wasStreaming &&
			!!previousFile?.endsWith(".jsonl") &&
			this.ctx.settings.get("session.detachedMainSessions") !== false;

		let parkedOurs = false;
		if (canPark && previousFile) {
			detachedSessionHolder.park(previousFile, this.ctx.session, this.ctx.sessionManager);
			parkedOurs = true;
		}

		const parkedTarget = switchingToDifferentSession ? detachedSessionHolder.take(sessionPath) : undefined;

		const mutableCtx = this.ctx as unknown as { session: unknown; agent: unknown };
		let swappedIn = false;
		if (parkedTarget) {
			mutableCtx.session = parkedTarget.session;
			mutableCtx.agent = parkedTarget.session.agent;
			await this.ctx.attachSessionView(parkedTarget.session);
			AgentRegistry.global().attachSession(MAIN_AGENT_ID, parkedTarget.session, sessionPath);
			swappedIn = true;
		} else if (!parkedOurs) {
			await this.ctx.session.switchSession(sessionPath);
		} else if (previousFile) {
			let created: AgentSession;
			try {
				created = await this.#createResumedForegroundSession(sessionPath);
			} catch (error) {
				detachedSessionHolder.delete(previousFile);
				throw error;
			}
			mutableCtx.session = created;
			mutableCtx.agent = created.agent;
			await this.ctx.attachSessionView(created);
			swappedIn = true;
		}
		this.ctx.clearTransientSessionUi();
		const newCwd = this.ctx.sessionManager.getCwd();
		const movedProject = normalizePathForComparison(newCwd) !== normalizePathForComparison(previousCwd);
		if (movedProject) {
			await this.ctx.applyCwdChange(newCwd);
		}
		this.#refreshSessionTerminalTitle();
		this.ctx.updateEditorBorderColor();

		if (!swappedIn) {
			await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
		}
		await this.ctx.reloadTodos();

		const evicted = await detachedSessionHolder.evictLRU(8);
		const evictionNote =
			evicted.length > 0
				? ` · background limit reached — closed ${evicted.length} oldest session${evicted.length === 1 ? "" : "s"}`
				: "";
		let status: string;
		if (parkedOurs && previousFile) {
			status = `Parked ${shortenPath(previousFile)} — still thinking in background`;
		} else if (wasStreaming && switchingToDifferentSession && !parkedOurs && previousFile?.endsWith(".jsonl")) {
			status = `Interrupted ${shortenPath(previousFile)} — it was still thinking`;
		} else {
			status = movedProject ? `Resumed session in ${shortenPath(newCwd)}` : "Resumed session";
		}
		this.ctx.showStatus(`${status}${evictionNote}`);
		return true;
	}

	async #createResumedForegroundSession(sessionPath: string): Promise<AgentSession> {
		const manager = await SessionManager.open(sessionPath, undefined, undefined, {
			initialCwd: this.ctx.sessionManager.getCwd(),
		});
		const created = await createAgentSession({
			cwd: manager.getCwd(),
			sessionManager: manager,
			settings: this.ctx.settings,
			modelRegistry: this.ctx.session.modelRegistry,
			eventBus: this.ctx.eventBus,
			mcpManager: this.ctx.mcpManager,
			hasUI: true,
		});
		const uiContext = this.ctx.getToolUIContext();
		if (uiContext) created.setToolUIContext(uiContext, true);
		return created.session;
	}

	async handleSessionDeleteCommand(): Promise<void> {
		const sessionFile = this.ctx.sessionManager.getSessionFile();
		if (!sessionFile) {
			this.ctx.showError("No session file to delete (in-memory session)");
			return;
		}

		const storage = new FileSessionStorage();
		const fileExists = await storage.exists(sessionFile);
		if (!fileExists) {
			this.ctx.showError("Session has not been saved yet");
			return;
		}

		const confirmed = await this.ctx.showHookConfirm(
			"Delete Session",
			"This will permanently delete the current session.\nYou will be returned to the session selector.",
		);

		if (!confirmed) {
			this.ctx.showStatus("Delete cancelled");
			return;
		}

		if (!(await this.#detachActiveSessionBeforeDeletion(sessionFile))) {
			this.ctx.showStatus("Delete cancelled");
			return;
		}

		await storage.deleteSessionWithArtifacts(sessionFile);

		this.ctx.showStatus("Session deleted");
		await this.showSessionSelector();
	}

	async #handleOAuthLogin(providerId: string): Promise<boolean> {
		this.ctx.showStatus(`Logging in to ${providerId}…`);
		const useManualInput = isPasteCodeLoginProvider(providerId);
		let restored = false;
		const restoreEditor = () => {
			if (restored) return;
			restored = true;
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(this.ctx.editor);
			this.ctx.ui.setFocus(this.ctx.editor);
			this.ctx.ui.requestRender();
		};
		const dialog = new LoginDialogComponent(this.ctx.ui, providerId, (_success, message) => {
			restoreEditor();
			if (message) this.ctx.showStatus(message);
		});
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(dialog);
		this.ctx.ui.setFocus(dialog);
		this.ctx.ui.requestRender();
		try {
			const identity = await this.ctx.session.modelRegistry.authStorage.login(providerId as OAuthProvider, {
				signal: dialog.signal,
				onAuth: (info: { url: string; launchUrl?: string; instructions?: string }) => {
					dialog.showAuth(info.url, info.instructions, info.launchUrl);
				},
				onPrompt: (prompt: { message: string; placeholder?: string }) =>
					dialog.showPrompt(prompt.message, prompt.placeholder),
				onProgress: (message: string) => {
					dialog.showProgress(message);
				},

				onManualCodeInput: useManualInput ? () => dialog.showManualInput(MANUAL_LOGIN_PROMPT) : undefined,
			});

			await this.ctx.session.modelRegistry.refreshProvider(providerId, "online");
			const block = new TranscriptBlock();

			const whoBase = identity?.type === "oauth" ? (identity.email ?? identity.accountId) : undefined;
			const whoOrg = identity?.type === "oauth" ? (identity.orgName ?? identity.orgId) : undefined;
			const who = whoBase ? ` as ${whoBase}${whoOrg ? ` (${whoOrg})` : ""}` : whoOrg ? ` as ${whoOrg}` : "";
			block.addChild(
				new Text(
					theme.fg("success", `${theme.status.success} Successfully logged in to ${providerId}${who}`),
					1,
					0,
				),
			);
			block.addChild(new Text(theme.fg("dim", `Credentials saved to ${getAgentDbPath()}`), 1, 0));
			this.ctx.present(block);
			return true;
		} catch (error: unknown) {
			if (dialog.signal.aborted) {
				return false;
			}
			this.ctx.showError(`Login failed: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		} finally {
			restoreEditor();
		}
	}

	async #handleCredentialLogout(providerId: string, account: LogoutAccount): Promise<void> {
		try {
			const authStorage = this.ctx.session.modelRegistry.authStorage;
			const removed = await authStorage.removeCredential(providerId, account.credentialId);
			if (!removed) {
				this.ctx.showError(`Logout skipped: ${account.label} is no longer stored for ${providerId}.`);
				return;
			}

			await this.ctx.session.modelRegistry.refreshProvider(providerId, "online");
			const block = new TranscriptBlock();
			block.addChild(
				new Text(
					theme.fg(
						"success",
						`${theme.status.success} Successfully logged out ${account.label} from ${providerId}`,
					),
					1,
					0,
				),
			);
			block.addChild(new Text(theme.fg("dim", `Credential removed from ${getAgentDbPath()}`), 1, 0));
			const remainingSource = authStorage.describeCredentialSource(providerId, this.ctx.session.sessionId);
			if (remainingSource) {
				block.addChild(
					new Text(theme.fg("warning", `${providerId} is still authenticated via ${remainingSource}`), 1, 0),
				);
			}
			this.ctx.present(block);
		} catch (error: unknown) {
			this.ctx.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #showOAuthLogoutAccountSelector(providerId: string): Promise<void> {
		const authStorage = this.ctx.session.modelRegistry.authStorage;
		try {
			await authStorage.reload();
		} catch (error: unknown) {
			this.ctx.showError(
				`Could not load stored credentials: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		const provider = getOAuthProviders().find(candidate => candidate.id === providerId);
		const accounts = toLogoutAccounts(providerId, authStorage.listStoredCredentials(providerId), {
			activeIdentity: authStorage.getOAuthAccountIdentity(providerId, this.ctx.session.sessionId),
			activeApiKey: authStorage.getCredentialOrigin(providerId)?.kind === "api_key",
		});
		if (accounts.length === 0) {
			const source = authStorage.describeCredentialSource(providerId, this.ctx.session.sessionId);
			const suffix = source ? ` Current auth comes from ${source}; remove that source to log out.` : "";
			this.ctx.showError(`Logout skipped: no stored credentials for ${providerId}.${suffix}`);
			return;
		}

		this.showSelector(done => {
			const selector = new LogoutAccountSelectorComponent(
				provider?.name ?? providerId,
				accounts,
				account => {
					done();
					void this.#handleCredentialLogout(providerId, account);
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	async showOAuthSelector(mode: "login" | "logout", providerId?: string): Promise<void> {
		if (providerId) {
			if (mode === "login") {
				await this.#handleOAuthLogin(providerId);
			} else {
				await this.#showOAuthLogoutAccountSelector(providerId);
			}
			return;
		}

		if (mode === "logout") {
			await this.#refreshOAuthProviderAuthState();
			const oauthProviders = getOAuthProviders();
			const loggedInProviders = oauthProviders.filter(provider =>
				this.ctx.session.modelRegistry.authStorage.has(provider.id),
			);
			if (loggedInProviders.length === 0) {
				this.ctx.showStatus("No stored provider credentials to log out. Remove env or config auth at its source.");
				return;
			}
		}

		this.showSelector(done => {
			let selector: OAuthSelectorComponent;
			selector = new OAuthSelectorComponent(
				mode,
				this.ctx.session.modelRegistry.authStorage,
				async (selectedProviderId: string) => {
					selector.stopValidation();
					done();
					if (mode === "login") {
						await this.#handleOAuthLogin(selectedProviderId);
					} else {
						await this.#showOAuthLogoutAccountSelector(selectedProviderId);
					}
				},
				() => {
					selector.stopValidation();
					done();
					this.ctx.ui.requestRender();
				},
				{
					validateAuth: async (selectedProviderId: string) => {
						const apiKey = await this.ctx.session.modelRegistry.getApiKeyForProvider(
							selectedProviderId,
							this.ctx.session.sessionId,
						);
						return !!apiKey;
					},
					requestRender: () => {
						this.ctx.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector };
		});
	}

	async showResetUsageSelector(): Promise<void> {
		const session = this.ctx.session;
		this.ctx.showStatus("Checking saved rate-limit resets…", { dim: true });
		let statuses: ResetCreditAccountStatus[];
		try {
			statuses = await session.listResetCredits();
		} catch (error) {
			this.ctx.showError(`Could not load saved resets: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		const accounts = toResetUsageAccounts(statuses);
		if (accounts.length === 0) {
			this.ctx.showStatus("No Codex accounts found. Use /login to add one.");
			return;
		}
		if (!accounts.some(account => account.availableCount > 0)) {
			this.ctx.showStatus(
				accounts.some(account => account.error)
					? "No saved resets available — some accounts couldn't be reached (try /login)."
					: "No saved rate-limit resets available to spend right now.",
			);
			return;
		}
		this.showSelector(done => {
			const selector = new ResetUsageSelectorComponent(
				accounts,
				account => {
					done();
					void this.#redeemReset(account);
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	async #redeemReset(account: ResetUsageAccount): Promise<void> {
		this.ctx.showStatus(`Spending 1 saved reset for ${account.label}…`, { dim: true });
		let outcome: ResetCreditRedeemOutcome;
		try {
			outcome = await this.ctx.session.redeemResetCredit(account.target);
		} catch (error) {
			this.ctx.showError(
				`Reset failed for ${account.label}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		const message = describeRedeemOutcome(outcome, account.label);
		if (outcome.ok) {
			this.ctx.showStatus(message);

			this.ctx.statusLine.invalidate();
			this.ctx.ui.requestRender();
		} else {
			this.ctx.showWarning(message);
		}
	}

	showAgentFleet(
		observers: SessionObserverRegistry,
		options?: { requireContent?: boolean; armCloseTap?: boolean },
	): void {
		const fleetKeys = [
			...this.ctx.keybindings.getKeys("app.agents.fleet"),
			...this.ctx.keybindings.getKeys("app.session.observe"),
		];
		let overlayHandle: OverlayHandle | undefined;
		let closed = false;

		const done = () => {
			if (closed) return;
			closed = true;
			fleet.dispose();
			overlayHandle?.hide();

			if (overlayHandle) this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};

		const fleet = new AgentFleetOverlayComponent({
			observers,
			settings: this.ctx.settings,
			fleetKeys,
			expandKeys: this.ctx.keybindings.getKeys("app.tools.expand"),
			onDone: done,
			requestRender: () => this.ctx.ui.requestRender(),
			ui: this.ctx.ui,
			getTool: name => this.ctx.session.getToolByName(name),
			isBuiltInTool: name => this.ctx.session.hasBuiltInTool(name),
			getMessageRenderer: type => this.ctx.session.extensionRunner?.getMessageRenderer(type),
			hideThinkingBlock: () => this.ctx.effectiveHideThinkingBlock,
			proseOnlyThinking: () => this.ctx.proseOnlyThinking,
			focusAgent: id => this.ctx.focusAgentSession(id),
			sessionFile: this.ctx.sessionManager.getSessionFile() ?? null,
		});

		const showReadyFleet = () => {
			if (closed) return;

			if (options?.requireContent && fleet.isEmpty) {
				done();
				return;
			}

			if (options?.armCloseTap) fleet.armCloseTap();
			overlayHandle = this.#showFullscreenMenu(fleet);
		};

		if (options?.requireContent && fleet.isEmpty) {
			void fleet.persistedSubagentsReady.then(showReadyFleet);
		} else {
			showReadyFleet();
		}
	}
}
