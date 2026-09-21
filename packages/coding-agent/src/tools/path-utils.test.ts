import { expect, test } from "bun:test";
import { expandTilde } from "./path-utils";

const home = "/home/example";

test("expandTilde expands exact home markers", () => {
	expect(expandTilde("~", home)).toBe(home);
	expect(expandTilde("~/notes/checklist.md", home)).toBe(`${home}/notes/checklist.md`);
	expect(expandTilde("~\\notes\\checklist.md", home)).toBe(`${home}\\notes\\checklist.md`);
});

test("expandTilde preserves named-user and literal tilde paths", () => {
	expect(expandTilde("~alice/file", home)).toBe("~alice/file");
	expect(expandTilde("~draft", home)).toBe("~draft");
});
