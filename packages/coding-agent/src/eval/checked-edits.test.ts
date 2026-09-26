import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../config/settings";
import type { ToolSession } from "../tools";
import { checkedEdits } from "./checked-edits";
import { fsObservationLedgerFor } from "./fs-observations";
import type { EvalStatusEvent } from "./types";

let root: string;
let session: ToolSession;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "checked-contract-"));
	session = {
		cwd: root,
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getEvalSessionId: () => root,
	};
	await fs.writeFile(path.join(root, "a"), "old a");
	await fs.writeFile(path.join(root, "b"), "old b");
});
afterEach(async () => {
	fsObservationLedgerFor(session).drain();
	await fs.rm(root, { recursive: true, force: true });
});
const changes = () => [
	{ path: "a", before: "old a", after: "new a" },
	{ path: "b", before: "old b", after: "new b" },
];
async function contents() {
	return Promise.all(["a", "b"].map(file => fs.readFile(path.join(root, file), "utf8")));
}
test("stale batch validates all files before writing or emitting mutations", async () => {
	const events: EvalStatusEvent[] = [];
	const edits = changes();
	edits[1].before = "stale";
	await expect(checkedEdits(edits, { session, apply: true, emitStatus: event => events.push(event) })).rejects.toThrow(
		/Stale/,
	);
	expect(await contents()).toEqual(["old a", "old b"]);
	expect(events).toEqual([]);
	expect(fsObservationLedgerFor(session).drain()).toEqual([]);
});
test("preview includes diffs but performs no writes, locks or ledger mutations", async () => {
	const names = await fs.readdir(root);
	const result = await checkedEdits(changes(), { session });
	expect(result.state).toBe("preview");
	expect(result.files[0].diff).toContain("new a");
	expect(await contents()).toEqual(["old a", "old b"]);
	expect(await fs.readdir(root)).toEqual(names);
	expect(fsObservationLedgerFor(session).drain()).toEqual([]);
});
test("duplicate path, directory aliases, hardlinks and symlink files are rejected", async () => {
	await fs.symlink(root, path.join(root, "alias"));
	await fs.symlink("a", path.join(root, "link"));
	await fs.link(path.join(root, "a"), path.join(root, "hard"));
	for (const alias of ["./a", "alias/a", "hard", "link"]) {
		await expect(
			checkedEdits([changes()[0], { path: alias, before: "old a", after: "other" }], { session, apply: true }),
		).rejects.toThrow();
	}
	await expect(
		checkedEdits([{ path: "link", before: "old a", after: "other" }], { session, apply: true }),
	).rejects.toThrow(/non-symlink/);
	expect(await contents()).toEqual(["old a", "old b"]);
});
test("multi-file commit preserves modes, skips unchanged content and observes creates", async () => {
	await fs.chmod(path.join(root, "a"), 0o751);
	const events: EvalStatusEvent[] = [];
	const result = await checkedEdits(
		[...changes(), { path: "new", before: null, after: "created" }, { path: "same", before: null, after: "" }],
		{ session, apply: true, emitStatus: event => events.push(event) },
	);
	expect(result.state).toBe("applied");
	expect(await contents()).toEqual(["new a", "new b"]);
	expect((await fs.stat(path.join(root, "a"))).mode & 0o777).toBe(0o751);
	expect(await fs.readFile(path.join(root, "same"), "utf8")).toBe("");
	expect(events.map(event => event.op)).toEqual(["write", "write", "write", "write"]);
	expect(
		fsObservationLedgerFor(session)
			.drain()
			.map(item => item.kind),
	).toEqual(["write", "write", "write", "write"]);
	const unchanged = await checkedEdits([{ path: "a", before: "new a", after: "new a" }], { session, apply: true });
	expect(unchanged.applied).toEqual([]);
	expect(fsObservationLedgerFor(session).drain()).toEqual([]);
});
test("mid-commit cancellation rolls back writes including new files and records reverts", async () => {
	const controller = new AbortController();
	const events: EvalStatusEvent[] = [];
	const result = await checkedEdits([{ path: "0new", before: null, after: "created" }, ...changes()], {
		session,
		apply: true,
		signal: controller.signal,
		emitStatus(event) {
			events.push(event);
			if (event.op === "write") controller.abort();
		},
	});
	expect(result.state).toBe("rolled-back");
	expect(await contents()).toEqual(["old a", "old b"]);
	expect(await Bun.file(path.join(root, "0new")).exists()).toBe(false);
	expect(events.map(event => event.op)).toEqual(["write", "revert"]);
	expect(fsObservationLedgerFor(session).drain()).toEqual([
		{ path: path.join(root, "0new"), kind: "write", mtimeNs: null, size: null, sha: null },
	]);
});
test("cancellation during the final write still rolls back", async () => {
	const controller = new AbortController();
	const result = await checkedEdits([changes()[0]], {
		session,
		apply: true,
		signal: controller.signal,
		emitStatus(event) {
			if (event.op === "write") controller.abort();
		},
	});
	expect(result.state).toBe("rolled-back");
	expect(await contents()).toEqual(["old a", "old b"]);
});
test("rollback preserves a concurrent user edit and refreshes its mutation observation", async () => {
	const result = await checkedEdits(changes(), {
		session,
		apply: true,
		emitStatus(event) {
			if (event.op === "write" && event.path === path.join(root, "a")) {
				writeFileSync(path.join(root, "a"), "user a");
				writeFileSync(path.join(root, "b"), "user b");
			}
		},
	});
	expect(result.state).toBe("partial");
	expect(result.conflicts).toEqual([path.join(root, "a")]);
	expect(await contents()).toEqual(["user a", "user b"]);
	expect(fsObservationLedgerFor(session).drain()[0].sha).toBe(
		new Bun.CryptoHasher("sha256").update("user a").digest("hex").slice(0, 16),
	);
});
test("mid-commit stale failure restores earlier files without touching the stale file", async () => {
	const result = await checkedEdits(changes(), {
		session,
		apply: true,
		emitStatus(event) {
			if (event.op === "write") writeFileSync(path.join(root, "b"), "user b");
		},
	});
	expect(result.state).toBe("rolled-back");
	expect(await contents()).toEqual(["old a", "user b"]);
	expect(fsObservationLedgerFor(session).drain()[0].sha).toBe(
		new Bun.CryptoHasher("sha256").update("old a").digest("hex").slice(0, 16),
	);
});
test("pre-cancelled batches and invalid apply flags do not write", async () => {
	await expect(checkedEdits(changes(), { session, apply: true, signal: AbortSignal.abort() })).rejects.toThrow();
	expect(await contents()).toEqual(["old a", "old b"]);
});

test("status listener failure cannot misreport a successful rollback as a conflict", async () => {
	const controller = new AbortController();
	const result = await checkedEdits([changes()[0]], {
		session,
		apply: true,
		signal: controller.signal,
		emitStatus(event) {
			if (event.op === "write") controller.abort();
			if (event.op === "revert") throw new Error("status listener disconnected");
		},
	});
	expect(result.state).toBe("rolled-back");
	expect(result.conflicts).toEqual([]);
	expect(await contents()).toEqual(["old a", "old b"]);
});
test("unrollbackable oversized replacement is rejected before mutation", async () => {
	await expect(
		checkedEdits([{ path: "a", before: "old a", after: "x".repeat(8 * 1024 * 1024 + 1) }], { session, apply: true }),
	).rejects.toThrow(/8 MiB/);
	expect(await contents()).toEqual(["old a", "old b"]);
});
test("overlapping checked batches serialize and only one stale snapshot commits", async () => {
	const results = await Promise.allSettled([
		checkedEdits(changes(), { session, apply: true }),
		checkedEdits(changes().reverse(), { session, apply: true }),
	]);
	expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
	expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
	expect(await contents()).toEqual(["new a", "new b"]);
});
