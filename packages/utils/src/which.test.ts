import { afterEach, expect, test, vi } from "bun:test";
import * as os from "node:os";
import { isExecutable } from "./procmgr";
import { $which } from "./which";

afterEach(() => {
	vi.restoreAllMocks();
});

test("lookups that differ only in which option carries a value do not share a cache entry", () => {
	const which = vi
		.spyOn(Bun, "which")
		.mockImplementation((_command, options) => (options?.cwd ? "/from-cwd" : "/from-path"));
	const command = "proto-which-cache-key-probe";
	expect($which(command, { cwd: "/opt/tools", PATH: "" })).toBe("/from-cwd");
	expect($which(command, { PATH: "/opt/tools" })).toBe("/from-path");
	expect(which).toHaveBeenCalledTimes(2);
});

test("a directory is not an executable even though it carries the execute bit", () => {
	expect(isExecutable(os.tmpdir())).toBe(false);
});
