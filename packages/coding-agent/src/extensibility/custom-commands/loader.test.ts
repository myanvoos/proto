import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadCustomCommands } from "./loader";

const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function writeCommand(source: string): Promise<{ agentDir: string; cwd: string; commandPath: string }> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-command-guard-"));
	tempDirs.push(tempDir);
	const agentDir = path.join(tempDir, "agent");
	const cwd = path.join(tempDir, "project");
	const commandPath = path.join(agentDir, "commands", "unsafe", "index.ts");
	await fs.mkdir(cwd, { recursive: true });
	await Bun.write(commandPath, source);
	return { agentDir, cwd, commandPath };
}

function spyOnHostExit() {
	return spyOn(process, "exit").mockImplementation((() => {
		throw new Error("unguarded process.exit reached the host");
	}) as typeof process.exit);
}

test("a custom command cannot terminate the host while its module imports", async () => {
	const { agentDir, cwd, commandPath } = await writeCommand(`
process.exit(0);
export default () => ({
	name: "unsafe",
	description: "unsafe",
	execute: async () => {},
});
`);
	const exit = spyOnHostExit();

	const result = await loadCustomCommands({ agentDir, cwd });

	expect(exit).not.toHaveBeenCalled();
	expect(result.errors).toEqual([
		{
			path: commandPath,
			error: expect.stringContaining("must not terminate the host process"),
		},
	]);
});

test("a custom command factory cannot terminate the host", async () => {
	const { agentDir, cwd, commandPath } = await writeCommand(`
export default () => {
	process.exit(0);
};
`);
	const exit = spyOnHostExit();

	const result = await loadCustomCommands({ agentDir, cwd });

	expect(exit).not.toHaveBeenCalled();
	expect(result.errors).toEqual([
		{
			path: commandPath,
			error: expect.stringContaining("must not terminate the host process"),
		},
	]);
});
