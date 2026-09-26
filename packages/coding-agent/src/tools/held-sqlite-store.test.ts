import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell, grep } from "@oh-my-pi/pi-natives";
import type { ToolSession } from ".";
import { ReadTool } from "./read";

// POSIX record locks belong to the process: an in-process open+close of a SQLite store the process
// holds drops its locks, after which another process's close deletes the WAL and the stores diverge.

const PEER_SCRIPT = `
import { Database } from "bun:sqlite";
const db = new Database(process.env.DB);
try {
	if (process.env.MODE === "exclusive") db.run("PRAGMA journal_mode=DELETE");
	else if (process.env.MODE === "write") db.run("INSERT INTO t VALUES ('peer')");
	process.stdout.write(db.query("SELECT group_concat(v) AS v FROM t").get().v);
} catch (error) {
	process.stdout.write(error.code);
}
db.close();
`;

let dir: string;
let dbPath: string;
let db: Database;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "held-sqlite-"));
	dbPath = path.join(dir, "agent.db");
	db = new Database(dbPath);
	db.run("PRAGMA journal_mode=WAL");
	db.run("CREATE TABLE t(v TEXT)");
	db.run("INSERT INTO t VALUES ('host')");
});

afterEach(() => {
	db.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

function peer(mode: "exclusive" | "write" | "read"): string {
	const result = Bun.spawnSync([process.execPath, "-e", PEER_SCRIPT], {
		env: { ...Bun.env, DB: dbPath, MODE: mode },
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(result.stderr.toString()).toBe("");
	return result.stdout.toString();
}

/** Fails once this process has lost its locks: a peer could then leave WAL mode or delete the WAL under it. */
function expectStoreShared(): void {
	expect(peer("exclusive")).toBe("SQLITE_BUSY");
	expect(peer("write")).toBe("host,peer");
	expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);
	expect(fs.existsSync(`${dbPath}-shm`)).toBe(true);
	db.run("INSERT INTO t VALUES ('host-after')");
	expect(peer("read")).toBe("host,peer,host-after");
}

async function runShell(command: string): Promise<{ exitCode: number | undefined; output: string }> {
	let output = "";
	const result = await executeShell(
		{ command, cwd: dir, timeoutMs: 10_000, minimizer: { enabled: false } },
		(error, chunk) => {
			if (!error) output += chunk;
		},
	);
	return { exitCode: result.exitCode, output };
}

test("in-process shell reads of a held SQLite store keep the host's locks", async () => {
	const { output } = await runShell(
		"rg -uu -l nomatch .; cat agent.db > /dev/null; head -c 16 agent.db-shm; wc -c < agent.db",
	);

	expectStoreShared();
	expect(output).toContain("held open by this process");
});

test("in-process shell still reads SQLite files it does not hold and non-SQLite files it does", async () => {
	const header = Buffer.from("SQLite format 3\0");
	fs.writeFileSync(path.join(dir, "other.db"), header);
	fs.writeFileSync(path.join(dir, "held.log"), "log line\n");
	const logFd = fs.openSync(path.join(dir, "held.log"), "r");
	try {
		const { exitCode, output } = await runShell("wc -c < other.db; cat held.log");

		expect(exitCode).toBe(0);
		expect(output.split("\n").map(line => line.trim())).toEqual([String(header.length), "log line", ""]);
	} finally {
		fs.closeSync(logFd);
	}
});

test("native grep over a held SQLite store keeps the host's locks", async () => {
	await grep({ pattern: "nomatch", path: dir, hidden: true, gitignore: false });

	expectStoreShared();
});

function readTool(): ReadTool {
	return new ReadTool({ cwd: dir, settings: { get: () => undefined } } as unknown as ToolSession);
}

test("read tool refuses the byte contents of a held store", async () => {
	await expect(readTool().execute("read-shm", { path: "agent.db-shm" })).rejects.toThrow("holds open");
	expectStoreShared();
});
