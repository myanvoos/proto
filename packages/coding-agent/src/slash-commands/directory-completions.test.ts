import { expect, test } from "bun:test";
import * as path from "node:path";
import { getProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { buildDirectoryArgumentCompletions } from "./builtin-completions";

test("move completion accepts directory punctuation before descending into children", async () => {
	const complete = buildDirectoryArgumentCompletions();
	for (const prefix of [".", "..", "~", "foo/.", "foo/.."]) {
		expect(await complete(prefix)).toEqual([{ value: `${prefix}/`, label: `${prefix}/` }]);
	}
});

test("move completion retains an absolute destination and does not turn the current directory into root", async () => {
	using tmp = TempDir.createSync("@move-completions-");
	await Bun.write(path.join(tmp.path(), "child", "file.txt"), "fixture");
	const complete = buildDirectoryArgumentCompletions();
	expect(await complete(`${tmp.path()}/`)).toEqual([{ value: `${tmp.path()}/child/`, label: "child/" }]);
	const cwd = getProjectDir();
	const prefix = `${path.dirname(cwd)}/${path.basename(cwd)}`;
	const matches = await complete(prefix);
	expect(matches?.find(item => item.value === `${cwd}/`)).toBeDefined();
});
