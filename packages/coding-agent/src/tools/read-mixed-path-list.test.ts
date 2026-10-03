import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import type { ToolSession } from ".";
import { ReadTool } from "./read";

let cwd: string;
let session: ToolSession;

beforeAll(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "read-mixed-list-"));
	await Bun.write(path.join(cwd, "Makefile"), "build:\n\techo make\n");
	await Bun.write(path.join(cwd, "a.ts"), "export const a = 1;\n");
	await Bun.write(path.join(cwd, "a;b.md"), "literal semicolon file\n");
	await Bun.write(path.join(cwd, "a"), "plain a\n");
	await Bun.write(path.join(cwd, "b.md"), "plain b\n");
	const db = new Database(path.join(cwd, "data.sqlite"));
	db.run("CREATE TABLE t (name TEXT)");
	db.run("INSERT INTO t VALUES ('row-one')");
	db.close();
	session = {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "fetch.enabled": true }),
	} as unknown as ToolSession;
});

afterAll(async () => {
	await removeWithRetries(cwd);
});

async function readText(target: string): Promise<string> {
	const result = await new ReadTool(session).execute("r", { path: target });
	return result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
}

describe("read with a `;` list mixing URLs and local paths", () => {
	it("splits an internal URL followed by a local path", async () => {
		const text = await readText("harness://;a.ts:1-1");
		expect(text).toContain("interpreted as 2 paths");
		expect(text).toContain("export const a = 1;");
	});

	it("splits a URL followed by an existing local path", async () => {
		const text = await readText("https://127.0.0.1:9/x;a.ts:1-1");
		expect(text).toContain("interpreted as 2 paths");
		expect(text).toContain("export const a = 1;");
	});

	it("keeps a URL that contains `;` whole", async () => {
		const text = await readText("https://127.0.0.1:9/x;v=1").catch((error: Error) => error.message);
		expect(text).not.toContain("interpreted as");
	});

	it("keeps a sqlite query ending in `;` whole", async () => {
		const text = await readText("data.sqlite?q=SELECT * FROM t;");
		expect(text).not.toContain("interpreted as");
		expect(text).toContain("row-one");
	});

	it("flattens nested grouped targets of a mixed comma and semicolon list", async () => {
		const result = await new ReadTool(session).execute("r", { path: "a.ts,Makefile;b.md" });
		expect(result.details?.displayReadTargets).toEqual(["a.ts", "Makefile", "b.md"]);
	});

	it("reads `a;b.md:1-1` as the literal file even when `a` and `b.md` exist", async () => {
		const text = await readText("a;b.md:1-1");
		expect(text).not.toContain("interpreted as");
		expect(text).toContain("literal semicolon file");
	});
});
