import * as path from "node:path";
import { matchesKey, ProcessTerminal, STDOUT_BACKLOG_CLEAR_BYTES, type Terminal } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import {
	flagConsumesValue,
	OPTIONAL_VALUE_FLAGS,
	PROFILE_BOOTSTRAP_BOUNDARY_ARG,
	STRING_VALUE_FLAGS,
	VALUELESS_FLAGS,
} from "../cli/flag-tables";
import { type DaemonBrokerClient, daemonClientForProject } from "../launch/client";
import { describeQuietly } from "../launch/ensure";
import {
	DAEMON_CAPABILITY_TERMINAL_ATTACHMENT,
	DAEMON_MAX_READ_BYTES,
	DAEMON_MAX_REQUEST_BYTES,
	type DaemonRpcResult,
	type DaemonSnapshot,
} from "../launch/protocol";
import { releaseSessionOwnership } from "../session/session-liveness";
import { visitEntriesFromFileStream } from "../session/session-loader";
import type { SessionManager } from "../session/session-manager";
import { ensureSessionHost } from "./ensure";
import { resolveSessionHostOwnership } from "./ownership";
import { sessionHostDaemonName } from "./protocol";

/** Session selection and cwd resolution have already happened; never repeat a fork/import in the host. */
export function interactiveHostArgs(rawArgs: readonly string[], sessionFile: string): string[] {
	const result = ["--resume", sessionFile];
	const selections = new Set([
		"--resume",
		"-r",
		"--session",
		"--fork",
		"--cwd",
		"--continue",
		"--from-claude",
		"--from-codex",
	]);
	for (let index = 0; index < rawArgs.length; index++) {
		const argument = rawArgs[index]!;
		if (argument === "--") {
			result.push(...rawArgs.slice(index));
			break;
		}
		const name = argument.split("=", 1)[0]!;
		const consumesValue = flagConsumesValue(argument, rawArgs[index + 1]);
		if (!selections.has(name)) {
			result.push(argument);
			if (consumesValue) result.push(rawArgs[index + 1]!);
		}
		if (consumesValue) index++;
	}
	return result;
}

/** Capture after extension discovery: restart restores durable state, never replays the initial submission. */
export function interactiveHostRestartArgs(
	rawArgs: readonly string[],
	sessionFile: string,
	extensionFlags: ReadonlyMap<string, { type: "boolean" | "string" }> = new Map(),
): string[] {
	const result = ["--resume", sessionFile];
	const startupSelections = new Set([
		"--resume",
		"-r",
		"--session",
		"--fork",
		"--cwd",
		"--continue",
		"-c",
		"--from-claude",
		"--from-codex",
		"--provider",
		"--model",
		"-m",
		"--thinking",
		"--profile",
		"--alias",
	]);
	for (let index = 0; index < rawArgs.length; index++) {
		const argument = rawArgs[index]!;
		if (argument === "--") break;
		if (!argument.startsWith("-") || argument === "-" || argument === PROFILE_BOOTSTRAP_BOUNDARY_ARG) continue;
		const name = argument.split("=", 1)[0]!;
		const extension = name.startsWith("--") ? extensionFlags.get(name.slice(2)) : undefined;
		const knownBuiltin = STRING_VALUE_FLAGS.has(name) || OPTIONAL_VALUE_FLAGS.has(name) || VALUELESS_FLAGS.has(name);
		let consumesValue = false;
		if (!argument.includes("=")) {
			if (extension)
				consumesValue =
					extension.type === "string" && rawArgs[index + 1] !== undefined && !rawArgs[index + 1]!.startsWith("-");
			else if (name === "-m") consumesValue = rawArgs[index + 1] !== undefined;
			else if (knownBuiltin || startupSelections.has(name))
				consumesValue = flagConsumesValue(argument, rawArgs[index + 1]);
		}
		if (!startupSelections.has(name) && (knownBuiltin || extension)) {
			result.push(extension?.type === "boolean" || VALUELESS_FLAGS.has(name) ? name : argument);
			if (consumesValue) result.push(rawArgs[index + 1]!);
		}
		if (consumesValue) index++;
	}
	return result;
}

/**
 * A broker rejection that only means the hosted daemon ended while an attachment
 * request was in flight. The terminal face of a hosted session must treat that as
 * the session exiting, never as a fatal error: the hosted TUI already shut down
 * (and printed its own goodbye), so reporting "Daemon … is exited" and waiting
 * for another Ctrl+C strands the user on a dead attachment.
 */
export function isHostedDaemonGone(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return (
		message === "Process has no live terminal to attach" ||
		message === "Process terminal is unavailable" ||
		/^Daemon .+ is (?:exited|failed|stopping)$/.test(message)
	);
}

/** The remote host owns the real full TUI. This client owns only a bounded terminal attachment. */
export async function relayHostedTerminal(
	client: DaemonBrokerClient,
	daemon: DaemonSnapshot,
	terminal: Terminal = new ProcessTerminal(),
): Promise<"detached" | "exited"> {
	await client.ensureCapability(DAEMON_CAPABILITY_TERMINAL_ATTACHMENT);
	const stopped = Promise.withResolvers<void>();
	const abort = new AbortController();
	const target = { name: daemon.name, expectedId: daemon.id };
	let terminalLeaseId: string | undefined;
	let cursor = 0;
	let inputBytes = 0;
	let inputQueue = Promise.resolve();
	let outcome: "detached" | "exited" = "detached";
	let failure: Error | undefined;
	let closed = false;
	const stop = (error?: unknown): void => {
		if (closed) return;
		closed = true;
		if (error !== undefined) failure = error instanceof Error ? error : new Error(String(error));
		abort.abort();
		stopped.resolve();
	};
	/** The daemon going away ends the attachment cleanly; anything else is a failure to report. */
	const stopFor = (error: unknown): void => {
		if (isHostedDaemonGone(error)) {
			outcome = "exited";
			stop();
			return;
		}
		stop(error);
	};
	const resize = (): void => {
		if (!terminalLeaseId || closed) return;
		void client
			.request(
				{
					op: "terminal_resize",
					...target,
					terminalLeaseId,
					columns: Math.max(1, Math.min(1000, terminal.columns)),
					rows: Math.max(1, Math.min(1000, terminal.rows)),
				},
				abort.signal,
			)
			.catch(error => {
				if (!closed) stopFor(error);
			});
	};
	const onInput = (data: string): void => {
		if (data === "\x1d" || matchesKey(data, "ctrl+]")) {
			stop();
			return;
		}
		if (!terminalLeaseId || closed) return;
		const bytes = Buffer.byteLength(data, "utf8");
		if (bytes + inputBytes > DAEMON_MAX_REQUEST_BYTES / 2) {
			stop(new Error("Terminal input exceeded its bounded queue; session remains running"));
			return;
		}
		inputBytes += bytes;
		const lease = terminalLeaseId;
		inputQueue = inputQueue
			.then(async () => {
				if (closed) return;
				await client.request({ op: "send", ...target, terminalLeaseId: lease, data, enter: false }, abort.signal);
			})
			.catch(error => {
				if (!closed) stopFor(error);
			})
			.finally(() => {
				inputBytes -= bytes;
			});
	};
	const onSignal = (): void => stop();
	process.on("SIGHUP", onSignal);
	process.on("SIGTERM", onSignal);
	try {
		terminal.start(onInput, resize, () => stop());
		let attached: DaemonRpcResult;
		try {
			attached = await client.request({
				op: "terminal_attach",
				...target,
				columns: Math.max(1, Math.min(1000, terminal.columns)),
				rows: Math.max(1, Math.min(1000, terminal.rows)),
			});
		} catch (error) {
			if (isHostedDaemonGone(error)) return "exited";
			throw error;
		}
		if (attached.op !== "terminal_attach") throw new Error("Unexpected terminal attachment response");
		terminalLeaseId = attached.terminalLeaseId;
		cursor = attached.cursor;
		terminal.write("\x1b[2J\x1b[H");
		void (async () => {
			while (!closed) {
				while (!closed && (terminal.pendingOutputBytes ?? 0) > STDOUT_BACKLOG_CLEAR_BYTES) await Bun.sleep(10);
				if (closed) break;
				const frame = await client.request(
					{ op: "read", ...target, terminalLeaseId, cursor, maxBytes: DAEMON_MAX_READ_BYTES, timeoutMs: 1000 },
					abort.signal,
				);
				if (frame.op !== "read") throw new Error("Unexpected terminal output response");
				cursor = frame.nextCursor;
				if (frame.reset || frame.omittedBytes > 0) {
					// A lost ANSI prefix is not renderable. Obtain an authoritative fresh screen.
					terminal.write("\x1b[2J\x1b[H");
					await client.request(
						{
							op: "terminal_resize",
							...target,
							terminalLeaseId,
							columns: Math.max(1, Math.min(1000, terminal.columns)),
							rows: Math.max(1, Math.min(1000, terminal.rows)),
						},
						abort.signal,
					);
				} else if (frame.text) terminal.write(frame.text);
				if (frame.daemon.state === "exited" || frame.daemon.state === "failed") {
					outcome = "exited";
					stop();
				}
			}
		})().catch(error => {
			if (!closed) stopFor(error);
		});
		await stopped.promise;
	} finally {
		stop();
		await inputQueue;
		if (terminalLeaseId) {
			try {
				await client.request({ op: "terminal_detach", ...target, terminalLeaseId });
			} catch (error) {
				logger.debug("Terminal attachment already retired", { error: String(error) });
			}
		}
		terminal.stop();
		terminal.showCursor(true);
		process.off("SIGHUP", onSignal);
		process.off("SIGTERM", onSignal);
	}
	if (failure) throw failure;
	return outcome;
}

/** Printed when Ctrl+] ends a hosted-terminal relay, so detaching never strands the user. */
export const DETACH_HINT = "Detached — the session keeps running. Reattach with `proto attach`.";

/** Why an attach to a live hosted session could not happen. */
export interface HostedInteractiveAttach {
	attached: boolean;
	reason?: "no-live-host" | "rpc-only";
}

/** A live host is adopted without opening its transcript or claiming a second writer. */
export async function attachExistingHostedInteractive(
	projectDir: string,
	sessionFile: string,
): Promise<HostedInteractiveAttach> {
	// Explicit file resumes may originate outside the owning project's broker namespace.
	await visitEntriesFromFileStream(
		sessionFile,
		entry => {
			if (entry.type === "session") projectDir = entry.cwd;
		},
		{ maxRecords: 2 },
	);
	const ownership = await resolveSessionHostOwnership(sessionFile);
	const client = await daemonClientForProject(ownership?.projectDir ?? projectDir);
	const name = ownership?.name ?? (await sessionHostDaemonName(sessionFile));
	const existing = await describeQuietly(client, name, "interactive session host");
	if (!existing || existing.state === "exited" || existing.state === "failed")
		return { attached: false, reason: "no-live-host" };
	const described = await client.request({ op: "describe", name, expectedId: existing.id });
	if (described.op !== "describe" || !described.spec.pty) return { attached: false, reason: "rpc-only" };
	if (ownership && path.resolve(ownership.requestedSessionFile) !== path.resolve(ownership.activeSessionFile)) {
		throw new Error(
			`This session belongs to an interface currently viewing ${ownership.activeSessionFile}. Reattach that file and select the requested session explicitly; running work was not interrupted.`,
		);
	}
	const outcome = await relayHostedTerminal(client, described.daemon);
	if (outcome === "detached") process.stderr.write(`${chalk.dim(DETACH_HINT)}\n`);
	return { attached: true };
}

/** Selection is local; the host takes the only runtime/writer lease before any turn is admitted. */
export async function launchHostedInteractive(manager: SessionManager, rawArgs: readonly string[]): Promise<void> {
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("A daemon-backed interface requires a persisted session");
	const ownership = await resolveSessionHostOwnership(sessionFile);
	if (ownership && path.resolve(ownership.requestedSessionFile) !== path.resolve(ownership.activeSessionFile)) {
		throw new Error(
			`This session belongs to an interface currently viewing ${ownership.activeSessionFile}. Reattach that file and select the requested session explicitly; running work was not interrupted.`,
		);
	}
	await manager.ensureOnDisk();
	await manager.close();
	releaseSessionOwnership({ removeMarker: true });
	const projectDir = ownership?.projectDir ?? manager.getCwd();
	const initialSessionFile = ownership?.initialSessionFile ?? sessionFile;
	const client = await daemonClientForProject(projectDir);
	const host = await ensureSessionHost(projectDir, initialSessionFile, {
		client,
		interactive: { argv: interactiveHostArgs(rawArgs, initialSessionFile) },
	});
	const described = await client.request({ op: "describe", name: host.name });
	if (described.op !== "describe" || !described.spec.pty)
		throw new Error("Session host does not expose the full terminal interface");
	await relayHostedTerminal(client, described.daemon);
}
