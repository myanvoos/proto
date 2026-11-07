import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

// Real RPC dispatch, native bash execution and transcript storage; model requests are forbidden.
const cwd = process.cwd();
const authStorage = await AuthStorage.create(":memory:");
const modelRegistry = new ModelRegistry(authStorage);
const agent = new Agent({
	initialState: { model: createMockModel({ provider: "anthropic" }), systemPrompt: [], tools: [] },
	convertToLlm,
	streamFn: () => {
		throw new Error("bash-rpc-agent must not call a model");
	},
});
const session = new AgentSession({
	agent,
	sessionManager: SessionManager.inMemory(cwd),
	settings: Settings.isolated({ "compaction.enabled": false }),
	modelRegistry,
});
await runRpcMode(session);
