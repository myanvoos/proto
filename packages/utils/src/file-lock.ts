import * as path from "node:path";
import { FileLock as NativeFileLock } from "@oh-my-pi/pi-natives";

export interface FileLockOptions {
	retries?: number;

	retryDelayMs?: number;
}

export interface FileLockHandle {
	release(): void;
}

const DEFAULT_OPTIONS: Required<FileLockOptions> = {
	retries: 50,
	retryDelayMs: 100,
};

function getLockPath(filePath: string): string {
	return `${path.resolve(filePath)}.lock`;
}

/** Attempts once to acquire the file lock. The caller must release a returned handle. */
export function tryAcquireFileLockSync(filePath: string): FileLockHandle | null {
	const lock = NativeFileLock.tryAcquire(getLockPath(filePath));
	return lock.acquired ? lock : null;
}

async function acquireLock(filePath: string, options: FileLockOptions = {}): Promise<FileLockHandle> {
	const opts = { ...DEFAULT_OPTIONS, ...options };

	for (let attempt = 0; attempt < opts.retries; attempt++) {
		const lock = tryAcquireFileLockSync(filePath);
		if (lock) return lock;
		if (attempt + 1 < opts.retries) await Bun.sleep(opts.retryDelayMs);
	}

	throw new Error(`Failed to acquire lock for ${filePath} after ${opts.retries} attempts`);
}

export async function withFileLock<T>(
	filePath: string,
	fn: () => Promise<T>,
	options: FileLockOptions = {},
): Promise<T> {
	const lock = await acquireLock(filePath, options);
	try {
		return await fn();
	} finally {
		lock.release();
	}
}
