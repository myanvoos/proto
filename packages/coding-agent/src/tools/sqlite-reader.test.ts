import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { executeReadQuery, getRowByRowId, parseSqliteSelector, queryRows, renderTable } from "./sqlite-reader";

const ROW_COUNT = 100;
const PAGE_LIMIT = 20;

describe("SQLite pagination", () => {
	test("bounds page discovery work and truthfully indicates an unknown remaining count", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)");
			db.run(
				`WITH RECURSIVE sequence(value) AS (
					SELECT 1
					UNION ALL
					SELECT value + 1 FROM sequence WHERE value < ${ROW_COUNT}
				) INSERT INTO items (label) SELECT printf('item-%04d', value) FROM sequence`,
			);

			const page = queryRows(db, "items", { limit: PAGE_LIMIT, offset: 0 });

			expect(page.rows).toHaveLength(PAGE_LIMIT);
			expect(page.totalCount).toBe(PAGE_LIMIT + 1);
			const rendered = renderTable(page.columns, page.rows, {
				totalCount: page.totalCount,
				offset: 0,
				limit: PAGE_LIMIT,
				table: "items",
				dbPath: ":memory:",
			});
			expect(rendered).toContain("[More rows; append :items?limit=20&offset=20 to the database path to continue]");
			expect(rendered).not.toContain("80 more rows");
		} finally {
			db.close();
		}
	});
});

test("SQLite pages retain generated columns and order and filter selectors", () => {
	const db = new Database(":memory:");
	try {
		db.run("CREATE TABLE items (n INTEGER, doubled INTEGER GENERATED ALWAYS AS (n * 2) VIRTUAL)");
		db.run("INSERT INTO items (n) VALUES (1),(2),(3),(4)");
		const where = "n >= 2";
		const order = "doubled:desc";
		const page = queryRows(db, "items", { limit: 1, offset: 0, where, order });
		expect(page.columns).toEqual(["n", "doubled"]);
		expect(page.rows).toEqual([{ n: 4, doubled: 8 }]);
		const rendered = renderTable(page.columns, page.rows, {
			totalCount: page.totalCount,
			offset: 0,
			limit: 1,
			table: "items",
			dbPath: ":memory:",
			where,
			order,
		});
		const params = new URLSearchParams(rendered.match(/append :items\?(.+) to the database/)![1]);
		expect(params.get("where")).toBe(where);
		expect(params.get("order")).toBe(order);
		const next = parseSqliteSelector("items", params.toString());
		if (next.kind !== "query") throw new Error("expected query continuation");
		expect(queryRows(db, next.table, next).rows).toEqual([{ n: 3, doubled: 6 }]);
	} finally {
		db.close();
	}
});

test("SQLite raw-query pagination preserves duplicate-column and PRAGMA behavior", () => {
	const db = new Database(":memory:");
	try {
		db.run("CREATE TABLE items (id INTEGER, label TEXT)");
		db.run("INSERT INTO items VALUES (1,'a'),(2,'b'),(3,'c')");
		const query = "SELECT id FROM items ORDER BY id; -- trailing comment";
		const page = executeReadQuery(db, query, { limit: 1, offset: 1 });
		expect(page.rows).toEqual([{ id: 2 }]);
		expect(page.truncated).toBe(true);
		const duplicate = "SELECT id AS x, id + 10 AS x FROM items ORDER BY id";
		expect(executeReadQuery(db, duplicate, { limit: 1, offset: 1 }).rows).toEqual(
			executeReadQuery(db, duplicate).rows.slice(1, 2),
		);
		expect(executeReadQuery(db, "PRAGMA table_info(items)", { limit: 1, offset: 1 }).rows[0]?.name).toBe("label");
		const selected = parseSqliteSelector("", "q=SELECT+id+FROM+items&limit=1&offset=2");
		expect(selected.kind === "raw" && selected.page).toEqual({ limit: 1, offset: 2 });
	} finally {
		db.close();
	}
});

test("SQLite row-key reads bypass user columns shadowing hidden rowid aliases", () => {
	const db = new Database(":memory:");
	try {
		db.run("CREATE TABLE items (ROWID TEXT, _rowid_ TEXT GENERATED ALWAYS AS ('shadow'))");
		db.run("INSERT INTO items (ROWID) VALUES ('not-an-id')");
		expect(getRowByRowId(db, "items", "1")?.ROWID).toBe("not-an-id");
		db.run("CREATE TABLE blocked (rowid TEXT, _rowid_ TEXT, oid TEXT)");
		expect(() => getRowByRowId(db, "blocked", "1")).toThrow("shadows all ROWID aliases");
	} finally {
		db.close();
	}
});
