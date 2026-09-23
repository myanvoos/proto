import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beginFileTracking, flushFileTracking, trackedFsModule } from "./fs-tracker";
import type { JsStatusEvent } from "./types";

const cleanupPaths = new Set<string>();

async function tempDir(): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "proto-fs-tracker-"));
	cleanupPaths.add(dir);
	return dir;
}

async function capture(run: () => void | Promise<void>): Promise<JsStatusEvent[]> {
	const events: JsStatusEvent[] = [];
	beginFileTracking(crypto.randomUUID(), event => events.push(event));
	try {
		await run();
	} finally {
		await flushFileTracking();
	}
	return events;
}

function mutationPaths(events: readonly JsStatusEvent[]): string[] {
	return events
		.filter((event): event is JsStatusEvent & { path: string } => typeof event.path === "string")
		.filter(event => event.op === "write" || event.op === "delete")
		.map(event => event.path);
}

function diffRows(event: JsStatusEvent | undefined): string[] {
	const diff = event?.diff;
	return typeof diff === "string" ? diff.split("\n") : [];
}

afterEach(async () => {
	await Promise.all([...cleanupPaths].map(target => fs.promises.rm(target, { recursive: true, force: true })));
	cleanupPaths.clear();
});

test("fs.promises.cp observes every copied file in a directory tree", async () => {
	const root = await tempDir();
	const source = path.join(root, "source");
	const destination = path.join(root, "destination");
	await fs.promises.mkdir(path.join(source, "nested"), { recursive: true });
	await Bun.write(path.join(source, "one.txt"), "one\n");
	await Bun.write(path.join(source, "nested", "two.txt"), "two\n");
	const tracked = trackedFsModule(fs);

	const events = await capture(async () => {
		await tracked.promises.cp(source, destination, { recursive: true });
	});

	expect(mutationPaths(events).toSorted()).toEqual([
		path.join(destination, "nested", "two.txt"),
		path.join(destination, "one.txt"),
	]);
});

test("a FileHandle retained across cells observes later content mutations", async () => {
	const root = await tempDir();
	const target = path.join(root, "retained.txt");
	await Bun.write(target, "before\n");
	const tracked = trackedFsModule(fs);
	let handle: fs.promises.FileHandle | undefined;
	try {
		await capture(async () => {
			handle = await tracked.promises.open(target, "r+");
		});
		const events = await capture(async () => {
			await handle!.writeFile("after\n");
		});

		expect(mutationPaths(events)).toContain(target);
	} finally {
		await handle?.close();
	}
});

async function expectObserved(targets: string | string[], run: () => void | Promise<void>): Promise<void> {
	const events = await capture(run);
	const paths = mutationPaths(events);
	for (const target of typeof targets === "string" ? [targets] : targets) {
		expect(paths).toContain(path.resolve(target));
	}
}

async function callbackMutation(
	start: (callback: (error: NodeJS.ErrnoException | null) => void) => void,
): Promise<void> {
	const completed = Promise.withResolvers<void>();
	start(error => {
		if (error) completed.reject(error);
		else completed.resolve();
	});
	await completed.promise;
}

async function finishWriteStream(stream: fs.WriteStream, content: string): Promise<void> {
	const completed = Promise.withResolvers<void>();
	stream.once("error", completed.reject);
	stream.once("finish", completed.resolve);
	stream.end(content);
	await completed.promise;
}

test("promise-based fs content and path mutators each emit an observation", async () => {
	const root = await tempDir();
	const tracked = trackedFsModule(fs).promises;

	const writeTarget = path.join(root, "promise-write.txt");
	await expectObserved(writeTarget, () => tracked.writeFile(writeTarget, "write\n"));

	const appendTarget = path.join(root, "promise-append.txt");
	await Bun.write(appendTarget, "before\n");
	await expectObserved(appendTarget, () => tracked.appendFile(appendTarget, "after\n"));

	const truncateTarget = path.join(root, "promise-truncate.txt");
	await Bun.write(truncateTarget, "before\n");
	await expectObserved(truncateTarget, () => tracked.truncate(truncateTarget, 2));

	const source = path.join(root, "promise-source.txt");
	await Bun.write(source, "source\n");
	const copyTarget = path.join(root, "promise-copy.txt");
	await expectObserved(copyTarget, () => tracked.copyFile(source, copyTarget));
	const cpTarget = path.join(root, "promise-cp.txt");
	await expectObserved(cpTarget, () => tracked.cp(source, cpTarget));
	const linkTarget = path.join(root, "promise-link.txt");
	await expectObserved(linkTarget, () => tracked.link(source, linkTarget));
	const symlinkTarget = path.join(root, "promise-symlink.txt");
	await expectObserved(symlinkTarget, () => tracked.symlink(source, symlinkTarget));

	const renameSource = path.join(root, "promise-rename-source.txt");
	const renameTarget = path.join(root, "promise-rename-target.txt");
	await Bun.write(renameSource, "rename\n");
	await expectObserved([renameSource, renameTarget], () => tracked.rename(renameSource, renameTarget));

	const unlinkTarget = path.join(root, "promise-unlink.txt");
	await Bun.write(unlinkTarget, "unlink\n");
	await expectObserved(unlinkTarget, () => tracked.unlink(unlinkTarget));
	const rmTarget = path.join(root, "promise-rm.txt");
	await Bun.write(rmTarget, "rm\n");
	await expectObserved(rmTarget, () => tracked.rm(rmTarget));
});

test("synchronous fs content and path mutators each emit an observation", async () => {
	const root = await tempDir();
	const tracked = trackedFsModule(fs);

	const writeTarget = path.join(root, "sync-write.txt");
	await expectObserved(writeTarget, () => tracked.writeFileSync(writeTarget, "write\n"));

	const appendTarget = path.join(root, "sync-append.txt");
	await Bun.write(appendTarget, "before\n");
	await expectObserved(appendTarget, () => tracked.appendFileSync(appendTarget, "after\n"));

	const truncateTarget = path.join(root, "sync-truncate.txt");
	await Bun.write(truncateTarget, "before\n");
	await expectObserved(truncateTarget, () => tracked.truncateSync(truncateTarget, 2));

	const source = path.join(root, "sync-source.txt");
	await Bun.write(source, "source\n");
	const copyTarget = path.join(root, "sync-copy.txt");
	await expectObserved(copyTarget, () => tracked.copyFileSync(source, copyTarget));
	const cpTarget = path.join(root, "sync-cp.txt");
	await expectObserved(cpTarget, () => tracked.cpSync(source, cpTarget));
	const linkTarget = path.join(root, "sync-link.txt");
	await expectObserved(linkTarget, () => tracked.linkSync(source, linkTarget));
	const symlinkTarget = path.join(root, "sync-symlink.txt");
	await expectObserved(symlinkTarget, () => tracked.symlinkSync(source, symlinkTarget));

	const renameSource = path.join(root, "sync-rename-source.txt");
	const renameTarget = path.join(root, "sync-rename-target.txt");
	await Bun.write(renameSource, "rename\n");
	await expectObserved([renameSource, renameTarget], () => tracked.renameSync(renameSource, renameTarget));

	const unlinkTarget = path.join(root, "sync-unlink.txt");
	await Bun.write(unlinkTarget, "unlink\n");
	await expectObserved(unlinkTarget, () => tracked.unlinkSync(unlinkTarget));
	const rmTarget = path.join(root, "sync-rm.txt");
	await Bun.write(rmTarget, "rm\n");
	await expectObserved(rmTarget, () => tracked.rmSync(rmTarget));
});

test("callback fs content and path mutators each emit an observation after settling", async () => {
	const root = await tempDir();
	const tracked = trackedFsModule(fs);

	const writeTarget = path.join(root, "callback-write.txt");
	await expectObserved(writeTarget, () =>
		callbackMutation(callback => tracked.writeFile(writeTarget, "write\n", callback)),
	);

	const appendTarget = path.join(root, "callback-append.txt");
	await Bun.write(appendTarget, "before\n");
	await expectObserved(appendTarget, () =>
		callbackMutation(callback => tracked.appendFile(appendTarget, "after\n", callback)),
	);

	const truncateTarget = path.join(root, "callback-truncate.txt");
	await Bun.write(truncateTarget, "before\n");
	await expectObserved(truncateTarget, () =>
		callbackMutation(callback => tracked.truncate(truncateTarget, 2, callback)),
	);

	const source = path.join(root, "callback-source.txt");
	await Bun.write(source, "source\n");
	const copyTarget = path.join(root, "callback-copy.txt");
	await expectObserved(copyTarget, () => callbackMutation(callback => tracked.copyFile(source, copyTarget, callback)));
	const cpTarget = path.join(root, "callback-cp.txt");
	await expectObserved(cpTarget, () => callbackMutation(callback => tracked.cp(source, cpTarget, callback)));
	const linkTarget = path.join(root, "callback-link.txt");
	await expectObserved(linkTarget, () => callbackMutation(callback => tracked.link(source, linkTarget, callback)));
	const symlinkTarget = path.join(root, "callback-symlink.txt");
	await expectObserved(symlinkTarget, () =>
		callbackMutation(callback => tracked.symlink(source, symlinkTarget, callback)),
	);

	const renameSource = path.join(root, "callback-rename-source.txt");
	const renameTarget = path.join(root, "callback-rename-target.txt");
	await Bun.write(renameSource, "rename\n");
	await expectObserved([renameSource, renameTarget], () =>
		callbackMutation(callback => tracked.rename(renameSource, renameTarget, callback)),
	);

	const unlinkTarget = path.join(root, "callback-unlink.txt");
	await Bun.write(unlinkTarget, "unlink\n");
	await expectObserved(unlinkTarget, () => callbackMutation(callback => tracked.unlink(unlinkTarget, callback)));
	const rmTarget = path.join(root, "callback-rm.txt");
	await Bun.write(rmTarget, "rm\n");
	await expectObserved(rmTarget, () => callbackMutation(callback => tracked.rm(rmTarget, callback)));
});

test("descriptor write, writev, and truncate APIs each emit an observation", async () => {
	const root = await tempDir();
	const tracked = trackedFsModule(fs);

	const syncCases: Array<{
		name: string;
		run: (fd: number) => void;
	}> = [
		{ name: "writeSync", run: fd => void tracked.writeSync(fd, "W", 0, "utf8") },
		{ name: "writevSync", run: fd => void tracked.writevSync(fd, [Buffer.from("V")], 0) },
		{ name: "ftruncateSync", run: fd => tracked.ftruncateSync(fd, 1) },
	];
	for (const mutation of syncCases) {
		const target = path.join(root, `${mutation.name}.txt`);
		await Bun.write(target, "before\n");
		const fd = tracked.openSync(target, "r+");
		try {
			await expectObserved(target, () => mutation.run(fd));
		} finally {
			tracked.closeSync(fd);
		}
	}

	const callbackCases: Array<{
		name: string;
		run: (fd: number, callback: (error: NodeJS.ErrnoException | null) => void) => void;
	}> = [
		{ name: "write", run: (fd, callback) => void tracked.write(fd, "W", 0, "utf8", callback) },
		{ name: "writev", run: (fd, callback) => void tracked.writev(fd, [Buffer.from("V")], 0, callback) },
		{ name: "ftruncate", run: (fd, callback) => tracked.ftruncate(fd, 1, callback) },
	];
	for (const mutation of callbackCases) {
		const target = path.join(root, `${mutation.name}.txt`);
		await Bun.write(target, "before\n");
		const fd = tracked.openSync(target, "r+");
		try {
			await expectObserved(target, () => callbackMutation(callback => mutation.run(fd, callback)));
		} finally {
			tracked.closeSync(fd);
		}
	}
});

test("every content-mutating FileHandle method emits an observation across cells", async () => {
	const root = await tempDir();
	const tracked = trackedFsModule(fs);
	const cases: Array<{
		name: string;
		run: (handle: fs.promises.FileHandle) => void | Promise<void>;
	}> = [
		{ name: "appendFile", run: async handle => void (await handle.appendFile("after\n")) },
		{ name: "truncate", run: async handle => void (await handle.truncate(2)) },
		{ name: "write", run: async handle => void (await handle.write("W", 0, "utf8")) },
		{ name: "writeFile", run: async handle => void (await handle.writeFile("changed\n")) },
		{ name: "writev", run: async handle => void (await handle.writev([Buffer.from("V")], 0)) },
	];

	for (const mutation of cases) {
		const target = path.join(root, `handle-${mutation.name}.txt`);
		await Bun.write(target, "before\n");
		let handle: fs.promises.FileHandle | undefined;
		try {
			await capture(async () => {
				handle = await tracked.promises.open(target, "r+");
			});
			await expectObserved(target, () => mutation.run(handle!));
		} finally {
			await handle?.close();
		}
	}
});

test("FileHandle.createWriteStream emits an observation across cells", async () => {
	const root = await tempDir();
	const target = path.join(root, "handle-createWriteStream.txt");
	await Bun.write(target, "before\n");
	const tracked = trackedFsModule(fs);
	let handle: fs.promises.FileHandle | undefined;
	await capture(async () => {
		handle = await tracked.promises.open(target, "r+");
	});
	await expectObserved(target, async () => {
		await finishWriteStream(handle!.createWriteStream({ start: 0 }), "stream\n");
	});
});

test("write streams and recursive rename/removal observe their file mutations", async () => {
	const root = await tempDir();
	const tracked = trackedFsModule(fs);
	const streamTarget = path.join(root, "stream.txt");
	await expectObserved(streamTarget, async () => {
		await finishWriteStream(tracked.createWriteStream(streamTarget), "stream\n");
	});

	const sourceTree = path.join(root, "rename-source");
	const renamedTree = path.join(root, "rename-target");
	await fs.promises.mkdir(path.join(sourceTree, "nested"), { recursive: true });
	await Bun.write(path.join(sourceTree, "one.txt"), "one\n");
	await Bun.write(path.join(sourceTree, "nested", "two.txt"), "two\n");
	await expectObserved(
		[
			path.join(sourceTree, "one.txt"),
			path.join(sourceTree, "nested", "two.txt"),
			path.join(renamedTree, "one.txt"),
			path.join(renamedTree, "nested", "two.txt"),
		],
		() => tracked.promises.rename(sourceTree, renamedTree),
	);
	await expectObserved([path.join(renamedTree, "one.txt"), path.join(renamedTree, "nested", "two.txt")], () =>
		tracked.promises.rm(renamedTree, { recursive: true }),
	);
});

test("a truncated whole-file rewrite reports both sides of the diff", async () => {
	const root = await tempDir();
	const target = path.join(root, "rewrite.ts");
	await Bun.write(target, Array.from({ length: 1200 }, (_, index) => `const before${index} = ${index};`).join("\n"));
	const tracked = trackedFsModule(fs);

	const events = await capture(async () => {
		await tracked.promises.writeFile(
			target,
			Array.from({ length: 1200 }, (_, index) => `const after${index} = ${index * 2};`).join("\n"),
		);
	});

	const event = events.find(candidate => candidate.op === "write" && candidate.path === target);
	expect(event?.diffTruncated).toBe(true);
	const rows = diffRows(event);
	// A rewrite emits every removal before the first addition; a head-only cut
	// would report the rewrite as a deletion.
	expect(rows.filter(row => row.startsWith("-")).length).toBeGreaterThan(0);
	expect(rows.filter(row => row.startsWith("+")).length).toBeGreaterThan(0);
	expect(rows.filter(row => row.includes("diff lines omitted"))).toHaveLength(1);
});

test("a diff of many short lines is bounded by rows, not only by characters", async () => {
	const root = await tempDir();
	const target = path.join(root, "short-lines.txt");
	await Bun.write(target, Array.from({ length: 750 }, (_, index) => `a${index}`).join("\n"));
	const tracked = trackedFsModule(fs);

	const events = await capture(async () => {
		await tracked.promises.writeFile(target, Array.from({ length: 750 }, (_, index) => `b${index}`).join("\n"));
	});

	const event = events.find(candidate => candidate.op === "write" && candidate.path === target);
	const rows = diffRows(event);
	// Well under the 32000-char ceiling, so only a row bound can stop it.
	expect(rows.join("\n").length).toBeLessThan(32000);
	expect(event?.diffTruncated).toBe(true);
	expect(rows.length).toBeLessThanOrEqual(400);
});
