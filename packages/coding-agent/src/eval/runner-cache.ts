import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const stagedPaths = new Map<string, string>();

export async function stageRunnerScript(dirName: string, ext: string, script: string): Promise<string> {
	const memoized = stagedPaths.get(dirName);
	if (memoized && (await Bun.file(memoized).exists())) return memoized;
	const dir = path.join(os.tmpdir(), dirName);
	await fs.promises.mkdir(dir, { recursive: true });
	const hash = Bun.hash(script).toString(36);
	const target = path.join(dir, `runner-${hash}.${ext}`);
	await Bun.write(target, script);
	stagedPaths.set(dirName, target);
	return target;
}
