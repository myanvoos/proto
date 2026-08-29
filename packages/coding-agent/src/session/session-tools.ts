import { AsyncLocalStorage } from "node:async_hooks";
import type { Agent, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { isRecord, logger, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { reset as resetCapabilities } from "../capability";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelString } from "../config/model-resolver";
import type { Settings, SkillsSettings } from "../config/settings";
import type { CustomTool, CustomToolContext } from "../extensibility/custom-tools/types";
import { CustomToolAdapter } from "../extensibility/custom-tools/wrapper";
import type { ExtensionRunner, SourceInfo, ToolInfo } from "../extensibility/extensions";
import { ExtensionToolWrapper } from "../extensibility/extensions/wrapper";
import { loadSkills, type Skill, type SkillWarning, setActiveSkills } from "../extensibility/skills";
import { type LocalProtocolOptions, XD_URL_PREFIX } from "../internal-urls";
import { deduplicateMCPToolsByName } from "../mcp/tool-bridge";
import xdevMountNoticePrompt from "../prompts/system/xdev-mount-notice.md" with { type: "text" };
import { usesCodexTaskPrompt } from "../task/prompt-policy";
import { DISABLED_TOOL_NAMES } from "../tools";
import { isMCPToolName, normalizeToolNames } from "../tools/builtin-names";
import { computerExposureMode } from "../tools/computer/exposure";
import { wrapToolWithMetaNotice } from "../tools/output-meta";
import { supportsExternalThinking } from "../tools/think";
import { isMountableUnderXdev, listXdevTools, type XdevState, xdevDocsFor, xdevEntries } from "../tools/xdev";
import { type EditMode, resolveEditMode } from "../utils/edit-mode";
import { type InspectImageMode, isInspectImageToolActive } from "../utils/inspect-image-mode";
import { buildToolNamespacesInfo, resolveCodeMode, type ToolNamespacesInfo } from "./code-mode";
import type { CustomMessage } from "./messages";
import type { SessionManager } from "./session-manager";

export interface SessionToolsHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	modelRegistry: ModelRegistry;
	extensionRunner(): ExtensionRunner | undefined;
	agentKind(): "main" | "sub";
	isDisposed(): boolean;
	isStreaming(): boolean;
	queuedMessageCount(): number;
	model(): Model | undefined;
	clearInheritedProviderPromptCacheKey(): void;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	notifyCommandMetadataChanged(): void;
	localProtocolOptions(): LocalProtocolOptions;

	getInspectImageModeOverride(): InspectImageMode | undefined;
	setInspectImageModeOverride(mode: InspectImageMode | undefined): void;

	setCodeModeNamespacesInfo?(info: unknown): void;
}

interface SessionToolsOptions {
	toolRegistry?: Map<string, AgentTool>;
	createComputerTool?: () => Promise<AgentTool | null>;

	createThinkTool?: () => Promise<AgentTool | null>;

	createInspectImageTool?: () => Promise<AgentTool | null>;
	builtInToolNames?: Iterable<string>;
	presentationPinnedToolNames?: ReadonlySet<string>;
	requiredToolNames?: ReadonlySet<string>;

	mcpManagerToolNames?: Iterable<string>;
	ensureWriteRegistered?: () => Promise<boolean>;
	rebuildSystemPrompt?: (
		toolNames: string[],
		tools: Map<string, AgentTool>,
		options?: { directToolNames?: readonly string[] },
	) => Promise<{ systemPrompt: string[]; xdevCatalogNames?: readonly string[] }>;
	getMcpServerInstructions?: () => Map<string, string> | undefined;
	xdev?: XdevState;
	setActiveToolNames?: (names: Iterable<string>) => void;
	baseSystemPrompt: string[];
	skills?: Skill[];
	skillWarnings?: SkillWarning[];
	skillsSettings?: SkillsSettings;
	skillsReloadable?: boolean;
}

interface MountedMCPToolRouteSource {
	readonly name: string;
	readonly mcpServerName?: unknown;
	readonly mcpToolName?: unknown;
}

interface MountedMCPToolRoute {
	readonly mcpServerName: string;
	readonly mcpToolName: string;
	readonly name: string;
}

interface MCPXdevGuidanceMapping extends MountedMCPToolRoute {
	readonly label: string;
	readonly path: string;
}

interface MCPXdevGuidanceProjection {
	readonly mappings: readonly MCPXdevGuidanceMapping[];
	readonly hasOmittedMappings: boolean;
}

const MAX_MCP_XDEV_GUIDANCE_MAPPING_DATA_LENGTH = 4000;
const MAX_MCP_XDEV_GUIDANCE_MAPPINGS = 64;

export function* collectMountedMCPToolRoutes(
	tools: Iterable<MountedMCPToolRouteSource>,
): Generator<MountedMCPToolRoute> {
	for (const tool of tools) {
		if (typeof tool.mcpServerName !== "string" || typeof tool.mcpToolName !== "string") continue;
		yield {
			mcpServerName: tool.mcpServerName,
			mcpToolName: tool.mcpToolName,
			name: tool.name,
		};
	}
}

function formatMCPXdevGuidanceLabel(label: string): string {
	return (JSON.stringify(label) ?? '""')
		.replaceAll("`", "\\u0060")
		.replaceAll("\u2028", "\\u2028")
		.replaceAll("\u2029", "\\u2029");
}

export function projectMountedMCPXdevGuidance(routes: Iterable<MountedMCPToolRoute>): MCPXdevGuidanceProjection {
	const mappings: MCPXdevGuidanceMapping[] = [];
	let remainingMappingDataLength = MAX_MCP_XDEV_GUIDANCE_MAPPING_DATA_LENGTH;
	let hasOmittedMappings = false;
	for (const route of routes) {
		const rawMappingDataLength = route.mcpToolName.length + XD_URL_PREFIX.length + route.name.length;
		if (mappings.length >= MAX_MCP_XDEV_GUIDANCE_MAPPINGS || rawMappingDataLength > remainingMappingDataLength) {
			hasOmittedMappings = true;
			continue;
		}
		const label = formatMCPXdevGuidanceLabel(route.mcpToolName);
		const path = `${XD_URL_PREFIX}${route.name}`;
		const mappingDataLength = label.length + path.length;
		if (mappingDataLength > remainingMappingDataLength) {
			hasOmittedMappings = true;
			continue;
		}
		mappings.push({ ...route, label, path });
		remainingMappingDataLength -= mappingDataLength;
	}
	return { mappings, hasOmittedMappings };
}

const XDEV_MOUNT_NOTICE_MESSAGE_TYPE = "xdev-mount-notice";

interface XdevMountNoticeDetails {
	added: string[];
	removed: string[];
}

export class SessionTools {
	readonly #host: SessionToolsHost;
	#toolRegistry: Map<string, AgentTool>;
	#createComputerTool: SessionToolsOptions["createComputerTool"];
	#createThinkTool: SessionToolsOptions["createThinkTool"];
	#createInspectImageTool: SessionToolsOptions["createInspectImageTool"];
	#builtInToolNames: Set<string>;
	#rpcHostToolNames = new Set<string>();
	#mcpManagerToolNames = new Set<string>();
	#extensionMcpTools = new Map<string, AgentTool>();
	#xdev: XdevState | undefined;
	#pendingXdevMountDelta: { added: Set<string>; removed: Set<string> } | undefined;

	#announcedMounts = new Set<string>();
	#announcedMountsSeeded = false;
	#presentationPinnedToolNames: ReadonlySet<string> | undefined;
	#requiredToolNames: ReadonlySet<string>;
	#runtimeSelectedToolNames: ReadonlySet<string> | undefined;
	#baseSystemPrompt: string[];

	#turnSystemPromptOverride: string[] | undefined;
	#lastAppliedToolSignature: string | undefined;

	#enabledToolNames = new Set<string>();

	#toolPredicateNames: readonly string[] | undefined;

	#codeModeDirectWireSignature: string | undefined;

	#codeModeDirectToolNames: readonly string[] | undefined;

	#basePromptXdevNames: ReadonlySet<string> = new Set();
	#toolRegistryMutationScope = new AsyncLocalStorage<boolean>();
	#toolRegistryMutationTail: Promise<void> = Promise.resolve();
	#promptModelKey: string | undefined;
	#rebuildSystemPrompt: SessionToolsOptions["rebuildSystemPrompt"];
	#getMcpServerInstructions: SessionToolsOptions["getMcpServerInstructions"];
	#setActiveToolNames: SessionToolsOptions["setActiveToolNames"];
	#ensureWriteRegistered: SessionToolsOptions["ensureWriteRegistered"];
	#skills: Skill[];
	#skillWarnings: SkillWarning[];
	#skillsSettings: SkillsSettings | undefined;
	#skillsReloadable: boolean;

	constructor(host: SessionToolsHost, options: SessionToolsOptions) {
		this.#host = host;
		this.#toolRegistry = options.toolRegistry ?? new Map();
		this.#createComputerTool = options.createComputerTool;
		this.#createThinkTool = options.createThinkTool;
		this.#createInspectImageTool = options.createInspectImageTool;
		this.#builtInToolNames = new Set(options.builtInToolNames ?? []);
		this.#mcpManagerToolNames = new Set(options.mcpManagerToolNames ?? []);
		if (options.mcpManagerToolNames === undefined) {
			for (const name of this.#toolRegistry.keys()) {
				if (isMCPToolName(name)) this.#mcpManagerToolNames.add(name);
			}
		}
		for (const [name, tool] of this.#toolRegistry) {
			if (isMCPToolName(name) && !this.#mcpManagerToolNames.has(name)) {
				this.#extensionMcpTools.set(name, tool);
			}
		}
		this.#presentationPinnedToolNames = options.presentationPinnedToolNames;
		this.#requiredToolNames = options.requiredToolNames ?? new Set();
		this.#ensureWriteRegistered = options.ensureWriteRegistered;
		this.#rebuildSystemPrompt = options.rebuildSystemPrompt;
		this.#getMcpServerInstructions = options.getMcpServerInstructions;
		this.#xdev = options.xdev;
		if (this.#xdev && this.#xdev.tools !== this.#toolRegistry) {
			throw new Error("xd:// state must reference the canonical session tool map");
		}
		this.#setActiveToolNames = options.setActiveToolNames;
		this.#baseSystemPrompt = options.baseSystemPrompt;
		this.#skills = options.skills ?? [];
		this.#skillWarnings = options.skillWarnings ?? [];
		this.#skillsSettings = options.skillsSettings;
		this.#skillsReloadable = options.skillsReloadable ?? true;
		this.#promptModelKey = this.#currentPromptModelKey();
	}

	get registry(): Map<string, AgentTool> {
		return this.#toolRegistry;
	}

	get baseSystemPrompt(): string[] {
		return this.#baseSystemPrompt;
	}

	setBaseSystemPrompt(prompt: string[]): void {
		this.#baseSystemPrompt = prompt;
	}

	#applyAgentSystemPrompt(base: string[]): void {
		this.#host.agent.setSystemPrompt(this.#turnSystemPromptOverride ?? base);
	}

	setTurnSystemPromptOverride(prompt: string[]): void {
		this.#turnSystemPromptOverride = prompt;
		this.#host.agent.setSystemPrompt(prompt);
	}

	clearTurnSystemPromptOverride(): void {
		this.#turnSystemPromptOverride = undefined;
	}

	get skills(): Skill[] {
		return this.#skills;
	}

	get skillWarnings(): SkillWarning[] {
		return this.#skillWarnings;
	}

	get skillsSettings(): SkillsSettings | undefined {
		return this.#skillsSettings;
	}

	#getActiveNonMCPToolNames(): string[] {
		return this.getEnabledToolNames().filter(name => !isMCPToolName(name) && this.#toolRegistry.has(name));
	}

	getActiveToolNames(): string[] {
		return this.#host.agent.state.tools.map(t => t.name);
	}

	getEnabledToolNames(): string[] {
		if (this.#enabledToolNames.size > 0) return [...this.#enabledToolNames];
		const mountedNames = this.#xdev?.mountedNames;
		if (!mountedNames || mountedNames.size === 0) return this.getActiveToolNames();
		return [...this.getActiveToolNames(), ...mountedNames];
	}

	getMountedXdevToolNames(): string[] {
		return [...(this.#xdev?.mountedNames ?? [])];
	}

	get hasEditTool(): boolean {
		return this.#toolRegistry.has("edit");
	}

	getToolByName(name: string): AgentTool | undefined {
		return this.#toolRegistry.get(name);
	}

	getToolForEvalBridge(name: string): AgentTool | undefined {
		if (
			!this.getEnabledToolNames().includes(name) &&
			!(name in DISABLED_TOOL_NAMES && this.#toolRegistry.has(name))
		) {
			return undefined;
		}
		return this.#toolRegistry.get(name);
	}

	getEvalBridgeToolNames(): string[] {
		return this.getEnabledToolNames();
	}

	getCodeModeDirectToolNames(): readonly string[] | undefined {
		return this.#codeModeDirectToolNames;
	}

	#hasCodeModeEvalTransport(): boolean {
		const evalTool = this.#toolRegistry.get("eval") as
			| (AgentTool & { supportsCodeModeTransport?: () => boolean })
			| undefined;
		if (!evalTool) return false;

		return evalTool.supportsCodeModeTransport?.() ?? false;
	}

	hasBuiltInTool(name: string): boolean {
		if (this.#builtInToolNames.has(name)) return true;
		if (this.#toolRegistry.has(name)) return false;
		for (const builtInName of this.#builtInToolNames) {
			if (this.#toolRegistry.get(builtInName)?.customWireName === name) return true;
		}
		return false;
	}

	setToolBuiltIn(name: string, builtIn: boolean): void {
		if (builtIn) {
			this.#builtInToolNames.add(name);
		} else {
			this.#builtInToolNames.delete(name);
		}
	}

	hasRpcHostTool(name: string): boolean {
		return this.#rpcHostToolNames.has(name);
	}

	hasMCPManagerTool(name: string): boolean {
		return this.#mcpManagerToolNames.has(name);
	}

	setMCPManagerTool(name: string, managerOwned: boolean): void {
		if (managerOwned) {
			this.#mcpManagerToolNames.add(name);
		} else {
			this.#mcpManagerToolNames.delete(name);
		}
	}

	getExtensionMCPTool(name: string): AgentTool | undefined {
		return this.#extensionMcpTools.get(name);
	}

	setExtensionMCPTool(name: string, tool: AgentTool | undefined): void {
		if (!isMCPToolName(name)) return;
		if (tool) {
			this.#extensionMcpTools.set(name, tool);
			this.#mcpManagerToolNames.delete(name);
		} else {
			this.#extensionMcpTools.delete(name);
		}
	}

	runToolRegistryMutation<T>(mutation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (this.#toolRegistryMutationScope.getStore()) return untilAborted(signal, mutation);
		const serialized = this.#toolRegistryMutationTail.then(() => {
			signal?.throwIfAborted();
			return this.#toolRegistryMutationScope.run(true, mutation);
		});
		const operation = untilAborted(signal, serialized);
		this.#toolRegistryMutationTail = serialized.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	getAllToolNames(): string[] {
		return Array.from(this.#toolRegistry.keys());
	}

	getAllToolInfos(): ToolInfo[] {
		return Array.from(this.#toolRegistry, ([name, tool]) => {
			const source = this.#builtInToolNames.has(name)
				? "builtin"
				: isMCPToolName(name)
					? "mcp"
					: this.#rpcHostToolNames.has(name)
						? "sdk"
						: "extension";
			const sourceInfo: SourceInfo = {
				path: `<${source}:${name}>`,
				source,
				scope: "temporary",
				origin: "top-level",
			};
			return { name, description: tool.description, parameters: tool.parameters, sourceInfo };
		});
	}

	#wrapRuntimeTool(tool: AgentTool): AgentTool {
		const wrapped = wrapToolWithMetaNotice(tool);
		const extensionRunner = this.#host.extensionRunner();
		return extensionRunner ? new ExtensionToolWrapper(wrapped, extensionRunner) : wrapped;
	}

	#getEditModeSession() {
		return {
			settings: this.#host.settings,
			getActiveModelString: () => {
				const model = this.#host.model();
				return model ? formatModelString(model) : undefined;
			},
		} as const;
	}

	resolveActiveEditMode(): EditMode {
		return resolveEditMode(this.#getEditModeSession());
	}

	#currentPromptModelKey(): string | undefined {
		const activeModel = this.#host.model();
		const model = activeModel ? formatModelString(activeModel) : undefined;
		if (!model || this.#host.settings.get("includeModelInPrompt")) return model;
		return usesCodexTaskPrompt(model) ? "task-policy:gpt-5.6" : "task-policy:default";
	}

	#logComputerState(message: string, enabled: boolean): void {
		const model = this.#host.model();
		logger.debug(message, {
			enabled,
			active: this.getEnabledToolNames().includes("computer"),
			model: model ? formatModelString(model) : undefined,
			exposure: computerExposureMode(model),
		});
	}

	async syncAfterModelChange(previousEditMode: EditMode): Promise<void> {
		const currentEditMode = this.resolveActiveEditMode();
		const editModeChanged = previousEditMode !== currentEditMode && this.getActiveToolNames().includes("edit");

		const modelChanged = this.#currentPromptModelKey() !== this.#promptModelKey;
		if (editModeChanged || modelChanged) {
			await this.refreshBaseSystemPrompt();
		}
		const computerExpected = this.#host.settings.get("computer.enabled");
		const computerActive = this.getEnabledToolNames().includes("computer");
		if (computerExpected && !computerActive) {
			const model = this.#host.model();
			const modelName = model ? formatModelString(model) : "the current model";

			logger.warn("Enabled computer tool missing after model change", { model: modelName });
			this.#host.emitNotice(
				"warning",
				`Computer use remains enabled, but the computer tool is unavailable to ${modelName}.`,
				"computer",
			);
		} else if (computerExpected) {
			this.#logComputerState("Computer tool retained after model change", true);
		}

		await this.reconcileInspectImageAfterModelChange();
	}

	codeModeChangesBetween(previousModel: Model | undefined, nextModel: Model): boolean {
		const enabledToolNames = this.getEnabledToolNames();
		const setting = this.#host.settings.get("providers.openai-codex.codeMode");
		const extraDirectTools = this.#host.settings.get("providers.openai-codex.codeModeDirectTools");
		const resolve = (model: Model | undefined) =>
			resolveCodeMode({
				provider: model?.provider ?? "",
				toolMode: model?.toolMode,
				setting,
				extraDirectTools,
				enabledToolNames,
				evalTransportAvailable: this.#hasCodeModeEvalTransport(),
			});
		const previous = resolve(previousModel);
		const next = resolve(nextModel);
		if (previous.active !== next.active) return true;
		if (!next.active) return false;
		if (previous.directToolNames.size !== next.directToolNames.size) return true;
		for (const name of previous.directToolNames) {
			if (!next.directToolNames.has(name)) return true;
		}
		return false;
	}

	codeModeDirectWireMetadataChanged(): boolean {
		if (this.#codeModeDirectWireSignature === undefined) return false;
		return this.#codeModeDirectWireSignature !== this.#computeCodeModeDirectWireSignature(this.getActiveToolNames());
	}

	#computeCodeModeDirectWireSignature(toolNames: readonly string[]): string {
		let signature = "";
		for (const name of toolNames) {
			const tool = this.#toolRegistry.get(name);
			signature += `${name}\u0000${tool?.customWireName ?? name}\u0001`;
		}
		return signature;
	}

	reconcileCodeMode(): Promise<void> {
		return this.applyActiveToolsByName(this.getEnabledToolNames());
	}

	getSelectedMCPToolNames(): string[] {
		return this.getEnabledToolNames().filter(name => isMCPToolName(name) && this.#toolRegistry.has(name));
	}

	applyActiveToolsByName(toolNames: string[], forcePromptRefresh = false, signal?: AbortSignal): Promise<void> {
		return this.runToolRegistryMutation(
			() => this.#applyActiveToolsByName(toolNames, forcePromptRefresh, signal),
			signal,
		);
	}

	async #applyActiveToolsByName(toolNames: string[], forcePromptRefresh = false, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		toolNames = normalizeToolNames([...toolNames, ...this.#requiredToolNames]);
		const codeMode = resolveCodeMode({
			provider: this.#host.model()?.provider ?? "",
			toolMode: this.#host.model()?.toolMode,
			setting: this.#host.settings.get("providers.openai-codex.codeMode"),
			extraDirectTools: this.#host.settings.get("providers.openai-codex.codeModeDirectTools"),
			enabledToolNames: toolNames,
			evalTransportAvailable: this.#hasCodeModeEvalTransport(),
		});
		let builtInWriteAvailable = this.#builtInToolNames.has("write");
		if (toolNames.includes("write") && !builtInWriteAvailable) {
			const writeRegistration = this.#ensureWriteRegistered?.();
			builtInWriteAvailable = writeRegistration ? (await untilAborted(signal, writeRegistration)) === true : false;
			if (builtInWriteAvailable) this.#builtInToolNames.add("write");
		}
		const selectedTools = toolNames.flatMap(name => {
			const tool = this.#toolRegistry.get(name);
			return tool ? [{ name, tool }] : [];
		});
		const xdevReadAvailable = this.#builtInToolNames.has("read") && selectedTools.some(({ name }) => name === "read");
		const xdevWriteAvailable = builtInWriteAvailable && selectedTools.some(({ name }) => name === "write");
		const isPresentationPinned = (name: string): boolean =>
			this.#presentationPinnedToolNames?.has(name) === true || this.#runtimeSelectedToolNames?.has(name) === true;
		const mountCandidates = selectedTools.filter(
			({ name, tool }) =>
				this.#xdev !== undefined &&
				xdevReadAvailable &&
				xdevWriteAvailable &&
				!isPresentationPinned(name) &&
				isMountableUnderXdev(tool),
		);
		const mountNames = new Set(mountCandidates.map(({ name }) => name));

		if (codeMode.active) mountNames.clear();
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const { name, tool } of selectedTools) {
			if (mountNames.has(name)) continue;
			tools.push(tool);
			validToolNames.push(name);
		}

		const pinnedWrite = isPresentationPinned("write");
		const activeDeferrableTool = tools.some(tool => tool.deferrable === true);
		const transportNeeded = mountNames.size > 0 || activeDeferrableTool;
		if (transportNeeded && !builtInWriteAvailable) {
			const writeRegistration = this.#ensureWriteRegistered?.();
			builtInWriteAvailable = writeRegistration ? (await untilAborted(signal, writeRegistration)) === true : false;
			if (builtInWriteAvailable) this.#builtInToolNames.add("write");
		}
		if (transportNeeded && builtInWriteAvailable) {
			const write = this.#toolRegistry.get("write");
			if (write && !validToolNames.includes("write")) {
				tools.push(write);
				validToolNames.push("write");
			}
		} else if (
			!pinnedWrite &&
			(this.#presentationPinnedToolNames !== undefined || this.#runtimeSelectedToolNames !== undefined)
		) {
			const writeNameIndex = validToolNames.indexOf("write");
			if (writeNameIndex >= 0 && this.#builtInToolNames.has("write")) validToolNames.splice(writeNameIndex, 1);
			const writeToolIndex = tools.findIndex(tool => tool.name === "write" && this.#builtInToolNames.has("write"));
			if (writeToolIndex >= 0) tools.splice(writeToolIndex, 1);
		}

		let appliedTools = tools;
		let appliedNames = validToolNames;
		let nextCodeModeNamespacesInfo: ToolNamespacesInfo | undefined;
		if (codeMode.active) {
			for (const name of this.#requiredToolNames) codeMode.directToolNames.add(name);

			if (transportNeeded && validToolNames.includes("write")) codeMode.directToolNames.add("write");
			appliedTools = tools.filter(tool => codeMode.directToolNames.has(tool.name));
			appliedNames = validToolNames.filter(name => codeMode.directToolNames.has(name));
			nextCodeModeNamespacesInfo = buildToolNamespacesInfo({
				tools: validToolNames.flatMap(name => {
					const tool = this.#toolRegistry.get(name);
					if (!tool) return [];
					return [
						{
							name,
							customWireName: tool.customWireName,
							loadMode: "loadMode" in tool && typeof tool.loadMode === "string" ? tool.loadMode : undefined,
							mcpServerName:
								"mcpServerName" in tool && typeof tool.mcpServerName === "string"
									? tool.mcpServerName
									: undefined,
						},
					];
				}),
				directToolNames: codeMode.directToolNames,
			});
		}
		const previousMounted = new Set(this.#xdev?.mountedNames ?? []);
		const previousActiveToolNames = this.getActiveToolNames();
		const previousEnabledToolNames = this.#enabledToolNames;
		const previousCodeModeDirectToolNames = this.#codeModeDirectToolNames;
		const previousToolPredicateNames = this.#toolPredicateNames;
		this.#enabledToolNames = new Set([...validToolNames, ...mountNames]);
		this.#setMountedNames(mountNames);
		this.#toolPredicateNames = codeMode.active ? [...this.#enabledToolNames] : appliedNames;
		this.#setActiveToolNames?.(this.#toolPredicateNames);

		this.#codeModeDirectToolNames = codeMode.active ? appliedNames : undefined;

		let rebuiltSystemPrompt: string[] | undefined;
		let rebuiltSignature: string | undefined;
		let rebuiltXdevCatalogNames: readonly string[] | undefined;
		try {
			if (this.#rebuildSystemPrompt) {
				const promptToolNames = codeMode.active ? [...this.#enabledToolNames] : appliedNames;
				const promptTools = codeMode.active
					? promptToolNames.flatMap(name => {
							const tool = this.#toolRegistry.get(name);
							return tool ? [tool] : [];
						})
					: appliedTools;
				const directToolNames = codeMode.active ? appliedNames : undefined;
				const signature = this.#computeAppliedToolSignature(promptToolNames, promptTools, directToolNames);
				if (forcePromptRefresh || signature !== this.#lastAppliedToolSignature) {
					const built = await untilAborted(
						signal,
						this.#rebuildSystemPrompt(promptToolNames, this.#toolRegistry, { directToolNames }),
					);
					rebuiltSystemPrompt = built.systemPrompt;
					rebuiltSignature = signature;
					rebuiltXdevCatalogNames = built.xdevCatalogNames;
				}
			}
			signal?.throwIfAborted();
		} catch (error) {
			this.#setMountedNames(previousMounted);
			this.#toolPredicateNames = previousToolPredicateNames;
			this.#setActiveToolNames?.(previousToolPredicateNames ?? previousActiveToolNames);
			this.#enabledToolNames = previousEnabledToolNames;
			this.#codeModeDirectToolNames = previousCodeModeDirectToolNames;
			throw error;
		}

		if (this.#host.isDisposed()) {
			this.#setMountedNames(previousMounted);
			this.#toolPredicateNames = previousToolPredicateNames;
			this.#setActiveToolNames?.(previousToolPredicateNames ?? previousActiveToolNames);
			this.#enabledToolNames = previousEnabledToolNames;
			this.#codeModeDirectToolNames = previousCodeModeDirectToolNames;
			return;
		}

		this.#notifyXdevMountDelta(previousMounted);
		this.#host.agent.setTools(appliedTools);
		this.#host.setCodeModeNamespacesInfo?.(nextCodeModeNamespacesInfo);
		this.#codeModeDirectWireSignature = codeMode.active
			? this.#computeCodeModeDirectWireSignature(appliedNames)
			: undefined;
		if (rebuiltSystemPrompt && rebuiltSignature) {
			if (this.#lastAppliedToolSignature !== undefined) this.#host.clearInheritedProviderPromptCacheKey();
			this.#baseSystemPrompt = rebuiltSystemPrompt;
			this.#applyAgentSystemPrompt(this.#baseSystemPrompt);
			this.#lastAppliedToolSignature = rebuiltSignature;
			this.#promptModelKey = this.#currentPromptModelKey();
			this.#basePromptXdevNames = new Set(rebuiltXdevCatalogNames);
		}
	}

	#setMountedNames(names: Iterable<string>): void {
		const mountedNames = this.#xdev?.mountedNames;
		if (!mountedNames) return;
		mountedNames.clear();
		for (const name of names) mountedNames.add(name);
	}

	#notifyXdevMountDelta(previousMounted: ReadonlySet<string>): void {
		const current = this.#xdev?.mountedNames;
		if (!current) return;
		const addedNames = [...current].filter(name => !previousMounted.has(name));
		const removedNames = [...previousMounted].filter(name => !current.has(name));
		if (addedNames.length === 0 && removedNames.length === 0) return;

		const pending = this.#pendingXdevMountDelta ?? { added: new Set<string>(), removed: new Set<string>() };
		for (const name of addedNames) {
			if (!pending.removed.delete(name)) pending.added.add(name);
		}
		for (const name of removedNames) {
			if (!pending.added.delete(name)) pending.removed.add(name);
		}
		this.#pendingXdevMountDelta = pending.added.size > 0 || pending.removed.size > 0 ? pending : undefined;
		if (this.#host.settings.get("startup.quiet")) return;
		const parts: string[] = [];
		if (addedNames.length > 0) parts.push(`mounted ${addedNames.join(", ")}`);
		if (removedNames.length > 0) parts.push(`unmounted ${removedNames.join(", ")}`);
		this.#host.emitNotice("info", `xd://: ${parts.join("; ")}`, "xdev");
	}

	resetAnnouncedMounts(): void {
		this.#announcedMounts.clear();
		this.#announcedMountsSeeded = false;
	}

	#ensureAnnouncedMountsSeeded(): void {
		if (this.#announcedMountsSeeded) return;
		this.#announcedMountsSeeded = true;
		for (const message of this.#host.agent.state.messages) {
			if (message.role !== "custom" || message.customType !== XDEV_MOUNT_NOTICE_MESSAGE_TYPE) continue;
			const details = message.details;
			if (
				isRecord(details) &&
				Array.isArray(details.added) &&
				details.added.every(name => typeof name === "string") &&
				Array.isArray(details.removed) &&
				details.removed.every(name => typeof name === "string")
			) {
				for (const name of details.added) this.#announcedMounts.add(name);
				for (const name of details.removed) this.#announcedMounts.delete(name);
				continue;
			}

			if (typeof message.content !== "string") continue;
			let section: "added" | "removed" | undefined;
			for (const line of message.content.split("\n")) {
				if (line === "These tools became available:") {
					section = "added";
					continue;
				}
				if (line.startsWith("No longer mounted")) {
					section = "removed";
					continue;
				}
				if (line === "Configured inline device docs:" || line === "</system-notice>") break;
				if (line.startsWith("Read `xd://<tool>`")) {
					section = undefined;
					continue;
				}
				if (!section) continue;
				const match = /^- xd:\/\/(\S+?)(?:\s+—|$)/.exec(line);
				const name = match?.[1];
				if (!name) continue;
				if (section === "added") this.#announcedMounts.add(name);
				else this.#announcedMounts.delete(name);
			}
		}
	}

	takePendingXdevMountNotice(baseCatalogDelivered: boolean): CustomMessage<XdevMountNoticeDetails> | undefined {
		const pending = this.#pendingXdevMountDelta;
		if (!pending) return undefined;
		this.#pendingXdevMountDelta = undefined;
		this.#ensureAnnouncedMountsSeeded();

		if (baseCatalogDelivered) {
			for (const name of pending.added) {
				if (this.#basePromptXdevNames.has(name)) this.#announcedMounts.add(name);
			}
		}

		const addedNames = [...pending.added].filter(name => !this.#announcedMounts.has(name));
		const removedNames = [...pending.removed].filter(name => this.#announcedMounts.has(name));
		if (addedNames.length === 0 && removedNames.length === 0) return undefined;
		const summaries = new Map(this.#xdev ? xdevEntries(this.#xdev).map(entry => [entry.name, entry.summary]) : []);
		const added = addedNames.map(name => ({ name, summary: summaries.get(name) ?? "" }));
		const removed = removedNames.map(name => ({ name }));
		const docs = this.#xdev
			? xdevDocsFor(
					this.#xdev,
					new Set(addedNames),
					this.#host.settings.get("tools.xdevDocs"),
					this.#host.settings.get("tools.xdevInlineDevices"),
				)
			: "";
		for (const name of addedNames) this.#announcedMounts.add(name);
		for (const name of removedNames) this.#announcedMounts.delete(name);
		return {
			role: "custom",
			customType: XDEV_MOUNT_NOTICE_MESSAGE_TYPE,
			content: prompt.render(xdevMountNoticePrompt, { added, removed, docs }),
			details: { added: addedNames, removed: removedNames },
			attribution: "agent",
			display: false,
			timestamp: Date.now(),
		};
	}

	async refreshSkills(): Promise<void> {
		resetCapabilities();
		if (this.#skillsReloadable) {
			const skillsSettings = this.#host.settings.getGroup("skills");
			const discovered = await loadSkills({
				...skillsSettings,
				cwd: this.#host.sessionManager.getCwd(),
				disabledExtensions: this.#host.settings.get("disabledExtensions") ?? [],
			});
			this.#skills = discovered.skills;
			this.#skillWarnings = discovered.warnings;
			this.#skillsSettings = skillsSettings;

			if (this.#host.agentKind() === "main") {
				setActiveSkills(this.#skills);
			}
		}
		await this.refreshBaseSystemPrompt();
		this.#host.notifyCommandMetadataChanged();
	}

	setActiveToolsByName(toolNames: string[]): Promise<void> {
		return this.runToolRegistryMutation(async () => {
			const normalized = normalizeToolNames(toolNames);

			await this.#applyToolPresentation(
				normalized,
				this.#xdev?.mountedNames ?? new Set(),
				this.getActiveToolNames().includes("write"),
			);
		});
	}

	setActiveToolPresentation(
		toolNames: string[],
		mountedToolNames: string[],
		forcePromptRefresh = false,
		signal?: AbortSignal,
	): Promise<void> {
		return this.runToolRegistryMutation(async () => {
			const normalized = normalizeToolNames(toolNames);

			await this.#applyToolPresentation(
				normalized,
				new Set(normalizeToolNames(mountedToolNames)),
				normalized.includes("write"),
				forcePromptRefresh,
				signal,
			);
		}, signal);
	}

	async #applyToolPresentation(
		normalized: string[],
		mounted: ReadonlySet<string>,
		writeSelected: boolean,
		forcePromptRefresh = false,
		signal?: AbortSignal,
	): Promise<void> {
		const transportWriteActive =
			writeSelected &&
			this.#builtInToolNames.has("write") &&
			this.#presentationPinnedToolNames?.has("write") !== true &&
			mounted.size > 0;
		const previousRuntimeSelectedToolNames = this.#runtimeSelectedToolNames;
		this.#runtimeSelectedToolNames = new Set(
			normalized.filter(name => !mounted.has(name) && !(name === "write" && transportWriteActive)),
		);
		try {
			await this.#applyActiveToolsByName(normalized, forcePromptRefresh, signal);
		} catch (error) {
			this.#runtimeSelectedToolNames = previousRuntimeSelectedToolNames;
			throw error;
		}
	}

	setComputerToolEnabled(enabled: boolean): Promise<boolean> {
		return this.runToolRegistryMutation(async () => {
			const logState = (): void => this.#logComputerState("Computer tool state changed", enabled);
			const active = this.getEnabledToolNames();
			if (!enabled) {
				if (active.includes("computer")) {
					await this.#applyActiveToolsByName(active.filter(name => name !== "computer"));
				}
				logState();
				return true;
			}
			if (!this.#toolRegistry.has("computer")) {
				const tool = await this.#createComputerTool?.();
				if (tool?.name !== "computer") {
					const model = this.#host.model();
					logger.warn("Computer tool could not be created", {
						model: model ? formatModelString(model) : undefined,
					});
					return false;
				}
				const wrapped = this.#wrapRuntimeTool(tool);
				this.#toolRegistry.set(wrapped.name, wrapped);
				this.#builtInToolNames.add(wrapped.name);
			}
			if (!active.includes("computer")) {
				await this.#applyActiveToolsByName([...active, "computer"]);
			}
			logState();
			return true;
		});
	}

	setThinkToolEnabled(enabled: boolean): Promise<boolean> {
		return this.#setThinkToolActive(enabled && supportsExternalThinking(this.#host.model()));
	}

	reconcileThinkTool(): Promise<boolean> {
		return this.#setThinkToolActive(
			this.#host.settings.get("externalThinking") && supportsExternalThinking(this.#host.model()),
		);
	}

	#setThinkToolActive(enabled: boolean): Promise<boolean> {
		return this.runToolRegistryMutation(async () => {
			const active = this.getEnabledToolNames();
			if (!enabled) {
				if (active.includes("think")) {
					await this.#applyActiveToolsByName(active.filter(name => name !== "think"));
				}
				return true;
			}
			if (!this.#toolRegistry.has("think")) {
				const tool = await this.#createThinkTool?.();
				if (tool?.name !== "think") return false;
				const wrapped = this.#wrapRuntimeTool(tool);
				this.#toolRegistry.set(wrapped.name, wrapped);
				this.#builtInToolNames.add(wrapped.name);
			}
			if (!active.includes("think")) {
				await this.#applyActiveToolsByName([...active, "think"]);
			}
			return true;
		});
	}

	inspectImageState(): { mode: InspectImageMode; active: boolean; model: string | undefined } {
		const model = this.#host.model();
		return {
			mode: this.#host.getInspectImageModeOverride() ?? this.#host.settings.get("inspect_image.mode"),
			active: this.getEnabledToolNames().includes("inspect_image"),
			model: model ? formatModelString(model) : undefined,
		};
	}

	reconcileInspectImageTool(): Promise<boolean> {
		return this.runToolRegistryMutation(async () => {
			const expected = isInspectImageToolActive({
				settings: this.#host.settings,
				getActiveModel: () => this.#host.model(),
				getInspectImageModeOverride: () => this.#host.getInspectImageModeOverride(),
			});

			const syncReadDescription = (available: boolean): void => {
				const readTool = this.#toolRegistry.get("read") as
					| { syncInspectImageState?: (available?: boolean) => boolean }
					| undefined;
				readTool?.syncInspectImageState?.(available);
			};
			const active = this.getEnabledToolNames();
			const isActive = active.includes("inspect_image");
			if (expected === isActive) {
				syncReadDescription(isActive);
				return true;
			}
			if (!expected) {
				syncReadDescription(false);
				await this.#applyActiveToolsByName(active.filter(name => name !== "inspect_image"));
				return true;
			}
			if (!this.#toolRegistry.has("inspect_image")) {
				const tool = await this.#createInspectImageTool?.();
				if (tool?.name !== "inspect_image") {
					logger.warn("inspect_image tool could not be created", {
						model: this.#host.model()?.id,
					});
					syncReadDescription(false);
					return false;
				}
				const wrapped = this.#wrapRuntimeTool(tool);
				this.#toolRegistry.set(wrapped.name, wrapped);
				this.#builtInToolNames.add(wrapped.name);
			}
			syncReadDescription(true);
			await this.#applyActiveToolsByName([...active, "inspect_image"]);
			return true;
		});
	}

	reconcileInspectImageAfterModelChange(): Promise<void> {
		return this.runToolRegistryMutation(async () => {
			const before = this.getEnabledToolNames().includes("inspect_image");
			const reconciled = await this.reconcileInspectImageTool();
			const after = this.getEnabledToolNames().includes("inspect_image");
			if (!reconciled || before === after) return;
			const model = this.#host.model();
			const modelName = model ? formatModelString(model) : "the current model";
			this.#host.emitNotice(
				"info",
				after
					? `inspect_image is now available: ${modelName} has no native image input.`
					: `inspect_image is now hidden: ${modelName} supports image input natively. Override with /vision on.`,
				"vision",
			);
		});
	}

	setInspectImageMode(mode: InspectImageMode): Promise<boolean> {
		return this.runToolRegistryMutation(async () => {
			this.#host.setInspectImageModeOverride(mode === "auto" ? undefined : mode);
			const applied = await this.reconcileInspectImageTool();
			const { active, model } = this.inspectImageState();
			logger.debug("inspect_image mode changed", { mode, active, model });
			return applied;
		});
	}

	refreshBaseSystemPrompt(): Promise<void> {
		return this.runToolRegistryMutation(() => this.#refreshBaseSystemPrompt());
	}

	async #refreshBaseSystemPrompt(): Promise<void> {
		if (this.#host.isDisposed() || !this.#rebuildSystemPrompt) return;
		const activeToolNames = this.getActiveToolNames();
		const promptToolNames =
			this.#codeModeDirectWireSignature === undefined ? activeToolNames : this.getEnabledToolNames();

		const directToolNames = this.#codeModeDirectWireSignature === undefined ? undefined : activeToolNames;
		this.#setActiveToolNames?.(this.#toolPredicateNames ?? activeToolNames);
		const previousBaseSystemPrompt = this.#baseSystemPrompt;
		const built = await this.#rebuildSystemPrompt(promptToolNames, this.#toolRegistry, { directToolNames });
		if (this.#host.isDisposed()) return;
		this.#baseSystemPrompt = built.systemPrompt;
		this.#basePromptXdevNames = new Set(built.xdevCatalogNames);
		if (
			previousBaseSystemPrompt.length !== this.#baseSystemPrompt.length ||
			previousBaseSystemPrompt.some((part, index) => part !== this.#baseSystemPrompt[index])
		) {
			this.#host.clearInheritedProviderPromptCacheKey();
		}
		this.#applyAgentSystemPrompt(this.#baseSystemPrompt);
		this.#promptModelKey = this.#currentPromptModelKey();

		const promptTools = promptToolNames
			.map(name => this.#toolRegistry.get(name))
			.filter((tool): tool is AgentTool => tool != null);
		this.#lastAppliedToolSignature = this.#computeAppliedToolSignature(promptToolNames, promptTools, directToolNames);
	}

	#computeAppliedToolSignature(toolNames: string[], tools: AgentTool[], directToolNames?: readonly string[]): string {
		const nameSegment = toolNames.join("\u0001");
		const describeTool = (tool: AgentTool): string =>
			`${tool.name}=${tool.label ?? ""}|${tool.description ?? ""}|${tool.customWireName ?? ""}`;
		const descriptionSegment = tools.map(describeTool).join("\u0002");
		const mountedMCPProjection = projectMountedMCPXdevGuidance(
			collectMountedMCPToolRoutes(this.#xdev ? listXdevTools(this.#xdev) : []),
		);
		const mountedMCPRouteSegment =
			JSON.stringify({
				mappings: mountedMCPProjection.mappings.map(mapping => [mapping.label, mapping.path] as const),
				hasOmittedMappings: mountedMCPProjection.hasOmittedMappings,
			}) ?? "{}";
		const serverInstructions = this.#getMcpServerInstructions?.();
		let instructionsSegment = "";
		if (serverInstructions && serverInstructions.size > 0) {
			const entries: string[] = [];
			for (const [server, instructions] of serverInstructions) {
				entries.push(`${server}=${instructions}`);
			}
			entries.sort();
			instructionsSegment = entries.join("\u0006");
		}

		const directSegment = directToolNames === undefined ? "" : `\u0004${directToolNames.join("\u0001")}`;
		return `${nameSegment}\u0003${descriptionSegment}\u0007${instructionsSegment}\u0008${mountedMCPRouteSegment}${directSegment}`;
	}

	refreshMCPTools(mcpTools: CustomTool[]): Promise<void> {
		const snapshot = [...mcpTools];
		return this.runToolRegistryMutation(() =>
			this.#host.isDisposed() ? Promise.resolve() : this.#applyMCPToolRefresh(snapshot),
		);
	}

	async #applyMCPToolRefresh(mcpTools: CustomTool[]): Promise<void> {
		const previousMcpTools = new Map<string, AgentTool>();
		for (const [name, tool] of this.#toolRegistry) {
			if (isMCPToolName(name)) previousMcpTools.set(name, tool);
		}
		const previousMcpManagerToolNames = new Set(this.#mcpManagerToolNames);
		const previousActiveMcpToolNames = this.getEnabledToolNames().filter(isMCPToolName);
		const restorePreviousMcpTools = () => {
			for (const name of this.#toolRegistry.keys()) {
				if (isMCPToolName(name)) this.#toolRegistry.delete(name);
			}
			for (const [name, tool] of previousMcpTools) this.#toolRegistry.set(name, tool);
			this.#mcpManagerToolNames = previousMcpManagerToolNames;
		};

		const getCustomToolContext = (): CustomToolContext => ({
			sessionManager: this.#host.sessionManager,
			modelRegistry: this.#host.modelRegistry,
			model: this.#host.model(),
			isIdle: () => !this.#host.isStreaming(),
			hasQueuedMessages: () => this.#host.queuedMessageCount() > 0,
			abort: () => {
				this.#host.agent.abort();
			},
			settings: this.#host.settings,
			localProtocolOptions: this.#host.localProtocolOptions(),
		});

		const extensionRunner = this.#host.extensionRunner();
		const managerTools = deduplicateMCPToolsByName(mcpTools).map(customTool => {
			const wrapped = wrapToolWithMetaNotice(CustomToolAdapter.wrap(customTool, getCustomToolContext) as AgentTool);
			return (extensionRunner ? new ExtensionToolWrapper(wrapped, extensionRunner) : wrapped) as AgentTool;
		});
		const managerToolSet = new Set(managerTools);
		const reconciledTools = deduplicateMCPToolsByName([...this.#extensionMcpTools.values(), ...managerTools]);

		for (const name of this.#toolRegistry.keys()) {
			if (isMCPToolName(name)) this.#toolRegistry.delete(name);
		}
		this.#mcpManagerToolNames.clear();
		for (const tool of reconciledTools) {
			this.#toolRegistry.set(tool.name, tool);
			if (managerToolSet.has(tool)) this.#mcpManagerToolNames.add(tool.name);
		}

		const retainedActiveExtensionToolNames = previousActiveMcpToolNames.filter(
			name => this.#extensionMcpTools.has(name) && this.#toolRegistry.has(name),
		);
		const nextActive = [
			...new Set([
				...this.#getActiveNonMCPToolNames(),
				...this.#mcpManagerToolNames,
				...retainedActiveExtensionToolNames,
			]),
		];
		try {
			await this.#applyActiveToolsByName(nextActive);
			if (this.#host.isDisposed()) restorePreviousMcpTools();
		} catch (error) {
			restorePreviousMcpTools();
			throw error;
		}
	}

	refreshRpcHostTools(rpcTools: AgentTool[]): Promise<void> {
		const snapshot = [...rpcTools];
		return this.runToolRegistryMutation(() => this.#applyRpcHostToolRefresh(snapshot));
	}

	async #applyRpcHostToolRefresh(rpcTools: AgentTool[]): Promise<void> {
		const nextToolNames = rpcTools.map(tool => tool.name);
		const uniqueToolNames = new Set(nextToolNames);
		if (uniqueToolNames.size !== nextToolNames.length) {
			throw new Error("RPC host tool names must be unique");
		}

		for (const name of uniqueToolNames) {
			if (this.#toolRegistry.has(name) && !this.#rpcHostToolNames.has(name)) {
				throw new Error(`RPC host tool "${name}" conflicts with an existing tool`);
			}
		}

		const previousRpcHostToolNames = new Set(this.#rpcHostToolNames);
		const previousActiveToolNames = this.getEnabledToolNames();
		const previousRpcHostTools = new Map(
			[...previousRpcHostToolNames].flatMap(name => {
				const tool = this.#toolRegistry.get(name);
				return tool ? [[name, tool] as const] : [];
			}),
		);
		for (const name of previousRpcHostToolNames) {
			this.#toolRegistry.delete(name);
		}
		this.#rpcHostToolNames.clear();

		const extensionRunner = this.#host.extensionRunner();
		for (const tool of rpcTools) {
			const metaWrapped = wrapToolWithMetaNotice(tool);
			const finalTool = (
				extensionRunner ? new ExtensionToolWrapper(metaWrapped, extensionRunner) : metaWrapped
			) as AgentTool;
			this.#toolRegistry.set(finalTool.name, finalTool);
			this.#rpcHostToolNames.add(finalTool.name);
		}

		const activeNonRpcToolNames = previousActiveToolNames.filter(name => !previousRpcHostToolNames.has(name));
		const preservedRpcToolNames = previousActiveToolNames.filter(
			name => previousRpcHostToolNames.has(name) && this.#rpcHostToolNames.has(name),
		);
		const autoActivatedRpcToolNames = rpcTools
			.filter(tool => !tool.hidden && !previousRpcHostToolNames.has(tool.name))
			.map(tool => tool.name);
		try {
			await this.#applyActiveToolsByName(
				Array.from(new Set([...activeNonRpcToolNames, ...preservedRpcToolNames, ...autoActivatedRpcToolNames])),
			);
		} catch (error) {
			for (const name of this.#rpcHostToolNames) this.#toolRegistry.delete(name);
			this.#rpcHostToolNames = previousRpcHostToolNames;
			for (const [name, tool] of previousRpcHostTools) this.#toolRegistry.set(name, tool);
			throw error;
		}
	}
}
