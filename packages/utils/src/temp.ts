import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Owned temporary directory, removed via `remove()` or `using`/`await using`.
 *
 * Prefixes follow `mkdtemp`: `"@name-"` creates under the OS temp dir, any other
 * prefix is a path (a bare `"name-"` lands in the process cwd), and no prefix
 * means `"@pi-temp-"`.
 */
export class TempDir {
	#path: string;
	private constructor(path: string) {
		this.#path = path;
	}

	static createSync(prefix?: string): TempDir {
		return new TempDir(fs.mkdtempSync(normalizePrefix(prefix)));
	}

	static async create(prefix?: string): Promise<TempDir> {
		return new TempDir(await fsPromises.mkdtemp(normalizePrefix(prefix)));
	}

	/** Private socket directory; AF_UNIX limits apply to UTF-8 bytes, independent of TMPDIR length. */
	static async createForUnixSocket(prefix: string, socketName: string): Promise<TempDir> {
		if (![prefix, socketName].every(part => /^[a-zA-Z0-9._-]+$/.test(part)))
			throw new Error("Socket directory prefix and name must be basenames");
		let base = os.tmpdir();
		if (!unixSocketPathFits(path.join(base, `${prefix}XXXXXX`, socketName))) base = "/tmp";
		if (!unixSocketPathFits(path.join(base, `${prefix}XXXXXX`, socketName)))
			throw new Error("Unix socket directory prefix exceeds the platform path limit");
		return TempDir.create(path.join(base, prefix));
	}

	#removePromise: Promise<void> | null = null;

	path(): string {
		return this.#path;
	}

	absolute(): string {
		return path.resolve(this.#path);
	}

	remove(): Promise<void> {
		if (this.#removePromise) {
			return this.#removePromise;
		}
		const removePromise = removeWithRetries(this.#path).catch(error => {
			if (this.#removePromise === removePromise) {
				this.#removePromise = null;
			}
			throw error;
		});
		this.#removePromise = removePromise;
		return removePromise;
	}

	removeSync(): void {
		removeSyncWithRetries(this.#path);
		this.#removePromise = Promise.resolve();
	}

	toString(): string {
		return this.#path;
	}

	join(...paths: string[]): string {
		return path.join(this.#path, ...paths);
	}

	async [Symbol.asyncDispose](): Promise<void> {
		try {
			await this.remove();
		} catch {}
	}

	[Symbol.dispose](): void {
		try {
			this.removeSync();
		} catch {}
	}
}

/** Leave room for the trailing NUL in sockaddr_un.sun_path. */
export function unixSocketPathFits(socketPath: string, platform: typeof process.platform = process.platform): boolean {
	return Buffer.byteLength(socketPath) < (platform === "darwin" ? 104 : 108);
}

const kTempDir = os.tmpdir();

function normalizePrefix(prefix?: string): string {
	if (!prefix) {
		return `${kTempDir}${path.sep}pi-temp-`;
	} else if (prefix.startsWith("@")) {
		return path.join(kTempDir, prefix.slice(1));
	}
	return prefix;
}

const kRemoveOptions = { recursive: true, force: true, maxRetries: 3, retryDelay: 100 } as const;

export async function removeWithRetries(target: string): Promise<void> {
	await fsPromises.rm(target, kRemoveOptions);
}

export function removeSyncWithRetries(target: string): void {
	fs.rmSync(target, kRemoveOptions);
}
