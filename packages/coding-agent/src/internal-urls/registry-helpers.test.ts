import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry } from "../registry/agent-registry";
import {
	findSessionFileFromDisk,
	registerArtifactsDir,
	registerSessionFile,
	sessionFilesFromDisk,
} from "./registry-helpers";

const roots: string[] = [];
afterEach(async () => {
	AgentRegistry.resetGlobalForTests();
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

test("transcript discovery reaches nested workers beyond depth eight without leaving the artifact root", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-history-depth-"));
	roots.push(root);
	const unregister = registerArtifactsDir(root);
	try {
		let nested = root;
		for (let depth = 0; depth < 12; depth++) nested = path.join(nested, `depth-${depth}`);
		await fs.mkdir(nested, { recursive: true });
		const file = path.join(nested, "deep-worker.jsonl");
		await Bun.write(file, '{"type":"session","id":"deep-worker"}\n');

		const files = await sessionFilesFromDisk();
		expect(files.get("deep-worker")).toBe(file);
	} finally {
		unregister();
	}
});

test("spawn registration is immediately indexed and a deleted transcript is invalidated on lookup", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-history-index-"));
	roots.push(root);
	const unregister = registerArtifactsDir(root);
	try {
		const file = path.join(root, "new-worker.jsonl");
		await Bun.write(file, '{"type":"session","id":"new-worker"}\n');
		await registerSessionFile("new-worker", file);
		expect(await findSessionFileFromDisk("NEW-WORKER")).toBe(file);

		await fs.rm(file);
		expect(await findSessionFileFromDisk("new-worker")).toBeUndefined();
		expect((await sessionFilesFromDisk()).has("new-worker")).toBe(false);
	} finally {
		unregister();
	}
});
