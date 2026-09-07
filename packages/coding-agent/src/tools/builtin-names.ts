export const BUILTIN_TOOL_NAMES = [
	"read",
	"bash",
	"ask",
	"eval",
	"kernel",
	"github",
	"inspect_media",
	"browser",
	"computer",
	"checkpoint",
	"rewind",
	"orchestrate_spawn",
	"orchestrate_send",
	"orchestrate_wait",
	"orchestrate_kill",
	"orchestrate_list",
	"fleet",
	"monitor",
	"todo",
	"web_search",
	"manage_skill",
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

const HIDDEN_TOOL_NAMES = ["yield", "goal", "think"] as const;

export type HiddenToolName = (typeof HIDDEN_TOOL_NAMES)[number];

const CANONICAL_TOOL_NAMES: Record<string, true> = Object.fromEntries(
	[...BUILTIN_TOOL_NAMES, ...HIDDEN_TOOL_NAMES].map(name => [name, true]),
);

export function normalizeToolName(name: string): string {
	const lower = name.toLowerCase();
	return Object.hasOwn(CANONICAL_TOOL_NAMES, lower) ? lower : name;
}

export function normalizeToolNames(names: Iterable<string>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		const normalized = normalizeToolName(name);
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

export function isMCPToolName(name: string): boolean {
	return name.startsWith("mcp__");
}
