import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteJson } from "@oh-my-pi/pi-utils";
import { SessionManager } from "../session/session-manager";
import {
	beginSessionHostOwnership,
	resolveSessionHostOwnership,
	type SessionHostOwnership,
	sessionHostReceiptPath,
} from "./ownership";
import { sessionHostDaemonName } from "./protocol";

const directories: string[] = [];
const owners: SessionHostOwnership[] = [];
const managers: SessionManager[] = [];
afterEach(async () => {
	for (const owner of owners.splice(0)) await owner.close().catch(() => {});
	for (const manager of managers.splice(0)) await manager.close();
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function fixture(): Promise<{ directory: string; source: SessionManager; sourceFile: string; socket: string }> {
	const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "proto-host-ownership-")));
	directories.push(directory);
	const source = SessionManager.create(directory, directory);
	managers.push(source);
	const id = source.getSessionId();
	await source.setNodeTopology({ id, rootId: id, generation: 0, state: "active" });
	source.appendMessage({ role: "user", content: "original lineage", timestamp: 0 });
	await source.ensureOnDisk();
	await source.flush();
	const sourceFile = source.getSessionFile()!;
	return {
		directory,
		source,
		sourceFile,
		socket: path.join(directory, `${await sessionHostDaemonName(sourceFile)}.sock`),
	};
}

async function forkRoot(sourceFile: string, directory: string): Promise<SessionManager> {
	const fork = await SessionManager.forkFrom(sourceFile, directory, directory, undefined, { activeLineageOnly: true });
	managers.push(fork);
	const id = fork.getSessionId();
	await fork.setNodeTopology({ id, rootId: id, generation: 0, state: "active" });
	await fork.ensureOnDisk();
	await fork.flush();
	return fork;
}

test("a forked filename locates the original host and restart restores its committed new foreground", async () => {
	const f = await fixture();
	const first = await beginSessionHostOwnership(f.socket, f.directory, f.sourceFile);
	owners.push(first);
	await first.setRestartArgs(["--resume", f.sourceFile, "--no-skills"]);
	await first.commit(f.sourceFile, f.source.getSessionId(), 0);
	const fork = await forkRoot(f.sourceFile, f.directory);
	const forkFile = fork.getSessionFile()!;
	await first.commit(forkFile, fork.getSessionId(), 0);
	const located = await resolveSessionHostOwnership(forkFile);
	expect(located?.name).not.toBe(await sessionHostDaemonName(forkFile));
	expect(located).toMatchObject({
		name: await sessionHostDaemonName(f.sourceFile),
		initialSessionFile: f.sourceFile,
		requestedSessionFile: forkFile,
		requestedNodeId: fork.getSessionId(),
		activeSessionFile: forkFile,
	});
	const original = await resolveSessionHostOwnership(f.sourceFile);
	expect(original).toMatchObject({
		name: located!.name,
		requestedNodeId: f.source.getSessionId(),
		activeSessionFile: forkFile,
	});
	await first.close();
	const restarted = await beginSessionHostOwnership(f.socket, f.directory, f.sourceFile);
	owners.push(restarted);
	expect(restarted.activeSessionFile).toBe(forkFile);
	expect(restarted.restartArgs).toEqual(["--resume", f.sourceFile, "--no-skills"]);
	expect((await resolveSessionHostOwnership(forkFile))?.generation).toBe(located!.generation + 1);
});

test("a committed foreground missing after a crash fails rather than silently reopening the source", async () => {
	const f = await fixture();
	const owner = await beginSessionHostOwnership(f.socket, f.directory, f.sourceFile);
	owners.push(owner);
	await owner.commit(f.sourceFile, f.source.getSessionId(), 0);
	const fork = await forkRoot(f.sourceFile, f.directory);
	const forkFile = fork.getSessionFile()!;
	await owner.commit(forkFile, fork.getSessionId(), 0);
	await owner.close();
	await fork.close();
	await fs.unlink(forkFile);
	await expect(beginSessionHostOwnership(f.socket, f.directory, f.sourceFile)).rejects.toThrow(
		"Committed foreground session is missing",
	);
	expect(await Bun.file(f.sourceFile).exists()).toBe(true);
});

test("an uncommitted handoff locator cannot claim a second writer while its host generation remains active", async () => {
	const f = await fixture();
	const owner = await beginSessionHostOwnership(f.socket, f.directory, f.sourceFile);
	owners.push(owner);
	await owner.commit(f.sourceFile, f.source.getSessionId(), 0);
	const committed = await resolveSessionHostOwnership(f.sourceFile);
	const fork = await forkRoot(f.sourceFile, f.directory);
	const forkFile = fork.getSessionFile()!;
	await atomicWriteJson(sessionHostReceiptPath(forkFile), {
		version: 1,
		hostId: committed!.hostId,
		name: committed!.name,
		socket: committed!.socket,
		projectDir: committed!.projectDir,
		sessionFile: forkFile,
		nodeId: fork.getSessionId(),
		hostGeneration: committed!.generation,
		committedRevision: committed!.revision + 1,
	});
	await expect(resolveSessionHostOwnership(forkFile)).rejects.toThrow("handoff has not committed");
	expect(owner.activeSessionFile).toBe(f.sourceFile);
	await owner.close();
	const restarted = await beginSessionHostOwnership(f.socket, f.directory, f.sourceFile);
	owners.push(restarted);
	expect(await resolveSessionHostOwnership(forkFile)).toBeUndefined();
	expect(restarted.activeSessionFile).toBe(f.sourceFile);
});

test("deep child lookup follows explicit root metadata without turning that child into the foreground root", async () => {
	const f = await fixture();
	const owner = await beginSessionHostOwnership(f.socket, f.directory, f.sourceFile);
	owners.push(owner);
	await owner.commit(f.sourceFile, f.source.getSessionId(), 0);
	let child = f.source;
	for (let depth = 1; depth <= 3; depth++) {
		const parent = child;
		child = SessionManager.create(f.directory, f.directory);
		managers.push(child);
		await child.setNodeTopology({
			id: child.getSessionId(),
			rootId: f.source.getSessionId(),
			parentId: parent.getSessionId(),
			parentSessionFile: parent.getSessionFile()!,
			rootSessionFile: f.sourceFile,
			generation: depth === 3 ? 4 : 0,
			state: depth === 3 ? "abandoned" : "active",
		});
		await child.ensureOnDisk();
		await child.flush();
	}
	const located = await resolveSessionHostOwnership(child.getSessionFile()!);
	expect(located).toMatchObject({
		requestedNodeId: child.getSessionId(),
		activeNodeId: f.source.getSessionId(),
		activeSessionFile: f.sourceFile,
	});
});
