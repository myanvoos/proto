import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EDITOR_LIMITS } from "@oh-my-pi/pi-tui";

const directories: string[] = [];
const modulePath = path.join(import.meta.dir, "history-storage.ts");

async function databasePath(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "proto-history-admission-"));
	directories.push(directory);
	return path.join(directory, "history.db");
}

// Child processes isolate the process-wide singleton and its exit cleanup hooks.
async function probe(dbPath: string, source: string): Promise<unknown> {
	const child = Bun.spawn(
		[
			process.execPath,
			"--eval",
			`
		import { Database } from "bun:sqlite";
		import { HistoryStorage } from ${JSON.stringify(modulePath)};
		import * as index from ${JSON.stringify(path.join(import.meta.dir, "session-index.ts"))};
		import * as fsSync from "node:fs";
		import { setAgentDir } from "@oh-my-pi/pi-utils";
		setAgentDir(${JSON.stringify(path.dirname(dbPath))});
		import { EDITOR_LIMITS } from "@oh-my-pi/pi-tui";
		const storage = HistoryStorage.open(${JSON.stringify(dbPath)});
		try { ${source} } finally { HistoryStorage.close(); }
	`,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(exitCode, stderr).toBe(0);
	return JSON.parse(stdout);
}

function seed(dbPath: string, version: number, rows: Array<[number, string, number, string | null]>): void {
	const db = new Database(dbPath);
	try {
		db.run(
			"CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, cwd TEXT)",
		);
		if (version > 0) db.run("ALTER TABLE history ADD COLUMN session_id TEXT");
		db.run(`PRAGMA user_version = ${version}`);
		const insert = db.prepare("INSERT INTO history (id, prompt, created_at, cwd) VALUES (?, ?, ?, ?)");
		db.transaction(() => {
			for (const row of rows) insert.run(...row);
		})();
	} finally {
		db.close();
	}
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

test("history write failures warn once per outage and recover after a durable write", async () => {
	const dbPath = await databasePath();
	expect(
		await probe(
			dbPath,
			`
		const db = new Database(${JSON.stringify(dbPath)});
		let failures = 0;
		storage.setErrorListener(() => { failures++; });
		const block = () => db.run("CREATE TRIGGER reject_history BEFORE INSERT ON history BEGIN SELECT RAISE(ABORT, 'write blocked'); END");
		block();
		await storage.add("first unavailable prompt");
		await storage.add("second unavailable prompt");
		const firstOutage = failures;
		db.run("DROP TRIGGER reject_history");
		await storage.add("durable prompt");
		block();
		await storage.add("new unavailable prompt");
		db.close();
		console.log(JSON.stringify({firstOutage, failures, prompts: storage.getRecent(10).map(row => row.prompt)}));
	`,
		),
	).toEqual({ firstOutage: 1, failures: 2, prompts: ["durable prompt"] });
});

test("legacy normalization preserves oversized durable rows and chooses the newest eligible duplicate", async () => {
	const dbPath = await databasePath();
	const oversized = ` legacy \r\n${"界".repeat(Math.ceil(EDITOR_LIMITS.draftBytes / 3))} `;
	seed(dbPath, 0, [
		[1, " normalize \r\n me ", 10, "old"],
		[2, "normalize\n me", 11, "winner"],
		[3, oversized, 12, "durable"],
		[4, " \r\n ", 13, null],
		[5, "normalize\r\n me  ", 11, "tie-winner"],
	]);
	expect(
		await probe(
			dbPath,
			`
		console.log(JSON.stringify({recent: storage.getRecent(100), search: storage.search("normalize", 100)}));
	`,
		),
	).toEqual({
		recent: [{ id: 5, prompt: "normalize\n me", created_at: 11, cwd: "tie-winner" }],
		search: [{ id: 5, prompt: "normalize\n me", created_at: 11, cwd: "tie-winner" }],
	});
	const db = new Database(dbPath, { readonly: true });
	try {
		expect(db.query<{ prompt: string }, []>("SELECT prompt FROM history WHERE id = 3").get()?.prompt).toBe(oversized);
		expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM history").get()?.count).toBe(2);
	} finally {
		db.close();
	}
	expect(
		await probe(dbPath, 'console.log(JSON.stringify(storage.search("normalize", 100).map(row => row.id)));'),
	).toEqual([5]);
});

test("recent and merged search admit one ordered byte-bounded prefix including metadata", async () => {
	const dbPath = await databasePath();
	const prompt = `needle ${"x".repeat(3 * 1024 * 1024 - 8)}`;
	seed(dbPath, 1, [
		[1, `${prompt}1`, 1, null],
		[2, `${prompt}2`, 2, null],
		[3, `${prompt}3`, 3, null],
		[4, `needle ${"界".repeat(Math.ceil(EDITOR_LIMITS.draftBytes / 3))}`, 4, null],
		[5, "needle metadata", 5, "m".repeat(EDITOR_LIMITS.historyBytes)],
	]);
	expect(
		await probe(
			dbPath,
			`
		const recent = storage.getRecent(100);
		const search = storage.search("needle", 100);
		console.log(JSON.stringify({recent: recent.map(row => row.id), search: search.map(row => row.id),
			bytes: recent.reduce((sum, row) => sum + Buffer.byteLength(row.prompt), 0)}));
	`,
		),
	).toEqual({ recent: [3, 2], search: [3, 2], bytes: 6 * 1024 * 1024 });
});

test("UTF-8 draft and aggregate ceilings include exact-boundary prompts but reject one extra byte", async () => {
	const dbPath = await databasePath();
	const prompt = `needle ${"é".repeat((EDITOR_LIMITS.draftBytes - 8) / 2)}`;
	seed(dbPath, 1, [
		[1, `${prompt}a`, 1, null],
		[2, `${prompt}b`, 2, null],
		[3, `${prompt}cc`, 3, null],
	]);
	expect(
		await probe(
			dbPath,
			`
		console.log(JSON.stringify({recent: storage.getRecent(100).map(row => row.id),
			search: storage.search("needle", 100).map(row => row.id)}));
	`,
		),
	).toEqual({ recent: [2, 1], search: [2, 1] });
});

test("admitted metadata consumes the same retrieval budget as prompts", async () => {
	const dbPath = await databasePath();
	const metadata = "m".repeat(EDITOR_LIMITS.draftBytes);
	seed(dbPath, 1, [
		[1, "needle older", 1, null],
		[2, "needle middle", 2, metadata],
		[3, "needle newest", 3, metadata],
	]);
	expect(
		await probe(
			dbPath,
			`
		console.log(JSON.stringify({recent: storage.getRecent(100).map(row => row.id),
			search: storage.search("needle", 100).map(row => row.id)}));
	`,
		),
	).toEqual({ recent: [3], search: [3] });
});

test("search merges FTS diacritic matches and substring matches in recency order while bounding queries", async () => {
	const dbPath = await databasePath();
	seed(dbPath, 1, [
		[1, "café", 1, null],
		[2, "decafeteria", 2, null],
		[3, "cafe", 2, null],
	]);
	expect(
		await probe(
			dbPath,
			`
		console.log(JSON.stringify({
			matches: storage.search("CAFE", 100).map(row => row.id),
			one: storage.search("cafe", 1).map(row => row.id),
			oversized: storage.search("界".repeat(1366), 100),
			tooManyTokens: storage.search("cafe ".repeat(65), 100),
			empty: storage.search("---", 100),
			invalidLimits: [-1, 0, NaN, Infinity].map(limit => storage.getRecent(limit)),
		}));
	`,
		),
	).toEqual({
		matches: [3, 2, 1],
		one: [3],
		oversized: [],
		tooManyTokens: [],
		empty: [],
		invalidLimits: [[], [], [], []],
	});
});

test("add persists bounded expanded prompts without admitting them to draft retrieval or truncating rejected input", async () => {
	const dbPath = await databasePath();
	expect(
		await probe(
			dbPath,
			`
		await storage.add(" okay \\r\\n prompt ", "/tmp", "session");
		await storage.add("x".repeat(EDITOR_LIMITS.expandedBytes), "/tmp", "expanded");
		await storage.add("z".repeat(EDITOR_LIMITS.expandedBytes + 1));
		await storage.add("metadata rejected", "m".repeat(EDITOR_LIMITS.draftBytes + 1));
		console.log(JSON.stringify(storage.getRecent(100).map(row => row.prompt)));
	`,
		),
	).toEqual(["okay\n prompt"]);
	const db = new Database(dbPath, { readonly: true });
	try {
		expect(
			db.query<{ bytes: number }, []>("SELECT length(CAST(prompt AS BLOB)) AS bytes FROM history ORDER BY id").all(),
		).toEqual([{ bytes: Buffer.byteLength("okay\n prompt") }, { bytes: EDITOR_LIMITS.expandedBytes }]);
	} finally {
		db.close();
	}
});

test("damaged history keeps every readable prompt and title without resetting assigned row ids", async () => {
	const dbPath = await databasePath();
	await probe(dbPath, "console.log(JSON.stringify(null));");
	const prompt = (id: number) => `prompt-${String(id).padStart(4, "0")}-${"x".repeat(180)}`;
	const db = new Database(dbPath);
	db.run("PRAGMA secure_delete = ON");
	db.run(
		"CREATE TABLE session_titles (session_id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER NOT NULL)",
	);
	db.run("INSERT INTO session_titles VALUES ('retained', 'Recovered title', 1700000000)");
	const insert = db.prepare("INSERT INTO history (id, prompt, created_at) VALUES (?, ?, ?)");
	db.transaction(() => {
		for (let id = 1; id <= 200; id++) insert.run(id, prompt(id), 1_700_000_000 + id);
	})();
	insert.finalize();
	db.run("PRAGMA wal_checkpoint(TRUNCATE)");
	const pageSize = db.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
	db.close();
	const bytes = await fs.readFile(dbPath);
	const pageOf = (id: number): number => {
		const marker = prompt(id).slice(0, 12);
		for (let at = bytes.indexOf(marker); at !== -1; at = bytes.indexOf(marker, at + 1)) {
			const page = Math.floor(at / pageSize);
			if (bytes[page * pageSize] === 0x0d) return page;
		}
		throw new Error(`No table leaf holds prompt ${id}`);
	};
	const damaged = pageOf(200);
	const expected = Array.from({ length: 200 }, (_, index) => 200 - index)
		.filter(id => pageOf(id) !== damaged)
		.map(prompt);
	bytes.fill(0xff, damaged * pageSize, (damaged + 1) * pageSize);
	await Bun.write(dbPath, bytes);
	const result = await probe(
		dbPath,
		`
		const recovered = storage.getRecent(1000).map(row => row.prompt);
		await storage.add("after recovery");
		const check = new Database(${JSON.stringify(dbPath)});
		try {
			console.log(JSON.stringify({ recovered, next: storage.getRecent(1)[0]?.id,
				titles: check.query("SELECT session_id, title FROM session_titles").all(),
				integrity: check.query("PRAGMA quick_check").get().quick_check }));
		} finally { check.close(); }
	`,
	);
	expect(result).toEqual({
		recovered: expected,
		next: 201,
		titles: [{ session_id: "retained", title: "Recovered title" }],
		integrity: "ok",
	});
	expect((await fs.readdir(path.dirname(dbPath))).some(name => name.includes(".corrupt-"))).toBe(true);
});

test("history recall filters BLOB prompts rather than handing binary data to the editor", async () => {
	const dbPath = await databasePath();
	expect(
		await probe(
			dbPath,
			`
		await storage.add("readable prompt");
		const db = new Database(${JSON.stringify(dbPath)});
		db.run("INSERT INTO history (prompt, created_at) VALUES (x'72656164', 4102444800)");
		db.close();
		console.log(JSON.stringify({ recent: storage.getRecent(10).map(row => row.prompt), search: storage.search("read", 10).map(row => row.prompt) }));
	`,
		),
	).toEqual({ recent: ["readable prompt"], search: ["readable prompt"] });
});

test("the title index reopens after history.db is replaced instead of writing to the discarded inode", async () => {
	const dbPath = await databasePath();
	expect(
		await probe(
			dbPath,
			`
		index.recordSessionTitle("old-session", "Old title");
		HistoryStorage.close();
		for (const suffix of ["", "-wal", "-shm"]) {
			const file = ${JSON.stringify(dbPath)} + suffix;
			if (fsSync.existsSync(file)) fsSync.renameSync(file, file + ".old");
		}
		index.recordSessionTitle("new-session", "New title");
		const raw = new Database(${JSON.stringify(dbPath)});
		try { console.log(JSON.stringify({ current: index.lookupSessionTitle("new-session"),
			rows: raw.query("SELECT session_id, title FROM session_titles").all() })); }
		finally { raw.close(); index.closeSessionIndex(); }
	`,
		),
	).toEqual({ current: "New title", rows: [{ session_id: "new-session", title: "New title" }] });
});
