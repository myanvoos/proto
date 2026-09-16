import { expect, test } from "bun:test";
import { parseJudgeVerdict } from "./ttsr-judge";

test("a judge verdict survives the shapes a small model actually answers in", () => {
	expect(parseJudgeVerdict("YES")).toBe(true);
	expect(parseJudgeVerdict("no\n")).toBe(false);
	expect(parseJudgeVerdict("No — the set is filled at runtime.")).toBe(false);
	// Chatty models reason first and land on the verdict last.
	expect(parseJudgeVerdict("The question asks about literals. The answer is yes.")).toBe(true);
	expect(parseJudgeVerdict("Yes would mean a literal table, so: no")).toBe(false);
	// Nothing parseable must stay undecided rather than default to a firing rule.
	expect(parseJudgeVerdict("I cannot determine that.")).toBeUndefined();
	expect(parseJudgeVerdict("")).toBeUndefined();
});
