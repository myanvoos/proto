import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Shell } from "../native/index.js";

test("native shell transports write snapshots and rejects stale redirects and tee", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "native-shell-writes-"));
	const shell = new Shell();
	try {
		await writeFile(join(cwd, "file"), "before\n");
		let result = await shell.run({ cwd, command: "cat file; printf after > file" });
		expect(result.exitCode).toBe(0);
		expect(result.fsObservations.find(value => value.mutation)?.mutation).toEqual({
			existed: true,
			exists: true,
			before: "before\n",
			after: "after",
		});
		await writeFile(join(cwd, "file"), "outside update");
		for (const command of ["printf lost > file", "printf lost | tee file"]) {
			result = await shell.run({ cwd, command });
			expect(result.exitCode).not.toBe(0);
			expect(await readFile(join(cwd, "file"), "utf8")).toBe("outside update");
			expect(result.fsObservations).toEqual([]);
		}
		result = await shell.run({ cwd, command: "cat file; : > file; printf tee | tee newfile" });
		expect(result.exitCode).toBe(0);
		expect(result.fsObservations.find(value => value.path === join(cwd, "file"))?.mutation?.after).toBe("");
		const created = result.fsObservations.find(value => value.path === join(cwd, "newfile"))?.mutation;
		expect(created?.existed).toBe(false);
		expect(created?.exists).toBe(true);
		expect(created?.before).toBeUndefined();
		expect(created?.after).toBe("tee");
	} finally {
		await shell.close();
		await rm(cwd, { recursive: true, force: true });
	}
});
