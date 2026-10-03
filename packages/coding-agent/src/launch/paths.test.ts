import { afterEach, describe, expect, it, vi } from "bun:test";
import type { PathLike } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalProjectDir } from "./paths";

describe("canonicalProjectDir", () => {
	const originalRealpath = fs.realpath.bind(fs);
	const tempDirs: string[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
	});

	async function failRealpathWith(code: string): Promise<string> {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-canonical-dir-"));
		tempDirs.push(projectDir);
		vi.spyOn(fs, "realpath").mockImplementation((async (p: PathLike) => {
			if (path.resolve(String(p)) === projectDir) {
				throw Object.assign(new Error(`${code}: realpath failed`), { code, syscall: "realpath" });
			}
			return originalRealpath(p);
		}) as typeof fs.realpath);
		return projectDir;
	}

	for (const code of ["EPERM", "EACCES"]) {
		it(`falls back to the resolved path when realpath is denied with ${code}`, async () => {
			const projectDir = await failRealpathWith(code);
			await expect(canonicalProjectDir(projectDir)).resolves.toBe(projectDir);
		});
	}

	it("rethrows other realpath failures", async () => {
		const projectDir = await failRealpathWith("ELOOP");
		await expect(canonicalProjectDir(projectDir)).rejects.toMatchObject({ code: "ELOOP" });
	});
});
