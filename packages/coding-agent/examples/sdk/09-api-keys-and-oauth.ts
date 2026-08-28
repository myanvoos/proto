import {
	AuthStorage,
	createAgentSession,
	discoverAuthStorage,
	discoverModels,
	ModelRegistry,
	SessionManager,
} from "@oh-my-pi/pi-coding-agent";

const authStorage = await discoverAuthStorage();
const modelRegistry = await discoverModels(authStorage);

await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry,
});
console.log("Session with default auth storage and model registry");

const customAuthStorage = await AuthStorage.create("/tmp/my-app/agent.db");
const customModelRegistry = await ModelRegistry.create(customAuthStorage, "/tmp/my-app/models.json");

await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage: customAuthStorage,
	modelRegistry: customModelRegistry,
});
console.log("Session with custom auth storage location");

authStorage.setRuntimeApiKey("anthropic", "sk-my-temp-key");
await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry,
});
console.log("Session with runtime API key override");

const simpleRegistry = await ModelRegistry.create(authStorage);
await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry: simpleRegistry,
});
console.log("Session with only built-in models");
