import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { FileLock as NativeFileLock } from "@oh-my-pi/pi-natives";

export interface FileLockOptions {
	retries?: number;

	retryDelayMs?: number;
	signal?: AbortSignal;
}

export interface FileLockHandle {
	release(): void;
}

const DEFAULT_OPTIONS = {
	retries: 50,
	retryDelayMs: 100,
};

function getLockPath(filePath: string): string {
	return `${path.resolve(filePath)}.lock`;
}

/** Attempts once to acquire the file lock. The caller must release a returned handle. */
export function tryAcquireFileLockSync(filePath: string): FileLockHandle | null {
	const lock = NativeFileLock.tryAcquire(getLockPath(filePath));
	if (lock.acquired) return lock;
	lock.release();
	return null;
}

export async function acquireFileLock(filePath: string, options: FileLockOptions = {}): Promise<FileLockHandle> {
	const opts = { ...DEFAULT_OPTIONS, ...options };

	for (let attempt = 0; attempt < opts.retries; attempt++) {
		opts.signal?.throwIfAborted();
		const lock = tryAcquireFileLockSync(filePath);
		if (lock) return lock;
		if (attempt + 1 < opts.retries) await scheduler.wait(opts.retryDelayMs, { signal: opts.signal });
	}

	throw new Error(`Failed to acquire lock for ${filePath} after ${opts.retries} attempts`);
}

function acquireLockSync(filePath: string, options: FileLockOptions = {}): FileLockHandle {
	const opts = { ...DEFAULT_OPTIONS, ...options };

	for (let attempt = 0; attempt < opts.retries; attempt++) {
		opts.signal?.throwIfAborted();
		const lock = tryAcquireFileLockSync(filePath);
		if (lock) return lock;
		if (attempt + 1 < opts.retries && opts.retryDelayMs > 0) Bun.sleepSync(opts.retryDelayMs);
	}

	throw new Error(`Failed to acquire lock for ${filePath} after ${opts.retries} attempts`);
}

export async function withFileLock<T>(
	filePath: string,
	fn: () => Promise<T>,
	options: FileLockOptions = {},
): Promise<T> {
	const lock = await acquireFileLock(filePath, options);
	try {
		return await fn();
	} finally {
		lock.release();
	}
}

export function withFileLockSync<T>(filePath: string, fn: () => T, options: FileLockOptions = {}): T {
	const lock = acquireLockSync(filePath, options);
	try {
		return fn();
	} finally {
		lock.release();
	}
}
