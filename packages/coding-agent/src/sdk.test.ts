import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import * as codexProvider from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "./config/model-registry";
import { Settings } from "./config/settings";
import type { ExtensionFactory } from "./extensibility/extensions/types";
import { createAgentSession } from "./sdk";
import { AuthStorage } from "./session/auth-storage";
import { SessionManager } from "./session/session-manager";

test("an empty tool selection disables MCP discovery", async () => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-sdk-no-tools-"));
	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	const settings = Settings.isolated();
	const sessionManager = SessionManager.inMemory(agentDir);
	try {
		const { session, mcpManager } = await createAgentSession({
			cwd: agentDir,
			agentDir,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings }),
			settings,
			sessionManager,
			toolNames: [],
			disableExtensionDiscovery: true,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			workspaceTree: { rootPath: agentDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		try {
			expect(mcpManager).toBeUndefined();
		} finally {
			await session.dispose();
		}
	} finally {
		authStorage.close();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("host-connected MCP instructions refresh with the server roster even when SDK discovery is disabled", async () => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-sdk-host-mcp-"));
	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	try {
		const created = await createAgentSession({
			cwd: agentDir,
			agentDir,
			authStorage,
			settings: Settings.isolated({}),
			sessionManager: SessionManager.inMemory(agentDir),
			toolNames: [],
			disableExtensionDiscovery: true,
			enableMCP: false,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			workspaceTree: { rootPath: agentDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		try {
			let instructions = new Map([["hosted", "Use the project-specific document index."]]);
			created.session.setMcpServerInstructionsSource(() => instructions);
			await created.session.refreshMCPTools([]);
			expect(created.session.systemPrompt.join("\n")).toContain("Use the project-specific document index.");
			instructions = new Map([["hosted", "Use the replacement document index."]]);
			await created.session.refreshMCPTools([]);
			const prompt = created.session.systemPrompt.join("\n");
			expect(prompt).toContain("Use the replacement document index.");
			expect(prompt).not.toContain("Use the project-specific document index.");
			created.session.setMcpServerInstructionsSource(undefined);
			await created.session.refreshMCPTools([]);
			expect(created.session.systemPrompt.join("\n")).not.toContain("Use the replacement document index.");
		} finally {
			await created.session.dispose();
		}
	} finally {
		authStorage.close();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("interactivePrompts decides whether a headless session keeps the ask tool", async () => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-sdk-ask-"));
	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	const settings = Settings.isolated();
	const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings });
	const baseOptions = {
		cwd: agentDir,
		agentDir,
		authStorage,
		modelRegistry,
		settings,
		toolNames: ["ask"],
		hasUI: false,
		disableExtensionDiscovery: true,
		enableMCP: false,
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		workspaceTree: { rootPath: agentDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	};
	try {
		// A background side agent is headless but still talks to the user, so `ask` has to survive.
		const prompting = await createAgentSession({
			...baseOptions,
			sessionManager: SessionManager.inMemory(agentDir),
			interactivePrompts: true,
		});
		const silent = await createAgentSession({
			...baseOptions,
			sessionManager: SessionManager.inMemory(agentDir),
		});
		try {
			expect(prompting.session.getEnabledToolNames()).toContain("ask");
			expect(silent.session.getEnabledToolNames()).not.toContain("ask");
		} finally {
			await prompting.session.dispose();
			await silent.session.dispose();
		}
	} finally {
		authStorage.close();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("resume restores a discovery-backed session model instead of the default role", async () => {
	// The saved model's provider (models.yml `discovery:`) has no cached catalog at startup, so the restore must
	// discover that provider before falling back to modelRoles.default.
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-sdk-resume-discovery-"));
	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelsPath = path.join(agentDir, "models.yml");
	await Bun.write(
		modelsPath,
		JSON.stringify({
			providers: {
				gateway: {
					baseUrl: "http://127.0.0.1:9994",
					api: "openai-completions",
					auth: "none",
					discovery: { type: "openai-models-list" },
				},
			},
		}),
	);
	let modelListCalls = 0;
	const fetchMock = Object.assign(
		async (input: string | URL | Request) => {
			const url = String(input);
			if (url === "http://127.0.0.1:9994/v1/models") {
				modelListCalls++;
				return Response.json({ data: [{ id: "dynamic-model", context_length: 65_536 }] });
			}
			throw new Error(`Unexpected URL: ${url}`);
		},
		{ preconnect: fetch.preconnect },
	);
	const settings = Settings.isolated({ modelRoles: { default: "anthropic/claude-sonnet-4-5" } });
	const sessionFile = path.join(agentDir, "resume.jsonl");
	const timestamp = "2026-06-01T00:00:00.000Z";
	await Bun.write(
		sessionFile,
		`${[
			{ type: "session", version: 3, id: "resume-discovery", timestamp, cwd: agentDir },
			{
				type: "model_change",
				id: "dynamic-model-change",
				parentId: null,
				timestamp,
				model: "gateway/dynamic-model",
				role: "default",
			},
		]
			.map(entry => JSON.stringify(entry))
			.join("\n")}\n`,
	);
	try {
		const { session } = await createAgentSession({
			cwd: agentDir,
			agentDir,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, modelsPath, { settings, fetch: fetchMock }),
			settings,
			sessionManager: await SessionManager.open(sessionFile, path.join(agentDir, "sessions")),
			toolNames: [],
			disableExtensionDiscovery: true,
			enableMCP: false,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			workspaceTree: { rootPath: agentDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		try {
			expect(modelListCalls).toBeGreaterThan(0);
			expect(`${session.model?.provider}/${session.model?.id}`).toBe("gateway/dynamic-model");
		} finally {
			await session.dispose();
		}
	} finally {
		authStorage.close();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("a deferred model pattern never resolves onto a disabled provider", async () => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-sdk-disabled-deferred-"));
	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	const modelsPath = path.join(agentDir, "models.yml");
	await Bun.write(
		modelsPath,
		JSON.stringify({
			providers: {
				gated: {
					baseUrl: "http://127.0.0.1:9995/v1",
					api: "openai-completions",
					apiKey: "GATED_KEY",
					models: [{ id: "gated-model" }],
				},
			},
		}),
	);
	const settings = Settings.isolated({ disabledProviders: ["gated"] });
	try {
		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: agentDir,
			agentDir,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, modelsPath, { settings }),
			settings,
			sessionManager: SessionManager.inMemory(agentDir),
			modelPattern: "gated/gated-model",
			toolNames: [],
			disableExtensionDiscovery: true,
			enableMCP: false,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			workspaceTree: { rootPath: agentDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		try {
			expect(session.model?.provider).not.toBe("gated");
			expect(modelFallbackMessage).toBe('Model "gated/gated-model" not found');
		} finally {
			await session.dispose();
		}
	} finally {
		authStorage.close();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("advisors can be granted the read tool they request by default", async () => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-sdk-advisor-read-"));
	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	const settings = Settings.isolated();
	try {
		const { session } = await createAgentSession({
			cwd: agentDir,
			agentDir,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings }),
			settings,
			sessionManager: SessionManager.inMemory(agentDir),
			hasUI: false,
			disableExtensionDiscovery: true,
			enableMCP: false,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			workspaceTree: { rootPath: agentDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		try {
			expect(session.getAdvisorAvailableToolNames()).toContain("read");
		} finally {
			await session.dispose();
		}
	} finally {
		authStorage.close();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("filesystem custom tools see the host UI once the mode installs it", async () => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-sdk-custom-tool-ui-"));
	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	const settings = Settings.isolated();
	const toolPath = path.join(agentDir, "probe-tool.ts");
	const captureKey = `__protoCustomToolApi_${path.basename(agentDir)}`;
	await Bun.write(
		toolPath,
		`export default pi => {
	globalThis[${JSON.stringify(captureKey)}] = pi;
	return {
		name: "probe_ui",
		label: "Probe UI",
		description: "probe",
		parameters: pi.zod.object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
	};
};
`,
	);
	const globals = globalThis as Record<string, unknown>;
	try {
		const { session, setToolUIContext } = await createAgentSession({
			cwd: agentDir,
			agentDir,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings }),
			settings,
			sessionManager: SessionManager.inMemory(agentDir),
			hasUI: false,
			disableExtensionDiscovery: true,
			enableMCP: false,
			preloadedCustomToolPaths: [{ path: toolPath }],
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			workspaceTree: { rootPath: agentDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		try {
			const api = globals[captureKey] as
				| { ui: { select(title: string, options: string[]): Promise<string | undefined> }; hasUI: boolean }
				| undefined;
			expect(api?.hasUI).toBe(false);
			const hostUI = { select: async () => "picked" } as unknown as Parameters<typeof setToolUIContext>[0];
			setToolUIContext(hostUI, true);
			expect(await api?.ui.select("Pick", ["picked"])).toBe("picked");
			expect(api?.hasUI).toBe(true);
		} finally {
			await session.dispose();
		}
	} finally {
		delete globals[captureKey];
		authStorage.close();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("an extension web_search tool replaces the built-in instead of being shadowed by it", async () => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-sdk-web-search-override-"));
	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	const settings = Settings.isolated({ "web_search.enabled": true });
	const customWebSearch: ExtensionFactory = pi => {
		pi.registerTool({
			name: "web_search",
			label: "Custom Web Search",
			description: "Custom extension web search",
			parameters: pi.zod.object({}),
			execute: async () => ({ content: [{ type: "text", text: "custom-web-search-result" }] }),
		});
	};
	try {
		const { session } = await createAgentSession({
			cwd: agentDir,
			agentDir,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings }),
			settings,
			sessionManager: SessionManager.inMemory(agentDir),
			hasUI: false,
			disableExtensionDiscovery: true,
			enableMCP: false,
			extensions: [customWebSearch],
			toolNames: ["web_search"],
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			workspaceTree: { rootPath: agentDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		try {
			const tool = session.getToolByName("web_search");
			const result = await tool?.execute("call-web-search", {});
			expect(result?.content).toEqual([{ type: "text", text: "custom-web-search-result" }]);
		} finally {
			await session.dispose();
		}
	} finally {
		authStorage.close();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("concurrent SDK roots isolate child job deliveries and manager disposal", async () => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-sdk-job-roots-"));
	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	const settings = Settings.isolated({ "async.enabled": true });
	const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings });
	const options = {
		cwd: agentDir,
		agentDir,
		authStorage,
		modelRegistry,
		settings,
		toolNames: [],
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableIrc: false,
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		workspaceTree: { rootPath: agentDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	};
	const sessions: Array<{ dispose(): Promise<void> }> = [];
	try {
		const first = await createAgentSession({
			...options,
			agentId: "root-a",
			sessionManager: SessionManager.inMemory(agentDir),
		});
		sessions.push(first.session);
		const second = await createAgentSession({
			...options,
			agentId: "root-b",
			sessionManager: SessionManager.inMemory(agentDir),
		});
		sessions.push(second.session);
		const a = first.session.asyncJobManager;
		const b = second.session.asyncJobManager;
		if (!a || !b) throw new Error("Expected enabled root job managers");
		const receivedA: string[] = [],
			receivedB: string[] = [];
		a.registerDeliverySink("probe", async (_id, text) => {
			receivedA.push(text);
		});
		b.registerDeliverySink("probe", async (_id, text) => {
			receivedB.push(text);
		});
		const child = await createAgentSession({
			...options,
			agentId: "child-a",
			parentTaskPrefix: "child-a",
			asyncJobManager: a,
			sessionManager: SessionManager.inMemory(agentDir),
		});
		sessions.push(child.session);
		const childManager = child.session.asyncJobManager;
		if (!childManager) throw new Error("Expected inherited job manager");
		childManager.register("worker", "child result", async () => "child-a-result", { ownerId: "probe" });
		b.register("worker", "other root", async () => "root-b-result", { ownerId: "probe" });
		await childManager.waitForAll();
		await b.waitForAll();
		await childManager.drainDeliveries();
		await b.drainDeliveries();
		expect(receivedA).toEqual(["child-a-result"]);
		expect(receivedB).toEqual(["root-b-result"]);
		await child.session.dispose();
		a.register("bash", "after child disposal", async () => "a-still-live", { ownerId: "probe" });
		await a.waitForAll();
		await a.drainDeliveries();
		expect(receivedA).toEqual(["child-a-result", "a-still-live"]);
		await first.session.dispose();
		b.register("bash", "after other root disposal", async () => "b-still-live", { ownerId: "probe" });
		await b.waitForAll();
		await b.drainDeliveries();
		expect(receivedB).toEqual(["root-b-result", "b-still-live"]);
	} finally {
		for (const session of sessions.reverse()) await session.dispose();
		authStorage.close();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

afterEach(() => vi.restoreAllMocks());

test("Codex prewarm uses the restored session tier instead of its preliminary model tier", async () => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-sdk-prewarm-tier-"));
	const authStorage = await AuthStorage.create(":memory:");
	const settings = Settings.isolated();
	const model = buildModel({
		provider: "openai-codex",
		id: "gpt-5.5",
		api: "openai-codex-responses",
		name: "Codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: false,
		input: ["text"],
		contextWindow: 10000,
		maxTokens: 1000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	model.preferWebsockets = true;
	const prewarmed = Promise.withResolvers<void>();
	const prewarm = spyOn(codexProvider, "prewarmOpenAICodexResponses").mockImplementation(async () => {
		prewarmed.resolve();
	});
	const manager = SessionManager.inMemory(agentDir);
	manager.appendModelChange("openai-codex/gpt-5.5");
	manager.appendServiceTierChange({ openai: "priority" });
	manager.appendMessage({ role: "user", content: "earlier turn", timestamp: 1 });
	try {
		const { session } = await createAgentSession({
			cwd: agentDir,
			agentDir,
			authStorage,
			settings,
			modelRegistry: new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings }),
			model,
			sessionManager: manager,
			getApiKey: async () => "test-key",
			toolNames: [],
			disableExtensionDiscovery: true,
			enableMCP: false,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			workspaceTree: { rootPath: agentDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		try {
			await prewarmed.promise;
			if (!session.model) throw new Error("Expected the session model to resolve before prewarm");
			expect(prewarm.mock.calls[0]?.[0]?.id).toBe(session.model.id);
			expect(prewarm.mock.calls[0]?.[1]).toMatchObject({
				serviceTier: "priority",
				providerSessionState: session.providerSessionState,
				preferWebsockets: session.preferWebsockets,
			});
		} finally {
			await session.dispose();
		}
	} finally {
		authStorage.close();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("an unavailable default role uses its configured authenticated fallback before an arbitrary available model", async () => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-sdk-default-chain-"));
	const authStorage = await AuthStorage.create(":memory:");
	const settings = Settings.isolated({
		modelRoles: { default: "fixture/missing" },
		enabledModels: ["fixture/first", "fixture/second"],
		"retry.modelFallback": true,
		"retry.fallbackChains": { default: ["fixture/second"] },
	});
	authStorage.setRuntimeApiKey("fixture", "test-key");
	const registry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings });
	registry.registerProvider("fixture", {
		apiKey: "test-key",
		api: "openai-completions",
		baseUrl: "https://fixture.invalid/v1",
		models: ["first", "second"].map(id => ({
			id,
			name: id,
			reasoning: false,
			input: ["text"],
			contextWindow: 10000,
			maxTokens: 1000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
	});
	try {
		const manager = SessionManager.inMemory(agentDir);
		const { session } = await createAgentSession({
			cwd: agentDir,
			agentDir,
			authStorage,
			modelRegistry: registry,
			settings,
			sessionManager: manager,
			toolNames: [],
			disableExtensionDiscovery: true,
			enableMCP: false,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			workspaceTree: { rootPath: agentDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		try {
			expect(session.model?.id).toBe("second");
		} finally {
			await session.dispose();
		}
	} finally {
		authStorage.close();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("a deferred child pattern records both its resumable default model and its explicit empty retry role", async () => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-sdk-pattern-role-"));
	const authStorage = await AuthStorage.create(":memory:");
	const settings = Settings.isolated();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const manager = SessionManager.inMemory(agentDir);
	try {
		const { session } = await createAgentSession({
			cwd: agentDir,
			agentDir,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings }),
			settings,
			sessionManager: manager,
			modelPattern: "anthropic/claude-sonnet-4-5",
			modelPatternFallbackRole: "subagent:pattern",
			modelPatternDefaultFallbackChain: [],
			toolNames: [],
			disableExtensionDiscovery: true,
			enableMCP: false,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			workspaceTree: { rootPath: agentDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		try {
			const changes = manager.getEntries().filter(entry => entry.type === "model_change");
			expect(changes.map(entry => entry.role)).toEqual([undefined, "subagent:pattern"]);
			expect(manager.buildSessionContext().models.default).toBe("anthropic/claude-sonnet-4-5");
			expect(settings.get("retry.fallbackChains")["subagent:pattern"]).toEqual([]);
		} finally {
			await session.dispose();
		}
	} finally {
		authStorage.close();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("historical images on a wire-stripped route become omission text before provider preprocessing", async () => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-sdk-strip-images-"));
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("deepseek", "test-key");
	const settings = Settings.isolated();
	const model = buildModel({
		provider: "deepseek",
		id: "deepseek-v3",
		api: "openai-completions",
		name: "DeepSeek",
		baseUrl: "https://api.deepseek.com",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 10000,
		maxTokens: 1000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	const provider = createMockModel({ handler: { content: ["done"] } });
	try {
		const { session } = await createAgentSession({
			cwd: agentDir,
			agentDir,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings }),
			settings,
			sessionManager: SessionManager.inMemory(agentDir),
			model,
			streamFn: provider.stream,
			toolNames: [],
			disableExtensionDiscovery: true,
			enableMCP: false,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			workspaceTree: { rootPath: agentDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		try {
			session.agent.replaceMessages([
				{
					role: "user",
					content: [{ type: "image", mimeType: "image/png", data: "invalid-if-decoded" }],
					timestamp: 1,
				},
			]);
			await session.prompt("continue");
			const historical = provider.calls[0]?.context.messages[0];
			expect(historical?.content).toEqual(
				expect.arrayContaining([
					{ type: "text", text: "[image omitted: the active model does not support image input]" },
				]),
			);
			expect(Array.isArray(historical?.content) && historical.content.some(block => block.type === "image")).toBe(
				false,
			);
		} finally {
			await session.dispose();
		}
	} finally {
		authStorage.close();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});
