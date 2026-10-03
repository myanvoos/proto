import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import { AuthStorage } from "../../session/auth-storage";
import { runCommitAgentSession } from "./agent";

const providerName = "commit-extension-provider";
const modelId = "commit-extension-model";
const apiId = "commit-extension-api";

let authStorage: AuthStorage | undefined;
let tempDir: string | undefined;

afterEach(async () => {
	authStorage?.close();
	authStorage = undefined;
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

test("commit agent keeps extension-registered providers in the shared model registry", async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-commit-agent-"));
	authStorage = await AuthStorage.create(":memory:");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), {
		cacheDbPath: path.join(tempDir, "models.db"),
		fetch: () => Promise.reject(new Error("network disabled in test")),
	});
	let requests = 0;
	modelRegistry.registerProvider(
		providerName,
		{
			baseUrl: "https://runtime.invalid/v1",
			apiKey: "RUNTIME_KEY",
			api: apiId,
			streamSimple: () => {
				requests++;
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "No proposal." }],
					api: apiId,
					provider: providerName,
					model: modelId,
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
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
			models: [
				{
					id: modelId,
					name: "Commit Extension Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 8_192,
				},
			],
		},
		"<extension:commit-provider>",
	);
	await modelRegistry.refresh("offline");
	const model = modelRegistry.find(providerName, modelId);
	if (!model) throw new Error("Expected extension model registration");

	await runCommitAgentSession({
		cwd: tempDir,
		model,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry,
		authStorage,
		changelogTargets: [],
		requireChangelog: false,
	});

	expect(requests).toBeGreaterThan(0);
	expect(modelRegistry.find(providerName, modelId)).toBeDefined();
});
