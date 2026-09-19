import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BlobStore } from "./blob-store";

let root: string | undefined;

afterEach(async () => {
	if (root) await fs.rm(root, { recursive: true, force: true });
	root = undefined;
});

test("concurrent writes never expose a partial content-addressed blob", async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-blob-atomic-"));
	const store = new BlobStore(root);
	const payload = Buffer.alloc(16 * 1024 * 1024, 0x5a);
	const expected = await store.put(payload);

	const invalidReads: Buffer[] = [];
	const readers = Array.from({ length: 8 }, async () => {
		for (let attempt = 0; attempt < 100; attempt++) {
			const value = await store.get(expected.hash);
			if (value && !value.equals(payload)) invalidReads.push(value);
		}
	});
	const writers = Array.from({ length: 8 }, () => store.put(payload));
	await Promise.all([...readers, ...writers]);

	expect(invalidReads).toEqual([]);
});
