import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { servePdfForBrowser, splitPdfImageReadPath } from "./read-pdf";

describe("splitPdfImageReadPath", () => {
	test("rejects arbitrary, zero, and unsafe PDF page members instead of selecting page 1", () => {
		expect(splitPdfImageReadPath("document.pdf:garbage")).toBeNull();
		expect(splitPdfImageReadPath("document.pdf:page-0.png")).toBeNull();
		expect(splitPdfImageReadPath("document.pdf:page-9007199254740992.png")).toBeNull();
	});

	test("resolves a valid PDF page member", () => {
		expect(splitPdfImageReadPath("document.pdf:page-7.png")).toEqual({
			pdfPath: "document.pdf",
			member: "page-7.png",
			page: 7,
		});
	});
});

test("PDF browser transport serves only the selected file over loopback", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "read-pdf-http-"));
	try {
		const file = path.join(root, "document.pdf");
		await Bun.write(file, "%PDF-1.7\nfixture");
		const { server, url } = servePdfForBrowser(file);
		try {
			expect(url.hostname).toBe("127.0.0.1");
			const response = await fetch(url);
			expect(response.headers.get("content-type")).toBe("application/pdf");
			expect(await response.text()).toBe("%PDF-1.7\nfixture");
			expect((await fetch(new URL("/other.pdf", url))).status).toBe(404);
			expect((await fetch(url, { method: "POST" })).status).toBe(405);
			expect((await fetch(url, { method: "HEAD" })).status).toBe(200);
		} finally {
			server.stop(true);
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
