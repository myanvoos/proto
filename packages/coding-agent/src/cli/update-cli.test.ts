import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseReportedVersion, resolveUpdateTargetFromPath, updateViaBinaryAt } from "./update-cli";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-update-cli-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("parseReportedVersion", () => {
	it("reads proto's version output, including prerelease suffixes", () => {
		expect(parseReportedVersion("proto/19.1.4")).toBe("19.1.4");
		expect(parseReportedVersion("proto/19.2.0-rc.1")).toBe("19.2.0-rc.1");
	});

	it("rejects version output from a different executable", () => {
		expect(parseReportedVersion("node/19.1.4")).toBeUndefined();
		expect(parseReportedVersion("1.4.2")).toBeUndefined();
		expect(parseReportedVersion("not a version")).toBeUndefined();
	});
});

describe("updateViaBinaryAt behind a foreign symlink", () => {
	async function updateThroughAlias(aliasPath: string, fetchImpl: () => Promise<Response>) {
		const target = resolveUpdateTargetFromPath(aliasPath, undefined);
		if (target.method !== "binary") throw new Error("Expected binary update target");
		expect(target.validateExistingTarget).toBe(true);
		return updateViaBinaryAt(target.path, "19.9.9", {
			binaryName: "proto-linux-x64",
			fetchImpl,
			githubToken: "test-token",
			validateExistingTarget: target.validateExistingTarget,
		});
	}

	it("refuses to overwrite a shared shebang dispatcher", async () => {
		const dir = await makeTempDir();
		const dispatcherPath = path.join(dir, "launch");
		const aliasPath = path.join(dir, "proto");
		const dispatcher = "#!/bin/sh\necho proto/19.1.4\n";
		await Bun.write(dispatcherPath, dispatcher);
		await fs.chmod(dispatcherPath, 0o755);
		await fs.symlink("launch", aliasPath);
		const fetchImpl = vi.fn(async () => new Response());

		await expect(updateThroughAlias(aliasPath, fetchImpl)).rejects.toThrow(
			`Refusing to replace ${await fs.realpath(dispatcherPath)}`,
		);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(await Bun.file(dispatcherPath).text()).toBe(dispatcher);
	});

	it("refuses a native target that does not report a proto version", async () => {
		const dir = await makeTempDir();
		const aliasPath = path.join(dir, "proto");
		await fs.symlink(process.execPath, aliasPath);
		const fetchImpl = vi.fn(async () => new Response());

		await expect(updateThroughAlias(aliasPath, fetchImpl)).rejects.toThrow(
			"does not report a proto version when run directly",
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
