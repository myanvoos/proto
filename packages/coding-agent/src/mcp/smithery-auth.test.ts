import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as dirs from "@oh-my-pi/pi-utils/dirs";
import { saveSmitheryApiKey } from "./smithery-auth";

const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

test("never publishes a newly-created API key with group or other permissions", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-smithery-auth-"));
	tempDirs.push(tempDir);
	spyOn(dirs, "getAgentDir").mockReturnValue(tempDir);
	const authPath = path.join(tempDir, "smithery.json");
	const publishedModes: number[] = [];
	const realChmod = fs.chmod;
	spyOn(fs, "chmod").mockImplementation(async (filePath, mode) => {
		publishedModes.push((await fs.stat(filePath)).mode & 0o777);
		await realChmod(filePath, mode);
	});

	const previousUmask = process.umask(0o022);
	try {
		await saveSmitheryApiKey("local-secret");
	} finally {
		process.umask(previousUmask);
	}

	expect(publishedModes).not.toContain(0o644);
	expect((await fs.stat(authPath)).mode & 0o777).toBe(0o600);
});
