import { afterAll, afterEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolSession } from "../sdk";
import * as scraperTypes from "../web/scrapers/types";
import * as scraperUtils from "../web/scrapers/utils";
import { executeReadUrl, fetchReadUrl, parseReadUrlTarget } from "./fetch";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-ports-"));
afterEach(() => vi.restoreAllMocks());
afterAll(() => fs.rm(root, { recursive: true, force: true }));
function session(): ToolSession {
	return {
		settings: { get: (key: string) => (key === "providers.fetch" ? "native" : 300), getStorage: () => null },
		getActiveModel: () => undefined,
		allocateOutputArtifact: async () => ({ id: "raw-source", path: path.join(root, "source.txt") }),
	} as unknown as ToolSession;
}
const prose = "This article describes the stable API and shows how to use its complete supported interface. ".repeat(6);
function page(content: string, extra: Partial<scraperTypes.LoadPageResult> = {}): scraperTypes.LoadPageResult {
	return { ok: true, content, contentType: "text/plain", finalUrl: "https://example.test/article", ...extra };
}

test("raw URL artifacts preserve whitespace and literal metadata separators without wrappers", async () => {
	const source = "  first\n\n\n---\n\nlast  \n";
	spyOn(scraperTypes, "loadPage").mockResolvedValue(page(source));
	const result = await fetchReadUrl(session(), { path: "https://example.test/article", raw: true }, undefined, {
		ensureArtifact: true,
	});
	expect(result.output).toBe(source);
	expect(result.content).toBe(source);
	expect(await Bun.file(result.artifactPath ?? "").text()).toBe(source);
	expect(result.details.raw).toBe(true);
});

test("whole URL preview shows a UTF-8-safe over-budget first line while retaining the complete artifact", async () => {
	const source = "🦋".repeat(20_000);
	spyOn(scraperTypes, "loadPage").mockResolvedValue(page(source));
	const result = await executeReadUrl(session(), { path: "https://example.test/article", raw: true });
	const preview = result.content[0];
	expect(preview.type).toBe("text");
	if (preview.type !== "text") throw new Error("missing preview");
	expect(preview.text.startsWith("🦋")).toBe(true);
	expect(preview.text).not.toContain("�");
	expect(Buffer.byteLength(preview.text)).toBeLessThanOrEqual(50 * 1024);
	expect(result.details?.truncated).toBe(true);
	expect(await Bun.file(path.join(root, "source.txt")).text()).toBe(source);
});

test("HTTP 204 avoids rendering and exposes no-content metadata", async () => {
	const load = spyOn(scraperTypes, "loadPage").mockResolvedValue(page("", { status: 204, contentType: "text/html" }));
	const result = await fetchReadUrl(session(), { path: "https://example.test/article" });
	expect(result.content).toBe("");
	expect(result.details).toMatchObject({ method: "no-content", notes: ["HTTP 204 No Content"], truncated: false });
	expect(load).toHaveBeenCalledTimes(1);
});

test("advertised page-scoped markdown wins by media type and reports its redirected source and truncation", async () => {
	const html = `<html><head><link rel="alternate" type="text/markdown" href="/article/representation"></head><body>${prose}</body></html>`;
	spyOn(scraperTypes, "loadPage").mockImplementation(async url =>
		url.endsWith("/representation")
			? page(prose, { finalUrl: "https://cdn.test/article.md", truncated: true })
			: page(html, { contentType: "text/html" }),
	);
	const result = await fetchReadUrl(session(), { path: "https://example.test/article" });
	expect(result.details).toMatchObject({
		method: "alternate-markdown",
		finalUrl: "https://cdn.test/article.md",
		truncated: true,
	});
	expect(result.details.notes.join(" ")).toContain("cut mid-stream");
});

test("an uncut negotiated representation replaces the initial response's network-cut flag and URL", async () => {
	let calls = 0;
	spyOn(scraperTypes, "loadPage").mockImplementation(async () =>
		++calls === 1
			? page(`<html><body>${prose}</body></html>`, { contentType: "text/html", truncated: true })
			: page(prose, { finalUrl: "https://cdn.test/negotiated" }),
	);
	const result = await fetchReadUrl(session(), { path: "https://example.test/article" });
	expect(result.details).toMatchObject({
		method: "content-negotiation",
		finalUrl: "https://cdn.test/negotiated",
		truncated: false,
	});
	expect(result.details.notes.join(" ")).not.toContain("cut mid-stream");
});

test("a site-wide markdown alternate cannot replace a page and guessed md suffixes are never requested", async () => {
	const html = `<html><head><link rel="alternate" type="text/markdown" href="/llms.txt"></head><body><main><h1>Requested article</h1><p>${prose}</p></main></body></html>`;
	const requests: string[] = [];
	spyOn(scraperTypes, "loadPage").mockImplementation(async url => {
		requests.push(url);
		return page(html, { contentType: "text/html" });
	});
	const result = await fetchReadUrl(session(), { path: "https://example.test/article" });
	expect(result.content).toContain("Requested article");
	expect(result.details.method).toBe("native");
	expect(requests).toEqual(["https://example.test/article", "https://example.test/article"]);
});

test("native article metadata keeps useful fields but lists unrelated tag names without their values", async () => {
	const html = `<html><head><title>Requested article</title><meta name="description" content="Useful description"><meta name="viewport" content="SECRET_LAYOUT_VALUE"><meta property="og:image" content="SECRET_IMAGE_VALUE"></head><body><main><p>${prose}</p></main></body></html>`;
	spyOn(scraperTypes, "loadPage").mockResolvedValue(page(html, { contentType: "text/html" }));
	const result = await fetchReadUrl(session(), { path: "https://example.test/article" });
	expect(result.content).toContain("Useful description");
	expect(result.content).toContain("meta_omitted:");
	expect(result.content).toContain("viewport");
	expect(result.content).toContain("og:image");
	expect(result.content).not.toContain("SECRET_LAYOUT_VALUE");
	expect(result.content).not.toContain("SECRET_IMAGE_VALUE");
});

test("generic MIME convertible documents reuse a failed conversion download in binary fallback", async () => {
	const load = spyOn(scraperTypes, "loadPage").mockResolvedValue(
		page("", {
			contentType: "application/octet-stream",
			finalUrl: "https://example.test/file.pdf",
			bodySkipped: true,
		}),
	);
	const binary = spyOn(scraperUtils, "fetchBinary").mockResolvedValue({
		ok: true,
		buffer: new TextEncoder().encode("%PDF-1.4\nopaque"),
	});
	spyOn(scraperUtils, "convertWithMarkit").mockResolvedValue({ ok: false, content: "", error: "unsupported PDF" });
	const result = await fetchReadUrl(session(), { path: "https://example.test/file.pdf" });
	expect(load.mock.calls[0]?.[1]?.skipBodyForContentType?.("application/octet-stream")).toBe(true);
	expect(binary).toHaveBeenCalledTimes(1);
	expect(result.details.method).toBe("binary");
});

test("redirects dropping a generic download extension restore the initially skipped text body", async () => {
	let calls = 0;
	spyOn(scraperTypes, "loadPage").mockImplementation(async () =>
		++calls === 1 ? page("", { contentType: "application/octet-stream", bodySkipped: true }) : page(prose),
	);
	const result = await fetchReadUrl(session(), { path: "https://example.test/file.pdf" });
	expect(calls).toBe(2);
	expect(result.content).toBe(prose.trim());
});

test("raw bare numbers select one line in either selector order while N- stays onward", () => {
	expect(parseReadUrlTarget("https://example.test/page:raw:5")).toMatchObject({ raw: true, offset: 5, limit: 1 });
	expect(parseReadUrlTarget("https://example.test/page:5:raw")).toMatchObject({ raw: true, offset: 5, limit: 1 });
	expect(parseReadUrlTarget("https://example.test/page:raw:5-")).toMatchObject({
		raw: true,
		offset: 5,
		limit: undefined,
	});
});

test("reader normalization no longer discards rendered content past 500000 characters", async () => {
	const source = `${"abc ".repeat(130_000)}end-of-source`;
	spyOn(scraperTypes, "loadPage").mockResolvedValue(page(source));
	const result = await fetchReadUrl(session(), { path: "https://example.test/article" });
	expect(result.content.endsWith("end-of-source")).toBe(true);
	expect(result.details.truncated).toBe(false);
});

test("refetched text honors its full charset header and clears the discarded response's network-cut flag", async () => {
	spyOn(scraperTypes, "loadPage").mockResolvedValue(page("\0".repeat(100), { truncated: true }));
	spyOn(scraperUtils, "fetchBinary").mockResolvedValue({
		ok: true,
		buffer: new Uint8Array([0x63, 0x61, 0x66, 0xe9]),
		contentType: "text/plain; charset=windows-1252",
	});
	const result = await fetchReadUrl(session(), { path: "https://example.test/article" });
	expect(result.content).toBe("café");
	expect(result.details.truncated).toBe(false);
	expect(result.details.notes.join(" ")).not.toContain("cut mid-stream");
});
