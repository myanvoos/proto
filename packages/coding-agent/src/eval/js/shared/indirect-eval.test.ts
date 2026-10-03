import { expect, test } from "bun:test";
import { indirectEval } from "./indirect-eval";

test("a filename with line terminators cannot inject source through the sourceURL pragma", () => {
	const key = "__protoSourceUrlInjection";
	const globals = globalThis as Record<string, unknown>;
	try {
		for (const separator of ["\n", "\r", "\u2028", "\u2029"]) {
			expect(indirectEval("1 + 1", `cell.js${separator}globalThis.${key} = true;`)).toBe(2);
		}
		expect(globals[key]).toBeUndefined();
	} finally {
		delete globals[key];
	}
});
