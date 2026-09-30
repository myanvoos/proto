/**
 * `/fast` and `/fast ultra` are scoped to the active model's service-tier family, and Codex models gate both on the
 * tier list their discovery reports: priority/scale require a non-empty list that names them, ultrafast always does.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;
let tempDir: TempDir | undefined;

afterEach(async () => {
	await session?.dispose();
	session = undefined;
	authStorage?.close();
	authStorage = undefined;
	tempDir?.removeSync();
	tempDir = undefined;
});

async function createSessionForModel(model: Model): Promise<AgentSession> {
	tempDir = TempDir.createSync("@pi-fast-mode-scope-");
	authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey(model.provider, "token");
	const agent = new Agent({
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
	});
	session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(authStorage),
	});
	session.subscribe(() => {});
	return session;
}

const codexModel = (serviceTiers: string[]) =>
	buildModel({
		id: "gpt-6.1-sol",
		name: "GPT-6.1 Sol",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
		serviceTiers,
	});

describe("/fast targets the current model's service-tier family", () => {
	it("refuses Ultrafast on a Codex model that does not advertise it", async () => {
		const local = await createSessionForModel(codexModel(["priority"]));
		expect(local.setUltrafastMode(true)).toBe(false);
		expect(local.serviceTierByFamily).toEqual({});
		expect(local.isUltrafastModeEnabled()).toBe(false);
	});

	it("refuses /fast on a Codex model whose discovered tiers omit priority", async () => {
		const local = await createSessionForModel(codexModel(["ultrafast"]));
		expect(local.setFastMode(true)).toBe(false);
		expect(local.serviceTierByFamily).toEqual({});
		expect(local.isFastModeActive()).toBe(false);
	});

	it("selects Ultrafast on an advertising Codex model and clears it with /fast off", async () => {
		const local = await createSessionForModel(codexModel(["priority", "ultrafast"]));
		expect(local.setUltrafastMode(true)).toBe(true);
		expect(local.serviceTierByFamily).toEqual({ openai: "ultrafast" });
		expect(local.isUltrafastModeEnabled()).toBe(true);
		expect(local.isFastModeEnabled()).toBe(true);
		expect(local.isFastModeActive()).toBe(true);
		local.setFastMode(false);
		expect(local.serviceTierByFamily).toEqual({});
		expect(local.isFastModeActive()).toBe(false);
	});
});
