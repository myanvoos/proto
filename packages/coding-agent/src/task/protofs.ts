/**
 * protofs checkouts as isolated subagent workspaces, used when
 * `orchestrator.isolation.mode` is auto and the protofs binary is found.
 *
 * Instead of cloning the repository, an isolated run works in a protofs checkout: a
 * copy-on-write view of the repository served by the protofs daemon, ready in
 * about a second whatever the checkout's size, with its own private git dir.
 * Capture and merge are unchanged: the runner diffs and commits the checkout like
 * a native copy, and the checkout is removed when the run ends (or kept, like a
 * native workspace, when its changes could not be captured).
 *
 * `protofs start --json` makes sure the daemon runs and reports its admin
 * socket; checkouts are then opened (`new`) and removed (`rm`) over that socket
 * (protocol: {@link callSocket}).
 *
 * Each workspace keeps a record of its checkout ({@link PROTOFS_CHECKOUT_FILE}) in the
 * run's task-isolation dir, beside the owner marker, so `proto worktree clear`
 * removes the checkouts of runs that crashed ({@link releaseProtofsCheckout}).
 * The record stays until removal is confirmed: a failed removal keeps it, and
 * reusing the slot moves it aside instead of deleting it.
 *
 * @example
 * // Picked by the task runner when protofs is found and isolation mode is auto:
 * const open = protofsWorkspace("/work/protofs/bin/protofs");
 * const workspace = await open(repoRoot, "AuthRefactor"); // workspace.dir: /work/.tree/agents/proto-authrefactor-1a2b3c
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteJson, logger } from "@oh-my-pi/pi-utils";
import { callSocket, ProtofsError } from "../protofs/client";
import { forgetDaemon, startDaemon } from "../protofs/daemon";
import { writeIsolationOwner } from "./isolation-ownership";
import type { IsolationWorkspace, OpenWorkspace, RetainedWorkspace } from "./isolation-runner";
import { vacateIsolationSlot } from "./isolation-runner";
import { taskIsolationBaseDir } from "./worktree";

/** Record of the checkout an isolation dir stands for. */
export const PROTOFS_CHECKOUT_FILE = ".protofs-checkout.json";

/** Contents of {@link PROTOFS_CHECKOUT_FILE}. */
interface CheckoutRecord {
	/** protofs executable that opened the checkout (it can start the daemon again). */
	command: string;
	checkout: string;
}

/** The checkout part of protofs's `new` reply. */
interface NewReply {
	checkout: { name: string; path: string };
}

/** One operation on the daemon `command` manages, starting it again once if it went away. */
async function call<T>(command: string, op: string, args: object): Promise<T> {
	const { socket } = await startDaemon(command);
	try {
		return await callSocket<T>(socket, op, args);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ECONNREFUSED" && code !== "ENOENT") throw err;
		forgetDaemon(command);
		return callSocket<T>((await startDaemon(command)).socket, op, args);
	}
}

/** A checkout name protofs accepts (`[a-z0-9][a-z0-9._-]{0,63}`), recognisable as this agent's, unique per run. */
function checkoutName(agentId: string): string {
	const stem = agentId
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[^a-z0-9]+/, "")
		.slice(0, 40);
	const suffix = Math.floor(Math.random() * 2 ** 24)
		.toString(16)
		.padStart(6, "0");
	return `proto-${stem || "task"}-${suffix}`;
}

/** Remove a checkout; one already gone counts as removed. */
async function removeCheckout(command: string, checkout: string): Promise<void> {
	try {
		await call(command, "rm", { checkout });
	} catch (err) {
		if (!(err instanceof ProtofsError && err.code === "not_found")) throw err;
	}
}

/**
 * Remove `checkout`, then delete `dir`. A removal that cannot be confirmed
 * keeps `dir` and the checkout record in it, so `proto worktree clear` can retry.
 */
async function releaseCheckoutRecord(dir: string, command: string, checkout: string): Promise<void> {
	try {
		await removeCheckout(command, checkout);
	} catch (err) {
		logger.warn("protofs checkout removal failed; `proto worktree clear` retries it", {
			dir,
			checkout,
			error: err instanceof Error ? err.message : String(err),
		});
		return;
	}
	await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Remove the protofs checkout a task-isolation dir records and report whether it
 * recorded one. Throws when the checkout cannot be removed (the record then stays
 * for a later retry); `proto worktree clear` calls this before deleting the dir.
 */
export async function releaseProtofsCheckout(dir: string): Promise<boolean> {
	let record: CheckoutRecord;
	try {
		record = (await Bun.file(path.join(dir, PROTOFS_CHECKOUT_FILE)).json()) as CheckoutRecord;
	} catch {
		return false;
	}
	await removeCheckout(record.command, record.checkout);
	return true;
}

/** An open protofs checkout and the isolation dir recording it. */
class ProtofsWorkspace implements IsolationWorkspace {
	readonly dir: string;
	#baseDir: string;
	readonly #command: string;
	readonly #checkout: string;

	constructor(dir: string, baseDir: string, command: string, checkout: string) {
		this.dir = dir;
		this.#baseDir = baseDir;
		this.#command = command;
		this.#checkout = checkout;
	}

	/** The checkout stays where it is; its record leaves the deterministic slot so a later run with this id keeps it. */
	async retain(): Promise<RetainedWorkspace> {
		this.#baseDir = (await vacateIsolationSlot(this.#baseDir)) ?? this.#baseDir;
		return { dir: this.dir, sidecarOk: true };
	}

	/** Remove the checkout, then its record; a checkout that cannot be removed keeps its record for `proto worktree clear`. */
	async cleanup(): Promise<void> {
		await releaseCheckoutRecord(this.#baseDir, this.#command, this.#checkout);
	}
}

/**
 * Workspaces that are protofs checkouts of the repository, opened through the
 * protofs executable `command`. Failures say what is wrong with protofs; there is
 * no silent fallback to native isolation.
 */
export function protofsWorkspace(command: string): OpenWorkspace {
	return async (repoRoot, agentId) => {
		const baseDir = taskIsolationBaseDir(repoRoot, agentId);
		// A dead run with this id may still record a checkout. Reusing the slot
		// deletes that record, so a removal that fails has to move the record
		// and its owner marker aside first — or leave them and refuse the slot.
		try {
			await releaseProtofsCheckout(baseDir);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const preserved = await vacateIsolationSlot(baseDir);
			if (!preserved) {
				logger.warn("releasing a stale protofs checkout failed", {
					dir: baseDir,
					error: message,
				});
				throw new Error(
					`protofs isolation failed: could not release the previous checkout (${message}); its record was kept for \`proto worktree clear\` (set orchestrator.isolation.mode to a native backend to bypass protofs)`,
				);
			}
			logger.warn("moved a stale protofs checkout record aside after removal failed", {
				dir: baseDir,
				preserved,
				error: message,
			});
		}
		await fs.rm(baseDir, { recursive: true, force: true });
		await fs.mkdir(baseDir, { recursive: true });
		await writeIsolationOwner(baseDir, agentId);
		const checkout = checkoutName(agentId);
		// The record is written once the daemon is reachable and before `new`
		// returns, so a crash or a lost reply still names the checkout. It is
		// deleted only after removal is confirmed.
		let recorded = false;
		try {
			await startDaemon(command);
			const record: CheckoutRecord = { command, checkout };
			await atomicWriteJson(path.join(baseDir, PROTOFS_CHECKOUT_FILE), record);
			recorded = true;
			const reply = await call<NewReply>(command, "new", { dir: repoRoot, name: checkout });
			return new ProtofsWorkspace(reply.checkout.path, baseDir, command, checkout);
		} catch (err) {
			// `exists` refused the name: that checkout predates this attempt, so
			// only the new local record goes — removing the checkout would
			// delete the older run's work.
			const refusedExisting = err instanceof ProtofsError && err.code === "exists";
			if (recorded && !refusedExisting) await releaseCheckoutRecord(baseDir, command, checkout);
			else await fs.rm(baseDir, { recursive: true, force: true });
			throw new Error(
				`protofs isolation failed: ${err instanceof Error ? err.message : String(err)} (set orchestrator.isolation.mode to a native backend to bypass protofs)`,
			);
		}
	};
}
