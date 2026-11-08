import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { Settings } from "../config/settings";
import { resolveProtofsCommand } from "./settings";

const MODULE_DIR = "/repo/packages/coding-agent/src/protofs";
const EXEC_PATH = "/opt/proto/bin/proto";

function settings(overrides: Record<string, unknown> = {}): Settings {
	return Settings.isolated({
		"protofs.enabled": true,
		...overrides,
	});
}

function environment(existing: readonly string[], which: string | null = null, embedded = false) {
	return {
		execPath: EXEC_PATH,
		platform: "darwin" as const,
		arch: "arm64",
		moduleDir: MODULE_DIR,
		exists: (candidate: string) => existing.includes(candidate),
		which: () => which,
		embedded,
	};
}

describe("protofs command resolution", () => {
	test("protofs.enabled=false disables every candidate, even an explicit path", () => {
		const resolved = resolveProtofsCommand(
			settings({ "protofs.enabled": false, "protofs.path": "/custom/protofs" }),
			environment(["/custom/protofs"], "/usr/bin/protofs"),
		);
		expect(resolved).toBeUndefined();
	});

	test("an explicit protofs.path wins over bundled and PATH binaries", () => {
		const resolved = resolveProtofsCommand(
			settings({ "protofs.path": "/custom/protofs" }),
			environment([path.join(path.dirname(EXEC_PATH), "protofs-darwin-arm64")], "/usr/bin/protofs"),
		);
		expect(resolved).toBe("/custom/protofs");
	});

	test("the platform-specific sibling beside the proto binary wins over the plain sibling", () => {
		const execDir = path.dirname(EXEC_PATH);
		const resolved = resolveProtofsCommand(
			settings(),
			environment([path.join(execDir, "protofs"), path.join(execDir, "protofs-darwin-arm64")]),
		);
		expect(resolved).toBe(path.join(execDir, "protofs-darwin-arm64"));
	});

	test("the plain sibling is used when the platform-specific sibling is absent", () => {
		const execDir = path.dirname(EXEC_PATH);
		const resolved = resolveProtofsCommand(settings(), environment([path.join(execDir, "protofs")]));
		expect(resolved).toBe(path.join(execDir, "protofs"));
	});

	test("a development build in packages/coding-agent/binaries is used before the vendored source build", () => {
		const devBinary = path.join(MODULE_DIR, "..", "..", "binaries", "protofs-darwin-arm64");
		const resolved = resolveProtofsCommand(settings(), environment([devBinary]));
		expect(resolved).toBe(devBinary);
	});

	test("the vendored protofs/protofs build is used before PATH", () => {
		const sourceBuild = path.join(MODULE_DIR, "..", "..", "..", "protofs", "protofs");
		const resolved = resolveProtofsCommand(settings(), environment([sourceBuild], "/usr/bin/protofs"));
		expect(resolved).toBe(sourceBuild);
	});

	test("falls back to protofs on PATH, and returns undefined when nothing exists", () => {
		expect(resolveProtofsCommand(settings(), environment([], "/usr/bin/protofs"))).toBe("protofs");
		expect(resolveProtofsCommand(settings(), environment([], null))).toBeUndefined();
	});

	test("a loadable library resolves protofs without an executable unless protofs.embedded is off", () => {
		expect(resolveProtofsCommand(settings(), environment([], null, true))).toBe("protofs");
		expect(
			resolveProtofsCommand(settings({ "protofs.embedded": false }), environment([], null, true)),
		).toBeUndefined();
	});
});
