import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache } from "../capability/fs";
import { expandAtImports } from "./at-imports";

test("escaped-space context imports expand real paths and preserve missing tokens and code examples", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-at-import-space-"));
	try {
		await Bun.write(path.join(root, "with space.md"), "included instructions");
		const input = "@./with\\ space.md and @./missing\\ file.md\n`@./with\\ space.md`";
		const expanded = await expandAtImports(input, path.join(root, "AGENTS.md"));
		expect(expanded).toBe("included instructions and @./missing\\ file.md\n`@./with\\ space.md`");
	} finally {
		clearCache();
		await fs.rm(root, { recursive: true, force: true });
	}
});
