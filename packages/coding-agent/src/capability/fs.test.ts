import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache, readDirEntries, readFile } from "./fs";

const tempDirs = new Set<string>();

async function makeTempDir(): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "proto-capability-fs-test-"));
	tempDirs.add(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();
	clearCache();
	await Promise.all([...tempDirs].map(dir => fs.promises.rm(dir, { recursive: true, force: true })));
	tempDirs.clear();
});

test("concurrent file reads share one filesystem operation before the cache is populated", async () => {
	const dir = await makeTempDir();
	const filePath = path.join(dir, "context.md");
	await Bun.write(filePath, "shared content");
	clearCache();
	const statSpy = vi.spyOn(fs.promises, "stat");
	const fileSpy = vi.spyOn(Bun, "file");

	const [first, second] = await Promise.all([readFile(filePath), readFile(filePath)]);

	expect(first).toBe("shared content");
	expect(second).toBe("shared content");
	expect(statSpy).toHaveBeenCalledTimes(1);
	expect(fileSpy).toHaveBeenCalledTimes(1);
});

test("concurrent directory reads share one filesystem operation before the cache is populated", async () => {
	const dir = await makeTempDir();
	await Bun.write(path.join(dir, "skill.md"), "content");
	clearCache();
	const readdirSpy = vi.spyOn(fs.promises, "readdir");

	const [first, second] = await Promise.all([readDirEntries(dir), readDirEntries(dir)]);

	expect(first.map(entry => entry.name)).toEqual(["skill.md"]);
	expect(second.map(entry => entry.name)).toEqual(["skill.md"]);
	expect(readdirSpy).toHaveBeenCalledTimes(1);
});
