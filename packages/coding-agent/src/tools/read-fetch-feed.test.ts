import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as toolsManager from "../utils/tools-manager";
import * as parallel from "../web/parallel";
import type { ToolSession } from ".";
import { ReadTool } from "./read";

const settingsValues: Record<string, unknown> = {
	"images.autoResize": false,
	"read.defaultLimit": 200,
	readLineNumbers: false,
	"read.renderMarkdown": false,
	"read.summarize.enabled": false,
	"fetch.enabled": true,
	"providers.fetch": "native",
	"tools.outputMaxColumns": 0,
};

const root = await fs.mkdtemp(path.join(os.tmpdir(), "read-fetch-feed-"));
const read = new ReadTool({
	cwd: root,
	settings: { get: (key: string) => settingsValues[key], getShellConfig: () => ({ env: {} }), getStorage: () => null },
	hasUI: false,
	canPromptUser: false,
	skills: [],
	additionalDirectories: [],
	getSessionFile: () => null,
	getSessionId: () => "read-fetch-feed",
	getImageAttachments: () => [],
	getArtifactsDir: () => null,
	getActiveModel: () => undefined,
	isToolActive: () => false,
	fetch: async () => new Response("remote readers are offline in tests", { status: 503 }),
} as unknown as ToolSession);

beforeEach(() => {
	spyOn(toolsManager, "ensureTool").mockResolvedValue(undefined);
	spyOn(parallel, "findParallelApiKey").mockReturnValue(null);
});

afterEach(() => {
	mock.restore();
});

const RSS_FEED = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>Shell | Blog</title><link>https://shell.example/</link><atom:link rel="self" href="https://shell.example/blog/rss.xml"/><item><title>A new website</title><link>https://shell.example/blog/new-website/</link><description>The site has a new design, a one-line installer, and reference docs for each release.</description><pubDate>Sat, 19 Sep 2026 00:00:00 GMT</pubDate></item><item><title><![CDATA[Release notes & upgrade guide]]></title><link>https://shell.example/blog/release-notes/</link><description><![CDATA[<p>Everything that changed in the latest release, with upgrade steps for existing configurations and scripts.</p>]]></description></item></channel></rss>`;
const EMPTY_FEED = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Nothing here</title><description>${"An empty channel with a long description and no items at all. ".repeat(6)}</description></channel></rss>`;

function landingPage(feedHref: string, body: string): string {
	return `<!doctype html><html><head><title>Shell</title><link href="${feedHref}" rel="alternate" title="Blog" type="application/rss+xml"/></head><body><main>${body}</main></body></html>`;
}

const PROSE = [
	"<h1>A Bash-compatible shell written in Rust</h1>",
	"<p>It reads your existing configuration files, runs your existing scripts unchanged, and adds autosuggestions, syntax highlighting, and programmable completion support out of the box.</p>",
	"<h2>Install</h2>",
	"<p>Install the latest release with the one-line installer, or build it from source with a recent stable toolchain; both paths produce a single self-contained binary.</p>",
	"<h2>Compatibility</h2>",
	"<p>The shell tracks the behavior of the reference implementation closely, and its test suite compares outputs against it for thousands of scripts to catch regressions early.</p>",
].join("");
const NAV_ONLY = Array.from({ length: 15 }, (_, i) => `<p><a href="/n${i}">Nav ${i}</a></p>`).join("");

const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch(request) {
		const { pathname } = new URL(request.url);
		const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
		const rss = (body: string) => new Response(body, { headers: { "content-type": "application/rss+xml" } });
		if (pathname === "/") return html(landingPage("/blog/rss.xml", PROSE));
		if (pathname === "/nav/") return html(landingPage("/nav/rss.xml", NAV_ONLY));
		if (pathname === "/empty-feed/") return html(landingPage("/empty-feed/rss.xml", NAV_ONLY));
		if (pathname === "/blog/rss.xml" || pathname === "/nav/rss.xml") return rss(RSS_FEED);
		if (pathname === "/empty-feed/rss.xml") return rss(EMPTY_FEED);
		return new Response("not found", { status: 404 });
	},
});
const origin = `http://127.0.0.1:${server.port}`;

afterAll(async () => {
	server.stop(true);
	await fs.rm(root, { recursive: true, force: true });
});

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(block => (block.type === "text" ? (block.text ?? "") : "")).join("");
}

test("reader mode returns a content page's own text even when it advertises a site feed", async () => {
	const result = await read.execute("landing", { path: `${origin}/` });
	const text = textOf(result);
	expect(result.details?.method).toBe("native");
	expect(text).toContain("A Bash-compatible shell written in Rust");
	expect(text).toContain("programmable completion support");
	expect(text).not.toContain("A new website");
});

test("reading a feed URL renders each item's title, date, summary, and link", async () => {
	const text = textOf(await read.execute("feed", { path: `${origin}/blog/rss.xml` }));
	expect(text).toContain("# Shell | Blog");
	expect(text).toContain("## A new website");
	expect(text).toContain("Sat, 19 Sep 2026");
	expect(text).toContain("one-line installer");
	expect(text).toContain("[Read more](https://shell.example/blog/new-website/)");
	expect(text).toContain("## Release notes & upgrade guide");
	expect(text).toContain("upgrade steps for existing configurations");
	expect(text).not.toContain("Untitled");
});

test("a navigation-only page falls back to its feed alternate when the feed has entries", async () => {
	const result = await read.execute("nav", { path: `${origin}/nav/` });
	expect(result.details?.method).toBe("alternate-feed");
	expect(textOf(result)).toContain("## A new website");
});

test("a feed alternate with no entries never replaces the page", async () => {
	const result = await read.execute("empty-feed", { path: `${origin}/empty-feed/` });
	expect(result.details?.method).not.toBe("alternate-feed");
	expect(textOf(result)).toContain("Nav 3");
});
