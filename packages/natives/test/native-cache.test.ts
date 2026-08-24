import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	cleanupStaleNativeVersions,
	getAddonFilenames,
	prepareNativeVersionDir,
	resolveLoaderCandidates,
} from "../native/loader-state.js";
import packageJson from "../package.json" with { type: "json" };

const posixNodeModulesNativeDir = "/home/u/proj/node_modules/@oh-my-pi/pi-natives/native";

describe("native loader candidate fallback", () => {
	it("keeps installed-package candidates free of compiled-cache paths", () => {
		const versionedDir = "/home/u/.proto/natives/15.0.1";
		const candidates = resolveLoaderCandidates({
			addonFilenames: getAddonFilenames({ tag: "linux-x64", arch: "x64", variant: "baseline" }),
			isCompiledBinary: false,
			nativeDir: posixNodeModulesNativeDir,
			execDir: "/usr/bin",
			versionedDir,
			userDataDir: "/home/u/.local/bin",
		});

		const versionedBaseline = path.join(versionedDir, "pi_natives.linux-x64-baseline.node");
		const nodeModulesBaseline = path.join(posixNodeModulesNativeDir, "pi_natives.linux-x64-baseline.node");
		expect(candidates).not.toContain(versionedBaseline);
		expect(candidates).toContain(nodeModulesBaseline);
	});
});

describe("native version cache cleanup", () => {
	it("removes only older version directories after the current native version loads", async () => {
		const nativesDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-natives-cache-"));
		const currentMajor = Number.parseInt(packageJson.version, 10);
		const futureVersion = `${currentMajor + 1}.0.0`;
		const staleVersion = "15.10.11";
		const freshVersion = "15.10.12";
		try {
			await fs.mkdir(path.join(nativesDir, staleVersion));
			await fs.mkdir(path.join(nativesDir, freshVersion));
			await fs.mkdir(path.join(nativesDir, packageJson.version));
			await fs.mkdir(path.join(nativesDir, futureVersion));
			await fs.mkdir(path.join(nativesDir, "not-a-version"));
			await Bun.write(path.join(nativesDir, "README.txt"), "not a version directory");
			await fs.utimes(path.join(nativesDir, staleVersion), new Date(0), new Date(0));
			await fs.utimes(path.join(nativesDir, freshVersion), new Date(0), new Date(0));
			prepareNativeVersionDir(path.join(nativesDir, freshVersion));

			const removed = cleanupStaleNativeVersions({ nativesDir, currentVersion: packageJson.version });

			expect(removed.map(filePath => path.basename(filePath))).toEqual([staleVersion]);
			expect((await fs.readdir(nativesDir)).sort()).toEqual(
				["README.txt", freshVersion, packageJson.version, futureVersion, "not-a-version"].sort(),
			);
		} finally {
			await fs.rm(nativesDir, { recursive: true, force: true });
		}
	});
});

describe("pi-natives version sentinel", () => {
	it("Rust `js_name` matches the package version", async () => {
		// The JS loader (`packages/natives/native/index.js`) computes its expected
		// sentinel from `package.json#version`; if the Rust source falls out of
		// sync we ship a `.node` that the loader will refuse to use. Pinning the
		// pairing here catches release-script regressions before they reach CI.
		const libRs = await Bun.file(path.join(import.meta.dir, "../../../crates/pi-natives/src/lib.rs")).text();
		const sentinelMatch = libRs.match(/js_name = "(__piNativesV[A-Za-z0-9_]+)"/);
		expect(sentinelMatch, 'Rust sentinel `js_name = "__piNativesV…"` not found in lib.rs').not.toBeNull();
		const expected = `__piNativesV${packageJson.version.replace(/[^A-Za-z0-9]/g, "_")}`;
		expect(sentinelMatch?.[1]).toBe(expected);
	});
});
