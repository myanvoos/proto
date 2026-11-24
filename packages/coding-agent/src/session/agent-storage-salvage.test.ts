/**
 * A corrupt agent.db is quarantined and replaced by an empty store. The
 * credentials it held are the ones that actually authenticate this fork's
 * providers, so AgentStorage.open must salvage them rather than leaving every
 * provider logged out (#8b1ebeaa05).
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let dir: string;
let dbPath: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-agent-salvage-"));
	dbPath = path.join(dir, "agent.db");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const storageModule = JSON.stringify(path.join(import.meta.dir, "agent-storage.ts"));

async function runChild(source: string): Promise<string> {
	const child = Bun.spawn([process.execPath, "--eval", source], {
		cwd: path.resolve(import.meta.dir, "../../../.."),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (code !== 0) throw new Error(`child failed (${code}): ${stderr}`);
	return stdout.trim();
}

/** Makes page 1 declare one more page than the file holds. */
function tearHeader(file: string): void {
	const fd = fs.openSync(file, "r+");
	try {
		const header = Buffer.alloc(100);
		fs.readSync(fd, header, 0, 100, 0);
		const pageSize = header.readUInt16BE(16);
		const pages = fs.statSync(file).size / pageSize;
		header.writeUInt32BE(pages + 1, 28);
		fs.writeSync(fd, header, 28, 4, 28);
	} finally {
		fs.closeSync(fd);
	}
}

test("AgentStorage.open restores provider credentials from a quarantined store", async () => {
	await runChild(`
		import { AgentStorage } from ${storageModule};
		const storage = await AgentStorage.open(${JSON.stringify(dbPath)});
		storage.replaceAuthCredentialsForProvider("salvage-test", [{ type: "api_key", key: "sk-salvaged" }]);
		AgentStorage.close();
	`);

	const grow = new Database(dbPath);
	grow.run("BEGIN");
	for (let i = 0; i < 600; i++) {
		grow.run(
			"INSERT INTO usage_history (recorded_at, provider, account_key, limit_id, label) VALUES (?, 'p', 'a', ?, 'l')",
			[i, `limit-${i}-${"x".repeat(200)}`],
		);
	}
	grow.run("COMMIT");
	grow.run("PRAGMA wal_checkpoint(TRUNCATE)");
	grow.close();
	tearHeader(dbPath);

	// A fresh process owns its own process-wide AgentStorage registry.
	const output = await runChild(`
		import { AgentStorage } from ${storageModule};
		const storage = await AgentStorage.open(${JSON.stringify(dbPath)});
		console.log(JSON.stringify(storage.listAuthCredentials("salvage-test").map(row => row.credential)));
		AgentStorage.close();
	`);

	expect(JSON.parse(output)).toEqual([{ type: "api_key", key: "sk-salvaged" }]);
});
