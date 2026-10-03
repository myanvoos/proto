import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { Settings } from "../config/settings";
import { flushGrievances } from "./report-tool-issue";

const settings = Settings.isolated({
	"dev.autoqa": true,
	"dev.autoqaPush.endpoint": "https://qa.example.com/grievances",
});

let db: Database;

beforeEach(() => {
	db = new Database(":memory:");
	db.run(`
		CREATE TABLE grievances (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			model TEXT NOT NULL,
			version TEXT NOT NULL,
			tool TEXT NOT NULL,
			report TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			pushed INTEGER NOT NULL DEFAULT 0,
			push_error TEXT
		);
	`);
});

afterEach(() => db.close());

function insert(tool: string, report: string): void {
	db.prepare("INSERT INTO grievances (model, version, tool, report) VALUES ('m', 'v', ?, ?)").run(tool, report);
}

function rowsByState(): Record<string, number[]> {
	const rows = db.prepare("SELECT id, pushed FROM grievances ORDER BY id").all() as { id: number; pushed: number }[];
	return Object.fromEntries(
		[...new Set(rows.map(row => row.pushed))].map(state => [
			String(state),
			rows.filter(row => row.pushed === state).map(row => row.id),
		]),
	);
}

function collector(respond: (entries: { tool: string; report: string }[]) => Response): {
	fetch: FetchImpl;
	calls: () => number;
} {
	let calls = 0;
	const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
		calls++;
		return respond(JSON.parse(String(init?.body)).entries);
	}) as FetchImpl;
	return { fetch, calls: () => calls };
}

// bypassConsent skips the shared in-flight/cooldown gates, keeping each test independent.
describe("flushGrievances", () => {
	it("parks a refused row and drains the rest of the backlog", async () => {
		for (let i = 0; i < 6; i++) insert(i === 0 ? "poison" : "read", `report-${i}`);
		const { fetch } = collector(entries =>
			entries.some(entry => entry.tool === "poison")
				? new Response("poison rejected", { status: 400 })
				: new Response("", { status: 200 }),
		);

		const result = await flushGrievances(db, settings, { fetch, bypassConsent: true });

		expect(result).toEqual({ pushed: 5, ok: true, rejected: 1, error: "HTTP 400: poison rejected" });
		expect(rowsByState()).toEqual({ "-1": [1], "1": [2, 3, 4, 5, 6] });
		expect(db.prepare("SELECT push_error FROM grievances WHERE id = 1").get()).toEqual({
			push_error: "HTTP 400: poison rejected",
		});
		const again = collector(() => new Response("", { status: 200 }));
		expect(await flushGrievances(db, settings, { fetch: again.fetch, bypassConsent: true })).toEqual({
			pushed: 0,
			ok: true,
		});
		expect(again.calls()).toBe(0);
	});

	it("keeps rows queued on auth failures instead of parking them", async () => {
		insert("read", "unauthorized");
		const { fetch } = collector(() => new Response("bad token", { status: 401 }));

		const result = await flushGrievances(db, settings, { fetch, bypassConsent: true });

		expect(result).toEqual({ pushed: 0, ok: false, error: "HTTP 401: bad token" });
		expect(rowsByState()).toEqual({ "0": [1] });
	});

	it("clamps an over-long tool name on the wire and keeps the full line in the report", async () => {
		const prose =
			"tool.glob yolu çağırınca beklenmedik şekilde RuntimeError fırlatıyor, sessizce boş dönmüyor. ".repeat(3);
		insert(prose, "details");
		let sent: { tool: string; report: string }[] = [];
		const { fetch } = collector(entries => {
			sent = entries;
			const oversized = entries.some(entry => Buffer.byteLength(entry.tool, "utf8") > 128);
			return new Response("", { status: oversized ? 400 : 200 });
		});

		expect(await flushGrievances(db, settings, { fetch, bypassConsent: true })).toEqual({ pushed: 1, ok: true });
		expect(prose.startsWith(sent[0]!.tool)).toBe(true);
		expect(sent[0]!.report).toBe(`${prose}\ndetails`);
	});
});
