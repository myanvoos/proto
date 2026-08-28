import { logger } from "@oh-my-pi/pi-utils";

const CODE_MODE_KEEP_TOOLS: Record<string, true> = {
	eval: true,
	ask: true,
	todo: true,
	yield: true,
	think: true,
	__agent__: true,
	__budget__: true,
	__completion__: true,
	__concurrency__: true,
};

interface CodeModeResolution {
	active: boolean;

	directToolNames: Set<string>;
}

export function resolveCodeMode(args: {
	provider: string;
	toolMode?: string;
	setting: "off" | "on" | "auto";
	extraDirectTools?: readonly string[];
	enabledToolNames: readonly string[];
	evalTransportAvailable: boolean;
}): CodeModeResolution {
	const active =
		args.provider === "openai-codex" &&
		args.enabledToolNames.includes("eval") &&
		args.evalTransportAvailable &&
		(args.setting === "on" || (args.setting === "auto" && args.toolMode === "code_mode_only"));
	if (!active) return { active: false, directToolNames: new Set(args.enabledToolNames) };
	const direct = new Set<string>();
	for (const name of args.enabledToolNames) {
		if (CODE_MODE_KEEP_TOOLS[name] === true) direct.add(name);
	}
	for (const name of args.extraDirectTools ?? []) {
		if (args.enabledToolNames.includes(name)) direct.add(name);
	}
	return { active: true, directToolNames: direct };
}

interface ToolNamespaceFunctionInfo {
	name: string;
	direct: boolean;
	code_mode_name: string | null;
	deferred: boolean;
	source: { kind: "harness" } | { kind: "mcp"; server_name: string };
}

export interface ToolNamespacesInfo {
	[namespace: string]: {
		name: string;
		functions: Record<string, ToolNamespaceFunctionInfo>;
	};
}

export function buildToolNamespacesInfo(args: {
	tools: ReadonlyArray<{ name: string; customWireName?: string; loadMode?: string; mcpServerName?: string }>;
	directToolNames: ReadonlySet<string>;
}): ToolNamespacesInfo {
	const functions: Record<string, ToolNamespaceFunctionInfo> = Object.create(null);
	for (const tool of args.tools) {
		const direct = args.directToolNames.has(tool.name);
		const wireName = direct ? (tool.customWireName ?? tool.name) : tool.name;
		const existing = functions[wireName];

		if (existing) {
			const existingExact = existing.code_mode_name === wireName;
			const candidateExact = tool.name === wireName;
			const replace = direct && (!existing.direct || (candidateExact && !existingExact));
			logger.warn("Code Mode wire name collision", {
				wireName,
				kept: replace ? tool.name : existing.code_mode_name,
				dropped: replace ? existing.code_mode_name : tool.name,
			});
			if (!replace) continue;
		}
		functions[wireName] = {
			name: wireName,
			direct,
			code_mode_name: tool.name,
			deferred: tool.loadMode === "discoverable",
			source: tool.mcpServerName ? { kind: "mcp", server_name: tool.mcpServerName } : { kind: "harness" },
		};
	}
	return { functions: { name: "functions", functions } };
}
