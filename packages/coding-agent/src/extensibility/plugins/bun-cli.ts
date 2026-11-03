import { resolveExecutablePath } from "../../subprocess/worker-client";

export interface BunCliResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** Re-enter the embedded Bun instead of requiring a separate Bun installation on PATH. */
export async function runBunCli(args: readonly string[], cwd: string): Promise<BunCliResult> {
	const proc = Bun.spawn([resolveExecutablePath(), ...args], {
		cwd,
		env: { ...Bun.env, BUN_BE_BUN: "1" },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}
