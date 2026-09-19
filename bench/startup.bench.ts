import { formatArtifact, runSuite } from "./harness";

const cwd = process.cwd();
const cli = `${cwd}/packages/coding-agent/src/cli.ts`;

type Fixture = { command: string[] };

async function runProcess({ command }: Fixture): Promise<void> {
	const child = Bun.spawn(command, {
		cwd,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	const exitCode = await child.exited;
	if (exitCode !== 0) throw new Error(`${command.join(" ")} exited with ${exitCode}`);
}

const artifact = await runSuite(
	"startup",
	[
		{ name: "root-version", setup: () => ({ command: ["bun", cli, "--version"] }), run: runProcess },
		{ name: "root-help", setup: () => ({ command: ["bun", cli, "--help"] }), run: runProcess },
		{ name: "ps", setup: () => ({ command: ["bun", cli, "ps"] }), run: runProcess },
		{ name: "gc-help", setup: () => ({ command: ["bun", cli, "gc", "--help"] }), run: runProcess },
		{ name: "models-help", setup: () => ({ command: ["bun", cli, "models", "--help"] }), run: runProcess },
		{ name: "setup-help", setup: () => ({ command: ["bun", cli, "setup", "--help"] }), run: runProcess },
		{ name: "launch-version", setup: () => ({ command: ["bun", cli, "launch", "--version"] }), run: runProcess },
		{
			name: "isolated-import-main",
			setup: () => ({ command: ["bun", "-e", "await import('./packages/coding-agent/src/main.ts')"] }),
			run: runProcess,
		},
	],
	{ runs: 8, warmup: 1 },
);
console.log(formatArtifact(artifact));
