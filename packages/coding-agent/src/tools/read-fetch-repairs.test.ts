import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import type { ToolSession } from ".";
import { parseReadUrlTarget } from "./fetch";
import { ReadTool } from "./read";

const settingsValues: Record<string, unknown> = {
	"images.autoResize": false,
	"read.defaultLimit": 200,
	readLineNumbers: false,
	"read.renderMarkdown": false,
	"read.summarize.enabled": false,
	"fetch.enabled": true,
	"bashInterceptor.enabled": false,
	"async.enabled": false,
	"bash.autoBackground.enabled": false,
	"kernel.speculation.enabled": false,
	"kernel.assertPreflight.enabled": false,
	"bash.direnv": "off",
	"tools.maxTimeout": 300,
	"tools.outputMaxColumns": 0,
};

function readSession(cwd: string): ToolSession {
	return {
		cwd,
		settings: {
			get: (key: string) => settingsValues[key],
			getShellConfig: () => ({ env: {} }),
			getStorage: () => null,
		},
		hasUI: false,
		canPromptUser: false,
		skills: [],
		additionalDirectories: [],
		getSessionFile: () => null,
		getSessionId: () => "read-fetch-repairs",
		getImageAttachments: () => [],
		getArtifactsDir: () => null,
		getActiveModel: () => undefined,
		isToolActive: () => false,
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("");
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "read-fetch-repairs-"));
const read = new ReadTool(readSession(root));
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/missing") return new Response("no such record", { status: 404 });
		if (url.pathname === "/boom") return new Response("upstream exploded", { status: 503 });
		const body = Array.from({ length: 6 }, (_, index) => `served line ${index + 1}`).join("\n");
		return new Response(body, { headers: { "content-type": "text/plain" } });
	},
});
const origin = `http://127.0.0.1:${server.port}`;

test("a trailing port stays part of the URL instead of being peeled off as a line selector", () => {
	expect(parseReadUrlTarget(`${origin}`)).toEqual({ path: origin, raw: false });
	expect(parseReadUrlTarget("https://example.com:8443")).toEqual({ path: "https://example.com:8443", raw: false });
	expect(parseReadUrlTarget("http://[::1]:8080")).toEqual({ path: "http://[::1]:8080", raw: false });
	expect(parseReadUrlTarget("www.example.com:8443")).toEqual({ path: "www.example.com:8443", raw: false });

	// A selector still attaches after the port, after a path, and alongside :raw.
	expect(parseReadUrlTarget("https://example.com:8443:3")).toEqual({
		path: "https://example.com:8443",
		raw: false,
		offset: 3,
		limit: undefined,
	});
	expect(parseReadUrlTarget("https://example.com:8443/page:12-14")).toEqual({
		path: "https://example.com:8443/page",
		raw: false,
		offset: 12,
		limit: 3,
	});
	expect(parseReadUrlTarget("https://example.com:8443/:5")).toEqual({
		path: "https://example.com:8443/",
		raw: false,
		offset: 5,
		limit: undefined,
	});
	expect(parseReadUrlTarget("https://example.com:8443:raw")).toEqual({ path: "https://example.com:8443", raw: true });
	// Ports beyond the valid range are ordinary line numbers.
	expect(parseReadUrlTarget("https://example.com:70000")).toEqual({
		path: "https://example.com",
		raw: false,
		offset: 70000,
		limit: undefined,
	});
});

test("reading an origin with a port reaches that origin, with and without a selector", async () => {
	const whole = await read.execute("port-origin", { path: origin });
	expect(textOf(whole)).toContain("served line 1");
	expect(whole.details?.finalUrl).toBe(`${origin}/`);

	// The selector applies to the port origin's own output, so it can run past its end.
	const ranged = await read.execute("port-origin-range", { path: `${origin}:2-3` });
	expect(ranged.details?.finalUrl).toBe(`${origin}/`);
	const overrun = textOf(await read.execute("port-origin-overrun", { path: `${origin}:9999` }));
	expect(overrun).toContain("Line 9999 is beyond end of URL output (12 lines total)");
});

test("HTTP error statuses and unreachable hosts are tool errors, and the error keeps the body", async () => {
	await expect(read.execute("http-404", { path: `${origin}/missing` })).rejects.toThrow(
		/Failed to fetch .*\/missing \(HTTP 404\)[\s\S]*no such record/,
	);
	await expect(read.execute("http-503", { path: `${origin}/boom` })).rejects.toThrow(
		/\(HTTP 503\)[\s\S]*upstream exploded/,
	);
	await expect(read.execute("http-refused", { path: "http://127.0.0.1:1/dead" })).rejects.toThrow(/Failed to fetch/);
});

test("a line selector on a single-stream compressed file reads the stream, not its member listing", async () => {
	const lines = Array.from({ length: 20 }, (_, index) => `line${String(index + 1).padStart(3, "0")}`);
	await fs.writeFile(path.join(root, "plain.txt.gz"), gzipSync(Buffer.from(`${lines.join("\n")}\n`)));

	const ranged = textOf(await read.execute("gz-range", { path: "plain.txt.gz:1-2" }));
	expect(ranged).toContain("line001");
	expect(ranged).toContain("line002");
	expect(ranged).not.toContain("line003");
	expect(ranged).not.toContain("plain.txt (");

	expect(textOf(await read.execute("gz-member", { path: "plain.txt.gz:plain.txt:1-2" }))).toContain("line001");
	// No selector still describes the archive.
	expect(textOf(await read.execute("gz-listing", { path: "plain.txt.gz" }))).toContain("plain.txt");
});

afterAll(async () => {
	server.stop(true);
	await fs.rm(root, { recursive: true, force: true });
});
