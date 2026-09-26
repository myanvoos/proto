import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { collectWeakRefs } from "../../test/fixtures/worker-lifecycle";
import { BlobRegistry } from "./store";

let root: string | undefined;
let registry: BlobRegistry | undefined;

function persistence(rootPath: string) {
	return {
		blobsDir: path.join(rootPath, "blobs"),
		indexPath: path.join(rootPath, "urls-index.json"),
		ttlMs: 0,
	};
}

afterEach(async () => {
	registry?.flush();
	registry = undefined;
	if (root) await fs.rm(root, { recursive: true, force: true });
	root = undefined;
});

test("concurrent first registration shares one persisted token", async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-blob-registry-"));
	const persist = persistence(root);
	registry = new BlobRegistry({ persist });
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
	restored.flush();
});

test("persistent purge does not report disk bytes as reclaimed", async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-blob-purge-"));
	const persist = persistence(root);
	registry = new BlobRegistry({ persist });
	const bytes = Buffer.from("keep the session reference safe");
	await registry.registerBytes("purge-key", "image/png", bytes);
	const sha = new Bun.SHA256().update(bytes).digest("hex");
	const index = await fs.readFile(path.join(persist.blobsDir, sha), "utf8");

	const response = registry.purge({ all: true, apply: true });
	expect(response.purgedBlobs).toBe(1);
	expect(response.reclaimedBytes).toBe(0);
	expect(index).toBe(bytes.toString());
});

test("invalid residency budgets cannot silently disable admission", () => {
	expect(() => new BlobRegistry({ maxBytes: Number.NaN })).toThrow(RangeError);
});

test("oversize eager admission fails without evicting a readable blob or leaving a failed key", async () => {
	registry = new BlobRegistry({ maxBytes: 8 });
	const original = await registry.registerBytes("original", "image/png", new Uint8Array([1, 2, 3]));

	await expect(registry.registerBytes("oversize", "image/png", new Uint8Array(32))).rejects.toThrow(
		/resident.*budget/i,
	);
	expect(registry.lookup("oversize")).toBeNull();
	expect(registry.status().metrics.residentBytes).toBe(3);
	expect(registry.status().metrics.activeBlobs).toBe(1);
	const response = await registry.serve(new Request(`http://blob.test/${original.path}`));
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

	const retried = await registry.registerBytes("oversize", "image/png", new Uint8Array(5));
	expect((await registry.serve(new Request(`http://blob.test/${retried.path}`))).status).toBe(200);
	expect(registry.status().metrics.residentBytes).toBe(8);
});

test("exhausted nonpersistent storage rejects new blobs instead of destroying existing handles", async () => {
	registry = new BlobRegistry({ maxBytes: 8 });
	const original = await registry.registerBytes("original", "image/png", new Uint8Array(8).fill(1));
	registry.setPublication("original", { url: `http://blob.test/${original.path}`, destination: "direct", bytes: 8 });

	await expect(registry.registerBytes("next", "image/png", new Uint8Array(1))).rejects.toThrow(/resident.*budget/i);
	expect(registry.lookup("next")).toBeNull();
	expect(registry.lookup("original")?.path).toBe(original.path);
	const response = await registry.serve(new Request(`http://blob.test/${original.path}`));
	expect(response.status).toBe(200);
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(8).fill(1));
	expect(registry.status().metrics.residentBytes).toBe(8);
});

test("resident blobs own only their admitted bytes rather than a mutable larger backing buffer", async () => {
	registry = new BlobRegistry({ maxBytes: 8 });
	const backing = new Uint8Array(1024).fill(7);
	const entry = await registry.registerBytes("view", "image/png", backing.subarray(400, 408));
	backing.fill(9);

	const response = await registry.serve(new Request(`http://blob.test/${entry.path}`));
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(8).fill(7));
	expect(registry.status().metrics.residentBytes).toBe(8);
});

test("oversize eager blobs remain readable from durable storage across registry restarts", async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-blob-oversize-"));
	const persist = persistence(root);
	registry = new BlobRegistry({ persist, maxBytes: 8 });
	const bytes = new Uint8Array(32).fill(9);
	const entry = await registry.registerBytes("oversize", "image/png", bytes);
	expect(registry.status().metrics.residentBytes).toBe(0);
	expect(registry.status().metrics.diskBytes).toBe(bytes.byteLength);
	registry.flush();

	registry = new BlobRegistry({ persist, maxBytes: 0 });
	const response = await registry.serve(new Request(`http://blob.test/${entry.path}`));
	expect(response.status).toBe(200);
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
	const headers = await registry.serve(new Request(`http://blob.test/${entry.path}`, { method: "HEAD" }));
	expect(headers.status).toBe(200);
	expect(headers.headers.get("content-length")).toBe("32");
	expect(await headers.text()).toBe("");
	expect(registry.status().metrics.residentBytes).toBe(0);
});

test("failed durable registration leaves no dead handle and can be retried after storage recovers", async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-blob-write-failure-"));
	const persist = persistence(root);
	await Bun.write(persist.blobsDir, "not a directory");
	registry = new BlobRegistry({ persist, maxBytes: 8 });

	await expect(registry.registerBytes("retry", "image/png", new Uint8Array(32))).rejects.toThrow();
	expect(registry.lookup("retry")).toBeNull();
	expect(registry.status().metrics.activeBlobs).toBe(0);
	expect(registry.status().metrics.residentBytes).toBe(0);
	await fs.rm(persist.blobsDir);

	const entry = await registry.registerBytes("retry", "image/png", new Uint8Array(32));
	const response = await registry.serve(new Request(`http://blob.test/${entry.path}`));
	expect(response.status).toBe(200);
	expect((await response.arrayBuffer()).byteLength).toBe(32);
});

test("oversize lazy materialization reports insufficient storage and keeps the same handle retryable", async () => {
	registry = new BlobRegistry({ maxBytes: 8 });
	const entry = registry.registerLazy("lazy", "image/png", async () => new Uint8Array(32));
	const rejected = await registry.serve(new Request(`http://blob.test/${entry.path}`));
	expect(rejected.status).toBe(507);
	expect(await rejected.text()).toMatch(/resident.*budget/i);
	expect(registry.status().metrics.residentBytes).toBe(0);

	const retried = registry.registerLazy("lazy", "image/png", async () => new Uint8Array([1, 2]));
	expect(retried.path).toBe(entry.path);
	const response = await registry.serve(new Request(`http://blob.test/${entry.path}`));
	expect(response.status).toBe(200);
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
	expect(registry.status().metrics.residentBytes).toBe(2);
});

test("lazy admission does not evict an unreloadable published eager blob", async () => {
	registry = new BlobRegistry({ maxBytes: 8 });
	const original = await registry.registerBytes("original", "image/png", new Uint8Array(8).fill(1));
	const lazy = registry.registerLazy("lazy", "image/png", async () => new Uint8Array(1));
	const response = await registry.serve(new Request(`http://blob.test/${lazy.path}`));
	expect(response.status).toBe(507);
	expect((await registry.serve(new Request(`http://blob.test/${original.path}`))).status).toBe(200);
	expect(registry.status().metrics.residentBytes).toBe(8);
});

test("nonpersistent lazy cache eviction preserves handles by refetching their bytes", async () => {
	registry = new BlobRegistry({ maxBytes: 8 });
	let firstFetches = 0;
	const first = registry.registerLazy("first", "image/png", async () => {
		firstFetches++;
		return new Uint8Array(8).fill(1);
	});
	const second = registry.registerLazy("second", "image/png", async () => new Uint8Array(8).fill(2));
	for (const entry of [first, second, first]) {
		const response = await registry.serve(new Request(`http://blob.test/${entry.path}`));
		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(8).fill(entry === second ? 2 : 1));
		expect(registry.status().metrics.residentBytes).toBe(8);
	}
	expect(firstFetches).toBe(2);
	expect(registry.status().metrics.activeBlobs).toBe(2);
});

test("concurrent oversize lazy reads spill once and remain readable after a restart with no resident budget", async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-blob-lazy-spill-"));
	const persist = persistence(root);
	registry = new BlobRegistry({ persist, maxBytes: 8 });
	const bytes = new Uint8Array(32).fill(4);
	let fetches = 0;
	const entry = registry.registerLazy("lazy", "image/png", async () => {
		fetches++;
		return bytes;
	});
	registry.setPublication("lazy", { url: `http://blob.test/${entry.path}`, destination: "direct", bytes: 0 });
	const responses = await Promise.all([
		registry.serve(new Request(`http://blob.test/${entry.path}`)),
		registry.serve(new Request(`http://blob.test/${entry.path}`)),
	]);
	for (const response of responses) {
		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
	}
	expect(fetches).toBe(1);
	expect(registry.status().metrics.residentBytes).toBe(0);
	expect(registry.lookup("lazy")?.publication?.bytes).toBe(32);
	registry.flush();

	registry = new BlobRegistry({ persist, maxBytes: 0 });
	const response = await registry.serve(new Request(`http://blob.test/${entry.path}`));
	expect(response.status).toBe(200);
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
	expect(registry.lookup("lazy")?.bytes).toBe(32);
	expect(registry.status().metrics.residentBytes).toBe(0);
});

test("durable lazy handles release producer closures without losing their published bytes", async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-blob-lazy-closure-"));
	registry = new BlobRegistry({ persist: persistence(root), maxBytes: 8 });
	function registerTrackedProducer(store: BlobRegistry) {
		const payload = { bytes: new Uint8Array(32).fill(6) };
		return {
			entry: store.registerLazy("lazy", "image/png", async () => payload.bytes),
			ref: new WeakRef(payload),
		};
	}
	const first = registerTrackedProducer(registry);
	registry.setPublication("lazy", { url: `http://blob.test/${first.entry.path}`, destination: "direct", bytes: 0 });
	const response = await registry.serve(new Request(`http://blob.test/${first.entry.path}`));
	expect(response.status).toBe(200);
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(32).fill(6));

	const redundant = registerTrackedProducer(registry);
	expect(redundant.entry.path).toBe(first.entry.path);
	expect(await collectWeakRefs([first.ref, redundant.ref])).toBe(2);
	const retained = await registry.serve(new Request(`http://blob.test/${first.entry.path}`));
	expect(retained.status).toBe(200);
	expect(new Uint8Array(await retained.arrayBuffer())).toEqual(new Uint8Array(32).fill(6));
	expect(registry.status().metrics.residentBytes).toBe(0);
}, 10_000);

test("lazy storage failure reports an admission error and retries without orphan resident bytes", async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-blob-lazy-write-failure-"));
	const persist = persistence(root);
	await Bun.write(persist.blobsDir, "not a directory");
	registry = new BlobRegistry({ persist, maxBytes: 8 });
	const entry = registry.registerLazy("lazy", "image/png", async () => new Uint8Array(32));
	const rejected = await registry.serve(new Request(`http://blob.test/${entry.path}`));
	expect(rejected.status).toBe(507);
	expect(registry.status().metrics.residentBytes).toBe(0);
	await fs.rm(persist.blobsDir);

	const response = await registry.serve(new Request(`http://blob.test/${entry.path}`));
	expect(response.status).toBe(200);
	expect((await response.arrayBuffer()).byteLength).toBe(32);
	expect(registry.status().metrics.residentBytes).toBe(0);
});

test.each([false, true])(
	"purging an in-flight lazy blob cannot resurrect bytes or metadata (persistent=%s)",
	async persistent => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-blob-lazy-purge-"));
		registry = new BlobRegistry({ persist: persistent ? persistence(root) : undefined, maxBytes: 8 });
		const started = Promise.withResolvers<void>();
		const fetched = Promise.withResolvers<Uint8Array | null>();
		const entry = registry.registerLazy("lazy", "image/png", () => {
			started.resolve();
			return fetched.promise;
		});
		const response = registry.serve(new Request(`http://blob.test/${entry.path}`));
		await started.promise;
		expect(registry.purge({ all: true, apply: true }).purgedBlobs).toBe(1);
		fetched.resolve(new Uint8Array(8));

		expect((await response).status).toBe(410);
		expect(registry.lookup("lazy")).toBeNull();
		expect(registry.status().metrics.activeBlobs).toBe(0);
		expect(registry.status().metrics.residentBytes).toBe(0);
		expect((await registry.serve(new Request(`http://blob.test/${entry.path}`))).status).toBe(404);
	},
);
