import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveArtifactFile } from "./artifact-protocol";
import { registerArtifactsDir } from "./registry-helpers";
import type { InternalUrl } from "./types";

let root: string | undefined;
let unregister: (() => void) | undefined;

afterEach(async () => {
	unregister?.();
	unregister = undefined;
	if (root) await fs.rm(root, { recursive: true, force: true });
	root = undefined;
});

test("artifact resolution refuses a symlink that escapes the registered root", async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-artifact-symlink-"));
	const outside = path.join(root, "..", `proto-artifact-secret-${crypto.randomUUID()}`);
	await Bun.write(outside, "must not be exposed");
	await fs.symlink(outside, path.join(root, "0.tool.log"));
	unregister = registerArtifactsDir(root);

	const url = Object.assign(new URL("artifact://0"), { rawHost: "0" }) as InternalUrl;
	await expect(
		resolveArtifactFile(url, { localProtocolOptions: { getArtifactsDir: (): string | null => root ?? null } }),
	).rejects.toThrow(/outside/i);
	await fs.rm(outside, { force: true });
});
