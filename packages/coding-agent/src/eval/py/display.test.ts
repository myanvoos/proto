import { expect, test } from "bun:test";
import { renderKernelDisplay } from "./display";

test("JSON display bundles expose one model-visible rendering", async () => {
	const rendered = await renderKernelDisplay({
		"application/json": { a: 1 },
		"text/plain": "{'a': 1}",
	});

	expect(rendered.text).toBe("");
	expect(rendered.outputs).toEqual([{ type: "json", data: { a: 1 } }]);
});

test("plain text display bundles remain model-visible text", async () => {
	const rendered = await renderKernelDisplay({ "text/plain": "hello" });

	expect(rendered.text).toBe("hello\n");
	expect(rendered.outputs).toEqual([]);
});
