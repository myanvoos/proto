import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getNativeAddonPath } from "../native/loader-state.js";
import packageJson from "../package.json" with { type: "json" };

const loaderPath = path.join(import.meta.dir, "../native/loader-state.js");
const script = `import { getNativeAddonPath } from ${JSON.stringify(loaderPath)}; process.stdout.write(getNativeAddonPath());`;

async function resolveAddon(override: string, cwd: string): Promise<string> {
	const child = Bun.spawn([process.execPath, "--eval", script], {
		cwd,
		env: { ...process.env, PI_COMPILED: "1", PROTO_NATIVES_DIR: override },
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = await new Response(child.stdout).text();
	const error = await new Response(child.stderr).text();
	expect(await child.exited, error).toBe(0);
	return output;
}

test("compiled native loading uses absolute and home-relative override directories but ignores relative paths", async () => {
	const root = await fs.mkdtemp(path.join(os.homedir(), ".proto-native-loader-test-"));
	try {
		const versioned = path.join(root, packageJson.version);
		await fs.mkdir(versioned);
		const expected = path.join(versioned, path.basename(getNativeAddonPath()));
		await fs.symlink(getNativeAddonPath(), expected);
		expect(await resolveAddon(` ${root} `, root)).toBe(expected);
		expect(await resolveAddon(`~/${path.basename(root)}`, root)).toBe(expected);
		expect(await resolveAddon(path.basename(root), root)).toBe(await resolveAddon("", root));
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
