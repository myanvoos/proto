import { logger } from "@oh-my-pi/pi-utils";
import { throwIfAborted } from "../tools/tool-errors";
import type { DaemonBrokerClient } from "./client";
import { DaemonBrokerRejectedError, type DaemonSnapshot } from "./protocol";

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

export async function describeQuietly(
	client: DaemonBrokerClient,
	name: string,
	label: string,
	signal?: AbortSignal,
): Promise<DaemonSnapshot | undefined> {
	try {
		const result = await client.request({ op: "describe", name }, signal);
		return result.op === "describe" ? result.daemon : undefined;
	} catch (error) {
		throwIfAborted(signal);
		logger.debug(`${label} describe failed`, {
			name,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

export type DaemonDescription =
	| { status: "found"; daemon: DaemonSnapshot }
	| { status: "absent" }
	| { status: "unknown" };

/**
 * Snapshot a broker daemon, telling an unregistered name apart from a failed
 * lookup. The broker reports an unknown name only as a rejection, and rejects
 * requests for other reasons (authentication, validation) the same way, so a
 * rejected `describe` is settled by the broker's daemon list. Use this instead
 * of {@link describeQuietly} when absence authorizes a step that would harm a
 * running daemon.
 */
export async function describeDaemon(
	client: DaemonBrokerClient,
	name: string,
	label: string,
	signal?: AbortSignal,
): Promise<DaemonDescription> {
	try {
		const result = await client.request({ op: "describe", name }, signal);
		return result.op === "describe" ? { status: "found", daemon: result.daemon } : { status: "unknown" };
	} catch (error) {
		throwIfAborted(signal);
		logger.debug(`${label} describe failed`, {
			name,
			error: error instanceof Error ? error.message : String(error),
		});
		if (!(error instanceof DaemonBrokerRejectedError)) return { status: "unknown" };
	}
	try {
		const result = await client.request({ op: "list" }, signal);
		if (result.op !== "list") return { status: "unknown" };
		const daemon = result.daemons.find(listed => listed.name === name);
		return daemon ? { status: "found", daemon } : { status: "absent" };
	} catch (error) {
		throwIfAborted(signal);
		logger.debug(`${label} list failed`, {
			name,
			error: error instanceof Error ? error.message : String(error),
		});
		return { status: "unknown" };
	}
}

export async function waitReady(
	client: DaemonBrokerClient,
	name: string,
	label: string,
	signal?: AbortSignal,
	timeoutMs: number = DEFAULT_READY_TIMEOUT_MS,
): Promise<DaemonSnapshot | undefined> {
	try {
		const result = await client.request({ op: "wait", name, for: "ready", timeoutMs }, signal);
		if (result.op !== "wait" || result.timedOut) return undefined;
		return result.daemon;
	} catch (error) {
		throwIfAborted(signal);
		logger.debug(`${label} ready wait failed`, {
			name,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

export async function stopQuietly(
	client: DaemonBrokerClient,
	name: string,
	label: string,
	signal?: AbortSignal,
	expectedId?: string,
): Promise<DaemonSnapshot | undefined> {
	try {
		const result = await client.request({ op: "stop", name, timeoutMs: STOP_TIMEOUT_MS, expectedId }, signal);
		return result.op === "stop" ? result.daemon : undefined;
	} catch (error) {
		throwIfAborted(signal);
		logger.debug(`${label} stop failed`, {
			name,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
