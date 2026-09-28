import { createRequire } from "node:module";
import * as path from "node:path";

/** Embed the SDK's own native Claude binary, matched to the compiled Proto target. */
export function createClaudeAgentPlugin(target?: Bun.Build.CompileTarget): Bun.BunPlugin {
	const parts = (target ?? `bun-${process.platform}-${process.arch}`).split("-");
	const platform = parts[1] === "windows" ? "win32" : parts[1];
	const arch = parts[2];
	const packageName = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}${parts.includes("musl") ? "-musl" : ""}`;
	const executable = platform === "win32" ? "claude.exe" : "claude";
	const require = createRequire(import.meta.url);
	let binary: string;
	try {
		binary = require.resolve(`${packageName}/${executable}`);
	} catch (cause) {
		throw new Error(
			`Missing Claude SDK binary ${packageName}. Install optional dependencies for the compile target (bun install --os='*' --cpu='*').`,
			{ cause },
		);
	}
	return {
		name: "claude-agent-executable",
		setup(build) {
			build.onLoad({ filter: /[/]claude-agent-executable\.ts$/ }, () => ({
				contents: `import binary from ${JSON.stringify(binary)} with { type: "file" };
import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract";
export function claudeAgentExecutable() { return process.env.PI_CLAUDE_EXECUTABLE ?? extractFromBunfs(binary); }`,
				loader: "ts",
				resolveDir: path.dirname(import.meta.path),
			}));
		},
	};
}
