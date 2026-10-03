import * as path from "node:path";
import { IsoBackendKind } from "@oh-my-pi/pi-natives";
import { atomicWriteJson, isEnoent } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

export const ISOLATION_OWNER_FILE = ".proto-isolation-owner.json";

interface IsolationOwner {
	pid: number;

	id: string;

	startToken?: string;
}

async function processStartToken(pid: number): Promise<string | null> {
	if (process.platform === "linux") {
		let stat: string;
		try {
			stat = await Bun.file(`/proc/${pid}/stat`).text();
		} catch {
			return null;
		}

		const commEnd = stat.lastIndexOf(")");
		if (commEnd < 0) return null;
		const starttime = stat.slice(commEnd + 2).split(" ")[19];
		return starttime && starttime.length > 0 ? starttime : null;
	}
	const res = await $`ps -o lstart= -p ${pid}`.quiet().nothrow();
	if (res.exitCode !== 0) return null;
	const started = res.text().trim();
	return started.length > 0 ? started : null;
}

export async function writeIsolationOwner(baseDir: string, id: string): Promise<void> {
	const startToken = await processStartToken(process.pid);
	const owner: IsolationOwner = { pid: process.pid, id, ...(startToken ? { startToken } : {}) };
	await Bun.write(path.join(baseDir, ISOLATION_OWNER_FILE), JSON.stringify(owner));
}

export async function hasLiveIsolationOwner(baseDir: string): Promise<boolean> {
	let decoded: unknown;
	try {
		decoded = await Bun.file(path.join(baseDir, ISOLATION_OWNER_FILE)).json();
	} catch {
		return false;
	}
	if (typeof decoded !== "object" || decoded === null || !("pid" in decoded)) return false;
	const pid = decoded.pid;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
	}

	if ("startToken" in decoded && typeof decoded.startToken === "string" && decoded.startToken.length > 0) {
		const current = await processStartToken(pid);
		if (current !== null && current !== decoded.startToken) return false;
	}
	return true;
}

export const RETAINED_BACKEND_FILE = ".proto-retained-backend.json";

export function needsNativeTeardown(backend: IsoBackendKind): boolean {
	return backend === IsoBackendKind.Overlayfs || backend === IsoBackendKind.Btrfs;
}

export async function writeRetainedBackend(baseDir: string, backend: IsoBackendKind): Promise<void> {
	await atomicWriteJson(path.join(baseDir, RETAINED_BACKEND_FILE), {
		backend,
		retainedAt: new Date().toISOString(),
	});
}

export async function readRetainedBackend(baseDir: string): Promise<IsoBackendKind | undefined> {
	const sidecar = path.join(baseDir, RETAINED_BACKEND_FILE);
	let decoded: unknown;
	try {
		decoded = await Bun.file(sidecar).json();
	} catch (error) {
		if (isEnoent(error) && !path.basename(baseDir).includes(".retained-")) return undefined;
		throw new Error(
			`Cannot read retained workspace metadata at ${sidecar}; recover the workspace before manual cleanup.`,
			{ cause: error },
		);
	}
	if (
		typeof decoded !== "object" ||
		decoded === null ||
		!("backend" in decoded) ||
		typeof decoded.backend !== "number" ||
		!Object.values(IsoBackendKind).includes(decoded.backend as IsoBackendKind)
	) {
		throw new Error(`Malformed retained workspace metadata at ${sidecar}; refusing to remove the workspace.`);
	}
	return decoded.backend as IsoBackendKind;
}
