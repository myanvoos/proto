import * as path from "node:path";
import { getRemoteDir } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../sdk";
import { findUniqueWorkspaceSuffix } from "./path-utils";

const REMOTE_MOUNT_PREFIX = getRemoteDir() + path.sep;
export function isRemoteMountPath(absolutePath: string): boolean {
	return absolutePath.startsWith(REMOTE_MOUNT_PREFIX);
}
export function isNotFoundError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const code = (error as { code?: string }).code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Named pipes and sockets stat like files but block (or fail obscurely) on open, so a read of one
 * never returns. Character devices such as `/dev/zero` and `/dev/null` do return, so they are left
 * alone.
 */
export function describeUnreadableFileType(stat: {
	isFIFO?: () => boolean;
	isSocket?: () => boolean;
}): string | undefined {
	if (stat.isFIFO?.()) return "a named pipe (FIFO), which blocks until another process writes to it";
	if (stat.isSocket?.()) return "a socket, which cannot be opened for reading";
	return undefined;
}

export type SuffixMatchCache = Map<string, { absolutePath: string; displayPath: string } | null>;

export async function findSuffixMatchCached(
	session: ToolSession,
	cache: SuffixMatchCache,
	rawPath: string,
	signal?: AbortSignal,
): Promise<{ absolutePath: string; displayPath: string } | null> {
	const hit = cache.get(rawPath);
	if (hit !== undefined) return hit;
	const result = await findUniqueWorkspaceSuffix(rawPath, session.cwd, signal);
	cache.set(rawPath, result);
	return result;
}
