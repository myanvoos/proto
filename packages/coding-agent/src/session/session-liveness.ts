import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

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
	return { fresh: true, streaming: marker?.streaming ?? false, pid: marker?.pid };
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
