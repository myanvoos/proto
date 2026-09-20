# SDK Examples

Programmatic usage of proto-coding-agent via `createAgentSession()`.

## Examples

| File                       | Description                                    |
| -------------------------- | ---------------------------------------------- |
| `01-minimal.ts`            | Simplest usage with all defaults               |
| `02-custom-model.ts`       | Select model and thinking level                |
| `03-custom-prompt.ts`      | Replace or modify system prompt                |
| `04-skills.ts`             | Discover, filter, or replace skills            |
| `06-extensions.ts`         | Extensions as hooks: logging, blocking         |
| `06-hooks.ts`              | Hook factories via the extensions option       |
| `07-context-files.ts`      | AGENTS.md context files                        |
| `08-prompt-templates.ts`   | Prompt templates                               |
| `08-slash-commands.ts`     | File-based slash commands                      |
| `09-api-keys-and-oauth.ts` | API key resolution, OAuth config               |
| `11-sessions.ts`           | In-memory, persistent, continue, list sessions |
| `12-redis-sessions.ts`     | Redis-backed session storage                   |
| `13-sql-sessions.ts`       | SQLite-backed session storage                  |

## Running

```bash
cd packages/coding-agent
bun examples/sdk/01-minimal.ts
```

## Quick Reference

```typescript
import { getModel } from "@oh-my-pi/pi-ai";
import {
	AuthStorage,
	createAgentSession,
	discoverAuthStorage,
	discoverContextFiles,
	discoverMCPServers,
	discoverSkills,
	discoverSlashCommands,
	buildSystemPrompt,
	ModelRegistry,
	SessionManager,
	BUILTIN_TOOLS,
	HIDDEN_TOOLS,
	createTools,
} from "@oh-my-pi/pi-coding-agent";

// Auth and models setup (all discover* functions are async)
const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);

// Minimal
const { session } = await createAgentSession({ authStorage, modelRegistry });

// Custom model
const model = getModel("anthropic", "claude-opus-4-5");
const { session } = await createAgentSession({ model, thinkingLevel: "high", authStorage, modelRegistry });

// Modify prompt
const { session } = await createAgentSession({
	systemPrompt: (defaultPrompt) => [...defaultPrompt, "Be concise."],
	authStorage,
	modelRegistry,
});

// Read-only tools
const { session } = await createAgentSession({ toolNames: ["read"], authStorage, modelRegistry });

// In-memory
const { session } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry,
});

// Full control
const customAuth = await AuthStorage.create("/my/app/agent.db");
customAuth.setRuntimeApiKey("anthropic", Bun.env.MY_KEY!);
const customRegistry = new ModelRegistry(customAuth);

const { session } = await createAgentSession({
	model,
	authStorage: customAuth,
	modelRegistry: customRegistry,
	systemPrompt: ["You are helpful."],
	toolNames: ["read", "bash"],
	customTools: [myTool],
	extensions: [myHook],
	skills: [],
	contextFiles: [],
	slashCommands: [],
	sessionManager: SessionManager.inMemory(),
});

// Run prompts
session.subscribe((event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});
await session.prompt("Hello");
```

## Options

| Option                      | Default                       | Description                       |
| --------------------------- | ----------------------------- | --------------------------------- |
| `authStorage`               | `discoverAuthStorage()`       | Credential storage                |
| `modelRegistry`             | `discoverModels(authStorage)` | Model registry                    |
| `cwd`                       | `process.cwd()`               | Working directory                 |
| `agentDir`                  | `~/.proto/agent`                | Config directory                  |
| `model`                     | From settings/first available | Model to use                      |
| `thinkingLevel`             | From settings/"off"           | off, low, medium, high            |
| `systemPrompt`              | Discovered                    | String or `(default) => modified` |
| `toolNames`                 | All built-in tools            | Filter which tools to include     |
| `customTools`               | Discovered                    | Replaces discovery                |
| `additionalCustomToolPaths` | `[]`                          | Merge with discovery              |
| `hooks`                     | Discovered                    | Replaces discovery                |
| `additionalHookPaths`       | `[]`                          | Merge with discovery              |
| `skills`                    | Discovered                    | Skills for prompt                 |
| `contextFiles`              | Discovered                    | AGENTS.md files                   |
| `slashCommands`             | Discovered                    | File commands                     |
| `sessionManager`            | `SessionManager.create(cwd)`  | Persistence                       |
| `settingsManager`           | From agentDir                 | Settings overrides                |

## Events

```typescript
session.subscribe((event) => {
	switch (event.type) {
		case "message_update":
			if (event.assistantMessageEvent.type === "text_delta") {
				process.stdout.write(event.assistantMessageEvent.delta);
			}
			break;
		case "tool_execution_start":
			console.log(`Tool: ${event.toolName}`);
			break;
		case "tool_execution_end":
			console.log(`Result: ${event.result}`);
			break;
		case "agent_end":
			console.log("Done");
			break;
	}
});
```
