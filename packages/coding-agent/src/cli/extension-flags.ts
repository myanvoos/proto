import { type Args, parseArgs } from "./args";

export interface ExtensionFlagSink {
	getFlags(): Map<string, { type: "boolean" | "string" }>;
	setFlagValue(name: string, value: boolean | string): void;
}

export function applyExtensionFlags(runner: ExtensionFlagSink | undefined, rawArgs: string[]): Args | null {
	if (!runner) return null;
	const parsed = parseArgs(rawArgs, runner.getFlags());

	for (const [name, value] of parsed.unknownFlags) {
		runner.setFlagValue(name, value);
	}
	return parsed;
}
