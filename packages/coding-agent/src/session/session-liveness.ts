import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { type FileLockHandle, tryAcquireFileLockSync } from "@oh-my-pi/pi-utils/file-lock";

export const SESSION_LIVE_HEARTBEAT_INTERVAL_MS = 5_000;

export const SESSION_LIVE_FRESH_WINDOW_MS = 15_000;

export function getSessionLivePath(sessionFile: string): string {
	return `${sessionFile}.live`;
}

export interface SessionLiveState {
	fresh: boolean;
	streaming: boolean;
	pid: number | undefined;
}

interface LiveMarkerContent {
	pid: number;
	streaming: boolean;
}

const NOT_LIVE: SessionLiveState = { fresh: false, streaming: false, pid: undefined };

function parseLiveMarker(content: string): LiveMarkerContent | undefined {
	try {
		const parsed: unknown = JSON.parse(content);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const pid = (parsed as { pid?: unknown }).pid;
		const streaming = (parsed as { streaming?: unknown }).streaming;
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
		return { pid, streaming: streaming === true };
	} catch {
		return undefined;
	}
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code !== "ESRCH" && code !== "EINVAL";
	}
}

function writeLiveMarker(sessionFile: string, streaming: boolean): void {
	const livePath = getSessionLivePath(sessionFile);
	const tmpPath = `${livePath}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(tmpPath, JSON.stringify({ pid: process.pid, streaming, at: Date.now() }), {
			encoding: "utf8",
			mode: 0o600,
		});
		fs.renameSync(tmpPath, livePath);
	} catch (error) {
		logger.debug("Failed to write session live marker", { sessionFile, error: String(error) });
		try {
			fs.rmSync(tmpPath, { force: true });
		} catch {}
	}
}

function touchLiveMarker(sessionFile: string): void {
	const livePath = getSessionLivePath(sessionFile);
	const now = new Date();
	try {
		fs.utimesSync(livePath, now, now);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			writeLiveMarker(sessionFile, false);
			return;
		}
		logger.debug("Failed to touch session live marker", { sessionFile, error: String(error) });
	}
}

export function readSessionLiveState(sessionFile: string, now = Date.now()): SessionLiveState {
	const livePath = getSessionLivePath(sessionFile);
	let mtimeMs: number;
	try {
		mtimeMs = fs.statSync(livePath).mtimeMs;
	} catch {
		return NOT_LIVE;
	}
	if (now - mtimeMs >= SESSION_LIVE_FRESH_WINDOW_MS) return NOT_LIVE;
	let marker: LiveMarkerContent | undefined;
	try {
		marker = parseLiveMarker(fs.readFileSync(livePath, "utf8"));
	} catch {
		marker = undefined;
	}
	if (marker && !processExists(marker.pid)) return NOT_LIVE;
	return { fresh: true, streaming: marker?.streaming ?? false, pid: marker?.pid };
}

/** PID of another live proto process that currently owns `sessionFile`, if any. */
export function liveSessionOwnerPid(sessionFile: string, now = Date.now()): number | undefined {
	const live = readSessionLiveState(sessionFile, now);
	if (!live.fresh || live.pid === undefined || live.pid === process.pid) return undefined;
	return live.pid;
}

/**
 * Ownership of a session file is exclusive to one proto process. The heartbeat
 * marker alone cannot express that: it is advisory and is published after the
 * session is already open, so two processes starting at once both see an
 * unowned file and then overwrite each other's turns. The claim below is an OS
 * level lock taken before the file is read, so the loser is told immediately
 * instead of losing its turn.
 */
let ownedSessionFile: string | undefined;
let ownershipHandle: FileLockHandle | null = null;

function ownershipLockKey(sessionFile: string): string {
	return `${path.resolve(sessionFile)}.owner`;
}

/**
 * Claims this process as the owner of `sessionFile`, replacing any previous
 * claim. Returns false when another live process already owns it.
 */
export function claimSessionOwnership(sessionFile: string | null | undefined): boolean {
	if (!sessionFile) return true;
	const resolved = path.resolve(sessionFile);
	if (ownedSessionFile === resolved) return true;

	// Both signals matter: the lock settles races between processes starting at the
	// same moment, the heartbeat marker covers a session another process already
	// holds open (it may have claimed it before switching to it).
	if (liveSessionOwnerPid(resolved) !== undefined) return false;

	const handle = tryAcquireFileLockSync(ownershipLockKey(resolved));
	if (!handle) return false;

	releaseSessionOwnership();
	ownedSessionFile = resolved;
	ownershipHandle = handle;
	// Publishing the marker with the claim means other processes can name the
	// owner in their refusal from the first moment the session is owned.
	writeLiveMarker(resolved, false);
	return true;
}

export function releaseSessionOwnership(): void {
	ownershipHandle?.release();
	ownershipHandle = null;
	ownedSessionFile = undefined;
}

/** Session file this process currently owns, if any. */
export function ownedSessionFilePath(): string | undefined {
	return ownedSessionFile;
}

export class SessionLiveHeartbeat {
	#sessionFile: string;
	#timer: NodeJS.Timeout | undefined;
	#streaming = false;
	#stopped = false;

	constructor(sessionFile: string, intervalMs: number = SESSION_LIVE_HEARTBEAT_INTERVAL_MS) {
		this.#sessionFile = sessionFile;
		writeLiveMarker(sessionFile, false);
		this.#timer = setInterval(() => touchLiveMarker(this.#sessionFile), intervalMs);
		this.#timer.unref?.();
	}

	setStreaming(streaming: boolean): void {
		if (this.#stopped || this.#streaming === streaming) return;
		this.#streaming = streaming;
		writeLiveMarker(this.#sessionFile, streaming);
	}

	retarget(sessionFile: string): void {
		if (this.#stopped || path.resolve(sessionFile) === path.resolve(this.#sessionFile)) return;
		this.removeMarker();
		this.#sessionFile = sessionFile;
		this.#streaming = false;
		writeLiveMarker(sessionFile, false);
	}

	removeMarker(): void {
		try {
			fs.rmSync(getSessionLivePath(this.#sessionFile), { force: true });
		} catch (error) {
			logger.debug("Failed to remove session live marker", { sessionFile: this.#sessionFile, error: String(error) });
		}
	}

	dispose(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
		this.removeMarker();
	}
}

export function createSessionLiveHeartbeat(
	sessionFile: string | null | undefined,
	intervalMs?: number,
): SessionLiveHeartbeat | undefined {
	if (!sessionFile) return undefined;
	return new SessionLiveHeartbeat(sessionFile, intervalMs);
}
