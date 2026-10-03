import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { encodeArchive } from "./ar";
import { BrowserPlatform, computeExecutablePath, getDownloadUrl, install } from "./browsers";

const BUILD_ID = "123.0.6312.58";
const CHROME_SCRIPT = "#!/bin/sh\necho synthetic chrome\n";
const roots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-browsers-test-"));
	roots.push(root);
	return root;
}

afterAll(async () => {
	for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

describe("Chrome-for-Testing layout", () => {
	test("linux", () => {
		expect(String(getDownloadUrl(BrowserPlatform.LINUX, BUILD_ID))).toBe(
			`https://storage.googleapis.com/chrome-for-testing-public/${BUILD_ID}/linux64/chrome-linux64.zip`,
		);
		expect(computeExecutablePath({ platform: BrowserPlatform.LINUX, buildId: BUILD_ID, cacheDir: "/cache" })).toBe(
			path.join("/cache", "chrome", `linux-${BUILD_ID}`, "chrome-linux64", "chrome"),
		);
	});

	test("rejects linux/arm64 before producing archive or cache paths", async () => {
		const unsupported = "Chrome for Testing does not provide linux/arm64 builds";
		expect(() => getDownloadUrl(BrowserPlatform.LINUX_ARM, BUILD_ID)).toThrow(unsupported);
		expect(() =>
			computeExecutablePath({ platform: BrowserPlatform.LINUX_ARM, buildId: BUILD_ID, cacheDir: "/cache" }),
		).toThrow(unsupported);
		await expect(
			install({
				platform: BrowserPlatform.LINUX_ARM,
				buildId: BUILD_ID,
				cacheDir: "/cache",
				baseUrl: "http://127.0.0.1:1",
			}),
		).rejects.toThrow(unsupported);
	});
});

test("install extracts a member larger than the default 64 MiB archive cap", async () => {
	const root = await makeRoot();
	const bigSize = 65 * 1024 * 1024;
	const zip = await encodeArchive("zip", [["chrome-linux64/chrome", new Uint8Array(bigSize)]]);
	const server = Bun.serve({ port: 0, fetch: () => new Response(new Blob([zip])) });
	try {
		const installed = await install({
			platform: BrowserPlatform.LINUX,
			buildId: BUILD_ID,
			cacheDir: root,
			baseUrl: String(server.url),
		});
		expect((await fs.stat(installed.executablePath)).size).toBe(bigSize);
	} finally {
		server.stop(true);
	}
});

test("concurrent installs download once without replacing the winner's browser", async () => {
	const root = await makeRoot();
	const zip = await encodeArchive("zip", [["chrome-linux64/chrome", new TextEncoder().encode(CHROME_SCRIPT)]]);
	const requested = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let requests = 0;
	const server = Bun.serve({
		port: 0,
		async fetch() {
			requests++;
			requested.resolve();
			await release.promise;
			return new Response(new Blob([zip]));
		},
	});
	const options = { platform: BrowserPlatform.LINUX, buildId: BUILD_ID, cacheDir: root, baseUrl: String(server.url) };
	try {
		const first = install(options);
		const second = install(options);
		await requested.promise;
		release.resolve();
		const results = await Promise.all([first, second]);
		expect(requests).toBe(1);
		for (const result of results) expect(await Bun.file(result.executablePath).text()).toBe(CHROME_SCRIPT);
	} finally {
		release.resolve();
		server.stop(true);
	}
});
