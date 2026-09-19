import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BlobRegistry } from "./store";

let root: string | undefined;

function persistence(rootPath: string) {
	return {
		blobsDir: path.join(rootPath, "blobs"),
		indexPath: path.join(rootPath, "urls-index.json"),
		ttlMs: 0,
	};
}

afterEach(async () => {
	if (root) await fs.rm(root, { recursive: true, force: true });
	root = undefined;
});

test("concurrent first registration shares one persisted token", async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-blob-registry-"));
	const persist = persistence(root);
	const registry = new BlobRegistry({ persist });
	const bytes = Buffer.from("same content");
	const [first, second] = await Promise.all([
		registry.registerBytes("image-key", "image/png", bytes),
		registry.registerBytes("image-key", "image/png", bytes),
	]);

	expect(first.path).toBe(second.path);
	registry.flush();

	const restored = new BlobRegistry({ persist });
	const entry = restored.lookup("image-key");
	expect(entry?.path).toBe(first.path);
	const response = await restored.serve(new Request(`http://blob.test/${first.path}`));
	expect(response.status).toBe(200);
	expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
});

test("persistent purge does not report disk bytes as reclaimed", async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-blob-purge-"));
	const persist = persistence(root);
	const registry = new BlobRegistry({ persist });
	const bytes = Buffer.from("keep the session reference safe");
	await registry.registerBytes("purge-key", "image/png", bytes);
	const sha = new Bun.SHA256().update(bytes).digest("hex");
	const index = await fs.readFile(path.join(persist.blobsDir, sha), "utf8");

	const response = registry.purge({ all: true, apply: true });
	expect(response.purgedBlobs).toBe(1);
	expect(response.reclaimedBytes).toBe(0);
	expect(index).toBe(bytes.toString());
});
