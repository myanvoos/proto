import { describe, expect, test } from "bun:test";
import { buildNodeJsKernel } from "./node-runtime";

describe("node kernel bundle", () => {
	// Release builds embed the native addon archive into the natives package; a Node kernel bundle that still
	// pulled in the addon loader then emitted that archive as a second output and broke `bun run build`.
	test("carries no native addon loader", async () => {
		const source = await buildNodeJsKernel();
		expect(source).toContain("native bindings are unavailable in node kernels");
		expect(source).not.toContain("__PI_NATIVE_VARIANT_CACHE");
		expect(source).not.toContain("embeddedAddon");
	});
});
