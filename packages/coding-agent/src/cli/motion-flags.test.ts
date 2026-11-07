import { expect, test } from "bun:test";
import { parseArgs } from "./args";

test("animation flags parse into the ephemeral overrides they name", () => {
	const args = parseArgs([
		"--spinner-interval",
		"250",
		"--max-fps",
		"4",
		"--motion",
		"reduced",
		"--shimmer",
		"disabled",
	]);
	expect(args.spinnerInterval).toBe(250);
	expect(args.maxFps).toBe(4);
	expect(args.motion).toBe("reduced");
	expect(args.shimmer).toBe("disabled");
});

test("animation flags reject values the settings layer would refuse", () => {
	expect(() => parseArgs(["--spinner-interval", "10"])).toThrow(/spinner-interval/);
	expect(() => parseArgs(["--max-fps", "0"])).toThrow(/max-fps/);
	expect(() => parseArgs(["--motion", "fast"])).toThrow(/motion/);
	expect(() => parseArgs(["--shimmer", "sparkle"])).toThrow(/shimmer/);
});
