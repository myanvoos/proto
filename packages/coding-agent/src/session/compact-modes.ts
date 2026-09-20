import type { CompactionMethod } from "./compaction-methods";

export type CompactMode = "remote";

interface CompactionOverride {
	methodOrder?: CompactionMethod[];
}

interface CompactModeDef {
	readonly name: CompactMode;

	readonly description: string;

	readonly overrides: CompactionOverride;
}

export const COMPACT_MODES: readonly CompactModeDef[] = [
	{
		name: "remote",
		description: "Compact via OpenAI-compatible server compaction or the configured remote endpoint",
		overrides: { methodOrder: ["remote"] },
	},
];

export function findCompactMode(name: string): CompactModeDef | undefined {
	const key = name.trim().toLowerCase();
	return COMPACT_MODES.find(mode => mode.name === key);
}

interface ParsedCompactArgs {
	mode?: CompactMode;
	instructions?: string;
}

export function parseCompactArgs(args: string): ParsedCompactArgs | { error: string } {
	const trimmed = args.trim();
	if (!trimmed) return {};

	const spaceIndex = trimmed.search(/\s/);
	const firstToken = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
	const mode = findCompactMode(firstToken);
	if (!mode) {
		return { instructions: trimmed };
	}

	const focus = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();
	return { mode: mode.name, instructions: focus || undefined };
}
