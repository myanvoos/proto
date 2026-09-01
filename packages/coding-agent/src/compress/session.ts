import { getProjectDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { formatModelString, resolveCliModel } from "../config/model-resolver";
import { Settings } from "../config/settings";
import { createAgentSession, discoverAuthStorage } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import systemPrompt from "./prompts/system.md" with { type: "text" };
import type { CompressProtocol } from "./protocol";

interface CompressSession {
	session: AgentSession;
	model: string;
}

export async function createCompressSession(options: {
	cwd?: string;
	model?: string;
	protocol: CompressProtocol;

	agentId?: string;
}): Promise<CompressSession> {
	const cwd = options.cwd ?? getProjectDir();
	const [settings, authStorage] = await Promise.all([Settings.init({ cwd }), discoverAuthStorage()]);
	const modelRegistry = new ModelRegistry(authStorage);
	await modelRegistry.refresh();

	const resolved = options.model ? resolveCliModel({ cliModel: options.model, modelRegistry, settings }) : undefined;
	if (resolved && (resolved.error || !resolved.model)) {
		throw new Error(resolved.error ?? `Model "${options.model}" not found`);
	}
	const { session } = await createAgentSession({
		cwd,
		settings,
		authStorage,
		modelRegistry,
		...(resolved?.model ? { model: resolved.model } : {}),
		customTools: [options.protocol.rewriteTool(), options.protocol.approveTool()],
		toolNames: ["rewrite", "approve"],
		restrictToolNames: true,
		allowRestrictedCustomTools: true,

		systemPrompt: [systemPrompt.trim()],
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableIrc: false,
		hasUI: false,
		agentId: options.agentId ?? "Compress",
		agentDisplayName: "compress",
	});
	const active = resolved?.model ?? session.model;
	return { session, model: active ? formatModelString(active) : "session default" };
}
