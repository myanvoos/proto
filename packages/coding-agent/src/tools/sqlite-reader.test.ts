import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { queryRows, renderTable } from "./sqlite-reader";

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
