import { describe, expect, test } from "bun:test";
import { addonSentinel, assertAddonSentinel, expectedAddonSentinel } from "./addon-sentinel";

describe("native addon version sentinel", () => {
	test("derives the export name the loader demands from the package version", () => {
		expect(expectedAddonSentinel("20.2.1")).toBe("__piNativesV20_2_1");
		expect(expectedAddonSentinel("20.2.0-rc.1")).toBe("__piNativesV20_2_0_rc_1");
	});

	test("reads the sentinel an addon binary was compiled with", () => {
		const bytes = Buffer.from("\x7fELF…\0__piNativesV20_2_1\0more", "latin1");
		expect(addonSentinel(bytes)).toBe("__piNativesV20_2_1");
		expect(addonSentinel(Buffer.from("no marker here", "latin1"))).toBeUndefined();
	});

	test("rejects a stale addon with the rebuild instruction", () => {
		expect(() => assertAddonSentinel("pi_natives.darwin-arm64.node", "__piNativesV20_1_2", "20.2.1")).toThrow(
			/__piNativesV20_1_2.*__piNativesV20_2_1.*Rebuild the addon/,
		);
		expect(() => assertAddonSentinel("pi_natives.darwin-arm64.node", undefined, "20.2.1")).toThrow(
			/no version sentinel/,
		);
		expect(() => assertAddonSentinel("pi_natives.darwin-arm64.node", "__piNativesV20_2_1", "20.2.1")).not.toThrow();
	});
});
