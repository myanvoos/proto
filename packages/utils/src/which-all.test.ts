import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "./temp";
import { $whichAll } from "./which";

test("all binary candidates preserve PATH priority without repeated directories", async () => {
	using tmp = TempDir.createSync("@which-all-");
	const name = "proto-test-interpreter";
	const first = path.join(tmp.path(), "first", name);
	const second = path.join(tmp.path(), "second", name);
	await Bun.write(first, "#!/bin/sh\nexit 1\n");
	await Bun.write(second, "#!/bin/sh\nexit 0\n");
	await Promise.all([fs.chmod(first, 0o700), fs.chmod(second, 0o700)]);
	const PATH = [path.dirname(first), path.dirname(second), path.dirname(first)].join(path.delimiter);
	expect($whichAll(name, { PATH })).toEqual([first, second]);
	expect($whichAll("absent-interpreter", { PATH })).toEqual([]);
});
