import { Database } from "bun:sqlite";
import { afterEach, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as ai from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "./agent-session";
import { AuthStorage, SqliteAuthCredentialStore } from "./auth-storage";
import { SessionManager } from "./session-manager";

const model = buildModel({
	id: "title-test",
	name: "Title Test",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "http://127.0.0.1:9",
	reasoning: false,
	input: ["text"],
	contextWindow: 128_000,
	maxTokens: 4_096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;
let previousNoTitle: string | undefined;

afterEach(async () => {
	if (previousNoTitle === undefined) delete Bun.env.PI_NO_TITLE;
	else Bun.env.PI_NO_TITLE = previousNoTitle;
	vi.restoreAllMocks();
	await session?.dispose();
	authStorage?.close();
	session = undefined;
	authStorage = undefined;
});

// A title request sharing the foreground provider session id advanced that provider
// session while the foreground request was still waiting (#10619). Titles now run under
// their own stable side identity that still bills the foreground's pinned account.
it("runs title requests under an isolated provider session on the foreground account", async () => {
	previousNoTitle = Bun.env.PI_NO_TITLE;
	delete Bun.env.PI_NO_TITLE;
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	authStorage = new AuthStorage(store, { usageProviderResolver: () => undefined });
	const account = (id: string) => ({
		type: "oauth" as const,
		access: `access-${id}`,
		refresh: `refresh-${id}`,
		expires: Date.now() + 3_600_000,
		accountId: `account-${id}`,
	});
	await authStorage.set("openai-codex", [account("a"), account("b")]);
	const pinned = store
		.listAuthCredentials("openai-codex")
		.find(row => row.credential.type === "oauth" && row.credential.access === "access-b");
	if (!pinned) throw new Error("credential row missing");
	const providerSessionId = "foreground-session";
	expect(authStorage.pinSessionOAuthAccount("openai-codex", providerSessionId, pinned.id)).toBe(true);

	const modelRegistry = new ModelRegistry(authStorage);
	vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([model]);
	const titleSessions: Array<string | undefined> = [];
	const titleAccounts: Array<string | undefined> = [];
	vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (_requestModel, sessionId) => {
		titleSessions.push(sessionId);
		titleAccounts.push(authStorage?.getOAuthAccountIdentity("openai-codex", sessionId)?.accountId);
		return "test-key";
	});
	const requestSessions: Array<string | undefined> = [];
	vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, _context, options) => {
		requestSessions.push(options?.sessionId);
		return {
			role: "assistant",
			content: [{ type: "text", text: "<title>Shutdown Investigation</title>" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	});
	session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		}),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, "providers.tinyModel": "online" }),
		modelRegistry,
		providerSessionId,
	});

	await session.generateTitle("Investigate the shutdown hang in the worker pool");
	await session.generateTitle("Investigate the shutdown hang in the worker pool again");

	const [first, second] = titleSessions;
	expect(first).toBeTruthy();
	expect(first).not.toBe(providerSessionId);
	// Stable side identity: repeated titles reuse one provider session instead of minting new ones.
	expect(second).toBe(first);
	expect(requestSessions).toEqual([first, first]);
	expect(titleAccounts).toEqual(["account-b", "account-b"]);
});
