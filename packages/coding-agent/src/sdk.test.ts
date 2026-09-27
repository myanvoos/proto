import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "./config/model-registry";
import { Settings } from "./config/settings";
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
