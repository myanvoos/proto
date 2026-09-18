import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const stagedPaths = new Map<string, string>();

function cacheKey(dirName: string, ext: string, script: string): string {
	return `${dirName}\0${ext}\0${Bun.hash(script).toString(36)}`;
}

function safePrefix(dirName: string): string {
	const readable = dirName.replaceAll(/[^A-Za-z0-9._-]/g, "-").slice(0, 48) || "proto-runner";
	return `${readable}-${Bun.hash(dirName).toString(36)}-`;
}

async function verifyStagedRunner(target: string, expected?: { dev: number; ino: number }): Promise<void> {
	const [directoryStat, fileStat] = await Promise.all([
		fs.promises.lstat(path.dirname(target)),
		fs.promises.lstat(target),
	]);
	if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
		throw new Error(`Runner staging directory is not a real directory: ${path.dirname(target)}`);
	}
	if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1) {
		throw new Error(`Staged runner is not a private regular file: ${target}`);
	}
	if (process.platform !== "win32") {
		const uid = process.getuid?.();
		if (uid !== undefined && (directoryStat.uid !== uid || fileStat.uid !== uid)) {
			throw new Error(`Staged runner ownership changed before execution: ${target}`);
		}
		if ((directoryStat.mode & 0o777) !== 0o700 || (fileStat.mode & 0o777) !== 0o600) {
			throw new Error(`Staged runner permissions are not private: ${target}`);
		}
	}
	if (expected && (fileStat.dev !== expected.dev || fileStat.ino !== expected.ino)) {
		throw new Error(`Staged runner changed before execution: ${target}`);
	}
}

export async function stageRunnerScript(dirName: string, ext: string, script: string): Promise<string> {
	if (!/^[A-Za-z0-9]+$/.test(ext)) throw new Error(`Invalid runner extension: ${ext}`);
	const key = cacheKey(dirName, ext, script);
	const memoized = stagedPaths.get(key);
	if (memoized) {
		try {
			await verifyStagedRunner(memoized);
			return memoized;
		} catch {
			stagedPaths.delete(key);
		}
	}

	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), safePrefix(dirName)));
	try {
		await fs.promises.chmod(dir, 0o700);
		const hash = Bun.hash(script).toString(36);
		const target = path.join(dir, `runner-${hash}.${ext}`);
		const noFollow = fs.constants.O_NOFOLLOW ?? 0;
		const handle = await fs.promises.open(
			target,
			fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
			0o600,
		);
		let openedStat: fs.Stats;
		try {
			await handle.writeFile(script, "utf8");
			await handle.chmod(0o600);
			openedStat = await handle.stat();
		} finally {
			await handle.close();
		}
		await verifyStagedRunner(target, { dev: openedStat.dev, ino: openedStat.ino });
		stagedPaths.set(key, target);
		return target;
	} catch (error) {
		await fs.promises.rm(dir, { recursive: true, force: true });
		throw error;
	}
}
